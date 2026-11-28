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
import {
  validateCurrentSourceContributions,
  validateCurrentSourceInput,
  type CurrentSourceContribution,
} from "../packages/core/src/shared-current-source-input.ts"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"
import {
  inspectSharedSourcePlan,
  type SharedSourcePlan,
} from "../packages/core/src/shared-source-plan.ts"
import { validateFixedGithubMaterializationSource } from "../packages/core/src/shared-source-materialization.ts"
import {
  inspectFixedGithubMetadata,
  type FixedGithubFile,
  type FixedGithubSource,
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
  owners: Schema.Array(
    Schema.Struct({
      owner_page_id: Uuid,
      skill_id: Schema.String,
      name: Schema.String,
      entrypoint: Schema.String,
      relations: Schema.Struct({ origin: Schema.Array(Uuid) }),
      files: Schema.Array(Schema.Unknown),
    }),
  ),
})
const TreeFileSchema = Schema.Struct({
  path: Schema.String,
  authority: Schema.Literals(["native", "resource", "source"]),
})
const OriginalSchema = Schema.Struct({
  skill_page_id: Uuid,
  commit: Oid,
  source_path: Schema.String,
  git_oid: Oid,
  bytes: Count,
  mode: Schema.Literals(["100644", "100755"]),
  verified_sha256: Hash,
  export_object_path: Schema.String,
})
const OriginalsSchema = Schema.Struct({ hits: Schema.Array(OriginalSchema) })
const RecoveredSchema = Schema.Struct({
  complete: Schema.Literal(true),
  fetched: Schema.Array(OriginalSchema),
  failed: Schema.Array(Schema.Unknown),
})
const SupplementSchema = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({
      owner_page_id: Uuid,
      source_id: Schema.String,
      source_page_id: Uuid,
      source: Schema.Unknown,
    }),
  ),
  originals: Schema.Array(OriginalSchema),
  commit_metadata: Schema.String,
  tree_metadata: Schema.String,
  commit_metadata_sha256: Hash,
  tree_metadata_sha256: Hash,
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
type ManagementInputs = {
  readonly sources: unknown
  readonly originals: unknown
  readonly recovered: unknown
  readonly supplement?: unknown
}
type SourceMetadata = {
  readonly page_id: string
  readonly source_id: string
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly location: string
  readonly ref: string
  readonly enabled: boolean
  readonly policy: string
  readonly settings: Readonly<Record<string, unknown>>
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
const object = (input: unknown): Record<string, unknown> => {
  demand(
    input !== null && typeof input === "object" && !Array.isArray(input),
    "METADATA_INVALID",
    "Expected a complete metadata object.",
  )
  return input as Record<string, unknown>
}
function readSourceMetadata(input: unknown): SourceMetadata[] {
  return Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(input).map((raw) => {
    const row = object(raw),
      properties = object(row.properties)
    demand(
      row.object === "page" && row.in_trash !== true && row.archived !== true,
      "SOURCE_ROW_INVALID",
      "Expected an existing live Source row.",
    )
    const rich = (name: string, type = "rich_text") => {
      const field = object(properties[name])
      demand(
        field.type === type && field.has_more !== true && Array.isArray(field[type]),
        "SOURCE_ROW_INVALID",
        "Source text metadata is incomplete.",
        { name },
      )
      return field[type]
        .map((part) => {
          const value = object(part),
            content = value.plain_text ?? object(value.text).content
          demand(
            typeof content === "string",
            "SOURCE_ROW_INVALID",
            "Source text fragment is incomplete.",
          )
          return content
        })
        .join("")
    }
    const selection = (name: string) => {
      const value = object(object(properties[name]).select).name
      demand(typeof value === "string", "SOURCE_ROW_INVALID", "Source selection is incomplete.", {
        name,
      })
      return value
    }
    const options = object(JSON.parse(rich("Options")))
    demand(
      options.version === 1 &&
        Object.keys(options).every((key) => ["version", "adapter", "settings"].includes(key)),
      "SOURCE_OPTIONS_INVALID",
      "This converter accepts only the explicitly inventoried old Options envelope.",
    )
    const adapter = object(options.adapter)
    const enabled = object(properties.Enabled).checkbox
    demand(typeof enabled === "boolean", "SOURCE_ROW_INVALID", "Source enablement is incomplete.")
    const provider = selection("Provider")
    if (provider === "git")
      demand(
        Object.keys(adapter).length === 0,
        "SOURCE_OPTIONS_INVALID",
        "Git adapter metadata contains unexplained settings.",
      )
    return {
      page_id: Schema.decodeUnknownSync(Uuid)(row.id),
      source_id: validateCurrentSourceId(rich("Source ID")),
      name: rich("Name", "title"),
      description: rich("Description"),
      provider,
      location: rich("Location"),
      ref: rich("Ref"),
      enabled,
      policy: selection("Policy"),
      settings: object(options.settings),
    }
  })
}

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
  management: ManagementInputs,
) {
  const tree = Schema.decodeUnknownSync(TreeSchema)(treeInput)
  const manifests = Schema.decodeUnknownSync(ManifestsSchema)(manifestsInput)
  const preflight = Schema.decodeUnknownSync(PreflightSchema)(preflightInput)
  const metadata = readSourceMetadata(management.sources)
  const supplement =
    management.supplement === undefined
      ? undefined
      : Schema.decodeUnknownSync(SupplementSchema)(management.supplement)
  const supplementalMembers = new Map<
    string,
    { source_id: string; source_page_id: string; source: FixedGithubSource }
  >()
  if (supplement !== undefined) {
    const commitBytes = readExact(supplement.commit_metadata, 8 * 1024 * 1024)
    const treeBytes = readExact(supplement.tree_metadata, 8 * 1024 * 1024)
    demand(
      hash(commitBytes) === supplement.commit_metadata_sha256 &&
        hash(treeBytes) === supplement.tree_metadata_sha256,
      "SUPPLEMENT_METADATA_CHANGED",
      "Exact supplemental commit or complete-tree evidence changed.",
    )
    const commit = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(commitBytes)))
    const treeMetadata: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(treeBytes),
    )
    for (const member of supplement.members) {
      const source = validateFixedGithubMaterializationSource(member.source)
      const inspected = inspectFixedGithubMetadata(
        source,
        { sha: commit.sha, tree: object(commit.commit).tree },
        treeMetadata,
      )
      demand(
        !supplementalMembers.has(member.owner_page_id) &&
          source.tree === inspected.tree &&
          canonicalSharedJson(source.files.map(({ sha256: _, ...file }) => file)) ===
            canonicalSharedJson(inspected.files),
        "SUPPLEMENT_MEMBERSHIP_CONFLICT",
        "A supplemental member does not match its complete pinned provider tree.",
        { owner_page_id: member.owner_page_id },
      )
      supplementalMembers.set(member.owner_page_id, { ...member, source })
    }
  }
  const metadataByPage = new Map(metadata.map((source) => [source.page_id, source]))
  demand(
    metadataByPage.size === metadata.length &&
      new Set(metadata.map((source) => source.source_id)).size === metadata.length,
    "SOURCE_ROW_DUPLICATE",
    "Sources metadata repeats a physical or stable identity.",
  )
  const recovered = Schema.decodeUnknownSync(RecoveredSchema)(management.recovered)
  demand(
    recovered.failed.length === 0,
    "ORIGINAL_RECOVERY_INCOMPLETE",
    "Exact original recovery contains failures.",
  )
  const originals = new Map<string, typeof OriginalSchema.Type>()
  const originalKey = (owner: string, commit: string, path: string) =>
    canonicalSharedJson([owner, commit, path])
  for (const original of [
    ...Schema.decodeUnknownSync(OriginalsSchema)(management.originals).hits,
    ...recovered.fetched,
    ...(supplement?.originals ?? []),
  ]) {
    const identity = originalKey(original.skill_page_id, original.commit, original.source_path)
    const previous = originals.get(identity)
    demand(
      previous === undefined ||
        (previous.git_oid === original.git_oid &&
          previous.verified_sha256 === original.verified_sha256 &&
          previous.bytes === original.bytes &&
          previous.mode === original.mode),
      "ORIGINAL_IDENTITY_CONFLICT",
      "Original evidence disagrees for one exact selected file.",
      { owner_page_id: original.skill_page_id, source_path: original.source_path },
    )
    originals.set(identity, original)
  }
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
      const sourceMetadata = metadataByPage.get(file.source.source_page_id)
      demand(
        sourceMetadata?.source_id === sourceId &&
          sourceMetadata.provider === "git" &&
          repository(sourceMetadata.location) === repository(file.source.repository_url),
        "SOURCE_ROW_CONFLICT",
        "The current file source differs from the exact inventoried Source row.",
        where,
      )
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

  const contributions = new Map<string, CurrentSourceContribution[]>()
  const restoreFiles = new Map<
    string,
    {
      owner_page_id: string
      path: string
      source_path: string
      sha256: string
      bytes: number
      mode: "100644" | "100755"
      local_bytes_path: string
      available_file: boolean
    }[]
  >()
  const memberCounts = new Map<string, number>()
  const consumedSupplementalMembers = new Set<string>()
  const unproven = []
  for (const owner of tree.owners) {
    const currentFiles = owner.files.map((file) => Schema.decodeUnknownSync(TreeFileSchema)(file))
    const replacement = supplementalMembers.get(owner.owner_page_id)
    const fixed = replacement ?? fixedByOwner.get(owner.owner_page_id)
    const sourceIds = new Set(
      [...selected.values()]
        .filter((file) => file.owner_page_id === owner.owner_page_id)
        .map((file) => file.source.source_id),
    )
    const originGroups = owner.relations.origin.flatMap((page) => {
      const source = metadataByPage.get(page)
      demand(
        source !== undefined,
        "SOURCE_ROW_MISSING",
        "An inventoried Origin has no Source row.",
        { owner_page_id: owner.owner_page_id, source_page_id: page },
      )
      const group = groups.get(source.source_id)
      return group === undefined ? [] : [group]
    })
    const candidates = sourceIds.size ? [...sourceIds].map((id) => groups.get(id)!) : originGroups
    if (candidates.length === 0) continue
    demand(
      candidates.length === 1,
      "MEMBER_SOURCE_AMBIGUOUS",
      "The fixed member needs one exact current Source assignment.",
      { owner_page_id: owner.owner_page_id },
    )
    const group = candidates[0]!
    demand(
      replacement === undefined ||
        (sourceIds.size === 0 &&
          replacement.source_id === group.source_id &&
          replacement.source_page_id === group.source_page_id),
      "SUPPLEMENT_AUTHORITY_CONFLICT",
      "Supplemental membership may only add excluded originals to its existing active Source.",
      { owner_page_id: owner.owner_page_id },
    )
    const resourceKey =
      fixed === undefined ? "" : canonicalSharedJson([fixed.source.url, fixed.source.commit])
    demand(
      replacement === undefined || group.resources.has(resourceKey),
      "SUPPLEMENT_COMMIT_NOT_CURRENT",
      "Supplemental membership must use an already effective fixed Source commit.",
      { owner_page_id: owner.owner_page_id },
    )
    if (fixed === undefined || !group.resources.has(resourceKey)) {
      demand(
        sourceIds.size === 0,
        "CURRENT_MEMBER_MISSING",
        "An effective Source member lost its fixed current original.",
      )
      unproven.push({
        owner_page_id: owner.owner_page_id,
        skill_id: owner.skill_id,
        source_id: group.source_id,
        reason:
          fixed === undefined
            ? "no_selected_fixed_git_manifest"
            : "native_only_selected_commit_is_not_current",
        ...(fixed === undefined
          ? {}
          : { root: fixed.source.root, selected_commit: fixed.source.commit }),
      })
      continue
    }
    const exclude: string[] = [],
      mapping: Record<string, string> = {}
    const selectedPaths = new Set<string>()
    for (const entry of fixed.source.files) {
      const proof = originals.get(
        originalKey(owner.owner_page_id, fixed.source.commit, entry.source_path),
      )
      demand(
        proof !== undefined &&
          proof.git_oid === entry.git_oid &&
          proof.bytes === entry.bytes &&
          proof.mode === entry.mode &&
          (entry.sha256 === undefined || proof.verified_sha256 === entry.sha256),
        "RESTORE_ORIGINAL_MISSING",
        "A complete current member original has no exact frozen byte evidence.",
        { owner_page_id: owner.owner_page_id, source_path: entry.source_path },
      )
      let original = verified.get(proof.export_object_path)
      if (original === undefined) {
        const bytes = readExact(proof.export_object_path, 64 * 1024 * 1024)
        original = {
          sha256: hash(bytes),
          git_oid: createHash("sha1")
            .update(`blob ${bytes.byteLength}\0`)
            .update(bytes)
            .digest("hex"),
          bytes: bytes.byteLength,
        }
        verified.set(proof.export_object_path, original)
      }
      demand(
        original.git_oid === entry.git_oid &&
          original.sha256 === proof.verified_sha256 &&
          original.bytes === entry.bytes,
        "RESTORE_ORIGINAL_CHANGED",
        "A selected restore-follow original changed on disk.",
        { owner_page_id: owner.owner_page_id, source_path: entry.source_path },
      )
      const binding = group.files.find(
        (file) =>
          file.owner_page_id === owner.owner_page_id &&
          file.source.source_path === entry.source_path,
      )
      const targetPath =
        binding?.path ?? (entry.path === "SKILL.md" ? owner.entrypoint : entry.path)
      demand(
        !selectedPaths.has(targetPath),
        "MEMBER_MAPPING_COLLISION",
        "The current member maps several originals to one target path.",
        { owner_page_id: owner.owner_page_id, path: targetPath },
      )
      selectedPaths.add(targetPath)
      if (targetPath !== entry.path) mapping[entry.path] = targetPath
      if (binding === undefined) {
        exclude.push(entry.path)
        const target = currentFiles.find((file) => file.path === targetPath)
        const choices = restoreFiles.get(group.source_id) ?? []
        choices.push({
          owner_page_id: owner.owner_page_id,
          path: targetPath,
          source_path: entry.source_path,
          sha256: proof.verified_sha256,
          bytes: entry.bytes,
          mode: proof.mode,
          local_bytes_path: proof.export_object_path,
          available_file: target !== undefined && target.authority !== "source",
        })
        restoreFiles.set(group.source_id, choices)
      }
      const resource = group.resources.get(resourceKey)!
      const declared: FixedGithubFile = {
        ...entry,
        path: entry.source_path,
        sha256: proof.verified_sha256,
      }
      const previous = resource.files.find((file) => file.path === declared.path)
      demand(
        previous === undefined || canonicalSharedJson(previous) === canonicalSharedJson(declared),
        "SOURCE_PATH_CONFLICT",
        "Full member originals conflict with the current Source plan.",
        { source_path: declared.path },
      )
      if (previous === undefined)
        group.resources.set(resourceKey, { ...resource, files: [...resource.files, declared] })
    }
    const entries = contributions.get(group.source_id) ?? []
    entries.push({
      member_key: fixed.source.root || ".",
      skill_id: owner.skill_id,
      mount_path: "",
      mapping,
      exclude,
    })
    contributions.set(group.source_id, entries)
    memberCounts.set(group.source_id, (memberCounts.get(group.source_id) ?? 0) + 1)
    if (replacement !== undefined) consumedSupplementalMembers.add(owner.owner_page_id)
  }
  demand(
    consumedSupplementalMembers.size === supplementalMembers.size,
    "SUPPLEMENT_OWNER_UNUSED",
    "A supplemental member has no admitted current Source assignment.",
  )

  const originChanges = tree.owners.flatMap((owner) => {
    const after = [
      ...new Set(
        [...selected.values()]
          .filter((file) => file.owner_page_id === owner.owner_page_id)
          .map((file) => file.source.source_page_id),
      ),
    ].sort(compare)
    const before = [...owner.relations.origin].sort(compare)
    return canonicalSharedJson(before) === canonicalSharedJson(after)
      ? []
      : [
          {
            owner_page_id: owner.owner_page_id,
            skill_id: owner.skill_id,
            before,
            after,
            remove: before.filter((page) => !after.includes(page)),
            add: after.filter((page) => !before.includes(page)),
          },
        ]
  })
  const retireSources = metadata
    .filter((source) => !groups.has(source.source_id))
    .map((source) => ({
      source_page_id: source.page_id,
      source_id: source.source_id,
      name: source.name,
      provider: source.provider,
      current_source_files: 0,
      prior_origin_owner_ids: tree.owners
        .filter((owner) => owner.relations.origin.includes(source.page_id))
        .map((owner) => owner.owner_page_id)
        .sort(compare),
      required_before_retirement:
        "Confirm current native/resource transfer, remove obsolete Origin links, retire old carriers, and independently verify zero current references.",
    }))

  const plans = []
  for (const group of [...groups.values()].sort((a, b) => compare(a.source_id, b.source_id))) {
    const sourceMetadata = metadataByPage.get(group.source_page_id)!
    const normalizedContributions = validateCurrentSourceContributions(
      contributions.get(group.source_id) ?? [],
    )
    const roots = [...new Set(normalizedContributions.map((entry) => entry.member_key))].sort(
      compare,
    )
    demand(
      roots.length !== 0,
      "CONTRIBUTIONS_MISSING",
      "An active Source has no complete current member contribution.",
      { source_id: group.source_id },
    )
    const permittedLegacy = new Set([
      "require_all_included",
      "accepted_ref",
      "storage",
      "target_mode",
      "strip_prefix",
      "target_prefix",
      "patch",
      "member_patches",
    ])
    demand(
      Object.keys(sourceMetadata.settings).every((key) => permittedLegacy.has(key)),
      "SOURCE_OPTIONS_UNEXPLAINED",
      "A Source has settings outside the explicitly converted scope.",
      { source_id: group.source_id, keys: Object.keys(sourceMetadata.settings) },
    )
    const declaration = validateCurrentSourceInput({
      version: 1,
      definition: {
        version: 1,
        source_id: group.source_id,
        name: sourceMetadata.name,
        description: sourceMetadata.description,
        enabled: sourceMetadata.enabled,
        policy: sourceMetadata.policy,
        adapter: { type: "git", url: repository(sourceMetadata.location), ref: sourceMetadata.ref },
        selection: { roots, include: roots, exclude: [], mapping: {} },
        options: {
          require_all_included: true,
          ...(sourceMetadata.settings.accepted_ref === undefined
            ? {}
            : { accepted_ref: sourceMetadata.settings.accepted_ref }),
        },
      },
      contributions: normalizedContributions,
    })
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
      declaration,
      selected_members: memberCounts.get(group.source_id) ?? 0,
      restore_follow: restoreFiles.get(group.source_id) ?? [],
      metadata_normalization: {
        selection:
          "Exact admitted current member roots; unrelated former Origin members are not provider selections.",
        options:
          "Flat current options only. Former target naming is resolved by stable Skill IDs and per-file mapping; native/resource choices remain excluded and no patch is reapplied.",
        retired_legacy_option_keys: Object.keys(sourceMetadata.settings)
          .filter((key) => !["require_all_included", "accepted_ref"].includes(key))
          .sort(compare),
      },
      bindings,
    })
  }
  return {
    version: 1,
    scope:
      "AH-513 complete fixed current members with explicit contributions, exclusions and current Origin projection; no Notion writes or moving provider discovery",
    library_id: manifests.library_id,
    source_count: plans.length,
    binding_count: selected.size,
    unique_local_originals_verified: verified.size,
    complete_member_count: [...memberCounts.values()].reduce((sum, count) => sum + count, 0),
    excluded_original_count: [...restoreFiles.values()].reduce(
      (sum, files) => sum + files.length,
      0,
    ),
    origin_changes: originChanges,
    retire_sources: retireSources,
    unproven_former_origin_members: unproven,
    apply_ready: false,
    preflight_checks: preflightChecks,
    plans,
  }
}

