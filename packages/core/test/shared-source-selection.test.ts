import { expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { fail, property, SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { prepareSharedMetadataWrite } from "../src/shared-metadata-write.ts"
import { registerSourcePlanBinding } from "../src/shared-source-plan-binding.ts"
import {
  applySharedSourceSelection,
  prepareSharedSourceSelection,
  reconcileSharedSourceSelection,
} from "../src/shared-source-selection.ts"
import { Store } from "../src/store.ts"
import { library, rich, sharedSnapshotFixture, skillPage } from "./shared-snapshot-fixture.ts"

type Fixture = ReturnType<typeof sharedSnapshotFixture>
type Requirements =
  | Store
  | Notion
  | Crypto.Crypto
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
const emptyPlan = { version: 1 as const, kind: "composition" as const, base: null, mounts: [] }
const patches = (f: Fixture) => f.calls.filter((call) => call.method === "PATCH")
function failure(
  result:
    | { readonly _tag: "Failure"; readonly failure: unknown }
    | { readonly _tag: "Success"; readonly success: unknown },
) {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected a typed source selection failure")
  return result.failure
}
function withWriter<A, E>(
  f: Fixture,
  action: Effect.Effect<A, E, Requirements>,
  options: { readonly unknownPatch?: boolean } = {},
) {
  return Effect.gen(function* () {
    const original = yield* Notion
    const api: Notion["Service"] = {
      ...original,
      request: (path, body, requestOptions) => {
        if (path !== `v1/pages/${skillPage}` || requestOptions?.method !== "PATCH")
          return original.request(path, body, requestOptions)
        return Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
          f.calls.push({ path, body, method: "PATCH" })
          const properties = property(f.main.properties)
          for (const [stableId, value] of Object.entries(property(property(body).properties))) {
            const key = Object.entries(properties).find(
              ([key, field]) => key === stableId || property(field).id === stableId,
            )?.[0]
            if (key === undefined)
              return Effect.fail(
                fail("FIXTURE_ERROR", "Source PATCH used an unknown property identity."),
              )
            properties[key] = { ...property(properties[key]), ...property(value) }
          }
          return options.unknownPatch
            ? Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Controlled original Source PATCH response lost."),
              )
            : Effect.succeed(structuredClone(f.main))
        })
      },
    }
    return yield* action.pipe(Effect.provideService(Notion, api))
  })
}
async function fixed(f: Fixture) {
  return await f.run(
    registerSourcePlanBinding(library, { skillPageId: skillPage, mode: "create", plan: emptyPlan }),
  )
}

test("prepare is read-only and apply changes only the stable Source property through the common journal", async () => {
  const f = sharedSnapshotFixture(),
    registered = await fixed(f)
  const properties = property(f.main.properties)
  properties["Renamed source column"] = properties.source
  delete properties.source
  f.clearCalls()
  const prepared = await f.run(
    prepareSharedSourceSelection({
      library,
      skillPageId: skillPage,
      sourceId: registered.binding.source_plan_id,
    }),
  )
  expect(prepared.selection).toMatchObject({
    kind: "composition",
    revision: registered.binding.source_plan_id,
    paths: [],
  })
  expect(prepared.plan.changes).toEqual([
    {
      field: "Source",
      property_id: "source",
      before: "",
      after: registered.binding.source_plan_id,
    },
  ])
  expect(f.writeCount()).toBe(0)
  const result = await f.run(
    withWriter(f, applySharedSourceSelection({ library, plan: prepared.plan, mode: "create" })),
  )
  expect(result).toMatchObject({
    status: "applied",
    protection: { conditional: false, automatic_retry: false },
  })
  expect(patches(f)).toHaveLength(1)
  expect(Object.keys(property(property(patches(f)[0]?.body).properties))).toEqual(["source"])
  expect(f.readBodyCount()).toBe(0)
  expect(
    [...f.json.keys()].some((key) => key.startsWith("operations/shared-observation-pending/")),
  ).toBe(false)
})

test("explicit native selection clears only Source and never treats an invalid source alias as native", async () => {
  const f = sharedSnapshotFixture(),
    registered = await fixed(f)
  property(f.main.properties).source = rich("source", registered.binding.source_plan_id)
  const native = await f.run(
    prepareSharedSourceSelection({ library, skillPageId: skillPage, sourceId: null }),
  )
  expect(native.selection).toEqual({ kind: "native" })
  expect(native.plan.changes[0]?.after).toBe("")
  await f.run(
    withWriter(f, applySharedSourceSelection({ library, plan: native.plan, mode: "create" })),
  )
  expect(patches(f)).toHaveLength(1)
  const before = f.calls.length
  expect(
    failure(
      await f.run(
        prepareSharedSourceSelection({ library, skillPageId: skillPage, sourceId: "latest" }).pipe(
          Effect.result,
        ),
      ),
    ).code,
  ).toBe("INVALID_SHARED_SOURCE")
  expect(f.calls).toHaveLength(before)
})

