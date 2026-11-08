import { authScope } from "../src/catalog.ts"
import { Notion } from "../src/notion.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { property } from "../src/model.ts"
import { makeSharedCreatePlan } from "../src/shared-create-model.ts"
import {
  executeSharedCreate,
  loadPendingSharedCreates,
  loadSharedCreatePlan,
} from "../src/shared-create.ts"
import {
  applySharedCreateRecovery,
  reconcileSharedCreateRecovery,
  reviewSharedCreateRecovery,
} from "../src/shared-create-recovery.ts"
import { FileEventSchema } from "../src/shared-file-state.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { querySharedSkillIndex } from "../src/shared-skill-index.ts"
import {
  fixture,
  library as sourceLibrary,
  ids as sourceIds,
  fixedProjection,
} from "./shared-source-projection-fixture.ts"

const library: SharedLibrary = sourceLibrary

const authored =
  "---\nname: initial-source\ndescription: Initial complete member\nlicense: MIT\n---\n\n\n# Initial\n\n## Section\nA paragraph.\n"
const originalWire = "\n<h1>Initial</h1>\n\n## Section\nA paragraph."
const observed = "# Initial\n\n## Section\n\nA paragraph."

async function partial() {
  const f = fixture([], {
    main: authored,
    recovery: true,
    readback: (wire) =>
      wire === originalWire ? observed : wire.replace(/^<h1>([^\n]*)<\/h1>(?=\n|$)/u, "# $1"),
  })
  const current = await f.prepare(true)
  const member = f.snapshot.members[0]!
  const plan = await f.run(
    makeSharedCreatePlan(
      library,
      {
        portable: {
          ...member.portable,
          files: member.portable.files.filter((file) => file.path.endsWith(".md")),
        },
        sourceProjection: current.source_projection,
        enabled: true,
      },
      8,
    ),
  )
  const failure = await f.run(Effect.flip(executeSharedCreate(library, { plan, mode: "create" })))
  expect(failure.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  expect(property(failure.details).stage).toBe("manifest")
  const target = property(failure.details).skill_page_id
  if (typeof target !== "string") throw new Error("Missing original acknowledged page")
  expect(f.nativeCreates()).toHaveLength(1)
  expect(
    await f.run(querySharedRecords(library, { skillPageId: target, kind: "operation" })),
  ).toEqual([])
  const selection = {
    entry: library.skills.database_id,
    operationId: plan.operation_id,
    target,
    plan,
  }
  f.clear()
  return { f, plan, target, selection }
}

test("an acknowledged v8 main before the manifest has a separate readonly v9 recovery review", async () => {
  const { f, plan, target, selection } = await partial()
  const before = structuredClone([...f.base.json])
  const review = await f.run(reviewSharedCreateRecovery(selection))
  expect(review.version).toBe(2)
  if (review.version !== 2) throw new Error("Expected the historical v8 to v9 review")
  expect(review.original_operation_id).toBe(plan.operation_id)
  expect(review.original_outcome_sha256).toBeNull()
  expect(review.projection_version).toBe(9)
  expect(review.bindings).toHaveLength(1)
  expect(review.bindings[0]?.page_id).toBe(target)
  expect(review.files[0]?.content.mode).toBe("100644")
  expect(property(review.files[0]?.content).frontmatter).toContain("license: MIT")
  expect(JSON.parse(review.observations[0]!.response_json).markdown).toBe(observed)
  const dry = await f.run(
    applySharedCreateRecovery({ plan, review, reviewId: review.review_id, dryRun: true }),
  )
  expect(dry.status).toBe("planned")
  expect(property(dry).remaining_pages).toBe(1)
  expect(f.writes()).toHaveLength(0)
  expect([...f.base.json]).toEqual(before)
})

test("prefix recovery preserves the original main and plan, completes only the undispatched suffix and proves cold ownership", async () => {
  const { f, plan, target, selection } = await partial()
  const review = await f.run(reviewSharedCreateRecovery(selection))
  const originalPlan = structuredClone(plan)
  f.clear()
  const result = await f.run(
    applySharedCreateRecovery({ plan, review, reviewId: review.review_id }),
  )
  expect(result.status).toBe("recovered")
  expect(property(result).existing_pages_preserved).toBe(1)
  expect(property(result).created_pages).toBe(1)
  expect(f.nativeCreates()).toHaveLength(1)
  expect(
    f
      .nativeCreates()
      .every(
        (call) =>
          property(property(call.body).parent).data_source_id === library.files.data_source_id,
      ),
  ).toBe(true)
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.includes("/markdown")),
  ).toHaveLength(0)
  expect(f.base.bodies.get(target)).toBe(observed)
  expect(plan).toEqual(originalPlan)
  expect(
    await f.run(
      loadSharedCreatePlan(library, { skillPageId: target, operationId: plan.operation_id }),
    ),
  ).toEqual(plan)
  const index = await f.run(querySharedSkillIndex(library, target))
  expect(index.enabled).toBe(true)
  expect(index.main.page_id).toBe(target)
  expect(index.source_reference).toBe(fixedProjection(plan).binding.source_id)
  const events = (
    await f.run(querySharedRecords(library, { skillPageId: target, kind: "file_event" }))
  ).map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload))
  expect(events).toHaveLength(plan.files.length)
  expect(events.every((event) => event.event_id.startsWith("recovery-file-"))).toBe(true)
  f.credential("independent-prefix-reader")
  f.clear()
  expect(await f.run(loadPendingSharedCreates(library, { skillPageId: target, events }))).toEqual(
    [],
  )
  expect(f.currentBodies()).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
  const completed = await f.run(reconcileSharedCreateRecovery(selection))
  expect(property(completed).current_snapshot_verified).toBe(false)
  expect(f.currentBodies()).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
})

