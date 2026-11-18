import { expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { updateSkill } from "../src/command-operations.ts"
import { property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { parseYaml } from "../src/yaml.ts"
import { reconcileSharedCreate } from "../src/shared-create.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
} from "../src/shared-records.ts"
import {
  reviewSharedCreateCurrentTree,
  applySharedCreateCurrentTree,
  reconcileSharedCreateCurrentTree,
} from "../src/shared-create-current-tree.ts"
import { failedCurrentTreeOriginal } from "./shared-create-current-tree-fixture.ts"

test("complete legacy v13 tree can be explicitly reviewed without an original local ACK", async () => {
  const { f, selected } = await failedCurrentTreeOriginal()
  const review = await f.run(reviewSharedCreateCurrentTree(selected))
  expect(review.kind).toBe("skill_create_current_tree_review")
  expect(f.writes()).toHaveLength(0)
})

test("independent acceptance publishes only new Records; old create remains needs_review and a cold normal consumer reads every file", async () => {
  const { f, plan, page, selected, originalFailure } = await failedCurrentTreeOriginal()
  const review = await f.run(reviewSharedCreateCurrentTree(selected))
  const input = { entry: selected.entry, plan, review, reviewId: review.review_id }
  expect((await f.run(applySharedCreateCurrentTree({ ...input, dryRun: true }))).status).toBe(
    "planned",
  )
  expect(f.writes()).toHaveLength(0)
  const result = await f.run(applySharedCreateCurrentTree(input))
  expect(result).toMatchObject({
    verified: true,
    original_status: "needs_review",
    original_completion: "unproven",
  })
  expect(f.writes()).toHaveLength(6)
  expect(f.nativeCreates()).toHaveLength(0)
  expect(f.enablePatches()).toHaveLength(0)
  const original = await f.run(
    querySharedRecords(f.library, {
      skillPageId: page,
      kind: "operation",
      recordId: "outcome-" + plan.operation_id,
    }),
  )
  expect(canonicalSharedJson(original[0])).toBe(originalFailure)
  const events = await f.run(
    querySharedRecords(f.library, { skillPageId: page, kind: "file_event" }),
  )
  expect(events).toHaveLength(4)
  expect(events.every((row) => row.record_id.startsWith("adopt-"))).toBe(true)
  expect(
    events.some((row) => plan.files.some((file) => row.record_id === file.event.event_id)),
  ).toBe(false)
  expect((await f.run(Effect.flip(reconcileSharedCreate(f.library, plan)))).code).toBe(
    "SHARED_CREATE_REVIEW_REQUIRED",
  )
  f.clear()
  expect((await f.run(reconcileSharedCreateCurrentTree(selected))).verified).toBe(true)
  expect(await f.run(applySharedCreateCurrentTree(input))).toMatchObject({ reused: true })
  expect(f.writes()).toHaveLength(0)
  expect(
    (await f.run(updateSkill(page, { database: selected.entry, enabled: true }))).verified,
  ).toBe(true)
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  f.credential("cold-current-tree-consumer")
  const consumer = await f.run(
    Effect.gen(function* () {
      return yield* openSharedConsumer({
        library: f.library,
        target: page,
        scope: yield* authScope,
        startedAt: Date.now(),
        forceFull: true,
      })
    }),
  )
  expect(consumer.files.map((file) => file.path).sort()).toEqual([
    "SKILL.md",
    "agents/openai.yaml",
    "references/guide.md",
    "scripts/smoke.sh",
  ])
  expect(consumer.files.find((file) => file.path === "scripts/smoke.sh")?.mode).toBe("100755")
  const main = consumer.files.find((file) => file.path === "SKILL.md")!
  const body = new TextDecoder().decode(f.base.objects.get("objects/" + main.sha256))
  expect(parseYaml(/^---\n([\s\S]*?)\n---/u.exec(body)![1]!)).toMatchObject({
    license: "MIT",
    "user-invokable": false,
    metadata: { version: 7 },
  })
  expect(f.writes()).toHaveLength(0)
  expect(property(original[0]!.payload).status).toBe("needs_review")
}, 30000)

test("the next independent Record rechecks a body changed after the review POST", async () => {
  const { f, plan, page, selected } = await failedCurrentTreeOriginal()
  const review = await f.run(reviewSharedCreateCurrentTree(selected))
  const failure = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      let changed = false
      return yield* Effect.flip(
        applySharedCreateCurrentTree({
          entry: selected.entry,
          plan,
          review,
          reviewId: review.review_id,
        }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              api.request(path, body, options).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (!changed && path === "v1/pages" && options?.method === "POST") {
                      changed = true
                      f.base.bodies.set(page, f.base.bodies.get(page) + "\nConcurrent author edit")
                    }
                  }),
                ),
              ),
          }),
        ),
      )
    }),
  )
  expect(failure.code).toBe("SHARED_CREATE_CURRENT_TREE_REQUIRED")
  expect(f.writes()).toHaveLength(1)
  expect(
    await f.run(querySharedRecords(f.library, { skillPageId: page, kind: "file_event" })),
  ).toHaveLength(0)
})

