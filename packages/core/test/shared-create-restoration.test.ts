import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { authScope } from "../src/catalog.ts"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  prepareSharedCreate,
  executeSharedCreate,
  loadPendingSharedCreates,
} from "../src/shared-create.ts"
import {
  reviewSharedCreateRestoration,
  applySharedCreateRestoration,
  reconcileSharedCreateRestoration,
} from "../src/shared-create-restoration.ts"
import { sharedCreateOutcomeId } from "../src/shared-create-outcome.ts"
import { FileEventSchema } from "../src/shared-file-state.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { sharedCreateFixture } from "./shared-create-fixture.ts"

const encode = (text: string) => new TextEncoder().encode(text)
async function restoredOriginal() {
  const f = sharedCreateFixture()
  f.onCreate((page, kind) => {
    if (kind === "skill")
      f.base.bodies.set(String(page.id), "# Root\n\nRead references/[policy.md](http://policy.md).")
  })
  const plan = await f.run(
    prepareSharedCreate(f.library, {
      portable: {
        kind: "skill",
        name: "Restored original",
        description: "Exact recovery",
        main: "SKILL.md",
        files: [
          { path: "SKILL.md", bytes: encode("# Root\n\nRead references/policy.md.\n") },
          { path: "references/policy.md", bytes: encode("# Policy\n\nKEEP-ORIGINAL\n") },
        ],
      },
    }),
  )
  const failure = await f.run(Effect.flip(executeSharedCreate(f.library, { plan, mode: "create" })))
  expect(failure.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  const page = String(property(failure.details).skill_page_id)
  const rows = await f.run(
    querySharedRecords(f.library, {
      skillPageId: page,
      kind: "operation",
      recordId: sharedCreateOutcomeId(plan.operation_id),
    }),
  )
  const originalFailure = canonicalSharedJson(rows[0])
  const main = plan.files.find((file) => file.path === plan.entrypoint)!
  f.base.bodies.set(page, main.projection.markdown)
  f.onCreate(() => {})
  f.clear()
  // Correcting the same body alone does not erase the immutable failure.
  expect(
    (await f.run(Effect.flip(executeSharedCreate(f.library, { plan, mode: "create" })))).code,
  ).toBe("SHARED_CREATE_REVIEW_REQUIRED")
  f.clear()
  const selected = { entry: f.library.skills.database_id, plan, target: page }
  const review = await f.run(reviewSharedCreateRestoration(selected))
  expect(f.writes()).toHaveLength(0)
  const apply = { entry: selected.entry, plan, review, reviewId: review.review_id }
  return { f, plan, page, originalFailure, selected, review, apply }
}

test("explicit exact restoration completes the same original create and a cold complete tree", async () => {
  const x = await restoredOriginal(),
    { f } = x
  const dry = await f.run(applySharedCreateRestoration({ ...x.apply, dryRun: true }))
  expect(dry).toMatchObject({
    status: "planned",
    write_plan: { maximum_native_page_creates: 1, existing_body_patches: 0 },
  })
  expect(f.writes()).toHaveLength(0)
  const result = await f.run(applySharedCreateRestoration(x.apply))
  expect(result).toMatchObject({
    status: "created",
    skill_page_id: x.page,
    operation_id: x.plan.operation_id,
    verified: true,
  })
  expect(f.nativeCreates()).toHaveLength(1)
  expect(f.enablePatches()).toHaveLength(1)
  const rows = await f.run(
    querySharedRecords(f.library, {
      skillPageId: x.page,
      kind: "operation",
      recordId: sharedCreateOutcomeId(x.plan.operation_id),
    }),
  )
  expect(canonicalSharedJson(rows[0])).toBe(x.originalFailure)
  f.clear()
  expect(await f.run(applySharedCreateRestoration(x.apply))).toMatchObject({
    verified: true,
    reused: true,
  })
  expect(f.writes()).toHaveLength(0)
  f.base.json.clear()
  f.base.objects.clear()
  f.credential("independent-restoration-reader")
  const events = (
    await f.run(querySharedRecords(f.library, { skillPageId: x.page, kind: "file_event" }))
  ).map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload))
  expect(await f.run(loadPendingSharedCreates(f.library, { skillPageId: x.page, events }))).toEqual(
    [],
  )
  expect(await f.run(reconcileSharedCreateRestoration(x.selected))).toMatchObject({
    verified: true,
    current_snapshot_verified: false,
  })
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
  expect(snapshot.files.map((file) => file.path).sort()).toEqual([
    "SKILL.md",
    "references/policy.md",
  ])
  expect(f.writes()).toHaveLength(0)
})

