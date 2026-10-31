import { describe, expect, test } from "bun:test"
import { Crypto, Effect } from "effect"
import { HttpClient } from "effect/http"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { parseTarget } from "../src/ref.ts"
import { LIBRARY_MARKER } from "../src/shared-library-model.ts"
import { targetSnapshot } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import {
  digest,
  id,
  library,
  rich,
  sharedSnapshotFixture,
  skillPage,
} from "./shared-snapshot-fixture.ts"

function routerFixture(registered = true) {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  property(f.main.properties).kind = { id: "kind", type: "select", select: { name: "router" } }
  property(f.main.properties).members = {
    id: "members%3A",
    type: "relation",
    relation: [{ id: id(900) }],
    has_more: false,
  }
  const descriptor = {
    ...library,
    skills: {
      ...library.skills,
      property_ids: {
        ...library.skills.property_ids,
        ...(registered ? { Members: "members%3A" } : {}),
      },
    },
  }
  const member = structuredClone(f.main)
  member.id = id(900)
  const fields = property(member.properties)
  fields.kind = { id: "kind", type: "select", select: { name: "skill" } }
  fields.skill_id = rich("skill_id", "router-member")
  fields.title = {
    id: "title",
    type: "title",
    title: [{ type: "text", text: { content: "Lazy member" }, plain_text: "Lazy member" }],
  }
  fields.description = rich("description", "First member description")
  const run = <A, E>(
    effect: Effect.Effect<A, E, Notion | Store | Crypto.Crypto | HttpClient.HttpClient>,
  ) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* effect.pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              const endpoint = path.split("?", 1)[0]
              if (endpoint === `v1/data_sources/${library.skills.data_source_id}/query`) {
                f.calls.push({
                  path,
                  method: options?.method ?? (body === undefined ? "GET" : "POST"),
                  body,
                })
                return Effect.succeed({
                  object: "list",
                  results: structuredClone([f.main, member]),
                  has_more: false,
                  next_cursor: null,
                })
              }
              if (endpoint === `v1/databases/${library.skills.database_id}`)
                return api.request(path, body, options).pipe(
                  Effect.map((raw) => ({
                    ...property(raw),
                    description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(descriptor) }],
                  })),
                )
              return api.request(path, body, options)
            },
          }),
        )
      }),
    )
  const target = (options: Parameters<typeof targetSnapshot>[1] = {}) =>
    run(
      targetSnapshot(parseTarget(skillPage), { database: library.skills.database_id, ...options }),
    )
  return { ...f, member, run, target }
}

function mainText(
  f: ReturnType<typeof routerFixture>,
  snapshot: Awaited<ReturnType<typeof f.target>>,
) {
  const file = snapshot.files.find((item) => item.path === "ROUTER.md")
  if (!file) throw new Error("Router entrypoint missing")
  const bytes = f.objects.get(`objects/${file.sha256}`)
  if (!bytes) throw new Error("Router object missing")
  return new TextDecoder().decode(bytes)
}

describe("shared Router snapshot integration", () => {
  test("public current consumption freezes the member index while all member bodies stay lazy", async () => {
    const f = routerFixture()
    const snapshot = await f.target()
    expect(snapshot.entrypoint).toBe("ROUTER.md")
    expect(snapshot.router_members).toHaveLength(1)
    expect(snapshot.router_members?.[0]?.id).toBe("shared_skill:library-snapshot:router-member")
    expect(mainText(f, snapshot)).toContain("## Members")
    expect(mainText(f, snapshot)).toContain("Lazy member")
    expect(mainText(f, snapshot)).toContain("First member description")
    expect(f.readBodyCount()).toBe(1)
    expect(f.calls.some((call) => call.path.startsWith(`v1/pages/${id(900)}`))).toBe(false)
    expect(
      f.calls.filter((call) =>
        call.path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`),
      ),
    ).toHaveLength(1)
    f.clearCalls()
    expect((await f.target()).snapshot_id).toBe(snapshot.snapshot_id)
    expect(f.calls).toHaveLength(0)
  })

  test("member metadata refresh changes the generated index without downloading any body or changing an old pin", async () => {
    const f = routerFixture()
    const first = await f.target()
    const original = structuredClone(f.json.get(`snapshots/${first.snapshot_id}.json`))
    for (const [key, value] of f.json)
      if (key.startsWith("cache/latest/")) property(value).validated_at = Date.now() - 300_001
    property(f.member.properties).description = rich("description", "Updated member description")
    f.clearCalls()
    const current = await f.target()
    expect(current.snapshot_id).not.toBe(first.snapshot_id)
    expect(mainText(f, current)).toContain("Updated member description")
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect(f.json.get(`snapshots/${first.snapshot_id}.json`)).toEqual(original)
    f.clearCalls()
    const pinned = await f.run(
      targetSnapshot({ selector: skillPage, path: "ROUTER.md", snapshot: first.snapshot_id }),
    )
    expect(mainText(f, pinned)).toContain("First member description")
    expect(f.calls).toHaveLength(0)
  })

  test("missing registered Members fails before body observation or adoption", async () => {
    const f = routerFixture(false)
    await expect(f.target()).rejects.toThrow("registered native Members")
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect(f.json.size).toBe(0)
  })

  test("an explicitly disabled member cannot produce a shortened successful Router", async () => {
    const f = routerFixture()
    property(f.member.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
    await expect(f.target()).rejects.toThrow()
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("older shared Router snapshots lacking their index are not reused offline or as current TTL hits", async () => {
    const f = routerFixture()
    const first = await f.target()
    const legacy = property(structuredClone(f.json.get(`snapshots/${first.snapshot_id}.json`)))
    delete legacy.router_members
    legacy.version_id = digest("legacy-router-version")
    legacy.snapshot_id = `s_${digest(JSON.stringify([legacy.scope, property(legacy.record).id, legacy.version_id]))}`
    const legacyId = String(legacy.snapshot_id)
    f.json.set(`snapshots/${legacyId}.json`, legacy)
    for (const [key, value] of f.json)
      if (key.startsWith("cache/latest/")) {
        property(value).snapshot_id = legacyId
        property(value).version_id = legacy.version_id
      }
    f.clearCalls()
    await expect(f.target({ offline: true })).rejects.toThrow("no frozen Members index")
    await expect(
      f.run(targetSnapshot({ selector: skillPage, path: "ROUTER.md", snapshot: legacyId })),
    ).rejects.toThrow("no frozen Members index")
    expect(f.calls).toHaveLength(0)
    const refreshed = await f.target()
    expect(refreshed.snapshot_id).toBe(first.snapshot_id)
    expect(refreshed.router_members).toHaveLength(1)
    expect(f.calls.length).toBeGreaterThan(0)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect(property(f.json.get(`snapshots/${legacyId}.json`)).router_members).toBeUndefined()
  })
})
