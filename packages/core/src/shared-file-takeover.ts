import { Effect, Schema } from "effect"
import { fail, property } from "./model.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import {
  FileEventSchema,
  resolveFileState,
  nativeMetadataForOwnership,
  nativeFileMetadata,
  NativeFileMetadataFields,
  decideObservedBody,
} from "./shared-file-state.ts"
import {
  assertSharedFileIntentReady,
  fileIntentChecked,
  readSharedFileIntentContext,
  sharedFileIntentJournal,
  type SharedFileIntentContext,
} from "./shared-file-intent.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { nativeObservedObjectIdentity } from "./shared-native-body-completion.ts"
import {
  commitSharedObservationPlan,
  makeSharedObservationPlan,
  reconcileSharedObservation,
  SharedObservationPlanSchema,
  validateSharedObservationPlan,
  loadPendingSharedObservationPlans,
  type SharedObservationPlan,
  type FrozenObservationBody,
} from "./shared-observation-operation.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import {
  pendingFileOperationKey,
  pendingFileOperations,
  retainPendingFileOperation,
} from "./shared-pending-file-operations.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import { SharedFileSourceContextSchema } from "./shared-file-source-context-model.ts"
import { completeNativeMainInput } from "./shared-complete-main-input.ts"
import { canonicalMain } from "./portable.ts"
import { readManagedFileBody, loadPendingSharedFileManagement } from "./shared-file-management.ts"
import { loadPendingSharedBodyWrites } from "./shared-body-write.ts"
import { loadPendingSharedMetadataWrites } from "./shared-metadata-write.ts"
import { loadPendingSharedSkillApplies } from "./shared-skill-apply.ts"

const HeaderInputSchema = Schema.Struct({
  version: Schema.Literal(1),
  input_markdown: Schema.String,
  input_sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  name: Schema.String,
  description: Schema.String,
  before_metadata: Schema.Struct(NativeFileMetadataFields),
  raw_body_sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  index_sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  bindings: Schema.Array(Schema.Struct({ page_id: Schema.String, path: Schema.String })),
})
type HeaderInput = typeof HeaderInputSchema.Type
const headerBindings = (context: SharedFileIntentContext) =>
  [context.index.main, ...context.index.files].map((file) => ({
    page_id: file.page_id,
    path: file.path,
  }))
function headerIndexIdentity(context: SharedFileIntentContext) {
  const binding = (file: SharedFileIntentContext["index"]["main"]) => ({
    file_id: file.file_id,
    page_id: file.page_id,
    skill_page_id: file.skill_page_id,
    path: file.path,
    ...(file.baseline === undefined ? {} : { baseline: file.baseline }),
  })
  return {
    ...context.index,
    main: binding(context.index.main),
    files: context.index.files.map(binding),
  }
}

/** Full header authoring is explicitly separate from ordinary body-only writes.
 * The body must have the exact consumer representation, including code and links. */
function headerMetadata(input: HeaderInput, body: string) {
  const parsed = completeNativeMainInput({
    text: input.input_markdown,
    name: input.name,
    description: input.description,
    path: "SKILL.md",
    bindings: input.bindings,
  })
  const representation = (value: string) =>
    new TextDecoder().decode(
      canonicalMain(input.name, input.description, value, {
        path: "SKILL.md",
        bytes: new Uint8Array(),
      }).bytes,
    )
  if (representation(parsed.body) !== representation(body))
    throw fail(
      "SHARED_HEADER_BODY_CHANGED",
      "A header-only input must preserve the complete current body; no body or header was written.",
    )
  return { ...input.before_metadata, frontmatter: parsed.frontmatter }
}

/** The new header entry cannot bypass any original family, including a parent
 * whose body is independently readable. Its own exact observation is the sole exclusion. */
