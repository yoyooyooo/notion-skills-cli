import { createHash, randomBytes } from "node:crypto"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Crypto, Effect, PlatformError, Schema } from "effect"
import { property } from "../packages/core/src/model.ts"
import { normalizePath } from "../packages/core/src/ref.ts"
import { resolveLegacyCommittedPublication } from "../packages/core/src/shared-migration-legacy-publication.ts"
import { SharedMigrationInputSchema } from "../packages/core/src/shared-migration-plan.ts"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"

const crypto = Crypto.make({
  randomBytes,
  digest: (algorithm, data) =>
    Effect.try({
      try: () =>
        Uint8Array.from(
          createHash(
            { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" }[
              algorithm
            ],
          )
            .update(data)
            .digest(),
        ),
      catch: (cause) =>
        PlatformError.systemError({
          module: "Crypto",
          method: "digest",
          _tag: "Unknown",
          description: "Could not compute digest",
          cause,
        }),
    }),
})
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const same = (a: unknown, b: unknown) => canonicalSharedJson(a) === canonicalSharedJson(b)
function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function string(value: unknown, message: string): string {
  requireFact(typeof value === "string" && value.length > 0, message)
  return value
}
type Frozen = { readonly path: string; readonly sha256: string }
function frozen(value: unknown): Frozen {
  const input = property(value)
  requireFact(
    typeof input.path === "string" &&
      isAbsolute(input.path) &&
      typeof input.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(input.sha256),
    "Use an exact retained absolute path and SHA-256.",
  )
  return { path: input.path, sha256: input.sha256 }
}
function asJson(bytes: Uint8Array) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  requireFact(Buffer.from(text).equals(bytes), "Retained JSON must preserve exact UTF-8 bytes.")
  return text
}

/** One selected closed member, offline. Original observations, input, approval
 * and operation inventory are retained; only a new draft and artifacts are made. */
