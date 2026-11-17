import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { acceptCurrentSharedBodyWrite } from "../src/shared-body-current-acceptance.ts"
import {
  executeSharedBodyWrite,
  loadPendingSharedBodyWrites,
  prepareSharedBodyWrite,
  reconcileSharedBodyWrite,
} from "../src/shared-body-write.ts"
import { bodyWriteOutcomeId, type SharedBodyWritePlan } from "../src/shared-body-write-model.ts"
import { querySharedOperationIndex } from "../src/shared-operation-index.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { property } from "../src/model.ts"
import { projectSharedNotionMarkdown } from "../src/shared-notion-projection.ts"
import {
  candidate,
  client,
  creates,
  eventRows,
  fileId,
  failure,
  hash,
  library,
  patches,
  payloadFor,
  prepare,
  remote,
  rowRecordId,
  seed,
  skillPage,
} from "./shared-body-write-review-fixture.ts"

const scope = hash("current-acceptance-scope")
const accept = (
  plan: SharedBodyWritePlan,
  options: { dryRun?: boolean; mode?: "create" | "reconcile"; accepted?: string } = {},
) =>
  acceptCurrentSharedBodyWrite({
    library,
    skillPageId: skillPage,
    originalOperationId: plan.operation_id,
    acceptedObservedSha256: options.accepted ?? hash(candidate),
    scope,
    dryRun: options.dryRun ?? false,
    mode: options.mode ?? "create",
  })

async function delayedEvent(markdown = candidate, projected = false) {
  const shared = remote()
  const projection = projectSharedNotionMarkdown(markdown, { version: 15, purpose: "body_write" })
  const api = client(shared, {
    ...(projected ? { readback: () => projection.markdown } : {}),
    afterRecord(kind, id) {
      if (kind !== "file_event") return
      const row = [...shared.rows.values()].find((value) => rowRecordId(value) === id)
      if (row !== undefined) shared.hidden.add(String(row.id))
    },
  })
  const plan = await api.run(
    projected
      ? prepareSharedBodyWrite({
          library,
          skillPageId: skillPage,
          fileId,
          candidateMarkdown: projection.markdown,
          inputProjection: projection,
          action: "write",
        })
      : prepare(markdown),
  )
  const result = await api.run(
    executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result),
  )
  expect(failure(result).code).toBe("SHARED_BODY_WRITE_UNRESOLVED")
  expect(patches(api)).toHaveLength(1)
  expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
  shared.hidden.clear()
  return { shared, plan }
}

