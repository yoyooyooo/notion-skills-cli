import { storedSharedOperationPlan } from "./shared-plan-storage.ts"
import { Clock, Effect, Schema } from "effect"
import {
  completedSharedFileAddAcceptance,
  loadCompletedSharedFileAddAcceptances,
} from "./shared-file-add-acceptance.ts"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache, validateSnapshot } from "./cache.ts"
import { decode, fail, property, SkillsError, SnapshotSchema, type Snapshot } from "./model.ts"
import { Notion, withNotionRequestAttribution } from "./notion.ts"
import { pageId } from "./ref.ts"
import { composeSharedFiles, type CompositionFile } from "./shared-composition.ts"
import { sharedSkillId } from "./shared-content.ts"
import { loadPendingSharedBodyWrites } from "./shared-body-write.ts"
import type { FrozenWriteBody } from "./shared-body-write-model.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import { restoreSharedNativeFileLinks } from "./shared-native-file-content.ts"
import { isSharedAuthoringTarget } from "./shared-authoring-context.ts"
import {
  decideObservedBody,
  FileEventSchema,
  normalizeObservedBody,
  isResourceContent,
  isResourceFollowing,
  resolveFileState,
  nativeMetadataForOwnership,
  nativeFileMetadata,
  type FileEvent,
  type RetainedContent,
  type ResolvedFileState,
} from "./shared-file-state.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  nativeSupportingMarkdown,
  splitNativeSupportingMarkdown,
} from "./shared-native-file-metadata.ts"
import { loadPendingSharedObservationPlans } from "./shared-observation-operation.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  type SharedRecord,
} from "./shared-records.ts"
import { querySharedSkillIndex, type SharedSkillIndex } from "./shared-skill-index.ts"
import { sharedSnapshotVersion } from "./shared-snapshot-identity.ts"
import { loadSharedApplyReferenceTree } from "./shared-skill-apply-target.ts"
import {
  pendingFileOperations,
  pendingFileOperationKey,
  retainPendingFileOperation,
  sharedPendingObservationPrefix,
  type SharedPendingFileScope,
} from "./shared-pending-file-operations.ts"
import { sha256, Store } from "./store.ts"
import type { SharedResourceAuthoringPlan } from "./shared-resource-authoring-model.ts"
import {
  sharedSkillApplyChildren,
  validateSharedSkillApplyPlan,
  type SharedSkillApplyPlan,
} from "./shared-skill-apply-model.ts"
import {
  loadPendingSharedResourceAuthoring,
  reconcileSharedResourceAuthoring,
} from "./shared-resource-authoring-recovery.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
  type SharedNotionMarkdownProjection,
} from "./shared-notion-projection.ts"
import {
  canonicalManagementPath,
  fileManagementOutcomeId,
  fileManagementOutcomesEntity,
  fileManagementProtection,
  makeSharedFileManagementPlan,
  managementChecked,
  plannedFileManagementEventId,
  retainedFileManagementPayload,
  validateSharedFileManagementPlan,
  decodeSharedFileManagementOutcome as decodeOutcome,
  type SharedFileManagementOutcome as Outcome,
  type SharedFileManagementPlan,
} from "./shared-file-management-model.ts"
export {
  SharedFileManagementPlanSchema,
  validateSharedFileManagementPlan,
  fileManagementProtection,
  type SharedFileManagementPlan,
} from "./shared-file-management-model.ts"

const FreshEvidenceSchema = Schema.Struct({
  version: Schema.Literal(1),
  read_only: Schema.Literal(true),
  scope: Schema.String,
  snapshot_id: Schema.String,
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  source_id: Schema.String,
  source_revision: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      file_id: Schema.String,
      page_id: Schema.String,
      path: Schema.String,
      heads: Schema.Array(Schema.String),
      body_sha256: Schema.String,
      last_edited_time: Schema.String,
      metadata_validated_at: Schema.Number,
      body_verified_at: Schema.Number,
    }),
  ),
})
const MarkdownSchema = Schema.Struct({
  id: Schema.String,
  markdown: Schema.String,
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(Schema.String),
  warnings: Schema.optional(Schema.Array(Schema.Unknown)),
})
type Context = {
  readonly index: SharedSkillIndex
  readonly events: readonly FileEvent[]
  readonly headers: readonly SharedOperationHeader[]
}
export type PrepareSharedFileManagementInput = {
  readonly library: SharedLibrary
  /** Must be the actual result of this invocation's complete readOnly builder. */
  readonly snapshot: Snapshot
  readonly referenceCheck?: SharedFileManagementPlan["reference_check"]
} & (
  | {
      readonly action: "add"
      readonly path: string
      readonly markdown: string
      readonly mode?: "100644" | "100755"
    }
  | { readonly action: "delete"; readonly fileId: string }
  | { readonly action: "move"; readonly fileId: string; readonly destinationPath: string }
  | { readonly action: "undelete"; readonly fileId: string }
)

