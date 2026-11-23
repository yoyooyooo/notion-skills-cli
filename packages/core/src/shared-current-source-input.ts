import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import type { createRequestMetrics } from "./request-metrics.ts"
import { planSharedFiles } from "./shared-composition.ts"
import {
  prepareCurrentSharedSourceContent,
  validateCurrentSourceId,
} from "./shared-current-source.ts"
import { currentWriteIdentity } from "./shared-current-write-input.ts"
import { assertSupportedGitBlob, gitBlobOid, type FixedGithubFile } from "./shared-github-source.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sourceDiscoveryInput } from "./shared-source-adapters.ts"
import { canonicalGitUrl } from "./shared-git-origin.ts"
import { sourceRich, validateSourceDefinition } from "./shared-source-definitions.ts"
import { validateFixedGithubMaterializationSource } from "./shared-source-materialization.ts"
import type { SharedSourcePlan } from "./shared-source-plan.ts"
import { SourceDefinitionInputSchema, type SourceDefinitionInput } from "./shared-sources-model.ts"
import { sha256 } from "./store.ts"
import { discoverSource, selectMembers, SourceSnapshotSchema } from "./upstream-source.ts"
import { sourceExternalResourceTargets } from "./upstream-member-links.ts"

export const CurrentSourceContributionSchema = Schema.Struct({
  member_key: Schema.String,
  skill_id: Schema.String,
  mount_path: Schema.String,
  mapping: Schema.Record(Schema.String, Schema.String),
  exclude: Schema.Array(Schema.String),
})
export const CurrentSourceContributionsSchema = Schema.Array(CurrentSourceContributionSchema)
export type CurrentSourceContribution = typeof CurrentSourceContributionSchema.Type
export const CurrentSourceInputSchema = Schema.Struct({
  version: Schema.Literal(1),
  definition: SourceDefinitionInputSchema,
  contributions: CurrentSourceContributionsSchema,
})
export type CurrentSourceDeclaration = typeof CurrentSourceInputSchema.Type
export type PreparedCurrentSourceFile = {
  readonly path: string
  readonly bytes: Uint8Array
  readonly mode: "100644" | "100755"
  readonly authority: {
    readonly kind: "source"
    readonly source_id: string
    readonly revision: string
    readonly source_path: string
  }
}
export type PreparedCurrentSourceTarget = {
  readonly skill_id: string
  readonly kind: "skill"
  readonly defaults: { readonly name: string; readonly description: string }
  readonly members: readonly string[]
  readonly files: readonly PreparedCurrentSourceFile[]
}
export type PreparedCurrentSourceInput = {
  readonly declaration: CurrentSourceDeclaration
  readonly configuration_sha256: string
  readonly resolved_commit: string
  readonly prepared_source: Effect.Success<ReturnType<typeof prepareCurrentSharedSourceContent>>
  readonly plan: SharedSourcePlan
  readonly targets: readonly PreparedCurrentSourceTarget[]
}
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_SOURCE_INPUT_INVALID", message, details)
const unsupported = (message: string, details?: unknown) =>
  fail("CURRENT_SOURCE_WRITE_UNSUPPORTED", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The current Source declaration is invalid."),
  })
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function exactPath(path: string, label: string): string {
  if (path.length > 4096) throw invalid(`${label} must be one exact bounded path.`, { path })
  planSharedFiles({ base: [{ path }], mounts: [], overrides: [], entrypoint: path })
  return path
}

/** The Sources property owns current target mapping and persistent file exclusions.
 * These paths are member-relative; Source.Selection remains member-root discovery. */
export function validateCurrentSourceContributions(input: unknown) {
  const decoded = Schema.decodeUnknownSync(CurrentSourceContributionsSchema)(
    structuredClone(input),
    { onExcessProperty: "error" },
  )
  const identities = new Set<string>()
  const contributions = decoded.map((entry) => {
    if (entry.member_key !== ".") exactPath(entry.member_key, "Member key")
    currentWriteIdentity(entry.skill_id, "Target Skill ID")
    if (entry.mount_path !== "") exactPath(entry.mount_path, "Mount path")
    const identity = canonicalSharedJson([entry.member_key, entry.skill_id])
    if (identities.has(identity))
      throw invalid("One member can contribute only once to the same stable Skill.", {
        member_key: entry.member_key,
        skill_id: entry.skill_id,
      })
    identities.add(identity)
    for (const [path, target] of Object.entries(entry.mapping)) {
      exactPath(path, "Mapped source path")
      exactPath(target, "Mapped target path")
    }
    if (new Set(entry.exclude).size !== entry.exclude.length)
      throw invalid("A file exclusion must occur only once within its contribution.")
    for (const path of entry.exclude) exactPath(path, "Excluded file path")
    return { ...entry, exclude: [...entry.exclude].sort(compare) }
  })
  contributions.sort(
    (a, b) => compare(a.skill_id, b.skill_id) || compare(a.member_key, b.member_key),
  )
  const serialized = canonicalSharedJson(contributions)
  if (new TextEncoder().encode(serialized).byteLength > 180_000)
    throw invalid("Current contributions exceed one complete Sources property.")
  sourceRich(serialized)
  return contributions
}

