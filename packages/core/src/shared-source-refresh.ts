import { Clock, Effect, Schema } from "effect"
import { zipSync } from "fflate"
import { authScope } from "./catalog.ts"
import { fail, property, text, snapshotMembers, type SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { readImportZip, importDocument, type ImportFile } from "./import.ts"
import { canonicalMain } from "./portable.ts"
import { pageId } from "./ref.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { discoverSourceDefinition } from "./shared-source-adapters.ts"
import {
  makeSourceBinding,
  registerSourceBinding,
  SharedGitSourceBindingSchema,
} from "./shared-source-binding.ts"
import { materializeFixedGithubSource } from "./shared-source-materialization.ts"
import { prepareSourceMember } from "./shared-source-member.ts"
import {
  guardedSourceMutation,
  readSourceDefinition,
  listSourceMembers,
  sourceChecked,
  sourceField,
  sourceRich,
  sourceTable,
} from "./shared-source-definitions.ts"
import { RetainedSourceSchema, validateRetainedSource } from "./shared-retained-source.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  validateSharedRecordEnvelope,
  querySharedRecords,
  type AppendSharedRecordInput,
} from "./shared-records.ts"
import { resolveSelectedSharedSource } from "./shared-selected-source.ts"
import { openSharedSnapshot } from "./shared-snapshot.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { resolveFileState, FileEventSchema } from "./shared-file-state.ts"
import { composeSharedFilePlacements, sharedFileSourcePath } from "./shared-file-placement.ts"
import { materializeSharedNativeFile, parseSharedFileLinks } from "./shared-native-file-content.ts"
import { compileSharedNativeReferences } from "./shared-native-references.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import { querySharedSkillRelation, renderSharedRouterMembers } from "./shared-router-members.ts"
import type { SourceSnapshot } from "./upstream-source.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import {
  applySharedSourceSelection,
  prepareSharedSourceSelection,
  reconcileSharedSourceSelection,
  validateSharedSourceSelectionPlan,
} from "./shared-source-selection.ts"
import {
  SharedMetadataWritePlanSchema,
  type SharedMetadataWritePlan,
} from "./shared-metadata-write-model.ts"
import { prepareSharedMetadataWrite } from "./shared-metadata-write.ts"
import { sha256, Store } from "./store.ts"

export const MemberReviewSchema = Schema.Struct({
  version: Schema.Literal(1),
  comparison: Schema.Literal("current_origin_bindings"),
  relation_ownership: Schema.Literal("notion"),
  relation_writes: Schema.Literal(false),
  added: Schema.Array(
    Schema.Struct({ member_key: Schema.String, name: Schema.String, description: Schema.String }),
  ),
  missing: Schema.Array(
    Schema.Struct({
      member_key: Schema.String,
      page_id: Schema.String,
      skill_id: Schema.String,
      name: Schema.String,
    }),
  ),
  renamed: Schema.Array(
    Schema.Struct({
      member_key: Schema.String,
      page_id: Schema.String,
      skill_id: Schema.String,
      before: Schema.String,
      after: Schema.String,
    }),
  ),
})

/** Origin inventory is a review baseline, never an author-selected Members set. */
export function reviewSourceMembers(
  library: SharedLibrary,
  source: string,
  snapshot: SourceSnapshot,
  membership?: Effect.Success<ReturnType<typeof listSourceMembers>>,
) {
  return Effect.gen(function* () {
    const bound = (membership ?? (yield* listSourceMembers(library, source))).items.filter(
      (item) => item.kind === "skill" && item.member !== "",
    )
    return yield* sourceChecked(() => {
      const candidates = snapshot.members
        .map((member) => ({
          member_key: member.member_key,
          name: member.portable.name,
          description: member.portable.description,
        }))
        .sort((a, b) => (a.member_key < b.member_key ? -1 : a.member_key > b.member_key ? 1 : 0))
      if (new Set(candidates.map((item) => item.member_key)).size !== candidates.length)
        throw fail(
          "SOURCE_MEMBER_AMBIGUOUS",
          "Candidate inventory repeated an exact source member key.",
        )
      return {
        version: 1 as const,
        comparison: "current_origin_bindings" as const,
        relation_ownership: "notion" as const,
        relation_writes: false as const,
        added: candidates.filter((item) => !bound.some((row) => row.member === item.member_key)),
        missing: bound
          .filter((row) => !candidates.some((item) => item.member_key === row.member))
          .map((row) => ({
            member_key: row.member,
            page_id: row.page_id,
            skill_id: row.skill_id,
            name: row.name,
          })),
        renamed: bound.flatMap((row) => {
          const candidate = candidates.find((item) => item.member_key === row.member)
          return candidate === undefined || candidate.name === row.name
            ? []
            : [
                {
                  member_key: row.member,
                  page_id: row.page_id,
                  skill_id: row.skill_id,
                  before: row.name,
                  after: candidate.name,
                },
              ]
        }),
      }
    })
  })
}

