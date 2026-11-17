import { expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { property, text } from "../src/model.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import {
  applySharedCreateRestoration,
  reconcileSharedCreateRestoration,
} from "../src/shared-create-restoration.ts"
import { sharedCreateLinkRepairProofsEntity } from "../src/shared-create-link-repair.ts"
import { querySharedRecords } from "../src/shared-records.ts"
import { failedLinkedOriginal } from "./shared-create-link-restoration-fixture.ts"

test.each([true, false])(
  "an unknown link PATCH visible=%s never repeats or completes from current equality",
  async (visible) => {
    const x = await failedLinkedOriginal(),
      { f } = x
    f.unknown("body", visible)
    const error = await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))
    expect(error.code).toMatch(/WRITE_OUTCOME_UNKNOWN|SOURCE_WRITE_UNKNOWN/)
    expect(
      f.calls.filter((call) => call.method === "PATCH" && call.path.includes("/markdown")),
    ).toHaveLength(1)
    f.clear()
    await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))
    expect(f.writes()).toHaveLength(0)
  },
)

test.each(["body", "ack"] as const)(
  "a changed original ACK prefix %s refuses all suffix writes",
  async (changed) => {
    const x = await failedLinkedOriginal(),
      { f } = x
    expect(x.review.bindings.length).toBeGreaterThan(1)
    const page = x.review.bindings.at(-1)!.page_id
    if (changed === "body")
      f.base.bodies.set(page, f.base.bodies.get(page)! + "\nA later user edit.")
    if (changed === "ack") {
      const key = [...f.base.json.keys()].find(
        (key) =>
          key.includes("/source-ack-") &&
          property(property(f.base.json.get(key)).response).id === page,
      )!
      expect(key).toBeDefined()
      f.base.json.set(key, { ...property(f.base.json.get(key)), response_hash: "f".repeat(64) })
    }
    f.clear()
    await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))
    expect(f.writes()).toHaveLength(0)
  },
)

test("a cold linked completion needs the retained exact PATCH proof", async () => {
  const x = await failedLinkedOriginal(),
    { f } = x
  await f.run(applySharedCreateRestoration(x.apply))
  const proofs = await f.run(
    querySharedRecords(f.library, {
      skillPageId: x.page,
      kind: "operation",
      entityId: sharedCreateLinkRepairProofsEntity,
    }),
  )
  expect(proofs.length).toBeGreaterThan(0)
  let removed = 0
  for (const [key, row] of f.base.records)
    if (text(property(property(row.properties).record).rich_text) === proofs[0]!.record_id) {
      f.base.records.delete(key)
      removed++
    }
  expect(removed).toBe(1)
  f.base.json.clear()
  f.base.objects.clear()
  f.credential("cold-missing-link-ack-proof")
  f.clear()
  await f.run(Effect.flip(reconcileSharedCreateRestoration(x.selected)))
  expect(f.writes()).toHaveLength(0)
})

test("four original script payloads and executable modes survive cold linked recovery", async () => {
  const x = await failedLinkedOriginal(),
    { f } = x
  await f.run(applySharedCreateRestoration(x.apply))
  f.base.json.clear()
  f.base.objects.clear()
  f.credential("cold-complete-link-resources")
  f.clear()
  const snapshot = await f.run(
    Effect.gen(function* () {
      return yield* openSharedConsumer({
        library: f.library,
        target: x.page,
        scope: yield* authScope,
        startedAt: Date.now(),
        forceFull: true,
        readOnly: true,
      })
    }),
  )
  expect(x.resources).toHaveLength(4)
  for (const original of x.resources) {
    const file = snapshot.files.find((file) => file.path === original.path)!
    expect(file).toBeDefined()
    expect(file.mode).toBe(original.mode)
    expect(f.base.objects.get(`objects/${file.sha256}`)).toEqual(original.bytes)
  }
  expect(f.writes()).toHaveLength(0)
})
