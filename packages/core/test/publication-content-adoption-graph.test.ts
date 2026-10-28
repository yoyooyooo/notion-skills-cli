import { expect, test } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import {
  fixture,
  database,
  dataSource,
  root,
  subscriptionId,
} from "./content-adoption-heading.fixture.ts"
import { projectNotionBlocks as legacyProjection } from "./content-adoption-legacy-projection.fixture.ts"
import {
  readContentAdoptionProof,
  type ContentAdoptionReadBounds,
} from "../src/publication-content-adoption-proof.ts"
import { createSkill } from "../src/mutation.ts"
import { property } from "../src/model.ts"
import { canonicalMain } from "../src/portable.ts"
import { publicationMarker } from "../src/publication-integrity.ts"
import { portableIdentity } from "../src/export.ts"
import { canonical } from "../src/publication-effect-proof.ts"
import { authScope } from "../src/catalog.ts"
import type { ContentAdoptionEvidence } from "../src/publication-content-adoption-authority.ts"

const inventoryPath = `v1/blocks/${root}/children?page_size=100`
const sha = (value: string) => createHash("sha256").update(value).digest("hex")

async function retainedHeadingEvidence() {
  // The real publication service produces the writing marker, every original
  // ACK, the uploaded ZIP and the interrupted commit. Only the API fixture may
  // lose a response; no receipt, marker, fence or intent is manufactured.
  const fake = fixture(undefined, true, undefined, false, false, true)
  fake.enableOwnership()
  fake.input.clear()
  fake.input.set(
    "SKILL.md",
    canonicalMain(
      "sample-skill",
      "Use for recovery.",
      "# Sample\n\n## Retained heading\n\nKeep [the original destination](https://example.test/original?q=1#anchor) and these exact instructions.\n",
      {
        path: "SKILL.md",
        bytes: new Uint8Array(),
      },
    ).bytes,
  )
  fake.input.set("agents/openai.yaml", new TextEncoder().encode("display_name: retained fixture\n"))
  fake.commitFault("before")
  const original = await fake.run(createSkill("/input", { database }).pipe(Effect.result))
  expect(original._tag).toBe("Failure")
  if (original._tag !== "Failure")
    throw new Error("The native publication must stop before its commit ACK")
  const operationId = property(original.failure.details).operation_id
  if (typeof operationId !== "string") throw new Error("Expected the real original operation ID")
  const originalReceipt = fake.receipt(operationId)
  expect(originalReceipt.intents.at(-1)?.status).toBe("unknown")
  expect(originalReceipt.intents.at(-1)?.response).toBeUndefined()
  expect(
    originalReceipt.intents.some(
      (intent) => intent.status === "completed" && intent.path.endsWith("/markdown"),
    ),
  ).toBe(true)
  expect(fake.uploadCounts()).toEqual({ allocations: 1, sends: 1 })
  const marker = publicationMarker(fake.rootPage())
  if (!marker || marker.state !== "writing") throw new Error("Expected the actual writing marker")
  const portable = fake.portableFor(operationId)
  const bounds: ContentAdoptionReadBounds = {
    page_id: root,
    database_id: database,
    data_source_id: dataSource,
    scope: await fake.run(authScope),
    portable,
    intended_hash: marker.intended_hash,
    old_marker: marker,
    marker,
    planned_ownership: {
      subscription_id: subscriptionId,
      member_key: "sample-skill",
      mode: "tracked",
      published_hash: await fake.run(portableIdentity(portable)),
      revision: "original-upstream",
    },
  }
  const beforeState = canonical(fake.retainedOldState()),
    beforeWrites = fake.mutations()
  const current = await fake.run(readContentAdoptionProof(bounds))
  expect(current.source_bytes_verified).toBe(true)
  expect(current.evidence.files.map((file) => file.path).sort()).toEqual([
    "SKILL.md",
    "agents/openai.yaml",
  ])
  expect(current.evidence.attachments).toHaveLength(1)
  expect(current.evidence.attachments[0]?.bytes).toBeGreaterThan(0)
  expect(current.evidence.page_ids).toEqual([root])
  expect(current.snapshot.references).toHaveLength(1)
  const rawInventory = property(current.evidence.raw[inventoryPath])
  expect(rawInventory.has_more).toBe(false)
  expect(rawInventory.next_cursor).toBeNull()
  if (!Array.isArray(rawInventory.results)) throw new Error("Complete raw roots are required")
  expect(
    rawInventory.results.every(
      (block) =>
        property(block).has_children === false &&
        property(property(block).parent).type === "page_id" &&
        property(property(block).parent).page_id === root,
    ),
  ).toBe(true)
  const roots = legacyProjection(rawInventory.results)
  if (!roots)
    throw new Error("Independent historical projector refused the complete original raw roots")
  const rootPage = current.snapshot.references?.[0]
  if (!rootPage) throw new Error("Complete root reference page required")
  const oldGraph = [{ id: root, path: portable.main, markdown: rootPage.markdown, blocks: roots }]
  const oldHash = sha(canonical(oldGraph))
  expect(oldHash).not.toBe(current.evidence.graph_sha256)
  expect(rootPage.blocks?.filter((block) => /^heading_[123]$/.test(block.type)).length).toBe(2)
  expect(
    rootPage.blocks
      ?.filter((block) => /^heading_[123]$/.test(block.type))
      .every((block) => typeof block.text === "string" && Array.isArray(block.rich_text)),
  ).toBe(true)
  // This is an in-memory verifier input for the previous documented graph
  // codec, derived independently from exactly the retained raw responses. It
  // is never written to a native plan, receipt, guard, source or page.
  const evidence: ContentAdoptionEvidence = { ...current.evidence, graph_sha256: oldHash }
  const retainedRaw = canonical(evidence.raw),
    retainedEvidence = canonical(evidence)
  const stable = () => {
    expect(fake.mutations()).toBe(beforeWrites)
    expect(canonical(fake.retainedOldState())).toBe(beforeState)
    expect(canonical(fake.receipt(operationId))).toBe(canonical(originalReceipt))
    expect(canonical(evidence.raw)).toBe(retainedRaw)
    expect(canonical(evidence)).toBe(retainedEvidence)
  }
  stable()
  return { fake, operationId, bounds: { ...bounds, evidence }, evidence, current, stable }
}

