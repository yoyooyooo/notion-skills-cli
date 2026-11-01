import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import {
  bodyWriteObservationId,
  bodyWriteOutcomeId,
  type SharedBodyWritePlan,
} from "../src/shared-body-write-model.ts"
import {
  executeSharedBodyWrite,
  loadPendingSharedBodyWrites,
  prepareSharedBodyWrite,
  reconcileSharedBodyWrite,
} from "../src/shared-body-write.ts"
import { reviewSharedBodyWrite } from "../src/shared-body-write-review.ts"
import { bodyWriteReviewReceiptId } from "../src/shared-body-write-review-model.ts"
import {
  normalizeObservedBody,
  resolveFileState,
  type FileEvent,
} from "../src/shared-file-state.ts"
import { querySharedOperationIndex } from "../src/shared-operation-index.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  retainPendingFileOperation,
  sharedPendingObservationPrefix,
} from "../src/shared-pending-file-operations.ts"
import {
  candidate,
  client,
  creates,
  eventRows,
  failure,
  fileId,
  hash,
  library,
  original,
  patches,
  payloadFor,
  prepare,
  reads,
  remote,
  rowRecordId,
  seed,
  skillPage,
} from "./shared-body-write-review-fixture.ts"

const scope = hash("body-review-test-scope")
const observed = "# Changed\nNew instructions merged by the server.\n"
const review = (
  plan: SharedBodyWritePlan,
  options: {
    accepted?: string
    mode?: "create" | "reconcile"
    dryRun?: boolean
  } = {},
) =>
  reviewSharedBodyWrite({
    library,
    skillPageId: skillPage,
    originalOperationId: plan.operation_id,
    acceptedObservedSha256: options.accepted ?? hash(observed),
    scope,
    mode: options.mode ?? "create",
    dryRun: options.dryRun ?? false,
  })

async function needsReview(
  options: {
    readback?: string
    response?: (raw: Record<string, unknown>) => unknown
    unknownBody?: boolean
  } = {},
) {
  const shared = remote()
  const api = client(shared, {
    readback: () => options.readback ?? observed,
    ...(options.response === undefined ? {} : { response: options.response }),
    ...(options.unknownBody === undefined ? {} : { unknownBody: options.unknownBody }),
  })
  const plan = await api.run(prepare())
  const write = await api.run(
    executeSharedBodyWrite(library, {
      plan,
      mode: "create",
      beforePlanWrite: (originalPlan) =>
        Effect.gen(function* () {
          yield* retainPendingFileOperation(
            {
              prefix: yield* sharedPendingObservationPrefix(
                scope,
                library.library_id,
                originalPlan.skill_id,
              ),
              scope,
              library_id: library.library_id,
              skill_id: originalPlan.skill_id,
              skill_page_id: skillPage,
            },
            originalPlan,
          )
        }),
    }).pipe(Effect.result),
  )
  expect(write._tag).toBe("Failure")
  expect(patches(api)).toHaveLength(1)
  expect(eventRows(shared)).toHaveLength(1)
  return { shared, plan, originalFailure: failure(write) }
}

function hide(shared: ReturnType<typeof remote>, recordId: string) {
  const row = [...shared.rows.values()].find((value) => rowRecordId(value) === recordId)
  if (row === undefined) throw new Error(`Missing test fact ${recordId}`)
  shared.hidden.add(String(row.id))
}

const pending = (api: ReturnType<typeof client>, shared: ReturnType<typeof remote>) =>
  api.run(
    Effect.gen(function* () {
      return yield* loadPendingSharedBodyWrites(library, {
        skillPageId: skillPage,
        events: eventRows(shared),
        headers: yield* querySharedOperationIndex(library, skillPage),
      })
    }),
  )

