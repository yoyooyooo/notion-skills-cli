import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect, Option } from "effect"
import { createSkill, replaceSkill, resumePublication, writeSkill } from "../src/mutation.ts"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { snapshotAuthoredPortable, snapshotPortable } from "../src/export.ts"
import { authScope } from "../src/catalog.ts"
import { cachedRemoteObservation } from "../src/cache.ts"
import { PortableSourceDecoder } from "../src/portable-source.ts"
import { bodyIdentity, readPortable } from "../src/portable.ts"
import { withoutCreationMarker } from "../src/publication-create-identity.ts"
import { PublicationReceiptSchema } from "../src/publication-model.ts"
import { publicationMarker } from "../src/publication-integrity.ts"
import { withoutChildPages } from "../src/references.ts"
import {
  blockPatchRecovery,
  metadata,
  publicationPropertiesMatch,
} from "../src/publication-observation.ts"
import { reconcilePublication } from "../src/publication-reconcile.ts"
import {
  publicationBlockReplacementCandidates,
  publicationPropertyReplacementCandidates,
} from "../src/publication-effect-proof.ts"
import { markdownIdentity } from "../src/markdown.ts"
import {
  closeFixtureServers,
  database,
  root,
  encoder,
  fixture,
} from "./reference-import.fixture.ts"

afterAll(closeFixtureServers)

for (const failure of ["registration", "body"] as const) {
  test(`saved publication resumes after ${failure} interruption without duplicate pages and reuses completed content`, async () => {
    const f = fixture(failure)
    const interrupted = await f.run(createSkill("/input", { database }).pipe(Effect.result))
    expect(interrupted._tag === "Failure" && interrupted.failure.code).toBe(
      failure === "body" ? "WRITE_OUTCOME_UNKNOWN" : "WRITE_PARTIAL",
    )
    expect(await f.run(cachedRemoteObservation(root, await f.run(authScope)))).toBeUndefined()
    const originalIds = f.children.map((child) => child.id)
    if (interrupted._tag !== "Failure") throw new Error("Expected publication interruption")
    const completed = await f.run(
      resumePublication(String(property(interrupted.failure.details).operation_id)),
    )
    expect("record" in completed && completed.record.id).toBe(`notion_page:${root}`)
    expect(f.children.map((child) => child.id).slice(0, originalIds.length)).toEqual(originalIds)
    expect(f.children.map((child) => child.title).sort()).toEqual(["guide.md", "policy.md"])
    const guide = await f.run(readSkill(completed.snapshot_id!, { path: "references/guide.md" }))
    expect("content" in guide && guide.content).toContain("[policy](./policy.md)")
    const policy = await f.run(readSkill(completed.snapshot_id!, { path: "references/policy.md" }))
    expect("content" in policy && policy.content).toContain(
      "A consumer must keep original page identities.",
    )
    const before = f.mutations()
    const reused = await f.run(replaceSkill("/input", { database, target: root }))
    expect(reused.action).toBe("reuse")
    const baseline = await f.run(openSkill(root, { refresh: true }))
    const portable = await f.run(snapshotPortable(baseline))
    const equivalent = {
      ...portable,
      files: portable.files.map((file) => ({
        ...file,
        bytes: encoder.encode(new TextDecoder().decode(file.bytes).replaceAll("\n\n", "\n\n\n")),
      })),
    }
    const baselineReuse = await f.run(replaceSkill(equivalent, { target: baseline }))
    expect(baselineReuse.action).toBe("reuse")
    expect(f.mutations()).toBe(before)
  })
}