const RefreshFields = {
  kind: Schema.Literal("source_refresh"),
  plan_id: Schema.String,
  library_id: Schema.String,
  sources_data_source_id: Schema.String,
  source_page_id: Schema.String,
  source_id: Schema.String,
  source_fingerprint: Schema.String,
  target_page_id: Schema.String,
  member: Schema.String,
  previous_pin: Schema.String,
  current_snapshot: Schema.String,
  provider_revision: Schema.String,
  provider_committed_at: Schema.optional(Schema.String),
  created_at: Schema.Number,
  projected_files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      bytes: Schema.Number,
      sha256: Schema.String,
      mode: Schema.optional(Schema.Literals(["100644", "100755"])),
    }),
  ),
  custom_files_preserved: Schema.Array(Schema.String),
}
const RetainedRefreshSchema = Schema.Struct({
  ...RefreshFields,
  version: Schema.Literals([1, 2, 3]),
  bundle_id: Schema.String,
  bundle: RetainedSourceSchema,
  archive_base64: Schema.String,
  selection: Schema.optional(SharedMetadataWritePlanSchema),
  member_review: Schema.optional(MemberReviewSchema),
})
const GitRefreshSchema = Schema.Struct({
  ...RefreshFields,
  version: Schema.Literal(4),
  source_pin: Schema.String,
  fixed_source: SharedGitSourceBindingSchema,
  source_files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha256: Schema.String,
      bytes: Schema.Number,
      mode: Schema.optional(Schema.Literals(["100644", "100755"])),
    }),
  ),
  selection: SharedMetadataWritePlanSchema,
  member_review: MemberReviewSchema,
})
export const SourceRefreshPlanSchema = Schema.Union([RetainedRefreshSchema, GitRefreshSchema])
export type SourceRefreshPlan = typeof SourceRefreshPlanSchema.Type
export type RetainedSourceRefreshPlan = typeof RetainedRefreshSchema.Type
export type SourceRefreshStorage = "auto" | "retained" | "fixed-git"
export const sourceRefreshPin = (plan: SourceRefreshPlan) =>
  plan.version === 4 ? plan.source_pin : plan.bundle_id
export const sourceRefreshFiles = (plan: SourceRefreshPlan) =>
  plan.version === 4 ? plan.source_files : plan.bundle.files

function binding(library: SharedLibrary, sourcePage: string, target: string, member?: string) {
  return Effect.gen(function* () {
    const id = pageId(target)
    if (!id)
      return yield* Effect.fail(fail("SOURCE_TARGET_INVALID", "Choose an exact shared Skill page."))
    const raw = property(yield* (yield* Notion).request(`v1/pages/${id}`))
    const ids = library.skills.property_ids
    if (property(raw.parent).data_source_id !== library.skills.data_source_id || raw.in_trash)
      return yield* Effect.fail(
        fail("SOURCE_BINDING_SCOPE", "Skill is outside the selected library."),
      )
    const origin = yield* sourceChecked(() => sourceField(raw, ids.Origin!))
    if (
      origin.has_more ||
      !Array.isArray(origin.relation) ||
      origin.relation.length !== 1 ||
      property(origin.relation[0]).id !== sourcePage
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_BINDING_CHANGED",
          "Target must have exactly this live Source definition bound.",
        ),
      )
    const key = text(sourceField(raw, ids["Source Member"]!).rich_text)
    if (!key || (member !== undefined && member !== key))
      return yield* Effect.fail(
        fail("SOURCE_MEMBER_CHANGED", "Target's exact Source Member does not match this plan."),
      )
    const index = yield* querySharedSkillIndex(library, id, raw)
    if (index.kind !== "skill" || !index.enabled)
      return yield* Effect.fail(
        fail(
          "SOURCE_TARGET_INVALID",
          "Refresh an enabled Skill member, not a generated Router or retired entry.",
        ),
      )
    return { id, raw, index, member: key }
  })
}

/** Preview effective bytes using the same ownership/placement/rendering owners
 * as ordinary consumption. Observe only the ACTUAL current selection: never
 * publish a hypothetical Source as the current cache. */
