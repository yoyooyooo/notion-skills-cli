import { expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import {
  executeSourceMemberDecision,
  prepareSourceMemberDecision,
} from "../src/shared-source-member-decision.ts"
import { sourceRefreshFixture, library, sourceIds } from "./shared-source-refresh-fixture.ts"
import { id, rich, skillPage } from "./shared-snapshot-fixture.ts"

async function rebindFixture() {
  const f = await sourceRefreshFixture()
  const before = structuredClone(f.snapshot)
  f.replaceSnapshot({
    ...before,
    members: [
      ...before.members,
      {
        ...before.members[0]!,
        member_key: "skills/renamed",
        source_path: "skills/renamed",
      },
    ],
  })
  f.clearCalls()
  const prepare = () =>
    f.run(
      prepareSourceMemberDecision(
        library,
        {
          source: id(82),
          target: skillPage,
          action: { kind: "rebind", member: "skills/renamed" },
        },
        f.acquire,
      ),
    )
  return { ...f, prepare }
}

test("exact-member decision freezes a complete manifest without inferring a rename or writing", async () => {
  const f = await rebindFixture()
  const plan = await f.prepare()
  expect(plan.action.kind).toBe("rebind")
  if (plan.action.kind !== "rebind") throw new Error("Expected rebind")
  expect(plan.action.member).toBe("skills/renamed")
  expect(plan.action.files).toHaveLength(3)
  expect(plan.action.files.find((file) => file.path === "assets/file.bin")).toMatchObject({
    bytes: 4,
  })
  expect(f.acquisitions()).toBe(1)
  expect(f.writeCount()).toBe(0)
  const preview = await f.run(executeSourceMemberDecision(library, plan, { dryRun: true }))
  expect(preview.verified).toBe(false)
  expect(preview.original.status).toBe("planned")
  expect(f.writeCount()).toBe(0)
})

test("rebinding preserves selected bytes, native bodies and user relations; repeated original apply writes nothing", async () => {
  const f = await rebindFixture()
  const bodies = new Map(f.bodies)
  const p = property(f.main.properties)
  const retained = structuredClone({
    selected: p.source,
    members: p.members,
    requires: p.requires,
    enabled: p.enabled,
  })
  const plan = await f.prepare()
  const result = await f.run(executeSourceMemberDecision(library, plan))
  expect(result.verified).toBe(true)
  expect(text(property(p.source_member).rich_text)).toBe("skills/renamed")
  expect({
    selected: p.source,
    members: p.members,
    requires: p.requires,
    enabled: p.enabled,
  }).toEqual(retained)
  expect(f.bodies).toEqual(bodies)
  expect(f.calls.some((call) => call.method === "PATCH" && call.path.endsWith("/markdown"))).toBe(
    false,
  )
  f.clearCalls()
  const repeated = await f.run(executeSourceMemberDecision(library, plan))
  expect(repeated.verified).toBe(true)
  expect(f.writeCount()).toBe(0)
  const original = await f.run(executeSourceMemberDecision(library, plan, { reconcile: true }))
  expect(original.retained_decisions).toBe(1)
  expect(original.verified).toBe(true)
  expect(f.writeCount()).toBe(0)
})

test("retaining an actually removed member detaches only discovery and keeps all existing content", async () => {
  const f = await sourceRefreshFixture()
  f.replaceSnapshot({ ...f.snapshot, members: [] })
  const before = new Map(f.bodies)
  const selected = property(f.main.properties).source
  const plan = await f.run(
    prepareSourceMemberDecision(
      library,
      {
        source: id(82),
        target: skillPage,
        action: { kind: "retain_removed" },
      },
      f.acquire,
    ),
  )
  const result = await f.run(executeSourceMemberDecision(library, plan))
  expect(result.verified).toBe(true)
  expect(property(property(f.main.properties).origin).relation).toEqual([])
  expect(text(property(property(f.main.properties).source_member).rich_text)).toBe("")
  expect(property(f.main.properties).source).toEqual(selected)
  expect(f.bodies).toEqual(before)
})

test("present members, incomplete discovery and changed selections stop before retaining or mutation", async () => {
  const f = await rebindFixture()
  await expect(
    f.run(
      prepareSourceMemberDecision(
        library,
        {
          source: id(82),
          target: skillPage,
          action: { kind: "retain_removed" },
        },
        f.acquire,
      ),
    ),
  ).rejects.toThrow("still exists")
  const plan = await f.prepare()
  property(f.main.properties).source = rich("source", `source-${"c".repeat(64)}`)
  await expect(f.run(executeSourceMemberDecision(library, plan))).rejects.toThrow(
    "selected version changed",
  )
  expect(f.writeCount()).toBe(0)
  f.replaceSnapshot({
    ...f.snapshot,
    unavailable: [
      {
        from_path: "skills/demo/SKILL.md",
        href: "../missing/file.bin",
        reason: "outside_source_root",
      },
    ],
  })
  await expect(f.prepare()).rejects.toThrow("complete provider observation")
  expect(f.writeCount()).toBe(0)
})

test("source drift and modified frozen plans fail before any remote write", async () => {
  const f = await rebindFixture()
  const plan = await f.prepare()
  await expect(
    f.run(executeSourceMemberDecision(library, { ...plan, provider_revision: "b".repeat(40) })),
  ).rejects.toThrow("identity differs")
  property(f.source.properties)[sourceIds.Name!] = {
    id: sourceIds.Name,
    type: "title",
    title: [{ plain_text: "Changed" }],
  }
  await expect(f.run(executeSourceMemberDecision(library, plan))).rejects.toThrow(
    "definition changed",
  )
  expect(f.writeCount()).toBe(0)
})

test("lost PATCH acknowledgement remains unknown even when current binding matches; no changed-input replay", async () => {
  const f = await rebindFixture()
  const plan = await f.prepare()
  await expect(
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* executeSourceMemberDecision(library, plan).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              const request = api.request(path, body, options)
              return path === `v1/pages/${skillPage}` && options?.method === "PATCH"
                ? request.pipe(
                    Effect.flatMap(() =>
                      Effect.fail(fail("NETWORK_LOST", "Acknowledgement lost.")),
                    ),
                  )
                : request
            },
          }),
        )
      }),
    ),
  ).rejects.toThrow("inspect the original operation")
  f.clearCalls()
  const result = await f.run(executeSourceMemberDecision(library, plan, { reconcile: true }))
  expect(result.original).toMatchObject({ status: "observed_current", original_outcome: "unknown" })
  expect(result.verified).toBe(false)
  expect(result.retained_decisions).toBe(1)
  const repeated = await f.run(executeSourceMemberDecision(library, plan))
  expect(repeated.verified).toBe(false)
  expect(f.writeCount()).toBe(0)
})

