import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { canonical } from "../src/publication-effect-proof.ts"
import { sha256 } from "../src/store.ts"
import { planContentAdoption } from "../src/upstream-content-adoption.ts"
import {
  applySourceRootCompletion,
  planSourceRootCompletion,
  reconcileSourceRootCompletion,
  showSourceRootCompletion,
} from "../src/upstream-source-root-completion.ts"
import { sourceRootCompletionKey } from "../src/upstream-source-root-completion-model.ts"
import {
  applySourceRootFidelity,
  planSourceRootFidelity,
  reconcileSourceRootFidelity,
  showSourceRootFidelity,
} from "../src/upstream-source-root-fidelity.ts"
import {
  decodeSourceRootFidelity,
  sourceRootFidelityKey,
} from "../src/upstream-source-root-fidelity-model.ts"
import { sourceRootFidelityFixture } from "./source-root-fidelity-fixture.ts"

async function failed(
  f: Awaited<ReturnType<typeof sourceRootFidelityFixture>>,
  effect: Parameters<typeof f.run>[0],
  expected?: string,
) {
  const result = await f.run(effect.pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw new Error("Expected the exact native proof to refuse")
  if (expected !== undefined) expect(property(result.failure).code).toBe(expected)
  return result.failure
}
async function planned() {
  const f = await sourceRootFidelityFixture()
  const completion = await f.run(planSourceRootCompletion(f.input))
  await failed(
    f,
    applySourceRootCompletion(completion.plan_id, completion.plan_hash),
    "CONTENT_ADOPTION_REFUSED",
  )
  const parent = await f.run(showSourceRootCompletion(completion.plan_id))
  expect(parent).toMatchObject({ phase: "acknowledged", attempts: [{ outcome: "acknowledged" }] })
  expect(parent.attempts).toHaveLength(1)
  expect(parent.attempts[0]?.response).toBeDefined()
  expect(f.writes).toHaveLength(1)
  f.writes.length = 0
  const input = {
    completion_plan_id: completion.plan_id,
    completion_plan_hash: completion.plan_hash,
  }
  const plan = await f.run(planSourceRootFidelity(input))
  const key = sourceRootFidelityKey(f.originalPlan.plan_id, 0)
  const before = await f.run(showSourceRootFidelity(plan.plan_id))
  f.freezeEffects(before.plan.effects)
  expect(f.writes).toEqual([])
  return {
    f,
    completion,
    parent,
    input,
    plan,
    key,
    before,
    receipt: () => f.run(showSourceRootFidelity(plan.plan_id)),
    parentReceipt: () => f.run(showSourceRootCompletion(completion.plan_id)),
    apply: () => f.run(applySourceRootFidelity(plan.plan_id, plan.plan_hash)),
    reconcile: () => f.run(reconcileSourceRootFidelity(plan.plan_id, plan.plan_hash)),
  }
}

test("one acknowledged parent needs nine exact block effects and independent final proofs before its own reconcile", async () => {
  const c = await planned()
  expect(c.plan).toMatchObject({
    phase: "planned",
    total_effects: 9,
    attempts: 0,
    body_verified: false,
    source_bytes_verified: false,
    parent_receipt_unchanged: true,
    publication_completed: false,
  })
  for (const mode of [applySourceRootCompletion, reconcileSourceRootCompletion])
    await failed(
      c.f,
      mode(c.completion.plan_id, c.completion.plan_hash),
      "SOURCE_ROOT_FIDELITY_REFUSED",
    )
  await failed(c.f, planContentAdoption(c.f.adoption))
  expect(await c.parentReceipt()).toEqual(c.parent)
  expect(await c.receipt()).toEqual(c.before)
  expect(c.f.writes).toEqual([])
  expect(await c.apply()).toMatchObject({
    phase: "body_verified",
    completed_effects: 9,
    total_effects: 9,
    attempts: 9,
    body_verified: true,
    source_bytes_verified: false,
    publication_completed: false,
  })
  const complete = await c.receipt()
  expect(complete.plan).toEqual(c.before.plan)
  expect(complete.checkpoints).toHaveLength(9)
  expect(complete.attempts.map((attempt) => attempt.outcome)).toEqual(Array(9).fill("acknowledged"))
  expect(c.f.writes).toEqual(c.before.plan.effects.map((effect) => effect.request))
  expect(new Set(c.f.writes.map((write) => write.path)).size).toBe(9)
  expect(await c.parentReceipt()).toEqual(c.parent)
  expect(complete.result?.first_observation.raw).toEqual(complete.result?.proof.raw)
  expect(complete.result?.proof).toMatchObject({
    source_proof: "not_installed",
    files: [],
    attachments: [],
  })
  expect(c.f.roots.slice(-2)).toEqual(c.f.children)
  await c.f.assertOriginal()
  c.f.sourceObjectsUnchanged()
  expect(
    await c.f.run(reconcileSourceRootCompletion(c.completion.plan_id, c.completion.plan_hash)),
  ).toMatchObject({ phase: "body_verified" })
  const progressedParent = await c.parentReceipt()
  expect(progressedParent.attempts).toEqual(c.parent.attempts)
  expect(progressedParent.plan).toEqual(c.parent.plan)
  const adoption = await c.f.run(planContentAdoption(c.f.adoption))
  expect(adoption).toMatchObject({ state: "planned", page_id: c.f.input.page_id })
  if (!adoption.source_installation)
    throw new Error("The normal CA plan must retain its exact new archive descriptor")
  for (const mode of [c.apply, c.reconcile])
    expect(await mode()).toMatchObject({ phase: "body_verified", reused: true })
  expect(await c.receipt()).toEqual(complete)
  expect(await c.parentReceipt()).toEqual(progressedParent)
  expect(c.f.writes).toHaveLength(9)
  await c.f.assertOriginal()
  c.f.sourceObjectsUnchanged(adoption.source_installation)
}, 180000)

test("a durable pending crash sends nothing; exact BEFORE retains history and only explicit apply retries", async () => {
  const c = await planned()
  c.f.crashAfterPending()
  await failed(c.f, applySourceRootFidelity(c.plan.plan_id, c.plan.plan_hash), "STORAGE_ERROR")
  const pending = await c.receipt()
  expect(pending.phase).toBe("pending")
  expect(c.f.writes).toEqual([])
  expect(await c.reconcile()).toMatchObject({
    phase: "ready",
    completed_effects: 0,
    needs_safe_apply: true,
  })
  expect((await c.receipt()).attempts[0]).toMatchObject({
    ...pending.attempts[0],
    resolution: { outcome: "known_not_applied" },
  })
  expect(c.f.writes).toEqual([])
  c.f.fault("after")
  await failed(
    c.f,
    applySourceRootFidelity(c.plan.plan_id, c.plan.plan_hash),
    "WRITE_OUTCOME_UNKNOWN",
  )
  const next = await c.receipt()
  expect(next.attempts).toHaveLength(2)
  expect(next.attempts[0]?.outcome).toBe("pending")
  expect(next.attempts[0]?.resolution?.outcome).toBe("known_not_applied")
  expect(next.attempts[1]).toMatchObject({ index: 1, effect_index: 0, outcome: "unknown" })
  expect(c.f.writes).toHaveLength(1)
  expect(await c.parentReceipt()).toEqual(c.parent)
  await c.f.assertOriginal()
}, 120000)

test("a lost transport response with exact BEFORE resolves without writing and preserves the unknown attempt", async () => {
  const c = await planned()
  c.f.fault("before")
  await failed(
    c.f,
    applySourceRootFidelity(c.plan.plan_id, c.plan.plan_hash),
    "WRITE_OUTCOME_UNKNOWN",
  )
  const unknown = await c.receipt()
  expect(await c.reconcile()).toMatchObject({ phase: "ready", completed_effects: 0, attempts: 1 })
  expect((await c.receipt()).attempts[0]).toMatchObject({
    ...unknown.attempts[0],
    resolution: { outcome: "known_not_applied" },
  })
  expect(c.f.writes).toHaveLength(1)
  c.f.fault("ack-read")
  await failed(c.f, applySourceRootFidelity(c.plan.plan_id, c.plan.plan_hash), "ACCESS_DENIED")
  const retained = await c.receipt()
  expect(retained.phase).toBe("acknowledged")
  expect(retained.attempts).toHaveLength(2)
  expect(retained.attempts[0]?.outcome).toBe("unknown")
  expect(retained.attempts[0]?.response).toBeUndefined()
  expect(retained.attempts[0]?.resolution?.outcome).toBe("known_not_applied")
  expect(retained.attempts[1]).toMatchObject({ index: 1, effect_index: 0, outcome: "acknowledged" })
  expect(c.f.writes).toHaveLength(2)
  expect(await c.parentReceipt()).toEqual(c.parent)
  await c.f.assertOriginal()
}, 120000)

for (const fault of ["after", "wrong-ack"] as const)
  test(`${fault}: only the adjacent full AFTER may settle an unknown without inventing an ACK`, async () => {
    const c = await planned()
    c.f.fault(fault)
    await failed(
      c.f,
      applySourceRootFidelity(c.plan.plan_id, c.plan.plan_hash),
      fault === "after" ? "WRITE_OUTCOME_UNKNOWN" : "SOURCE_ROOT_FIDELITY_ACK_INVALID",
    )
    const unknown = await c.receipt()
    expect(unknown.attempts[0]?.outcome).toBe("unknown")
    expect(unknown.attempts[0]?.response).toBeUndefined()
    if (fault === "wrong-ack")
      expect(property(unknown.attempts[0]?.untrusted_response).id).not.toBe(
        c.before.plan.effects[0]?.block_id,
      )
    expect(await c.reconcile()).toMatchObject({ phase: "ready", completed_effects: 1, attempts: 1 })
    const resolved = await c.receipt()
    expect(resolved.attempts[0]).toMatchObject({
      ...unknown.attempts[0],
      resolution: { outcome: "observed_applied" },
    })
    expect(resolved.attempts[0]?.response).toBeUndefined()
    expect(resolved.checkpoints).toHaveLength(1)
    expect(c.f.writes).toHaveLength(1)
    expect(await c.parentReceipt()).toEqual(c.parent)
    await c.f.assertOriginal()
    c.f.sourceObjectsUnchanged()
  }, 120000)

for (const fault of ["ack-read", "stale-after"] as const)
  test(`${fault}: a real ACK stays durable and cannot authorize a duplicate send`, async () => {
    const c = await planned()
    c.f.fault(fault)
    await failed(
      c.f,
      applySourceRootFidelity(c.plan.plan_id, c.plan.plan_hash),
      fault === "ack-read" ? "ACCESS_DENIED" : "SOURCE_ROOT_FIDELITY_NOT_CONVERGED",
    )
    const acknowledged = await c.receipt()
    expect(acknowledged).toMatchObject({
      phase: "acknowledged",
      checkpoints: [],
      attempts: [{ outcome: "acknowledged" }],
    })
    expect(acknowledged.attempts).toHaveLength(1)
    expect(c.f.writes).toHaveLength(1)
    if (fault === "stale-after") {
      await failed(
        c.f,
        applySourceRootFidelity(c.plan.plan_id, c.plan.plan_hash),
        "SOURCE_ROOT_FIDELITY_NOT_CONVERGED",
      )
      expect(await c.receipt()).toEqual(acknowledged)
      expect(c.f.writes).toHaveLength(1)
      c.f.revealAfter()
    }
    expect(await c.reconcile()).toMatchObject({ phase: "ready", completed_effects: 1 })
    expect((await c.receipt()).attempts).toEqual(acknowledged.attempts)
    expect(c.f.writes).toHaveLength(1)
    expect(await c.parentReceipt()).toEqual(c.parent)
    await c.f.assertOriginal()
  }, 120000)

for (const fault of ["partial-after", "other-block"] as const)
  test(`${fault}: an ACK plus another changed physical field is a retained conflict`, async () => {
    const c = await planned()
    c.f.fault(fault)
    await failed(
      c.f,
      applySourceRootFidelity(c.plan.plan_id, c.plan.plan_hash),
      "SOURCE_ROOT_FIDELITY_CONFLICT",
    )
    const conflict = await c.receipt()
    expect(conflict.phase).toBe("conflict")
    expect(conflict.attempts[0]?.outcome).toBe("acknowledged")
    expect(conflict.checkpoints).toEqual([])
    await failed(
      c.f,
      reconcileSourceRootFidelity(c.plan.plan_id, c.plan.plan_hash),
      "SOURCE_ROOT_FIDELITY_CONFLICT",
    )
    expect(await c.receipt()).toEqual(conflict)
    expect(c.f.writes).toHaveLength(1)
    expect(await c.parentReceipt()).toEqual(c.parent)
    await c.f.assertOriginal()
  }, 120000)

test("unknown cannot be inferred from a later prefix or a nonadjacent subset", async () => {
  const c = await planned()
  c.f.fault("after")
  await failed(
    c.f,
    applySourceRootFidelity(c.plan.plan_id, c.plan.plan_hash),
    "WRITE_OUTCOME_UNKNOWN",
  )
  c.f.applyUnjournaled(c.before.plan.effects[2]!)
  await failed(
    c.f,
    reconcileSourceRootFidelity(c.plan.plan_id, c.plan.plan_hash),
    "SOURCE_ROOT_FIDELITY_CONFLICT",
  )
  expect((await c.receipt()).checkpoints).toEqual([])
  expect((await c.receipt()).attempts[0]?.resolution).toBeUndefined()
  expect(c.f.writes).toHaveLength(1)
  await c.f.assertOriginal()
}, 120000)

for (const drift of ["parent", "competing-claim"] as const)
  test(`${drift}: the native pending CAS refuses a late durable authority change before any PATCH`, async () => {
    const c = await planned()
    if (drift === "parent") c.f.changeParentBeforePending()
    else c.f.foreignClaimBeforePending()
    await failed(
      c.f,
      applySourceRootFidelity(c.plan.plan_id, c.plan.plan_hash),
      "UPSTREAM_OPERATION_BUSY",
    )
    expect(await c.receipt()).toEqual(c.before)
    expect(c.f.writes).toEqual([])
    if (drift === "parent")
      expect(
        await c.f.run(c.f.native.command(sourceRootCompletionKey(c.f.originalPlan.plan_id, 0))),
      ).toEqual({ ...c.parent, injected: "changed before pending CAS" })
    else expect(await c.parentReceipt()).toEqual(c.parent)
    await c.f.assertOriginal()
  }, 120000)

test("the complete original authority and immutable plan refuse source drift and excess input without claiming a request", async () => {
  const c = await planned()
  await failed(
    c.f,
    planSourceRootFidelity({ ...c.input, block_id: c.before.plan.effects[0]!.block_id }),
    "SOURCE_ROOT_FIDELITY_REFUSED",
  )
  await failed(
    c.f,
    applySourceRootFidelity(c.plan.plan_id, "f".repeat(64)),
    "SOURCE_ROOT_FIDELITY_REFUSED",
  )
  const frozen = c.f.originalPlan.items[0]!.candidate!.files[0]!
  const key = `objects/${frozen.hash}`,
    bytes = c.f.objects.get(key)!
  c.f.objects.set(key, new TextEncoder().encode("different source"))
  await failed(c.f, applySourceRootFidelity(c.plan.plan_id, c.plan.plan_hash))
  c.f.objects.set(key, bytes)
  expect(await c.receipt()).toEqual(c.before)
  expect(c.f.writes).toEqual([])
  expect(await c.parentReceipt()).toEqual(c.parent)
  await c.f.assertOriginal()
  c.f.sourceObjectsUnchanged()
}, 120000)

test("the retry budget is reserved before pending and invalid phase certificates cannot be loaded", async () => {
  const c = await planned(),
    digest = await c.f.run(sha256(canonical(c.before.plan.before)))
  const attempts = Array.from({ length: 10 }, (_, index) => ({
    index,
    effect_index: 0,
    started_at_ms: index * 2,
    request: c.before.plan.effects[0]!.request,
    before_sha256: digest,
    outcome: "unknown" as const,
    failure: {
      code: "WRITE_OUTCOME_UNKNOWN",
      message: "Synthetic already retained no-effect test history",
    },
    resolution: {
      outcome: "known_not_applied" as const,
      observed_at_ms: index * 2 + 1,
      observation: c.before.plan.before,
    },
  }))
  const exhausted = await c.f.run(
    decodeSourceRootFidelity({ ...c.before, phase: "ready", attempts }),
  )
  await c.f.run(c.f.native.claimCommand(c.key, c.before, exhausted))
  await failed(
    c.f,
    applySourceRootFidelity(c.plan.plan_id, c.plan.plan_hash),
    "SOURCE_ROOT_FIDELITY_REFUSED",
  )
  expect(await c.receipt()).toEqual(exhausted)
  expect(c.f.writes).toEqual([])
  await failed(
    c.f,
    decodeSourceRootFidelity({ ...exhausted, phase: "body_verified" }),
    "SOURCE_ROOT_FIDELITY_REFUSED",
  )
  await failed(
    c.f,
    decodeSourceRootFidelity({
      ...exhausted,
      checkpoints: [
        {
          effect_index: 1,
          attempt_index: 0,
          observed_at_ms: 50,
          observation: c.before.plan.before,
        },
      ],
    }),
    "SOURCE_ROOT_FIDELITY_REFUSED",
  )
  expect(await c.parentReceipt()).toEqual(c.parent)
  await c.f.assertOriginal()
}, 120000)