function projectCandidate(
  library: SharedLibrary,
  selected: Effect.Success<ReturnType<typeof binding>>,
  files: readonly ImportFile[],
) {
  const referenceErrorContext =
    (preparation_stage: "current_snapshot" | "candidate_file_references") =>
    (error: SkillsError) => {
      if (
        error.code !== "SHARED_REFERENCE_INVALID" ||
        typeof error.details !== "object" ||
        error.details === null ||
        Array.isArray(error.details)
      )
        return error
      return fail(error.code, error.message, {
        ...error.details,
        target_page_id: selected.id,
        source_member: selected.member,
        preparation_stage,
      })
    }
  return Effect.gen(function* () {
    const fixed = selected.index.source_reference
      ? yield* resolveSelectedSharedSource(library, selected.id, selected.index.source_reference)
      : undefined
    const scope = yield* authScope
    const record = yield* sourceChecked(() =>
      sharedRecordFromPage(
        selected.raw,
        {
          alias: library.library_id,
          database_id: library.skills.database_id,
          data_source_ids: [library.skills.data_source_id],
          title: "",
          role: "content",
          shared_library: library,
        },
        library.skills.data_source_id,
      ),
    )
    const members =
      library.skills.property_ids.Members === undefined
        ? undefined
        : yield* querySharedSkillRelation(library, {
            record,
            rawPage: selected.raw,
            field: "Members",
          })
    const required =
      library.skills.property_ids.Requires === undefined
        ? undefined
        : yield* querySharedSkillRelation(library, {
            record,
            rawPage: selected.raw,
            field: "Requires",
          })
    const current = yield* openSharedSnapshot({
      library,
      target: selected.id,
      rawPage: selected.raw,
      scope,
      startedAt: yield* Clock.currentTimeMillis,
      forceFull: true,
      readOnly: true,
      relations: { members, required },
      ...(fixed
        ? {
            fixedSource: {
              source_id: fixed.source_id,
              revision: fixed.revision,
              files: fixed.files,
              local_paths: fixed.local_paths,
            },
          }
        : {}),
    }).pipe(Effect.mapError(referenceErrorContext("current_snapshot")))
    const records = yield* querySharedRecords(library, {
      skillPageId: selected.id,
      kind: "file_event",
    })
    const events = yield* sourceChecked(() =>
      records.map((row) =>
        Schema.decodeUnknownSync(FileEventSchema)(row.payload, { onExcessProperty: "error" }),
      ),
    )
    const bindings = [selected.index.main, ...selected.index.files]
    const links = yield* sourceChecked(() =>
      parseSharedFileLinks(selected.index.file_links, library.library_id),
    )
    const overrides: import("./shared-composition.ts").CompositionOverride[] = []
    const states: Array<{
      file_id: string
      path: string
      state: ReturnType<typeof resolveFileState>
    }> = []
    const custom: string[] = []
    for (const file of bindings) {
      const state = yield* sourceChecked(() =>
        resolveFileState(
          file.file_id,
          events.filter((event) => event.file_id === file.file_id),
        ),
      )
      states.push({ file_id: file.file_id, path: file.path, state })
      if (state.ownership.kind === "following") {
        const path = yield* sourceChecked(() => sharedFileSourcePath(file.path, state))
        if (!files.some((item) => item.path === path))
          return yield* Effect.fail(
            fail(
              "SOURCE_REMOVAL_REQUIRES_REVIEW",
              "Candidate removes a currently bound following file.",
              { path: file.path },
            ),
          )
      } else if (state.ownership.kind === "tombstone")
        overrides.push({ kind: "tombstone", file_id: file.file_id, path: file.path })
      else if (state.ownership.kind === "custom") {
        const bytes = yield* (yield* Store).readBytes(`objects/${state.ownership.content.sha256}`)
        if ((yield* sha256(bytes)) !== state.ownership.content.sha256)
          return yield* Effect.fail(fail("STATE_CORRUPT", "Current custom body checksum differs."))
        overrides.push({
          kind: "custom",
          file_id: file.file_id,
          path: file.path,
          bytes,
          ...(state.ownership.content.mode === undefined || state.ownership.content.mode === null
            ? {}
            : { mode: state.ownership.content.mode }),
        })
        custom.push(file.path)
      }
    }
    const composed = yield* sourceChecked(() =>
      composeSharedFilePlacements({
        source: files,
        overrides,
        bindings: states,
        entrypoint: current.entrypoint,
      }),
    )
    const activeBindings = bindings.filter(
      (binding) =>
        states.find((item) => item.file_id === binding.file_id)?.state.ownership.kind !==
        "tombstone",
    )
    const native = yield* compileSharedNativeReferences({
      library,
      record,
      bindings: activeBindings,
      files: yield* Effect.forEach(
        composed.files.filter((file) => /\.md$/iu.test(file.path)),
        (file) =>
          Effect.gen(function* () {
            const binding = activeBindings.find((item) => item.path === file.path)
            const observed = current.shared_authoring.files.find((item) => item.path === file.path)
            return {
              path: file.path,
              markdown: yield* sourceChecked(() =>
                new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
              ),
              body_sha256: observed?.body_sha256 ?? (yield* sha256(file.bytes)),
              ...(binding === undefined ? {} : { page_id: binding.page_id }),
              ...(observed?.native_body_completion === undefined
                ? {}
                : { native_body_completion: observed.native_body_completion }),
            }
          }),
      ),
      relations: {
        members: snapshotMembers(current) ?? [],
        required: current.required ?? [],
        file_links: links,
      },
    })
    const resolvedLinks = [...links, ...native.links]
    const final = yield* sourceChecked(() =>
      composed.files.map((file) => {
        if (file.path !== current.entrypoint)
          return /\.md$/iu.test(file.path)
            ? {
                ...file,
                bytes: new TextEncoder().encode(
                  materializeSharedNativeFile(
                    new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
                    file.path,
                    activeBindings,
                    resolvedLinks,
                    native.linkedPages.get(file.path),
                    native.completions.get(file.path),
                  ),
                ),
              }
            : file
        const doc = importDocument(file, {
          name: current.record.name,
          description: current.record.description,
        })
        return canonicalMain(
          current.record.name,
          current.record.description,
          materializeSharedNativeFile(
            doc.body,
            file.path,
            activeBindings,
            resolvedLinks,
            native.linkedPages.get(file.path),
            native.completions.get(file.path),
          ) +
            (members === undefined || members.length === 0
              ? ""
              : renderSharedRouterMembers(members)),
          file,
          files.find((item) => item.path === file.path),
        )
      }),
    )
    yield* sourceChecked(() => assertSharedFileReferences(final)).pipe(
      Effect.mapError(referenceErrorContext("candidate_file_references")),
    )
    const projected = yield* Effect.forEach(final, (file) =>
      Effect.gen(function* () {
        return {
          path: file.path,
          bytes: file.bytes.length,
          sha256: yield* sha256(file.bytes),
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        }
      }),
    )
    return {
      current_snapshot: current.snapshot_id,
      projected_files: projected,
      custom_files_preserved: custom.sort(),
    }
  })
}

export function prepareSourceRefresh(
  library: SharedLibrary,
  source: string,
  target: string,
  acquire: typeof discoverSourceDefinition = discoverSourceDefinition,
  storage: SourceRefreshStorage = "auto",
) {
  return Effect.gen(function* () {
    const definition = yield* readSourceDefinition(library, source)
    if (!definition.enabled || definition.options.shared_target_set !== undefined)
      return yield* Effect.fail(
        fail("SOURCE_COMPOSITION_REVIEW_REQUIRED", "Choose an enabled single-origin Source."),
      )
    const acquired = yield* acquire(definition, { metrics: (yield* Notion).metrics })
    const memberReview = yield* reviewSourceMembers(library, definition.page_id, acquired)
    return yield* prepareSourceRefreshFromSnapshot(library, {
      definition,
      acquired,
      memberReview,
      target,
      storage,
    })
  }).pipe(withReadOnlyNotion)
}

/** Retained v1-v3 remains an explicit recovery policy with independent compatibility coverage. */
export function prepareRetainedSourceRefresh(
  library: SharedLibrary,
  source: string,
  target: string,
  acquire: typeof discoverSourceDefinition = discoverSourceDefinition,
) {
  return Effect.gen(function* () {
    const definition = yield* readSourceDefinition(library, source)
    if (!definition.enabled || definition.options.shared_target_set !== undefined)
      return yield* Effect.fail(
        fail("SOURCE_COMPOSITION_REVIEW_REQUIRED", "Choose an enabled single-origin Source."),
      )
    const acquired = yield* acquire(definition, { metrics: (yield* Notion).metrics })
    const memberReview = yield* reviewSourceMembers(library, definition.page_id, acquired)
    return yield* prepareRetainedSourceRefreshFromSnapshot(library, {
      definition,
      acquired,
      memberReview,
      target,
    })
  }).pipe(withReadOnlyNotion)
}

