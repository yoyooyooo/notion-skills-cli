import { Clock, Effect, Schema } from "effect"
import {
  effectiveCachePolicy,
  invalidateSnapshotCache,
  publishSnapshotObservation,
  type ObservedSnapshot,
} from "./cache.ts"
import { importDocument } from "./import.ts"
import { decode, fail, SkillsError, SnapshotSchema, type Snapshot, type Source } from "./model.ts"
import { Notion } from "./notion.ts"
import { canonicalMain } from "./portable.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import {
  composeSharedFiles,
  type CompositionFile,
  type CompositionOverride,
} from "./shared-composition.ts"
import { loadRetainedBody, observeSharedFile } from "./shared-file-observer.ts"
import {
  planFileValidation,
  refreshMetadataObservation,
  type FileMetadataInput,
  type LocalFileObservation,
} from "./shared-file-observation.ts"
import {
  FileEventSchema,
  resolveFileState,
  type FileEvent,
  type ResolvedFileState,
} from "./shared-file-state.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  loadPendingSharedObservationPlans,
  type SharedObservationPlan,
} from "./shared-observation-operation.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import {
  loadPendingSharedBodyWrites,
  reconcileSharedBodyWrite,
  type SharedBodyWritePlan,
} from "./shared-body-write.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import {
  pendingFileOperations,
  pendingFileOperationKey,
  retainPendingFileOperation,
  sharedPendingObservationPrefix,
} from "./shared-pending-file-operations.ts"
export { sharedPendingObservationPrefix } from "./shared-pending-file-operations.ts"
import { querySharedSkillIndex, type SharedBodyBinding } from "./shared-skill-index.ts"
import {
  querySharedRouterMembers,
  renderSharedRouterMembers,
  type SharedRouterMember,
} from "./shared-router-members.ts"
import { sha256, Store } from "./store.ts"
import type { SharedAuthoringEvidence } from "./shared-authoring.ts"

export const SHARED_FULL_BODY_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_OBJECT_BYTES = 64 * 1024
const encoder = new TextEncoder()

const LocalFileObservationSchema = Schema.Struct({
  file_id: Schema.String,
  page_id: Schema.String,
  path: Schema.String,
  last_edited_time: Schema.String,
  management_revision: Schema.String,
  body_sha256: Schema.String,
  body_verified_at: Schema.Number,
  metadata_validated_at: Schema.Number,
})
const SharedObservationCacheSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String,
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  snapshot_id: Schema.String,
  observations: Schema.Array(LocalFileObservationSchema),
})
export type FixedSharedSource = {
  readonly source_id: string
  readonly revision: string
  /** Already resolved, selected immutable bytes. This builder never resolves a branch or downloads. */
  readonly files: readonly CompositionFile[]
}
export type OpenSharedSnapshotInput = {
  readonly library: SharedLibrary
  readonly target: string
  readonly rawPage?: unknown
  readonly scope: string
  readonly startedAt: number
  readonly forceFull?: boolean
  readonly fixedSource?: FixedSharedSource
  readonly routerMembers?: readonly SharedRouterMember[]
  /** Internal authoring preflight: never retain/adopt a newly observed body. */
  readonly readOnly?: boolean
}

function checked<A>(run: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "SHARED_SNAPSHOT_INVALID",
            error instanceof Error ? error.message : "Invalid shared snapshot input.",
          ),
  })
}

function objectSize(bytes: Uint8Array, path: string): void {
  if (bytes.byteLength > MAX_OBJECT_BYTES)
    throw fail(
      "SHARED_OBJECT_TOO_LARGE",
      "This shared snapshot path supports objects up to 64 KiB.",
      {
        path,
        bytes: bytes.byteLength,
        max_bytes: MAX_OBJECT_BYTES,
      },
    )
}