describe("independent current acceptance after an acknowledged event was not visible", () => {
  test("a legal complete original keeps its actual full-envelope identity", async () => {
    const { shared, plan } = await delayedEvent(
      "# Changed\n\n" + "Retained instructions.\n".repeat(200),
      true,
    )
    expect(property(payloadFor(shared, plan.operation_id)).storage).toBeUndefined()
    const full = canonicalSharedJson({ version: 1, operation_id: plan.operation_id, payload: plan })
    expect(new TextEncoder().encode(full).byteLength).toBeLessThanOrEqual(64 * 1024)
    const api = client(shared)
    const preview = await api.run(accept(plan, { dryRun: true, accepted: hash(shared.markdown) }))
    if (preview.status !== "planned") throw new Error("Expected the exact full-storage preview")
    expect(preview.decision_record.original_plan_sha256).toBe(hash(full))
    expect(creates(api)).toHaveLength(0)
  })

  test("acceptance does not bypass the record limit for an oversized full payload", async () => {
    const { shared, plan } = await delayedEvent(
      "# Changed\n\n" + "Retained instructions.\n".repeat(1400),
      true,
    )
    for (const [key, row] of shared.rows)
      if (rowRecordId(row) === plan.operation_id) shared.rows.delete(key)
    seed(shared, "operation", plan.operation_id, plan.operation_id, plan.file_id, plan)
    const api = client(shared)
    const result = await api.run(
      accept(plan, { dryRun: true, accepted: hash(shared.markdown) }).pipe(Effect.result),
    )
    expect(failure(result).code).toBe("SHARED_RECORD_TOO_LARGE")
    expect(creates(api)).toHaveLength(0)
  })

  test("explicit acceptance can review a disabled exact target without enabling it", async () => {
    const { shared, plan } = await delayedEvent()
    shared.enabled = false
    const api = client(shared)
    expect((await api.run(accept(plan, { dryRun: true }))).status).toBe("planned")
    expect(creates(api)).toHaveLength(0)
    const result = await api.run(accept(plan))
    expect(result.status).toBe("reviewed")
    expect(result.original_write_outcome).toBe("unknown")
    expect(shared.enabled).toBe(false)
    expect(patches(api)).toHaveLength(0)
    expect(creates(api)).toHaveLength(1)
    expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
  })

  test("a derived-text original is checked in its stored encoding and the decision binds the complete plan", async () => {
    const markdown = `# Changed\n\n${"Retained instructions.\n".repeat(1400)}`
    const { shared, plan } = await delayedEvent(markdown, true)
    const accepted = hash(shared.markdown)
    expect(property(payloadFor(shared, plan.operation_id)).storage).toBe("derived-text-v1")
    const api = client(shared)
    const preview = await api.run(accept(plan, { dryRun: true, accepted }))
    expect(preview.status).toBe("planned")
    if (preview.status !== "planned") throw new Error("Expected current acceptance preview")
    expect(preview.decision_record.original_plan_sha256).toBe(
      hash(canonicalSharedJson({ version: 1, operation_id: plan.operation_id, payload: plan })),
    )
    expect(preview.decision_record.original_plan_sha256).not.toBe(
      hash(
        canonicalSharedJson({
          version: 1,
          operation_id: plan.operation_id,
          payload: payloadFor(shared, plan.operation_id),
        }),
      ),
    )
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
    const result = await api.run(accept(plan, { accepted }))
    expect(result.status).toBe("reviewed")
    expect(result.original_write_outcome).toBe("unknown")
    expect((await client(shared).run(reconcileSharedBodyWrite(library, plan))).status).toBe(
      "reviewed",
    )
    expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
  })

  test("preview is read-only; acceptance retains unknown and releases only its exact original fence", async () => {
    const { shared, plan } = await delayedEvent()
    const api = client(shared)
    const beforeRows = shared.rows.size
    const preview = await api.run(accept(plan, { dryRun: true }))
    expect(preview.status).toBe("planned")
    expect(preview.original_write_outcome).toBe("unknown")
    expect(shared.local.size).toBe(0)
    expect(shared.rows.size).toBe(beforeRows)
    const result = await api.run(accept(plan))
    expect(result.status).toBe("reviewed")
    expect(result.decision).toBe("accepted_current")
    expect(result.original_write_outcome).toBe("unknown")
    expect(creates(api)).toHaveLength(1)
    expect(patches(api)).toHaveLength(0)
    expect(eventRows(shared)).toHaveLength(2)
    expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
    expect((await api.run(reconcileSharedBodyWrite(library, plan))).status).toBe("reviewed")
    seed(shared, "file_event", "support-event", "support-event", "support-file", {
      event_id: "support-event",
      file_id: "support-file",
      parents: [],
      kind: "adopted",
      content: { object_id: `body-${hash("support")}`, sha256: hash("support"), bytes: 7 },
    })
    expect(
      await api.run(
        Effect.gen(function* () {
          return yield* loadPendingSharedBodyWrites(library, {
            skillPageId: skillPage,
            events: eventRows(shared),
            headers: yield* querySharedOperationIndex(library, skillPage),
          })
        }),
      ),
    ).toEqual([])
  })

  test("unknown acceptance keeps one frozen dispatch and never repeats its POST", async () => {
    const { shared, plan } = await delayedEvent()
    const first = client(shared, {
      unknownRecord: "operation",
      unknownRecordPrefix: "accept-current-",
      invisible: true,
    })
    expect((await first.run(accept(plan).pipe(Effect.result)))._tag).toBe("Failure")
    expect(creates(first)).toHaveLength(1)
    const second = client(shared)
    expect((await second.run(accept(plan).pipe(Effect.result)))._tag).toBe("Failure")
    expect(creates(second)).toHaveLength(0)
    expect(
      (await second.run(accept(plan, { accepted: hash("another") }).pipe(Effect.result)))._tag,
    ).toBe("Failure")
    shared.hidden.clear()
    const result = await second.run(accept(plan, { mode: "reconcile" }))
    expect(result.original_write_outcome).toBe("unknown")
    expect(creates(second)).toHaveLength(0)
    expect(patches(second)).toHaveLength(0)
  })

  test("a missing acceptance event cannot be inferred from equal current bytes", async () => {
    const shared = remote()
    const api = client(shared, { unknownBody: true })
    const plan = await api.run(prepare())
    expect(
      (await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result)))
        ._tag,
    ).toBe("Failure")
    expect(shared.markdown).toBe(candidate)
    const review = client(shared)
    expect(failure(await review.run(accept(plan).pipe(Effect.result))).code).toBe(
      "SHARED_CURRENT_ACCEPTANCE_INELIGIBLE",
    )
    expect(creates(review)).toHaveLength(0)
    expect(shared.local.size).toBe(0)
  })

  test("changed current content and a wrong explicit hash are rejected before dispatch", async () => {
    const { shared, plan } = await delayedEvent()
    const api = client(shared)
    expect(
      failure(await api.run(accept(plan, { accepted: hash("wrong") }).pipe(Effect.result))).code,
    ).toBe("SHARED_CURRENT_ACCEPTANCE_HASH_MISMATCH")
    shared.markdown = candidate + "Later edit.\n"
    expect(failure(await api.run(accept(plan).pipe(Effect.result))).code).toBe(
      "SHARED_CURRENT_ACCEPTANCE_STALE",
    )
    expect(creates(api)).toHaveLength(0)
    expect(shared.local.size).toBe(0)
  })

  test("identity and Source changes fail without creating a review", async () => {
    const { shared, plan } = await delayedEvent()
    shared.source = "another-source"
    const api = client(shared)
    expect(failure(await api.run(accept(plan).pipe(Effect.result))).code).toBe(
      "SHARED_CURRENT_ACCEPTANCE_STALE",
    )
    expect(creates(api)).toHaveLength(0)
  })

  test("an existing definitive outcome must use the established workflow", async () => {
    const shared = remote(),
      api = client(shared)
    const plan = await api.run(prepare())
    await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }))
    const review = client(shared)
    expect(failure(await review.run(accept(plan).pipe(Effect.result))).code).toBe(
      "SHARED_CURRENT_ACCEPTANCE_INELIGIBLE",
    )
    expect(creates(review)).toHaveLength(0)
  })
})