test("a missing selected binding fails before plan/receipt creation, and a disappeared prepared binding fails before dispatch", async () => {
  const f = sharedSnapshotFixture()
  expect(
    failure(
      await f.run(
        prepareSharedSourceSelection({
          library,
          skillPageId: skillPage,
          sourceId: `source-plan-${"0".repeat(64)}`,
        }).pipe(Effect.result),
      ),
    ).code,
  ).toBe("SHARED_SOURCE_MISSING")
  expect(f.writeCount()).toBe(0)
  const registered = await fixed(f)
  const prepared = await f.run(
    prepareSharedSourceSelection({
      library,
      skillPageId: skillPage,
      sourceId: registered.binding.source_plan_id,
    }),
  )
  f.records.delete(registered.record.page_id)
  f.clearCalls()
  const result = await f.run(
    withWriter(
      f,
      applySharedSourceSelection({ library, plan: prepared.plan, mode: "create" }),
    ).pipe(Effect.result),
  )
  expect(failure(result).code).toBe("SHARED_SOURCE_MISSING")
  expect(f.writeCount()).toBe(0)
  expect(patches(f)).toHaveLength(0)
  expect(
    [...f.json.keys()].some((key) => key.startsWith("operations/shared-observation-pending/")),
  ).toBe(false)
})

test("changed Source between prepare and apply refuses the stale plan before a property PATCH", async () => {
  const f = sharedSnapshotFixture(),
    registered = await fixed(f)
  const prepared = await f.run(
    prepareSharedSourceSelection({
      library,
      skillPageId: skillPage,
      sourceId: registered.binding.source_plan_id,
    }),
  )
  property(f.main.properties).source = rich("source", `source-${"a".repeat(64)}`)
  f.clearCalls()
  const result = await f.run(
    withWriter(
      f,
      applySharedSourceSelection({ library, plan: prepared.plan, mode: "create" }),
    ).pipe(Effect.result),
  )
  expect(failure(result).code).toBe("WRITE_CONFLICT")
  expect(patches(f)).toHaveLength(0)
  expect(f.writeCount()).toBe(0)
})

test("unknown original Source PATCH remains unresolved even when current Source already equals the candidate", async () => {
  const f = sharedSnapshotFixture(),
    registered = await fixed(f)
  const prepared = await f.run(
    prepareSharedSourceSelection({
      library,
      skillPageId: skillPage,
      sourceId: registered.binding.source_plan_id,
    }),
  )
  const first = await f.run(
    withWriter(f, applySharedSourceSelection({ library, plan: prepared.plan, mode: "create" }), {
      unknownPatch: true,
    }).pipe(Effect.result),
  )
  expect(failure(first).code).toBe("WRITE_OUTCOME_UNKNOWN")
  const second = await f.run(
    withWriter(
      f,
      applySharedSourceSelection({ library, plan: prepared.plan, mode: "create" }),
    ).pipe(Effect.result),
  )
  expect(failure(second).code).toBe("SHARED_METADATA_WRITE_UNRESOLVED")
  expect(property(failure(second).details).current_matches_after).toBe(true)
  const reconciled = await f.run(
    withWriter(f, reconcileSharedSourceSelection(library, prepared.plan)).pipe(Effect.result),
  )
  expect(failure(reconciled).code).toBe("SHARED_METADATA_WRITE_UNRESOLVED")
  expect(patches(f)).toHaveLength(1)
})

test("an invisible unknown first plan is retained locally and normal apply cannot send a replacement plan or PATCH", async () => {
  const f = sharedSnapshotFixture(),
    registered = await fixed(f)
  const prepared = await f.run(
    prepareSharedSourceSelection({
      library,
      skillPageId: skillPage,
      sourceId: registered.binding.source_plan_id,
    }),
  )
  f.clearCalls()
  f.unknownRecord("operation", false)
  expect(
    failure(
      await f.run(
        withWriter(
          f,
          applySharedSourceSelection({ library, plan: prepared.plan, mode: "create" }),
        ).pipe(Effect.result),
      ),
    ).code,
  ).toBe("WRITE_OUTCOME_UNKNOWN")
  expect(
    failure(
      await f.run(
        withWriter(
          f,
          applySharedSourceSelection({ library, plan: prepared.plan, mode: "create" }),
        ).pipe(Effect.result),
      ),
    ).code,
  ).toBe("SHARED_RECORD_UNRESOLVED")
  expect(f.writeCount()).toBe(1)
  expect(patches(f)).toHaveLength(0)
})

test("dry run validates the exact candidate and baseline without shared plan, dispatch receipt, or PATCH", async () => {
  const f = sharedSnapshotFixture(),
    registered = await fixed(f)
  const prepared = await f.run(
    prepareSharedSourceSelection({
      library,
      skillPageId: skillPage,
      sourceId: registered.binding.source_plan_id,
    }),
  )
  f.clearCalls()
  const result = await f.run(
    withWriter(
      f,
      applySharedSourceSelection({ library, plan: prepared.plan, mode: "create", dryRun: true }),
    ),
  )
  expect(result.status).toBe("planned")
  expect(f.writeCount()).toBe(0)
  expect(patches(f)).toHaveLength(0)
  expect(
    [...f.json.keys()].some((key) => key.startsWith("operations/shared-observation-pending/")),
  ).toBe(false)
})

test("Source apply refuses a broader valid metadata plan instead of accepting unrelated property writes", async () => {
  const f = sharedSnapshotFixture()
  const plan = await f.run(
    prepareSharedMetadataWrite({
      library,
      skillPageId: skillPage,
      changes: [{ field: "Name", value: "Unrelated name" }],
    }),
  )
  f.clearCalls()
  expect(
    failure(
      await f.run(
        applySharedSourceSelection({ library, plan, mode: "create" }).pipe(Effect.result),
      ),
    ).code,
  ).toBe("INVALID_SOURCE_SELECTION")
  expect(f.calls).toHaveLength(0)
})
