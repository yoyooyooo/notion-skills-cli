import { expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ChildProcessSpawner } from "effect/process"
import { HttpClient } from "effect/http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fail, property, type SkillsError } from "../src/model.ts"
import { Store } from "../src/store.ts"
import { Notion } from "../src/notion.ts"
import { executeSharedCreate } from "../src/shared-create.ts"
import { bindSourceDefinition } from "../src/shared-source-definitions.ts"
import {
  prepareSourceOnboarding,
  reviewSourceOnboarding,
  executeSourceOnboarding,
  sourceOnboardingError,
} from "../src/shared-source-onboarding.ts"
import { fixture, library, ids } from "./shared-source-projection-fixture.ts"
import { id, rich } from "./shared-snapshot-fixture.ts"

function setup() {
  const f = fixture([], { markdownImport: true })
  const root = mkdtempSync(join(tmpdir(), "ntn-source-onboarding-"))
  for (const row of f.skills.values()) {
    const p = property(row.properties)
    p.origin = { id: "origin", type: "relation", relation: [], has_more: false }
    p.source_member = rich("source_member", "")
  }
  let acquisitions = 0
  const acquire = () => {
    acquisitions++
    return Effect.succeed(structuredClone(f.snapshot))
  }
  const scope = { kind: "source", source: f.source.id } as const
  const run = <A, E>(
    action: Effect.Effect<
      A,
      E,
      | Store
      | Notion
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | HttpClient.HttpClient
      | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
    f.run(
      Effect.gen(function* () {
        const store = yield* Store
        const api = yield* Notion
        const bindingApi: Notion["Service"] = {
          ...api,
          request: (path, body, options) =>
            Effect.suspend(() => {
              const target = f.skills.get(path.replace(/^v1\/pages\//u, ""))
              const changes = property(property(body).properties)
              if (
                target !== undefined &&
                options?.method === "PATCH" &&
                Object.keys(changes).sort().join(",") === "origin,source_member"
              ) {
                f.calls.push({ path, method: "PATCH", body })
                const props = property(target.properties)
                props.origin = {
                  id: "origin",
                  type: "relation",
                  ...property(changes.origin),
                  has_more: false,
                }
                props.source_member = {
                  id: "source_member",
                  type: "rich_text",
                  ...property(changes.source_member),
                }
                return Effect.succeed(structuredClone(target))
              }
              return api.request(path, body, options)
            }),
        }
        return yield* action.pipe(
          Effect.provideService(Store, { ...store, root }),
          Effect.provideService(Notion, bindingApi),
          Effect.provide(NodeServices.layer),
        )
      }),
    )
  return { ...f, run, acquire, scope, acquisitions: () => acquisitions }
}

test("a source-only row becomes one disabled complete Skill through the same frozen plan", async () => {
  const f = setup()
  const report = await f.run(reviewSourceOnboarding(library, f.scope, f.acquire))
  expect(report.sources[0]?.members[0]?.kind).toBe("admit")
  expect(f.writes()).toHaveLength(0)
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  expect(plan.actions).toHaveLength(1)
  expect(f.acquisitions()).toBe(2)
  expect(plan.actions[0]?.kind).toBe("create")
  f.clear()
  const dry = await f.run(executeSourceOnboarding(library, plan, "dry-run"))
  expect(dry.status).toBe("previewed")
  expect(f.writes()).toHaveLength(0)
  const applied = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(applied.status).toBe("completed")
  expect(applied.results[0]?.verified).toBe(true)
  const created = [...f.skills.values()].find((row) => row.id === applied.results[0]?.page_id)
  expect(property(property(created).properties).enabled).toMatchObject({ checkbox: false })
  f.clear()
  const repeated = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(repeated.status).toBe("completed")
  expect(f.writes()).toHaveLength(0)
  expect((await f.run(executeSourceOnboarding(library, plan, "reconcile"))).status).toBe(
    "completed",
  )
  expect(f.writes()).toHaveLength(0)
  const again = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  expect(again.actions).toHaveLength(0)
  expect(again.report.sources[0]?.members[0]?.kind).toBe("registered")
})

test("an explicit Source subset shares one inventory, retains order and never claims full-library coverage", async () => {
  const f = setup()
  const unavailable = id(9999)
  const scope = { kind: "sources", sources: [f.source.id, unavailable] } as const
  const report = await f.run(reviewSourceOnboarding(library, scope, f.acquire))
  expect(report.scope).toEqual(scope)
  expect(report.coverage).toBe("partial")
  expect(report.sources.map((source) => source.status)).toEqual(["reviewed", "unavailable"])
  expect(report.sources[0]?.members[0]?.kind).toBe("admit")
  expect(report.sources[1]?.error).not.toBeNull()
  expect(f.acquisitions()).toBe(1)
  expect(f.writes()).toHaveLength(0)
  const plan = await f.run(prepareSourceOnboarding(library, scope, {}, f.acquire))
  expect(plan.report.scope).toEqual(scope)
  expect(plan.report.coverage).toBe("partial")
  expect(plan.actions).toHaveLength(1)
  expect(plan.actions[0]?.kind).toBe("create")
  expect(f.writes()).toHaveLength(0)
})

test("an explicit Source subset cannot include duplicates, an empty selector, or one Source disguised as a batch", async () => {
  const f = setup()
  for (const sources of [[f.source.id], [f.source.id, f.source.id], [f.source.id, ""]]) {
    await expect(
      f.run(reviewSourceOnboarding(library, { kind: "sources", sources }, f.acquire)),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
  }
  expect(f.acquisitions()).toBe(0)
  expect(f.writes()).toHaveLength(0)
})

test("two selectors resolving to one Source cannot dispatch its provider twice", async () => {
  const f = setup()
  const report = await f.run(
    reviewSourceOnboarding(
      library,
      { kind: "sources", sources: [f.source.id, f.source.id.replaceAll("-", "")] },
      f.acquire,
    ),
  )
  expect(report.coverage).toBe("partial")
  expect(report.sources[0]?.status).toBe("reviewed")
  expect(report.sources[1]?.error?.code).toBe("SOURCE_DUPLICATE_SELECTION")
  expect(f.acquisitions()).toBe(1)
  expect(f.writes()).toHaveLength(0)
})

test("a source directory Router is preserved separately from missing Skill members", async () => {
  const f = setup()
  const router = f.seedSkill(id(8765), "source-directory", "Source directory", "router", true)
  const props = property(router.properties)
  props.origin = {
    id: "origin",
    type: "relation",
    relation: [{ id: f.source.id }],
    has_more: false,
  }
  props.source_member = rich("source_member", "")
  const before = structuredClone(router)
  const review = await f.run(reviewSourceOnboarding(library, f.scope, f.acquire))
  expect(review.sources[0]?.unresolved_bindings).toEqual([])
  expect(review.sources[0]?.source_routers).toMatchObject([
    { page_id: router.id, kind: "router", member: "" },
  ])
  expect(review.sources[0]?.members[0]?.kind).toBe("admit")
  expect(router).toEqual(before)
  expect(f.writes()).toHaveLength(0)
})

test("explicit member scope freezes only that member without editing the Source selection", async () => {
  const f = setup()
  const original = structuredClone(f.source)
  const second = structuredClone(f.snapshot.members[0]!)
  Object.assign(second, {
    member_key: "skills/other",
    portable: { ...second.portable, name: "Other workflow" },
  })
  Object.assign(f.snapshot, { members: [...f.snapshot.members, second] })
  const scope = { ...f.scope, members: ["skills/demo"] }
  const plan = await f.run(prepareSourceOnboarding(library, scope, {}, f.acquire))
  expect(plan.report.scope).toEqual(scope)
  expect(plan.report.sources[0]?.members).toHaveLength(1)
  expect(plan.actions.map((action) => action.member)).toEqual(["skills/demo"])
  expect(f.source).toEqual(original)
  expect(f.writes()).toHaveLength(0)
  const missing = await f.run(
    prepareSourceOnboarding(library, { ...f.scope, members: ["skills/absent"] }, {}, f.acquire),
  )
  expect(missing.actions).toHaveLength(0)
  expect(missing.report.sources[0]?.error).toMatchObject({
    code: "SOURCE_MEMBER_UNAVAILABLE",
    details: { members: ["skills/absent"] },
  })
  await expect(
    f.run(
      prepareSourceOnboarding(
        library,
        { ...f.scope, members: ["skills/demo", "skills/demo"] },
        {},
        f.acquire,
      ),
    ),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
})

test("source drift and tampered parent plans cannot dispatch a child", async () => {
  const f = setup()
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  const changed = { ...plan, plan_id: `source-onboarding-${"0".repeat(64)}` }
  f.clear()
  await expect(f.run(executeSourceOnboarding(library, changed, "apply"))).rejects.toMatchObject({
    code: "SOURCE_ONBOARDING_INVALID",
  })
  f.source.properties[ids.Ref!] = rich(ids.Ref!, "different")
  const result = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(result.status).toBe("partial")
  expect(result.results[0]?.error?.code).toBe("SOURCE_DEFINITION_CHANGED")
  expect(f.writes()).toHaveLength(0)
})

test("unknown creation remains on its original operation and is never replaced", async () => {
  const f = setup()
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  f.unknown("skill", false)
  const first = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(first.status).toBe("partial")
  f.clear()
  const second = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(second.status).toBe("partial")
  expect(f.nativeCreates()).toHaveLength(0)
  const fresh = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  expect(fresh.actions).toHaveLength(0)
  expect(fresh.report.sources[0]?.members[0]).toMatchObject({
    kind: "blocked",
    reason: "original_creation_pending",
  })
})

test("a child failure keeps original recovery identity without echoing the complete plan", async () => {
  const f = setup()
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  const action = plan.actions[0]!
  if (action.kind !== "create") throw new Error("Expected an original creation")
  const original = structuredClone(action.plan)
  const error = fail("SHARED_CREATE_BODY_MISMATCH", "Known semantic mismatch", {
    component: "links",
    native_create_operation_id: original.operation_id,
    skill_page_id: id(99),
    recovery: { mode: "reconcile", plan: original },
  })
  const projected = sourceOnboardingError(error, action)
  expect(projected).toMatchObject({
    code: error.code,
    details: {
      component: "links",
      recovery: {
        mode: "reconcile",
        original_plan: {
          operation_id: original.operation_id,
          skill_id: original.skill_id,
          retained_in_parent_plan: true,
          full_input_omitted: true,
        },
      },
    },
  })
  expect(Object.hasOwn(property(property(projected.details).recovery), "plan")).toBe(false)
  expect(JSON.stringify(projected).length).toBeLessThan(2000)
  expect(action.plan).toEqual(original)
  expect(property(property(error.details).recovery).plan).toEqual(original)
})

test("missing discovery bindings reuse a proven fixed-source page and preserve custom bodies and eligibility", async () => {
  const f = setup()
  const child = await f.prepare(true)
  const original = await f.run(executeSharedCreate(library, { plan: child, mode: "create" }))
  const row = f.skills.get(original.page_id)!
  const props = property(row.properties)
  props.origin = { id: "origin", type: "relation", relation: [], has_more: false }
  props.source_member = rich("source_member", "")
  f.base.bodies.set(original.page_id, "# User-owned custom body\nKeep all my edits.\n")
  const protectedBodies = new Map(f.base.bodies)
  const pin = structuredClone(props.source)
  f.clear()
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  expect(plan.actions).toHaveLength(1)
  expect(plan.actions[0]).toMatchObject({ kind: "bind", before: { page_id: original.page_id } })
  expect(f.writes()).toHaveLength(0)
  expect((await f.run(executeSourceOnboarding(library, plan, "dry-run"))).status).toBe("previewed")
  expect(f.writes()).toHaveLength(0)
  const result = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(result.results.map((item) => item.error)).toEqual([undefined])
  expect(result.status).toBe("completed")
  expect(f.nativeCreates()).toHaveLength(0)
  expect(f.base.bodies).toEqual(protectedBodies)
  expect(props.source).toEqual(pin)
  expect(props.enabled).toMatchObject({ checkbox: true })
  expect(
    f.calls
      .filter((call) => call.method === "PATCH")
      .map((call) => Object.keys(property(property(call.body).properties)).sort()),
  ).toEqual([["origin", "source_member"]])
  f.clear()
  expect((await f.run(executeSourceOnboarding(library, plan, "reconcile"))).status).toBe(
    "completed",
  )
  expect((await f.run(executeSourceOnboarding(library, plan, "apply"))).status).toBe("completed")
  expect(f.writes()).toHaveLength(0)
})

test("same-name native content is review-only, including a collision beyond the first metadata page", async () => {
  const f = setup()
  for (let i = 0; i < 105; i++) {
    const row = f.seedSkill(
      id(1000 + i),
      `other-${i}`,
      i === 104 ? "initial-source" : `Other ${i}`,
      "skill",
      false,
    )
    const props = property(row.properties)
    props.origin = { id: "origin", type: "relation", relation: [], has_more: false }
    props.source_member = rich("source_member", "")
    props.source = rich("source", "")
  }
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  expect(plan.report.inventory_count).toBe(106)
  expect(plan.report.sources[0]?.members[0]).toMatchObject({
    kind: "blocked",
    reason: "existing_identity_needs_review",
    candidates: [id(1104)],
  })
  expect(plan.actions).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
})

test("duplicate upstream keys and names do not generate competing create plans", async () => {
  const f = setup()
  const copied = structuredClone(f.snapshot.members[0]!)
  Object.assign(f.snapshot, { members: [...f.snapshot.members, copied] })
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  expect(plan.actions).toHaveLength(0)
  expect(plan.report.sources[0]?.members.every((member) => member.kind === "blocked")).toBe(true)
  expect(f.writes()).toHaveLength(0)
})

test("incomplete metadata cannot authorize absence or even start provider discovery", async () => {
  const f = setup()
  const action = Effect.gen(function* () {
    const api = yield* Notion
    return yield* reviewSourceOnboarding(library, f.scope, f.acquire).pipe(
      Effect.provideService(Notion, {
        ...api,
        request: (path, body, options) =>
          path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`)
            ? api.request(path, body, options).pipe(
                Effect.map((raw) => ({
                  ...property(raw),
                  request_status: { type: "incomplete", incomplete_reason: "query_timeout" },
                })),
              )
            : api.request(path, body, options),
      }),
    )
  })
  await expect(f.run(action)).rejects.toBeDefined()
  expect(f.acquisitions()).toBe(0)
  expect(f.writes()).toHaveLength(0)
})

test("a bounded provider timeout returns explicit partial coverage instead of hiding the Source", async () => {
  const f = setup()
  const result = await f.run(
    reviewSourceOnboarding(library, f.scope, () => Effect.never, { sourceTimeoutMs: 10 }),
  )
  expect(result.coverage).toBe("partial")
  expect(result.sources).toHaveLength(1)
  expect(result.sources[0]).toMatchObject({
    status: "unavailable",
    error: { code: "SOURCE_REVIEW_TIMEOUT", details: { source: f.source.id, duration_ms: 10 } },
  })
  expect(result.sources[0]?.members).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
})

test("provider failures retain exact error diagnostics and cannot prepare an empty success", async () => {
  const f = setup()
  const result = await f.run(
    prepareSourceOnboarding(library, f.scope, {}, () =>
      Effect.fail(fail("GITHUB_RATE_LIMITED", "Controlled limit", { status: 403, reset: 1234 })),
    ),
  )
  expect(result.report.sources[0]?.error).toEqual({
    code: "GITHUB_RATE_LIMITED",
    message: "Controlled limit",
    details: { status: 403, reset: 1234 },
  })
  expect(result.actions).toHaveLength(0)
  expect((await f.run(executeSourceOnboarding(library, result, "dry-run"))).status).toBe("partial")
  expect(f.writes()).toHaveLength(0)
})

test("incomplete provider references retain bounded actionable provenance without admitting partial members", async () => {
  const f = setup()
  const unavailable = Array.from({ length: 23 }, (_, index) => ({
    reason: "outside_source_root" as const,
    from_path: `notes/${index}.md`,
    href: "../../outside/HANDOFF.md",
  }))
  const observed = { ...f.snapshot, unavailable }
  const plan = await f.run(
    prepareSourceOnboarding(library, f.scope, {}, () => Effect.succeed(observed)),
  )
  expect(plan.report.coverage).toBe("partial")
  expect(plan.actions).toHaveLength(0)
  expect(plan.report.sources[0]?.members).toHaveLength(0)
  expect(plan.report.sources[0]?.error).toMatchObject({
    code: "SOURCE_REFRESH_INCOMPLETE",
    details: {
      source_id: "initial-source",
      source_page_id: f.source.id,
      provider_revision: observed.revision,
      unavailable_count: 23,
      unavailable: unavailable.slice(0, 20),
      unavailable_truncated: true,
    },
  })
  expect(f.writes()).toHaveLength(0)
})

test("a lost binding response is not promoted to success from current equality", async () => {
  const f = setup()
  const original = await f.run(
    executeSharedCreate(library, { plan: await f.prepare(), mode: "create" }),
  )
  const props = property(f.skills.get(original.page_id)!.properties)
  props.origin = { id: "origin", type: "relation", relation: [], has_more: false }
  props.source_member = rich("source_member", "")
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  const dropped = Effect.gen(function* () {
    const api = yield* Notion
    return yield* executeSourceOnboarding(library, plan, "apply").pipe(
      Effect.provideService(Notion, {
        ...api,
        request: (path, body, options) => {
          const response = api.request(path, body, options)
          return path === `v1/pages/${original.page_id}` && options?.method === "PATCH"
            ? response.pipe(
                Effect.flatMap(() =>
                  Effect.fail(fail("NOTION_REQUEST_FAILED", "Controlled response loss.")),
                ),
              )
            : response
        },
      }),
    )
  })
  expect((await f.run(dropped)).status).toBe("partial")
  f.clear()
  const observed = await f.run(executeSourceOnboarding(library, plan, "reconcile"))
  expect(observed.status).toBe("partial")
  expect(observed.results[0]?.verified).toBe(false)
  expect((await f.run(executeSourceOnboarding(library, plan, "apply"))).status).toBe("partial")
  expect(f.writes()).toHaveLength(0)
})

test("an unknown original public bind cannot be replayed through onboarding", async () => {
  const f = setup()
  const original = await f.run(
    executeSharedCreate(library, { plan: await f.prepare(), mode: "create" }),
  )
  const props = property(f.skills.get(original.page_id)!.properties)
  props.origin = { id: "origin", type: "relation", relation: [], has_more: false }
  props.source_member = rich("source_member", "")
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  const originalAttempt = Effect.gen(function* () {
    const api = yield* Notion
    return yield* bindSourceDefinition(library, {
      source: f.source.id,
      target: original.page_id,
      member: f.snapshot.members[0]!.member_key,
      expected: "none",
    }).pipe(
      Effect.provideService(Notion, {
        ...api,
        request: (path, body, options) => {
          if (path === `v1/pages/${original.page_id}` && options?.method === "PATCH") {
            f.calls.push({ path, method: "PATCH", body })
            return Effect.fail(fail("NOTION_REQUEST_FAILED", "Controlled unknown original bind."))
          }
          return api.request(path, body, options)
        },
      }),
    )
  })
  await expect(f.run(originalAttempt)).rejects.toMatchObject({ code: "SOURCE_WRITE_UNKNOWN" })
  f.clear()
  const result = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(result.status).toBe("partial")
  expect(result.results[0]?.error?.code).toBe("SOURCE_WRITE_UNKNOWN")
  expect(f.writes()).toHaveLength(0)
})

test("an explicit new association binds an exact native candidate without pretending historical provenance", async () => {
  const f = setup()
  const original = await f.run(
    executeSharedCreate(library, { plan: await f.prepare(true), mode: "create" }),
  )
  const row = f.skills.get(original.page_id)!,
    props = property(row.properties)
  props.origin = { id: "origin", type: "relation", relation: [], has_more: false }
  props.source_member = rich("source_member", "")
  props.source = rich("source", `bundle-${"a".repeat(64)}`)
  const metadata = structuredClone(props),
    bodies = new Map(f.base.bodies)
  const observed = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  expect(observed.actions).toHaveLength(0)
  expect(observed.report.sources[0]?.members[0]).toMatchObject({
    kind: "blocked",
    reason: "existing_identity_needs_review",
  })
  const decisions = [{ member: f.snapshot.members[0]!.member_key, target: original.page_id }]
  const reviewed = await f.run(
    prepareSourceOnboarding(library, f.scope, { bindings: decisions }, f.acquire),
  )
  expect(reviewed.actions).toEqual([
    expect.objectContaining({ kind: "bind", proof: "explicit_binding_decision" }),
  ])
  f.clear()
  expect((await f.run(executeSourceOnboarding(library, reviewed, "dry-run"))).status).toBe(
    "previewed",
  )
  expect(f.writes()).toHaveLength(0)
  expect((await f.run(executeSourceOnboarding(library, reviewed, "apply"))).status).toBe(
    "completed",
  )
  expect(f.nativeCreates()).toHaveLength(0)
  expect(f.base.bodies).toEqual(bodies)
  expect(props.source).toEqual(metadata.source)
  expect(props.enabled).toEqual(metadata.enabled)
  expect(props.required).toEqual(metadata.required)
  expect(props.members).toEqual(metadata.members)
  f.clear()
  expect((await f.run(executeSourceOnboarding(library, reviewed, "apply"))).status).toBe(
    "completed",
  )
  expect(f.writes()).toHaveLength(0)
  await expect(
    f.run(
      prepareSourceOnboarding(
        library,
        f.scope,
        { bindings: [{ ...decisions[0]!, target: id(9999) }] },
        f.acquire,
      ),
    ),
  ).rejects.toMatchObject({ code: "SOURCE_BINDING_DECISION_INVALID" })
  await expect(
    f.run(prepareSourceOnboarding(library, { kind: "all" }, { bindings: decisions }, f.acquire)),
  ).rejects.toMatchObject({ code: "SOURCE_BINDING_DECISION_INVALID" })
})
