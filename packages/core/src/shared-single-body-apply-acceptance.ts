import { Effect, Schema } from "effect"
import { fail, property } from "./model.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { Notion } from "./notion.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { observeSharedBodyCurrentAcceptance } from "./shared-body-current-acceptance.ts"
import { bodyWriteOutcomeId, plannedBodyWriteEventId } from "./shared-body-write-model.ts"
import { FileEventSchema, type FileEvent } from "./shared-file-state.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import { storedSharedOperationPlan } from "./shared-plan-storage.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { querySharedSkillIndex, type SharedSkillIndex } from "./shared-skill-index.ts"
import {
  applyChecked,
  sharedSkillApplyOutcomeId,
  sharedSkillApplyPlansEntity,
  validateSharedSkillApplyPlan,
  type SharedSkillApplyPlan,
} from "./shared-skill-apply-model.ts"
import { sha256 } from "./store.ts"
import { parseYaml } from "./yaml.ts"
import { readSharedFileSourceContext } from "./shared-file-source-context.ts"
import { loadPendingSharedSkillApplies } from "./shared-skill-apply.ts"

/** Only the exact current main file is eligible. This is not parent completion,
 * a replay permission, or a replacement for any missing original fact. */
export function observeAcceptedSingleBodyApply(
  library: SharedLibrary,
  input: SharedSkillApplyPlan,
  observed?: {
    readonly index: SharedSkillIndex
    readonly headers: readonly SharedOperationHeader[]
    readonly events: readonly FileEvent[]
  },
) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedSkillApplyPlan(input)
    if (plan.version !== 1 || plan.bodies.length !== 1 || plan.metadata !== undefined)
      return undefined
    const child = plan.bodies[0]!
    if (
      child.action !== "write" ||
      child.event.kind !== "adopted" ||
      child.candidate.content.kind === "resource" ||
      child.file_id !== plan.file_id ||
      child.page_id !== plan.skill_page_id ||
      plan.library_id !== library.library_id
    )
      return undefined
    const headers = yield* querySharedOperationIndex(library, plan.skill_page_id)
    const headerIdentity = (values: readonly SharedOperationHeader[]) =>
      canonicalSharedJson([...values].sort((a, b) => a.record_id.localeCompare(b.record_id)))
    if (observed !== undefined && headerIdentity(headers) !== headerIdentity(observed.headers))
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_STALE",
          "The complete shared operation frontier changed after the selected graph read.",
        ),
      )
    const has = (id: string) => headers.some((header) => header.record_id === id)
    if (
      has(sharedSkillApplyOutcomeId(plan.operation_id)) ||
      has(bodyWriteOutcomeId(child.operation_id))
    )
      return undefined
    const parents = yield* loadPendingSharedSkillApplies(library, {
      skillPageId: plan.skill_page_id,
      headers,
    })
    const bodies = headers.filter(
      (header) =>
        plannedBodyWriteEventId(header.record_id) !== undefined &&
        !has(bodyWriteOutcomeId(header.record_id)),
    )
    if (
      parents.length !== 1 ||
      parents[0]?.operation_id !== plan.operation_id ||
      bodies.length !== 1 ||
      bodies[0]?.record_id !== child.operation_id
    )
      return undefined
    for (const [original, entity] of [
      [plan, sharedSkillApplyPlansEntity],
      [child, child.file_id],
    ] as const) {
      const rows = yield* querySharedRecords(library, {
        skillPageId: plan.skill_page_id,
        kind: "operation",
        entityId: entity,
        recordId: original.operation_id,
        payloadContainsBody: true,
      })
      const row = rows[0],
        header = headers.find((entry) => entry.record_id === original.operation_id)
      const stored =
        row !== undefined && canonicalSharedJson(row.payload) === canonicalSharedJson(original)
          ? original
          : storedSharedOperationPlan(original)
      const hash = yield* sha256(
        canonicalSharedJson({ version: 1, operation_id: original.operation_id, payload: stored }),
      )
      if (
        rows.length !== 1 ||
        row === undefined ||
        header === undefined ||
        row.record_id !== original.operation_id ||
        row.operation_id !== original.operation_id ||
        row.entity_id !== entity ||
        row.skill_page_id !== plan.skill_page_id ||
        row.hash !== header.hash ||
        row.hash !== hash ||
        canonicalSharedJson(row.payload) !== canonicalSharedJson(stored)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_CURRENT_ACCEPTANCE_INVALID",
            "The exact original parent or child record is unavailable or differs from its frozen encoding.",
          ),
        )
    }
    for (const recordId of [
      sharedSkillApplyOutcomeId(plan.operation_id),
      bodyWriteOutcomeId(child.operation_id),
    ]) {
      const outcomes = yield* querySharedRecords(library, {
        skillPageId: plan.skill_page_id,
        kind: "operation",
        recordId,
      })
      if (outcomes.length !== 0) return undefined
    }
    const raw = yield* (yield* Notion).request(`v1/pages/${plan.skill_page_id}`)
    const index = yield* querySharedSkillIndex(library, plan.skill_page_id, raw)
    if (
      observed !== undefined &&
      canonicalSharedJson(index) !== canonicalSharedJson(observed.index)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_STALE",
          "The current native metadata or file binding changed after the selected graph read.",
        ),
      )
    if (
      index.skill_id !== plan.skill_id ||
      index.main.file_id !== child.file_id ||
      index.main.page_id !== child.page_id ||
      index.main.path !== child.path ||
      index.source_reference !== plan.source_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_STALE",
          "The independently accepted parent no longer has its exact native main binding or Source.",
        ),
      )
    const source = yield* readSharedFileSourceContext(library, plan.skill_page_id, raw)
    if (source.selected_version !== child.source_id || source.definition !== null)
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_STALE",
          "This bounded acceptance cannot release an unfrozen live Source binding.",
        ),
      )
    const header = child.candidate.content.frontmatter
    const match =
      typeof header === "string"
        ? /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(header)
        : null
    const metadata = yield* applyChecked(() =>
      property(match === null ? undefined : parseYaml(match[1] ?? "")),
    )
    if (metadata.name !== index.name || metadata.description !== index.description)
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_STALE",
          "The current main name or description differs from the accepted complete file.",
        ),
      )
    const events = yield* Effect.gen(function* () {
      const rows = yield* querySharedRecords(library, {
        skillPageId: plan.skill_page_id,
        kind: "file_event",
      })
      return yield* applyChecked(() =>
        rows.map((row) => {
          const event = Schema.decodeUnknownSync(FileEventSchema)(row.payload, {
            onExcessProperty: "error",
          })
          if (
            row.record_id !== event.event_id ||
            row.operation_id !== event.event_id ||
            row.entity_id !== event.file_id
          )
            throw fail(
              "SHARED_CURRENT_ACCEPTANCE_INVALID",
              "A current file event differs from its immutable identity.",
            )
          return event
        }),
      )
    })
    const eventIdentity = (values: readonly FileEvent[]) =>
      canonicalSharedJson([...values].sort((a, b) => a.event_id.localeCompare(b.event_id)))
    if (observed !== undefined && eventIdentity(events) !== eventIdentity(observed.events))
      return yield* Effect.fail(
        fail(
          "SHARED_CURRENT_ACCEPTANCE_STALE",
          "The complete current file frontier changed after the selected graph read.",
        ),
      )
    const current = yield* observeSharedBodyCurrentAcceptance(library, child, {
      index,
      headers,
      events,
    })
    return current === undefined ? undefined : { plan, child, headers, events, ...current }
  }).pipe(withReadOnlyNotion)
}
