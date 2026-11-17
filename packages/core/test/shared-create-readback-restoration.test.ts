import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { authScope } from "../src/catalog.ts"
import { property, text } from "../src/model.ts"
import {
  prepareSharedCreate,
  executeSharedCreate,
  loadSharedCreatePlan,
  loadPendingSharedCreates,
} from "../src/shared-create.ts"
import {
  reviewSharedCreateRestoration,
  applySharedCreateRestoration,
  reconcileSharedCreateRestoration,
} from "../src/shared-create-restoration.ts"
import { sharedCreateOutcomeId } from "../src/shared-create-outcome.ts"
import { FileEventSchema, normalizeObservedBody } from "../src/shared-file-state.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { sha256 } from "../src/store.ts"
import { sharedCreateFixture } from "./shared-create-fixture.ts"

const encode = (text: string) => new TextEncoder().encode(text)
async function original(
  resources = true,
  mainText = "# Original\n\nUse Sparkle.app.\n",
  observedText = "# Original\n\nUse [Sparkle.app](http://Sparkle.app).",
) {
  const f = sharedCreateFixture()
  const input = {
    kind: "skill" as const,
    name: "Reviewed original",
    description: "Original ACK readback",
    main: "SKILL.md",
    files: [
      { path: "SKILL.md", bytes: encode(mainText) },
      ...(resources
        ? [
            {
              path: "assets/data.bin",
              bytes: new Uint8Array([0, 255, 17, 0]),
              mode: "100644" as const,
            },
            {
              path: "scripts/run.js",
              bytes: encode("console.log('retained bytes')\n"),
              mode: "100755" as const,
            },
          ]
        : []),
    ],
  }
  const plan = await f.run(
    prepareSharedCreate(f.library, { portable: input, completeResources: true }),
  )
  f.onCreate((page, kind) => {
    if (kind === "skill") f.base.bodies.set(String(page.id), observedText)
  })
  const error = await f.run(Effect.flip(executeSharedCreate(f.library, { plan, mode: "create" })))
  expect(error.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  expect(property(error.details).stage).toBe("manifest")
  const page = String(property(error.details).skill_page_id)
  const acceptedObservedSha256 = await f.run(
    sha256(normalizeObservedBody(f.base.bodies.get(page)!)),
  )
  const selected = {
    entry: f.library.skills.database_id,
    plan,
    target: page,
    acceptedObservedSha256,
  }
  f.onCreate(() => {})
  f.clear()
  return { f, input, plan, page, selected }
}
async function reviewed(resources = true) {
  const x = await original(resources)
  const review = await x.f.run(reviewSharedCreateRestoration(x.selected))
  expect(review).toMatchObject({
    version: 2,
    original_outcome_sha256: null,
    decision: "resume_reviewed_import_readback",
    bootstrap: { kind: "acknowledged_main_before_manifest" },
  })
  expect(x.f.writes()).toHaveLength(0)
  return {
    ...x,
    review,
    apply: { entry: x.selected.entry, plan: x.plan, review, reviewId: review.review_id },
  }
}

test.each([true, false])(
  "reviewed complete sole-main resources=%s completes the original page and cold bytes",
  async (resources) => {
    const x = await reviewed(resources),
      { f } = x
    const dry = await f.run(applySharedCreateRestoration({ ...x.apply, dryRun: true }))
    expect(dry).toMatchObject({
      status: "planned",
      original_status: "acknowledged_main_before_manifest",
      write_plan: { maximum_native_page_creates: resources ? 2 : 0, existing_body_patches: 0 },
    })
    expect(f.writes()).toHaveLength(0)
    const completed = await f.run(applySharedCreateRestoration(x.apply))
    expect(completed).toMatchObject({
      status: "created",
      verified: true,
      skill_page_id: x.page,
      operation_id: x.plan.operation_id,
    })
    expect(f.nativeCreates()).toHaveLength(resources ? 2 : 0)
    expect(f.enablePatches()).toHaveLength(1)
    expect(
      f.calls.filter((call) => call.path.includes("/markdown") && call.method !== "GET"),
    ).toHaveLength(0)
    expect(
      await f.run(
        querySharedRecords(f.library, {
          skillPageId: x.page,
          kind: "operation",
          recordId: sharedCreateOutcomeId(x.plan.operation_id),
        }),
      ),
    ).toEqual([])
    f.clear()
    expect(await f.run(applySharedCreateRestoration(x.apply))).toMatchObject({
      verified: true,
      reused: true,
    })
    expect(f.writes()).toHaveLength(0)
    f.base.json.clear()
    f.base.objects.clear()
    f.credential("independent-complete-readback-reader")
    const reconstructed = await f.run(
      loadSharedCreatePlan(f.library, { skillPageId: x.page, operationId: x.plan.operation_id }),
    )
    expect(canonicalSharedJson(reconstructed)).toBe(canonicalSharedJson(x.plan))
    const events = (
      await f.run(querySharedRecords(f.library, { skillPageId: x.page, kind: "file_event" }))
    ).map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload))
    expect(
      await f.run(loadPendingSharedCreates(f.library, { skillPageId: x.page, events })),
    ).toEqual([])
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
    expect(snapshot.files.map((file) => file.path).sort()).toEqual(
      x.input.files.map((file) => file.path).sort(),
    )
    for (const original of x.input.files.filter((file) => file.path !== "SKILL.md")) {
      const file = snapshot.files.find((file) => file.path === original.path)!
      expect(f.base.objects.get(`objects/${file.sha256}`)).toEqual(original.bytes)
      expect(file.mode).toBe(original.mode)
    }
    const main = snapshot.files.find((file) => file.path === "SKILL.md")!
    const exportedMain = new TextDecoder().decode(f.base.objects.get(`objects/${main.sha256}`))
    // The portable entry also contains its preserved/generated YAML header.
    expect(exportedMain).toContain(normalizeObservedBody(f.base.bodies.get(x.page)!))
    expect(events.find((event) => event.file_id === x.plan.files[0]!.file_id)).toMatchObject({
      kind: "adopted",
      content: { sha256: x.selected.acceptedObservedSha256 },
    })
    expect(f.writes()).toHaveLength(0)
  },
)

