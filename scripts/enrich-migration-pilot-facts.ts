import { createHash, randomBytes } from "node:crypto"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Crypto, Effect, PlatformError, Schema } from "effect"
import { property, text } from "../packages/core/src/model.ts"
import { pageId } from "../packages/core/src/ref.ts"
import { resolveMigrationActivation } from "../packages/core/src/shared-migration-activation.ts"
import {
  SharedMigrationEntrySchema,
  type SharedMigrationEntry,
} from "../packages/core/src/shared-migration-plan.ts"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"

type FrozenFile = { readonly path: string; readonly sha256: string }
type RetainedJson = {
  readonly json: string
  readonly sha256: string
  readonly bytes: number
  readonly retention_ref: string
}
type Activity = {
  readonly version: 2
  readonly policy: "legacy_catalog_active_page_v2"
  readonly api_version: "2026-03-11"
  readonly catalog_row: RetainedJson
  readonly data_source_schema: RetainedJson
}
// This root script only needs Effect's Crypto service. The platform-node layer
// belongs to the core package and is not a dependency of the repository root.
const evidenceCrypto = Crypto.make({
  randomBytes,
  digest: (algorithm, data) =>
    Effect.try({
      try: () =>
        Uint8Array.from(
          createHash(
            {
              "SHA-1": "sha1",
              "SHA-256": "sha256",
              "SHA-384": "sha384",
              "SHA-512": "sha512",
            }[algorithm],
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
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const same = (a: unknown, b: unknown) =>
  a === undefined || b === undefined ? a === b : canonicalSharedJson(a) === canonicalSharedJson(b)

/** A bounded interpretation of complete linked References pages. This changes
 * record mode/storage layout only, never file ownership or complete flags. */
export function enrichLegacyPageFacts(
  entry: SharedMigrationEntry,
  activity: Activity,
  provenance: unknown,
) {
  return Effect.gen(function* () {
    const record = property(entry.record),
      locator = property(record.locator)
    requireFact(
      locator.type === "notion_page" && record.kind === "skill",
      "Select an ordinary retained Skill page, not a generated Router.",
    )
    requireFact(
      entry.legacy_mode === undefined ||
        entry.legacy_mode === "unknown" ||
        entry.legacy_mode === "tracked",
      "Do not replace a conflicting known legacy mode.",
    )
    requireFact(
      entry.legacy_layout === undefined ||
        entry.legacy_layout === "unknown" ||
        entry.legacy_layout === "ordinary_page",
      "Do not replace a conflicting known legacy layout.",
    )
    const row = property(JSON.parse(activity.catalog_row.json)),
      props = property(row.properties)
    const mode = property(props["Sync Mode"])
    requireFact(
      mode.type === "select" && property(mode.select).name === "tracked",
      "The full original row must explicitly select tracked.",
    )
    const refs = property(props.References)
    requireFact(
      refs.type === "rich_text" && Array.isArray(refs.rich_text),
      "Retain the complete original References rich text.",
    )
    const references: { path: string; page_id: string }[] = []
    for (const raw of refs.rich_text) {
      const item = property(raw),
        label = text([raw])
      if (label.trim() === "") continue
      const url = property(property(item.text).link).url
      const target = typeof url === "string" ? pageId(url) : undefined
      requireFact(
        item.type === "text" &&
          label === label.trim() &&
          target &&
          (item.href === undefined || item.href === url),
        "This policy requires each complete typed reference to name one exact native page.",
      )
      references.push({ path: label, page_id: target })
    }
    const supporting = entry.files.filter((file) => file.path !== record.entrypoint)
    requireFact(
      supporting.length > 0 &&
        references.length === supporting.length &&
        new Set(references.map((item) => item.path)).size === references.length &&
        new Set(entry.files.map((file) => file.path)).size === entry.files.length,
      "The ordinary-page policy needs the exact complete supporting path set.",
    )
    const pages = new Set<string>()
    let mainCount = 0
    for (const file of entry.files) {
      const raw = property(file.raw),
        native = property(raw.native_preimage),
        capture = property(raw.pilot_current_capture)
      const expected =
        file.path === record.entrypoint
          ? locator.page_id
          : references.find((item) => item.path === file.path)?.page_id
      if (file.path === record.entrypoint) mainCount++
      requireFact(
        typeof expected === "string" &&
          pageId(expected) === expected &&
          native.kind === "notion_page_markdown" &&
          native.page_id === expected &&
          capture.page_id === expected &&
          !pages.has(expected),
        "Original References and retained native preimages must bind each path to one distinct actual page.",
      )
      pages.add(expected)
    }
    requireFact(mainCount === 1, "Retain the exact single native main page.")
    const metadata = property(entry.metadata)
    requireFact(
      entry.metadata === undefined || same(entry.metadata, metadata),
      "Do not replace opaque original metadata.",
    )
    requireFact(
      !Object.hasOwn(metadata, "legacy_catalog_activity") &&
        !Object.hasOwn(metadata, "legacy_catalog_factual_enrichment"),
      "Preserve previous enrichment rather than replacing it.",
    )
    const facts = {
      version: 1,
      policy: "legacy_catalog_tracked_reference_pages_v1",
      original: {
        legacy_mode: entry.legacy_mode ?? "absent",
        legacy_layout: entry.legacy_layout ?? "absent",
      },
      mapped: { legacy_mode: "tracked", legacy_layout: "ordinary_page" },
      sync_mode: { property_id: mode.id, observed_name: "tracked" },
      references: references.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      provenance,
      ownership_inferred: false,
      complete_flags_changed: false,
    }
    const enriched: SharedMigrationEntry = {
      ...entry,
      legacy_mode: "tracked",
      legacy_layout: "ordinary_page",
      metadata: {
        ...metadata,
        legacy_catalog_activity: activity,
        legacy_catalog_factual_enrichment: facts,
      },
    }
    const activation = yield* resolveMigrationActivation(enriched, "legacy_page_to_native_v2")
    requireFact(
      activation?.policy === "legacy_catalog_active_page_v2",
      "The actual core activity policy did not validate this original row/schema.",
    )
    requireFact(
      same(enriched.files, entry.files) &&
        same(enriched.record, entry.record) &&
        enriched.files_complete === entry.files_complete &&
        enriched.metadata_complete === entry.metadata_complete,
      "Enrichment cannot change files, ownership, original records or completeness.",
    )
    return { entry: enriched, activation, facts }
  })
}

function frozen(value: unknown): FrozenFile {
  const raw = property(value)
  requireFact(
    typeof raw.path === "string" &&
      isAbsolute(raw.path) &&
      typeof raw.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(raw.sha256),
    "Bind each input to an absolute original path and SHA-256.",
  )
  return { path: raw.path, sha256: raw.sha256 }
}
function string(value: unknown, message: string): string {
  requireFact(typeof value === "string" && value.length > 0, message)
  return value
}
function array(value: unknown, message: string): readonly unknown[] {
  requireFact(Array.isArray(value), message)
  return value
}
function retained(bytes: Uint8Array, retentionRef: string): RetainedJson {
  const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  requireFact(Buffer.from(json).equals(bytes), "Retained JSON must preserve its exact UTF-8 bytes.")
  return { json, sha256: hash(bytes), bytes: bytes.length, retention_ref: retentionRef }
}

export async function enrichPilotDraft(configPath: string) {
  const bindings: { path: string; sha256: string; bytes: number }[] = []
  const read = async (item: FrozenFile) => {
    const stat = await lstat(item.path)
    requireFact(
      stat.isFile() && !stat.isSymbolicLink(),
      "Retain a regular input file, not a symlink.",
    )
    const bytes = await readFile(item.path)
    requireFact(hash(bytes) === item.sha256, "Frozen input changed: " + item.path)
    bindings.push({ ...item, bytes: bytes.length })
    return bytes
  }
  const configBytes = await readFile(configPath)
  const config = property(JSON.parse(configBytes.toString("utf8")))
  requireFact(
    config.version === 1 && config.format === "migration-pilot-factual-enrichment",
    "Select the versioned bounded enrichment config.",
  )
  const output = string(config.output, "Choose one new output directory.")
  requireFact(isAbsolute(output), "Output must be absolute.")
  try {
    await lstat(output)
    throw new Error("Output already exists; keep the original run.")
  } catch (error) {
    if (property(error).code !== "ENOENT") throw error
  }
  const originalBytes = await read(frozen(config.original_input)),
    baseBytes = await read(frozen(config.assembled_input))
  const original = property(JSON.parse(originalBytes.toString("utf8"))),
    base = property(JSON.parse(baseBytes.toString("utf8")))
  requireFact(
    same(original.approved_legacy_ids, []) && same(base.approved_legacy_ids, []),
    "This followup cannot add or reuse approvals.",
  )
  for (const name of [
    "version",
    "scope",
    "target_library_id",
    "backup",
    "preservation",
    "readiness_evidence",
  ])
    requireFact(same(original[name], base[name]), "The assembled input changed original " + name)
  const originalCatalog = property(original.catalog),
    catalog = property(base.catalog)
  const beforeEntries = array(originalCatalog.entries, "Original catalog entries are missing.")
  const entries = array(catalog.entries, "Assembled catalog entries are missing.")
  requireFact(
    same(originalCatalog.coverage, catalog.coverage) &&
      same(
        beforeEntries.map((item) => property(item).legacy_id),
        entries.map((item) => property(item).legacy_id),
      ),
    "Keep full original coverage and every catalog identity in order.",
  )
  const metadataRoot = string(
    config.original_metadata_root,
    "Retain the original metadata evidence root.",
  )
  requireFact(isAbsolute(metadataRoot), "Metadata retention root must be absolute.")
  for (const [field, name] of [
    ["schema", "schema.raw.json"],
    ["schema_request", "schema-request.json"],
    ["schema_completion", "schema-completion.json"],
    ["row_origins", "row-origins.json"],
  ] as const)
    requireFact(
      frozen(config[field]).path === join(metadataRoot, name),
      "Keep each original metadata file at its recorded retention coordinate.",
    )
  const rowOriginsBytes = await read(frozen(config.row_origins)),
    origins = array(JSON.parse(rowOriginsBytes.toString("utf8")), "Row origins are missing.")
  const schemaBytes = await read(frozen(config.schema)),
    schema = property(JSON.parse(schemaBytes.toString("utf8")))
  const schemaRequestBytes = await read(frozen(config.schema_request)),
    schemaRequest = property(JSON.parse(schemaRequestBytes.toString("utf8")))
  const schemaCompletionBytes = await read(frozen(config.schema_completion)),
    completion = property(JSON.parse(schemaCompletionBytes.toString("utf8")))
  const schemaArgv = array(schemaRequest.argv, "Missing schema GET argv.")
  requireFact(
    schemaArgv.length === 7 &&
      same(schemaArgv.slice(1), [
        "api",
        `v1/data_sources/${schema.id}`,
        "--notion-version",
        "2026-03-11",
        "-X",
        "GET",
      ]) &&
      completion.exit_code === 0 &&
      completion.requests === 1 &&
      completion.notion_writes === 0 &&
      completion.response_sha256 === hash(schemaBytes) &&
      completion.response_bytes === schemaBytes.length,
    "The full schema needs its successful exact API 2026-03-11 GET receipt.",
  )
  const selections = array(config.entries, "Select the exact two retained Skill rows.")
  requireFact(
    selections.length === 2,
    "This bounded followup updates exactly the two observed ordinary Skills.",
  )
  const replacements = new Map<string, SharedMigrationEntry>(),
    reports: unknown[] = []
  for (const selectionValue of selections) {
    const selection = property(selectionValue),
      label = string(selection.label, "Missing private selection label.")
    const legacyId = string(selection.legacy_id, "Missing exact original legacy ID.")
    requireFact(
      !replacements.has(legacyId) && /^[a-z][a-z0-9_-]*$/u.test(label),
      "Do not duplicate or expand a selection.",
    )
    const matches = entries.filter((item) => property(item).legacy_id === legacyId)
    requireFact(matches.length === 1, "The exact legacy entry must occur once in the full input.")
    const entry = Schema.decodeUnknownSync(SharedMigrationEntrySchema)(matches[0], {
      onExcessProperty: "error",
    })
    const rowBytes = await read(frozen(selection.row)),
      row = property(JSON.parse(rowBytes.toString("utf8")))
    const foundOrigins = origins.filter(
      (item) => property(item).name === label && property(item).page_id === row.id,
    )
    requireFact(foundOrigins.length === 1, "Missing exact original query-row origin.")
    const origin = property(foundOrigins[0]),
      queryPath = string(origin.query, "Missing retained original query.")
    requireFact(
      origin.retained_row === join(metadataRoot, label + ".row.json") &&
        frozen(selection.row).path === origin.retained_row &&
        origin.row_sha256 === hash(rowBytes) &&
        origin.row_bytes === rowBytes.length,
      "Original row identity or exact bytes differ from their extraction receipt.",
    )
    const queryBytes = await read(frozen({ path: queryPath, sha256: origin.query_sha256 }))
    requireFact(
      typeof origin.byte_start === "number" &&
        Number.isSafeInteger(origin.byte_start) &&
        origin.byte_start >= 0 &&
        typeof origin.byte_end === "number" &&
        Number.isSafeInteger(origin.byte_end) &&
        origin.byte_end - origin.byte_start === rowBytes.length &&
        queryBytes.subarray(origin.byte_start, origin.byte_end).equals(rowBytes),
      "The extracted row is not the original query byte slice.",
    )
    const query = property(JSON.parse(queryBytes.toString("utf8"))),
      queryRows = array(query.results, "Original query lacks results.")
    requireFact(
      typeof origin.array_index === "number" &&
        Number.isSafeInteger(origin.array_index) &&
        same(queryRows[origin.array_index], row),
      "The retained row differs from its original query array index.",
    )
    const requestPath = queryPath.replace(/\.json$/u, ".request.json")
    const requestBytes = await read(frozen(selection.query_request)),
      request = property(JSON.parse(requestBytes.toString("utf8")))
    const receiptBytes = await read(frozen(selection.query_receipt)),
      receipt = property(JSON.parse(receiptBytes.toString("utf8")))
    const queryArgv = array(receipt.argv, "Missing original query argv.")
    requireFact(
      queryArgv.length === 9 &&
        same(queryArgv.slice(1), [
          "api",
          `v1/data_sources/${schema.id}/query`,
          "--method",
          "POST",
          "--notion-version",
          "2026-03-11",
          "--data",
          "@" + requestPath,
        ]) &&
        frozen(selection.query_request).path === requestPath &&
        receipt.exit === 0 &&
        receipt.response_sha256 === hash(queryBytes) &&
        request.page_size === 100 &&
        Object.keys(request).every((key) => ["page_size", "start_cursor"].includes(key)),
      "Keep the successful unfiltered full-row query and its explicit API version.",
    )
    const activity: Activity = {
      version: 2,
      policy: "legacy_catalog_active_page_v2",
      api_version: "2026-03-11",
      catalog_row: retained(
        rowBytes,
        string(origin.retained_row, "Missing original row retention reference."),
      ),
      data_source_schema: retained(schemaBytes, join(metadataRoot, "schema.raw.json")),
    }
    const provenance = {
      row_origin: origin,
      row_origins: retained(rowOriginsBytes, frozen(config.row_origins).path),
      query_request: retained(requestBytes, requestPath),
      query_receipt: retained(receiptBytes, frozen(selection.query_receipt).path),
      schema_request: retained(schemaRequestBytes, frozen(config.schema_request).path),
      schema_completion: retained(schemaCompletionBytes, frozen(config.schema_completion).path),
    }
    const result = await Effect.runPromise(
      enrichLegacyPageFacts(entry, activity, provenance).pipe(
        Effect.provideService(Crypto.Crypto, evidenceCrypto),
      ),
    )
    replacements.set(legacyId, result.entry)
    reports.push({
      label,
      legacy_id: legacyId,
      activation: result.activation,
      mapping_policy: result.facts.policy,
      legacy_mode: result.entry.legacy_mode,
      legacy_layout: result.entry.legacy_layout,
      native_paths: result.entry.files.length,
      supporting_reference_bindings: result.facts.references.length,
      files_complete: entry.files_complete,
      metadata_complete: entry.metadata_complete,
      original_entry_sha256: hash(canonicalSharedJson(entry)),
      enriched_entry_sha256: hash(canonicalSharedJson(result.entry)),
      file_inventory_sha256: hash(canonicalSharedJson(entry.files)),
      ownership_changed: false,
      source_changed: false,
      complete_flags_changed: false,
    })
  }
  const draft: Record<string, unknown> = {
    ...base,
    catalog: {
      ...catalog,
      entries: entries.map((entry) => replacements.get(String(property(entry).legacy_id)) ?? entry),
    },
  }
  requireFact(
    same(draft.approved_legacy_ids, []) && same(draft.preservation, original.preservation),
    "Approval or preservation changed.",
  )
  for (const item of bindings)
    requireFact(
      hash(await readFile(item.path)) === item.sha256,
      "An original input changed during offline enrichment.",
    )
  requireFact(
    (await readFile(configPath)).equals(configBytes),
    "The config changed during enrichment.",
  )
  const outputBytes = encoded(draft)
  const summary = {
    version: 1,
    mode: "offline_legacy_catalog_fact_enrichment",
    status: "prepared_with_explicit_gaps",
    approved_legacy_ids: [],
    total_catalog_entries: entries.length,
    changed_entries: reports,
    remote_requests: 0,
    cli_executed: false,
    migration_executed: false,
    full_input_retained: true,
    source_changed: false,
    ownership_changed: false,
    preservation_changed: false,
    complete_flags_changed: false,
    original_input: frozen(config.original_input),
    assembled_input: frozen(config.assembled_input),
    draft: {
      file: "draft-input.json",
      sha256: hash(outputBytes),
      bytes: Buffer.byteLength(outputBytes),
    },
    unresolved: [
      "file_ownership",
      "fixed_source_selector_conversion",
      "router_member_closure",
      "original_operation_readiness",
    ],
  }
  await mkdir(output, { mode: 0o700 })
  await writeFile(join(output, "draft-input.json"), outputBytes, { flag: "wx", mode: 0o600 })
  await writeFile(join(output, "entry-proposals.json"), encoded([...replacements.values()]), {
    flag: "wx",
    mode: 0o600,
  })
  await writeFile(
    join(output, "input-bindings.json"),
    encoded([
      { path: configPath, sha256: hash(configBytes), bytes: configBytes.length },
      ...bindings,
    ]),
    { flag: "wx", mode: 0o600 },
  )
  await writeFile(join(output, "summary.json"), encoded(summary), { flag: "wx", mode: 0o600 })
  return summary
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--config")
    throw new Error(
      "Usage: bun scripts/enrich-migration-pilot-facts.ts --config FROZEN_PRIVATE_CONFIG",
    )
  enrichPilotDraft(resolve(process.argv[3]!)).then(
    (summary) =>
      process.stdout.write(
        encoded({
          ok: true,
          status: summary.status,
          changed_entries: summary.changed_entries.length,
          draft: summary.draft,
          remote_requests: 0,
        }),
      ),
    (error: unknown) => {
      process.stderr.write(String(error) + "\n")
      process.exitCode = 2
    },
  )
}