test("the complete proof accepts the historical heading projection after exact raw and source ZIP verification", async () => {
  const context = await retainedHeadingEvidence()
  const result = await context.fake.run(readContentAdoptionProof(context.bounds))
  expect(result.source_bytes_verified).toBe(true)
  expect(result.evidence.graph_sha256).toBe(context.current.evidence.graph_sha256)
  expect(result.evidence.graph_sha256).not.toBe(context.evidence.graph_sha256)
  expect(result.evidence.files).toEqual(context.evidence.files)
  expect(result.evidence.attachments).toEqual(context.evidence.attachments)
  expect(canonical(result.evidence.raw)).toBe(canonical(context.evidence.raw))
  context.stable()
})

for (const change of ["heading formatting", "unprojected physical field"] as const) {
  test(`historical heading compatibility refuses changed ${change} in the independent retained raw inventory`, async () => {
    const context = await retainedHeadingEvidence()
    const inventory = structuredClone(property(context.evidence.raw[inventoryPath]))
    if (!Array.isArray(inventory.results)) throw new Error("Complete original inventory required")
    const heading = inventory.results.map(property).find((block) => block.type === "heading_2")
    if (!heading) throw new Error("Original heading required")
    if (change === "heading formatting") {
      const spans = property(heading.heading_2).rich_text
      if (!Array.isArray(spans) || spans.length !== 1)
        throw new Error("Expected one exact heading span")
      property(property(spans[0]).annotations).bold = true
    } else heading.last_edited_time = "2026-10-20T00:00:00.000Z"
    context.fake.inventories.set(inventoryPath, inventory)
    const result = await context.fake.run(
      readContentAdoptionProof(context.bounds).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure")
      throw new Error("Physical changes must not use heading projection compatibility")
    expect(result.failure.code).toBe("CONTENT_ADOPTION_REFUSED")
    expect(result.failure.message).toBe(
      "An unrequested original field or physical resource changed.",
    )
    expect(property(result.failure.details).path).toBe(inventoryPath)
    context.stable()
  })
}

for (const change of ["body", "external URL", "source ZIP"] as const) {
  test(`historical heading compatibility retains the complete ${change} authority`, async () => {
    const context = await retainedHeadingEvidence()
    if (change === "body") context.fake.changeRootBody()
    else if (change === "external URL") context.fake.changeRootUrl()
    else expect(context.fake.changeAttachedBytes()).toBe(1)
    const result = await context.fake.run(
      readContentAdoptionProof(context.bounds).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure")
      throw new Error("Complete content and source bytes remain authoritative")
    expect(result.failure.code).toBe("CONTENT_ADOPTION_REFUSED")
    expect(result.failure.message).toBe(
      change === "source ZIP"
        ? "The downloaded source bundle differs from the original frozen portable bytes."
        : "Complete live bodies or external destinations differ from the frozen source.",
    )
    context.stable()
  })
}

for (const change of ["missing raw path", "unknown graph digest"] as const) {
  test(`historical heading compatibility refuses ${change}`, async () => {
    const context = await retainedHeadingEvidence()
    const raw = { ...structuredClone(context.evidence.raw) }
    if (change === "missing raw path") delete raw[inventoryPath]
    const evidence: ContentAdoptionEvidence = {
      ...context.evidence,
      raw,
      ...(change === "unknown graph digest" ? { graph_sha256: "f".repeat(64) } : {}),
    }
    const result = await context.fake.run(
      readContentAdoptionProof({ ...context.bounds, evidence }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure")
      throw new Error("The whole historical graph digest and raw path set must remain exact")
    expect(result.failure.code).toBe("CONTENT_ADOPTION_REFUSED")
    expect(result.failure.message).toBe(
      "The complete retained content graph or Files bytes changed.",
    )
    context.stable()
  })
}