/** Reuse one immutable provider observation across a completely enumerated Source. */
export function prepareSourceRefreshFromSnapshot(
  library: SharedLibrary,
  input: {
    readonly definition: Effect.Success<ReturnType<typeof readSourceDefinition>>
    readonly acquired: SourceSnapshot
    readonly memberReview: typeof MemberReviewSchema.Type
    readonly target: string
    readonly storage?: SourceRefreshStorage
  },
) {
  return Effect.gen(function* () {
    const { definition, acquired, memberReview, target } = input
    if (!acquired.revision || (acquired.unavailable?.length ?? 0) !== 0)
      return yield* Effect.fail(
        fail("SOURCE_REFRESH_INCOMPLETE", "Source has unresolved deterministic resources."),
      )
    if (input.storage === "retained")
      return yield* prepareRetainedSourceRefreshFromSnapshot(library, input)
    const selected = yield* binding(library, definition.page_id, target)
    const prepared = yield* prepareSourceMember(
      definition,
      acquired,
      selected.member,
      input.storage,
    )
    if (prepared.kind === "retained") {
      return yield* prepareRetainedSourceRefreshFromSnapshot(library, input)
    }
    const { binding: fixed, files, manifest: verifiedFiles } = prepared
    const preview = yield* projectCandidate(library, selected, files)
    const selection = yield* prepareSharedMetadataWrite({
      library,
      skillPageId: selected.id,
      changes: [{ field: "Source", value: fixed.source_id }],
      expected: { values: [{ field: "Source", value: selected.index.source_reference }] },
    })
    const contents = {
      version: 4 as const,
      kind: "source_refresh" as const,
      library_id: library.library_id,
      sources_data_source_id: sourceTable(library).data_source_id,
      source_page_id: definition.page_id,
      source_id: definition.source_id,
      source_fingerprint: definition.fingerprint,
      target_page_id: selected.id,
      member: selected.member,
      previous_pin: selected.index.source_reference,
      provider_revision: acquired.revision,
      ...(acquired.provenance.committed_at === undefined
        ? {}
        : { provider_committed_at: acquired.provenance.committed_at }),
      created_at: yield* Clock.currentTimeMillis,
      source_pin: fixed.source_id,
      fixed_source: fixed,
      source_files: verifiedFiles,
      ...preview,
      selection,
      member_review: memberReview,
    }
    const plan = {
      ...contents,
      plan_id: `source-refresh-${yield* sha256(canonicalSharedJson(contents))}`,
    }
    yield* sourceChecked(() => {
      validateSharedRecordEnvelope(`register-${fixed.source_id}`, fixed, "source")
      validateSharedRecordEnvelope(plan.plan_id, sourceRefreshProvenance(plan))
    })
    return plan
  }).pipe(withReadOnlyNotion)
}

