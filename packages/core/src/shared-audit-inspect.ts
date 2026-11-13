import { Clock, Effect, Option, Schema } from "effect"
import { decode, fail, property, SkillsError, type Source } from "./model.ts"
import { Notion } from "./notion.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import { sharedMarkdownReferences } from "./shared-file-references.ts"
import {
  FileEventSchema,
  resolveFileState,
  type FileEvent,
  type ResolvedFileState,
} from "./shared-file-state.ts"
import { planSharedFilePlacements } from "./shared-file-placement.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  compileSharedNativeReferences,
  type NativeReferenceSource,
} from "./shared-native-references.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import { querySharedRecords } from "./shared-records.ts"
import { describeSharedResourceFile } from "./shared-resource-state-model.ts"
import {
  isResourceFollowing,
  resourceContentForOwnership,
  loadSharedResourceContent,
} from "./shared-resource-content.ts"
import {
  planSelectedSharedSource,
  resolveSelectedSharedSourceReference,
  type PlannedSharedSource,
} from "./shared-selected-source.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { readSharedFileSourceContext } from "./shared-file-source-context.ts"
import { fileRecord, type FileRecord } from "./skill-file-index.ts"
import { sha256, Store } from "./store.ts"
import { loadPendingSharedObservationPlans } from "./shared-observation-operation.ts"
import { loadPendingSharedBodyWrites } from "./shared-body-write.ts"
import { loadPendingSharedMetadataWrites } from "./shared-metadata-write.ts"
import { loadPendingSharedFileManagement } from "./shared-file-management.ts"
import { loadPendingSharedResourceAuthoring } from "./shared-resource-authoring-recovery.ts"
import { resourceAuthoringOutcomesEntity } from "./shared-resource-authoring-model.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import { loadPendingSharedCreates } from "./shared-create.ts"
import { loadPendingSharedSkillApplies } from "./shared-skill-apply.ts"
import {
  sharedSkillApplyPlansEntity,
  sharedSkillApplyOutcomesEntity,
} from "./shared-skill-apply-model.ts"
import { loadPendingSharedRepairs } from "./shared-native-repair.ts"
import { nativeRepairEntity } from "./shared-native-repair-model.ts"
import { sharedCreateManifestEntity, sharedCreateOutcomesEntity } from "./shared-create-model.ts"
import { sharedMetadataEntity } from "./shared-metadata-write-model.ts"
import {
  auditCoverage,
  auditFinding,
  type AuditDepth,
  type AuditFinding,
  type AuditInventory,
  type AuditItem,
  type AuditTreeFile,
} from "./shared-audit-model.ts"
import {
  auditFailureCoverage,
  auditField,
  auditRelationIds,
  auditRich,
  auditRowId,
  auditSkillSignature,
  inspectAuditDraft,
  isAuditPause,
  validBusinessId,
} from "./shared-audit-inventory.ts"
import { auditRetainedHistory } from "./shared-audit-history.ts"
import { AuditEvidence } from "./shared-audit-evidence.ts"

const EvidenceErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.Unknown,
})
const SourceBytesEvidenceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    source_id: Schema.String,
    path: Schema.String,
    error: EvidenceErrorSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("available"),
    source_id: Schema.String,
    path: Schema.String,
    sha256: Schema.String,
    bytes: Schema.Number,
    remote_status: Schema.Literals(["verified", "cached_available", "unobserved", "unavailable"]),
    local: Schema.Boolean,
    remote_error: Schema.NullOr(EvidenceErrorSchema),
  }),
])

const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("AUDIT_OBJECT_INVALID", "The audit object cannot be decoded."),
  })