test("owned References retry preserves no-effect history without pointing at intervening child creation", async () => {
  const f = fixture("registration_unknown")
  await f.run(createSkill("/input", { database }))
  f.input.set(
    "references/additional.md",
    encoder.encode("# Additional\n\nPreserve the original retry audit.\n"),
  )
  f.input.set(
    "references/next.md",
    encoder.encode("# Next\n\nAllocate after the interrupted registration.\n"),
  )
  f.interruptRegistration()
  const interrupted = await f.run(
    replaceSkill("/input", {
      database,
      target: root,
      ownership: {
        subscription_id: "77777777-7777-4777-8777-777777777777",
        member_key: "retry-audit",
        mode: "tracked",
        published_hash: "frozen-retry",
        revision: "1",
      },
    }).pipe(Effect.result),
  )
  if (interrupted._tag !== "Failure") throw new Error("Expected References response loss")
  expect(interrupted.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
  const operationId = String(property(interrupted.failure.details).operation_id)
  const before = f.receipt(operationId)
  const pendingIndex = before.intents.findIndex((intent) => intent.status === "unknown")
  expect(pendingIndex).toBeGreaterThanOrEqual(0)
  const resumed = await f.run(resumePublication(operationId))
  expect(resumed).toMatchObject({ operation_id: operationId, verified: true, resumed: true })
  const receipt = f.receipt(operationId)
  expect(receipt.intents[pendingIndex]).toMatchObject({
    status: "failed",
    response: { prior_status: "unknown", recovery: "known_not_applied" },
  })
  expect(property(receipt.intents[pendingIndex]!.response).replayed_by_intent).toBeUndefined()
  const child = receipt.intents.findIndex(
    (intent, index) =>
      index > pendingIndex && intent.method === "POST" && intent.path === "v1/pages",
  )
  expect(child).toBeGreaterThan(pendingIndex)
  expect(
    receipt.intents.some(
      (intent, index) =>
        index > child &&
        intent.path === `v1/pages/${root}` &&
        property(property(intent.body).properties).references !== undefined,
    ),
  ).toBe(true)
  const writes = f.mutations()
  await f.run(resumePublication(operationId))
  expect(f.mutations()).toBe(writes)
})

for (const changed of [undefined, "body", "metadata", "kind"] as const) {
  test(`acknowledged normalized publication resumes after final verification read failure ${changed ? `and rejects changed ${changed}` : "without extra business PATCHes"}`, async () => {
    const f = fixture(undefined, false, undefined, true)
    if (!changed)
      for (let index = 0; index < 8; index++)
        f.input.set(
          `references/extra-${index}.md`,
          encoder.encode(`First extra instruction ${index}\nRead the policy.\n`),
        )
    await f.run(createSkill("/input", { database }))
    f.propertyWrites.length = 0
    f.input.set(
      "SKILL.md",
      encoder.encode(
        "---\nname: sample-skill\ndescription: Use for recovery.\n---\nFirst instruction\nRead [guide](references/guide.md).\n",
      ),
    )
    f.input.set(
      "references/guide.md",
      encoder.encode("First reference instruction\nRead [policy](./policy.md).\n"),
    )
    f.input.set(
      "references/policy.md",
      encoder.encode("# Policy\n\nUpdated policy instructions.\n"),
    )
    const interrupted = await f.run(
      replaceSkill("/input", {
        database,
        target: root,
        onProgress: (event) =>
          Effect.sync(() => {
            if (event.stage === "verify" && event.status === "started") f.failNextRead()
          }),
      }).pipe(Effect.result),
    )
    expect(interrupted._tag).toBe("Failure")
    if (interrupted._tag !== "Failure") throw new Error("Expected verification interruption")
    expect(interrupted.failure.code).toBe("WRITE_PARTIAL")
    expect(property(interrupted.failure.details).cause_code).toBe("ACCESS_DENIED")
    const operationId = String(property(interrupted.failure.details).operation_id)
    const before = f.receipt(operationId)
    const content = before.intents.filter((intent) => intent.path.endsWith("/markdown"))
    expect(content).toHaveLength(3)
    expect(content.every((intent) => intent.status === "completed")).toBe(true)
    expect(content.every((intent) => intent.typed_links?.state !== "pending")).toBe(true)
    const guideId = f.children.find((child) => child.title === "guide.md")!.id
    const guideIntent = content.find((intent) => intent.path.includes(guideId))!
    expect(bodyIdentity(String(before.guards[guideIntent.path]))).not.toBe(
      bodyIdentity(String(property(property(guideIntent.body).replace_content).new_str)),
    )
    expect(f.propertyWrites.filter((fields) => fields.Publication)).toHaveLength(1)
    const writes = f.mutations()
    const businessWrites = f.businessPatches()
    f.reads.clear()
    if (changed === "body") f.children[0]!.body += "\nExternal body edit.\n"
    if (changed === "metadata") f.changeDescription()
    if (changed === "kind") f.changeKind()
    const resumed = await f.run(
      resumePublication(operationId).pipe(
        Effect.provideService(PortableSourceDecoder, {
          decode: readPortable,
          rewriteSourceArchive: true,
        }),
        Effect.result,
      ),
    )
    expect(f.businessPatches()).toBe(businessWrites)
    if (changed) {
      expect(resumed._tag === "Failure" && resumed.failure.code).toBe("WRITE_CONFLICT")
      expect(f.mutations()).toBe(writes)
      expect(f.propertyWrites.filter((fields) => fields.Publication)).toHaveLength(1)
      expect(f.receipt(operationId).intents).toEqual(before.intents)
      return
    }
    expect(resumed._tag).toBe("Success")
    if (resumed._tag !== "Success") throw new Error("Expected acknowledged publication resume")
    expect(resumed.success).toMatchObject({
      operation_id: operationId,
      verified: true,
      resumed: true,
    })
    expect(f.mutations()).toBe(writes + 1)
    const after = f.receipt(operationId)
    expect(after.operation_id).toBe(operationId)
    expect(after.state).toBe("completed")
    expect(after.intents.slice(0, before.intents.length)).toEqual(before.intents)
    expect(after.intents).toHaveLength(before.intents.length + 1)
    expect(f.propertyWrites.filter((fields) => fields.Publication)).toHaveLength(2)
    const marker = property(f.propertyWrites.at(-1)!.Publication).rich_text as unknown[]
    expect(JSON.parse(String(property(property(marker[0]).text).content))).toMatchObject({
      operation_id: operationId,
      state: "committed",
    })
    const pageReads = [...f.reads.entries()].filter(([path]) => path.endsWith("/markdown"))
    expect(pageReads).toHaveLength(f.children.length + 1)
    // Full recovery/checkpoint/commit graph proofs remain, without two graph reads per body.
    expect(Math.max(...pageReads.map(([, count]) => count))).toBeLessThanOrEqual(32)
    const saved = await f.run(
      readSkill(resumed.success.snapshot_id!, { path: "references/policy.md" }),
    )
    expect("content" in saved && saved.content).toContain("Updated policy instructions.")
    const completedWrites = f.mutations()
    const repeated = await f.run(resumePublication(operationId))
    expect(repeated.operation_id).toBe(operationId)
    expect(f.mutations()).toBe(completedWrites)
  })
}

for (const changed of [
  undefined,
  "body",
  "metadata",
  "resource",
  "unknown",
  "unsupported",
] as const) {
  test(`public reconcile reassesses historical select conflict ${changed ?? "and preserves its audit through same-operation resume"}`, async () => {
    const f = fixture(undefined, false, undefined, true)
    for (let index = 0; index < 7; index++)
      f.input.set(
        `references/extra-${index}.md`,
        encoder.encode(`# Extra ${index}\n\nOriginal instructions.\n`),
      )
    await f.run(createSkill("/input", { database }))
    for (const [path, bytes] of f.input)
      f.input.set(
        path,
        encoder.encode(
          new TextDecoder()
            .decode(bytes)
            .replaceAll("Use for recovery.", "Use for fence recovery.") +
            "\n\nUpdated instructions for fence recovery.\n",
        ),
      )
    const interrupted = await f.run(
      replaceSkill("/input", {
        database,
        target: root,
        onProgress: (event) =>
          Effect.sync(() => {
            if (event.stage === "verify" && event.status === "started") f.failNextRead()
          }),
      }).pipe(Effect.result),
    )
    if (interrupted._tag !== "Failure")
      throw new Error("Expected real final verification interruption")
    const operationId = String(property(interrupted.failure.details).operation_id)
    const original = f.receipt(operationId)
    expect(original.intents).toHaveLength(13)
    expect(original.intents.every((intent) => intent.status === "completed")).toBe(true)
    // Historical runtime compared the entire returned select object to { name }.
    // Seed only its durable failure on the real interrupted operation, never runtime behavior.
    const historical = {
      ...original,
      conflict: true,
      state: "failed" as const,
      failure: {
        code: "WRITE_CONFLICT",
        message: "Exact saved property content has not converged.",
        details: { comparator: "whole_select_response" },
      },
    }
    if (changed === "unknown") historical.intents.at(-1)!.status = "unknown"
    if (changed === "unsupported")
      historical.intents[0] = { ...historical.intents[0]!, method: "GET" }
    await f.run(
      Effect.gen(function* () {
        yield* (yield* Store).writeJson(`publications/${operationId}.json`, historical)
      }),
    )
    if (changed === "body") f.children[0]!.body += "\nExternal body edit.\n"
    if (changed === "metadata") f.changeKind()
    if (changed === "resource") f.changeResource()
    const mutations = f.mutations()
    const business = f.businessPatches()
    const ids = f.children.map((child) => child.id)
    f.reads.clear()
    const reconciled = await f.run(reconcilePublication(operationId))
    expect(f.mutations()).toBe(mutations)
    for (const path of Object.keys(historical.guards))
      expect(f.reads.get(path) ?? 0).toBeGreaterThan(0)
    const reassessed = f.receipt(operationId)
    expect(reassessed.intents).toEqual(historical.intents)
    expect(reassessed.failure).toEqual(historical.failure)
    expect(reassessed.stages).toEqual(historical.stages)
    if (changed) {
      // An unsupported intent cannot prove convergence; the existing fence still blocks resume.
      expect(reconciled.outcome).toBe(changed === "unsupported" ? "unknown" : "conflict")
      expect(reassessed.conflict).toBe(true)
      expect(reassessed.conflict_history).toBeUndefined()
      const refused = await f.run(resumePublication(operationId).pipe(Effect.result))
      expect(refused._tag === "Failure" && refused.failure.code).toBe("WRITE_CONFLICT")
      expect(f.mutations()).toBe(mutations)
      return
    }
    expect(["success", "needs_safe_commit"]).toContain(reconciled.outcome)
    expect(reassessed.conflict).toBeUndefined()
    expect(reassessed.conflict_history).toEqual([
      {
        observed_at_ms: expect.any(Number),
        conflict: true,
        state: historical.state,
        stages: historical.stages,
        failure: historical.failure,
        guard_paths: Object.keys(historical.guards),
        intent_count: 13,
        intended_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ])
    const resumed = await f.run(resumePublication(operationId))
    expect(resumed).toMatchObject({ operation_id: operationId, verified: true, resumed: true })
    expect(f.businessPatches()).toBe(business)
    expect(f.children.map((child) => child.id)).toEqual(ids)
    const completed = f.receipt(operationId)
    expect(completed.intents.slice(0, original.intents.length)).toEqual(historical.intents)
    expect(completed.conflict_history).toEqual(reassessed.conflict_history)
  })
}

for (const changed of [undefined, "notice", "single_quote"] as const) {
  test(`public reconcile proves quote sibling boundary ${changed ?? "and resumes without duplicate bodies"}`, async () => {
    const f = fixture(undefined, false, undefined, false, true)
    f.input.set(
      "SKILL.md",
      encoder.encode(
        "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nOriginal root instructions.\n",
      ),
    )
    f.input.set("references/guide.md", encoder.encode("# Guide\n\nOriginal guide instructions.\n"))
    await f.run(createSkill("/input", { database }))
    f.input.set(
      "references/policy.md",
      encoder.encode("# Policy\n\n> 保留日历操作的原始授权。\n\n注意：保留原始边界。\n"),
    )
    const interrupted = await f.run(
      replaceSkill("/input", {
        database,
        target: root,
        onProgress: (event) =>
          Effect.sync(() => {
            if (event.stage === "verify" && event.status === "started") f.failNextRead()
          }),
      }).pipe(Effect.result),
    )
    if (interrupted._tag !== "Failure") throw new Error("Expected final verification interruption")
    expect(property(interrupted.failure.details).cause_code).toBe("ACCESS_DENIED")
    const operationId = String(property(interrupted.failure.details).operation_id)
    const original = f.receipt(operationId)
    expect(original.intents.every((intent) => intent.status === "completed")).toBe(true)
    const policy = f.children.find((child) => child.title === "policy.md")!
    const path = `v1/pages/${policy.id}/markdown`
    const intent = original.intents.findLast((intent) => intent.path === path)!
    const target = String(property(property(intent.body).replace_content).new_str)
    expect(String(original.guards[path])).toContain(
      "> 保留日历操作的原始授权。\n注意：保留原始边界。",
    )
    expect(markdownIdentity(String(original.guards[path]))).not.toBe(markdownIdentity(target))
    const historical = {
      ...original,
      state: "failed" as const,
      conflict: true,
      failure: { code: "WRITE_CONFLICT", message: "Historical quote boundary comparison." },
    }
    await f.run(
      Effect.gen(function* () {
        yield* (yield* Store).writeJson(`publications/${operationId}.json`, historical)
      }),
    )
    if (changed === "notice") f.changeNotice()
    if (changed === "single_quote") f.collapseQuote()
    const mutations = f.mutations()
    const business = f.businessPatches()
    const ids = f.children.map((child) => child.id)
    f.reads.clear()
    const reconciled = await f.run(reconcilePublication(operationId))
    expect(f.mutations()).toBe(mutations)
    const reassessed = f.receipt(operationId)
    expect(reassessed.guards).toEqual(historical.guards)
    expect(reassessed.intents).toEqual(historical.intents)
    expect(reassessed.failure).toEqual(historical.failure)
    expect(reassessed.stages).toEqual(historical.stages)
    if (changed) {
      expect(reconciled.outcome).toBe("conflict")
      expect(reassessed.conflict).toBe(true)
      expect(reassessed.conflict_history).toBeUndefined()
      const refused = await f.run(resumePublication(operationId).pipe(Effect.result))
      expect(refused._tag === "Failure" && refused.failure.code).toBe("WRITE_CONFLICT")
      expect(f.mutations()).toBe(mutations)
      return
    }
    expect(["success", "needs_safe_commit"]).toContain(reconciled.outcome)
    expect(reassessed.conflict).toBeUndefined()
    expect(reassessed.conflict_history?.[0]).toMatchObject({
      intended_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      intent_count: historical.intents.length,
      guard_paths: Object.keys(historical.guards),
    })
    expect(f.reads.get(`v1/blocks/${policy.id}/children?page_size=100`)).toBe(1)
    const resumed = await f.run(resumePublication(operationId))
    expect(resumed).toMatchObject({ operation_id: operationId, verified: true, resumed: true })
    expect(f.businessPatches()).toBe(business)
    expect(f.children.map((child) => child.id)).toEqual(ids)
    const completed = f.receipt(operationId)
    expect(completed.intents.slice(0, historical.intents.length)).toEqual(historical.intents)
    expect(
      completed.intents
        .slice(historical.intents.length)
        .filter((intent) => intent.path.endsWith("/markdown")),
    ).toHaveLength(0)
    expect(completed.conflict_history).toEqual(reassessed.conflict_history)
  })
}

for (const changed of [undefined, "body", "block", "unknown", "missing_body_proof"] as const) {
  test(`public reconcile proves completed typed block checkpoint ${changed ?? "and resumes without repeating the repair"}`, async () => {
    const f = fixture(undefined, false, undefined, false, false, true)
    f.input.set(
      "SKILL.md",
      encoder.encode(
        "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nOriginal root instructions.\n",
      ),
    )
    f.input.set("references/guide.md", encoder.encode("# Guide\n\nOriginal guide instructions.\n"))
    await f.run(createSkill("/input", { database }))
    f.input.set(
      "references/guide.md",
      encoder.encode("# Guide\n\nRead [policy](./policy.md#policy).\n"),
    )
    const interrupted = await f.run(
      replaceSkill("/input", {
        database,
        target: root,
        onProgress: (event) =>
          Effect.sync(() => {
            if (event.stage === "verify" && event.status === "started") f.failNextRead()
          }),
      }).pipe(Effect.result),
    )
    if (interrupted._tag !== "Failure") throw new Error("Expected final verification interruption")
    expect(property(interrupted.failure.details).cause_code).toBe("ACCESS_DENIED")
    const operationId = String(property(interrupted.failure.details).operation_id)
    const original = f.receipt(operationId)
    const guide = f.children.find((child) => child.title === "guide.md")!
    const bodyPath = `v1/pages/${guide.id}/markdown`
    const replacementIndex = original.intents.findLastIndex((intent) => intent.path === bodyPath)
    const blockIndex = original.intents.findIndex((intent) =>
      /^v1\/blocks\/[^/]+$/.test(intent.path),
    )
    expect(blockIndex).toBeGreaterThan(replacementIndex)
    const blockIntent = original.intents[blockIndex]!
    expect(original.intents.every((intent) => intent.status === "completed")).toBe(true)
    expect(original.intents[replacementIndex]).toMatchObject({
      typed_links: { state: "completed" },
    })
    expect(String(blockIntent.guards?.[bodyPath])).toContain("https://app.notion.com/p/")
    expect(String(original.guards[bodyPath])).toContain("#ntn-skills-path=")
    expect(blockIntent.guards?.[bodyPath]).not.toBe(original.guards[bodyPath])
    // Matching final guards cannot authorize an unknown effect through the pending path.
    expect(
      blockPatchRecovery({ ...blockIntent, status: "unknown" }, original, original.guards).outcome,
    ).toBe("conflict")
    const historical = structuredClone({
      ...original,
      state: "failed" as const,
      conflict: true,
      failure: { code: "WRITE_CONFLICT", message: "Historical completed block owner comparison." },
    })
    if (changed === "unknown") historical.intents[blockIndex]!.status = "unknown"
    if (changed === "missing_body_proof") historical.intents.splice(replacementIndex, 1)
    await f.run(
      Effect.gen(function* () {
        yield* (yield* Store).writeJson(`publications/${operationId}.json`, historical)
      }),
    )
    if (changed === "body") guide.body += "\nExternal owner instruction.\n"
    if (changed === "block") {
      const block = f.blocks.get(blockIntent.path.split("/")[2]!)!
      block.paragraph = { rich_text: [{ type: "text", text: { content: "External block edit" } }] }
    }
    const mutations = f.mutations()
    const business = f.businessPatches()
    const reconciled = await f.run(reconcilePublication(operationId))
    expect(f.mutations()).toBe(mutations)
    const reassessed = f.receipt(operationId)
    expect(reassessed.guards).toEqual(historical.guards)
    expect(reassessed.intents).toEqual(historical.intents)
    expect(reassessed.failure).toEqual(historical.failure)
    expect(reassessed.stages).toEqual(historical.stages)
    if (changed) {
      expect(["unknown", "conflict"]).toContain(reconciled.outcome)
      expect(reassessed.conflict).toBe(true)
      expect(reassessed.conflict_history).toBeUndefined()
      const refused = await f.run(resumePublication(operationId).pipe(Effect.result))
      expect(refused._tag === "Failure" && refused.failure.code).toBe("WRITE_CONFLICT")
      expect(f.mutations()).toBe(mutations)
      return
    }
    expect(["success", "needs_safe_commit"]).toContain(reconciled.outcome)
    expect(reassessed.conflict).toBeUndefined()
    expect(reassessed.conflict_history?.[0]).toMatchObject({
      intended_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      intent_count: historical.intents.length,
      guard_paths: Object.keys(historical.guards),
    })
    const resumed = await f.run(resumePublication(operationId))
    expect(resumed).toMatchObject({ operation_id: operationId, verified: true, resumed: true })
    expect(f.businessPatches()).toBe(business)
    const completed = f.receipt(operationId)
    expect(completed.intents.slice(0, historical.intents.length)).toEqual(historical.intents)
    expect(
      completed.intents
        .slice(historical.intents.length)
        .filter(
          (intent) => intent.path.endsWith("/markdown") || intent.path.startsWith("v1/blocks/"),
        ),
    ).toHaveLength(0)
    expect(completed.conflict_history).toEqual(reassessed.conflict_history)
  })
}

for (const changed of [
  undefined,
  "unfenced",
  "failed",
  "pending",
  "different_page",
  "different_body",
  "partial",
  "later_partial",
  "untraceable_parent",
  "response_id",
  "archive",
  "body",
  "source",
  "unknown_block",
  "pagination",
  "property_history",
  "property_no_disposition",
  "property_unknown",
  "property_partial",
  "property_owner",
  "property_latest_failed",
  "property_unproven_child",
  "property_current",
] as const) {
  test(`public reconcile proves historical block replacement coverage ${changed ?? "without obsolete block reads or replay"}`, async () => {
    const f = fixture(undefined, false, undefined, false, true)
    const propertyHistory = changed?.startsWith("property_") === true
    let propertyHistoryIndex = -1
    f.input.set(
      "SKILL.md",
      encoder.encode(
        "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nOriginal root instructions.\n",
      ),
    )
    f.input.set("references/guide.md", encoder.encode("# Guide\n\nOriginal guide instructions.\n"))
    if (propertyHistory)
      for (let extra = 0; extra < 11; extra++)
        f.input.set(
          `references/existing-${extra}.md`,
          encoder.encode(`# Existing ${extra}\n\nOriginal instructions.\n`),
        )
    await f.run(createSkill("/input", { database }))
    if (propertyHistory)
      f.input.set(
        "references/new-child.md",
        encoder.encode("# New child\n\nCurrent frozen instructions.\n"),
      )
    const policy = f.children.find((child) => child.title === "policy.md")!
    const table = "55555555-5555-4555-8555-555555555555"
    const row = "66666666-6666-4666-8666-666666666666"
    const rowPath = `v1/blocks/${row}`
    const bodyPath = `v1/pages/${policy.id}/markdown`
    f.blocks.set(table, {
      id: table,
      type: "table",
      parent: { type: "page_id", page_id: policy.id },
      has_children: true,
      table: { table_width: 1, has_column_header: false, has_row_header: false },
    })
    f.blocks.set(row, {
      id: row,
      type: "table_row",
      parent: { type: "block_id", block_id: table },
      has_children: false,
      table_row: { cells: [[{ type: "text", text: { content: "Original literal" } }]] },
    })
    f.input.set(
      "references/policy.md",
      encoder.encode("# Policy\n\n> 保留日历操作的原始授权。\n\n注意：保留原始边界。\n"),
    )
    let repaired = false
    const interrupted = await f.run(
      replaceSkill("/input", {
        database,
        target: root,
        onProgress: (event) =>
          Effect.gen(function* () {
            if (
              propertyHistory &&
              event.stage === "create_reference:references/new-child.md" &&
              event.status === "started"
            ) {
              const api = yield* Effect.serviceOption(Notion)
              if (Option.isNone(api))
                return yield* Effect.fail(
                  fail("UNEXPECTED", "Fixture property history requires the active session."),
                )
              const rootPage = yield* api.value.request(`v1/pages/${root}`)
              const refs = property(property(property(rootPage).properties).References)
                .rich_text as unknown[]
              yield* api.value.request(
                `v1/pages/${root}`,
                {
                  properties: {
                    references: {
                      rich_text: refs.map((item) => ({ type: "text", text: property(item).text })),
                    },
                  },
                },
                { method: "PATCH" },
              )
              propertyHistoryIndex = f.receipt(event.operation_id).intents.length - 1
            }
            if (
              event.stage === "body:references/policy.md" &&
              event.status === "started" &&
              !repaired
            ) {
              repaired = true
              const api = yield* Effect.serviceOption(Notion)
              if (Option.isNone(api))
                return yield* Effect.fail(
                  fail(
                    "UNEXPECTED",
                    "Fixture block repair requires the active publication session.",
                  ),
                )
              yield* api.value.request(
                rowPath,
                {
                  table_row: { cells: [[{ type: "text", text: { content: "Repaired literal" } }]] },
                },
                { method: "PATCH" },
              )
            }
            if (event.stage === "verify" && event.status === "started") f.failNextRead()
          }),
      }).pipe(Effect.result),
    )
    if (interrupted._tag !== "Failure") throw new Error("Expected final verification interruption")
    expect(property(interrupted.failure.details).cause_code).toBe("ACCESS_DENIED")
    const operationId = String(property(interrupted.failure.details).operation_id)
    const original = f.receipt(operationId)
    const index = original.intents.findIndex((intent) => intent.path === rowPath)
    const replacementIndex = original.intents.findLastIndex((intent) => intent.path === bodyPath)
    expect(repaired).toBe(true)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(replacementIndex).toBeGreaterThan(index)
    expect(original.intents[index]).toMatchObject({ status: "completed", response: { id: row } })
    expect(original.intents[index]!.guards?.[rowPath]).toBeDefined()
    expect(original.intents[index]!.guards?.[`v1/blocks/${table}`]).toBeDefined()
    expect(original.guards[rowPath]).toBeUndefined()
    expect(original.guards[`v1/blocks/${table}`]).toBeUndefined()
    expect(f.blocks.has(row)).toBe(false)
    const historical = {
      ...original,
      conflict: changed !== "unfenced",
      state: "failed" as const,
      failure: {
        code: "WRITE_CONFLICT",
        message: "Historical acknowledged block guard was invalidated by whole-body replacement.",
      },
    }
    let propertyReplacementIndex = -1
    if (propertyHistory) {
      const failed = historical.intents[propertyHistoryIndex]!
      expect(
        (
          property(property(property(failed.body).properties).references).rich_text as unknown[]
        ).filter((entry) => property(property(entry).text).content !== "\n"),
      ).toHaveLength(13)
      failed.status = changed === "property_unknown" ? "unknown" : "failed"
      failed.response =
        changed === "property_no_disposition"
          ? {}
          : {
              prior_status: "unknown",
              recovery: "known_not_applied",
              replayed_by_intent: propertyHistoryIndex + 1,
            }
      propertyReplacementIndex = historical.intents.findLastIndex(
        (intent) =>
          intent.method === "PATCH" &&
          intent.path === `v1/pages/${root}` &&
          "references" in property(property(intent.body).properties),
      )
      const latest = historical.intents[propertyReplacementIndex]!
      expect(
        (
          property(property(property(latest.body).properties).references).rich_text as unknown[]
        ).filter((entry) => property(property(entry).text).content !== "\n"),
      ).toHaveLength(14)
      if (changed === "property_partial")
        historical.intents[propertyReplacementIndex] = {
          ...latest,
          body: { properties: { references: { rich_text: [], append: true } } },
        }
      if (changed === "property_owner")
        historical.intents[propertyHistoryIndex] = { ...failed, path: `v1/pages/${policy.id}` }
      if (changed === "property_latest_failed") latest.status = "failed"
      if (changed === "property_unproven_child") {
        const createdIndex = historical.intents.findIndex(
          (intent) =>
            intent.method === "POST" && property(property(intent.body).parent).page_id === root,
        )
        const created = historical.intents[createdIndex]!
        historical.intents[createdIndex] = {
          ...created,
          body: { ...property(created.body), parent: { page_id: policy.id } },
        }
      }
      expect(publicationPropertyReplacementCandidates(historical)).toHaveLength(
        changed === "property_history" || changed === "property_current" ? 1 : 0,
      )
    }
    const blockIntent = historical.intents[index]!
    const replacement = historical.intents[replacementIndex]!
    if (changed === "failed" || changed === "pending") replacement.status = changed
    if (changed === "different_page")
      historical.intents[replacementIndex] = {
        ...replacement,
        path: `v1/pages/${f.children[0]!.id}/markdown`,
        response: { id: f.children[0]!.id },
      }
    if (changed === "different_body")
      historical.intents[replacementIndex] = {
        ...replacement,
        body: {
          ...property(replacement.body),
          replace_content: { new_str: "# Unrelated replacement\n" },
        },
      }
    if (changed === "partial" || changed === "later_partial") {
      const partial = {
        ...replacement,
        body: {
          markdown_version: "v2",
          type: "update_content",
          update_content: { content_updates: [{ old_str: "before", new_str: "after" }] },
        },
      }
      if (changed === "partial") historical.intents[replacementIndex] = partial
      else historical.intents.push(partial)
    }
    if (changed === "untraceable_parent")
      historical.intents[index] = {
        ...blockIntent,
        guards: { ...blockIntent.guards, [`v1/blocks/${table}`]: undefined },
      }
    if (changed === "response_id") blockIntent.response = { id: table }
    if (changed === "archive")
      historical.intents[index] = {
        ...blockIntent,
        body: { ...property(blockIntent.body), archived: true },
      }
    if (changed === "source")
      historical.intents[index] = {
        ...blockIntent,
        guards: {
          ...blockIntent.guards,
          [`v1/pages/${root}`]: {
            ...property(blockIntent.guards?.[`v1/pages/${root}`]),
            parent: { type: "data_source_id", data_source_id: "another-source" },
          },
        },
      }
    const expectedCoverage =
      changed === undefined ||
      changed === "unfenced" ||
      changed === "body" ||
      changed === "different_body" ||
      changed === "unknown_block" ||
      changed === "pagination" ||
      changed === "property_history" ||
      changed === "property_current"
    expect(publicationBlockReplacementCandidates(historical)).toHaveLength(expectedCoverage ? 1 : 0)
    await f.run(
      Effect.gen(function* () {
        yield* (yield* Store).writeJson(`publications/${operationId}.json`, historical)
      }),
    )
    if (changed === "body") policy.body += "\nExternal edit after replacement.\n"
    if (changed === "property_current") f.changeDescription()
    if (changed === "unknown_block")
      f.blocks.set("future-block", {
        id: "future-block",
        type: "unsupported_future",
        has_children: false,
        parent: { type: "page_id", page_id: policy.id },
        unsupported_future: {},
      })
    if (changed === "pagination")
      f.inventories.set(`v1/blocks/${policy.id}/children?page_size=100`, {
        results: [],
        has_more: true,
        next_cursor: null,
      })
    const mutations = f.mutations()
    const business = f.businessPatches()
    f.reads.clear()
    const reconciled = await f.run(reconcilePublication(operationId))
    expect(f.mutations()).toBe(mutations)
    const reassessed = f.receipt(operationId)
    expect(reassessed.intents).toEqual(historical.intents)
    expect(reassessed.guards).toEqual(historical.guards)
    expect(reassessed.failure).toEqual(historical.failure)
    expect(reassessed.stages).toEqual(historical.stages)
    if (changed && changed !== "unfenced" && changed !== "property_history") {
      expect(["unknown", "conflict"]).toContain(reconciled.outcome)
      expect(reassessed.conflict).toBe(true)
      expect(reassessed.conflict_history).toBeUndefined()
      expect(
        reconciled.observations.some((item) => item.path === rowPath && item.outcome === "success"),
      ).toBe(false)
      return
    }
    expect(["success", "needs_safe_commit"]).toContain(reconciled.outcome)
    expect(f.reads.get(rowPath) ?? 0).toBe(0)
    expect(f.reads.get(`v1/blocks/${table}`) ?? 0).toBe(0)
    expect(reconciled.observations).toContainEqual({
      path: rowPath,
      outcome: "success",
      intent_index: index,
      covered_by_intent_index: replacementIndex,
      reason: `Acknowledged block intent ${index} covered by completed whole-page replacement intent ${replacementIndex}.`,
    })
    if (propertyHistory)
      expect(reconciled.observations).toContainEqual({
        path: `v1/pages/${root}`,
        outcome: "success",
        intent_index: propertyHistoryIndex,
        covered_by_intent_index: propertyReplacementIndex,
        property_id: "references",
        reason: `Terminal no-effect property intent ${propertyHistoryIndex} covered_by_completed_property_replacement:${propertyReplacementIndex}.`,
      })
    if (changed === "unfenced") expect(reassessed.conflict).toBe(false)
    else expect(reassessed.conflict).toBeUndefined()
    expect(f.reads.get(`v1/blocks/${policy.id}/children?page_size=100`)).toBe(1)
    const resumed = await f.run(resumePublication(operationId))
    expect(resumed).toMatchObject({ operation_id: operationId, verified: true, resumed: true })
    expect(f.businessPatches()).toBe(business)
    expect(f.reads.get(rowPath) ?? 0).toBe(0)
    const completed = f.receipt(operationId)
    expect(completed.intents.slice(0, historical.intents.length)).toEqual(historical.intents)
    expect(completed.conflict_history).toEqual(reassessed.conflict_history)
  })
}

for (const changedCreation of [
  false,
  true,
  "acknowledged",
  "ack_other_page",
  "ack_parent",
  "ack_marker",
  "ack_incomplete",
  "ack_multiple",
  "ack_unknown",
  "child_acknowledged",
  "child_unknown",
  "child_missing_id",
  "child_duplicate",
  "child_parent",
  "child_title",
  "child_binding",
  "child_nonce",
] as const) {
  test(`public reconcile joins original root create proof with unbound integrity ${changedCreation === false ? "through same-operation resume" : changedCreation === true ? "and refuses changed creation" : changedCreation}`, async () => {
    const f = fixture(undefined, false, undefined, true)
    const interrupted = await f.run(
      createSkill("/input", {
        database,
        onProgress: (event) =>
          Effect.sync(() => {
            if (event.stage === "verify" && event.status === "started") f.failNextRead()
          }),
      }).pipe(Effect.result),
    )
    if (interrupted._tag !== "Failure")
      throw new Error("Expected real create verification interruption")
    const operationId = String(property(interrupted.failure.details).operation_id)
    const original = f.receipt(operationId)
    expect(original.operation).toBe("create")
    expect(original.intents.every((intent) => intent.status === "completed")).toBe(true)
    const roots = original.intents.filter(
      (intent) =>
        intent.path === "v1/pages" &&
        property(property(intent.body).parent).data_source_id === "ds",
    )
    expect(roots).toHaveLength(1)
    expect(property(roots[0]!.response).id).toBe(root)
    const integrity = await f.run(
      Effect.gen(function* () {
        return yield* (yield* Store).integrity.inspect(operationId)
      }),
    )
    expect(integrity?.page_id).toBeUndefined()
    expect(property(integrity?.marker).creation).toBeUndefined()
    const historical = {
      ...original,
      state: "failed" as const,
      conflict: true,
      failure: { code: "WRITE_CONFLICT", message: "Historical whole-select response comparison." },
    }
    const acknowledged =
      typeof changedCreation === "string" && !changedCreation.startsWith("child_")
    if (acknowledged) {
      const rootIndex = historical.intents.indexOf(roots[0]!)
      const rootIntent = historical.intents[rootIndex]!
      const body = structuredClone(property(rootIntent.body))
      const fields = property(body.properties)
      const marker = structuredClone(integrity!.marker)
      fields.Publication = {
        rich_text: [{ type: "text", text: { content: JSON.stringify(marker) } }],
      }
      historical.intents[rootIndex] = { ...rootIntent, body }
      f.setPublication(marker)
      const rootGuard = property(historical.guards[`v1/pages/${root}`])
      historical.guards[`v1/pages/${root}`] = metadata({
        ...rootGuard,
        properties: {
          ...property(rootGuard.properties),
          Publication: {
            id: "Publication",
            type: "rich_text",
            rich_text: [
              {
                type: "text",
                text: { content: JSON.stringify(marker) },
                plain_text: JSON.stringify(marker),
              },
            ],
          },
        },
      })
      if (changedCreation === "ack_other_page")
        historical.intents[rootIndex]!.response = { id: f.children[0]!.id }
      if (changedCreation === "ack_parent") body.parent = { data_source_id: "another-source" }
      if (changedCreation === "ack_marker") {
        const extra = { ...marker, base_revision: "a".repeat(64) }
        f.setPublication(extra)
        const guard = property(historical.guards[`v1/pages/${root}`])
        historical.guards[`v1/pages/${root}`] = metadata({
          ...guard,
          properties: {
            ...property(guard.properties),
            Publication: {
              id: "Publication",
              type: "rich_text",
              rich_text: [
                {
                  type: "text",
                  text: { content: JSON.stringify(extra) },
                  plain_text: JSON.stringify(extra),
                },
              ],
            },
          },
        })
      }
      if (changedCreation === "ack_incomplete") delete body.properties
      if (changedCreation === "ack_multiple")
        historical.intents.push(structuredClone(historical.intents[rootIndex]!))
      if (changedCreation === "ack_unknown") historical.intents[rootIndex]!.status = "unknown"
    }
    const childAcknowledged =
      typeof changedCreation === "string" && changedCreation.startsWith("child_")
    let acknowledgedChildIndex = -1
    if (childAcknowledged) {
      for (const [index, intent] of historical.intents.entries()) {
        if (intent.method !== "POST" || property(property(intent.body).parent).page_id !== root)
          continue
        acknowledgedChildIndex = acknowledgedChildIndex < 0 ? index : acknowledgedChildIndex
        const id = String(property(intent.response).id)
        const body = structuredClone(property(intent.body))
        const current = f.children.find((child) => child.id === id)!
        if (changedCreation !== "child_nonce") body.children = []
        current.body = withoutCreationMarker(current.body)
        historical.guards[`v1/pages/${id}/markdown`] = withoutCreationMarker(
          String(historical.guards[`v1/pages/${id}/markdown`]),
        )
        historical.intents[index] = { ...intent, body }
        for (const [bodyIndex, bodyIntent] of historical.intents.entries()) {
          if (bodyIntent.path !== `v1/pages/${id}/markdown`) continue
          const payload = structuredClone(property(bodyIntent.body))
          const replacement = property(payload.replace_content)
          if (typeof replacement.new_str === "string")
            replacement.new_str = withoutCreationMarker(replacement.new_str)
          historical.intents[bodyIndex] = { ...bodyIntent, body: payload }
        }
      }
      const child = historical.intents[acknowledgedChildIndex]!
      if (changedCreation === "child_unknown") child.status = "unknown"
      if (changedCreation === "child_missing_id") child.response = {}
      if (changedCreation === "child_duplicate") historical.intents.push(structuredClone(child))
      if (changedCreation === "child_parent")
        historical.intents[acknowledgedChildIndex] = {
          ...child,
          body: { ...property(child.body), parent: { page_id: f.children[1]!.id } },
        }
      if (changedCreation === "child_title")
        historical.intents[acknowledgedChildIndex] = {
          ...child,
          body: {
            ...property(child.body),
            properties: { title: { title: [{ text: { content: "wrong.md" } }] } },
          },
        }
      if (changedCreation === "child_binding") {
        const guard = property(historical.guards[`v1/pages/${root}`])
        const refs = property(property(guard.properties).References)
        refs.rich_text = (refs.rich_text as unknown[]).map((raw) => {
          const item = structuredClone(property(raw))
          if (property(item.text).content === "references/guide.md")
            item.text = { ...property(item.text), content: "references/wrong.md" }
          return item
        })
      }
    }
    if (changedCreation === true) {
      const rootIntent = historical.intents.find((intent) => intent === roots[0])!
      const body = structuredClone(property(rootIntent.body))
      const publication = property(property(body.properties).Publication)
      const marker = JSON.parse(
        String(property(property((publication.rich_text as unknown[])[0]).text).content),
      )
      marker.creation.operation_token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      publication.rich_text = [{ type: "text", text: { content: JSON.stringify(marker) } }]
      historical.intents[historical.intents.indexOf(rootIntent)] = { ...rootIntent, body }
    }
    await f.run(
      Effect.gen(function* () {
        yield* (yield* Store).writeJson(`publications/${operationId}.json`, historical)
      }),
    )
    const mutations = f.mutations()
    const business = f.businessPatches()
    f.reads.clear()
    const reconciled = await f.run(reconcilePublication(operationId))
    expect(f.mutations()).toBe(mutations)
    for (const path of Object.keys(historical.guards))
      expect(f.reads.get(path) ?? 0).toBeGreaterThan(0)
    const reassessed = f.receipt(operationId)
    expect(reassessed.intents).toEqual(historical.intents)
    expect(reassessed.failure).toEqual(historical.failure)
    expect(reassessed.stages).toEqual(historical.stages)
    if (
      changedCreation !== false &&
      changedCreation !== "acknowledged" &&
      changedCreation !== "child_acknowledged"
    ) {
      // Unsettled journals retain the fence; a changed binding violates a live guard.
      // Other cases lack valid creation proof without proving a remote content change.
      const unsettled = changedCreation === "ack_unknown" || changedCreation === "child_unknown"
      const changedGuard = changedCreation === "child_binding"
      expect(reconciled.outcome).toBe(unsettled || changedGuard ? "conflict" : "unknown")
      expect(reassessed.conflict).toBe(true)
      expect(reassessed.conflict_history).toBeUndefined()
      const refused = await f.run(resumePublication(operationId).pipe(Effect.result))
      expect(refused._tag === "Failure" && refused.failure.code).toBe("WRITE_CONFLICT")
      expect(f.mutations()).toBe(mutations)
      return
    }
    expect(["success", "needs_safe_commit"]).toContain(reconciled.outcome)
    expect(reassessed.conflict).toBeUndefined()
    if (acknowledged)
      expect(reconciled.observations).toContainEqual({
        path: `v1/pages/${root}`,
        outcome: "success",
        intent_index: 0,
        proof_kind: "acknowledged_root_create",
        reason:
          "acknowledged_root_create: completed root intent 0 retains its exact original marker and source identity.",
      })
    if (childAcknowledged)
      expect(reconciled.observations).toContainEqual({
        path: `v1/pages/${String(property(historical.intents[acknowledgedChildIndex]!.response).id)}`,
        outcome: "success",
        intent_index: acknowledgedChildIndex,
        proof_kind: "acknowledged_child_create",
        reason: `acknowledged_child_create: completed child intent ${acknowledgedChildIndex} retains its exact original parent and References binding.`,
      })
    expect(reassessed.conflict_history?.[0]?.failure).toEqual(historical.failure)
    const resumed = await f.run(resumePublication(operationId))
    expect(resumed).toMatchObject({ operation_id: operationId, verified: true, resumed: true })
    expect(f.businessPatches()).toBe(business)
    expect(f.receipt(operationId).conflict_history).toEqual(reassessed.conflict_history)
    expect(f.receipt(operationId).intents.slice(0, historical.intents.length)).toEqual(
      historical.intents,
    )
  })
}

for (const [label, actual, requested, matches] of [
  [
    "name with server fields",
    { id: "option-skill", name: "skill", color: "default" },
    { name: "skill" },
    true,
  ],
  [
    "changed name",
    { id: "option-skill", name: "prompt", color: "default" },
    { name: "skill" },
    false,
  ],
  [
    "requested ID",
    { id: "option-skill", name: "skill", color: "default" },
    { id: "option-skill" },
    true,
  ],
  ["wrong ID", { id: "other", name: "skill", color: "default" }, { id: "option-skill" }, false],
  [
    "name and ID",
    { id: "option-skill", name: "skill", color: "default" },
    { name: "skill", id: "option-skill" },
    true,
  ],
  [
    "name mismatch with matching ID",
    { id: "option-skill", name: "prompt" },
    { name: "skill", id: "option-skill" },
    false,
  ],
  [
    "ID mismatch with matching name",
    { id: "other", name: "skill" },
    { name: "skill", id: "option-skill" },
    false,
  ],
  ["explicit null", null, null, true],
  ["missing is not null", undefined, null, false],
  ["present is not null", { name: "skill" }, null, false],
  ["null is not an option", null, { name: "skill" }, false],
  ["requested color", { name: "skill", color: "blue" }, { name: "skill", color: "blue" }, true],
  [
    "changed requested color",
    { name: "skill", color: "red" },
    { name: "skill", color: "blue" },
    false,
  ],
  ["unknown requested key", { name: "skill" }, { name: "skill", unexpected: "value" }, false],
  ["empty request", { name: "skill" }, {}, false],
  ["array request", { name: "skill" }, [], false],
  ["primitive request", { name: "skill" }, "skill", false],
  ["primitive actual", "skill", { name: "skill" }, false],
  ["missing requested value", { name: "skill" }, { name: "skill", color: undefined }, false],
] as const) {
  test(`publication select convergence compares ${label}`, () => {
    expect(
      publicationPropertiesMatch(
        { properties: { Kind: { id: "kind", type: "select", select: actual } } },
        { kind: { select: requested } },
      ),
    ).toBe(matches)
  })
}

async function sourceAttachmentBeforeOwnershipRetry() {
  const f = fixture(undefined, true)
  f.input.clear()
  f.input.set(
    "SKILL.md",
    encoder.encode(
      "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nKeep the exact source archive.\n",
    ),
  )
  f.interruptOwnership()
  const ownership = {
    subscription_id: "77777777-7777-4777-8777-777777777777",
    member_key: "source-attachment-retry",
    mode: "tracked" as const,
    published_hash: "frozen-publication-hash",
    revision: "frozen-source-revision",
  }
  const stopped = await f.run(createSkill("/input", { database, ownership }).pipe(Effect.result))
  expect(stopped._tag === "Failure" && stopped.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
  if (stopped._tag !== "Failure") throw new Error("Expected the original ownership response loss")
  const id = String(property(stopped.failure.details).operation_id)
  const original = structuredClone(f.receipt(id))
  const ownershipIndex = original.intents.length - 1
  expect(original.intents[ownershipIndex]!.status).toBe("unknown")
  const attachmentIndex = ownershipIndex - 1
  const attached = original.intents[attachmentIndex]!
  expect(attached).toMatchObject({ method: "PATCH", path: `v1/pages/${root}`, status: "completed" })
  expect(property(property(attached.body).properties).files).toMatchObject({
    files: [{ name: "ntn-skills-source.zip", type: "file_upload" }],
  })

  // Real recovery proves the original complete before-state and durably records
  // no effect. Interrupt its ordinary continuation before attachment reuse, so
  // this is the same historical state as the live failure, with no forged ACK.
  let stoppedAfterProof = false
  const classified = await f.run(
    resumePublication(id, {
      onProgress: (event) => {
        if (event.stage === "source_bundle" && event.status === "started") {
          stoppedAfterProof = true
          return Effect.fail(fail("FIXTURE_STOP", "Stopped after the original no-effect proof"))
        }
        return Effect.void
      },
    }).pipe(Effect.result),
  )
  expect(stoppedAfterProof).toBe(true)
  expect(classified._tag === "Failure" && classified.failure.code).toBe("WRITE_PARTIAL")
  const retained = structuredClone(f.receipt(id))
  expect(retained.intents).toHaveLength(original.intents.length)
  expect(retained.intents[ownershipIndex]).toMatchObject({
    status: "failed",
    response: { prior_status: "unknown", recovery: "known_not_applied" },
  })
  expect(retained.intents[ownershipIndex]!.response).toEqual({
    prior_status: "unknown",
    recovery: "known_not_applied",
  })
  expect(retained.intents[ownershipIndex]!.body).toEqual(original.intents[ownershipIndex]!.body)
  expect(retained.intents[attachmentIndex]).toEqual(original.intents[attachmentIndex])
  expect(retained.conflict).not.toBe(true)
  expect(retained.owner).toBeUndefined()
  return { f, id, retained, ownershipIndex, attachmentIndex }
}

test("source attachment ACK reuse preserves terminal no-effect ownership history through final reconcile", async () => {
  const { f, id, retained, ownershipIndex, attachmentIndex } =
    await sourceAttachmentBeforeOwnershipRetry()
  const uploads = f.uploadCounts()
  const writes = f.propertyWrites.length
  const resumed = await f.run(resumePublication(id))
  expect(resumed).toMatchObject({ operation_id: id, resumed: true, verified: true })
  const completed = f.receipt(id)
  expect(completed.state).toBe("completed")
  expect(completed.intents[ownershipIndex]).toEqual(retained.intents[ownershipIndex])
  expect(completed.intents[attachmentIndex]).toEqual(retained.intents[attachmentIndex])
  expect(
    completed.intents
      .slice(retained.intents.length)
      .filter(
        (intent) =>
          intent.method === "PATCH" &&
          JSON.stringify(intent.body) === JSON.stringify(retained.intents[ownershipIndex]!.body),
      ),
  ).toHaveLength(1)
  expect(completed.intents.filter((intent) => intent.path === "v1/pages")).toHaveLength(1)
  expect(f.uploadCounts()).toEqual(uploads)
  expect(f.propertyWrites.slice(writes).some((fields) => Object.hasOwn(fields, "files"))).toBe(
    false,
  )
  const verified = await f.run(reconcilePublication(id))
  expect(verified).toMatchObject({ outcome: "success", state: "completed", verified: true })
  expect(f.receipt(id).intents[ownershipIndex]).toEqual(retained.intents[ownershipIndex])
  expect(f.uploadCounts()).toEqual(uploads)
}, 15000)

for (const changed of [
  "attachment_bytes",
  "source_bytes",
  "ownership_request",
  "disposition",
  "later_mutation",
] as const) {
  test(`source attachment ACK reuse refuses changed ${changed} without another remote mutation`, async () => {
    const { f, id, retained, ownershipIndex } = await sourceAttachmentBeforeOwnershipRetry()
    if (changed === "attachment_bytes") f.changeAttachedBytes()
    else if (changed === "source_bytes") f.changeFrozenBytes(id)
    else {
      const invalid = structuredClone(retained)
      const last = invalid.intents[ownershipIndex]!
      if (changed === "ownership_request")
        property(property(last.body).properties)["Upstream Revision"] = {
          rich_text: [{ type: "text", text: { content: "different-frozen-revision" } }],
        }
      if (changed === "disposition")
        last.response = { ...property(last.response), replayed_by_intent: invalid.intents.length }
      if (changed === "later_mutation")
        invalid.intents.push({
          path: `v1/pages/${root}`,
          method: "PATCH",
          status: "completed",
          body: {
            properties: {
              description: {
                rich_text: [{ type: "text", text: { content: "Use for recovery." } }],
              },
            },
          },
          response: { id: root },
        })
      await f.run(
        Effect.flatMap(Store, (store) => store.writeJson(`publications/${id}.json`, invalid)),
      )
    }
    const originalRequests = structuredClone(f.receipt(id).intents)
    const writes = f.mutations()
    const uploads = f.uploadCounts()
    const stopped = await f.run(resumePublication(id).pipe(Effect.result))
    expect(stopped._tag).toBe("Failure")
    expect(f.mutations()).toBe(writes)
    expect(f.uploadCounts()).toEqual(uploads)
    expect(f.receipt(id).intents).toEqual(originalRequests)
    expect(f.receipt(id).owner).toBeUndefined()
  }, 15000)
}

test("acknowledged publication resumes after a later attachment is reconciled as observed applied", async () => {
  const f = fixture("attachment", true)
  const interrupted = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  expect(interrupted._tag === "Failure" && interrupted.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
  if (interrupted._tag !== "Failure") throw new Error("Expected attachment response loss")
  const operationId = String(property(interrupted.failure.details).operation_id)
  const original = f.receipt(operationId)
  const attachmentIndex = original.intents.findIndex(
    (intent) =>
      intent.path === `v1/pages/${root}` && "files" in property(property(intent.body).properties),
  )
  expect(attachmentIndex).toBeGreaterThan(0)
  expect(original.intents[attachmentIndex]!.status).toBe("unknown")
  const reconciled = await f.run(reconcilePublication(operationId))
  expect(reconciled.outcome).toBe("success")
  const before = f.receipt(operationId)
  expect(before.intents[attachmentIndex]).toMatchObject({
    status: "completed",
    response: { prior_status: "unknown", recovery: "observed_applied" },
  })
  const business = before.intents.filter(
    (intent) =>
      intent.method === "PATCH" &&
      (intent.path.endsWith("/markdown") ||
        (intent.path === `v1/pages/${root}` &&
          !("Publication" in property(property(intent.body).properties)))),
  )
  expect(business.length).toBeGreaterThan(0)
  const propertyWrites = f.propertyWrites.length
  const businessPatches = f.businessPatches()
  const resumed = await f.run(
    resumePublication(operationId).pipe(
      Effect.provideService(PortableSourceDecoder, {
        decode: readPortable,
        rewriteSourceArchive: true,
      }),
    ),
  )
  expect(resumed).toMatchObject({ operation_id: operationId, resumed: true, verified: true })
  expect(f.businessPatches()).toBe(businessPatches)
  const after = f.receipt(operationId)
  expect(after.state).toBe("completed")
  expect(after.intents.slice(0, before.intents.length)).toEqual(before.intents)
  expect(
    after.intents
      .slice(before.intents.length)
      .filter(
        (intent) =>
          intent.path.endsWith("/markdown") ||
          (intent.path === `v1/pages/${root}` &&
            !("Publication" in property(property(intent.body).properties))),
      ),
  ).toHaveLength(0)
  expect(
    f.propertyWrites.slice(propertyWrites).filter((fields) => fields.Publication),
  ).toHaveLength(1)
  expect(f.propertyWrites.slice(propertyWrites)).toHaveLength(1)
  const saved = await f.run(readSkill(resumed.snapshot_id!, { path: "references/policy.md" }))
  expect("content" in saved && saved.content).toContain(
    "A consumer must keep original page identities.",
  )
})

test("fresh replacement refuses an uncommitted publication before inspecting duplicate reference paths", async () => {
  const f = fixture("registration")
  await f.run(createSkill("/input", { database }).pipe(Effect.result))
  f.children.push({ ...f.children[0]!, id: "33333333-3333-4333-8333-333333333333" })
  const before = f.mutations()
  const result = await f.run(replaceSkill("/input", { database, target: root }).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure.code).toBe("PUBLICATION_INCOMPLETE")
  expect(f.mutations()).toBe(before)
})

test("publication verifies live reference pages and exact source bytes together", async () => {
  const f = fixture(undefined, true)
  f.input.set("assets/data.bin", new Uint8Array([0, 255, 7]))
  const result = await f.run(createSkill("/input", { database }))
  expect("verified" in result && result.verified).toBe(true)
  const snapshot = await f.run(openSkill(root, { refresh: true }))
  const saved = await f.run(snapshotPortable(snapshot))
  for (const file of saved.files) expect(file.bytes).toEqual(f.input.get(file.path)!)
  const reused = await f.run(replaceSkill("/input", { database, target: root }))
  expect(reused.action).toBe("reuse")
})

for (const rewriteSourceArchive of [false, true]) {
  test(`replacement ${rewriteSourceArchive ? "updates" : "reuses"} identical pages when source rewrite is ${rewriteSourceArchive}`, async () => {
    const f = fixture(undefined, true)
    await f.run(createSkill("/input", { database }))
    const ids = f.children.map((child) => child.id)
    const before = f.mutations()
    const result = await f.run(
      replaceSkill("/input", { database, target: root }).pipe(
        Effect.provideService(PortableSourceDecoder, {
          decode: readPortable,
          rewriteSourceArchive,
        }),
      ),
    )
    expect(result).toMatchObject({
      action: rewriteSourceArchive ? "update" : "reuse",
      reused: !rewriteSourceArchive,
      verified: true,
    })
    expect(f.children.map((child) => child.id)).toEqual(ids)
    if (rewriteSourceArchive) expect(f.mutations()).toBeGreaterThan(before)
    else expect(f.mutations()).toBe(before)
  })
}

for (const rewriteSourceArchive of [false, true]) {
  test(`source rewrite ${rewriteSourceArchive ? "skips impossible reuse and strictly replaces" : "retains strict live-page rejection"}`, async () => {
    const f = fixture(undefined, true)
    f.input.set("references/guide.md", encoder.encode("# Guide\n\nRead SKILL.md.\n"))
    await f.run(createSkill("/input", { database }))
    f.legacyPublication()
    const guide = f.children.find((child) => child.title === "guide.md")!
    guide.body += "\nRead [SKILL.md](https://example.com/changed-instructions).\n"
    // A retained source projection may describe the live rendering while retaining authored bytes.
    const decodeSource: typeof readPortable = (files) => {
      const portable = readPortable(files)
      return (
        portable && {
          ...portable,
          projection: {
            ...portable.projection!,
            references: {
              ...portable.projection?.references,
              "references/guide.md": bodyIdentity(withoutCreationMarker(guide.body)),
            },
          },
        }
      )
    }
    const baseline = await f.run(openSkill(root, { refresh: true }))
    const before = f.mutations()
    const result = await f.run(
      replaceSkill("/input", { database, target: baseline }).pipe(
        Effect.provideService(PortableSourceDecoder, {
          decode: decodeSource,
          rewriteSourceArchive,
        }),
        Effect.result,
      ),
    )
    if (!rewriteSourceArchive) {
      expect(result._tag === "Failure" && result.failure.code).toBe("WRITE_VERIFICATION_FAILED")
      expect(f.mutations()).toBe(before)
      expect(guide.body).toContain("[SKILL.md](https://example.com/changed-instructions)")
      return
    }
    expect(result._tag).toBe("Success")
    if (result._tag !== "Success") throw new Error("Expected guarded source replacement")
    expect(result.success).toMatchObject({ action: "update", reused: false, verified: true })
    expect(f.mutations()).toBeGreaterThan(before)
    const saved = await f.run(openSkill(root, { refresh: true }))
    const portable = await f.run(snapshotPortable(saved))
    expect(portable.files.find((file) => file.path === "references/guide.md")?.bytes).toEqual(
      f.input.get("references/guide.md")!,
    )
  })
}

test("source rewrite preserves external-edit conflicts without writing", async () => {
  const f = fixture(undefined, true)
  const created = await f.run(createSkill("/input", { database }))
  const originalReceipt = structuredClone(f.receipt(created.operation_id))
  const baseline = await f.run(openSkill(root, { refresh: true }))
  f.children[0]!.body += "\nAn independent external edit.\n"
  const before = f.mutations()
  const result = await f.run(
    replaceSkill("/input", { database, target: baseline }).pipe(
      Effect.provideService(PortableSourceDecoder, {
        decode: readPortable,
        rewriteSourceArchive: true,
      }),
      Effect.result,
    ),
  )
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_CONFLICT" } })
  expect(f.mutations()).toBe(before)
  expect(f.children[0]!.body).toContain("An independent external edit.")
  expect(f.receipt(created.operation_id)).toEqual(originalReceipt)
  const history = await f.run(readSkill(baseline.snapshot_id, { path: "references/guide.md" }))
  if (!("content" in history)) throw new Error("Expected pinned Markdown content")
  expect(history.content).not.toContain("An independent external edit.")
  const current = await f.run(readSkill(root, { path: "references/guide.md", refresh: true }))
  expect(current).toMatchObject({
    content: expect.stringContaining("An independent external edit."),
  })
  expect(f.mutations()).toBe(before)
})

for (const changed of ["main", "reference"] as const) {
  test(`publication rejects altered ${changed} Markdown even when a source bundle can preserve original bytes`, async () => {
    const f = fixture(undefined, true, changed, true)
    const result = await f.run(createSkill("/input", { database }).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected saved-content rejection")
    expect(result.failure.code).toBe("WRITE_PARTIAL")
    expect(property(result.failure.details).cause_code).toBe("WRITE_VERIFICATION_FAILED")
    const repeated = await f.run(
      replaceSkill("/input", { database, target: root }).pipe(Effect.result),
    )
    expect(repeated._tag).toBe("Failure")
  })
}

for (const hasFiles of [false, true]) {
  test(`create verifies Notion inline breaks, canonical page URLs and child tags ${hasFiles ? "with source bytes" : "without Files"}`, async () => {
    const f = fixture(undefined, hasFiles, undefined, true)
    f.input.set(
      "SKILL.md",
      encoder.encode(
        "---\nname: sample-skill\ndescription: Use for recovery.\n---\nFirst instruction\nRead [guide](references/guide.md).\n",
      ),
    )
    f.input.set(
      "references/guide.md",
      encoder.encode("First reference instruction\nRead [policy](./policy.md).\n"),
    )
    const saved = await f.run(createSkill("/input", { database }))
    expect(saved.action).toBe("create")
    expect("verified" in saved && saved.verified).toBe(true)
    const snapshot = await f.run(openSkill(root, { refresh: true }))
    const portable = await f.run(snapshotPortable(snapshot))
    if (hasFiles)
      for (const file of portable.files) expect(file.bytes).toEqual(f.input.get(file.path)!)
    const writes = f.mutations()
    const reused = await f.run(replaceSkill("/input", { database, target: root }))
    expect(reused.action).toBe("reuse")
    expect(f.mutations()).toBe(writes)
  })
}

for (const hasFiles of [false, true]) {
  test(`reference main-file write preserves page metadata ${hasFiles ? "with source bytes" : "without Files"}`, async () => {
    const f = fixture(undefined, hasFiles)
    const first = await f.run(createSkill("/input", { database }))
    f.propertyWrites.length = 0
    const content =
      "---\nname: file-only-name\ndescription: File-only description.\n---\n\nUpdated instructions.\n"
    f.input.set("SKILL.md", encoder.encode(content))
    const result = await f.run(writeSkill(first.snapshot_id!, { input: "/input/SKILL.md" }))
    expect("record" in result && result.record.name).toBe("sample-skill")
    expect("record" in result && result.record.description).toBe("Use for recovery.")
    for (const properties of f.propertyWrites) {
      expect(properties).not.toHaveProperty("title")
      expect(properties).not.toHaveProperty("description")
    }
    const snapshot = await f.run(openSkill(root, { refresh: true }))
    const saved = await f.run(snapshotPortable(snapshot))
    expect(saved.name).toBe("sample-skill")
    expect(saved.description).toBe("Use for recovery.")
    const main = saved.files.find((file) => file.path === saved.main)!
    if (hasFiles) expect(main.bytes).toEqual(encoder.encode(content))
    else expect(new TextDecoder().decode(main.bytes)).toContain("Updated instructions.")
    expect(saved.files.find((file) => file.path === "references/policy.md")).toBeDefined()
  })
}

const receiptDigest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex")

async function emptyReferencesFencedCreate(resources: boolean) {
  const f = fixture(undefined, true, undefined, false, true)
  f.input.clear()
  f.input.set(
    "SKILL.md",
    encoder.encode(
      "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nKeep every original instruction and source file.\n",
    ),
  )
  if (resources) {
    f.input.set("assets/sync.sh", encoder.encode("#!/bin/sh\nprintf 'sync\\n'\n"))
    f.input.set("assets/sync_test.sh", encoder.encode("#!/bin/sh\nprintf 'test\\n'\n"))
  }
  let verificationStarted = false
  // The final attachment PATCH invalidates property-items read guards. A
  // stable changed revision during the subsequent normal validation must
  // retain its original checkpoint and form a fence through the real catch.
  const stopped = await f.run(
    createSkill("/input", {
      database,
      onProgress: (event) =>
        Effect.sync(() => {
          if (event.stage === "verify" && event.status === "started") {
            verificationStarted = true
            f.changeRootRevision(true)
          }
        }),
    }).pipe(Effect.result),
  )
  f.changeRootRevision(false)
  expect(verificationStarted).toBe(true)
  expect(stopped._tag).toBe("Failure")
  if (stopped._tag !== "Failure") throw new Error("Expected a final validation conflict")
  expect([stopped.failure.code, property(stopped.failure.details).cause_code]).toContain(
    "WRITE_CONFLICT",
  )
  const id = String(property(stopped.failure.details).operation_id)
  const retained = structuredClone(f.receipt(id))
  expect(retained.state).toBe("failed")
  expect(retained.conflict).toBe(true)
  expect(retained.operation).toBe("create")
  expect(retained.owner).toBeUndefined()
  expect(retained.intents).toHaveLength(7)
  expect(retained.intents.every((intent) => intent.status === "completed")).toBe(true)
  expect(retained.intents.filter((intent) => intent.path === "v1/pages")).toHaveLength(1)
  const last = retained.intents[retained.intents.length - 1]!
  expect(last).toMatchObject({ path: `v1/pages/${root}`, method: "PATCH", status: "completed" })
  expect(property(property(last.body).properties).files).toMatchObject({
    files: [{ name: "ntn-skills-source.zip", type: "file_upload" }],
  })
  const rootPath = `v1/pages/${root}`
  expect(property(property(retained.guards[rootPath]).properties).References).toEqual({
    id: "references",
    type: "rich_text",
    rich_text: [],
  })
  expect(retained.guards[`v1/blocks/${root}/children?page_size=100`]).toEqual({
    results: [],
    has_more: false,
    next_cursor: null,
  })
  expect(
    Object.keys(retained.guards).some((path) => path.startsWith(rootPath + "/properties/")),
  ).toBe(false)
  expect(publicationMarker(retained.guards[rootPath])?.state).toBe("writing")
  expect(f.children).toHaveLength(0)
  return { f, id, retained }
}

for (const resources of [false, true]) {
  test(`empty References checkpoint completes its original fenced create ${resources ? "with two text resources" : "with only the main file"}`, async () => {
    const { f, id, retained } = await emptyReferencesFencedCreate(resources)
    const mutations = f.mutations()
    const uploads = f.uploadCounts()
    const reconciled = await f.run(reconcilePublication(id))
    expect(["success", "needs_safe_commit"]).toContain(reconciled.outcome)
    expect(reconciled.verified).toBe(false)
    expect(f.mutations()).toBe(mutations)
    const checkpoint = structuredClone(f.receipt(id))
    expect(checkpoint.conflict).toBeUndefined()
    expect(receiptDigest(checkpoint.guards)).toBe(receiptDigest(retained.guards))
    expect(receiptDigest(checkpoint.intents)).toBe(receiptDigest(retained.intents))
    expect(receiptDigest(checkpoint.failure)).toBe(receiptDigest(retained.failure))
    expect(checkpoint.stages).toEqual(retained.stages)
    expect(
      Object.keys(checkpoint.guards).some((path) =>
        path.startsWith(`v1/pages/${root}/properties/`),
      ),
    ).toBe(false)
    expect(checkpoint.conflict_history).toHaveLength(1)
    expect(checkpoint.conflict_history?.[0]).toMatchObject({
      conflict: true,
      state: retained.state,
      stages: retained.stages,
      intent_count: retained.intents.length,
      guard_paths: Object.keys(retained.guards),
      intended_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(receiptDigest(checkpoint.conflict_history?.[0]?.failure)).toBe(
      receiptDigest(retained.failure),
    )
    const resumed = await f.run(resumePublication(id))
    expect(resumed).toMatchObject({ operation_id: id, resumed: true, verified: true })
    const completed = f.receipt(id)
    expect(completed.state).toBe("completed")
    expect(receiptDigest(completed.intents.slice(0, retained.intents.length))).toBe(
      receiptDigest(retained.intents),
    )
    expect(completed.conflict_history).toHaveLength(1)
    expect(completed.conflict_history).toEqual(checkpoint.conflict_history)
    expect(completed.intents.filter((intent) => intent.path === "v1/pages")).toHaveLength(1)
    expect(
      completed.intents
        .slice(retained.intents.length)
        .some((intent) => intent.path.endsWith("/markdown")),
    ).toBe(false)
    expect(f.uploadCounts()).toEqual(uploads)
    const snapshot = await f.run(openSkill(root, { refresh: true }))
    const source = await f.run(snapshotAuthoredPortable(snapshot))
    expect(source.files.map((file) => file.path).sort()).toEqual([...f.input.keys()].sort())
    for (const file of source.files)
      expect(Array.from(file.bytes)).toEqual(Array.from(f.input.get(file.path)!))
  })
}

for (const changed of ["metadata", "body", "source_bytes", "attachment_bytes", "child"] as const) {
  test(`empty References checkpoint refuses changed ${changed} and preserves its original fence`, async () => {
    const { f, id, retained } = await emptyReferencesFencedCreate(true)
    if (changed === "metadata") f.changeDescription()
    if (changed === "source_bytes") f.changeFrozenBytes(id)
    if (changed === "attachment_bytes") f.changeAttachedBytes()
    if (changed === "child")
      f.children.push({
        id: "33333333-3333-4333-8333-333333333333",
        title: "unexpected.md",
        body: "External child.\n",
      })
    if (changed === "body")
      await f.run(
        Effect.gen(function* () {
          const api = yield* Notion
          yield* api.request(
            `v1/pages/${root}/markdown`,
            {
              type: "replace_content",
              replace_content: { new_str: "# Externally changed body\n" },
            },
            { method: "PATCH" },
          )
        }),
      )
    const mutations = f.mutations()
    const reconciled = await f.run(reconcilePublication(id))
    expect(["unknown", "conflict"]).toContain(reconciled.outcome)
    expect(reconciled.verified).toBe(false)
    expect(f.mutations()).toBe(mutations)
    const after = f.receipt(id)
    expect(after.conflict).toBe(true)
    expect(after.conflict_history).toBeUndefined()
    expect(receiptDigest(after.intents)).toBe(receiptDigest(retained.intents))
    expect(receiptDigest(after.guards)).toBe(receiptDigest(retained.guards))
    expect(receiptDigest(after.failure)).toBe(receiptDigest(retained.failure))
    const stopped = await f.run(resumePublication(id).pipe(Effect.result))
    expect(stopped._tag === "Failure" && stopped.failure.code).toBe("WRITE_CONFLICT")
    expect(f.mutations()).toBe(mutations)
  })
}

function referenceLimitInput(f: ReturnType<typeof fixture>) {
  f.input.clear()
  f.input.set(
    "SKILL.md",
    encoder.encode(
      "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nKeep all sixty reference files.\n",
    ),
  )
  for (let index = 0; index < 60; index++) {
    const name = `guide-${String(index).padStart(3, "0")}.md`
    f.input.set(
      `references/${name}`,
      encoder.encode(`# Guide ${index}\n\nOriginal frozen instructions ${index}.\n`),
    )
  }
}

function historicalReferenceValue(pages: readonly { path: string; id: string }[]) {
  return {
    rich_text: pages.flatMap((page, index) => [
      ...(index ? [{ type: "text", text: { content: "\n" } }] : []),
      {
        type: "text",
        text: {
          content: page.path,
          link: { url: `https://www.notion.so/${page.id.replaceAll("-", "")}` },
        },
      },
    ]),
  }
}

test("sixty references stay within the public rich text limit and preserve complete source bytes", async () => {
  const f = fixture("reference_limit", true, undefined, false, true)
  referenceLimitInput(f)
  const created = await f.run(createSkill("/input", { database }))
  expect("verified" in created && created.verified).toBe(true)
  expect(f.children).toHaveLength(60)
  const writes = f.propertyWrites.filter((value) => value.references !== undefined)
  expect(writes.length).toBeGreaterThanOrEqual(61)
  for (const value of writes) {
    const raw = property(value.references).rich_text as unknown[]
    expect(raw.length).toBeLessThanOrEqual(100)
  }
  expect(writes[49]!.references).toEqual(
    historicalReferenceValue(
      f.children.slice(0, 50).map((child) => ({ id: child.id, path: `references/${child.title}` })),
    ),
  )
  expect(property(writes[50]!.references).rich_text).toHaveLength(51)
  const snapshot = await f.run(openSkill(root, { refresh: true }))
  const portable = await f.run(snapshotAuthoredPortable(snapshot))
  const digestFiles = (files: readonly { path: string; bytes: Uint8Array }[]) =>
    files
      .map((file) => [file.path, createHash("sha256").update(file.bytes).digest("hex")])
      .sort(([a], [b]) => a!.localeCompare(b!))
  expect(digestFiles(portable.files)).toEqual(
    digestFiles([...f.input].map(([path, bytes]) => ({ path, bytes }))),
  )
}, 60000)

for (const changed of [undefined, "metadata", "child", "source"] as const)
  test(
    `the original rejected 101-element References request ${changed ? `refuses changed ${changed} before mutation` : "resumes with bounded requests and preserves every original ACK"}`,
    async () => {
      const f = fixture("reference_limit", true, undefined, false, true)
      referenceLimitInput(f)
      let sentHistorical = false
      // Generate the old writer's request through the real session. The fixture's
      // documented 100-element API limit rejects it; no receipt or ACK is seeded.
      const stopped = await f.run(
        createSkill("/input", {
          database,
          onProgress: (event) =>
            Effect.gen(function* () {
              if (
                sentHistorical ||
                event.status !== "started" ||
                event.stage !== "register_reference:references/guide-050.md"
              )
                return
              sentHistorical = true
              const api = yield* Effect.serviceOption(Notion)
              if (Option.isNone(api))
                return yield* Effect.fail(
                  fail("UNEXPECTED", "The original reference session is unavailable."),
                )
              yield* api.value.request(
                `v1/pages/${root}`,
                {
                  properties: {
                    references: historicalReferenceValue(
                      f.children.map((child) => ({
                        id: child.id,
                        path: `references/${child.title}`,
                      })),
                    ),
                  },
                },
                { method: "PATCH" },
              )
            }),
        }).pipe(Effect.result),
      )
      if (stopped._tag !== "Failure")
        throw new Error("The old 101-element request must be rejected")
      expect(sentHistorical).toBe(true)
      expect(stopped.failure.code).toBe("WRITE_PARTIAL")
      expect(property(stopped.failure.details).cause_code).toBe("NOTION_REQUEST_FAILED")
      expect(property(property(stopped.failure.details).cause_details)).toMatchObject({
        http_status: 400,
        notion_code: "validation_error",
        phase: "definitive_rejection",
      })
      const operationId = String(property(stopped.failure.details).operation_id)
      const original = f.receipt(operationId)
      const originalIntents = structuredClone(original.intents)
      const originalIds = f.children.map((child) => child.id)
      expect(original.intents).toHaveLength(103)
      expect(original.intents.slice(0, 102).every((intent) => intent.status === "completed")).toBe(
        true,
      )
      expect(original.intents[102]).toMatchObject({
        path: `v1/pages/${root}`,
        method: "PATCH",
        status: "failed",
      })
      expect(Object.keys(original.intents[102]!).sort()).toEqual([
        "body",
        "method",
        "path",
        "status",
      ])
      expect(
        property(property(property(original.intents[102]!.body).properties).references).rich_text,
      ).toHaveLength(101)
      expect(f.children).toHaveLength(51)
      const mutations = f.mutations()
      const writeCount = f.propertyWrites.length
      if (changed === "metadata") f.changeDescription()
      if (changed === "child") f.children[0]!.title = "external-change.md"
      if (changed === "source") f.changeFrozenBytes(operationId)
      const resumed = await f.run(resumePublication(operationId).pipe(Effect.result))
      const current = f.receipt(operationId)
      expect(current.operation_id).toBe(operationId)
      expect(current.intents.slice(0, originalIntents.length)).toEqual(originalIntents)
      if (changed) {
        expect(resumed._tag).toBe("Failure")
        expect(f.mutations()).toBe(mutations)
        expect(f.propertyWrites).toHaveLength(writeCount)
        expect(f.children.map((child) => child.id)).toEqual(originalIds)
        return
      }
      if (resumed._tag !== "Success")
        throw new Error(
          `The original reference publication did not resume: ${resumed.failure.code}`,
        )
      expect(resumed.success).toMatchObject({
        operation_id: operationId,
        verified: true,
        resumed: true,
      })
      expect(current.state).toBe("completed")
      expect(f.children).toHaveLength(60)
      expect(f.children.slice(0, originalIds.length).map((child) => child.id)).toEqual(originalIds)
      expect(new Set(f.children.map((child) => child.id)).size).toBe(60)
      const resumedWrites = f.propertyWrites.slice(writeCount)
      expect(resumedWrites.length).toBeGreaterThan(0)
      for (const value of resumedWrites) {
        const richText = property(value.references).rich_text
        if (Array.isArray(richText)) expect(richText.length).toBeLessThanOrEqual(100)
      }
      expect(publicationPropertyReplacementCandidates(current)).toEqual([
        {
          path: `v1/pages/${root}`,
          intent_index: 102,
          covered_by_intent_index: current.intents.findLastIndex(
            (intent) => property(property(intent.body).properties).references !== undefined,
          ),
          property_id: "references",
          basis: "oversized_legacy_references",
        },
      ])
      const reconciled = await f.run(reconcilePublication(operationId))
      expect(reconciled.outcome).toBe("success")
      expect(f.receipt(operationId).intents.slice(0, originalIntents.length)).toEqual(
        originalIntents,
      )
      const saved = await f.run(openSkill(root, { refresh: true }))
      const portable = await f.run(snapshotAuthoredPortable(saved))
      expect(portable.files).toHaveLength(f.input.size)
      for (const file of portable.files)
        expect(createHash("sha256").update(file.bytes).digest("hex")).toBe(
          createHash("sha256").update(f.input.get(file.path)!).digest("hex"),
        )
    },
    changed === undefined ? 60000 : undefined,
  )

for (const changed of ["main", "reference"] as const) {
  test(`source policy permits an explicitly changed ${changed} source with archive rewrite disabled`, async () => {
    const f = fixture(undefined, true)
    await f.run(createSkill("/input", { database }))
    const baseline = await f.run(openSkill(root, { refresh: true }))
    const ids = f.children.map((child) => child.id)
    const path = changed === "main" ? "SKILL.md" : "references/guide.md"
    const authored = new TextDecoder("utf-8", { fatal: true }).decode(f.input.get(path)!)
    f.input.set(path, encoder.encode(`${authored}\nAn explicitly authored ${changed} change.\n`))
    const before = f.mutations()
    const replaced = await f.run(
      replaceSkill("/input", { database, target: baseline }).pipe(
        Effect.provideService(PortableSourceDecoder, {
          decode: readPortable,
          rewriteSourceArchive: false,
        }),
      ),
    )
    expect(replaced).toMatchObject({ action: "update", reused: false, verified: true })
    expect(f.mutations()).toBeGreaterThan(before)
    expect(f.children.map((child) => child.id)).toEqual(ids)
    const current = await f.run(openSkill(root, { refresh: true }))
    const source = await f.run(snapshotAuthoredPortable(current))
    expect(source.files).toHaveLength(f.input.size)
    for (const file of source.files) expect(file.bytes).toEqual(f.input.get(file.path)!)
  })
}