function headerIntentReady(
  library: SharedLibrary,
  context: SharedFileIntentContext,
  own?: SharedObservationPlan,
) {
  return Effect.gen(function* () {
    const headers = yield* querySharedOperationIndex(library, context.index.page_id)
    const rows = yield* querySharedRecords(library, {
      skillPageId: context.index.page_id,
      kind: "file_event",
    })
    const events = yield* fileIntentChecked(() =>
      rows.map((row) => {
        const event = Schema.decodeUnknownSync(FileEventSchema)(row.payload, {
          onExcessProperty: "error",
        })
        if (row.record_id !== event.event_id || row.entity_id !== event.file_id)
          throw fail(
            "SHARED_FILE_INTENT_INVALID",
            "The current complete file frontier differs from its identities.",
          )
        return event
      }),
    )
    const current = { skillPageId: context.index.page_id, headers, events }
    const pending = [
      ...(yield* loadPendingSharedSkillApplies(library, current)),
      ...(yield* loadPendingSharedBodyWrites(library, current)),
      ...(yield* loadPendingSharedObservationPlans(library, current)),
      ...(yield* loadPendingSharedMetadataWrites(library, current)),
      ...(yield* loadPendingSharedFileManagement(library, current)),
      ...(yield* pendingFileOperations(yield* sharedFileIntentJournal(library, context))).map(
        (entry) => entry.plan,
      ),
    ]
    if (
      pending.some(
        (plan) =>
          own === undefined ||
          plan.operation_id !== own.operation_id ||
          canonicalSharedJson(plan) !== canonicalSharedJson(own),
      )
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_INTENT_PENDING",
          "An original pending operation cannot be released by editing the main header.",
        ),
      )
  })
}

export const SharedFileTakeoverPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("file_takeover"),
  plan_id: Schema.String.check(Schema.isPattern(/^takeover-[a-f0-9]{64}$/u)),
  library_id: Schema.String,
  skill_id: Schema.String,
  source_id: Schema.String,
  source_context: SharedFileSourceContextSchema,
  path: Schema.String,
  observation: SharedObservationPlanSchema,
  /** Optional explicit complete-header input; absent in all original takeover plans. */
  main_header_input: Schema.optional(HeaderInputSchema),
})
export type SharedFileTakeoverPlan = typeof SharedFileTakeoverPlanSchema.Type

export function validateSharedFileTakeoverPlan(library: SharedLibrary, input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* fileIntentChecked(() =>
      Schema.decodeUnknownSync(SharedFileTakeoverPlanSchema)(structuredClone(input), {
        onExcessProperty: "error",
      }),
    )
    yield* validateSharedObservationPlan(plan.observation)
    if (plan.main_header_input !== undefined) {
      const header = plan.main_header_input
      const expected = yield* fileIntentChecked(() =>
        headerMetadata(header, plan.observation.body.markdown),
      )
      if (
        plan.path !== "SKILL.md" ||
        plan.observation.page_id !== plan.observation.skill_page_id ||
        plan.observation.event.parents.length === 0 ||
        (yield* sha256(header.input_markdown)) !== header.input_sha256 ||
        canonicalSharedJson(nativeFileMetadata(plan.observation.event.content)) !==
          canonicalSharedJson(expected)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_INTENT_INVALID",
            "The complete main header differs from its frozen input, prior native metadata or exact unchanged body.",
          ),
        )
    }
    const { plan_id, ...contents } = plan
    if (
      plan.library_id !== library.library_id ||
      plan_id !== "takeover-" + (yield* sha256(canonicalSharedJson(contents)))
    )
      return yield* Effect.fail(
        fail("SHARED_FILE_INTENT_INVALID", "The takeover plan digest or library identity differs."),
      )
    return plan
  })
}

