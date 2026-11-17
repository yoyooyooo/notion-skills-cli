import { expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { fail, property, text } from "../src/model.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { sharedCreateOutcomeId } from "../src/shared-create-outcome.ts"
import {
  applySharedCreateRestoration,
  reconcileSharedCreateRestoration,
  reviewSharedCreateRestoration,
} from "../src/shared-create-restoration.ts"
import { sharedCreateLinkRepairProofsEntity } from "../src/shared-create-link-repair.ts"
import { assertImportedMarkdownContent } from "../src/shared-import-markdown.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { Store } from "../src/store.ts"
import { parseYaml } from "../src/yaml.ts"
import { withSharedAuthoringTarget } from "../src/shared-authoring-context.ts"
import {
  executeSharedMetadataWrite,
  prepareSharedMetadataWrite,
} from "../src/shared-metadata-write.ts"
import {
  failedTablePlusOriginal,
  tablePlusPath,
} from "./shared-create-table-plus-restoration-fixture.ts"

test("v4 repairs only the acknowledged supporting file before the unattempted suffix, preserving the original failure", async () => {
  const x = await failedTablePlusOriginal(),
    { f } = x
  expect(x.review.version).toBe(4)
  if (x.review.version !== 4) throw new Error("Expected table-literal review")
  expect(x.review.table_plus).toMatchObject({
    path: tablePlusPath,
    mode: "100644",
    changed_literals: 1,
  })
  const dry = await f.run(applySharedCreateRestoration({ ...x.apply, dryRun: true }))
  expect(dry).toMatchObject({
    status: "planned",
    write_plan: { maximum_native_page_creates: 2, existing_body_patches: 1, enabled: false },
  })
  expect(f.writes()).toHaveLength(0)
  const result = await f.run(applySharedCreateRestoration(x.apply))
  expect(result).toMatchObject({
    verified: true,
    operation_id: x.plan.operation_id,
    skill_page_id: x.page,
  })
  const patchAt = f.calls.findIndex(
    (call) => call.method === "PATCH" && call.path.endsWith("/markdown"),
  )
  expect(patchAt).toBeGreaterThanOrEqual(0)
  expect(f.nativeCreates()).toHaveLength(2)
  expect(f.nativeCreates().every((call) => f.calls.indexOf(call) > patchAt)).toBe(true)
  const patches = f.writes().filter((call) => call.method === "PATCH")
  expect(patches).toHaveLength(1)
  expect(patches[0]!.path).toContain(x.review.bindings.at(-1)!.page_id)
  const repaired = f.base.bodies.get(x.review.bindings.at(-1)!.page_id)!
  expect(() =>
    assertImportedMarkdownContent(
      x.plan.files.find((file) => file.path === tablePlusPath)!.projection.markdown,
      repaired,
    ),
  ).not.toThrow()
  expect(repaired).toContain("<b>+</b>")
  const original = await f.run(
    querySharedRecords(f.library, {
      skillPageId: x.page,
      kind: "operation",
      recordId: sharedCreateOutcomeId(x.plan.operation_id),
    }),
  )
  expect(canonicalSharedJson(original[0])).toBe(x.originalFailure)
  f.clear()
  expect(await f.run(applySharedCreateRestoration(x.apply))).toMatchObject({
    verified: true,
    reused: true,
  })
  expect(f.writes()).toHaveLength(0)

  // Represent the separate, explicit enable operation. Recovery itself remains disabled.
  property(property(f.skills.get(x.page)).properties).enabled = {
    id: "enabled",
    type: "checkbox",
    checkbox: true,
  }
  f.base.json.clear()
  f.base.objects.clear()
  f.credential("cold-v4-ordinary-consumer")
  f.clear()
  expect(await f.run(reconcileSharedCreateRestoration(x.selected))).toMatchObject({
    verified: true,
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
    x.portable.files.map((file) => file.path).sort(),
  )
  for (const original of x.portable.files) {
    const file = snapshot.files.find((file) => file.path === original.path)!
    expect(file.mode).toBe(original.mode)
    const current = f.base.objects.get("objects/" + file.sha256)!
    if (original.path.endsWith(".md")) {
      const currentText = new TextDecoder().decode(current)
      if (original.path === "SKILL.md") {
        const split = (value: string) => /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(value)!
        const expected = split(new TextDecoder().decode(original.bytes))
        const observed = split(currentText)
        expect(parseYaml(observed[1]!)).toEqual(parseYaml(expected[1]!))
        expect(() => assertImportedMarkdownContent(expected[2]!, observed[2]!)).not.toThrow()
      } else
        expect(() =>
          assertImportedMarkdownContent(new TextDecoder().decode(original.bytes), currentText),
        ).not.toThrow()
    } else expect(current).toEqual(original.bytes)
  }
  expect(f.writes()).toHaveLength(0)
})

test.each([true, false])(
  "unknown table repair visible=%s never replays or allocates the suffix",
  async (visible) => {
    const x = await failedTablePlusOriginal(),
      { f } = x
    f.unknown("body", visible)
    const failed = await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))
    expect(failed.code).toMatch(/WRITE_OUTCOME_UNKNOWN|SOURCE_WRITE_UNKNOWN/)
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
    expect(f.nativeCreates()).toHaveLength(0)
    f.clear()
    await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))
    expect(f.writes()).toHaveLength(0)
  },
)