function prepareRetainedSourceRefreshFromSnapshot(
  library: SharedLibrary,
  input: {
    readonly definition: Effect.Success<ReturnType<typeof readSourceDefinition>>
    readonly acquired: SourceSnapshot
    readonly memberReview: typeof MemberReviewSchema.Type
    readonly target: string
  },
) {
  return Effect.gen(function* () {
    const { definition, acquired, memberReview, target } = input
    if (definition.options.shared_target_set !== undefined)
      return yield* Effect.fail(
        fail(
          "SOURCE_COMPOSITION_REVIEW_REQUIRED",
          "This definition retains a multi-contributor target set. A single-origin refresh must not replace a merged base; prepare an explicit fixed composition instead.",
          { source_id: definition.source_id, target_set: definition.options.shared_target_set },
        ),
      )
    const selected = yield* binding(library, definition.page_id, target)
    const matches = acquired.members.filter((item) => item.member_key === selected.member)
    if (matches.length !== 1)
      return yield* Effect.fail(
        fail("SOURCE_MEMBER_UNAVAILABLE", "Source did not return the exact bound member.", {
          member: selected.member,
        }),
      )
    const files = matches[0]!.portable.files
      .map((file) => {
        const mode =
          matches[0]!.git_manifest?.files.find((entry) => entry.path === file.path)?.mode ??
          file.mode
        return {
          path: file.path,
          bytes: new Uint8Array(file.bytes),
          ...(mode === undefined ? {} : { mode }),
        }
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    if (matches[0]!.portable.main !== "SKILL.md")
      return yield* Effect.fail(
        fail("SOURCE_ENTRYPOINT_CHANGED", "A changed entrypoint needs explicit content migration."),
      )
    const preview = yield* projectCandidate(library, selected, files)
    const archive = zipSync(
      Object.fromEntries(
        files.map((file) => [
          file.path,
          [
            file.bytes,
            {
              mtime: new Date("1980-01-01T00:00:00Z"),
              ...(file.mode === undefined
                ? {}
                : { os: 3, attrs: ((file.mode === "100755" ? 0o100755 : 0o100644) << 16) >>> 0 }),
            },
          ],
        ]),
      ),
      { level: 6 },
    )
    const chunks = []
    for (let at = 0; at < archive.length; at += 32768) {
      const bytes = archive.slice(at, at + 32768),
        hash = yield* sha256(bytes)
      chunks.push({ object_id: `chunk-${hash}`, sha256: hash, bytes: bytes.length })
    }
    const bundle = yield* validateRetainedSource(
      library,
      {
        version: 1,
        kind: "retained_bundle",
        library_id: library.library_id,
        skill_page_id: selected.id,
        entrypoint: "SKILL.md",
        files: yield* Effect.forEach(files, (file) =>
          Effect.gen(function* () {
            return {
              path: file.path,
              sha256: yield* sha256(file.bytes),
              bytes: file.bytes.length,
              ...(file.mode === undefined ? {} : { mode: file.mode }),
            }
          }),
        ),
        archive: { format: "zip", sha256: yield* sha256(archive), bytes: archive.length, chunks },
      },
      selected.id,
    )
    const bundleId = `bundle-${yield* sha256(canonicalSharedJson(bundle))}`
    // Freeze the exact existing selection protocol in the approval itself.
    // The candidate need not already be registered to prepare native metadata;
    // execution separately verifies its retained complete bytes before PATCH.
    const selection = yield* prepareSharedMetadataWrite({
      library,
      skillPageId: selected.id,
      changes: [{ field: "Source", value: bundleId }],
      expected: { values: [{ field: "Source", value: selected.index.source_reference }] },
    })
    const contents = {
      version: 3 as const,
      kind: "source_refresh" as const,
      library_id: library.library_id,
      sources_data_source_id: sourceTable(library).data_source_id,
      source_page_id: definition.page_id,
      source_id: definition.source_id,
      source_fingerprint: definition.fingerprint,
      target_page_id: selected.id,
      member: selected.member,
      previous_pin: selected.index.source_reference,
      provider_revision: acquired.revision,
      ...(acquired.provenance.committed_at === undefined
        ? {}
        : { provider_committed_at: acquired.provenance.committed_at }),
      created_at: yield* Clock.currentTimeMillis,
      bundle_id: bundleId,
      bundle,
      archive_base64: Buffer.from(archive).toString("base64"),
      ...preview,
      selection,
      member_review: memberReview,
    }
    const plan = {
      ...contents,
      plan_id: `source-refresh-${yield* sha256(canonicalSharedJson(contents))}`,
    } satisfies RetainedSourceRefreshPlan
    yield* sourceChecked(() => {
      validateSharedRecordEnvelope(`retain-${plan.bundle_id}`, plan.bundle, "snapshot")
      validateSharedRecordEnvelope(plan.plan_id, sourceRefreshProvenance(plan))
    })
    return plan
  }).pipe(withReadOnlyNotion)
}
export function validateSourceRefresh(library: SharedLibrary, input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* sourceChecked(() =>
      Schema.decodeUnknownSync(SourceRefreshPlanSchema)(structuredClone(input), {
        onExcessProperty: "error",
      }),
    )
    const { plan_id, ...rest } = plan
    if (
      (plan.version === 1 ? plan.selection !== undefined : plan.selection === undefined) ||
      (plan.version >= 3 ? plan.member_review === undefined : plan.member_review !== undefined) ||
      !Number.isSafeInteger(plan.created_at) ||
      plan.created_at < 0 ||
      !plan.provider_revision ||
      (plan.provider_committed_at !== undefined &&
        !Number.isFinite(Date.parse(plan.provider_committed_at))) ||
      plan.library_id !== library.library_id ||
      plan.sources_data_source_id !== sourceTable(library).data_source_id ||
      pageId(plan.target_page_id) !== plan.target_page_id ||
      pageId(plan.source_page_id) !== plan.source_page_id ||
      plan_id !== `source-refresh-${yield* sha256(canonicalSharedJson(rest))}`
    )
      return yield* Effect.fail(
        fail("SOURCE_REFRESH_INVALID", "Refresh plan identity or library scope differs."),
      )
    if (plan.selection)
      yield* checkedSelection(library, plan, {
        version: 1,
        plan_id: plan.plan_id,
        selection: plan.selection,
      })
    if (plan.version === 4) {
      const fixed = yield* makeSourceBinding(plan.fixed_source)
      if (
        fixed.source_id !== plan.source_pin ||
        fixed.commit !== plan.provider_revision ||
        canonicalSharedJson(fixed) !== canonicalSharedJson(plan.fixed_source) ||
        plan.source_files.length !== fixed.files.length ||
        new Set(plan.source_files.map((file) => file.path)).size !== plan.source_files.length ||
        plan.source_files.some(
          (file) =>
            !/^[a-f0-9]{64}$/u.test(file.sha256) ||
            !fixed.files.some(
              (entry) =>
                entry.path === file.path && entry.bytes === file.bytes && entry.mode === file.mode,
            ),
        )
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_REFRESH_INVALID",
            "Fixed Git candidate identity or complete file manifest differs.",
          ),
        )
      yield* sourceChecked(() => {
        validateSharedRecordEnvelope(`register-${fixed.source_id}`, fixed, "source")
        validateSharedRecordEnvelope(plan.plan_id, sourceRefreshProvenance(plan))
      })
      return { kind: "git" as const, plan }
    }
    const bundle = yield* validateRetainedSource(library, plan.bundle, plan.target_page_id)
    yield* sourceChecked(() => {
      validateSharedRecordEnvelope(`retain-${plan.bundle_id}`, bundle, "snapshot")
      validateSharedRecordEnvelope(plan.plan_id, sourceRefreshProvenance(plan))
    })
    const bytes = Buffer.from(plan.archive_base64, "base64")
    if (
      bytes.toString("base64") !== plan.archive_base64 ||
      bytes.length !== bundle.archive.bytes ||
      (yield* sha256(bytes)) !== bundle.archive.sha256 ||
      plan.bundle_id !== `bundle-${yield* sha256(canonicalSharedJson(bundle))}`
    )
      return yield* Effect.fail(
        fail("SOURCE_REFRESH_INVALID", "Frozen resource bundle failed checksum verification."),
      )
    for (const [index, chunk] of bundle.archive.chunks.entries()) {
      const part = bytes.subarray(index * 32768, index * 32768 + chunk.bytes)
      if (part.length !== chunk.bytes || (yield* sha256(part)) !== chunk.sha256)
        return yield* Effect.fail(
          fail(
            "SOURCE_REFRESH_INVALID",
            "Frozen chunk identity differs from the verified archive.",
          ),
        )
    }
    const files = yield* sourceChecked(() => readImportZip(bytes))
    if (files.length !== bundle.files.length)
      return yield* Effect.fail(
        fail("SOURCE_REFRESH_INVALID", "Frozen resource tree is incomplete."),
      )
    for (const file of files) {
      const expected = bundle.files.find((item) => item.path === file.path)
      if (
        !expected ||
        file.bytes.length !== expected.bytes ||
        (expected.mode !== undefined && file.mode !== expected.mode) ||
        (yield* sha256(file.bytes)) !== expected.sha256
      )
        return yield* Effect.fail(
          fail("SOURCE_REFRESH_INVALID", "Frozen file differs from manifest."),
        )
    }
    return { kind: "retained" as const, plan, archive: bytes, files }
  })
}