/** Explicit consent can adopt unchanged following bytes; Status and timestamps cannot. */
export function prepareSharedFileTakeover(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly path: string
  readonly headerInput?: string
}) {
  return Effect.gen(function* () {
    const context = yield* readSharedFileIntentContext({
      ...input,
      allowDisabledHeader: input.headerInput !== undefined,
    })
    if (context.state?.ownership.kind === "tombstone")
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_INTENT_BLOCKED",
          "A tombstone requires its separate explicit restoration lifecycle.",
        ),
      )
    yield* assertSharedFileIntentReady(input.library, context)
    let header: HeaderInput | undefined
    let body: FrozenObservationBody
    if (input.headerInput !== undefined) {
      if (
        input.path !== "SKILL.md" ||
        context.index.kind !== "skill" ||
        context.binding.file_id !== context.index.main.file_id ||
        context.binding.page_id !== context.index.page_id ||
        context.state === undefined ||
        context.state.heads.length !== 1
      )
        return yield* Effect.fail(
          fail(
            "SHARED_MAIN_HEADER_SCOPE",
            "Header input requires one existing native main baseline; Git-only, resource and unresolved files keep their separate entry points.",
          ),
        )
      yield* headerIntentReady(input.library, context)
      const { raw_markdown, ...observed } = yield* readManagedFileBody(context.binding.page_id)
      body = observed
      if (
        (yield* fileIntentChecked(() =>
          decideObservedBody(context.state!.ownership, body.fingerprint),
        )).kind !== "unchanged"
      )
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_INTENT_STALE",
            "The native body changed before the header-only request; read and resolve that original edit first.",
          ),
        )
      header = {
        version: 1,
        input_markdown: input.headerInput,
        input_sha256: yield* sha256(input.headerInput),
        name: context.index.name,
        description: context.index.description,
        before_metadata: nativeMetadataForOwnership(context.state.ownership),
        raw_body_sha256: yield* sha256(raw_markdown),
        index_sha256: yield* sha256(canonicalSharedJson(headerIndexIdentity(context))),
        bindings: headerBindings(context),
      }
    } else body = yield* observeSharedBody(context.binding.page_id)
    const retained = yield* nativeObservedObjectIdentity(
      body.fingerprint.sha256,
      body.native_body_completion,
    )
    const content = {
      object_id: retained.object_id,
      sha256: body.fingerprint.sha256,
      bytes: body.bytes,
      ...(header === undefined
        ? nativeMetadataForOwnership(context.state?.ownership)
        : yield* fileIntentChecked(() => headerMetadata(header!, body.markdown))),
    }
    const parents = [...(context.state?.heads ?? [])].sort()
    const eventDescription = { version: 1, file_id: context.binding.file_id, parents, content }
    const event = yield* fileIntentChecked(() =>
      Schema.decodeUnknownSync(FileEventSchema)({
        kind: "adopted",
        file_id: context.binding.file_id,
        parents,
        content,
        event_id: "pending",
      }),
    )
    if (event.kind !== "adopted")
      return yield* Effect.fail(
        fail("SHARED_FILE_INTENT_INVALID", "A takeover must produce an adopted event."),
      )
    const observation = yield* makeSharedObservationPlan({
      skillPageId: context.index.page_id,
      fileId: context.binding.file_id,
      pageId: context.binding.page_id,
      body,
      event: {
        ...event,
        event_id: "adopt-" + (yield* sha256(canonicalSharedJson(eventDescription))),
      },
    })
    const contents = {
      version: 1 as const,
      kind: "file_takeover" as const,
      library_id: input.library.library_id,
      skill_id: context.index.skill_id,
      source_id: context.index.source_reference,
      source_context: context.sourceContext,
      path: context.binding.path,
      observation,
      ...(header === undefined ? {} : { main_header_input: header }),
    }
    const plan = yield* validateSharedFileTakeoverPlan(input.library, {
      ...contents,
      plan_id: "takeover-" + (yield* sha256(canonicalSharedJson(contents))),
    })
    return {
      status: "planned" as const,
      dry_run: true as const,
      body_writes: 0 as const,
      unchanged:
        context.state?.ownership.kind === "custom" &&
        context.state.ownership.content.sha256 === body.fingerprint.sha256 &&
        canonicalSharedJson(nativeMetadataForOwnership(context.state.ownership)) ===
          canonicalSharedJson(nativeFileMetadata(content)),
      plan,
      ...(header === undefined
        ? {}
        : {
            header_change: {
              before: header.before_metadata,
              after: nativeFileMetadata(content),
              input_sha256: header.input_sha256,
            },
          }),
    }
  }).pipe(withReadOnlyNotion)
}

function currentForPlan(library: SharedLibrary, plan: SharedFileTakeoverPlan) {
  return Effect.gen(function* () {
    const context = yield* readSharedFileIntentContext({
      library,
      skillPageId: plan.observation.skill_page_id,
      path: plan.path,
      allowDisabledHeader: plan.main_header_input !== undefined,
    })
    if (
      context.index.skill_id !== plan.skill_id ||
      context.index.source_reference !== plan.source_id ||
      canonicalSharedJson(context.sourceContext) !== canonicalSharedJson(plan.source_context) ||
      context.binding.file_id !== plan.observation.file_id ||
      context.binding.page_id !== plan.observation.page_id ||
      context.state?.ownership.kind === "tombstone" ||
      canonicalSharedJson(context.state?.heads ?? []) !==
        canonicalSharedJson(plan.observation.event.parents)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_INTENT_STALE",
          "The file identity, selected source or original frontier changed.",
        ),
      )
    const header = plan.main_header_input
    if (header !== undefined) {
      if (
        (yield* sha256(canonicalSharedJson(headerIndexIdentity(context)))) !==
          header.index_sha256 ||
        canonicalSharedJson(headerBindings(context)) !== canonicalSharedJson(header.bindings) ||
        canonicalSharedJson(nativeMetadataForOwnership(context.state?.ownership)) !==
          canonicalSharedJson(header.before_metadata)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_INTENT_STALE",
            "Native metadata, exact header, mode or bindings changed after header preparation.",
          ),
        )
      yield* headerIntentReady(library, context, plan.observation)
    }
    let body: FrozenObservationBody
    if (header === undefined) body = yield* observeSharedBody(context.binding.page_id)
    else {
      const { raw_markdown, ...observed } = yield* readManagedFileBody(context.binding.page_id)
      if ((yield* sha256(raw_markdown)) !== header.raw_body_sha256)
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_INTENT_STALE",
            "The exact native body changed before the header event; no replacement body is permitted.",
          ),
        )
      body = observed
    }
    if (
      body.fingerprint.sha256 !== plan.observation.body.fingerprint.sha256 ||
      body.bytes !== plan.observation.body.bytes ||
      canonicalSharedJson(body.native_body_completion ?? null) !==
        canonicalSharedJson(plan.observation.body.native_body_completion ?? null)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_INTENT_STALE",
          "The complete observed body changed after takeover was prepared.",
        ),
      )
    return context
  })
}