function loadFileObservations(
  prefix: string,
  input: {
    readonly scope: string
    readonly library_id: string
    readonly skill_id: string
  },
) {
  return Effect.gen(function* () {
    const store = yield* Store
    const keys = (yield* store.listKeys(prefix))
      .filter((key) => key.endsWith(".json"))
      .sort()
      .reverse()
    const key = keys[0]
    if (key === undefined) return [] satisfies LocalFileObservation[]
    const saved = yield* store.readJson(key, SharedObservationCacheSchema)
    if (saved === undefined) return [] satisfies LocalFileObservation[]
    if (
      saved.scope !== input.scope ||
      saved.library_id !== input.library_id ||
      saved.skill_id !== input.skill_id ||
      key !== `${prefix}/${String(saved.generation).padStart(20, "0")}.json`
    )
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "Shared file observations have a different scope or generation."),
      )
    return [...saved.observations]
  })
}

function fileRevision(
  binding: SharedBodyBinding,
  events: readonly FileEvent[],
  source:
    | {
        readonly path_hash: string
      }
    | undefined,
) {
  return sha256(
    canonicalSharedJson({
      version: 1,
      file_id: binding.file_id,
      page_id: binding.page_id,
      path: binding.path,
      events: [...events].sort((a, b) =>
        a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0,
      ),
      source: source === undefined ? null : { path_hash: source.path_hash },
    }),
  )
}

/**
 * Current shared-library consumer. Shared facts determine ownership on every invocation.
 * The caller owns zero-network TTL/pinned/offline fast paths; this invocation revalidates
 * the selected Skills row, Files membership and shared facts through batched metadata.
 */