function pendingMutation(f: Awaited<ReturnType<typeof partial>>["f"], operation: string) {
  const found = [...f.base.json].find(
    ([key, value]) =>
      /\/source-op-[a-f0-9]{64}\.json$/u.test(key) &&
      String(property(value).identity).startsWith(operation + ":"),
  )
  if (!found) throw new Error("Missing original mutation fixture")
  return {
    key: found[0],
    value: property(found[1]),
    ackKey: found[0].replace("/source-op-", "/source-ack-"),
  }
}

test.each([
  "missing-journal",
  "missing-ack",
  "request-hash",
  "response-page",
  "extra-original-attempt",
  "changed-journal",
] as const)("prefix review refuses %s before any remote mutation", async (kind) => {
  const { f, plan, selection } = await partial()
  const original = pendingMutation(f, plan.operation_id)
  if (kind === "missing-journal") {
    for (const key of f.base.json.keys())
      if (key.startsWith("operations/shared-native-create/")) f.base.json.delete(key)
  } else if (kind === "missing-ack") f.base.json.delete(original.ackKey)
  else if (kind === "request-hash" || kind === "response-page") {
    const ack = structuredClone(property(f.base.json.get(original.ackKey)))
    if (kind === "request-hash") ack.request_hash = "0".repeat(64)
    else {
      property(ack.response).id = "00000000-0000-4000-8000-000000009999"
      ack.response_hash = createHash("sha256")
        .update(canonicalSharedJson(ack.response))
        .digest("hex")
    }
    f.base.json.set(original.ackKey, ack)
  } else if (kind === "extra-original-attempt") {
    f.base.json.set(
      original.key.replace(/source-op-[a-f0-9]{64}/u, "source-op-" + "f".repeat(64)),
      {
        ...original.value,
        identity: plan.operation_id + ":" + "e".repeat(64),
      },
    )
  } else {
    const key = [...f.base.json.keys()].find((key) =>
      key.startsWith("operations/shared-native-create/"),
    )!
    const journal = structuredClone(property(f.base.json.get(key)))
    property(journal.plan).description = "Changed original full input"
    f.base.json.set(key, journal)
  }
  const failure = await f.run(Effect.flip(reviewSharedCreateRecovery(selection)))
  expect(failure.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
  expect(f.writes()).toHaveLength(0)
})

test("a credential rotation cannot use the visible original main as a new bootstrap", async () => {
  const { f, selection } = await partial()
  f.credential("different-prefix-writer")
  const failure = await f.run(Effect.flip(reviewSharedCreateRecovery(selection)))
  expect(failure.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
  expect(f.writes()).toHaveLength(0)
})

test.each(["body", "enabled", "source", "duplicate-owner"] as const)(
  "changed %s after review stops before the recovery journal and writes",
  async (kind) => {
    const { f, plan, target, selection } = await partial()
    const review = await f.run(reviewSharedCreateRecovery(selection))
    const before = structuredClone([...f.base.json])
    if (kind === "body") f.base.bodies.set(target, observed + "\nHuman edit")
    if (kind === "enabled")
      property(property(f.skills.get(target)).properties).enabled = {
        id: "enabled",
        type: "checkbox",
        checkbox: true,
      }
    if (kind === "source")
      property(f.source.properties[sourceIds.Description!]).rich_text = [
        { plain_text: "Changed source definition" },
      ]
    if (kind === "duplicate-owner")
      f.seedSkill(
        "00000000-0000-4000-8000-000000009998",
        plan.skill_id,
        "Another alias",
        "skill",
        false,
      )
    f.clear()
    const failure = await f.run(
      Effect.flip(applySharedCreateRecovery({ plan, review, reviewId: review.review_id })),
    )
    expect(failure.code).toBe(
      {
        body: "SHARED_CREATE_RECOVERY_REQUIRED",
        enabled: "SHARED_CREATE_REVIEW_REQUIRED",
        source: "SHARED_CREATE_SOURCE_CHANGED",
        "duplicate-owner": "SHARED_SKILL_ID_CONFLICT",
      }[kind],
    )
    expect(f.writes()).toHaveLength(0)
    expect([...f.base.json]).toEqual(before)
  },
)

test.each([false, true])(
  "an unknown suffix POST is never repeated (visible=%s)",
  async (visible) => {
    const { f, plan, selection } = await partial()
    const review = await f.run(reviewSharedCreateRecovery(selection))
    f.unknown("file", visible)
    const failed = await f.run(
      Effect.flip(applySharedCreateRecovery({ plan, review, reviewId: review.review_id })),
    )
    expect(failed.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(f.nativeCreates()).toHaveLength(1)
    f.clear()
    const repeated = await f.run(
      Effect.flip(applySharedCreateRecovery({ plan, review, reviewId: review.review_id })),
    )
    expect(repeated.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
    expect(f.writes()).toHaveLength(0)
    expect(f.nativeCreates()).toHaveLength(0)
  },
)

test.each([false, true])(
  "a lost immutable completion reconciles only the original visible fact (visible=%s)",
  async (visible) => {
    const { f, plan, selection } = await partial()
    const review = await f.run(reviewSharedCreateRecovery(selection))
    f.unknown("recovery_outcome", visible)
    const failed = await f.run(
      Effect.flip(applySharedCreateRecovery({ plan, review, reviewId: review.review_id })),
    )
    expect(failed.code).toBe("WRITE_OUTCOME_UNKNOWN")
    f.clear()
    const repeated = await f.run(
      Effect.result(applySharedCreateRecovery({ plan, review, reviewId: review.review_id })),
    )
    expect(repeated._tag).toBe(visible ? "Success" : "Failure")
    expect(f.writes()).toHaveLength(0)
    expect(f.currentBodies()).toHaveLength(0)
  },
)

test("a rehashed review cannot change preserved mode or the original full input", async () => {
  const { f, plan, selection } = await partial()
  const review = await f.run(reviewSharedCreateRecovery(selection))
  if (review.version !== 2) throw new Error("Expected the historical v8 to v9 review")
  const tampered = structuredClone(review)
  const { review_id: _old, ...fields } = tampered
  property(fields.files[0]?.content).mode = "100755"
  property(fields.files[0]?.event).mode = "100755"
  const next = {
    ...fields,
    review_id:
      "create-recovery-" + createHash("sha256").update(canonicalSharedJson(fields)).digest("hex"),
  }
  const failed = await f.run(
    Effect.flip(applySharedCreateRecovery({ plan, review: next, reviewId: next.review_id })),
  )
  expect(failed.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
  expect(f.writes()).toHaveLength(0)
})

test.each(["truncated", "unknown_block_ids", "warnings", "has_more"] as const)(
  "an exact body with incomplete response field %s cannot authorize recovery",
  async (field) => {
    const { f, selection } = await partial()
    const action = Effect.gen(function* () {
      const api = yield* Notion
      return yield* reviewSharedCreateRecovery(selection).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            api.request(path, body, options).pipe(
              Effect.map((raw) =>
                path.includes("/markdown?")
                  ? {
                      ...property(raw),
                      [field]:
                        field === "unknown_block_ids"
                          ? ["unread"]
                          : field === "warnings"
                            ? ["incomplete"]
                            : true,
                    }
                  : raw,
              ),
            ),
        }),
      )
    })
    const failure = await f.run(Effect.flip(action))
    expect(failure.code).toBe("BODY_INCOMPLETE")
    expect(f.writes()).toHaveLength(0)
  },
)

test.each(["body", "source"] as const)(
  "a %s edit during the remaining allocation stops the next new mutation",
  async (kind) => {
    const { f, plan, target, selection } = await partial()
    const review = await f.run(reviewSharedCreateRecovery(selection))
    f.onCreate((_page, type) => {
      if (type !== "file") return
      if (kind === "body") f.base.bodies.set(target, observed + "\nEdit during recovery")
      else
        property(f.source.properties[sourceIds.Description!]).rich_text = [
          { plain_text: "Changed during recovery" },
        ]
    })
    f.clear()
    const failure = await f.run(
      Effect.flip(applySharedCreateRecovery({ plan, review, reviewId: review.review_id })),
    )
    expect(failure.code).toBe(
      kind === "body" ? "SHARED_CREATE_RECOVERY_REQUIRED" : "SHARED_CREATE_SOURCE_CHANGED",
    )
    expect(f.nativeCreates()).toHaveLength(1)
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(0)
    expect(property(property(f.skills.get(target)).properties).enabled).toMatchObject({
      checkbox: false,
    })
    if (kind === "body") expect(f.base.bodies.get(target)).toBe(observed + "\nEdit during recovery")
    f.clear()
    await f.run(
      Effect.flip(applySharedCreateRecovery({ plan, review, reviewId: review.review_id })),
    )
    expect(f.writes()).toHaveLength(0)
  },
)

test("completed prefix recovery opens the original full fixed Git tree under independent readonly consumption", async () => {
  const { f, plan, target, selection } = await partial()
  const review = await f.run(reviewSharedCreateRecovery(selection))
  await f.run(applySharedCreateRecovery({ plan, review, reviewId: review.review_id }))
  f.credential("independent-prefix-consumer")
  f.clear()
  const consumed = await f.run(
    Effect.gen(function* () {
      return yield* openSharedConsumer({
        library,
        target,
        scope: yield* authScope,
        startedAt: Date.now(),
        forceFull: true,
        readOnly: true,
      })
    }),
  )
  expect(consumed.files.map((file) => file.path)).toEqual(
    f.snapshot.members[0]!.portable.files.map((file) => file.path),
  )
  expect(consumed.files.find((file) => file.path === "scripts/run.js")?.mode).toBe("100755")
  const main = consumed.files.find((file) => file.path === "SKILL.md")!
  expect(new TextDecoder().decode(f.base.objects.get("objects/" + main.sha256))).toContain(
    '"license": "MIT"',
  )
  expect(f.writes()).toHaveLength(0)
})

test.each(["Description", "Skill ID", "Main File ID", "Source", "Enabled", "Origin"] as const)(
  "ACK metadata must match the original requested %s even after current equality and a new response hash",
  async (name) => {
    const { f, plan, selection } = await partial()
    const original = pendingMutation(f, plan.operation_id)
    const ack = structuredClone(property(f.base.json.get(original.ackKey)))
    const field = property(
      property(property(ack.response).properties)[library.skills.property_ids[name]!],
    )
    if (name === "Enabled") field.checkbox = true
    else if (name === "Origin") field.relation = [{ id: "00000000-0000-4000-8000-000000009997" }]
    else field.rich_text = [{ type: "text", text: { content: "Another original value" } }]
    ack.response_hash = createHash("sha256").update(canonicalSharedJson(ack.response)).digest("hex")
    f.base.json.set(original.ackKey, ack)
    const failure = await f.run(Effect.flip(reviewSharedCreateRecovery(selection)))
    expect(failure.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
    expect(f.writes()).toHaveLength(0)
  },
)

test("ACK metadata permits generated fields and renamed display keys with the same registered property ID", async () => {
  const { f, plan, selection } = await partial()
  const original = pendingMutation(f, plan.operation_id)
  const ack = structuredClone(property(f.base.json.get(original.ackKey)))
  const response = property(ack.response),
    props = property(response.properties)
  const id = library.skills.property_ids["Main File ID"]!
  props["Renamed display field"] = props[id]
  delete props[id]
  response.url = "https://www.notion.so/generated"
  response.last_edited_time = "2026-11-08T16:00:00Z"
  ack.response_hash = createHash("sha256").update(canonicalSharedJson(ack.response)).digest("hex")
  f.base.json.set(original.ackKey, ack)
  expect((await f.run(reviewSharedCreateRecovery(selection))).version).toBe(2)
  expect(f.writes()).toHaveLength(0)
})
