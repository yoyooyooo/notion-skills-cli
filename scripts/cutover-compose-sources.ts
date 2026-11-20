/** AH-513 only. Compose verified current Source files; no Notion or provider I/O. Remove in AH-517. */
import { createHash } from "node:crypto"
import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Schema } from "effect"
import { localRuntime } from "../packages/cli/src/runtime.ts"
import { decodeCurrentFileContent } from "../packages/core/src/shared-current-file.ts"
import {
  prepareCurrentSharedSourceContent,
  validateCurrentSourceId,
} from "../packages/core/src/shared-current-source.ts"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"
import {
  inspectSharedSourcePlan,
  type SharedSourcePlan,
} from "../packages/core/src/shared-source-plan.ts"
import { validateFixedGithubMaterializationSource } from "../packages/core/src/shared-source-materialization.ts"
import type {
  FixedGithubFile,
  FixedGithubSource,
} from "../packages/core/src/shared-github-source.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Oid = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
const Uuid = Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u))
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const SourceFileSchema = Schema.Struct({
  authority: Schema.Literal("source"),
  path: Schema.String,
  sha256: Hash,
  bytes: Count,
  mode: Schema.Literals(["100644", "100755"]),
  local_bytes_path: Schema.String,
  source: Schema.Struct({
    source_page_id: Uuid,
    source_id: Schema.String,
    source_path: Schema.String,
    commit: Oid,
    git_oid: Oid,
    repository_url: Schema.String,
    root: Schema.String,
    selected_record_page_id: Uuid,
    legacy_source_carrier_id: Schema.String,
  }),
})
const TreeSchema = Schema.Struct({
  owners: Schema.Array(Schema.Struct({ owner_page_id: Uuid, files: Schema.Array(Schema.Unknown) })),
})
const ManifestsSchema = Schema.Struct({
  library_id: Schema.String,
  git: Schema.Array(
    Schema.Struct({
      skill_page_id: Uuid,
      record_page_id: Uuid,
      source_id: Schema.String,
      source: Schema.Unknown,
    }),
  ),
})
const PreflightSchema = Schema.Struct({
  multi_commit_sources: Schema.Array(
    Schema.Struct({
      source_page_id: Uuid,
      source_id: Schema.String,
      repository_url: Schema.String,
      selected_commit_groups: Schema.Array(
        Schema.Struct({
          commit: Oid,
          source_owned_file_count: Count,
          owners: Schema.Array(
            Schema.Struct({
              owner_page_id: Uuid,
              selected_record_page_id: Uuid,
              selected_source_carrier_id: Schema.String,
              root: Schema.String,
              source_owned_files: Schema.Array(
                Schema.Struct({
                  path: Schema.String,
                  source_path: Schema.String,
                  blob_sha: Oid,
                  sha256: Schema.NullOr(Hash),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
})
type SourceFile = typeof SourceFileSchema.Type
type SelectedFile = SourceFile & { readonly owner_page_id: string }
type Group = {
  readonly source_id: string
  readonly source_page_id: string
  readonly files: SelectedFile[]
  readonly resources: Map<string, FixedGithubSource>
}

export class ComposeError extends Error {
  readonly code: string
  readonly details: unknown
  constructor(code: string, message: string, details: unknown = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}
function demand(
  condition: unknown,
  code: string,
  message: string,
  details: unknown = {},
): asserts condition {
  if (!condition) throw new ComposeError(code, message, details)
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const repository = (url: string) => url.replace(/\.git$/u, "")
const key = (owner: string, path: string) => canonicalSharedJson([owner, path])
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

function readExact(path: string, maxBytes: number): Uint8Array {
  demand(isAbsolute(path), "INPUT_PATH_INVALID", "Inputs must be explicit absolute file paths.", {
    path,
  })
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    demand(
      before.isFile() && before.size <= maxBytes,
      "INPUT_FILE_INVALID",
      "Input is not one bounded regular file.",
      { path },
    )
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    demand(
      before.size === bytes.byteLength &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      "INPUT_CHANGED",
      "Input changed while it was being read.",
      { path },
    )
    return bytes
  } finally {
    closeSync(fd)
  }
}

/** The input tree supplies authority; old manifests supply only exact acquisition identities. */
export async function composeCurrentSources(
  treeInput: unknown,
  manifestsInput: unknown,
  preflightInput: unknown,
) {
  const tree = Schema.decodeUnknownSync(TreeSchema)(treeInput)
  const manifests = Schema.decodeUnknownSync(ManifestsSchema)(manifestsInput)
  const preflight = Schema.decodeUnknownSync(PreflightSchema)(preflightInput)
  const fixedByOwner = new Map<
    string,
    { record_page_id: string; source_id: string; source: FixedGithubSource }
  >()
  for (const member of manifests.git) {
    demand(
      !fixedByOwner.has(member.skill_page_id),
      "MANIFEST_DUPLICATE",
      "One owner has several selected Git manifests.",
      { owner_page_id: member.skill_page_id },
    )
    fixedByOwner.set(member.skill_page_id, {
      ...member,
      source: validateFixedGithubMaterializationSource(member.source),
    })
  }
  const groups = new Map<string, Group>()
  const pages = new Map<string, string>()
  const owners = new Set<string>()
  const selected = new Map<string, SelectedFile>()
  const verified = new Map<string, { sha256: string; git_oid: string; bytes: number }>()
  for (const owner of tree.owners) {
    demand(
      !owners.has(owner.owner_page_id),
      "OWNER_DUPLICATE",
      "The current tree repeats an owner.",
      { owner_page_id: owner.owner_page_id },
    )
    owners.add(owner.owner_page_id)
    const paths = new Set<string>()
    for (const raw of owner.files) {
      demand(
        raw !== null && typeof raw === "object" && "authority" in raw,
        "TREE_FILE_INVALID",
        "Every current file must declare its authority.",
      )
      if (raw.authority !== "source") continue
      const file = Schema.decodeUnknownSync(SourceFileSchema)(raw)
      const where = { owner_page_id: owner.owner_page_id, path: file.path }
      demand(
        !paths.has(file.path),
        "FILE_DUPLICATE",
        "The current tree repeats a source-owned logical path.",
        where,
      )
      paths.add(file.path)
      const sourceId = validateCurrentSourceId(file.source.source_id)
      const previousPage = pages.get(file.source.source_page_id)
      demand(
        previousPage === undefined || previousPage === sourceId,
        "SOURCE_ID_CONFLICT",
        "One Source page has several stable identities.",
        where,
      )
      pages.set(file.source.source_page_id, sourceId)
      const fixed = fixedByOwner.get(owner.owner_page_id)
      demand(
        fixed !== undefined,
        "MANIFEST_MISSING",
        "A source-owned file has no selected original Git manifest.",
        where,
      )
      demand(
        fixed.record_page_id === file.source.selected_record_page_id &&
          fixed.source_id === file.source.legacy_source_carrier_id &&
          fixed.source.commit === file.source.commit &&
          fixed.source.root === file.source.root &&
          fixed.source.url === repository(file.source.repository_url),
        "MANIFEST_IDENTITY_CONFLICT",
        "The selected manifest differs from the current exact source binding.",
        where,
      )
      const entry = fixed.source.files.find(
        (candidate) => candidate.source_path === file.source.source_path,
      )
      demand(
        entry !== undefined &&
          entry.git_oid === file.source.git_oid &&
          entry.bytes === file.bytes &&
          entry.mode === file.mode &&
          (entry.sha256 === undefined || entry.sha256 === file.sha256),
        "MANIFEST_FILE_CONFLICT",
        "The current file differs from its exact original manifest entry.",
        where,
      )
      let original = verified.get(file.local_bytes_path)
      if (original === undefined) {
        const bytes = readExact(file.local_bytes_path, 64 * 1024 * 1024)
        original = {
          sha256: hash(bytes),
          git_oid: createHash("sha1")
            .update(`blob ${bytes.byteLength}\0`)
            .update(bytes)
            .digest("hex"),
          bytes: bytes.byteLength,
        }
        verified.set(file.local_bytes_path, original)
      }
      demand(
        original.sha256 === file.sha256 &&
          original.git_oid === file.source.git_oid &&
          original.bytes === file.bytes,
        "ORIGINAL_BYTES_CONFLICT",
        "Local original bytes differ from the current SHA-256, Git blob or length.",
        where,
      )
      const chosen = { ...file, owner_page_id: owner.owner_page_id }
      selected.set(key(owner.owner_page_id, file.path), chosen)
      const group = groups.get(sourceId) ?? {
        source_id: sourceId,
        source_page_id: file.source.source_page_id,
        files: [],
        resources: new Map<string, FixedGithubSource>(),
      }
      demand(
        group.source_page_id === file.source.source_page_id,
        "SOURCE_ID_CONFLICT",
        "One Source identity has several physical pages.",
        where,
      )
      group.files.push(chosen)
      const resourceKey = canonicalSharedJson([fixed.source.url, fixed.source.commit])
      const resource = group.resources.get(resourceKey)
      demand(
        resource === undefined || resource.tree === fixed.source.tree,
        "GIT_TREE_CONFLICT",
        "One exact repository commit has conflicting tree identities.",
        where,
      )
      const declared: FixedGithubFile = { ...entry, path: entry.source_path, sha256: file.sha256 }
      const prior = resource?.files.find((candidate) => candidate.path === declared.path)
      demand(
        prior === undefined || canonicalSharedJson(prior) === canonicalSharedJson(declared),
        "SOURCE_PATH_CONFLICT",
        "One current Source path has conflicting selected file identities.",
        where,
      )
      group.resources.set(resourceKey, {
        ...fixed.source,
        root: "",
        files: prior === undefined ? [...(resource?.files ?? []), declared] : resource!.files,
      })
      groups.set(sourceId, group)
    }
  }

  const preflightChecks = preflight.multi_commit_sources.map((source) => {
    const actual = groups.get(source.source_id)
    const expected = new Set<string>()
    const historicalOnly: string[] = []
    for (const commit of source.selected_commit_groups) {
      const declaredCount = commit.owners.reduce(
        (sum, owner) => sum + owner.source_owned_files.length,
        0,
      )
      demand(
        declaredCount === commit.source_owned_file_count,
        "PREFLIGHT_COUNT_CONFLICT",
        "A preflight commit count differs from its current files.",
        { source_id: source.source_id, commit: commit.commit },
      )
      if (declaredCount === 0) historicalOnly.push(commit.commit)
      for (const owner of commit.owners)
        for (const file of owner.source_owned_files) {
          const identity = key(owner.owner_page_id, file.path)
          demand(
            !expected.has(identity),
            "PREFLIGHT_DUPLICATE",
            "Preflight repeats a source-owned file.",
            { identity },
          )
          expected.add(identity)
          const found = selected.get(identity)
          demand(
            found !== undefined &&
              found.source.source_id === source.source_id &&
              found.source.source_page_id === source.source_page_id &&
              repository(found.source.repository_url) === repository(source.repository_url) &&
              found.source.commit === commit.commit &&
              found.source.root === owner.root &&
              found.source.selected_record_page_id === owner.selected_record_page_id &&
              found.source.legacy_source_carrier_id === owner.selected_source_carrier_id &&
              found.source.source_path === file.source_path &&
              found.source.git_oid === file.blob_sha &&
              (file.sha256 === null || found.sha256 === file.sha256),
            "PREFLIGHT_BINDING_CONFLICT",
            "The current tree differs from a preflight source-owned binding.",
            { source_id: source.source_id, owner_page_id: owner.owner_page_id, path: file.path },
          )
        }
    }
    demand(
      (actual?.files.length ?? 0) === expected.size &&
        (actual?.files.every((file) => expected.has(key(file.owner_page_id, file.path))) ??
          expected.size === 0),
      "PREFLIGHT_SCOPE_CONFLICT",
      "The current Source scope differs from its complete preflight file set.",
      { source_id: source.source_id },
    )
    return {
      source_id: source.source_id,
      files: expected.size,
      excluded_native_origin_commits: historicalOnly.sort(compare),
    }
  })

  const plans = []
  for (const group of [...groups.values()].sort((a, b) => compare(a.source_id, b.source_id))) {
    const resources = [...group.resources.values()].sort((a, b) =>
      compare(canonicalSharedJson([a.url, a.commit]), canonicalSharedJson([b.url, b.commit])),
    )
    const first = resources[0]!
    const input: SharedSourcePlan = {
      version: 1,
      kind: "composition",
      base: { kind: "git", source: first },
      mounts: resources
        .slice(1)
        .map((source) => ({ mount_path: "", resource: { kind: "git" as const, source } })),
    }
    const inspection = inspectSharedSourcePlan(input)
    // Only NodeServices is activated; Store, credentials and provider services are not provided.
    const prepared = await Effect.runPromise(
      prepareCurrentSharedSourceContent(inspection.plan).pipe(Effect.provide(localRuntime)),
    )
    const bindings = group.files
      .sort((a, b) => compare(key(a.owner_page_id, a.path), key(b.owner_page_id, b.path)))
      .map((file) => ({
        owner_page_id: file.owner_page_id,
        path: file.path,
        source_path: file.source.source_path,
        commit: file.source.commit,
        git_oid: file.source.git_oid,
        content: decodeCurrentFileContent({
          kind: "source",
          source_id: group.source_id,
          revision: prepared.revision,
          source_path: file.source.source_path,
          sha256: file.sha256,
          bytes: file.bytes,
          mode: file.mode,
        }),
      }))
    plans.push({
      source_page_id: group.source_page_id,
      source_id: group.source_id,
      revision: prepared.revision,
      plan: inspection.plan,
      manifest_files: inspection.manifest.length,
      manifest_bytes: new TextEncoder().encode(canonicalSharedJson(inspection.plan)).byteLength,
      manifest_storage:
        "resource" in prepared.content
          ? { kind: "resource" as const, content: prepared.content.resource }
          : { kind: "inline" as const },
      commits: resources.map((source) => ({
        repository_url: source.url,
        commit: source.commit,
        tree: source.tree,
        files: source.files.length,
      })),
      bindings,
    })
  }
  return {
    version: 1,
    scope:
      "AH-513 actual current Source-owned files only; no Notion writes or Source management declaration",
    library_id: manifests.library_id,
    source_count: plans.length,
    binding_count: selected.size,
    unique_local_originals_verified: verified.size,
    preflight_checks: preflightChecks,
    plans,
  }
}

export function parseComposeArguments(args: readonly string[]) {
  const values = new Map<string, string>()
  const flags = new Set(["--tree", "--manifests", "--preflight", "--output"])
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1]
    demand(
      flag !== undefined &&
        flags.has(flag) &&
        !values.has(flag) &&
        value !== undefined &&
        isAbsolute(value),
      "INVALID_ARGUMENT",
      "Use --tree ABS --manifests ABS --preflight ABS --output NEW_ABS exactly once.",
    )
    values.set(flag, value)
  }
  demand(values.size === flags.size, "INVALID_ARGUMENT", "All four explicit paths are required.")
  const output = values.get("--output")!
  demand(
    [...values].every(([flag, value]) => flag === "--output" || resolve(value) !== resolve(output)),
    "INVALID_ARGUMENT",
    "Output must not replace an input.",
  )
  return {
    tree: values.get("--tree")!,
    manifests: values.get("--manifests")!,
    preflight: values.get("--preflight")!,
    output,
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.slice(2).join(" ") === "--help") {
    process.stdout.write(
      "AH-513 current Source composition, read-only inputs and local output only.\nnode scripts/cutover-compose-sources.ts --tree ABS --manifests ABS --preflight ABS --output NEW_ABS\nUses exact verified Git originals and current plan primitives. Does not discover providers, write Notion, select native history as authority, or claim library readiness. Remove with AH-517.\n",
    )
  } else {
    try {
      const args = parseComposeArguments(process.argv.slice(2))
      const inputs = Object.fromEntries(
        ["tree", "manifests", "preflight"].map((name) => {
          const path = args[name as "tree" | "manifests" | "preflight"]
          const bytes = readExact(path, 64 * 1024 * 1024)
          return [
            name,
            {
              path,
              sha256: hash(bytes),
              value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
            },
          ]
        }),
      )
      const result = await composeCurrentSources(
        inputs.tree!.value,
        inputs.manifests!.value,
        inputs.preflight!.value,
      )
      const output = {
        ...result,
        inputs: Object.fromEntries(
          Object.entries(inputs).map(([name, { path, sha256 }]) => [name, { path, sha256 }]),
        ),
      }
      writeFileSync(args.output, JSON.stringify(output, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      })
      process.stdout.write(
        JSON.stringify({
          output: args.output,
          sources: result.source_count,
          bindings: result.binding_count,
          originals_verified: result.unique_local_originals_verified,
          preflight_checks: result.preflight_checks,
        }) + "\n",
      )
    } catch (error) {
      process.stderr.write(
        JSON.stringify(
          error instanceof ComposeError
            ? { code: error.code, message: error.message, details: error.details }
            : {
                code: "COMPOSE_FAILED",
                message: error instanceof Error ? error.message : "Source composition failed.",
              },
        ) + "\n",
      )
      process.exitCode = 1
    }
  }
}