export function parseComposeArguments(args: readonly string[]) {
  const values = new Map<string, string>()
  const flags = new Set([
    "--tree",
    "--manifests",
    "--preflight",
    "--sources",
    "--originals",
    "--recovered",
    "--output",
    "--supplement",
  ])
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
      "Use --tree ABS --manifests ABS --preflight ABS --sources ABS --originals ABS --recovered ABS --output NEW_ABS, optionally --supplement ABS, exactly once.",
    )
    values.set(flag, value)
  }
  demand(
    [...flags].every((flag) => flag === "--supplement" || values.has(flag)),
    "INVALID_ARGUMENT",
    "All seven required explicit paths must be supplied.",
  )
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
    sources: values.get("--sources")!,
    originals: values.get("--originals")!,
    recovered: values.get("--recovered")!,
    ...(values.has("--supplement") ? { supplement: values.get("--supplement")! } : {}),
    output,
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.slice(2).join(" ") === "--help") {
    process.stdout.write(
      "AH-513 current Source composition, read-only inputs and local output only.\nnode scripts/cutover-compose-sources.ts --tree ABS --manifests ABS --preflight ABS --sources ABS --originals ABS --recovered ABS --output NEW_ABS [--supplement ABS]\nBuilds complete fixed member plans, explicit exclusions, restore-follow originals and current Origin changes. Does not discover providers, write Notion, select native history as authority, or claim library readiness. Remove with AH-517.\n",
    )
  } else {
    try {
      const args = parseComposeArguments(process.argv.slice(2))
      const inputs = Object.fromEntries(
        [
          "tree",
          "manifests",
          "preflight",
          "sources",
          "originals",
          "recovered",
          ...(args.supplement === undefined ? [] : ["supplement"]),
        ].map((name) => {
          const path =
            args[
              name as
                | "tree"
                | "manifests"
                | "preflight"
                | "sources"
                | "originals"
                | "recovered"
                | "supplement"
            ]!
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
        {
          sources: inputs.sources!.value,
          originals: inputs.originals!.value,
          recovered: inputs.recovered!.value,
          ...(inputs.supplement === undefined ? {} : { supplement: inputs.supplement.value }),
        },
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
