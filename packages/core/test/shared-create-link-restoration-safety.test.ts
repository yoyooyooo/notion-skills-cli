import { expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { fail, property, text } from "../src/model.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import {
  applySharedCreateRestoration,
  reconcileSharedCreateRestoration,
  validateSharedCreateRestorationReview,
} from "../src/shared-create-restoration.ts"
import { sharedCreateLinkRepairProofsEntity } from "../src/shared-create-link-repair.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { sha256, Store } from "../src/store.ts"
import { withSharedAuthoringTarget } from "../src/shared-authoring-context.ts"
import {
  prepareSharedMetadataWrite,
  executeSharedMetadataWrite,
} from "../src/shared-metadata-write.ts"
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

test.each([false, true])(
  "UTF-8 sole-main durable ACK resumes without replay; foreign pending=%s",
  async (foreignPending) => {
    const x = await failedLinkedOriginal(14, true),
      { f } = x
    let interrupted = false
    const error = await f.run(
      Effect.flip(
        Effect.gen(function* () {
          const store = yield* Store
          const interruptedStore: typeof store = {
            ...store,
            writeJson: (key, value) =>
              store.writeJson(key, value).pipe(
                Effect.flatMap(() => {
                  if (
                    !interrupted &&
                    key.includes("/source-ack-") &&
                    property(property(value).response).id === x.page &&
                    typeof property(property(value).response).markdown === "string"
                  ) {
                    interrupted = true
                    return Effect.fail(
                      fail("STATE_CONFLICT", "Controlled interruption after durable fragment ACK"),
                    )
                  }
                  return Effect.void
                }),
              ),
          }
          return yield* applySharedCreateRestoration(x.apply).pipe(
            Effect.provideService(Store, interruptedStore),
          )
        }),
      ),
    )
    expect(interrupted).toBe(true)
    expect(error.code).toBe("SOURCE_WRITE_UNKNOWN")
    expect(f.nativeCreates()).toHaveLength(6)
    if (foreignPending) {
      const pending = await f.run(
        withSharedAuthoringTarget(
          x.page,
          prepareSharedMetadataWrite({
            library: f.library,
            skillPageId: x.page,
            changes: [{ field: "Description", value: "Another pending metadata operation" }],
          }),
        ),
      )
      f.base.unknownRecord("operation", true)
      const pendingError = await f.run(
        Effect.flip(
          withSharedAuthoringTarget(
            x.page,
            executeSharedMetadataWrite(f.library, { plan: pending, mode: "create" }),
          ),
        ),
      )
      expect(pendingError.code).toBe("WRITE_OUTCOME_UNKNOWN")
      f.clear()
      const resumed = await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))
      expect(resumed.code).toBe("SHARED_CREATE_RESTORATION_REQUIRED")
      expect(f.writes()).toHaveLength(0)
      return
    }
    f.clear()
    expect(await f.run(applySharedCreateRestoration(x.apply))).toMatchObject({ verified: true })
    expect(f.nativeCreates()).toHaveLength(0)
    expect(
      f
        .writes()
        .filter(
          (request) => request.method === "PATCH" && request.path === `v1/pages/${x.page}/markdown`,
        ),
    ).toHaveLength(0)
  },
)

test("UTF-8 sole-main unknown PATCH never gains authority from its visible body", async () => {
  const x = await failedLinkedOriginal(14, true),
    { f } = x
  f.unknown("body", true)
  const error = await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))
  expect(error.code).toMatch(/WRITE_OUTCOME_UNKNOWN|SOURCE_WRITE_UNKNOWN/)
  f.clear()
  await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))
  expect(f.writes()).toHaveLength(0)
})

test("UTF-8 sole-main bootstrap cannot relabel a multi-allocation failure as a null original outcome", async () => {
  const x = await failedLinkedOriginal()
  if (x.review.version !== 3) throw new Error("Expected local-link review.")
  const { review_id: _oldId, ...original } = x.review
  const fields = {
    ...original,
    original_outcome_sha256: null,
    bootstrap: { ...original.bootstrap, kind: "acknowledged_main_before_manifest" },
  }
  const review = {
    ...fields,
    review_id: "create-restore-" + (await x.f.run(sha256(canonicalSharedJson(fields)))),
  }
  x.f.clear()
  const rejected = await x.f.run(Effect.flip(validateSharedCreateRestorationReview(review, x.plan)))
  expect(rejected.code).toBe("SHARED_CREATE_RESTORATION_REQUIRED")
  expect(x.f.writes()).toHaveLength(0)
})