test("an acknowledged PATCH followed by failed readback is reconciled from its retained response without another mutation", async () => {
  const f = await rebindFixture()
  const plan = await f.prepare()
  let acknowledged = false
  await expect(
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* executeSourceMemberDecision(library, plan).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              if (path === `v1/pages/${skillPage}` && options?.method === "PATCH")
                return api.request(path, body, options).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      acknowledged = true
                    }),
                  ),
                )
              if (acknowledged && path === `v1/pages/${skillPage}` && body === undefined)
                return Effect.fail(
                  fail("READBACK_UNAVAILABLE", "The independent readback is unavailable."),
                )
              return api.request(path, body, options)
            },
          }),
        )
      }),
    ),
  ).rejects.toThrow("independent readback")
  f.clearCalls()
  const reconciled = await f.run(executeSourceMemberDecision(library, plan, { reconcile: true }))
  expect(reconciled.original).toMatchObject({
    status: "observed_current",
    original_outcome: "applied",
  })
  expect(reconciled.verified).toBe(true)
  expect(f.writeCount()).toBe(0)
})

test("the same frozen member decision cannot dispatch again after a credential change", async () => {
  const f = await rebindFixture()
  const plan = await f.prepare()
  let attempts = 0
  const reads: string[] = []
  const run = (credential: string, invisible = false) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const store = yield* Store
        return yield* executeSourceMemberDecision(library, plan).pipe(
          Effect.provideService(Notion, {
            ...api,
            credentialIdentity: Effect.succeed(credential),
            request: (path, body, options) => {
              if (path === `v1/pages/${skillPage}` && options?.method === "PATCH") {
                attempts++
                if (invisible)
                  return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Invisible original PATCH."))
              }
              return api.request(path, body, options)
            },
          }),
          Effect.provideService(Store, {
            ...store,
            readJson: (key, schema) => {
              reads.push(key)
              return store.readJson(key, schema)
            },
          }),
        )
      }),
    )
  await expect(run("first", true)).rejects.toMatchObject({ code: "SOURCE_WRITE_UNKNOWN" })
  await expect(run("first")).rejects.toMatchObject({ code: "SOURCE_WRITE_UNKNOWN" })
  expect(attempts).toBe(1)
  const originalKeys = [...f.json.keys()].filter((key) =>
    key.startsWith("operations/shared-sources/"),
  )
  const originalState = new Map(originalKeys.map((key) => [key, structuredClone(f.json.get(key))]))
  reads.length = 0
  f.clearCalls()
  await expect(run("rotated")).rejects.toMatchObject({ code: "SOURCE_WRITE_UNKNOWN" })
  expect(attempts).toBe(1)
  expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(0)
  expect(reads.some((key) => originalKeys.includes(key))).toBe(false)
  expect(
    new Map([...f.json].filter(([key]) => key.startsWith("operations/shared-sources/"))),
  ).toEqual(originalState)
})

test("the same acknowledged member decision cannot overwrite a later restoration of its original binding", async () => {
  const f = await rebindFixture()
  const plan = await f.prepare()
  const first = await f.run(executeSourceMemberDecision(library, plan))
  expect(first.verified).toBe(true)
  property(f.main.properties).source_member = rich("source_member", plan.before.member)
  f.clearCalls()
  await expect(f.run(executeSourceMemberDecision(library, plan))).rejects.toMatchObject({
    code: "SOURCE_WRITE_UNKNOWN",
  })
  expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(0)
  expect(text(property(property(f.main.properties).source_member).rich_text)).toBe(
    plan.before.member,
  )
})