test.each(["body", "review", "ack", "owner"] as const)(
  "restoration refuses changed %s before a write",
  async (kind) => {
    const x = await restoredOriginal(),
      { f } = x
    let review = x.review
    if (kind === "body") f.base.bodies.set(x.page, "# Changed")
    if (kind === "review") review = { ...review, original_plan_sha256: "f".repeat(64) }
    if (kind === "ack") {
      const key = [...f.base.json.keys()].find(
        (key) =>
          key.includes("/source-ack-") &&
          property(property(f.base.json.get(key)).response).id === x.page,
      )!
      f.base.json.set(key, { ...property(f.base.json.get(key)), response_hash: "f".repeat(64) })
    }
    if (kind === "owner")
      property(f.skills.get(x.page)!.parent).data_source_id = "00000000-0000-4000-8000-000000000999"
    f.clear()
    const failure = await f.run(Effect.flip(applySharedCreateRestoration({ ...x.apply, review })))
    expect(failure.code).toMatch(/SHARED_CREATE|SHARED_LIBRARY|INVALID_SHARED_SKILL/u)
    expect(f.writes()).toHaveLength(0)
  },
)

test.each([true, false])(
  "an unknown original suffix visible=%s remains unreplayed",
  async (visible) => {
    const x = await restoredOriginal(),
      { f } = x
    f.unknown("file", visible)
    expect((await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))).code).toBe(
      "WRITE_OUTCOME_UNKNOWN",
    )
    f.clear()
    expect((await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))).code).toMatch(
      /SHARED_CREATE|WRITE_OUTCOME/u,
    )
    expect(f.writes()).toHaveLength(0)
  },
)

test("an acknowledged suffix with interrupted body readback resumes its exact original page", async () => {
  const x = await restoredOriginal(),
    { f } = x
  let suffixPage: string | undefined
  f.onCreate((page, kind) => {
    if (kind === "file") suffixPage = String(page.id)
  })
  const failed = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* Effect.flip(applySharedCreateRestoration(x.apply)).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            suffixPage !== undefined && path.includes(suffixPage + "/markdown")
              ? Effect.fail(
                  fail("NOTION_READ_INTERRUPTED", "Original ACK retained before readback failed"),
                )
              : api.request(path, body, options),
        }),
      )
    }),
  )
  expect(failed.code).toBe("NOTION_READ_INTERRUPTED")
  expect(suffixPage).toBeDefined()
  expect(f.nativeCreates()).toHaveLength(1)
  expect(f.enablePatches()).toHaveLength(0)
  f.clear()
  expect(await f.run(applySharedCreateRestoration(x.apply))).toMatchObject({
    status: "created",
    verified: true,
  })
  expect(f.nativeCreates()).toHaveLength(0)
  expect(f.enablePatches()).toHaveLength(1)
  expect([...f.files.keys()]).toContain(suffixPage!)
})

test("a cold completion without its full original restoration review stays unresolved", async () => {
  const x = await restoredOriginal(),
    { f } = x
  await f.run(applySharedCreateRestoration(x.apply))
  for (const [key, row] of f.base.records)
    if (
      text(property(property(row.properties).record).rich_text) ===
      "restoration-review-" + x.plan.operation_id
    )
      f.base.records.delete(key)
  f.base.json.clear()
  f.base.objects.clear()
  f.credential("cold-missing-original-review")
  f.clear()
  expect((await f.run(Effect.flip(reconcileSharedCreateRestoration(x.selected)))).code).toBe(
    "SHARED_CREATE_RESTORATION_REQUIRED",
  )
  expect(f.writes()).toHaveLength(0)
})