/** Reuse the existing observation journal; no content update, selection or relation PATCH exists here. */
export function executeSharedFileTakeover(input: {
  readonly library: SharedLibrary
  readonly plan: unknown
  readonly mode: "create" | "reconcile"
}) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedFileTakeoverPlan(input.library, input.plan)
    const observation = plan.observation
    const operationId = observation.operation_id
    return yield* Effect.gen(function* () {
      const context = yield* readSharedFileIntentContext({
        library: input.library,
        skillPageId: observation.skill_page_id,
        path: plan.path,
        allowDisabledHeader: plan.main_header_input !== undefined,
      })
      if (
        context.index.skill_id !== plan.skill_id ||
        context.binding.file_id !== observation.file_id ||
        context.binding.page_id !== observation.page_id
      )
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_INTENT_STALE",
            "The original takeover belongs to another file identity.",
          ),
        )
      const journal = yield* sharedFileIntentJournal(input.library, context)
      const headers = yield* querySharedOperationIndex(input.library, observation.skill_page_id)
      const local = yield* pendingFileOperations(journal)
      const originalExists =
        headers.some((header) => header.record_id === operationId) ||
        local.some((entry) => entry.plan.operation_id === operationId)
      if (input.mode === "reconcile" || originalExists) {
        yield* reconcileSharedObservation(input.library, observation).pipe(withReadOnlyNotion)
      } else {
        const current = yield* currentForPlan(input.library, plan)
        yield* assertSharedFileIntentReady(input.library, current)
        if (
          current.state?.ownership.kind === "custom" &&
          current.state.ownership.content.sha256 === observation.body.fingerprint.sha256 &&
          canonicalSharedJson(nativeMetadataForOwnership(current.state.ownership)) ===
            canonicalSharedJson(nativeFileMetadata(observation.event.content))
        )
          return {
            status: "unchanged" as const,
            file_id: observation.file_id,
            body_writes: 0 as const,
            remote_writes: 0 as const,
            state: current.state,
          }
        yield* retainPendingFileOperation(journal, observation)
        yield* commitSharedObservationPlan(input.library, {
          mode: "create",
          plan: observation,
          beforeEventWrite: currentForPlan(input.library, plan).pipe(
            Effect.asVoid,
            withReadOnlyNotion,
          ),
        })
      }
      yield* (yield* Store).retireKeys([
        yield* pendingFileOperationKey(journal.prefix, observation),
      ])
      const verified = yield* readSharedFileIntentContext({
        library: input.library,
        skillPageId: observation.skill_page_id,
        path: plan.path,
        allowDisabledHeader: plan.main_header_input !== undefined,
      })
      const state = yield* fileIntentChecked(() =>
        resolveFileState(observation.file_id, verified.events),
      )
      if (!verified.events.some((event) => event.event_id === observation.event.event_id))
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_INTENT_UNKNOWN",
            "The original adoption event is not visible in the complete file history.",
          ),
        )
      return {
        status: "verified_applied" as const,
        plan_id: plan.plan_id,
        operation_id: operationId,
        file_id: observation.file_id,
        body_writes: 0 as const,
        state,
        original_observation: observation.body.fingerprint,
        requires_fresh_read: true as const,
      }
    }).pipe(
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          ...property(error.details),
          status:
            error.code === "WRITE_OUTCOME_UNKNOWN" || error.code === "SHARED_RECORD_UNRESOLVED"
              ? "unknown"
              : "blocked",
          plan_id: plan.plan_id,
          observation_operation_id: operationId,
          takeover_plan: plan,
          body_writes: 0,
        }),
      ),
    )
  })
}