test.each(["body", "ack", "input", "owner", "mode", "metadata", "source"] as const)(
  "v4 refuses changed %s with zero writes",
  async (changed) => {
    const x = await failedTablePlusOriginal(),
      { f } = x
    const target = x.review.bindings.at(-1)!
    let apply = x.apply
    if (changed === "body")
      f.base.bodies.set(target.page_id, f.base.bodies.get(target.page_id)! + "\nLater edit.")
    if (changed === "ack") {
      const key = [...f.base.json.keys()].find(
        (key) =>
          key.includes("/source-ack-") &&
          property(property(f.base.json.get(key)).response).id === target.page_id,
      )!
      expect(key).toBeDefined()
      f.base.json.set(key, { ...property(f.base.json.get(key)), response_hash: "f".repeat(64) })
    }
    if (changed === "input") {
      const plan = structuredClone(x.plan)
      const file = plan.files.find((file) => file.path === tablePlusPath)!
      Object.assign(file.input, { text: file.input.text + "\nUnreviewed input." })
      apply = { ...apply, plan }
    }
    if (changed === "owner")
      property(property(f.files.get(target.page_id)).properties).skill = {
        id: "skill",
        type: "relation",
        relation: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
        has_more: false,
      }
    if (changed === "mode") {
      const plan = structuredClone(x.plan)
      Object.assign(plan.files.find((file) => file.path === tablePlusPath)!.input, {
        mode: "100755",
      })
      apply = { ...apply, plan }
    }
    if (changed === "metadata")
      property(property(f.skills.get(x.page)).properties).description = {
        id: "description",
        type: "rich_text",
        rich_text: [{ plain_text: "Concurrent metadata" }],
        has_more: false,
      }
    if (changed === "source")
      property(property(f.skills.get(x.page)).properties).source = {
        id: "source",
        type: "rich_text",
        rich_text: [{ plain_text: "another-source" }],
        has_more: false,
      }
    f.clear()
    await f.run(Effect.flip(applySharedCreateRestoration(apply)))
    expect(f.writes()).toHaveLength(0)
  },
)

test.each(["text", "code", "href"] as const)(
  "review rejects extra %s damage rather than accepting plus/bullet equivalence",
  async (component) => {
    const x = await failedTablePlusOriginal(),
      { f } = x
    const page = x.review.bindings.at(-1)!.page_id
    const raw = f.base.bodies.get(page)!
    const changed =
      component === "text"
        ? raw.replace("No other text", "Lost text")
        : component === "code"
          ? raw.replace("on_blur()", "deleted_code()")
          : raw.replace("https://example.test/capabilities", "https://example.test/wrong")
    expect(changed).not.toBe(raw)
    f.base.bodies.set(page, changed)
    f.clear()
    await f.run(Effect.flip(reviewSharedCreateRestoration(x.selected)))
    expect(f.writes()).toHaveLength(0)
  },
)

test.each(["SKILL.md", "references/a-keep.md", "references/z-tail.md"])(
  "review cannot select %s outside the exact failed prefix endpoint",
  async (path) => {
    const x = await failedTablePlusOriginal(),
      { f } = x
    f.clear()
    await f.run(
      Effect.flip(reviewSharedCreateRestoration({ ...x.selected, repairTablePlus: path })),
    )
    expect(f.writes()).toHaveLength(0)
  },
)

test("cold completion requires its immutable table-repair ACK proof", async () => {
  const x = await failedTablePlusOriginal(),
    { f } = x
  await f.run(applySharedCreateRestoration(x.apply))
  const proofs = await f.run(
    querySharedRecords(f.library, {
      skillPageId: x.page,
      kind: "operation",
      entityId: sharedCreateLinkRepairProofsEntity,
    }),
  )
  expect(proofs).toHaveLength(1)
  expect(property(proofs[0]!.payload).kind).toBe("original_create_table_plus_repair")
  for (const [key, row] of f.base.records)
    if (text(property(property(row.properties).record).rich_text) === proofs[0]!.record_id)
      f.base.records.delete(key)
  f.base.json.clear()
  f.base.objects.clear()
  f.credential("cold-missing-table-proof")
  f.clear()
  await f.run(Effect.flip(reconcileSharedCreateRestoration(x.selected)))
  expect(f.writes()).toHaveLength(0)
})

test.each([false, true])(
  "a durable repair ACK resumes only its untouched suffix; foreign pending=%s",
  async (foreignPending) => {
    const x = await failedTablePlusOriginal(),
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
                    property(property(value).response).id === x.review.bindings.at(-1)!.page_id &&
                    typeof property(property(value).response).markdown === "string"
                  ) {
                    interrupted = true
                    return Effect.fail(
                      fail("STATE_CONFLICT", "Controlled interruption after durable ACK"),
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
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
    expect(f.nativeCreates()).toHaveLength(0)
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
            executeSharedMetadataWrite(f.library, {
              plan: pending,
              mode: "create",
            }),
          ),
        ),
      )
      expect(pendingError.code).toBe("WRITE_OUTCOME_UNKNOWN")
      f.clear()
      const resumed = await f.run(applySharedCreateRestoration(x.apply).pipe(Effect.result))
      expect(resumed._tag).toBe("Failure")
      if (resumed._tag === "Failure")
        expect(resumed.failure.code).toBe("SHARED_CREATE_RESTORATION_REQUIRED")
      expect(f.writes()).toHaveLength(0)
      return
    }
    f.clear()
    expect(await f.run(applySharedCreateRestoration(x.apply))).toMatchObject({ verified: true })
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(0)
    expect(f.nativeCreates()).toHaveLength(2)
  },
)

test.each([true, false])(
  "an unknown original suffix visible=%s preserves the completed repair and is never replayed",
  async (visible) => {
    const x = await failedTablePlusOriginal(),
      { f } = x
    f.unknown("file", visible)
    await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
    expect(f.nativeCreates()).toHaveLength(1)
    f.clear()
    await f.run(Effect.flip(applySharedCreateRestoration(x.apply)))
    expect(f.writes()).toHaveLength(0)
  },
)