function scopeFor(scope: string, library: SharedLibrary, skillId: string, skillPageId: string) {
  return Effect.gen(function* () {
    return {
      prefix: yield* sharedPendingObservationPrefix(scope, library.library_id, skillId),
      scope,
      library_id: library.library_id,
      skill_id: skillId,
      skill_page_id: skillPageId,
    } satisfies SharedPendingFileScope
  })
}
function recovery(error: SkillsError, plan: SharedFileManagementPlan, stage: string) {
  const page = property(error.details).page_id
  return fail(error.code, error.message, {
    ...property(error.details),
    file_management_operation_id: plan.operation_id,
    stage,
    protection: fileManagementProtection,
    recovery: { mode: "reconcile", plan },
    next: {
      argv:
        typeof page === "string" && pageId(page) === page
          ? ["ntn-skills", "ctl", "api", `v1/pages/${page}/markdown?markdown_version=v2`]
          : [
              "ntn-skills",
              "ctl",
              "operation",
              "show",
              plan.operation_id,
              "--target",
              plan.skill_page_id,
            ],
      read_only: true,
      reason:
        "Inspect the exact retained page or original operation. Do not repeat create or remove its pending state; a known add mismatch can be independently reviewed through ctl file accept-add.",
    },
    ...(stage === "plan" && error.code === "WRITE_OUTCOME_UNKNOWN"
      ? { first_plan_visibility_boundary: true }
      : {}),
  })
}
function bindings(index: SharedSkillIndex) {
  return [index.main, ...index.files]
}
function eventDigest(events: readonly FileEvent[]) {
  return sha256(
    canonicalSharedJson(
      [...events].sort((left, right) =>
        left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0,
      ),
    ),
  )
}
function metadataDigest(index: SharedSkillIndex) {
  return sha256(
    canonicalSharedJson({
      ...index,
      files: [...index.files].sort((left, right) =>
        left.file_id < right.file_id ? -1 : left.file_id > right.file_id ? 1 : 0,
      ),
    }),
  )
}
function readEvents(library: SharedLibrary, skillPageId: string) {
  return Effect.gen(function* () {
    const facts = yield* querySharedRecords(library, { skillPageId, kind: "file_event" })
    return yield* managementChecked(() =>
      facts.map((fact) => {
        const event = decode(FileEventSchema, fact.payload)
        if (fact.record_id !== event.event_id || fact.entity_id !== event.file_id)
          throw fail("SHARED_STATE_SCOPE", "File management found a foreign file event identity.")
        return event
      }),
    )
  })
}
function currentContext(library: SharedLibrary, skillPageId: string) {
  return Effect.gen(function* () {
    const index = yield* querySharedSkillIndex(library, skillPageId)
    const events = yield* readEvents(library, skillPageId)
    const headers = yield* querySharedOperationIndex(library, skillPageId)
    if (!index.enabled && !(yield* isSharedAuthoringTarget(skillPageId)))
      return yield* Effect.fail(
        fail("CONTENT_DISABLED", "Enable the selected shared Skill before managing its files."),
      )
    return { index, events, headers } satisfies Context
  })
}
function resolved(context: Context) {
  const states = new Map<string, ResolvedFileState>()
  const byId = new Map(bindings(context.index).map((binding) => [binding.file_id, binding]))
  for (const event of context.events)
    if (!byId.has(event.file_id))
      throw fail(
        "UNBOUND_FILE_STATE",
        "A file event has no visible binding; missing membership cannot authorize a lifecycle change.",
        { file_id: event.file_id },
      )
  for (const binding of byId.values()) {
    const state = resolveFileState(
      binding.file_id,
      context.events.filter((event) => event.file_id === binding.file_id),
    )
    if (state.placement !== undefined && state.placement.path !== binding.path)
      throw fail(
        "SHARED_PATH_CONFLICT",
        "The current Path property differs from the file's shared logical placement.",
        { file_id: binding.file_id, path: binding.path, expected_path: state.placement.path },
      )
    states.set(binding.file_id, state)
  }
  return states
}
export function readManagedFileBody(page: string) {
  return readBody(page)
}
function readBody(page: string) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/pages/${page}/markdown?markdown_version=v2`)
    const value = yield* managementChecked(() => decode(MarkdownSchema, raw))
    if (
      value.id !== page ||
      value.truncated ||
      value.unknown_block_ids.length !== 0 ||
      (value.warnings?.length ?? 0) !== 0
    )
      return yield* Effect.fail(
        fail(
          "BODY_INCOMPLETE",
          "File management requires a complete exact-page Markdown response.",
        ),
      )
    const markdown = yield* managementChecked(() => normalizeObservedBody(value.markdown))
    return {
      page_id: page,
      raw_markdown: value.markdown,
      markdown,
      fingerprint: { normalization_version: 1 as const, sha256: yield* sha256(markdown) },
      bytes: new TextEncoder().encode(markdown).byteLength,
      downloaded_at: yield* Clock.currentTimeMillis,
    } satisfies FrozenWriteBody
  })
}
function snapshotTree(snapshot: Snapshot) {
  return Effect.gen(function* () {
    yield* validateSnapshot(snapshot)
    const store = yield* Store
    return yield* Effect.forEach(snapshot.files, (file) =>
      store.readBytes(`objects/${file.sha256}`).pipe(
        Effect.map((bytes) => ({
          path: file.path,
          bytes,
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        })),
      ),
    )
  })
}
function proposedTree(
  files: readonly CompositionFile[],
  input: {
    readonly action: SharedFileManagementPlan["action"]
    readonly path: string
    readonly destination_path: string | null
    readonly content: {
      readonly markdown: string
      readonly retained?: RetainedContent
    }
    readonly entrypoint: string
  },
) {
  let candidate: CompositionFile[]
  if (input.action === "add" || input.action === "undelete") {
    if (files.some((file) => file.path === input.path))
      throw fail(
        "SHARED_FILE_PATH_CONFLICT",
        "The new path already exists in the complete source/custom tree.",
        { path: input.path },
      )
    candidate = [
      ...files,
      {
        path: input.path,
        bytes: new TextEncoder().encode(
          nativeSupportingMarkdown(
            input.content.markdown,
            nativeFileMetadata(input.content.retained ?? {}),
          ),
        ),
      },
    ]
  } else {
    if (!files.some((file) => file.path === input.path))
      throw fail(
        "SHARED_FILE_NOT_BOUND",
        "The selected file is absent from the complete active snapshot.",
      )
    if (input.action === "move" && files.some((file) => file.path === input.destination_path))
      throw fail(
        "SHARED_FILE_PATH_CONFLICT",
        "The move destination already exists in the complete source/custom tree.",
        { path: input.destination_path },
      )
    candidate = files.flatMap((file) =>
      file.path !== input.path
        ? [file]
        : input.action === "delete"
          ? []
          : [{ path: input.destination_path!, bytes: file.bytes }],
    )
  }
  const composed = composeSharedFiles({
    base: candidate,
    mounts: [],
    overrides: [],
    entrypoint: input.entrypoint,
  })
  return { files: composed.files, check: assertSharedFileReferences(composed.files) }
}
function checkSnapshotIdentity(
  library: SharedLibrary,
  snapshot: Snapshot,
  context: Context,
  states: ReadonlyMap<string, ResolvedFileState>,
  sourceRevision: string,
  ownershipOverride?: readonly {
    readonly file_id: string
    readonly path: string
    readonly state: ResolvedFileState | undefined
  }[],
) {
  return Effect.gen(function* () {
    const locator = snapshot.record.locator,
      index = context.index
    if (
      locator.type !== "shared_skill" ||
      locator.library_id !== library.library_id ||
      locator.skill_id !== index.skill_id ||
      locator.page_id !== index.page_id ||
      locator.database_id !== library.skills.database_id ||
      locator.data_source_id !== library.skills.data_source_id ||
      snapshot.record.name !== index.name ||
      snapshot.record.description !== index.description ||
      snapshot.record.kind !== index.kind ||
      snapshot.record.default_context !== index.default_context ||
      snapshot.entrypoint !== index.main.path
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_STALE",
          "The complete snapshot and current library/Skill metadata disagree.",
        ),
      )
    if ((index.source_reference === "") !== (sourceRevision === ""))
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_STALE",
          "The complete observation has no exact immutable source revision.",
        ),
      )
    const version = yield* sharedSnapshotVersion({
      record: snapshot.record,
      files: snapshot.files,
      router_members: snapshot.router_members,
      members: snapshot.members,
      required: snapshot.required,
      file_bindings: snapshot.file_bindings,
      native_references: snapshot.native_references,
      shared_acquisition: snapshot.shared_acquisition,
      source:
        index.source_reference === ""
          ? null
          : { source_id: index.source_reference, revision: sourceRevision },
      ownership:
        ownershipOverride ??
        bindings(index).map((binding) => ({
          file_id: binding.file_id,
          path: binding.path,
          state: states.get(binding.file_id),
        })),
    })
    if (version !== snapshot.version_id)
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_STALE",
          "The source selection or shared file frontier changed after the complete snapshot. Obtain another read-only observation.",
        ),
      )
  })
}
function assertFreshEvidence(
  snapshot: Snapshot,
  library: SharedLibrary,
  context: Context,
  states: ReadonlyMap<string, ResolvedFileState>,
  scope: string,
  now: number,
) {
  const evidence = Schema.decodeUnknownSync(FreshEvidenceSchema)(
    property(snapshot).shared_authoring,
  )
  if (
    snapshot.scope !== scope ||
    evidence.scope !== scope ||
    evidence.snapshot_id !== snapshot.snapshot_id ||
    evidence.library_id !== library.library_id ||
    evidence.skill_id !== context.index.skill_id ||
    evidence.skill_page_id !== context.index.page_id ||
    evidence.source_id !== context.index.source_reference
  )
    throw fail(
      "SHARED_FILE_MANAGEMENT_STALE",
      "File management requires this invocation's exact read-only shared snapshot evidence.",
    )
  const active = bindings(context.index).filter(
    (binding) => states.get(binding.file_id)?.ownership.kind !== "tombstone",
  )
  if (
    evidence.files.length !== active.length ||
    new Set(evidence.files.map((file) => file.file_id)).size !== active.length
  )
    throw fail(
      "SHARED_FILE_MANAGEMENT_STALE",
      "The fresh observation does not cover every current active file.",
    )
  for (const binding of active) {
    const file = evidence.files.find((item) => item.file_id === binding.file_id),
      state = states.get(binding.file_id)
    if (
      file === undefined ||
      state === undefined ||
      file.page_id !== binding.page_id ||
      file.path !== binding.path ||
      file.last_edited_time !== binding.last_edited_time ||
      canonicalSharedJson(file.heads) !== canonicalSharedJson(state.heads) ||
      !/^[a-f0-9]{64}$/u.test(file.body_sha256) ||
      !Number.isSafeInteger(file.metadata_validated_at) ||
      file.metadata_validated_at < 0 ||
      file.metadata_validated_at > now ||
      !Number.isSafeInteger(file.body_verified_at) ||
      file.body_verified_at < 0 ||
      file.body_verified_at > now
    )
      throw fail(
        "SHARED_FILE_MANAGEMENT_STALE",
        "A file binding, edit timestamp or shared frontier changed after the actual body/metadata observation.",
        { file_id: binding.file_id },
      )
    const expected =
      state.ownership.kind === "custom"
        ? state.ownership.content.sha256
        : state.ownership.kind === "following"
          ? isResourceFollowing(state.ownership)
            ? snapshot.files.find((file) => file.path === binding.path)?.sha256
            : state.ownership.projection.sha256
          : undefined
    if (expected !== file.body_sha256)
      throw fail(
        "SHARED_FILE_MANAGEMENT_STALE",
        "The observed body no longer matches accepted shared ownership.",
        { file_id: binding.file_id },
      )
  }
  return evidence
}
function pendingRemote(library: SharedLibrary, context: Context) {
  return Effect.gen(function* () {
    const input = {
      skillPageId: context.index.page_id,
      events: context.events,
      headers: context.headers,
    }
    const observed = yield* loadPendingSharedObservationPlans(library, input)
    const written = yield* loadPendingSharedBodyWrites(library, input)
    const managed = yield* loadPendingSharedFileManagement(library, input)
    return [...observed, ...written, ...managed]
  })
}

/** Shared complete-tree proof for non-body lifecycle authors. This is read-only;
 * callers still retain their own original plan and inspect pending operations. */
export function inspectSharedFileManagementContext(library: SharedLibrary, snapshot: Snapshot) {
  return Effect.gen(function* () {
    const locator = snapshot.record.locator
    if (locator.type !== "shared_skill")
      return yield* Effect.fail(
        fail("CONTENT_NOT_MUTABLE", "File management requires a shared Skill."),
      )
    const scope = yield* authScope
    const context = yield* currentContext(library, locator.page_id)
    const states = yield* managementChecked(() => resolved(context))
    const now = yield* Clock.currentTimeMillis
    const evidence = yield* managementChecked(() =>
      assertFreshEvidence(snapshot, library, context, states, scope, now),
    )
    yield* checkSnapshotIdentity(library, snapshot, context, states, evidence.source_revision)
    return {
      ...context,
      states,
      evidence,
      scope,
      journal: yield* scopeFor(scope, library, context.index.skill_id, locator.page_id),
      tree: yield* snapshotTree(snapshot),
      metadata_sha256: yield* metadataDigest(context.index),
      events_sha256: yield* eventDigest(context.events),
      tree_sha256: yield* sha256(canonicalSharedJson(snapshot.files)),
      pending: yield* pendingRemote(library, context),
    }
  })
}

/** Recheck the exact frozen snapshot/frontier before dispatch, never substitute
 * a current tree or infer completion from matching bytes. */
export function revalidateSharedFileManagementContext(
  library: SharedLibrary,
  input: {
    readonly library_id: string
    readonly skill_id: string
    readonly skill_page_id: string
    readonly snapshot_id: string
    readonly snapshot_version_id: string
    readonly snapshot_scope: string
    readonly source_revision: string
    readonly metadata_sha256: string
    readonly events_sha256: string
    readonly tree_sha256: string
  },
) {
  return Effect.gen(function* () {
    const scope = yield* authScope
    if (library.library_id !== input.library_id || scope !== input.snapshot_scope)
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_SCOPE",
          "The original operation belongs to another library or authentication scope.",
        ),
      )
    const snapshot = yield* (yield* Store).readJson(
      `snapshots/${input.snapshot_id}.json`,
      SnapshotSchema,
    )
    const context = yield* currentContext(library, input.skill_page_id)
    if (
      snapshot === undefined ||
      snapshot.scope !== scope ||
      snapshot.version_id !== input.snapshot_version_id ||
      context.index.skill_id !== input.skill_id ||
      (yield* metadataDigest(context.index)) !== input.metadata_sha256 ||
      (yield* eventDigest(context.events)) !== input.events_sha256 ||
      (yield* sha256(canonicalSharedJson(snapshot.files))) !== input.tree_sha256
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_STALE",
          "The original snapshot, binding, metadata or file frontier changed after planning.",
        ),
      )
    const states = yield* managementChecked(() => resolved(context))
    yield* checkSnapshotIdentity(library, snapshot, context, states, input.source_revision)
    return {
      ...context,
      states,
      snapshot,
      tree: yield* snapshotTree(snapshot),
      pending: yield* pendingRemote(library, context),
    }
  })
}

export function prepareSharedFileManagement(input: PrepareSharedFileManagementInput) {
  return Effect.gen(function* () {
    const locator = input.snapshot.record.locator
    if (locator.type !== "shared_skill")
      return yield* Effect.fail(
        fail("CONTENT_NOT_MUTABLE", "File management requires a shared Skill."),
      )
    const scope = yield* authScope
    if (scope !== input.snapshot.scope)
      return yield* Effect.fail(
        fail("SNAPSHOT_CONFLICT", "The snapshot belongs to another authentication scope."),
      )
    const context = yield* currentContext(input.library, locator.page_id)
    const journal = yield* scopeFor(scope, input.library, context.index.skill_id, locator.page_id)
    const local = yield* pendingFileOperations(journal)
    const remote = yield* pendingRemote(input.library, context)
    if (local.length !== 0 || remote.length !== 0)
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_PENDING",
          "Reconcile original shared file operations before planning another lifecycle change.",
          {
            operation_ids: [
              ...new Set([
                ...local.map((entry) => entry.plan.operation_id),
                ...remote.map((plan) => plan.operation_id),
              ]),
            ],
          },
        ),
      )
    const states = yield* managementChecked(() => resolved(context))
    const now = yield* Clock.currentTimeMillis
    const evidence = yield* managementChecked(() =>
      assertFreshEvidence(input.snapshot, input.library, context, states, scope, now),
    )
    yield* checkSnapshotIdentity(
      input.library,
      input.snapshot,
      context,
      states,
      evidence.source_revision,
    )
    const tree = yield* snapshotTree(input.snapshot)
    const path =
      input.action === "add"
        ? yield* managementChecked(() => canonicalManagementPath(input.path))
        : bindings(context.index).find((binding) => binding.file_id === input.fileId)?.path
    if (path === undefined)
      return yield* Effect.fail(
        fail("SHARED_FILE_NOT_BOUND", "The selected stable File ID is not bound in this Skill."),
      )
    const destination =
      input.action === "move"
        ? yield* managementChecked(() => canonicalManagementPath(input.destinationPath))
        : null
    if (path === context.index.main.path || destination === context.index.main.path)
      return yield* Effect.fail(
        fail(
          "SHARED_MAIN_FILE_PROTECTED",
          "The main Skill body cannot be moved, deleted, undeleted or added over.",
        ),
      )
    if (
      (input.action === "add" || input.action === "move") &&
      context.index.files.some((file) => file.path === (destination ?? path))
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_PATH_CONFLICT",
          "This path already has a stable File binding, including a retained tombstone.",
        ),
      )
    if (
      input.action === "undelete" &&
      context.index.files.some((file) => file.path === path && file.file_id !== input.fileId)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_PATH_CONFLICT",
          "Undelete cannot revive a path that another stable file already owns.",
          { path },
        ),
      )
    let before: FrozenWriteBody | null = null
    let creationProjection: SharedNotionMarkdownProjection | null = null
    let supportingHeader: string | undefined
    let creationBindings: readonly { readonly page_id: string; readonly path: string }[] | undefined
    let fileId: string, current: ResolvedFileState | undefined
    let markdown: string
    if (input.action === "add") {
      const document = splitNativeSupportingMarkdown(input.markdown)
      supportingHeader = document.frontmatter
      const available = bindings(context.index).map(({ page_id, path }) => ({ page_id, path }))
      const authored = yield* managementChecked(() =>
        restoreSharedNativeFileLinks(document.body, path, available),
      )
      if (authored !== document.body) creationBindings = available
      creationProjection = yield* managementChecked(() =>
        projectSharedNotionMarkdown(authored, { purpose: "data_source_create" }),
      )
      markdown = creationProjection.markdown
      fileId = `file-${yield* sha256(canonicalSharedJson([input.library.library_id, locator.skill_id, input.snapshot.version_id, path, yield* sha256(input.markdown)]))}`
    } else if (input.action === "undelete") {
      fileId = input.fileId
      const binding = bindings(context.index).find((value) => value.file_id === fileId)
      current = states.get(fileId)
      if (binding === undefined || current === undefined || current.ownership.kind !== "tombstone")
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_NOT_TOMBSTONE",
            "Undelete requires one exact native tombstone. An active file is not revived, and restore-follow stays a separate operation.",
          ),
        )
      if (isResourceContent(current.ownership.retained))
        return yield* Effect.fail(
          fail(
            "SHARED_UNDELETE_UNSUPPORTED",
            "A raw resource tombstone uses its own restore. Markdown undelete does not create a substitute row.",
          ),
        )
      if (input.snapshot.files.some((file) => file.path === path))
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_PATH_CONFLICT",
            "The tombstone path is already present in the active tree.",
            { path },
          ),
        )
      before = yield* readBody(binding.page_id)
      before = { ...before, ...nativeMetadataForOwnership(current.ownership) }
      if (before.fingerprint.sha256 !== current.ownership.retained.sha256)
        return yield* Effect.fail(
          fail(
            "SHARED_UNDELETE_BYTES_UNAVAILABLE",
            "The retained original bytes are unavailable or differ. No new file row was created.",
            { file_id: fileId },
          ),
        )
      markdown = before.markdown
    } else {
      fileId = input.fileId
      const binding = bindings(context.index).find((value) => value.file_id === fileId)
      current = states.get(fileId)
      if (binding === undefined || current === undefined || current.ownership.kind === "tombstone")
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_NOT_BOUND",
            "Select an active supporting file; a tombstone requires an explicit restoration.",
          ),
        )
      before = yield* readBody(binding.page_id)
      before = { ...before, ...nativeMetadataForOwnership(current.ownership) }
      if (
        (yield* managementChecked(() =>
          decideObservedBody(current!.ownership, before!.fingerprint),
        )).kind !== "unchanged" ||
        evidence.files.find((file) => file.file_id === fileId)?.body_sha256 !==
          before.fingerprint.sha256
      )
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_MANAGEMENT_STALE",
            "The exact target body changed after its accepted observation; preserve that edit through a current read first.",
          ),
        )
      markdown = before.markdown
    }
    const hash = yield* sha256(markdown)
    const retained = {
      object_id: `body-${hash}`,
      sha256: hash,
      bytes: new TextEncoder().encode(markdown).byteLength,
      ...nativeMetadataForOwnership(current?.ownership),
      ...(supportingHeader === undefined ? {} : { frontmatter: supportingHeader }),
      ...(input.action === "add" && input.mode !== undefined ? { mode: input.mode } : {}),
    }
    const content = { markdown, retained }
    const checkedTree =
      input.referenceCheck === undefined
        ? yield* managementChecked(() =>
            proposedTree(tree, {
              action: input.action,
              path,
              destination_path: destination,
              content,
              entrypoint: input.snapshot.entrypoint,
            }),
          )
        : { check: input.referenceCheck }

    const parents = current?.heads ?? []
    const sourcePath =
      current?.placement !== undefined
        ? current.placement.source_path
        : current?.ownership.kind === "following" ||
            context.events.some(
              (event) =>
                event.file_id === fileId &&
                (event.kind === "projected" || event.kind === "following_restored"),
            )
          ? path
          : null
    const suppressed = [
      ...new Set([
        ...(current?.placement?.suppressed_paths ?? []),
        path,
        ...(sourcePath === null ? [] : [sourcePath]),
      ]),
    ]
      .filter((value) => value !== destination)
      .sort()
    const event =
      input.action === "add"
        ? { kind: "adopted" as const, file_id: fileId, parents, content: retained }
        : input.action === "delete"
          ? { kind: "deleted" as const, file_id: fileId, parents, retained }
          : input.action === "undelete"
            ? { kind: "undeleted" as const, file_id: fileId, parents, retained }
            : {
                kind: "moved" as const,
                file_id: fileId,
                parents,
                retained,
                from_path: path,
                to_path: destination!,
                source_path: sourcePath,
                suppressed_paths: suppressed,
              }
    const plan = yield* makeSharedFileManagementPlan({
      action: input.action,
      library_id: input.library.library_id,
      skill_page_id: locator.page_id,
      skill_id: locator.skill_id,
      file_id: fileId,
      page_id: before?.page_id ?? null,
      path,
      destination_path: destination,
      entrypoint: input.snapshot.entrypoint,
      source_id: context.index.source_reference,
      source_revision: evidence.source_revision,
      snapshot_id: input.snapshot.snapshot_id,
      snapshot_version_id: input.snapshot.version_id,
      snapshot_scope: scope,
      tree_sha256: yield* sha256(canonicalSharedJson(input.snapshot.files)),
      metadata_sha256: yield* metadataDigest(context.index),
      events_sha256: yield* eventDigest(context.events),
      reference_check: checkedTree.check,
      before,
      creation_projection: creationProjection,
      ...(input.action === "add" && input.mode !== undefined ? { creation_mode: input.mode } : {}),
      ...(input.action === "add" &&
      (supportingHeader !== undefined || creationBindings !== undefined)
        ? { creation_input: input.markdown }
        : {}),
      ...(creationBindings === undefined ? {} : { creation_bindings: creationBindings }),
      content,
      event,
    })
    yield* managementChecked(() =>
      resolveFileState(fileId, [
        ...context.events.filter((value) => value.file_id === fileId),
        plan.event,
      ]),
    )
    return plan
  })
}

function saveOutcome(
  library: SharedLibrary,
  plan: SharedFileManagementPlan,
  status: Outcome["status"],
  reason: string,
  page?: string,
) {
  return Effect.gen(function* () {
    const outcome: Outcome = {
      version: 1,
      kind: "file_management_outcome",
      operation_id: plan.operation_id,
      file_id: plan.file_id,
      status,
      reason_code: reason,
      ...(page === undefined ? {} : { page_id: page }),
      ...(status === "applied" ? { event_id: plan.event.event_id } : {}),
    }
    yield* appendSharedRecord(library, {
      mode: "create",
      recordId: fileManagementOutcomeId(plan.operation_id),
      operationId: plan.operation_id,
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: fileManagementOutcomesEntity,
      payload: outcome,
    })
    return outcome
  })
}
function originalRecord(
  library: SharedLibrary,
  plan: SharedFileManagementPlan,
  mode: "create" | "reconcile",
) {
  return appendSharedRecord(library, {
    mode,
    recordId: plan.operation_id,
    operationId: plan.operation_id,
    skillPageId: plan.skill_page_id,
    kind: "operation",
    entityId: plan.file_id,
    payload: storedSharedOperationPlan(plan),
    payloadContainsBody: true,
  })
}
function retainBody(
  library: SharedLibrary,
  plan: SharedFileManagementPlan,
  mode: "create" | "reconcile",
) {
  const retained = plan.content.retained
  return appendSharedRecord(library, {
    mode,
    recordId: retained.object_id,
    operationId: `retain-${retained.sha256}`,
    skillPageId: plan.skill_page_id,
    kind: "object",
    entityId: retained.object_id,
    payload: retainedFileManagementPayload(plan.content.markdown),
  })
}
function verifyPlanScope(library: SharedLibrary, plan: SharedFileManagementPlan, scope: string) {
  if (library.library_id !== plan.library_id || scope !== plan.snapshot_scope)
    throw fail(
      "SHARED_FILE_MANAGEMENT_SCOPE",
      "The original file operation belongs to another library or authentication scope.",
    )
}
export type SharedFileManagementBatch = {
  readonly parent_operation_id: string
  readonly allowed_operation_ids: readonly string[]
  readonly prior_events: readonly FileEvent[]
  readonly prior_file_ids: readonly string[]
  readonly prior_moves: readonly {
    readonly file_id: string
    readonly from: string
    readonly to: string
  }[]
  readonly baseline_membership_sha256: string
  readonly reference_check: SharedFileManagementPlan["reference_check"]
  readonly final_files: readonly CompositionFile[]
}

/** Binding identity without Notion timestamps. Timestamps are not a compare-and-swap. */
export function sharedFileMembershipShape(index: SharedSkillIndex) {
  return {
    skill_id: index.skill_id,
    page_id: index.page_id,
    kind: index.kind,
    name: index.name,
    description: index.description,
    enabled: index.enabled,
    default_context: index.default_context,
    source_reference: index.source_reference,
    main: {
      file_id: index.main.file_id,
      page_id: index.main.page_id,
      path: index.main.path,
    },
    files: index.files
      .map((file) => ({
        file_id: file.file_id,
        page_id: file.page_id,
        path: file.path,
      }))
      .sort((left, right) =>
        left.file_id < right.file_id ? -1 : left.file_id > right.file_id ? 1 : 0,
      ),
  }
}

function assertBatchFrontier(
  context: Context,
  plan: SharedFileManagementPlan,
  batch: SharedFileManagementBatch,
) {
  return Effect.gen(function* () {
    const priorIds = new Set(batch.prior_events.map((event) => event.event_id))
    for (const event of batch.prior_events) {
      const found = context.events.find((value) => value.event_id === event.event_id)
      if (found === undefined || canonicalSharedJson(found) !== canonicalSharedJson(event))
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_CONCURRENT_EDIT",
            "A prior child of this apply is missing or differs. Later children stay unsent.",
            { file_management_operation_id: plan.operation_id },
          ),
        )
    }
    const baselineEvents = context.events.filter((event) => !priorIds.has(event.event_id))
    if (
      context.events.length !== baselineEvents.length + batch.prior_events.length ||
      (yield* eventDigest(baselineEvents)) !== plan.events_sha256
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_CONCURRENT_EDIT",
          "The shared file frontier changed outside this apply. Completed children stay; the suffix stops.",
          { file_management_operation_id: plan.operation_id },
        ),
      )
    const moves = new Map(batch.prior_moves.map((move) => [move.file_id, move]))
    const files = []
    for (const file of context.index.files) {
      if (batch.prior_file_ids.includes(file.file_id)) continue
      const move = moves.get(file.file_id)
      if (move !== undefined && file.path !== move.to)
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_CONCURRENT_EDIT",
            "A moved file no longer has the path this apply recorded.",
            { file_id: file.file_id },
          ),
        )
      files.push({ ...file, path: move?.from ?? file.path })
    }
    if (
      (yield* sha256(
        canonicalSharedJson(sharedFileMembershipShape({ ...context.index, files })),
      )) !== batch.baseline_membership_sha256 ||
      canonicalSharedJson(plan.reference_check) !== canonicalSharedJson(batch.reference_check)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_CONCURRENT_EDIT",
          "Skill membership or the frozen final reference check changed. No later child is dispatched.",
          { file_management_operation_id: plan.operation_id },
        ),
      )
  })
}

function verifyBefore(
  library: SharedLibrary,
  plan: SharedFileManagementPlan,
  context: Context,
  batch?: SharedFileManagementBatch,
) {
  return Effect.gen(function* () {
    if (
      context.index.skill_id !== plan.skill_id ||
      context.index.page_id !== plan.skill_page_id ||
      context.index.source_reference !== plan.source_id ||
      (batch === undefined &&
        ((yield* metadataDigest(context.index)) !== plan.metadata_sha256 ||
          (yield* eventDigest(context.events)) !== plan.events_sha256))
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_STALE",
          "The complete metadata or shared frontier changed after planning.",
        ),
      )
    if (batch !== undefined) yield* assertBatchFrontier(context, plan, batch)
    const states = yield* managementChecked(() => resolved(context))
    const snapshot = yield* (yield* Store).readJson(
      `snapshots/${plan.snapshot_id}.json`,
      SnapshotSchema,
    )
    if (
      snapshot === undefined ||
      snapshot.scope !== plan.snapshot_scope ||
      snapshot.version_id !== plan.snapshot_version_id ||
      (yield* sha256(canonicalSharedJson(snapshot.files))) !== plan.tree_sha256
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_STALE",
          "The exact checked complete snapshot is unavailable or differs from the original plan.",
        ),
      )
    const priorEventIds = new Set(batch?.prior_events.map((event) => event.event_id) ?? [])
    const ownershipOverride =
      batch === undefined
        ? undefined
        : bindings(context.index).flatMap((binding) => {
            if (batch.prior_file_ids.includes(binding.file_id)) return []
            const events = context.events.filter(
              (event) => event.file_id === binding.file_id && !priorEventIds.has(event.event_id),
            )
            const move = batch.prior_moves.find((item) => item.file_id === binding.file_id)
            return [
              {
                file_id: binding.file_id,
                path: move?.from ?? binding.path,
                state:
                  events.length === 0
                    ? states.get(binding.file_id)
                    : resolveFileState(binding.file_id, events),
              },
            ]
          })
    yield* checkSnapshotIdentity(
      library,
      snapshot,
      context,
      states,
      plan.source_revision,
      ownershipOverride,
    )
    const standaloneTree = batch === undefined ? yield* snapshotTree(snapshot) : undefined
    const references =
      batch === undefined
        ? yield* managementChecked(() => proposedTree(standaloneTree!, plan).check)
        : yield* managementChecked(() => assertSharedFileReferences(batch.final_files))
    if (batch !== undefined) {
      const expected = batch.final_files.find(
        (file) => file.path === (plan.destination_path ?? plan.path),
      )
      if (plan.action === "delete" ? expected !== undefined : expected === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_FINAL_TREE",
            "The child's lifecycle does not match the exact retained target manifest.",
          ),
        )
      if (
        expected !== undefined &&
        (plan.action === "add" || plan.action === "undelete") &&
        ((yield* sha256(expected.bytes)) !== plan.content.retained.sha256 ||
          expected.bytes.byteLength !== plan.content.retained.bytes)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_FINAL_TREE",
            "The child's exact native candidate differs from the retained final tree.",
          ),
        )
    }
    if (canonicalSharedJson(references) !== canonicalSharedJson(plan.reference_check))
      return yield* Effect.fail(
        fail(
          "SHARED_REFERENCE_INVALID",
          "The complete checked reference tree differs from its frozen result.",
        ),
      )
    if (plan.action === "add") {
      if (
        plan.version === 3 &&
        plan.creation_bindings.some(
          (expected) =>
            !bindings(context.index).some(
              (actual) => actual.path === expected.path && actual.page_id === expected.page_id,
            ),
        )
      )
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_MANAGEMENT_STALE",
            "A native reference target changed before file creation.",
          ),
        )
      if (
        bindings(context.index).some(
          (binding) => binding.file_id === plan.file_id || binding.path === plan.path,
        )
      )
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_PATH_CONFLICT",
            "A new file cannot replace an existing stable binding.",
          ),
        )
    } else {
      const binding = bindings(context.index).find((value) => value.file_id === plan.file_id)
      if (binding === undefined || binding.page_id !== plan.page_id || binding.path !== plan.path)
        return yield* Effect.fail(
          fail("SHARED_FILE_MANAGEMENT_STALE", "The original file binding changed."),
        )
      const body = yield* readBody(binding.page_id)
      if (
        body.raw_markdown !== plan.before?.raw_markdown ||
        body.fingerprint.sha256 !== plan.content.retained.sha256
      )
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_MANAGEMENT_STALE",
            "The complete current target body changed before dispatch.",
          ),
        )
    }
    return context
  })
}
function sameOthers(
  before: SharedSkillIndex,
  after: SharedSkillIndex,
  plan: SharedFileManagementPlan,
): boolean {
  const shape = (index: SharedSkillIndex) => ({
    skill_id: index.skill_id,
    page_id: index.page_id,
    kind: index.kind,
    name: index.name,
    description: index.description,
    enabled: index.enabled,
    default_context: index.default_context,
    source_reference: index.source_reference,
    main:
      plan.action === "add" ? { ...index.main, last_edited_time: "relation_creation" } : index.main,
    files: index.files
      .filter((binding) => binding.file_id !== plan.file_id)
      .sort((left, right) =>
        left.file_id < right.file_id ? -1 : left.file_id > right.file_id ? 1 : 0,
      ),
  })
  return canonicalSharedJson(shape(before)) === canonicalSharedJson(shape(after))
}
function retireVerified(plan: SharedFileManagementPlan, journal: SharedPendingFileScope) {
  return Effect.gen(function* () {
    yield* invalidateSnapshotCache(sharedSkillId(plan.library_id, plan.skill_id), journal.scope)
    yield* (yield* Store).retireKeys([yield* pendingFileOperationKey(journal.prefix, plan)])
  })
}

/** Locate an original immutable intent, including an invisible first POST held locally. */
export function loadSharedFileManagementPlan(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly operationId: string },
) {
  return Effect.gen(function* () {
    if (plannedFileManagementEventId(input.operationId) === undefined)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Select the exact original file-management operation ID."),
      )
    const scope = yield* authScope
    const index = yield* querySharedSkillIndex(library, input.skillPageId)
    const journal = yield* scopeFor(scope, library, index.skill_id, input.skillPageId)
    const local = (yield* pendingFileOperations(journal)).find(
      (entry) => entry.plan.operation_id === input.operationId,
    )
    if (local !== undefined) {
      if (local.plan.kind !== "file_management")
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_MANAGEMENT_SCOPE",
            "The original pending intent is another operation kind.",
          ),
        )
      return local.plan
    }
    const rows = yield* querySharedRecords(library, {
      skillPageId: input.skillPageId,
      kind: "operation",
      recordId: input.operationId,
      payloadContainsBody: true,
    })
    const row = rows[0]
    if (rows.length !== 1 || row === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_UNRESOLVED",
          "The original lifecycle intent is unavailable in this credential's local journal and exact shared Skill scope; no replacement will be created.",
        ),
      )
    const plan = yield* validateSharedFileManagementPlan(row.payload)
    if (
      plan.operation_id !== input.operationId ||
      row.operation_id !== plan.operation_id ||
      row.entity_id !== plan.file_id ||
      plan.library_id !== library.library_id ||
      plan.skill_page_id !== input.skillPageId ||
      plan.skill_id !== index.skill_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_SCOPE",
          "The shared lifecycle intent differs from the selected original identity.",
        ),
      )
    return plan
  })
}

/** Exact original-operation facts only. Matching current bytes never authorize replay or success. */
export function reconcileSharedFileManagement(
  library: SharedLibrary,
  input: SharedFileManagementPlan | SharedResourceAuthoringPlan,
) {
  return Effect.gen(function* () {
    if (input.kind === "resource_authoring")
      return yield* reconcileSharedResourceAuthoring(library, input)
    const plan = yield* validateSharedFileManagementPlan(input)
    const scope = yield* authScope
    if (library.library_id !== plan.library_id)
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_SCOPE",
          "The original file operation belongs to another shared library.",
        ),
      )
    const index = yield* querySharedSkillIndex(library, plan.skill_page_id)
    if (index.skill_id !== plan.skill_id)
      return yield* Effect.fail(
        fail("SHARED_FILE_MANAGEMENT_SCOPE", "The current Skill has a different stable identity."),
      )
    yield* originalRecord(library, plan, "reconcile").pipe(
      Effect.mapError((error) => recovery(error, plan, "plan")),
    )
    yield* retainBody(library, plan, "reconcile").pipe(
      Effect.mapError((error) => recovery(error, plan, "retained_body")),
    )
    const rows = yield* querySharedRecords(library, {
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: fileManagementOutcomesEntity,
      recordId: fileManagementOutcomeId(plan.operation_id),
    })
    const row = rows[0]
    if (rows.length !== 1 || row === undefined)
      return yield* Effect.fail(
        recovery(
          fail(
            "SHARED_FILE_MANAGEMENT_UNRESOLVED",
            "The exact original lifecycle outcome is unavailable. A matching current page, body or event does not prove this operation completed; no create or Path PATCH was replayed.",
          ),
          plan,
          "outcome",
        ),
      )
    const outcome = yield* managementChecked(() => decodeOutcome(row))
    if (outcome.file_id !== plan.file_id)
      return yield* Effect.fail(
        fail("SHARED_FILE_MANAGEMENT_SCOPE", "The original outcome belongs to another file."),
      )
    if (outcome.status === "needs_review") {
      const accepted = yield* completedSharedFileAddAcceptance(library, plan)
      if (accepted !== undefined) {
        yield* retireVerified(
          plan,
          yield* scopeFor(scope, library, plan.skill_id, plan.skill_page_id),
        )
        return accepted
      }
      return yield* Effect.fail(
        recovery(
          fail(
            "SHARED_FILE_MANAGEMENT_REVIEW_REQUIRED",
            "The original lifecycle operation requires explicit review; retain its page and frozen bytes.",
          ),
          plan,
          "postcondition",
        ),
      )
    }
    if (outcome.status === "applied") {
      const event = yield* appendSharedRecord(library, {
        mode: "reconcile",
        recordId: plan.event.event_id,
        operationId: plan.event.event_id,
        skillPageId: plan.skill_page_id,
        kind: "file_event",
        entityId: plan.file_id,
        payload: plan.event,
      })
      const binding = index.files.find((file) => file.file_id === plan.file_id)
      if (
        binding === undefined ||
        binding.page_id !== outcome.page_id ||
        event.entity_id !== plan.file_id ||
        (plan.page_id !== null && outcome.page_id !== plan.page_id)
      )
        return yield* Effect.fail(
          recovery(
            fail(
              "UNBOUND_FILE_STATE",
              "The original verified lifecycle operation no longer has its exact page binding.",
            ),
            plan,
            "binding",
          ),
        )
    }
    const journal = yield* scopeFor(scope, library, plan.skill_id, plan.skill_page_id)
    yield* retireVerified(plan, journal)
    return {
      status: outcome.status === "applied" ? ("applied" as const) : ("not_applied" as const),
      operation_id: plan.operation_id,
      page_id: outcome.page_id ?? plan.page_id,
      verified: true as const,
      requires_fresh_read: true as const,
    }
  }).pipe((effect) =>
    withNotionRequestAttribution(effect, {
      phase: "reconcile",
      skill_page_id: input.skill_page_id,
      operation_id: input.operation_id,
    }),
  )
}

function authenticateApplyParent(
  library: SharedLibrary,
  plan: SharedFileManagementPlan,
  parent: SharedSkillApplyPlan | undefined,
  completed: readonly string[] | undefined,
) {
  return Effect.gen(function* () {
    if (parent === undefined && completed === undefined) return undefined
    if (parent === undefined || parent.version !== 2)
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_PARENT_REQUIRED",
          "A layout child inside an apply must cite its retained parent. A forged batch is not accepted.",
        ),
      )
    const validated = yield* validateSharedSkillApplyPlan(parent)
    if (validated.version !== 2)
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_PARENT_REQUIRED",
          "Only a version 2 parent can authorize a layout child.",
        ),
      )
    const child = validated.layout.find((item) => item.operation_id === plan.operation_id)
    if (
      child === undefined ||
      canonicalSharedJson(child) !== canonicalSharedJson(plan) ||
      validated.library_id !== library.library_id ||
      canonicalSharedJson(plan.reference_check) !== canonicalSharedJson(validated.reference_check)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_PARENT_REQUIRED",
          "The parent does not contain this exact child or its frozen final reference check.",
        ),
      )
    const rows = yield* querySharedRecords(library, {
      skillPageId: validated.skill_page_id,
      kind: "operation",
      entityId: "skill-apply-plans-v1",
      recordId: validated.operation_id,
      payloadContainsBody: true,
    })
    const stored = rows[0]
    if (
      rows.length !== 1 ||
      stored === undefined ||
      canonicalSharedJson(stored.payload) !== canonicalSharedJson(validated)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_PARENT_REQUIRED",
          "The original parent plan is not retained. No layout child is dispatched from a caller-supplied batch.",
        ),
      )
    const done = new Set(completed ?? [])
    const order = sharedSkillApplyChildren(validated).map((item) => item.operation_id)
    const position = order.indexOf(plan.operation_id)
    if (
      position < 0 ||
      done.size !== position ||
      (completed?.length ?? 0) !== position ||
      order.slice(0, position).some((id) => !done.has(id))
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_PARENT_REQUIRED",
          "Completed children must be the original prefix of this parent.",
        ),
      )
    for (const id of order.slice(0, position)) {
      const prior = validated.layout.find((value) => value.operation_id === id)
      if (prior === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_PARENT_REQUIRED",
            "A file-layout child cannot bypass an unverified prior operation family.",
          ),
        )
      const result = yield* reconcileSharedFileManagement(library, prior)
      if (result.status !== "applied")
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_UNRESOLVED",
            "The original prior layout child has not applied; its suffix remains unsent.",
          ),
        )
    }
    return validated
  })
}

export function executeSharedFileManagement<R = never>(
  library: SharedLibrary,
  input: {
    readonly plan: SharedFileManagementPlan
    readonly mode: "create" | "reconcile"
    readonly parent?: SharedSkillApplyPlan
    readonly completedChildIds?: readonly string[]
    readonly beforePlanWrite?: (
      plan: SharedFileManagementPlan,
    ) => Effect.Effect<void, SkillsError, R>
  },
) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedFileManagementPlan(input.plan)
    const parent = yield* authenticateApplyParent(
      library,
      plan,
      input.parent,
      input.completedChildIds,
    )
    const batch =
      parent === undefined
        ? undefined
        : {
            parent_operation_id: parent.operation_id,
            allowed_operation_ids: [
              parent.operation_id,
              ...sharedSkillApplyChildren(parent).map((child) => child.operation_id),
            ],
            prior_events: parent.layout
              .filter((child) => input.completedChildIds?.includes(child.operation_id))
              .map((child) => child.event),
            prior_file_ids: parent.layout
              .filter(
                (child) =>
                  child.action === "add" && input.completedChildIds?.includes(child.operation_id),
              )
              .map((child) => child.file_id),
            prior_moves: parent.layout.flatMap((child) =>
              child.action === "move" &&
              child.destination_path !== null &&
              input.completedChildIds?.includes(child.operation_id)
                ? [{ file_id: child.file_id, from: child.path, to: child.destination_path }]
                : [],
            ),
            baseline_membership_sha256: parent.membership_sha256,
            reference_check: parent.reference_check,
            final_files: yield* loadSharedApplyReferenceTree(parent),
          }
    if (input.mode === "reconcile") return yield* reconcileSharedFileManagement(library, plan)
    if (input.mode !== "create")
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "File management mode must be create or reconcile."),
      )
    const scope = yield* authScope
    yield* managementChecked(() => verifyPlanScope(library, plan, scope))
    const journal = yield* scopeFor(scope, library, plan.skill_id, plan.skill_page_id)
    const local = yield* pendingFileOperations(journal)
    const original = local.find((entry) => entry.plan.operation_id === plan.operation_id)
    if (original !== undefined) {
      if (canonicalSharedJson(original.plan) !== canonicalSharedJson(plan))
        return yield* Effect.fail(
          fail(
            "STATE_CORRUPT",
            "The original frozen file operation differs from the requested plan.",
          ),
        )
      return yield* reconcileSharedFileManagement(library, plan)
    }
    const context = yield* withNotionRequestAttribution(
      currentContext(library, plan.skill_page_id),
      { phase: "author_preflight" },
    )
    if (context.headers.some((header) => header.record_id === plan.operation_id))
      return yield* reconcileSharedFileManagement(library, plan)
    const remote = yield* withNotionRequestAttribution(pendingRemote(library, context), {
      phase: "author_preflight",
    })
    const allowed = new Set(batch?.allowed_operation_ids ?? [])
    const blocked =
      batch === undefined
        ? local.length !== 0 || remote.length !== 0
        : local.some((entry) => !allowed.has(entry.plan.operation_id)) ||
          remote.some((pending) => !allowed.has(pending.operation_id))
    if (blocked)
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_MANAGEMENT_PENDING",
          "An original shared file operation must be reconciled before this new lifecycle dispatch.",
        ),
      )
    const before = yield* withNotionRequestAttribution(
      verifyBefore(library, plan, context, batch),
      { phase: "author_preflight" },
    )
    if (input.beforePlanWrite !== undefined) yield* input.beforePlanWrite(plan)
    yield* retainPendingFileOperation(journal, plan)
    yield* invalidateSnapshotCache(sharedSkillId(plan.library_id, plan.skill_id), scope)
    yield* originalRecord(library, plan, "create").pipe(
      Effect.mapError((error) => recovery(error, plan, "plan")),
    )
    yield* retainBody(library, plan, "create").pipe(
      Effect.mapError((error) => recovery(error, plan, "retained_body")),
    )
    const checked = yield* currentContext(library, plan.skill_page_id).pipe(
      Effect.flatMap((current) => verifyBefore(library, plan, current, batch)),
      (effect) => withNotionRequestAttribution(effect, { phase: "author_preflight" }),
      Effect.result,
    )
    if (checked._tag === "Failure") {
      yield* saveOutcome(
        library,
        plan,
        "not_sent",
        checked.failure.code,
        plan.page_id ?? undefined,
      ).pipe(Effect.mapError((error) => recovery(error, plan, "outcome")))
      return yield* Effect.fail(recovery(checked.failure, plan, "pre_send"))
    }
    let selectedPage = plan.page_id
    if (plan.action !== "delete" && plan.action !== "undelete") {
      const api = yield* Notion
      const field = library.files.property_ids
      const text = (value: string) => ({ rich_text: [{ type: "text", text: { content: value } }] })
      const request =
        plan.action === "add"
          ? api.request(
              "v1/pages",
              {
                parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
                properties: {
                  [field.Name!]: {
                    title: [
                      { type: "text", text: { content: plan.path.split("/").at(-1) ?? plan.path } },
                    ],
                  },
                  [field["File ID"]!]: text(plan.file_id),
                  [field.Path!]: text(plan.path),
                  [field.Projection!]: { rich_text: [] },
                  [field.Status!]: { select: { name: "custom" } },
                  [field.Skill!]: { relation: [{ id: plan.skill_page_id }] },
                },
                markdown: sharedNotionMarkdownWire(plan.creation_projection!),
                markdown_version: "v2",
              },
              { method: "POST" },
            )
          : api.request(
              `v1/pages/${plan.page_id}`,
              { properties: { [field.Path!]: text(plan.destination_path!) } },
              { method: "PATCH" },
            )
      const response = yield* request.pipe(Effect.result)
      if (response._tag === "Failure") {
        const details = property(response.failure.details)
        if (
          response.failure.code === "NOTION_REQUEST_FAILED" &&
          details.phase === "definitive_rejection" &&
          details.http_status === 400 &&
          details.notion_code === "validation_error"
        )
          yield* saveOutcome(
            library,
            plan,
            "rejected",
            response.failure.code,
            plan.page_id ?? undefined,
          ).pipe(Effect.mapError((error) => recovery(error, plan, "outcome")))
        return yield* Effect.fail(
          recovery(response.failure, plan, plan.action === "add" ? "create_page" : "path_patch"),
        )
      }
      const responseId = property(response.success).id
      if (
        property(response.success).object !== "page" ||
        typeof responseId !== "string" ||
        pageId(responseId) !== responseId ||
        (plan.page_id !== null && responseId !== plan.page_id)
      ) {
        yield* saveOutcome(
          library,
          plan,
          "needs_review",
          "INVALID_PAGE_RESPONSE",
          plan.page_id ?? undefined,
        ).pipe(Effect.mapError((error) => recovery(error, plan, "outcome")))
        return yield* Effect.fail(
          recovery(
            fail(
              "SHARED_FILE_MANAGEMENT_REVIEW_REQUIRED",
              "The create or Path PATCH returned no exact page receipt; no request was replayed.",
            ),
            plan,
            "page_response",
          ),
        )
      }
      selectedPage = responseId
    }
    const exact = yield* Effect.gen(function* () {
      const after = yield* currentContext(library, plan.skill_page_id)
      const binding = after.index.files.find((file) => file.file_id === plan.file_id)
      const priorIds = new Set(batch?.prior_events.map((event) => event.event_id) ?? [])
      const observedPrior = after.events.filter((event) => priorIds.has(event.event_id))
      const observedBaseline = after.events.filter((event) => !priorIds.has(event.event_id))
      const frontierMatches =
        batch === undefined
          ? (yield* eventDigest(after.events)) === plan.events_sha256
          : observedPrior.length === batch.prior_events.length &&
            batch.prior_events.every((event) =>
              observedPrior.some(
                (found) => canonicalSharedJson(found) === canonicalSharedJson(event),
              ),
            ) &&
            (yield* eventDigest(observedBaseline)) === plan.events_sha256
      if (
        binding === undefined ||
        binding.page_id !== selectedPage ||
        binding.path !== (plan.destination_path ?? plan.path) ||
        !sameOthers(before.index, after.index, plan) ||
        !frontierMatches
      )
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_MANAGEMENT_STALE",
            "The exact file binding, other metadata, source selection or prior frontier changed during lifecycle dispatch.",
          ),
        )
      const body = yield* readBody(binding.page_id)
      if (
        body.fingerprint.sha256 !== plan.content.retained.sha256 ||
        body.bytes !== plan.content.retained.bytes
      )
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_MANAGEMENT_BODY_MISMATCH",
            "The resulting complete file body differs from the frozen content. The page remains intact for review.",
          ),
        )
      yield* managementChecked(() =>
        resolveFileState(plan.file_id, [
          ...after.events.filter((event) => event.file_id === plan.file_id),
          plan.event,
        ]),
      )
      return { after, binding }
    }).pipe(
      (effect) => withNotionRequestAttribution(effect, { phase: "author_verify" }),
      Effect.result,
    )
    if (exact._tag === "Failure") {
      yield* saveOutcome(
        library,
        plan,
        "needs_review",
        exact.failure.code,
        selectedPage ?? undefined,
      ).pipe(Effect.mapError((error) => recovery(error, plan, "outcome")))
      return yield* Effect.fail(
        recovery(
          fail(
            "SHARED_FILE_MANAGEMENT_REVIEW_REQUIRED",
            "The exact lifecycle postcondition was not verified. Original bytes and the native page remain retained; no rollback or replacement was attempted.",
            { cause_code: exact.failure.code, page_id: selectedPage },
          ),
          plan,
          "postcondition",
        ),
      )
    }
    const acknowledgedEvent = yield* appendSharedRecord(library, {
      mode: "create",
      recordId: plan.event.event_id,
      operationId: plan.event.event_id,
      skillPageId: plan.skill_page_id,
      kind: "file_event",
      entityId: plan.file_id,
      payload: plan.event,
    }).pipe(Effect.mapError((error) => recovery(error, plan, "event")))
    const events = yield* withNotionRequestAttribution(readEvents(library, plan.skill_page_id), {
      phase: "author_verify",
    })
    if (
      events.some(
        (event) =>
          event.event_id === plan.event.event_id &&
          canonicalSharedJson(event) !== canonicalSharedJson(acknowledgedEvent.payload),
      )
    )
      return yield* Effect.fail(
        recovery(
          fail(
            "SHARED_STATE_CONFLICT",
            "The acknowledged lifecycle event differs from the complete shared history.",
          ),
          plan,
          "event",
        ),
      )
    // The exact append ACK proves this immutable fact even when the query index lags it.
    // The full fresh history still rejects conflicting heads and missing parents.
    const state = yield* managementChecked(() =>
      resolveFileState(plan.file_id, [
        ...events.filter((event) => event.file_id === plan.file_id),
        acknowledgedEvent.payload,
      ]),
    )
    yield* saveOutcome(
      library,
      plan,
      "applied",
      "EXACT_FILE_AND_EVENT_VERIFIED",
      exact.success.binding.page_id,
    ).pipe(Effect.mapError((error) => recovery(error, plan, "outcome")))
    yield* retireVerified(plan, journal)
    return {
      status: "applied" as const,
      operation_id: plan.operation_id,
      page_id: exact.success.binding.page_id,
      file_id: plan.file_id,
      event: plan.event,
      state,
      verified: true as const,
      requires_fresh_read: true as const,
    }
  }).pipe((effect) =>
    withNotionRequestAttribution(effect, {
      phase: "author_apply",
      skill_page_id: input.plan.skill_page_id,
      operation_id: input.plan.operation_id,
    }),
  )
}

/** Share the existing one-per-Skill compact index; completed plans never load full bodies. */
export function loadPendingSharedFileManagement(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly events: readonly FileEvent[]
    readonly headers?: readonly SharedOperationHeader[]
  },
) {
  return Effect.gen(function* () {
    const headers = input.headers ?? (yield* querySharedOperationIndex(library, input.skillPageId))
    const independentAcceptances = yield* loadCompletedSharedFileAddAcceptances(library, {
      ...input,
      headers,
    })
    const resources = yield* loadPendingSharedResourceAuthoring(library, { ...input, headers })
    const candidates = headers.filter(
      (header) =>
        header.record_id.startsWith("file-management-") &&
        header.entity_id !== fileManagementOutcomesEntity,
    )
    if (candidates.length === 0)
      return resources as readonly (SharedFileManagementPlan | SharedResourceAuthoringPlan)[]
    const byId = new Map(headers.map((header) => [header.record_id, header]))
    const outcomes = new Map<string, Outcome>()
    if (headers.some((header) => header.entity_id === fileManagementOutcomesEntity)) {
      const rows = yield* querySharedRecords(library, {
        skillPageId: input.skillPageId,
        kind: "operation",
        entityId: fileManagementOutcomesEntity,
      })
      for (const row of rows) {
        const outcome = yield* managementChecked(() => decodeOutcome(row))
        if (byId.get(row.record_id)?.hash !== row.hash)
          return yield* Effect.fail(
            fail(
              "SHARED_FILE_MANAGEMENT_INVALID",
              "A lifecycle outcome differs from its compact index.",
            ),
          )
        outcomes.set(outcome.operation_id, outcome)
      }
      for (const header of headers.filter(
        (value) => value.entity_id === fileManagementOutcomesEntity,
      )) {
        const operation = header.record_id.replace(/^outcome-/u, "")
        if (!outcomes.has(operation))
          return yield* Effect.fail(
            fail(
              "SHARED_FILE_MANAGEMENT_UNRESOLVED",
              "An indexed lifecycle outcome is unavailable; missing facts cannot clear its original plan.",
            ),
          )
      }
    }
    const plans: SharedFileManagementPlan[] = []
    for (const header of candidates) {
      const eventId = plannedFileManagementEventId(header.record_id)
      if (eventId === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_MANAGEMENT_INVALID",
            "A lifecycle header has an invalid original operation identity.",
          ),
        )
      const outcome = outcomes.get(header.record_id)
      if (outcome !== undefined && outcome.file_id !== header.entity_id)
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_MANAGEMENT_SCOPE",
            "A lifecycle outcome belongs to another original file.",
          ),
        )
      if (outcome?.status === "not_sent" || outcome?.status === "rejected") continue
      if (outcome?.status === "applied") {
        const event = input.events.find((value) => value.event_id === eventId)
        if (event === undefined || event.file_id !== header.entity_id)
          return yield* Effect.fail(
            fail(
              "SHARED_FILE_MANAGEMENT_UNRESOLVED",
              "A lifecycle completion has no exact visible acceptance event.",
            ),
          )
        const { event_id: _event, ...fields } = event
        const hash = yield* sha256(canonicalSharedJson({ version: 1, ...fields }))
        if (!eventId.endsWith(`-${hash}`))
          return yield* Effect.fail(
            fail(
              "SHARED_FILE_MANAGEMENT_INVALID",
              "A lifecycle completion differs from its content-derived event identity.",
            ),
          )
        continue
      }
      const rows = yield* querySharedRecords(library, {
        skillPageId: input.skillPageId,
        kind: "operation",
        entityId: header.entity_id,
        recordId: header.record_id,
        payloadContainsBody: true,
      })
      const row = rows[0]
      if (rows.length !== 1 || row === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_MANAGEMENT_UNRESOLVED",
            "The indexed original lifecycle plan is unavailable; never replace it with new intent.",
          ),
        )
      const plan = yield* validateSharedFileManagementPlan(row.payload)
      if (
        row.hash !== header.hash ||
        row.record_id !== plan.operation_id ||
        row.operation_id !== plan.operation_id ||
        row.entity_id !== plan.file_id ||
        row.skill_page_id !== plan.skill_page_id ||
        plan.skill_page_id !== input.skillPageId ||
        plan.library_id !== library.library_id
      )
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_MANAGEMENT_SCOPE",
            "The original lifecycle plan differs from its exact compact index identity.",
          ),
        )
      if (outcome?.status === "needs_review" && independentAcceptances.has(plan.operation_id))
        continue
      plans.push(plan)
    }
    return [...plans, ...resources].sort((left, right) =>
      left.operation_id < right.operation_id ? -1 : left.operation_id > right.operation_id ? 1 : 0,
    )
  })
}