test("complete readback review requires the explicit observed hash and refuses an unacknowledged main", async () => {
  const x = await original(),
    { f } = x
  for (const acceptedObservedSha256 of [undefined, "f".repeat(64)]) {
    expect(
      (
        await f.run(
          Effect.flip(reviewSharedCreateRestoration({ ...x.selected, acceptedObservedSha256 })),
        )
      ).code,
    ).toBe("SHARED_CREATE_RESTORATION_REQUIRED")
  }
  for (const key of f.base.json.keys()) if (key.includes("/source-ack-")) f.base.json.delete(key)
  expect((await f.run(Effect.flip(reviewSharedCreateRestoration(x.selected)))).code).toMatch(
    /SHARED_CREATE/,
  )
  expect(f.writes()).toHaveLength(0)
})

test("explicit original-main review accepts the literal custom-tag list representation", async () => {
  const x = await original(
    false,
    "# Plan\n\n<prd-template>\n\n<user-story-example>\n1. As <actor>, I want <feature>.\n</user-story-example>\n\n</prd-template>\n",
    "# Plan\n\n\\<prd-template>\n\n\\<user-story-example>\n\n1. As \\<actor>, I want \\<feature>.<br />\\</user-story-example>\n\n\\</prd-template>",
  )
  const review = await x.f.run(reviewSharedCreateRestoration(x.selected))
  expect(
    await x.f.run(
      applySharedCreateRestoration({
        entry: x.selected.entry,
        plan: x.plan,
        review,
        reviewId: review.review_id,
      }),
    ),
  ).toMatchObject({ verified: true, skill_page_id: x.page })
  expect(x.f.nativeCreates()).toHaveLength(0)
})

test("explicit observed hash never accepts a changed authored link destination", async () => {
  const x = await original(
    false,
    "# Plan\n\nRead [guide](https://example.com/a).\n",
    "# Plan\n\nRead [guide](https://example.com/b).",
  )
  expect(await x.f.run(Effect.flip(reviewSharedCreateRestoration(x.selected)))).toMatchObject({
    code: "SHARED_CREATE_BODY_MISMATCH",
    details: { component: "links" },
  })
  expect(x.f.writes()).toHaveLength(0)
})

test.each(["body", "ack", "resource"] as const)(
  "reviewed readback refuses changed %s before writing",
  async (kind) => {
    const x = await reviewed(),
      { f } = x
    let plan = x.plan
    if (kind === "body")
      f.base.bodies.set(x.page, "## Original\n\nUse [Sparkle.app](http://Sparkle.app).")
    if (kind === "ack") {
      const key = [...f.base.json.keys()].find(
        (key) =>
          key.includes("/source-ack-") &&
          property(property(f.base.json.get(key)).response).id === x.page,
      )!
      f.base.json.set(key, { ...property(f.base.json.get(key)), response_hash: "f".repeat(64) })
    }
    if (kind === "resource")
      plan = {
        ...plan,
        resources: plan.resources!.map((file, index) =>
          index
            ? file
            : {
                ...file,
                prepared: {
                  ...file.prepared,
                  objects: file.prepared.objects.map((object) => ({
                    ...object,
                    payload: { ...object.payload, data: "AAAA" },
                  })),
                },
              },
        ),
      }
    f.clear()
    expect(
      (await f.run(Effect.flip(applySharedCreateRestoration({ ...x.apply, plan })))).code,
    ).toMatch(/SHARED_CREATE|SHARED_RESOURCE/)
    expect(f.writes()).toHaveLength(0)
  },
)

test.each([true, false])(
  "an unknown raw-resource suffix visible=%s is never replayed",
  async (visible) => {
    const x = await reviewed(),
      { f } = x
    f.unknown("file", visible)
    expect((await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))).code).toBe(
      "WRITE_OUTCOME_UNKNOWN",
    )
    f.clear()
    expect((await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))).code).toMatch(
      /SHARED_CREATE|WRITE_OUTCOME/,
    )
    expect(f.writes()).toHaveLength(0)
  },
)

test("cold recovery completion cannot hide a missing retained raw-resource object", async () => {
  const x = await reviewed(),
    { f } = x
  await f.run(applySharedCreateRestoration(x.apply))
  const removed = x.plan.resources![0]!.prepared.objects[0]!.object_id
  let count = 0
  for (const [key, row] of f.base.records)
    if (text(property(property(row.properties).record).rich_text) === removed) {
      f.base.records.delete(key)
      count++
    }
  expect(count).toBe(1)
  f.base.json.clear()
  f.base.objects.clear()
  f.credential("cold-missing-resource")
  f.clear()
  expect((await f.run(Effect.flip(reconcileSharedCreateRestoration(x.selected)))).code).toMatch(
    /SHARED_RESOURCE|SHARED_RECORD|SHARED_CREATE|RETAINED/,
  )
  expect(f.writes()).toHaveLength(0)
})