export async function deriveMigrationPublication(configPath: string) {
  const bindings: { path: string; sha256: string; bytes: number }[] = []
  const read = async (input: Frozen) => {
    const info = await lstat(input.path)
    requireFact(
      info.isFile() && !info.isSymbolicLink(),
      "Retain a regular original file, not a symlink.",
    )
    const bytes = await readFile(input.path)
    requireFact(hash(bytes) === input.sha256, "Original input changed: " + input.path)
    bindings.push({ ...input, bytes: bytes.length })
    return bytes
  }
  const retained = async (value: unknown) => {
    const input = frozen(value),
      bytes = await read(input)
    return {
      json: asJson(bytes),
      sha256: input.sha256,
      bytes: bytes.length,
      retention_ref: input.path,
    }
  }
  const configBytes = await readFile(configPath),
    config = property(JSON.parse(asJson(configBytes)))
  requireFact(
    config.version === 1 && config.format === "migration-retained-publication",
    "Use the explicit retained-publication config.",
  )
  const proofVersion = config.proof_version === undefined ? 1 : config.proof_version
  requireFact(
    proofVersion === 1 || proofVersion === 2 || proofVersion === 3,
    "proof_version must be 1, 2 or 3.",
  )
  const output = string(config.output, "Choose a fresh output directory.")
  requireFact(isAbsolute(output), "Output must be absolute.")
  try {
    await lstat(output)
    throw new Error("Output exists; preserve the original attempt.")
  } catch (error) {
    if (property(error).code !== "ENOENT") throw error
  }
  const inputBytes = await read(frozen(config.input))
  const original = Schema.decodeUnknownSync(SharedMigrationInputSchema)(
    JSON.parse(asJson(inputBytes)),
    { onExcessProperty: "error" },
  )
  requireFact(
    original.approved_legacy_ids.length === 0,
    "This factual followup cannot add or reuse approval.",
  )
  const legacyId = string(config.legacy_id, "Select exactly one retained legacy identity.")
  const selected = original.catalog.entries.filter((entry) => entry.legacy_id === legacyId)
  const entry = selected[0]
  requireFact(
    selected.length === 1 && entry,
    "The exact selected entry must appear once in the full input.",
  )
  requireFact(
    Array.isArray(config.parent_rows) && config.parent_rows.length === 2,
    "Retain the two original parent page observations.",
  )
  const parentRows = []
  for (const value of config.parent_rows) parentRows.push(await retained(value))
  const snapshot = await retained(config.snapshot),
    inspection = await retained(config.fixed_source_inspection)
  const archiveInput = frozen(config.source_archive),
    archiveBytes = await read(archiveInput)
  const exportConfig = property(config.authored_export)
  const request = await retained(exportConfig.request),
    receipt = await retained(exportConfig.receipt)
  const completion = await retained(exportConfig.completion),
    inventory = await retained(exportConfig.inventory)
  const exported = property(JSON.parse(receipt.json)),
    files = property(JSON.parse(inventory.json))
  const directory = string(exportConfig.directory, "Retain the original authored export directory.")
  requireFact(
    isAbsolute(directory) && directory === exported.output,
    "Use the exact original export output coordinate.",
  )
  const authoredFiles = []
  for (const [path, raw] of Object.entries(files)) {
    requireFact(normalizePath(path) === path, "Do not traverse outside a retained file tree.")
    const file = property(raw),
      originalPath = join(directory, path)
    const bytes = await read(frozen({ path: originalPath, sha256: file.sha256 }))
    requireFact(bytes.length === file.bytes, "Authored export byte length changed.")
    authoredFiles.push({
      path,
      base64: bytes.toString("base64"),
      sha256: hash(bytes),
      bytes: bytes.length,
      retention_ref: originalPath,
    })
  }
  const nativePreimages = []
  for (const file of entry.files) {
    requireFact(
      file.body && normalizePath(file.path) === file.path,
      "Keep each original logical body and canonical path.",
    )
    const authored = await read(frozen({ path: file.body.retention_ref, sha256: file.body.sha256 }))
    requireFact(
      authored.length === file.body.bytes,
      "The original assembled authored copy changed.",
    )
    const native = property(property(file.raw).native_preimage)
    const bytes = await read(frozen({ path: native.retention_ref, sha256: native.response_sha256 }))
    requireFact(bytes.length === native.response_bytes, "The original native response changed.")
    nativePreimages.push({
      ...native,
      path: file.path,
      body_retention_ref: join(output, "native", file.path),
      response_json: asJson(bytes),
    })
  }
  const proofInput = {
    version: proofVersion,
    policy:
      proofVersion === 3
        ? "legacy_committed_current_metadata_v3"
        : proofVersion === 2
          ? "legacy_committed_source_bundle_v2"
          : "legacy_committed_publication_v1",
    observation: "retained",
    current_terminal_verified: false,
    human_edit_intent_inferred: false,
    entry_before: entry,
    parent_rows: parentRows,
    snapshot,
    fixed_source_inspection: inspection,
    source_archive: {
      base64: archiveBytes.toString("base64"),
      sha256: archiveInput.sha256,
      bytes: archiveBytes.length,
      retention_ref: archiveInput.path,
    },
    authored_export: { request, receipt, completion, inventory, files: authoredFiles },
    native_preimages: nativePreimages,
  }
  const result = await Effect.runPromise(
    resolveLegacyCommittedPublication(proofInput).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
    ),
  )
  requireFact(
    result.scope === original.scope,
    "The retained snapshot belongs to another observed authentication scope.",
  )
  requireFact(
    !original.preservation.sources.items.some(
      (source) =>
        source.legacy_id === result.source.legacy_id || source.references.includes(legacyId),
    ),
    "Do not replace or merge an existing selected Source interpretation.",
  )
  const draft = Schema.decodeUnknownSync(SharedMigrationInputSchema)(
    {
      ...original,
      catalog: {
        ...original.catalog,
        entries: original.catalog.entries.map((value) =>
          value.legacy_id === legacyId ? result.entry : value,
        ),
      },
      preservation: {
        ...original.preservation,
        sources: {
          ...original.preservation.sources,
          items: [...original.preservation.sources.items, result.source],
        },
      },
    },
    { onExcessProperty: "error" },
  )
  requireFact(
    draft.approved_legacy_ids.length === 0 &&
      draft.preservation.sources.complete === original.preservation.sources.complete,
    "A selected retained Source cannot establish namespace completeness or approval.",
  )
  for (const domain of ["operations", "pins", "views", "routers"] as const)
    requireFact(
      same(draft.preservation[domain], original.preservation[domain]),
      "Unrelated preservation facts changed.",
    )
  requireFact(
    same(
      draft.catalog.entries.filter((value) => value.legacy_id !== legacyId),
      original.catalog.entries.filter((value) => value.legacy_id !== legacyId),
    ),
    "Do not reinterpret other members, including the incomplete Router or cross-root Skill.",
  )
  for (const binding of bindings)
    requireFact(
      hash(await readFile(binding.path)) === binding.sha256,
      "An original artifact changed during derivation.",
    )
  requireFact((await readFile(configPath)).equals(configBytes), "The derivation config changed.")
  const draftBytes = json(draft),
    proofBytes = json(result.proof)
  await mkdir(output, { mode: 0o700 })
  for (const file of result.native_files) {
    requireFact(
      file.retention_ref === join(output, "native", file.path),
      "Derived native body coordinates changed.",
    )
    await mkdir(dirname(file.retention_ref), { recursive: true, mode: 0o700 })
    await writeFile(file.retention_ref, file.bytes, { flag: "wx", mode: 0o600 })
    requireFact(
      hash(await readFile(file.retention_ref)) === file.sha256,
      "A derived native body was not retained exactly.",
    )
  }
  const summary = {
    version: 1,
    status: "retained_publication_derived",
    policy: result.proof.policy,
    legacy_id: legacyId,
    original_input: frozen(config.input),
    proof_sha256: result.proof_sha256,
    draft: {
      file: "draft-input.json",
      bytes: Buffer.byteLength(draftBytes),
      sha256: hash(draftBytes),
    },
    native_files: result.native_files.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: file.sha256,
      retention_ref: file.retention_ref,
    })),
    source_id: result.source_binding.source_id,
    source_legacy_id: result.source.legacy_id,
    original_source_namespace_complete: original.preservation.sources.complete,
    current_terminal_verified: false,
    human_edit_intent_inferred: false,
    approved_legacy_ids: [],
    remote_requests: 0,
    cli_executed: false,
    migration_executed: false,
    original_operations_unchanged: true,
    unselected_entries_unchanged: true,
    original_input_unchanged: true,
    remaining: [
      "concrete public migration review",
      "explicit approval of its exact input and review ID",
      "new-copy execution and final verification",
    ],
  }
  for (const [name, value] of [
    ["proof.json", proofBytes],
    ["draft-input.json", draftBytes],
    ["entry-proposal.json", json(result.entry)],
    ["source-proposal.json", json(result.source)],
    ["summary.json", json(summary)],
    [
      "input-bindings.json",
      json([
        { path: configPath, sha256: hash(configBytes), bytes: configBytes.length },
        ...bindings,
      ]),
    ],
  ] as const)
    await writeFile(join(output, name), value, { flag: "wx", mode: 0o600 })
  return summary
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--config")
    throw new Error("Usage: bun scripts/derive-migration-publication.ts --config FROZEN_CONFIG")
  deriveMigrationPublication(resolve(process.argv[3]!)).then(
    (summary) => process.stdout.write(json({ ok: true, ...summary })),
    (error: unknown) => {
      process.stderr.write(String(error) + "\n")
      process.exitCode = 2
    },
  )
}