function gitUrl(definition: SourceDefinitionInput): string {
  if (definition.adapter.type !== "git")
    throw unsupported("Current Source writes require a Git source with regular files.")
  return canonicalGitUrl(definition.adapter.url)
}

/** Explicit assignments override stable identities; discovery owns current membership. */
function resolveCurrentSourceContributions(input: {
  readonly source_id: string
  readonly members: readonly string[]
  readonly overrides: readonly CurrentSourceContribution[]
}) {
  return Effect.gen(function* () {
    const selected = new Set(input.members)
    const contributions = input.overrides.filter((entry) => selected.has(entry.member_key))
    const assigned = new Set(contributions.map((entry) => entry.member_key))
    for (const member_key of [...selected].sort(compare)) {
      if (assigned.has(member_key)) continue
      contributions.push({
        member_key,
        skill_id: `skill-${yield* sha256(canonicalSharedJson(["source-member", input.source_id, member_key]))}`,
        mount_path: "",
        mapping: {},
        exclude: [],
      })
    }
    return yield* checked(() => validateCurrentSourceContributions(contributions))
  })
}

export function validateCurrentSourceInput(input: unknown): CurrentSourceDeclaration {
  const decoded = Schema.decodeUnknownSync(CurrentSourceInputSchema)(structuredClone(input), {
    onExcessProperty: "error",
  })
  const requested = validateSourceDefinition(decoded.definition)
  validateCurrentSourceId(requested.source_id)
  const url = gitUrl(requested)
  if (requested.adapter.type !== "git") throw unsupported("Use a Git Source.")
  const definition: SourceDefinitionInput = {
    ...requested,
    adapter: { ...requested.adapter, url },
  }
  const permitted = new Set(["accepted_ref", "require_all_included"])
  for (const key of Object.keys(definition.options))
    if (!permitted.has(key))
      throw unsupported("This option has no current fixed-file write behavior.", { option: key })
  const accepted = definition.options.accepted_ref
  if (accepted !== undefined && (typeof accepted !== "string" || !/^[a-f0-9]{40}$/u.test(accepted)))
    throw invalid("accepted_ref must select an exact lowercase Git commit.")
  const requireAllIncluded = definition.options.require_all_included
  if (requireAllIncluded !== undefined && typeof requireAllIncluded !== "boolean")
    throw invalid("require_all_included must be boolean.")
  if (
    definition.policy === "pinned" &&
    definition.adapter.type === "git" &&
    accepted !== undefined &&
    accepted !== definition.adapter.ref
  )
    throw invalid("A pinned definition and accepted_ref must select the same commit.")
  return {
    version: 1,
    definition,
    contributions: validateCurrentSourceContributions(decoded.contributions),
  }
}

function exactCommit(input: CurrentSourceDeclaration, override?: string): string | undefined {
  if (override !== undefined && !/^[a-f0-9]{40}$/u.test(override))
    throw invalid("A resumed Source intent must select an exact lowercase Git commit.")
  const configured =
    typeof input.definition.options.accepted_ref === "string"
      ? input.definition.options.accepted_ref
      : input.definition.policy === "pinned" && input.definition.adapter.type === "git"
        ? input.definition.adapter.ref
        : undefined
  if (configured !== undefined && override !== undefined && configured !== override)
    throw invalid("The resumed commit differs from the declaration's explicit fixed revision.")
  return override ?? configured
}

/** Prepare a real adapter observation without Notion writes or authority conversion.
 * Every fixed blob is checked before any target files are returned. */