function materializeSourceRefresh(
  candidate: Effect.Success<ReturnType<typeof validateSourceRefresh>>,
) {
  return Effect.gen(function* () {
    if (candidate.kind === "retained") return candidate.files
    const files = yield* materializeFixedGithubSource(candidate.plan.fixed_source, {
      metrics: (yield* Notion).metrics,
    })
    for (const file of files) {
      const expected = candidate.plan.source_files.find((entry) => entry.path === file.path)
      if (
        expected === undefined ||
        file.sha256 !== expected.sha256 ||
        file.bytes.length !== expected.bytes
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_REFRESH_INVALID",
            "Retrieved fixed Git bytes differ from the frozen candidate.",
          ),
        )
    }
    return files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      ...(file.mode === undefined ? {} : { mode: file.mode }),
    }))
  })
}
export function retainSourceFact(
  library: SharedLibrary,
  input: Omit<AppendSharedRecordInput, "mode" | "beforeCreate">,
) {
  return Effect.gen(function* () {
    const store = yield* Store,
      scope = yield* sha256(
        canonicalSharedJson([
          yield* (yield* Notion).credentialIdentity,
          library.library_id,
          input.skillPageId,
        ]),
      )
    const key = `operations/shared-sources/${scope}/source-op-${yield* sha256(canonicalSharedJson(input))}.json`
    const previous = yield* store.readJson(key, Schema.Unknown)
    if (previous !== undefined && canonicalSharedJson(previous) !== canonicalSharedJson(input))
      return yield* Effect.fail(
        fail("SOURCE_OPERATION_CONFLICT", "Original source fact dispatch differs."),
      )
    return yield* appendSharedRecord(library, {
      ...input,
      mode: previous === undefined ? "create" : "reconcile",
      beforeCreate: store.writeJson(key, input),
    })
  })
}
const SelectionReceipt = Schema.Struct({
  version: Schema.Literal(1),
  plan_id: Schema.String,
  selection: SharedMetadataWritePlanSchema,
})
function selectionReceiptKey(library: SharedLibrary, plan: SourceRefreshPlan) {
  return Effect.gen(function* () {
    const scope = yield* sha256(
      canonicalSharedJson([
        yield* (yield* Notion).credentialIdentity,
        library.library_id,
        library.skills.data_source_id,
        library.records.data_source_id,
        plan.target_page_id,
      ]),
    )
    return `operations/shared-sources/${scope}/source-selection-${plan.plan_id.slice("source-refresh-".length)}.json`
  })
}
function checkedSelection(library: SharedLibrary, plan: SourceRefreshPlan, value: unknown) {
  return Effect.gen(function* () {
    const receipt = yield* sourceChecked(() =>
      Schema.decodeUnknownSync(SelectionReceipt)(value, { onExcessProperty: "error" }),
    )
    const selection = yield* validateSharedSourceSelectionPlan(receipt.selection)
    const change = selection.changes[0]!
    if (
      receipt.plan_id !== plan.plan_id ||
      selection.library_id !== library.library_id ||
      selection.skill_page_id !== plan.target_page_id ||
      change.property_id !== library.skills.property_ids.Source ||
      change.before !== plan.previous_pin ||
      change.after !== sourceRefreshPin(plan)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_SELECTION_RECEIPT_CONFLICT",
          "Original selection receipt differs from this complete frozen refresh.",
        ),
      )
    return selection
  })
}
function originalSelection(library: SharedLibrary, plan: SourceRefreshPlan) {
  return Effect.gen(function* () {
    if (plan.version >= 2)
      return yield* checkedSelection(library, plan, {
        version: 1,
        plan_id: plan.plan_id,
        selection: plan.selection,
      })
    const store = yield* Store,
      key = yield* selectionReceiptKey(library, plan)
    const local = yield* store.readJson(key, Schema.Unknown)
    if (local !== undefined) return yield* checkedSelection(library, plan, local)
    const rows = yield* querySharedRecords(library, {
      skillPageId: plan.target_page_id,
      kind: "source",
      entityId: `selection-${plan.plan_id}`,
    })
    if (!rows.length) return undefined
    if (
      rows.length !== 1 ||
      rows[0]!.record_id !== `selection-${plan.plan_id}` ||
      rows[0]!.operation_id !== plan.plan_id
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_SELECTION_RECEIPT_CONFLICT",
          "Shared refresh selection has an ambiguous identity.",
        ),
      )
    return yield* checkedSelection(library, plan, rows[0]!.payload)
  })
}
function saveSelection(
  library: SharedLibrary,
  plan: SourceRefreshPlan,
  selection: SharedMetadataWritePlan,
) {
  return Effect.gen(function* () {
    const receipt = { version: 1, plan_id: plan.plan_id, selection }
    yield* (yield* Store).writeJson(yield* selectionReceiptKey(library, plan), receipt)
    // V1 keeps its original pre-selection mapping gate and outcome untouched.
    // V2 and V3 are independently verifiable from the digest-bound approval and the
    // normal shared metadata journal, so there is no second dispatch index.
    if (plan.version === 1)
      yield* retainSourceFact(library, {
        recordId: `selection-${plan.plan_id}`,
        operationId: plan.plan_id,
        skillPageId: plan.target_page_id,
        entityId: `selection-${plan.plan_id}`,
        kind: "source",
        payload: receipt,
      })
  })
}

/** This observes the EXACT original selection outcome. It cannot retry a PATCH,
 * clear an unknown outcome, or silently reconstruct a missing original plan. */
