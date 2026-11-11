import { expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { sourceRefreshPin } from "../src/shared-source-refresh.ts"
import {
  prepareSourceRefreshBatch,
  runSourceRefreshBatch,
  validateSourceRefreshBatch,
} from "../src/shared-source-batch.ts"
import { sourceRefreshFixture, library, relatedSkill } from "./shared-source-refresh-fixture.ts"
import { digest, id, skillPage } from "./shared-snapshot-fixture.ts"

async function fixture() {
  const f = await sourceRefreshFixture()
  const targets = [skillPage, id(91), id(92)]
  for (const [offset, page] of targets.slice(1).entries()) {
    const member = `skills/member-${offset + 2}`
    relatedSkill(f, page, `member-${offset + 2}`, `Member ${offset + 2}`, member)
    f.bodies.set(page, `Native body ${page}\n`)
    const template = f.snapshot.members[0]!
    f.replaceSnapshot({
      ...f.snapshot,
      members: [...f.snapshot.members, { ...template, member_key: member, source_path: member }],
    })
  }
  let unknownTarget: string | undefined
  let unknownDispatched = false
  let incompleteMembership = false
  const run = <A, E, R>(action: Effect.Effect<A, E, R>) =>
    f.run(
      Effect.gen(function* () {
        const original = yield* Notion
        const api: Notion["Service"] = {
          ...original,
          request: (path, body, options) =>
            Effect.suspend(() => {
              if (path.startsWith(`v1/data_sources/${library.files.data_source_id}/query`)) {
                const target = property(property(property(body).filter).relation).contains
                if (target !== skillPage) {
                  f.calls.push({ path, body, method: "POST" })
                  return Effect.succeed({
                    object: "list",
                    results: [],
                    has_more: false,
                    next_cursor: null,
                  })
                }
              }
              if (
                incompleteMembership &&
                path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`)
              )
                return Effect.succeed({
                  object: "list",
                  results: [],
                  has_more: true,
                  next_cursor: null,
                })
              if (path === "v1/pages" && !unknownDispatched && unknownTarget !== undefined) {
                const props = property(property(body).properties)
                const relations = property(props.skill).relation
                if (
                  property(props.kind).select &&
                  property(property(props.kind).select).name === "object" &&
                  Array.isArray(relations) &&
                  relations.some((item) => property(item).id === unknownTarget)
                ) {
                  unknownDispatched = true
                  f.unknownRecord("object", false)
                }
              }
              return original.request(path, body, options)
            }),
        }
        return yield* action.pipe(Effect.provideService(Notion, api))
      }),
    )
  for (const target of targets.slice(1))
    await run(
      Effect.gen(function* () {
        return yield* openSharedSnapshot({
          library,
          target,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
        })
      }),
    )
  f.clearCalls()
  return {
    ...f,
    run,
    targets,
    unknownOn: (target: string) => {
      unknownTarget = target
    },
    incompleteMembership: () => {
      incompleteMembership = true
    },
  }
}

test("one complete Source acquisition freezes three exact member plans without remote writes", async () => {
  const f = await fixture()
  const batch = await f.run(prepareSourceRefreshBatch(library, id(82), f.acquire))
  expect(f.acquisitions()).toBe(1)
  expect(batch.plans.map((plan) => plan.target_page_id)).toEqual(f.targets)
  expect(new Set(batch.plans.map((plan) => plan.provider_revision)).size).toBe(1)
  expect(batch.membership).toHaveLength(3)
  expect(batch.plans.every((plan) => plan.projected_files.length === 3)).toBe(true)
  expect(f.calls.some((call) => call.path === "v1/pages" || call.method === "PATCH")).toBe(false)
  expect(await f.run(validateSourceRefreshBatch(library, batch))).toEqual(batch)
})

test("missing member or truncated membership cannot publish a partial candidate", async () => {
  const f = await fixture()
  f.replaceSnapshot({ ...f.snapshot, members: f.snapshot.members.slice(0, 2) })
  await expect(f.run(prepareSourceRefreshBatch(library, id(82), f.acquire))).rejects.toThrow(
    "exact bound member",
  )
  expect(f.writeCount()).toBe(0)
  const truncated = await fixture()
  truncated.incompleteMembership()
  await expect(
    truncated.run(prepareSourceRefreshBatch(library, id(82), truncated.acquire)),
  ).rejects.toThrow("cursor")
  expect(truncated.acquisitions()).toBe(0)
})

test("a changed binding set during discovery invalidates the complete batch", async () => {
  const f = await fixture()
  const acquire = () =>
    Effect.sync(() => {
      const page = f.relatedPages[0]!
      property(page.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
      return structuredClone(f.snapshot)
    })
  await expect(f.run(prepareSourceRefreshBatch(library, id(82), acquire))).rejects.toThrow()
  expect(f.writeCount()).toBe(0)
})

test("rehashing a batch cannot authorize a tampered member or a duplicate target", async () => {
  const f = await fixture()
  const batch = await f.run(prepareSourceRefreshBatch(library, id(82), f.acquire))
  const changed = { ...batch, plans: [batch.plans[0]!, batch.plans[0]!, batch.plans[2]!] }
  const { plan_id: _old, ...contents } = changed
  changed.plan_id = `source-batch-${digest(canonicalSharedJson(contents))}`
  f.clearCalls()
  await expect(f.run(runSourceRefreshBatch(library, changed, { mode: "apply" }))).rejects.toThrow(
    "member differs",
  )
  expect(f.calls).toHaveLength(0)
})

test("three-member apply preserves success, failure and unknown without replaying an unknown create", async () => {
  const f = await fixture()
  const batch = await f.run(prepareSourceRefreshBatch(library, id(82), f.acquire))
  f.bodies.set(f.targets[1]!, "Changed while the frozen batch awaited application.\n")
  f.unknownOn(f.targets[2]!)
  const first = await f.run(runSourceRefreshBatch(library, batch, { mode: "apply" }))
  expect(first.status).toBe("partial")
  expect(first.atomic).toBe(false)
  expect(first.items.map((item) => item.outcome)).toEqual(["confirmed", "failed", "unknown"])
  expect(first.counts).toEqual({ total: 3, confirmed: 1, failed: 1, unknown: 1 })
  expect(text(property(property(f.main.properties).source).rich_text)).toBe(
    sourceRefreshPin(batch.plans[0]!),
  )
  const writes = f.writeCount()
  const second = await f.run(runSourceRefreshBatch(library, batch, { mode: "apply" }))
  expect(second.items.map((item) => item.outcome)).toEqual(["confirmed", "failed", "unknown"])
  expect(f.writeCount()).toBe(writes)
  expect(f.json.has(first.result_key)).toBe(true)
  expect(f.json.has(second.result_key)).toBe(true)
  expect(first.result_key).not.toBe(second.result_key)
  f.clearCalls()
  const observed = await f.run(runSourceRefreshBatch(library, batch, { mode: "reconcile" }))
  expect(observed.remote_writes).toBe(0)
  expect(observed.all_members_confirmed).toBe(false)
  expect(f.calls.some((call) => call.path === "v1/pages" || call.method === "PATCH")).toBe(false)
})

test("a second full preparation of unchanged members creates no content versions or body writes", async () => {
  const f = await fixture()
  const first = await f.run(prepareSourceRefreshBatch(library, id(82), f.acquire))
  expect(
    (await f.run(runSourceRefreshBatch(library, first, { mode: "apply" }))).all_members_confirmed,
  ).toBe(true)
  const next = await f.run(prepareSourceRefreshBatch(library, id(82), f.acquire))
  expect(next.plans.every((plan) => plan.previous_pin === sourceRefreshPin(plan))).toBe(true)
  f.clearCalls()
  const result = await f.run(runSourceRefreshBatch(library, next, { mode: "apply" }))
  expect(result.all_members_confirmed).toBe(true)
  expect(f.calls.some((call) => call.path === "v1/pages" || call.method === "PATCH")).toBe(false)
})