describe("explicit acceptance of a retained body-write observation", () => {
  test("dry-run verifies original facts and fresh bytes with zero writes or new local state", async () => {
    const { shared, plan } = await needsReview()
    const priorLocal = canonicalSharedJson([...shared.local.entries()])
    const priorRows = shared.rows.size
    const api = client(shared)
    const preview = await api.run(review(plan, { dryRun: true }))
    expect(preview.status).toBe("planned")
    expect(preview.decision).toBe("accepted_observed")
    expect(preview.original_status).toBe("needs_review")
    expect(shared.rows.size).toBe(priorRows)
    expect(canonicalSharedJson([...shared.local.entries()])).toBe(priorLocal)
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
    expect(reads(api).length).toBeGreaterThan(0)
    expect((await pending(api, shared)).map((value) => value.operation_id)).toEqual([
      plan.operation_id,
    ])
  })

  test("public review preserves the original needs_review and enables a later independent correction", async () => {
    const { shared, plan } = await needsReview()
    const priorPlan = canonicalSharedJson(payloadFor(shared, plan.operation_id))
    const priorOutcome = canonicalSharedJson(
      payloadFor(shared, bodyWriteOutcomeId(plan.operation_id)),
    )
    const priorObservation = canonicalSharedJson(
      payloadFor(shared, bodyWriteObservationId(plan.operation_id)),
    )
    const api = client(shared)
    const accepted = await api.run(review(plan))
    if (accepted.status !== "reviewed") throw new Error("Expected completed explicit review")
    expect(accepted.original_status).toBe("needs_review")
    expect(accepted.decision).toBe("accepted_observed")
    expect(accepted.event.event_id).not.toBe(plan.event.event_id)
    expect(accepted.event.parents).toEqual(plan.event.parents)
    expect(shared.markdown).toBe(observed)
    expect(creates(api)).toHaveLength(4)
    expect(patches(api)).toHaveLength(0)
    expect(canonicalSharedJson(payloadFor(shared, plan.operation_id))).toBe(priorPlan)
    expect(canonicalSharedJson(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id)))).toBe(
      priorOutcome,
    )
    expect(canonicalSharedJson(payloadFor(shared, bodyWriteObservationId(plan.operation_id)))).toBe(
      priorObservation,
    )
    expect(property(payloadFor(shared, `body-${hash(original)}`)).markdown).toBe(original)
    expect(property(payloadFor(shared, `body-${hash(candidate)}`)).markdown).toBe(candidate)
    expect(property(payloadFor(shared, `body-${hash(observed)}`)).markdown).toBe(observed)
    expect([...shared.local.keys()].filter((key) => key.startsWith("operations/"))).toHaveLength(0)
    expect([...shared.retired.keys()].filter((key) => key.startsWith("operations/"))).toHaveLength(
      2,
    )
    const state = resolveFileState(fileId, eventRows(shared))
    expect(state.heads).toEqual([accepted.event.event_id])
    expect(state.ownership).toEqual({ kind: "custom", content: accepted.event.content })
    expect(await pending(api, shared)).toEqual([])
    const originalRecovery = await api.run(reconcileSharedBodyWrite(library, plan))
    expect(originalRecovery.status).toBe("reviewed")
    expect(originalRecovery.operation_id).toBe(accepted.operation_id)
    const correction = await api.run(
      prepareSharedBodyWrite({
        library,
        skillPageId: skillPage,
        fileId,
        action: "write",
        candidateMarkdown: "# Corrected\n\nRestored paragraph boundary.\n",
      }),
    )
    expect(correction.event.parents).toEqual([accepted.event.event_id])
    expect(correction.before.raw_markdown).toBe(observed)
    expect(correction.operation_id).not.toBe(plan.operation_id)
    expect(
      (await api.run(executeSharedBodyWrite(library, { plan: correction, mode: "create" }))).status,
    ).toBe("applied")
    expect(canonicalSharedJson(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id)))).toBe(
      priorOutcome,
    )
  })

  test("repeat and reconcile only verify historical review facts, including after a later user edit", async () => {
    const { shared, plan } = await needsReview()
    await client(shared).run(review(plan))
    shared.markdown = "A separate later user edit remains untouched.\n"
    for (const mode of ["create", "reconcile"] as const) {
      const api = client(shared)
      const result = await api.run(review(plan, { mode }))
      expect(result.status).toBe("reviewed")
      expect(result.original_status).toBe("needs_review")
      expect(creates(api)).toHaveLength(0)
      expect(patches(api)).toHaveLength(0)
      expect(reads(api)).toHaveLength(0)
      expect(shared.markdown).toBe("A separate later user edit remains untouched.\n")
    }
  })

  test("explicit raw hash and byte comparison distinguish CRLF from its normalized retained object", async () => {
    const raw = observed.replaceAll("\n", "\r\n")
    const { shared, plan } = await needsReview({ readback: raw })
    const wrong = client(shared)
    expect(failure(await wrong.run(review(plan).pipe(Effect.result))).code).toBe(
      "SHARED_BODY_REVIEW_HASH_MISMATCH",
    )
    expect(creates(wrong)).toHaveLength(0)
    const accepted = await client(shared).run(review(plan, { accepted: hash(raw) }))
    expect(accepted.accepted_observed_sha256).toBe(hash(raw))
    expect(accepted.content_sha256).toBe(hash(normalizeObservedBody(raw)))
    expect(property(payloadFor(shared, `body-${hash(observed)}`)).markdown).toBe(observed)
    expect(
      property(property(payloadFor(shared, bodyWriteObservationId(plan.operation_id))).response)
        .markdown,
    ).toBe(raw)
  })

  test.each([
    "changed_body",
    "same_normalized_body",
    "changed_source",
    "changed_skill",
    "disabled",
    "changed_heads",
  ])("%s cannot be accepted under the original observation and parent frontier", async (change) => {
    const { shared, plan } = await needsReview()
    if (change === "changed_body") shared.markdown = "A subsequent user body.\n"
    if (change === "same_normalized_body") shared.markdown = observed.replaceAll("\n", "\r\n")
    if (change === "changed_source") shared.source = "another-source"
    if (change === "changed_skill") shared.skillId = "another-skill"
    if (change === "disabled") shared.enabled = false
    if (change === "changed_heads") {
      if (shared.initial.kind !== "adopted") throw new Error("Fixture requires initial custom")
      const changed: FileEvent = {
        ...shared.initial,
        event_id: "later-parent",
        parents: [shared.initial.event_id],
      }
      seed(shared, "file_event", changed.event_id, changed.event_id, fileId, changed)
    }
    const api = client(shared)
    expect(failure(await api.run(review(plan).pipe(Effect.result))).code).toBe(
      "SHARED_BODY_REVIEW_STALE",
    )
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
  })

  test.each(["truncated", "unknown_blocks", "warnings", "foreign_page", "missing_response"])(
    "retained %s response remains ineligible even when the fresh body is complete",
    async (kind) => {
      const { shared, plan } = await needsReview({
        response: (raw) => {
          if (kind === "missing_response") return undefined
          return {
            ...raw,
            ...(kind === "truncated" ? { truncated: true } : {}),
            ...(kind === "unknown_blocks" ? { unknown_block_ids: ["unknown"] } : {}),
            ...(kind === "warnings" ? { warnings: ["partial content"] } : {}),
            ...(kind === "foreign_page" ? { id: "00000000-0000-4000-8000-000000000099" } : {}),
          }
        },
      })
      const api = client(shared)
      expect(failure(await api.run(review(plan).pipe(Effect.result))).code).toMatch(
        /^SHARED_BODY_REVIEW_/u,
      )
      expect(creates(api)).toHaveLength(0)
      expect(patches(api)).toHaveLength(0)
    },
  )

  test.each(["observation", "outcome", "candidate"])(
    "missing original %s is never repaired by review",
    async (kind) => {
      const { shared, plan } = await needsReview()
      hide(
        shared,
        kind === "observation"
          ? bodyWriteObservationId(plan.operation_id)
          : kind === "outcome"
            ? bodyWriteOutcomeId(plan.operation_id)
            : plan.candidate.content.object_id,
      )
      const api = client(shared)
      expect((await api.run(review(plan).pipe(Effect.result)))._tag).toBe("Failure")
      expect(creates(api)).toHaveLength(0)
      expect(patches(api)).toHaveLength(0)
    },
  )

  test("an unknown original body write is ineligible even if current bytes match a proposed acceptance", async () => {
    const { shared, plan, originalFailure } = await needsReview({ unknownBody: true })
    expect(originalFailure.code).toBe("WRITE_OUTCOME_UNKNOWN")
    const api = client(shared)
    expect(failure(await api.run(review(plan).pipe(Effect.result))).code).toBe(
      "SHARED_BODY_REVIEW_INELIGIBLE",
    )
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
  })

  test("a body change after review intent is frozen stops adoption and never resumes missing facts", async () => {
    const { shared, plan } = await needsReview()
    const api = client(shared, {
      afterRecord: (kind) => {
        if (kind === "object") shared.markdown = "Edited while the review object was retained.\n"
      },
    })
    expect(failure(await api.run(review(plan).pipe(Effect.result))).code).toBe(
      "SHARED_BODY_REVIEW_STALE",
    )
    expect(creates(api)).toHaveLength(2)
    expect(eventRows(shared)).toHaveLength(1)
    shared.markdown = observed
    const retry = client(shared)
    expect(failure(await retry.run(review(plan).pipe(Effect.result))).code).toBe(
      "SHARED_RECORD_UNRESOLVED",
    )
    expect(creates(retry)).toHaveLength(0)
    expect(patches(retry)).toHaveLength(0)
    expect(eventRows(shared)).toHaveLength(1)
  })

  test.each([
    ["plan", "operation", "body-review-"],
    ["object", "object", `body-${hash(observed)}`],
    ["event", "file_event", "review-adopt-"],
    ["receipt", "operation", "reviewed-body-review-"],
  ] as const)(
    "unknown %s request never dispatches missing subsequent review facts",
    async (_stage, kind, prefix) => {
      for (const invisible of [false, true]) {
        const { shared, plan } = await needsReview()
        const api = client(shared, { unknownRecord: kind, unknownRecordPrefix: prefix, invisible })
        expect(failure(await api.run(review(plan).pipe(Effect.result))).code).toBe(
          "WRITE_OUTCOME_UNKNOWN",
        )
        const numberOfRows = shared.rows.size
        const retry = client(shared)
        const result = await retry.run(review(plan, { mode: "reconcile" }).pipe(Effect.result))
        if (_stage === "receipt" && !invisible) {
          if (result._tag !== "Success")
            throw new Error("A visible complete original receipt must reconcile")
          expect(result.success.status).toBe("reviewed")
          expect(await pending(retry, shared)).toEqual([])
        } else {
          expect(result._tag).toBe("Failure")
          const read = await retry.run(
            Effect.gen(function* () {
              return yield* loadPendingSharedBodyWrites(library, {
                skillPageId: skillPage,
                events: eventRows(shared),
                headers: yield* querySharedOperationIndex(library, skillPage),
              })
            }).pipe(Effect.result),
          )
          if (read._tag === "Success")
            expect(read.success.map((value) => value.operation_id)).toContain(plan.operation_id)
        }
        expect(shared.rows.size).toBe(numberOfRows)
        expect(creates(retry)).toHaveLength(0)
        expect(patches(retry)).toHaveLength(0)
        expect(property(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).status).toBe(
          "needs_review",
        )
      }
    },
  )

  test("a review event without its intent and receipt cannot retire the original pending barrier", async () => {
    const { shared, plan } = await needsReview()
    const api = client(shared)
    const preview = await api.run(review(plan, { dryRun: true }))
    if (preview.status !== "planned") throw new Error("Expected review preview")
    seed(
      shared,
      "file_event",
      preview.plan.event.event_id,
      preview.plan.operation_id,
      fileId,
      preview.plan.event,
    )
    expect((await pending(api, shared)).map((value) => value.operation_id)).toEqual([
      plan.operation_id,
    ])
    const recovery = client(shared)
    expect((await recovery.run(review(plan, { mode: "reconcile" }).pipe(Effect.result)))._tag).toBe(
      "Failure",
    )
    expect(creates(recovery)).toHaveLength(0)
    expect(patches(recovery)).toHaveLength(0)
  })

  test("a hidden final receipt keeps the barrier; later visibility permits only read-only reconciliation", async () => {
    const { shared, plan } = await needsReview()
    const first = client(shared, {
      unknownRecord: "operation",
      unknownRecordPrefix: "reviewed-body-review-",
      invisible: true,
    })
    const lost = await first.run(review(plan).pipe(Effect.result))
    expect(failure(lost).code).toBe("WRITE_OUTCOME_UNKNOWN")
    const receipt = [...shared.rows.values()].find((row) =>
      rowRecordId(row).startsWith("reviewed-body-review-"),
    )
    if (receipt === undefined) throw new Error("Expected hidden receipt")
    shared.hidden.delete(String(receipt.id))
    const retry = client(shared)
    const accepted = await retry.run(review(plan, { mode: "reconcile" }))
    expect(accepted.status).toBe("reviewed")
    expect(
      property(payloadFor(shared, bodyWriteReviewReceiptId(accepted.operation_id))).decision,
    ).toBe("accepted_observed")
    expect(creates(retry)).toHaveLength(0)
    expect(patches(retry)).toHaveLength(0)
  })
})