export function reconcileSourceRefresh(library: SharedLibrary, input: unknown) {
  return Effect.gen(function* () {
    const { plan } = yield* validateSourceRefresh(library, input)
    const selection = yield* originalSelection(library, plan)
    if (!selection)
      return yield* Effect.fail(
        fail(
          "SOURCE_SELECTION_NOT_DISPATCHED",
          "No exact original selection receipt is available; retain the refresh plan and inspect its completed resource steps.",
        ),
      )
    const outcome = yield* reconcileSharedSourceSelection(library, selection)
    return {
      plan_id: plan.plan_id,
      selection: outcome,
      remote_writes: 0,
      current_snapshot_verified: false,
      requires_fresh_read: true,
    }
  })
}

function sourceRefreshProvenance(plan: SourceRefreshPlan) {
  return {
    version: 1,
    kind: "source_refresh_candidate",
    source_page_id: plan.source_page_id,
    source_id: plan.source_id,
    source_fingerprint: plan.source_fingerprint,
    provider_revision: plan.provider_revision,
    ...(plan.provider_committed_at === undefined
      ? {}
      : { provider_committed_at: plan.provider_committed_at }),
    member: plan.member,
    ...(plan.version === 4
      ? { source_pin: plan.source_pin, storage: "fixed_git" }
      : { bundle_id: plan.bundle_id }),
    previous_pin: plan.previous_pin,
    custom_files_preserved: plan.custom_files_preserved,
    plan_id: plan.plan_id,
    ...(plan.selection ? { selection_operation_id: plan.selection.operation_id } : {}),
    ...(plan.member_review === undefined ? {} : { member_review: plan.member_review }),
  }
}