export function inspectAuditSkill(
  library: SharedLibrary,
  input: {
    readonly page_id: string
    readonly inventory: AuditInventory
    readonly depth: AuditDepth
    readonly pin_id?: string
    readonly observed_from: number
  },
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const store = yield* Store
    const evidence = Option.getOrUndefined(yield* Effect.serviceOption(AuditEvidence))
    const scope_key = `skill:${input.page_id}`
    const findings: AuditFinding[] = []
    const add = (
      code: string,
      object: string,
      location: string,
      message: string,
      evidence: unknown,
      coverage: AuditFinding["coverage"] = "full",
      severity: AuditFinding["severity"] = "error",
    ) =>
      findings.push(
        auditFinding({
          code,
          object_id: object,
          scope_key,
          location,
          message,
          evidence,
          coverage,
          severity,
        }),
      )
    const unavailable = (code: string, object: string, location: string, error: SkillsError) =>
      Effect.gen(function* () {
        if (isAuditPause(error)) return yield* Effect.fail(error)
        add(
          code,
          object,
          location,
          error.message,
          { code: error.code, details: error.details ?? null },
          auditFailureCoverage(error),
          "warning",
        )
      })
    const supplied = input.inventory.skills.find((row) => auditRowId(row) === input.page_id)
    const loaded =
      supplied !== undefined
        ? { _tag: "Success" as const, success: supplied }
        : yield* api.request(`v1/pages/${input.page_id}`).pipe(Effect.result)
    if (loaded._tag === "Failure") {
      if (isAuditPause(loaded.failure)) return yield* Effect.fail(loaded.failure)
      add(
        "TARGET_PAGE_UNAVAILABLE",
        input.page_id,
        "target",
        loaded.failure.message,
        { code: loaded.failure.code, details: loaded.failure.details ?? null },
        auditFailureCoverage(loaded.failure),
        "warning",
      )
      return {
        scope_key,
        page_id: input.page_id,
        skill_id: null,
        signature: yield* auditSkillSignature(library, input.inventory, input.page_id),
        checked_at: yield* Clock.currentTimeMillis,
        observed_from: input.observed_from,
        coverage: auditCoverage(findings.map((finding) => finding.coverage)),
        findings,
        tree: [],
        history: [],
        requires: [],
        state: { tree: "unobserved", adoption: "not_evaluated" },
        reused_from: null,
      } satisfies AuditItem
    }
    const raw = loaded.success
    const draft = yield* checked(() => inspectAuditDraft(library, input.inventory, raw))
    if (draft) {
      findings.push(...draft.findings)
      if (input.depth !== "metadata")
        add(
          "UNREGISTERED_CONTENT_UNVERIFIED",
          input.page_id,
          input.depth,
          "A draft has no registered file tree. Content and retained-history verification remain unobserved.",
          { depth: input.depth, adoption: "not_evaluated" },
          "partial",
          "warning",
        )
      return {
        scope_key,
        page_id: input.page_id,
        skill_id: null,
        signature: yield* auditSkillSignature(library, input.inventory, input.page_id),
        checked_at: yield* Clock.currentTimeMillis,
        observed_from: input.observed_from,
        coverage: auditCoverage(findings.map((finding) => finding.coverage)),
        findings,
        tree: [],
        history: [],
        requires: auditRelationIds(raw, library.skills, "Requires"),
        state: draft.state,
        reused_from: null,
      } satisfies AuditItem
    }
    try {
      const main = auditRich(raw, library.skills, "Main File ID")
      if (!validBusinessId(main))
        add(
          "MAIN_FILE_ID_INVALID",
          input.page_id,
          "Main File ID",
          "The main body has no stable File identity.",
          { value: main },
          "full",
          "error",
        )
    } catch (error) {
      add(
        "MAIN_FILE_ID_INVALID",
        input.page_id,
        "Main File ID",
        "The main file identity could not be read before the file tree was constructed.",
        { code: error instanceof SkillsError ? error.code : "INVALID_RESPONSE" },
        "partial",
        "warning",
      )
    }
    const files: FileRecord[] = []
    for (const row of input.inventory.files.filter((row) =>
      auditRelationIds(row, library.files, "Skill").includes(input.page_id),
    )) {
      const parsed = yield* checked(() =>
        fileRecord(row, input.page_id, library.files.data_source_id, library.files.property_ids),
      ).pipe(Effect.result)
      if (parsed._tag === "Success") files.push(parsed.success)
      else
        yield* unavailable(
          "FILE_METADATA_INVALID",
          auditRowId(row),
          auditRich(row, library.files, "Path"),
          parsed.failure,
        )
    }
    const indexed = yield* querySharedSkillIndex(library, input.page_id, raw, files).pipe(
      Effect.result,
    )
    if (indexed._tag === "Failure") {
      if (isAuditPause(indexed.failure)) return yield* Effect.fail(indexed.failure)
      add(
        "SKILL_TREE_UNAVAILABLE",
        input.page_id,
        "skill",
        "The file tree was not constructed. The main-file identity finding above still stands.",
        { code: indexed.failure.code, details: indexed.failure.details ?? null },
        "partial",
        "warning",
      )
      return {
        scope_key,
        page_id: input.page_id,
        skill_id: null,
        signature: yield* auditSkillSignature(library, input.inventory, input.page_id),
        checked_at: yield* Clock.currentTimeMillis,
        observed_from: input.observed_from,
        coverage: auditCoverage(findings.map((finding) => finding.coverage)),
        findings,
        tree: [],
        history: [],
        requires: auditRelationIds(raw, library.skills, "Requires"),
        state: { tree: "unobserved", adoption: "not_evaluated" },
        reused_from: null,
      } satisfies AuditItem
    }
    const index = indexed.success
    const sourceContext = yield* readSharedFileSourceContext(library, input.page_id, raw).pipe(
      Effect.result,
    )
    if (sourceContext._tag === "Failure")
      yield* unavailable(
        "SOURCE_BINDING_UNAVAILABLE",
        input.page_id,
        "Origin",
        sourceContext.failure,
      )
    const headers = input.inventory.records.filter((row) =>
      auditRelationIds(row, library.records, "Skill").includes(input.page_id),
    )
    const eventHeaders = headers.filter(
      (row) => property(auditField(row, library.records, "Kind").select).name === "file_event",
    )
    const events: FileEvent[] = []
    const blockedBodies = new Set<string>()
    const facts = yield* querySharedRecords(library, {
      skillPageId: input.page_id,
      kind: "file_event",
    }).pipe(Effect.result)
    const decodeEvents = (
      rows: readonly { record_id: string; entity_id: string; payload: unknown; page_id: string }[],
    ) =>
      Effect.gen(function* () {
        for (const fact of rows) {
          try {
            const event = decode(FileEventSchema, fact.payload)
            if (event.event_id !== fact.record_id || event.file_id !== fact.entity_id)
              throw fail("SHARED_STATE_SCOPE", "File-event and record identities disagree.")
            events.push(event)
          } catch (error) {
            blockedBodies.add(fact.entity_id)
            yield* unavailable(
              "FILE_EVENT_INVALID",
              fact.page_id,
              fact.record_id,
              error instanceof SkillsError
                ? error
                : fail("FILE_EVENT_INVALID", "Invalid file event."),
            )
          }
        }
      })
    if (facts._tag === "Success") yield* decodeEvents(facts.success)
    else {
      if (isAuditPause(facts.failure)) return yield* Effect.fail(facts.failure)
      // One malformed fact must not hide unrelated physical records.
      for (const header of eventHeaders) {
        const recordId = auditRich(header, library.records, "Record ID")
        const result = yield* querySharedRecords(library, {
          skillPageId: input.page_id,
          kind: "file_event",
          recordId,
        }).pipe(Effect.result)
        if (result._tag === "Success") yield* decodeEvents(result.success)
        else {
          blockedBodies.add(auditRich(header, library.records, "Entity ID"))
          yield* unavailable("FILE_EVENT_UNAVAILABLE", auditRowId(header), recordId, result.failure)
        }
      }
      if (!eventHeaders.length)
        yield* unavailable("FILE_STATE_UNOBSERVED", input.page_id, "file_event", facts.failure)
    }
    const bindings = [index.main, ...index.files]
    const states = new Map<string, ResolvedFileState>()
    for (const binding of bindings) {
      const ownEvents = events.filter((event) => event.file_id === binding.file_id)
      if (ownEvents.length === 0) {
        add(
          "OWNERSHIP_UNRECORDED",
          binding.file_id,
          binding.path,
          "No shared file-state facts establish ownership.",
          { page_id: binding.page_id },
          "partial",
          "warning",
        )
        continue
      }
      const resolved = yield* checked(() => resolveFileState(binding.file_id, ownEvents)).pipe(
        Effect.result,
      )
      if (resolved._tag === "Success") states.set(binding.file_id, resolved.success)
      else {
        blockedBodies.add(binding.file_id)
        yield* unavailable("FILE_STATE_CONFLICT", binding.file_id, binding.path, resolved.failure)
      }
    }
    const bound = new Set(bindings.map((binding) => binding.file_id))
    for (const id of new Set(events.map((event) => event.file_id)))
      if (!bound.has(id)) {
        const resolved = yield* checked(() =>
          resolveFileState(
            id,
            events.filter((event) => event.file_id === id),
          ),
        ).pipe(Effect.result)
        if (resolved._tag === "Success" && resolved.success.ownership.kind === "tombstone")
          states.set(id, resolved.success)
        else
          add(
            "ACTIVE_FILE_BINDING_UNOBSERVED",
            id,
            "file_event",
            "An active file-state identity has no current native binding; no deletion is inferred.",
            {
              event_ids: events
                .filter((event) => event.file_id === id)
                .map((event) => event.event_id),
            },
            "partial",
            "warning",
          )
      }
    const selected =
      index.source_reference === ""
        ? undefined
        : yield* resolveSelectedSharedSourceReference(library, {
            skillPageId: input.page_id,
            sourceId: index.source_reference,
          }).pipe(Effect.result)
    if (selected?._tag === "Failure")
      yield* unavailable(
        "SELECTED_SOURCE_UNAVAILABLE",
        index.source_reference,
        "Source",
        selected.failure,
      )
    const sourcePaths = selected?._tag === "Success" ? selected.success.paths : []
    const placement = yield* checked(() =>
      planSharedFilePlacements({
        source: sourcePaths.map((path) => ({ path })),
        overrides: bindings.flatMap((binding) => {
          const state = states.get(binding.file_id)
          return state?.ownership.kind === "following"
            ? []
            : [
                {
                  kind:
                    state?.ownership.kind === "tombstone"
                      ? ("tombstone" as const)
                      : ("custom" as const),
                  file_id: binding.file_id,
                  path: binding.path,
                },
              ]
        }),
        bindings: bindings.flatMap((binding) => {
          const state = states.get(binding.file_id)
          return state === undefined
            ? []
            : [{ file_id: binding.file_id, path: binding.path, state }]
        }),
        entrypoint: index.main.path,
      }),
    ).pipe(Effect.result)
    if (placement._tag === "Failure")
      yield* unavailable("FILE_TREE_CONFLICT", input.page_id, "files", placement.failure)
    const paths =
      placement._tag === "Success"
        ? placement.success.paths
        : [...new Set([...sourcePaths, ...bindings.map((binding) => binding.path)])].sort()
    const tree = new Map<string, AuditTreeFile>()
    for (const path of paths) {
      const binding = bindings.find((binding) => binding.path === path)
      const origin =
        placement._tag === "Success" ? placement.success.provenance.get(path) : undefined
      tree.set(path, {
        path,
        file_id: binding?.file_id ?? null,
        page_id: binding?.page_id ?? null,
        origin:
          origin?.kind === "custom" || !sourcePaths.includes(path) ? "native" : "fixed_source",
        bytes: null,
        sha256: null,
        byte_status: "unobserved",
        remote_status: "unobserved",
        cached_available: null,
        ownership:
          binding === undefined
            ? { kind: "fixed_source", source_id: index.source_reference }
            : (states.get(binding.file_id)?.ownership ?? { kind: "unknown" }),
      })
    }
    const descriptions: unknown[] = []
    const native: NativeReferenceSource[] = []
    const content = new Map<string, string>()
    if (input.depth !== "metadata")
      for (const binding of bindings) {
        if (blockedBodies.has(binding.file_id)) continue
        const state = states.get(binding.file_id)
        if (state?.ownership.kind === "tombstone") continue
        const resourceContent =
          state === undefined ? undefined : resourceContentForOwnership(state.ownership)
        if (resourceContent !== undefined) {
          const following = state !== undefined && isResourceFollowing(state.ownership)
          const resource = yield* loadSharedResourceContent(library, {
            skillPageId: input.page_id,
            content: resourceContent,
          }).pipe(Effect.result)
          const entry = tree.get(binding.path)
          if (resource._tag === "Failure") {
            yield* unavailable(
              following ? "RESOURCE_BASELINE_UNAVAILABLE" : "RESOURCE_BYTES_UNAVAILABLE",
              binding.file_id,
              binding.path,
              resource.failure,
            )
            if (entry && !following)
              tree.set(binding.path, {
                ...entry,
                origin: "resource",
                byte_status: "unavailable",
                remote_status: "unavailable",
              })
          } else if (entry && !following) {
            yield* store.writeBytes(
              `objects/${resource.success.content.sha256}`,
              resource.success.bytes,
            )
            tree.set(binding.path, {
              ...entry,
              origin: "resource",
              byte_status: "verified",
              remote_status: "verified",
              bytes: resource.success.content.bytes,
              sha256: resource.success.content.sha256,
            })
            if (/\.(?:md|markdown)$/iu.test(binding.path)) {
              const decoded = yield* checked(() =>
                new TextDecoder("utf-8", { fatal: true }).decode(resource.success.bytes),
              ).pipe(Effect.result)
              if (decoded._tag === "Success") content.set(binding.path, decoded.success)
              else
                yield* unavailable(
                  "REFERENCE_TEXT_INVALID",
                  binding.file_id,
                  binding.path,
                  decoded.failure,
                )
            }
          }
          descriptions.push({
            file_id: binding.file_id,
            page_id: binding.page_id,
            path: binding.path,
            ownership: state?.ownership ?? { kind: "unknown" },
            observation: "native_body_not_applicable",
            recorded_resource: resourceContent,
            recorded_resource_verification:
              resource._tag === "Success" ? "remote_verified" : "unavailable",
          })
          continue
        }
        const observed = yield* observeSharedBody(binding.page_id).pipe(Effect.result)
        if (observed._tag === "Failure") {
          yield* unavailable(
            "CURRENT_BODY_UNAVAILABLE",
            binding.file_id,
            binding.path,
            observed.failure,
          )
          const entry = tree.get(binding.path)
          if (entry)
            tree.set(binding.path, {
              ...entry,
              byte_status: "unavailable",
              remote_status: "unavailable",
            })
          continue
        }
        const receipt = yield* evidence?.read(
          `v1/pages/${binding.page_id}/markdown?markdown_version=v2`,
        ) ?? Effect.succeed(undefined)
        const observedBody = {
          ...observed.success,
          downloaded_at: receipt?.observed_at ?? observed.success.downloaded_at,
        }
        yield* store.writeBytes(
          `objects/${observedBody.fingerprint.sha256}`,
          new TextEncoder().encode(observedBody.markdown),
        )
        const description = yield* checked(() =>
          describeSharedResourceFile({
            binding,
            events: events.filter((event) => event.file_id === binding.file_id),
            selectedRevision: selected?._tag === "Success" ? selected.success.revision : null,
            observation: { kind: "observed", body: observedBody },
          }),
        ).pipe(Effect.result)
        if (description._tag === "Success") {
          descriptions.push(description.success)
          if (
            description.success.display.observation.kind === "observed" &&
            description.success.display.observation.ownership_comparison ===
              "requires_observation_commit"
          )
            add(
              "REQUIRES_OBSERVATION_COMMIT",
              binding.file_id,
              binding.path,
              "The current body differs from its recorded owner. Audit did not adopt the edit.",
              { fingerprint: observed.success.fingerprint, ownership: state?.ownership ?? null },
              "partial",
              "warning",
            )
        } else
          yield* unavailable(
            "FILE_STATE_CONFLICT",
            binding.file_id,
            binding.path,
            description.failure,
          )
        native.push({
          path: binding.path,
          page_id: binding.page_id,
          markdown: observed.success.markdown,
          body_sha256: observed.success.fingerprint.sha256,
          ...(observed.success.native_body_completion
            ? { native_body_completion: observed.success.native_body_completion }
            : {}),
        })
        const entry = tree.get(binding.path)
        if (entry?.origin === "native") {
          content.set(binding.path, observed.success.markdown)
          tree.set(binding.path, {
            ...entry,
            byte_status: "verified",
            remote_status: "verified",
            sha256: observed.success.fingerprint.sha256,
            bytes: observed.success.bytes,
          })
        }
      }
    let planned: PlannedSharedSource | undefined
    if (input.depth !== "metadata" && selected?._tag === "Success") {
      const result = yield* planSelectedSharedSource(
        library,
        input.page_id,
        index.source_reference,
      ).pipe(Effect.result)
      if (result._tag === "Success") planned = result.success
      else
        yield* unavailable(
          "SOURCE_CONTENT_UNAVAILABLE",
          index.source_reference,
          "Source",
          result.failure,
        )
    }
    if (planned !== undefined)
      for (const entry of tree.values()) {
        if (entry.origin !== "fixed_source") continue
        const provenance =
          placement._tag === "Success" ? placement.success.provenance.get(entry.path) : undefined
        const path = provenance?.kind === "base" ? provenance.source_path : entry.path
        const proofPath = `audit-source-bytes:${index.source_reference}:${path}`
        const previous = yield* evidence?.read(proofPath) ?? Effect.succeed(undefined)
        const proof =
          previous === undefined
            ? undefined
            : yield* checked(() => decode(SourceBytesEvidenceSchema, previous.value))
        if (
          proof !== undefined &&
          (proof.source_id !== index.source_reference || proof.path !== path)
        )
          return yield* Effect.fail(
            fail(
              "AUDIT_CHECKPOINT_CORRUPT",
              "The confirmed source evidence belongs to another immutable file.",
            ),
          )
        if (proof?.kind === "unavailable") {
          yield* unavailable(
            "SOURCE_CONTENT_UNAVAILABLE",
            index.source_reference,
            entry.path,
            fail(proof.error.code, proof.error.message, proof.error.details),
          )
          tree.set(entry.path, {
            ...entry,
            byte_status: "unavailable",
            remote_status: "unavailable",
          })
          continue
        }
        const remembered =
          proof?.kind === "available"
            ? yield* store.readBytes(`objects/${proof.sha256}`).pipe(Effect.result)
            : undefined
        const usable =
          remembered?._tag === "Success" &&
          proof?.kind === "available" &&
          remembered.success.length === proof.bytes &&
          (yield* sha256(remembered.success)) === proof.sha256
        const before = api.requestMetrics?.().total_requests
        // A history check explicitly bypasses derived byte-cache reads. Existing
        // materializers still validate all fixed identities and write only their
        // normal local immutable cache; audit does not repair or delete it.
        const remoteStore: Store["Service"] = {
          ...store,
          readJson: (key, schema) =>
            key.startsWith("cache/") ? Effect.succeed(undefined) : store.readJson(key, schema),
          readBytes: (key) =>
            key.startsWith("objects/")
              ? Effect.fail(fail("SNAPSHOT_MISSING", "Explicit remote recovery observation."))
              : store.readBytes(key),
        }
        const loaded =
          usable && remembered?._tag === "Success" && proof?.kind === "available"
            ? {
                _tag: "Success" as const,
                success: {
                  files: [{ path, bytes: remembered.success }],
                  local_paths: proof.local ? [path] : [],
                },
              }
            : yield* planned.materialize([path]).pipe(Effect.result)
        if (loaded._tag === "Failure") {
          yield* unavailable(
            "SOURCE_CONTENT_UNAVAILABLE",
            index.source_reference,
            entry.path,
            loaded.failure,
          )
          if (evidence !== undefined)
            yield* evidence.save(proofPath, {
              kind: "unavailable",
              source_id: index.source_reference,
              path,
              error: {
                code: loaded.failure.code,
                message: loaded.failure.message,
                details: loaded.failure.details ?? null,
              },
            })
          tree.set(entry.path, {
            ...entry,
            byte_status: "unavailable",
            remote_status: "unavailable",
          })
          continue
        }
        const file = loaded.success.files.find((file) => file.path === path)
        if (!file) {
          add(
            "SOURCE_FILE_MISSING",
            index.source_reference,
            entry.path,
            "The immutable manifest member did not produce its exact bytes.",
            { source_path: path },
            "partial",
          )
          continue
        }
        const hash = yield* sha256(file.bytes)
        const cached_available =
          usable || (before !== undefined && api.requestMetrics?.().total_requests === before)
        let remote_status: AuditTreeFile["remote_status"] =
          usable && proof?.kind === "available"
            ? proof.remote_status
            : loaded.success.local_paths.includes(path)
              ? "unobserved"
              : cached_available
                ? "cached_available"
                : "verified"
        let remote_error = usable && proof?.kind === "available" ? proof.remote_error : null
        if (
          input.depth === "history" &&
          !usable &&
          !loaded.success.local_paths.includes(path) &&
          remote_status === "cached_available"
        ) {
          const remote = yield* planned
            .materialize([path])
            .pipe(Effect.provideService(Store, remoteStore), Effect.result)
          if (remote._tag === "Failure") {
            yield* unavailable(
              "SOURCE_REMOTE_UNAVAILABLE",
              index.source_reference,
              entry.path,
              remote.failure,
            )
            remote_status = "unavailable"
            remote_error = {
              code: remote.failure.code,
              message: remote.failure.message,
              details: remote.failure.details ?? null,
            }
          } else remote_status = "verified"
        } else if (remote_error !== null) {
          yield* unavailable(
            "SOURCE_REMOTE_UNAVAILABLE",
            index.source_reference,
            entry.path,
            fail(remote_error.code, remote_error.message, remote_error.details),
          )
        }
        yield* store.writeBytes(`objects/${hash}`, file.bytes)
        if (evidence !== undefined && !usable)
          yield* evidence.save(proofPath, {
            kind: "available",
            source_id: index.source_reference,
            path,
            sha256: hash,
            bytes: file.bytes.length,
            remote_status,
            local: loaded.success.local_paths.includes(path),
            remote_error,
          })
        tree.set(entry.path, {
          ...entry,
          byte_status: "verified",
          remote_status,
          cached_available,
          sha256: hash,
          bytes: file.bytes.length,
        })
        if (input.depth === "history" && remote_status !== "verified")
          add(
            "SOURCE_REMOTE_RECOVERY_UNVERIFIED",
            index.source_reference,
            entry.path,
            "Local bytes do not establish remote recoverability for this exact source member.",
            { source_path: path, remote_status },
            "partial",
            "warning",
          )
        if (/\.(?:md|markdown)$/iu.test(entry.path)) {
          const decoded = yield* checked(() =>
            new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
          ).pipe(Effect.result)
          if (decoded._tag === "Success") content.set(entry.path, decoded.success)
          else
            yield* unavailable(
              "REFERENCE_TEXT_INVALID",
              index.source_reference,
              entry.path,
              decoded.failure,
            )
        }
      }
    // Current native observations and fixed effective files are separate inputs;
    // neither silently replaces an unavailable retained version.
    const referenceBodies = [
      ...content.entries(),
      ...native.map((file) => [file.path, file.markdown] as const),
    ]
    for (const [path, markdown] of referenceBodies) {
      const references = yield* checked(() => sharedMarkdownReferences(path, markdown)).pipe(
        Effect.result,
      )
      if (references._tag === "Failure") {
        yield* unavailable("REFERENCE_INVALID", input.page_id, path, references.failure)
        continue
      }
      for (const reference of references.success)
        if (!tree.has(reference.target))
          add(
            "REFERENCE_TARGET_MISSING",
            input.page_id,
            `${path}:${reference.line}:${reference.href}`,
            "An explicit local Markdown reference is absent from the complete effective file tree.",
            reference,
            selected?._tag === "Failure" || placement._tag === "Failure" ? "partial" : "full",
          )
    }
    if (native.length) {
      const source: Source = {
        alias: library.library_id,
        title: "",
        role: "content",
        database_id: library.skills.database_id,
        data_source_ids: [library.skills.data_source_id],
        shared_library: library,
      }
      const references = yield* checked(() =>
        sharedRecordFromPage(raw, source, library.skills.data_source_id),
      ).pipe(
        Effect.flatMap((record) =>
          compileSharedNativeReferences({
            library,
            record,
            files: native,
            bindings,
            relations: {
              requires: auditRelationIds(raw, library.skills, "Requires"),
              members: auditRelationIds(raw, library.skills, "Members"),
            },
            inventory: {
              skills: {
                data_source_id: library.skills.data_source_id,
                complete:
                  input.inventory.scope?.kind !== "reachable" &&
                  input.inventory.complete.includes("skills"),
                pages: input.inventory.skills,
              },
              files: {
                data_source_id: library.files.data_source_id,
                complete:
                  input.inventory.scope?.kind !== "reachable" &&
                  input.inventory.complete.includes("files"),
                pages: input.inventory.files,
              },
            },
          }),
        ),
        Effect.result,
      )
      if (references._tag === "Failure")
        yield* unavailable(
          "NATIVE_REFERENCE_UNVERIFIED",
          input.page_id,
          "references",
          references.failure,
        )
      else
        for (const reference of references.success.index?.unresolved ?? []) {
          const target = yield* api.request(`v1/pages/${reference.page_id}`).pipe(Effect.result)
          if (target._tag === "Failure")
            yield* unavailable(
              "NATIVE_REFERENCE_UNAVAILABLE",
              reference.page_id,
              `${reference.from}:${reference.href}`,
              target.failure,
            )
          else {
            const row = property(target.success)
            const parent = property(row.parent).data_source_id
            const inLibrary =
              parent === library.skills.data_source_id || parent === library.files.data_source_id
            const trashed = row.in_trash === true || row.archived === true
            const censusComplete =
              input.inventory.scope?.kind !== "reachable" &&
              input.inventory.complete.includes("skills") &&
              input.inventory.complete.includes("files")
            add(
              trashed
                ? "NATIVE_REFERENCE_TRASHED"
                : !inLibrary
                  ? "NATIVE_REFERENCE_OUTSIDE_LIBRARY"
                  : censusComplete
                    ? "NATIVE_REFERENCE_CENSUS_MISMATCH"
                    : "NATIVE_REFERENCE_UNREACHED_IN_LIBRARY",
              reference.page_id,
              `${reference.from}:${reference.href}`,
              trashed
                ? "The explicit native target is in trash."
                : !inLibrary
                  ? "The explicit native target is not an available managed identity in this exact library."
                  : "The native target is in this library but outside the completed observation. Deletion is not established.",
              { parent: row.parent, in_trash: row.in_trash ?? false },
              trashed || !inLibrary ? "full" : "partial",
              trashed || !inLibrary ? "error" : "warning",
            )
          }
        }
    }
    const operations = yield* querySharedOperationIndex(library, input.page_id)
    const pending: Array<{ operation_id: string; plan: unknown }> = []
    const completedEvents = new Set(events.map((event) => event.event_id))
    const unclassified = operations.filter(
      (header) =>
        !header.record_id.startsWith("observe-") &&
        !header.record_id.startsWith("body-write-") &&
        !header.record_id.startsWith("file-management-") &&
        !header.record_id.startsWith("resource-authoring-") &&
        !header.record_id.startsWith("outcome-") &&
        header.entity_id !== sharedMetadataEntity &&
        header.entity_id !== resourceAuthoringOutcomesEntity &&
        header.entity_id !== sharedSkillApplyPlansEntity &&
        header.entity_id !== sharedSkillApplyOutcomesEntity &&
        header.entity_id !== nativeRepairEntity &&
        header.entity_id !== sharedCreateManifestEntity &&
        header.entity_id !== sharedCreateOutcomesEntity,
    )
    for (const operation of unclassified)
      add(
        "OPERATION_OUTCOME_UNOBSERVED",
        operation.record_id,
        "operations",
        "This original operation family has not established a resolved outcome in the audit.",
        operation,
        "partial",
        "warning",
      )
    if (input.depth === "metadata") {
      const completedHeaders = operations.filter((operation) => {
        const observed = /^observe-([a-f0-9]{64})\.[a-f0-9]{64}$/u.exec(operation.record_id)?.[1]
        return observed !== undefined && completedEvents.has(`adopt-${observed}`)
      })
      const verified = yield* loadPendingSharedObservationPlans(library, {
        skillPageId: input.page_id,
        events,
        headers: completedHeaders,
      }).pipe(Effect.result)
      if (verified._tag === "Failure")
        yield* unavailable(
          "OPERATION_COMPLETION_INVALID",
          input.page_id,
          "operations",
          verified.failure,
        )
      for (const operation of operations) {
        if (verified._tag === "Success" && completedHeaders.includes(operation)) continue
        if (!unclassified.includes(operation))
          add(
            "OPERATION_PAYLOAD_UNOBSERVED",
            operation.record_id,
            "operations",
            "Metadata depth retains the original operation header without loading its body-bearing plan.",
            operation,
            "partial",
            "info",
          )
      }
    } else {
      const summaries = (
        plans: readonly { readonly operation_id: string }[],
      ): readonly { readonly operation_id: string; readonly plan: unknown }[] =>
        plans.map((plan) => ({ operation_id: plan.operation_id, plan }))
      const families = [
        loadPendingSharedSkillApplies(library, {
          skillPageId: input.page_id,
          headers: operations,
        }).pipe(Effect.map(summaries)),
        loadPendingSharedRepairs(library, { skillPageId: input.page_id, headers: operations }).pipe(
          Effect.map(summaries),
        ),
        loadPendingSharedObservationPlans(library, {
          skillPageId: input.page_id,
          events,
          headers: operations,
        }).pipe(Effect.map(summaries)),
        loadPendingSharedBodyWrites(library, {
          skillPageId: input.page_id,
          events,
          headers: operations,
        }).pipe(Effect.map(summaries)),
        loadPendingSharedMetadataWrites(library, {
          skillPageId: input.page_id,
          headers: operations,
        }).pipe(Effect.map(summaries)),
        loadPendingSharedFileManagement(library, {
          skillPageId: input.page_id,
          events,
          headers: operations,
        }).pipe(Effect.map(summaries)),
        loadPendingSharedResourceAuthoring(library, {
          skillPageId: input.page_id,
          events,
          headers: operations,
        }).pipe(Effect.map(summaries)),
        loadPendingSharedCreates(library, {
          skillPageId: input.page_id,
          events,
          headers: operations,
        }).pipe(Effect.map(summaries)),
      ]
      for (const family of families) {
        const result = yield* family.pipe(Effect.result)
        if (result._tag === "Failure") {
          yield* unavailable(
            "OPERATION_EVIDENCE_UNAVAILABLE",
            input.page_id,
            "operations",
            result.failure,
          )
          continue
        }
        for (const plan of result.success) {
          pending.push(plan)
          add(
            "ORIGINAL_OPERATION_UNRESOLVED",
            plan.operation_id,
            "operations",
            "The original operation still needs observation or explicit review. Audit did not replay it.",
            { operation_id: plan.operation_id },
            "partial",
            "warning",
          )
        }
      }
    }
    const history =
      input.depth === "history"
        ? yield* auditRetainedHistory(library, {
            skill_page_id: input.page_id,
            events,
            operations: pending,
            pins: [
              ...(input.pin_id ? [input.pin_id] : []),
              ...headers
                .filter(
                  (row) =>
                    property(auditField(row, library.records, "Kind").select).name === "snapshot",
                )
                .map((row) => auditRich(row, library.records, "Entity ID")),
            ],
            bundles: [
              ...(index.source_reference.startsWith("bundle-") ? [index.source_reference] : []),
              ...headers
                .filter(
                  (row) =>
                    property(auditField(row, library.records, "Kind").select).name === "source" &&
                    auditRich(row, library.records, "Entity ID").startsWith("bundle-"),
                )
                .map((row) => auditRich(row, library.records, "Entity ID")),
            ],
          })
        : { findings: [], history: [] }
    findings.push(...history.findings)
    if (input.depth !== "metadata")
      for (const file of tree.values())
        if (file.byte_status === "unobserved")
          add(
            "FILE_BYTES_UNOBSERVED",
            file.file_id ?? index.source_reference,
            file.path,
            "This file's bytes were not verified at the requested content depth.",
            { path: file.path },
            "partial",
            "warning",
          )
    return {
      scope_key,
      page_id: input.page_id,
      skill_id: index.skill_id,
      signature: yield* auditSkillSignature(library, input.inventory, input.page_id),
      checked_at: yield* Clock.currentTimeMillis,
      observed_from: input.observed_from,
      coverage: auditCoverage(findings.map((finding) => finding.coverage)),
      findings,
      tree: [...tree.values()].sort((a, b) => a.path.localeCompare(b.path)),
      history: history.history,
      requires: auditRelationIds(raw, library.skills, "Requires"),
      state: {
        source_reference: index.source_reference,
        source_context: sourceContext._tag === "Success" ? sourceContext.success : null,
        selected: selected?._tag === "Success" ? selected.success : null,
        files: descriptions,
        retained_files: [...states]
          .filter(([, state]) => state.ownership.kind === "tombstone")
          .map(([file_id, state]) => {
            const binding = bindings.find((value) => value.file_id === file_id)
            return {
              file_id,
              page_id: binding?.page_id ?? null,
              path: binding?.path ?? null,
              ownership: "tombstone",
              heads: state.heads,
            }
          }),
        operations: operations.map((operation) => ({
          record_id: operation.record_id,
          page_id: operation.page_id,
        })),
      },
      reused_from: null,
    } satisfies AuditItem
  })
}