export function prepareCurrentSourceFromDiscovery(
  input: unknown,
  observation: unknown,
  options: { readonly exactCommit?: string } = {},
) {
  return Effect.gen(function* () {
    const requested_declaration = yield* checked(() => validateCurrentSourceInput(input))
    const expected = yield* checked(() => exactCommit(requested_declaration, options.exactCommit))
    const snapshot = yield* checked(() =>
      Schema.decodeUnknownSync(SourceSnapshotSchema)(structuredClone(observation), {
        onExcessProperty: "error",
      }),
    )
    const url = yield* checked(() => gitUrl(requested_declaration.definition))
    yield* checked(() => {
      if (!requested_declaration.definition.enabled)
        throw fail("SOURCE_DISABLED", "Enable this Source before preparing its current files.")
      if (
        !/^[a-f0-9]{40}$/u.test(snapshot.revision) ||
        (expected !== undefined && snapshot.revision !== expected) ||
        snapshot.provenance.git_url === undefined ||
        canonicalGitUrl(snapshot.provenance.git_url) !== url ||
        snapshot.provenance.resolved_ref !== snapshot.revision
      )
        throw invalid("The observation does not identify the selected exact Git origin and commit.")
      if (snapshot.unavailable?.length)
        throw unsupported("A Source reference cannot escape its complete Git repository.")
      const selected = new Set(snapshot.members.map((member) => member.member_key))
      if (selected.size !== snapshot.members.length)
        throw invalid("The complete Git observation contains duplicate members.")
      if (selected.size === 0 && !/^[a-f0-9]{40}$/u.test(snapshot.provenance.tree_hash ?? ""))
        throw invalid("A complete empty selection must identify the exact Git tree.")
    })
    const declaration: CurrentSourceDeclaration = {
      ...requested_declaration,
      contributions: yield* resolveCurrentSourceContributions({
        source_id: requested_declaration.definition.source_id,
        members: snapshot.members.map((member) => member.member_key),
        overrides: requested_declaration.contributions,
      }),
    }
    const sourceFiles: FixedGithubFile[] = []
    const verified = new Map<string, { bytes: Uint8Array; mode: "100644" | "100755" }>()
    const members = new Map(snapshot.members.map((member) => [member.member_key, member]))
    let tree: string | undefined = snapshot.provenance.tree_hash
    for (const member of snapshot.members) {
      const manifest = yield* checked(() => {
        if (member.member_key !== ".") exactPath(member.member_key, "Discovered member key")
        const selected = member.git_manifest
        if (
          selected === undefined ||
          member.git_materialization !== undefined ||
          member.patch_hash !== undefined
        )
          throw unsupported(
            "Only unchanged regular Git files have a current fixed-source representation.",
            {
              member_key: member.member_key,
            },
          )
        if (
          member.source_path !== member.member_key ||
          selected.root !== (member.member_key === "." ? "" : member.member_key) ||
          selected.commit !== snapshot.revision ||
          (tree !== undefined && selected.tree !== tree) ||
          member.portable.main !== "SKILL.md" ||
          selected.files.length !== member.portable.files.length ||
          new Set(member.portable.files.map((file) => file.path)).size !==
            member.portable.files.length
        )
          throw invalid("The member observation differs from its complete fixed Git tree.", {
            member_key: member.member_key,
          })
        return selected
      })
      tree = manifest.tree
      const files = new Map(member.portable.files.map((file) => [file.path, file]))
      for (const entry of manifest.files) {
        const file = yield* checked(() => {
          const file = files.get(entry.path)
          if (
            file === undefined ||
            file.bytes.byteLength !== entry.bytes ||
            entry.source_path !==
              (manifest.root === "" ? entry.path : `${manifest.root}/${entry.path}`) ||
            (entry.mode !== "100644" && entry.mode !== "100755") ||
            (file.mode !== undefined && file.mode !== entry.mode) ||
            verified.has(entry.source_path)
          )
            throw invalid("The original Git file identity, size, path or mode is incomplete.", {
              member_key: member.member_key,
              path: entry.path,
            })
          assertSupportedGitBlob(file.bytes)
          return { bytes: file.bytes.slice(), mode: entry.mode }
        })
        if ((yield* gitBlobOid(file.bytes)) !== entry.git_oid)
          return yield* Effect.fail(
            invalid("Prepared bytes differ from their exact original Git blob.", {
              member_key: member.member_key,
              path: entry.path,
            }),
          )
        verified.set(entry.source_path, file)
        sourceFiles.push({
          ...entry,
          path: entry.source_path,
          sha256: yield* sha256(file.bytes),
        })
      }
    }
    const references = snapshot.external_resources ?? []
    yield* checked(() => {
      const expected = sourceExternalResourceTargets(
        snapshot.members,
        references.map((reference) => ({
          path: reference.source_path,
          oid: reference.git_oid,
          mode: reference.mode,
          type: "blob",
        })),
      )
      if (expected.length !== references.length)
        throw invalid(
          "Repository reference metadata must identify each authored outside-member target once.",
        )
    })
    for (const reference of references) {
      yield* checked(() => {
        exactPath(reference.source_path, "Repository reference path")
        if (verified.has(reference.source_path))
          throw invalid("A repository reference cannot duplicate a selected member file.")
        assertSupportedGitBlob(reference.bytes)
      })
      const sha = yield* sha256(reference.bytes)
      if ((yield* gitBlobOid(reference.bytes)) !== reference.git_oid || sha !== reference.sha256)
        return yield* Effect.fail(
          invalid("Repository reference bytes differ from their fixed Git identity."),
        )
      verified.set(reference.source_path, { bytes: reference.bytes, mode: reference.mode })
      sourceFiles.push({
        path: reference.source_path,
        source_path: reference.source_path,
        git_oid: reference.git_oid,
        bytes: reference.bytes.byteLength,
        mode: reference.mode,
        sha256: sha,
      })
    }
    yield* checked(() => {
      const selected = selectMembers(
        { ...sourceDiscoveryInput(declaration.definition), allow_empty: true },
        [...members.keys()],
        [...verified.keys()],
      )
      if (selected.length !== members.size)
        throw invalid("The discovered members differ from the complete declared selection.")
    })
    const source = yield* checked(() =>
      validateFixedGithubMaterializationSource({
        url,
        commit: snapshot.revision,
        tree,
        root: "",
        files: sourceFiles,
      }),
    )
    const plan: SharedSourcePlan = {
      version: 1,
      kind: "composition",
      base: { kind: "git", source },
      mounts: [],
    }
    const prepared_source = yield* prepareCurrentSharedSourceContent(plan)
    const targets = new Map<
      string,
      {
        skill_id: string
        kind: "skill"
        defaults: { name: string; description: string }
        members: string[]
        files: PreparedCurrentSourceFile[]
      }
    >()
    for (const contribution of declaration.contributions) {
      const member = members.get(contribution.member_key)!
      const target = targets.get(contribution.skill_id) ?? {
        skill_id: contribution.skill_id,
        kind: "skill" as const,
        defaults: { name: member.portable.name, description: member.portable.description },
        members: [],
        files: [],
      }
      target.members.push(contribution.member_key)
      const excluded = new Set(contribution.exclude)
      for (const file of member.portable.files) {
        if (excluded.has(file.path)) continue
        const mapped = contribution.mapping[file.path] ?? file.path
        const path =
          contribution.mount_path === "" ? mapped : `${contribution.mount_path}/${mapped}`
        const source_path =
          member.member_key === "." ? file.path : `${member.member_key}/${file.path}`
        const declared = verified.get(source_path)!
        target.files.push({
          path,
          bytes: declared.bytes.slice(),
          mode: declared.mode,
          authority: {
            kind: "source",
            source_id: declaration.definition.source_id,
            revision: prepared_source.revision,
            source_path,
          },
        })
        if (path === "SKILL.md")
          target.defaults = { name: member.portable.name, description: member.portable.description }
      }
      targets.set(contribution.skill_id, target)
    }
    yield* checked(() => {
      for (const target of targets.values()) {
        target.files.sort((a, b) => compare(a.path, b.path))
        const first = target.files[0]
        if (first !== undefined)
          planSharedFiles({ base: target.files, mounts: [], overrides: [], entrypoint: first.path })
      }
    })
    return {
      declaration,
      configuration_sha256: yield* sha256(canonicalSharedJson(declaration)),
      resolved_commit: snapshot.revision,
      prepared_source,
      plan,
      targets: [...targets.values()].sort((a, b) => compare(a.skill_id, b.skill_id)),
    } satisfies PreparedCurrentSourceInput
  })
}

/** Only the parent finite intent may supply exactCommit when resuming. Sparse
 * overrides and stored resolved assignments converge to the same configuration. */
export function prepareCurrentSource(
  input: unknown,
  options: {
    readonly exactCommit?: string
    readonly metrics?: ReturnType<typeof createRequestMetrics>
  } = {},
) {
  return Effect.gen(function* () {
    const declaration = yield* checked(() => validateCurrentSourceInput(input))
    const selected = yield* checked(() => exactCommit(declaration, options.exactCommit))
    const effective =
      selected === undefined
        ? declaration.definition
        : {
            ...declaration.definition,
            options: { ...declaration.definition.options, accepted_ref: selected },
          }
    const observation = yield* discoverSource(
      { ...sourceDiscoveryInput(effective), allow_empty: true },
      { metrics: options.metrics },
    )
    return yield* prepareCurrentSourceFromDiscovery(declaration, observation, options)
  })
}