export function applySourceRefresh(
  library: SharedLibrary,
  input: unknown,
  dryRun = false,
  reportSourceStatus = true,
) {
  return Effect.gen(function* () {
    const candidate = yield* validateSourceRefresh(library, input)
    const { plan } = candidate
    const sourcePin = sourceRefreshPin(plan)
    const definition = yield* readSourceDefinition(library, plan.source_page_id)
    if (definition.options.shared_target_set !== undefined)
      return yield* Effect.fail(
        fail(
          "SOURCE_COMPOSITION_REVIEW_REQUIRED",
          "Multi-contributor origins require an explicit fixed composition before selection.",
        ),
      )
    if (
      !definition.enabled ||
      definition.source_id !== plan.source_id ||
      definition.fingerprint !== plan.source_fingerprint
    )
      return yield* Effect.fail(
        fail("SOURCE_DEFINITION_CHANGED", "Source definition changed after preparation."),
      )
    const selected = yield* binding(library, definition.page_id, plan.target_page_id, plan.member)
    const alreadySelected = selected.index.source_reference === sourcePin
    if (!alreadySelected && selected.index.source_reference !== plan.previous_pin)
      return yield* Effect.fail(
        fail("SOURCE_SELECTION_CHANGED", "Current content pin changed after preparation."),
      )
    const files = yield* materializeSourceRefresh(candidate)
    if (alreadySelected && plan.previous_pin === sourcePin) {
      const unchanged = yield* projectCandidate(library, selected, files)
      if (
        unchanged.current_snapshot !== plan.current_snapshot ||
        canonicalSharedJson(unchanged.projected_files) !== canonicalSharedJson(plan.projected_files)
      )
        return yield* Effect.fail(
          fail("SOURCE_TARGET_CHANGED", "Current content changed since the no-change proposal."),
        )
      return {
        status: "unchanged",
        verified: true,
        plan_id: plan.plan_id,
        snapshot_id: unchanged.current_snapshot,
        source_pin: sourcePin,
        provider_revision: plan.provider_revision,
        remote_writes: 0,
        body_writes: 0,
      }
    }
    let selection = yield* originalSelection(library, plan)
    if (alreadySelected && !selection)
      return {
        status: "already_selected",
        plan_id: plan.plan_id,
        source_pin: sourcePin,
        current_pin_verified: true,
        verified: false,
        body_writes: 0,
        original_outcome: "unavailable; no original operation was manufactured",
      }
    if (!alreadySelected) {
      const preview = yield* projectCandidate(library, selected, files)
      if (
        preview.current_snapshot !== plan.current_snapshot ||
        canonicalSharedJson(preview.projected_files) !==
          canonicalSharedJson(plan.projected_files) ||
        canonicalSharedJson(preview.custom_files_preserved) !==
          canonicalSharedJson(plan.custom_files_preserved)
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_TARGET_CHANGED",
            "Current content or file ownership changed since preparation.",
          ),
        )
    }
    if (dryRun)
      return {
        status: alreadySelected ? "already_selected" : "planned",
        dry_run: true,
        plan_id: plan.plan_id,
        source_pin: sourcePin,
        projected_files: plan.projected_files,
        custom_files_preserved: plan.custom_files_preserved,
        notion_writes: 0,
      }

    // These exact facts are independently replay-safe; a missing outcome stays
    // in reconciliation and cannot cause a second POST of that dispatch.
    const sourceRecord = yield* Effect.gen(function* () {
      if (candidate.kind === "git")
        return (yield* registerSourceBinding(library, {
          skillPageId: selected.id,
          mode: "create",
          fixedSource: candidate.plan.fixed_source,
        })).record
      for (const [index, chunk] of candidate.plan.bundle.archive.chunks.entries()) {
        const bytes = candidate.archive.slice(index * 32768, index * 32768 + chunk.bytes)
        yield* retainSourceFact(library, {
          recordId: chunk.object_id,
          operationId: `retain-${chunk.object_id}`,
          skillPageId: selected.id,
          entityId: chunk.object_id,
          kind: "object",
          payload: {
            version: 1,
            kind: "exact_bytes",
            encoding: "base64",
            sha256: chunk.sha256,
            bytes: chunk.bytes,
            data: bytes.toString("base64"),
          },
          payloadContainsBody: true,
        })
      }
      return yield* retainSourceFact(library, {
        recordId: candidate.plan.bundle_id,
        operationId: `retain-${candidate.plan.bundle_id}`,
        skillPageId: selected.id,
        entityId: candidate.plan.bundle_id,
        kind: "source",
        payload: candidate.plan.bundle,
      })
    })
    const provenanceRecord = yield* retainSourceFact(library, {
      recordId: plan.plan_id,
      operationId: plan.plan_id,
      skillPageId: selected.id,
      entityId: plan.plan_id,
      kind: "source",
      payload: sourceRefreshProvenance(plan),
    })
    const freshDefinition = yield* readSourceDefinition(library, plan.source_page_id)
    if (freshDefinition.fingerprint !== plan.source_fingerprint || !freshDefinition.enabled)
      return yield* Effect.fail(
        fail(
          "SOURCE_DEFINITION_CHANGED",
          "Source changed before selecting the retained candidate; current content was not advanced.",
        ),
      )
    const freshTarget = yield* binding(library, plan.source_page_id, selected.id, plan.member)
    if (!alreadySelected) {
      const checked = yield* projectCandidate(library, freshTarget, files)
      if (
        checked.current_snapshot !== plan.current_snapshot ||
        canonicalSharedJson(checked.projected_files) !== canonicalSharedJson(plan.projected_files)
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_TARGET_CHANGED",
            "Target changed while retaining the candidate; current selection remains protected.",
          ),
        )
    }
    if (!selection)
      selection = (yield* prepareSharedSourceSelection({
        library,
        skillPageId: selected.id,
        sourceId: sourcePin,
        expectedSourceId: plan.previous_pin || null,
      })).plan
    yield* saveSelection(library, plan, selection)
    const applied = yield* applySharedSourceSelection({
      library,
      plan: selection,
      mode: alreadySelected ? "reconcile" : "create",
    })
    if (applied.status !== "applied" && applied.status !== "unchanged")
      return yield* Effect.fail(
        fail(
          "SOURCE_SELECTION_UNRESOLVED",
          "The original selection requires review; current visibility alone does not complete this refresh.",
          { plan_id: plan.plan_id, selection: applied },
        ),
      )

    const fixed = yield* resolveSelectedSharedSource(library, selected.id, sourcePin)
    const verified = yield* openSharedSnapshot({
      library,
      target: selected.id,
      scope: yield* authScope,
      startedAt: yield* Clock.currentTimeMillis,
      readOnly: true,
      forceFull: true,
      fixedSource: {
        source_id: fixed.source_id,
        revision: fixed.revision,
        files: fixed.files,
        local_paths: fixed.local_paths,
      },
    })
    if (canonicalSharedJson(verified.files) !== canonicalSharedJson(plan.projected_files))
      return yield* Effect.fail(
        fail(
          "SOURCE_REFRESH_CHANGED_AFTER_SELECTION",
          "Selected candidate's actual complete content differs; preserve the acknowledged selection and inspect current state.",
        ),
      )
    const api = yield* Notion,
      origin = library.records.property_ids.Origin!
    for (const linked of [sourceRecord, provenanceRecord])
      yield* guardedSourceMutation(
        library,
        {
          identity: `${plan.plan_id}:origin:${linked.page_id}`,
          path: `v1/pages/${linked.page_id}`,
          method: "PATCH",
          body: { properties: { [origin]: { relation: [{ id: plan.source_page_id }] } } },
          repeat: "never",
        },
        Effect.gen(function* () {
          const row = yield* api.request(`v1/pages/${linked.page_id}`),
            relation = sourceField(row, origin)
          return !relation.has_more &&
            Array.isArray(relation.relation) &&
            relation.relation.length === 1 &&
            property(relation.relation[0]).id === plan.source_page_id
            ? { linked: true }
            : undefined
        }),
      )
    const field = sourceTable(library).property_ids
    const checkedAt = Math.floor(plan.created_at / 60000) * 60000
    const summary = `Member ${plan.member}; selected ${sourcePin}; ${plan.projected_files.length} verified effective files; ${plan.custom_files_preserved.length} custom files preserved.`
    const observed = yield* api.request(`v1/pages/${plan.source_page_id}`)
    const moreRecent =
      Date.parse(String(property(sourceField(observed, field["Last Checked"]!).date).start)) >
      checkedAt
    if (!moreRecent && reportSourceStatus)
      yield* guardedSourceMutation(
        library,
        {
          identity: `${plan.plan_id}:status`,
          path: `v1/pages/${plan.source_page_id}`,
          method: "PATCH",
          repeat: "never",
          body: {
            properties: {
              [field.Status!]: { select: { name: "applied" } },
              [field["Last Revision"]!]: { rich_text: sourceRich(plan.provider_revision) },
              [field["Last Checked"]!]: { date: { start: new Date(checkedAt).toISOString() } },
              [field["Last Result"]!]: { rich_text: sourceRich(summary) },
            },
          },
        },
        Effect.gen(function* () {
          const row = yield* api.request(`v1/pages/${plan.source_page_id}`)
          return property(sourceField(row, field.Status!).select).name === "applied" &&
            text(sourceField(row, field["Last Revision"]!).rich_text) === plan.provider_revision &&
            Date.parse(String(property(sourceField(row, field["Last Checked"]!).date).start)) ===
              checkedAt &&
            text(sourceField(row, field["Last Result"]!).rich_text) === summary
            ? { status: "applied", revision: plan.provider_revision }
            : undefined
        }),
      )
    return {
      status: alreadySelected ? "already_selected" : "applied",
      verified: true,
      snapshot_id: verified.snapshot_id,
      plan_id: plan.plan_id,
      source_pin: sourcePin,
      provider_revision: plan.provider_revision,
      selection: applied,
      custom_files_preserved: plan.custom_files_preserved,
      body_writes: 0,
      projection_writeback: false,
      scope: "one exact bound Skill member",
    }
  })
}