test("cold acceptance refuses a missing independent ownership event and does not substitute the old create event", async () => {
  const { f, plan, page, selected } = await failedCurrentTreeOriginal()
  const review = await f.run(reviewSharedCreateCurrentTree(selected))
  await f.run(
    applySharedCreateCurrentTree({
      entry: selected.entry,
      plan,
      review,
      reviewId: review.review_id,
    }),
  )
  await f.run(updateSkill(page, { database: selected.entry, enabled: true }))
  for (const [id, row] of f.base.records)
    if (text(property(property(row.properties).record).rich_text) === review.events[0]!.event_id)
      f.base.records.delete(id)
  await f.run(
    appendSharedRecord(f.library, {
      mode: "create",
      kind: "file_event",
      skillPageId: page,
      recordId: plan.files[0]!.event.event_id,
      operationId: plan.files[0]!.event.event_id,
      entityId: plan.files[0]!.file_id,
      payload: plan.files[0]!.event,
    }),
  )
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  f.credential("cold-missing-acceptance-event")
  const failed = await f.run(
    Effect.flip(
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library: f.library,
          target: page,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
        })
      }),
    ),
  )
  expect(failed.code).toBe("SHARED_CREATE_CURRENT_TREE_REQUIRED")
  expect(f.writes()).toHaveLength(0)
})

test("reviewed authored body, metadata, missing raw chunk and extra binding drift all refuse before any new write", async () => {
  for (const change of [
    "body",
    "metadata",
    "raw",
    "retained-body",
    "extra-binding",
    "unknown-outcome",
  ] as const) {
    const { f, plan, page, selected } = await failedCurrentTreeOriginal()
    const review = await f.run(reviewSharedCreateCurrentTree(selected))
    if (change === "body") f.base.bodies.set(page, f.base.bodies.get(page) + "\nchanged")
    if (change === "metadata")
      property(property(f.skills.get(page)).properties).description = {
        id: "description",
        type: "rich_text",
        rich_text: [{ plain_text: "changed" }],
        has_more: false,
      }
    if (change === "raw") {
      const chunk = plan.resources![0]!.prepared.objects[0]!.object_id
      for (const [id, row] of f.base.records)
        if (text(property(property(row.properties).record).rich_text) === chunk)
          f.base.records.delete(id)
    }
    if (change === "retained-body") {
      const object = plan.files[0]!.content.object_id
      for (const [id, row] of f.base.records)
        if (text(property(property(row.properties).record).rich_text) === object)
          f.base.records.delete(id)
    }
    if (change === "extra-binding") {
      const row = structuredClone(
        [...f.files.values()].find(
          (value) =>
            property(value.parent).data_source_id === f.library.files.data_source_id &&
            text(property(property(value.properties).path).rich_text) === "references/guide.md",
        )!,
      )
      row.id = "00000000-0000-4000-8000-00000000f999"
      property(row.properties).file_id = {
        id: "file_id",
        type: "rich_text",
        rich_text: [{ plain_text: "foreign-file" }],
      }
      property(row.properties).path = {
        id: "path",
        type: "rich_text",
        rich_text: [{ plain_text: "references/foreign.md" }],
      }
      f.files.set(String(row.id), row)
    }
    if (change === "unknown-outcome") f.removeCompletion(plan.operation_id)
    f.clear()
    await f.run(
      Effect.flip(
        applySharedCreateCurrentTree({
          entry: selected.entry,
          plan,
          review,
          reviewId: review.review_id,
        }),
      ),
    )
    expect(f.writes(), change).toHaveLength(0)
  }
}, 30000)

test("a foreign pending Record blocks the full current-tree decision", async () => {
  const { f, plan, page, selected } = await failedCurrentTreeOriginal()
  const review = await f.run(reviewSharedCreateCurrentTree(selected))
  await f.run(
    appendSharedRecord(f.library, {
      mode: "create",
      kind: "operation",
      skillPageId: page,
      recordId: "foreign-pending",
      operationId: "foreign-pending",
      entityId: plan.files[0]!.file_id,
      payload: { pending: true },
    }),
  )
  f.clear()
  expect(
    (
      await f.run(
        Effect.flip(
          applySharedCreateCurrentTree({
            entry: selected.entry,
            plan,
            review,
            reviewId: review.review_id,
          }),
        ),
      )
    ).code,
  ).toBe("SHARED_CREATE_CURRENT_TREE_REQUIRED")
  expect(f.writes()).toHaveLength(0)
})

test("unknown independent Record is never resent; reconcile is read-only and a visible exact prefix permits only the unattempted suffix", async () => {
  for (const visible of [false, true]) {
    const { f, plan, selected } = await failedCurrentTreeOriginal()
    const review = await f.run(reviewSharedCreateCurrentTree(selected))
    const input = { entry: selected.entry, plan, review, reviewId: review.review_id }
    f.base.unknownRecord("file_event", visible)
    await f.run(Effect.flip(applySharedCreateCurrentTree(input)))
    expect(f.writes()).toHaveLength(2)
    const originalDispatches = [...f.base.json].filter(([key]) => key.includes("/source-op-"))
    f.clear()
    await f.run(Effect.flip(reconcileSharedCreateCurrentTree(selected)))
    expect(f.writes()).toHaveLength(0)
    if (visible) {
      expect((await f.run(applySharedCreateCurrentTree(input))).verified).toBe(true)
      expect(f.writes()).toHaveLength(4)
      const eventPosts = f
        .writes()
        .filter(
          (call) =>
            property(
              property(
                property(property(call.body).properties)[f.library.records.property_ids.Kind!],
              ).select,
            ).name === "file_event",
        )
      expect(
        eventPosts.map((call) =>
          text(
            property(
              property(property(call.body).properties)[
                f.library.records.property_ids["Record ID"]!
              ],
            ).rich_text,
          ),
        ),
      ).toEqual(review.events.slice(1).map((event) => event.event_id))
    } else {
      expect((await f.run(Effect.flip(applySharedCreateCurrentTree(input)))).code).toBe(
        "SHARED_CREATE_CURRENT_TREE_REQUIRED",
      )
      expect(f.writes()).toHaveLength(0)
    }
    for (const [key, value] of originalDispatches) expect(f.base.json.get(key)).toEqual(value)
  }
}, 30000)