export function openSharedSnapshot(input: OpenSharedSnapshotInput) {
  return Effect.gen(function* () {
    const store = yield* Store
    const api = yield* Notion
    const selected = yield* checked(() => {
      const id = pageId(input.target)
      if (!id || !input.scope || !Number.isFinite(input.startedAt) || input.startedAt < 0)
        throw fail(
          "INVALID_ARGUMENT",
          "Shared consumption requires an exact page, account scope and valid start time.",
        )
      return id
    })
    // Copy caller-owned source buffers before any asynchronous use.
    const sourceFiles = yield* checked(() =>
      (input.fixedSource?.files ?? []).map((file) => {
        if (!(file.bytes instanceof Uint8Array))
          throw fail("INVALID_SOURCE", "A fixed source must contain resolved bytes.")
        return { path: file.path, bytes: new Uint8Array(file.bytes) }
      }),
    )
    const raw =
      input.rawPage === undefined ? yield* api.request(`v1/pages/${selected}`) : input.rawPage
    const source: Source = {
      alias: input.library.library_id,
      database_id: input.library.skills.database_id,
      title: "",
      data_source_ids: [input.library.skills.data_source_id],
      role: "content",
      shared_library: input.library,
    }
    const record = yield* checked(() =>
      sharedRecordFromPage(raw, source, input.library.skills.data_source_id),
    )
    if (record.locator.page_id !== selected)
      return yield* Effect.fail(
        fail("SHARED_FILE_SCOPE", "The supplied Skill page differs from the selected target."),
      )
    if (!record.enabled)
      return yield* Effect.fail(
        fail("CONTENT_DISABLED", "The selected Skill is disabled in Notion.", { id: record.id }),
      )
    const routerMembers =
      record.kind === "router"
        ? (input.routerMembers ??
          (yield* querySharedRouterMembers(input.library, { router: record, rawPage: raw })))
        : undefined
    const frozenMembers = routerMembers?.map(({ id, ref, metadata }) => ({ id, ref, metadata }))
    const generation = yield* store.reserveCacheGeneration(input.scope, record.id)
    const index = yield* querySharedSkillIndex(input.library, selected, raw)
    if (index.skill_id !== record.locator.skill_id)
      return yield* Effect.fail(
        fail("SHARED_FILE_SCOPE", "Shared Skill identity changed during metadata decoding."),
      )
    if (index.source_reference !== (input.fixedSource?.source_id ?? ""))
      return yield* Effect.fail(
        fail(
          "SHARED_SOURCE_UNAVAILABLE",
          "Resolve the exact source selected in Notion before consumption; no current-body or Git fallback is allowed.",
          {
            source_id: index.source_reference,
          },
        ),
      )
    if (
      input.fixedSource !== undefined &&
      (!input.fixedSource.source_id || !input.fixedSource.revision)
    )
      return yield* Effect.fail(
        fail("INVALID_SOURCE", "A resolved source requires a fixed identity and revision."),
      )
    const bindings: readonly SharedBodyBinding[] = [index.main, ...index.files]
    const bindingById = new Map(bindings.map((file) => [file.file_id, file]))
    const sourceByPath = new Map<string, CompositionFile>()
    const sourceHashes = new Map<string, string>()
    for (const file of sourceFiles) {
      if (sourceByPath.has(file.path))
        return yield* Effect.fail(
          fail("COMPOSITION_SOURCE_COLLISION", "Fixed source paths must be unique.", {
            path: file.path,
          }),
        )
      sourceByPath.set(file.path, file)
      sourceHashes.set(file.path, yield* sha256(file.bytes))
    }
    const scopeIdentity = yield* sha256(
      canonicalSharedJson([input.scope, input.library.library_id, index.skill_id]),
    )
    // Pending intent is a replay barrier, not a discardable body cache or an ownership authority.
    const pendingScope = {
      prefix: yield* sharedPendingObservationPrefix(
        input.scope,
        input.library.library_id,
        index.skill_id,
      ),
      scope: input.scope,
      library_id: input.library.library_id,
      skill_id: index.skill_id,
      skill_page_id: selected,
    }
    const facts = yield* querySharedRecords(input.library, {
      skillPageId: selected,
      kind: "file_event",
    })
    const eventsByFile = new Map<string, FileEvent[]>()
    for (const fact of facts) {
      const event = yield* checked(() => decode(FileEventSchema, fact.payload))
      if (fact.record_id !== event.event_id || fact.entity_id !== event.file_id)
        return yield* Effect.fail(
          fail(
            "SHARED_STATE_SCOPE",
            "An event payload differs from its immutable record identity.",
          ),
        )
      if (!bindingById.has(event.file_id))
        return yield* Effect.fail(
          fail(
            "UNBOUND_FILE_STATE",
            "A shared file fact has no current binding; reconcile membership before creating a complete snapshot.",
            { file_id: event.file_id },
          ),
        )
      const events = eventsByFile.get(event.file_id) ?? []
      events.push(event)
      eventsByFile.set(event.file_id, events)
    }
    const allEvents = [...eventsByFile.values()].flat()
    const eventById = new Map(allEvents.map((event) => [event.event_id, event]))
    const plans = new Map<string, SharedObservationPlan>()
    const localPending = yield* pendingFileOperations(pendingScope)
    const operationHeaders = yield* querySharedOperationIndex(input.library, selected)
    const bodyWrites = new Map<string, SharedBodyWritePlan>()
    for (const entry of localPending) {
      if (entry.plan.kind === "body_write") {
        bodyWrites.set(entry.plan.operation_id, entry.plan)
        continue
      }
      const completed = eventById.get(entry.plan.event.event_id)
      if (completed !== undefined) {
        if (canonicalSharedJson(completed) !== canonicalSharedJson(entry.plan.event))
          return yield* Effect.fail(
            fail(
              "SHARED_RECORD_CONFLICT",
              "The shared event differs from the original pending observation.",
            ),
          )
        yield* store.retireKeys([entry.key])
      } else plans.set(entry.plan.operation_id, entry.plan)
    }
    for (const plan of yield* loadPendingSharedObservationPlans(input.library, {
      skillPageId: selected,
      events: allEvents,
      headers: operationHeaders,
    })) {
      const existing = plans.get(plan.operation_id)
      if (existing !== undefined && canonicalSharedJson(existing) !== canonicalSharedJson(plan))
        return yield* Effect.fail(
          fail("SHARED_RECORD_CONFLICT", "Shared and local frozen observation plans disagree."),
        )
      plans.set(plan.operation_id, plan)
    }
    for (const plan of yield* loadPendingSharedBodyWrites(input.library, {
      skillPageId: selected,
      events: allEvents,
      headers: operationHeaders,
    })) {
      const existing = bodyWrites.get(plan.operation_id)
      if (existing !== undefined && canonicalSharedJson(existing) !== canonicalSharedJson(plan))
        return yield* Effect.fail(
          fail("SHARED_RECORD_CONFLICT", "Shared and local original body-write plans disagree."),
        )
      bodyWrites.set(plan.operation_id, plan)
    }
    // Explicit system candidates must never be observed as natural user edits.
    // Completion requires the exact operation outcome, not a content event alone.
    for (const plan of bodyWrites.values()) {
      const binding = bindingById.get(plan.file_id)
      if (
        binding === undefined ||
        binding.page_id !== plan.page_id ||
        plan.skill_id !== index.skill_id
      )
        return yield* Effect.fail(
          fail(
            "UNBOUND_FILE_STATE",
            "The original pending body write no longer has its exact file binding.",
            { body_write_operation_id: plan.operation_id },
          ),
        )
      const result = yield* reconcileSharedBodyWrite(input.library, plan)
      yield* invalidateSnapshotCache(record.id, input.scope)
      const local = localPending.find((entry) => entry.plan.operation_id === plan.operation_id)
      if (local !== undefined) yield* store.retireKeys([local.key])
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_WRITE_RECONCILED",
          "The original body write is now verified. Read the current page again before publishing a new snapshot.",
          {
            body_write_operation_id: plan.operation_id,
            status: result.status,
            original_downloaded_at: plan.before.downloaded_at,
            read_again: true,
          },
        ),
      )
    }
    // Resolve old intent before consulting current bodies or publishing cached bytes.
    // Even an invisible first POST is fenced by the original local journal.
    for (const plan of plans.values()) {
      const binding = bindingById.get(plan.file_id)
      if (binding === undefined || binding.page_id !== plan.page_id)
        return yield* Effect.fail(
          fail(
            "UNBOUND_FILE_STATE",
            "A pending observation has no matching current file binding; preserve its original plan.",
            { operation_id: plan.operation_id },
          ),
        )
      const reconciled = yield* observeSharedFile({
        library: input.library,
        skillPageId: selected,
        fileId: binding.file_id,
        pageId: binding.page_id,
        events: eventsByFile.get(binding.file_id) ?? [],
        plans: [plan],
        bodyWrites: [],
        readOnly: input.readOnly,
      }).pipe(Effect.result)
      if (reconciled._tag === "Failure") {
        if (reconciled.failure.code === "SHARED_OBSERVATION_RECONCILED") {
          yield* invalidateSnapshotCache(record.id, input.scope)
          const local = localPending.find((entry) => entry.plan.operation_id === plan.operation_id)
          if (local !== undefined) yield* store.retireKeys([local.key])
        }
        return yield* Effect.fail(reconciled.failure)
      }
      return yield* Effect.fail(
        fail(
          "SHARED_OBSERVATION_UNRESOLVED",
          "The original observation must be reconciled before a new snapshot can be published.",
        ),
      )
    }
    const states = new Map<string, ResolvedFileState>()
    // Validate every graph and baseline before observing or adopting any body.
    for (const binding of bindings) {
      const events = eventsByFile.get(binding.file_id) ?? []
      if (events.length === 0) {
        if (index.source_reference || binding.baseline !== undefined)
          return yield* Effect.fail(
            fail(
              "BASELINE_MISSING",
              "Shared projected state is absent; reads cannot reconstruct a following fact from display metadata.",
              { file_id: binding.file_id },
            ),
          )
        continue
      }
      const state = yield* checked(() => resolveFileState(binding.file_id, events))
      if (state.ownership.kind === "following" && !sourceByPath.has(binding.path))
        return yield* Effect.fail(
          fail(
            "SHARED_SOURCE_FILE_MISSING",
            "A following file has no bytes in the exact selected source.",
            { file_id: binding.file_id, path: binding.path },
          ),
        )
      states.set(binding.file_id, state)
    }
    const prefix = `cache/shared-file-observations/${scopeIdentity}`
    const previous = yield* loadFileObservations(prefix, {
      scope: input.scope,
      library_id: input.library.library_id,
      skill_id: index.skill_id,
    })
    const missingMembership = previous.filter(
      (observation) => !bindingById.has(observation.file_id),
    )
    if (missingMembership.length > 0)
      return yield* Effect.fail(
        fail(
          "UNBOUND_FILE_STATE",
          "Previously observed file membership is missing; absence cannot authorize deleting it from a complete snapshot.",
          {
            files: missingMembership.map((file) => ({
              file_id: file.file_id,
              page_id: file.page_id,
              path: file.path,
            })),
            deletion_authorized: false,
          },
        ),
      )
    const activeBindings = bindings.filter(
      (file) => states.get(file.file_id)?.ownership.kind !== "tombstone",
    )
    const activeIds = new Set(activeBindings.map((file) => file.file_id))
    const observations = previous.filter((value) => activeIds.has(value.file_id))
    const cachedBodies = new Map<string, Uint8Array>()
    for (const observation of observations) {
      if (!/^[a-f0-9]{64}$/.test(observation.body_sha256))
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "Cached body has an invalid checksum identity."),
        )
      if (cachedBodies.has(observation.body_sha256)) continue
      const cached = yield* store
        .readBytes(`objects/${observation.body_sha256}`)
        .pipe(Effect.result)
      if (cached._tag === "Failure") {
        if (cached.failure.code === "SNAPSHOT_MISSING") continue
        return yield* Effect.fail(cached.failure)
      }
      if ((yield* sha256(cached.success)) !== observation.body_sha256)
        return yield* Effect.fail(
          fail(
            "STATE_CORRUPT",
            "A cached observed body failed checksum validation; it cannot establish ownership.",
          ),
        )
      cachedBodies.set(observation.body_sha256, cached.success)
    }
    const metadata: FileMetadataInput[] = []
    const sourceIdentity = (binding: SharedBodyBinding) => {
      if (
        input.fixedSource === undefined ||
        states.get(binding.file_id)?.ownership.kind !== "following"
      )
        return undefined
      const pathHash = sourceHashes.get(binding.path)
      return pathHash === undefined ? undefined : { path_hash: pathHash }
    }
    for (const binding of activeBindings)
      metadata.push({
        file_id: binding.file_id,
        page_id: binding.page_id,
        path: binding.path,
        last_edited_time: binding.last_edited_time,
        management_revision: yield* fileRevision(
          binding,
          eventsByFile.get(binding.file_id) ?? [],
          sourceIdentity(binding),
        ),
      })
    const metadataObservedAt = yield* Clock.currentTimeMillis
    const cachePolicy = yield* effectiveCachePolicy
    const plan = yield* checked(() =>
      planFileValidation({
        files: metadata,
        observations,
        now: metadataObservedAt,
        metadataTtlMs: cachePolicy.read_max_age_ms,
        fullBodyMaxAgeMs: SHARED_FULL_BODY_MAX_AGE_MS,
        forceFull: input.forceFull,
        availableObjectHashes: new Set(cachedBodies.keys()),
        membershipComplete: true,
      }),
    )
    const previousById = new Map(observations.map((value) => [value.file_id, value]))
    const nextObservations: LocalFileObservation[] = []
    const overrides: CompositionOverride[] = []
    let bodyReads = 0
    for (const item of plan.files) {
      const binding = bindingById.get(item.file.file_id)
      if (binding === undefined)
        return yield* Effect.fail(
          fail("SHARED_FILE_SCOPE", "Validation lost its exact file binding."),
        )
      let state = states.get(binding.file_id)
      let body: Uint8Array
      let next: LocalFileObservation
      // A following projection may not have retained Markdown. Re-observe current
      // presentation when that cache is absent; effective bytes still come from
      // the exact selected source. This is never a historical-pin recovery path.
      if (
        item.action === "body_read" ||
        (item.action === "recover_fixed" && state?.ownership.kind === "following")
      ) {
        const events = eventsByFile.get(binding.file_id) ?? []
        const observed = yield* observeSharedFile({
          library: input.library,
          skillPageId: selected,
          fileId: binding.file_id,
          pageId: binding.page_id,
          events,
          plans: [],
          bodyWrites: [],
          readOnly: input.readOnly,
          beforePlanWrite: (plan) => retainPendingFileOperation(pendingScope, plan),
          ...(events.length === 0 ? { initialNative: true } : {}),
        })
        bodyReads += 1
        state = observed.state
        states.set(binding.file_id, state)
        if (observed.changed) {
          eventsByFile.set(binding.file_id, [...events, observed.event])
          // Successful observation verified its shared event; local intent can now retire.
          yield* store.retireKeys([
            yield* pendingFileOperationKey(pendingScope.prefix, observed.operation),
          ])
        }
        body = encoder.encode(observed.body.markdown)
        yield* checked(() => objectSize(body, binding.path))
        yield* store.writeBytes(`objects/${observed.body.fingerprint.sha256}`, body)
        next = {
          ...item.file,
          management_revision: yield* fileRevision(
            binding,
            eventsByFile.get(binding.file_id) ?? [],
            sourceIdentity(binding),
          ),
          body_sha256: observed.body.fingerprint.sha256,
          body_verified_at: observed.body.downloaded_at,
          metadata_validated_at: metadataObservedAt,
        }
      } else {
        const observed = previousById.get(binding.file_id)
        if (observed === undefined)
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "A cached file has no validated observation."),
          )
        if (item.action === "recover_fixed") {
          if (
            state?.ownership.kind !== "custom" ||
            state.ownership.content.sha256 !== item.body_sha256
          )
            return yield* Effect.fail(
              fail(
                "RETAINED_BODY_MISSING",
                "The exact observed object is unavailable; a current body cannot replace a fixed cache identity.",
                { sha256: item.body_sha256 },
              ),
            )
          const retained = yield* loadRetainedBody(input.library, selected, state.ownership.content)
          body = encoder.encode(retained.markdown)
          yield* store.writeBytes(`objects/${item.body_sha256}`, body)
        } else {
          const bytes = cachedBodies.get(item.body_sha256)
          if (bytes === undefined)
            return yield* Effect.fail(
              fail("SNAPSHOT_MISSING", "The validated cached body became unavailable."),
            )
          body = bytes
        }
        next = yield* checked(() =>
          refreshMetadataObservation({
            file: item.file,
            observation: observed,
            now: metadataObservedAt,
          }),
        )
      }
      if (state === undefined)
        return yield* Effect.fail(
          fail("BASELINE_MISSING", "No shared ownership fact exists after body observation."),
        )
      nextObservations.push(next)
      switch (state.ownership.kind) {
        case "following":
          if (!sourceByPath.has(binding.path))
            return yield* Effect.fail(
              fail(
                "SHARED_SOURCE_FILE_MISSING",
                "Selected source no longer contains a following file.",
                { path: binding.path },
              ),
            )
          break
        case "custom":
          if (
            (yield* sha256(body)) !== state.ownership.content.sha256 ||
            body.byteLength !== state.ownership.content.bytes
          )
            return yield* Effect.fail(
              fail(
                "SHARED_BODY_CONFLICT",
                "Observed bytes differ from the selected shared custom version.",
              ),
            )
          overrides.push({
            kind: "custom",
            file_id: binding.file_id,
            path: binding.path,
            bytes: body,
          })
          break
        case "tombstone":
          overrides.push({ kind: "tombstone", file_id: binding.file_id, path: binding.path })
          break
      }
    }
    for (const binding of bindings)
      if (
        states.get(binding.file_id)?.ownership.kind === "tombstone" &&
        !activeIds.has(binding.file_id)
      )
        overrides.push({ kind: "tombstone", file_id: binding.file_id, path: binding.path })
    const composed = yield* checked(() =>
      composeSharedFiles({
        base: sourceFiles,
        mounts: [],
        overrides,
        entrypoint: record.entrypoint,
      }),
    )
    const completeFiles = yield* checked(() =>
      composed.files.map((file) => {
        if (file.path !== record.entrypoint) return file
        const document = importDocument(file, {
          name: record.name,
          description: record.description,
        })
        const body =
          document.body +
          (routerMembers === undefined ? "" : renderSharedRouterMembers(routerMembers))
        return canonicalMain(record.name, record.description, body, file)
      }),
    )
    const files: Snapshot["files"][number][] = []
    for (const file of completeFiles) {
      const hash = yield* sha256(file.bytes)
      yield* store.writeBytes(`objects/${hash}`, file.bytes)
      files.push({ path: file.path, bytes: file.bytes.length, sha256: hash })
    }
    const version = yield* sha256(
      canonicalSharedJson({
        version: 1,
        record,
        files,
        ...(frozenMembers === undefined ? {} : { router_members: frozenMembers }),
        source:
          input.fixedSource === undefined
            ? null
            : { source_id: input.fixedSource.source_id, revision: input.fixedSource.revision },
        ownership: [...bindings]
          .sort((a, b) => (a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0))
          .map((binding) => ({
            file_id: binding.file_id,
            path: binding.path,
            state: states.get(binding.file_id),
          })),
      }),
    )
    const snapshotId = `s_${yield* sha256(JSON.stringify([input.scope, record.id, version]))}`
    const saved = yield* store.readJson(`snapshots/${snapshotId}.json`, SnapshotSchema)
    const snapshot =
      saved ??
      (yield* checked(() =>
        decode(SnapshotSchema, {
          snapshot_id: snapshotId,
          scope: input.scope,
          record,
          entrypoint: record.entrypoint,
          version_id: version,
          created_at: metadataObservedAt,
          files,
          ...(frozenMembers === undefined ? {} : { router_members: frozenMembers }),
        }),
      ))
    if (
      snapshot.snapshot_id !== snapshotId ||
      snapshot.scope !== input.scope ||
      snapshot.record.id !== record.id ||
      snapshot.version_id !== version
    )
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "The immutable shared snapshot has a different identity."),
      )
    yield* store.writeJson(`snapshots/${snapshotId}.json`, snapshot)
    yield* store.writeJson(`${prefix}/${String(generation).padStart(20, "0")}.json`, {
      version: 1,
      scope: input.scope,
      library_id: input.library.library_id,
      skill_id: index.skill_id,
      skill_page_id: selected,
      generation,
      snapshot_id: snapshotId,
      observations: nextObservations,
    })
    const bodyValidUntil = Math.min(
      ...nextObservations.map((file) => file.body_verified_at + SHARED_FULL_BODY_MAX_AGE_MS),
    )
    if (!Number.isFinite(bodyValidUntil))
      return yield* Effect.fail(
        fail("SHARED_SNAPSHOT_INVALID", "A complete Skill requires a validated main body."),
      )
    const published: ObservedSnapshot = yield* publishSnapshotObservation(
      snapshot,
      input.startedAt,
      generation,
      {
        ...(bodyReads < activeBindings.length ? { metadataOnly: true } : {}),
        sharedBodyValidUntil: bodyValidUntil,
      },
    )
    const shared_authoring = yield* checked(
      () =>
        ({
          version: 1 as const,
          scope: input.scope,
          snapshot_id: snapshotId,
          library_id: input.library.library_id,
          skill_id: index.skill_id,
          skill_page_id: selected,
          source_id: index.source_reference,
          files: activeBindings.map((binding) => {
            const state = states.get(binding.file_id)
            const observation = nextObservations.find((value) => value.file_id === binding.file_id)
            if (state === undefined || observation === undefined)
              throw fail(
                "SHARED_SNAPSHOT_INVALID",
                "Fresh shared authoring evidence is missing an exact active file.",
              )
            return {
              file_id: binding.file_id,
              page_id: binding.page_id,
              path: binding.path,
              heads: state.heads,
              body_sha256: observation.body_sha256,
            }
          }),
        }) satisfies SharedAuthoringEvidence,
    )
    return { ...published, shared_authoring }
  })
}
