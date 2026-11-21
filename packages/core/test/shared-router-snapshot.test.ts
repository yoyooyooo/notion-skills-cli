import { describe, expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { parseTarget } from "../src/ref.ts"
import { LIBRARY_MARKER } from "../src/shared-library-model.ts"
import { targetSnapshot } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import {
  currentDigest as digest,
  currentId as id,
  currentLibrary as library,
  currentRich as rich,
  currentSnapshotFixture,
  currentSkillPage as skillPage,
} from "./shared-current-fixture.ts"

function routerFixture(registered = true) {
  const f = currentSnapshotFixture({ fileCount: 0 })
  property(f.main.properties)["Kind"] = { id: "kind", type: "select", select: { name: "router" } }
  property(f.main.properties).members = {
    id: "members%3A",
    type: "relation",
    relation: [{ id: id(900) }],
    has_more: false,
  }
  const propertyIds: Record<string, string> = {
    ...library.skills.property_ids,
    Members: "members%3A",
  }
  if (!registered) delete propertyIds.Members
  const descriptor = {
    ...library,
    skills: {
      ...library.skills,
      property_ids: propertyIds,
    },
  }
  const member = structuredClone(f.main)
  member.id = id(900)
  const fields = property(member.properties)
  fields["Kind"] = { id: "kind", type: "select", select: { name: "skill" } }
  fields["Skill ID"] = rich("skill-id", "router-member")
  fields["Name"] = {
    id: "title",
    type: "title",
    title: [{ type: "text", text: { content: "Lazy member" }, plain_text: "Lazy member" }],
  }
  fields["Description"] = rich("description", "First member description")
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Notion | Store | Crypto.Crypto | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
    >,
  ) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* effect.pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              const endpoint = path.split("?", 1)[0]
              if (endpoint === `v1/pages/${member.id}`) {
                f.calls.push({ path, body, method: "GET" })
                return Effect.succeed(structuredClone(member))
              }
              if (endpoint === `v1/data_sources/${library.skills.data_source_id}/query`) {
                f.calls.push({
                  path,
                  method: options?.method ?? (body === undefined ? "GET" : "POST"),
                  body,
                })
                const filter = property(body).filter
                if (filter !== undefined)
                  expect(property(filter).property).toBe(library.skills.property_ids["Skill ID"])
                return Effect.succeed({
                  object: "list",
                  results: structuredClone(
                    [f.main, member].filter(
                      (row) =>
                        filter === undefined ||
                        text(property(property(row.properties)["Skill ID"]).rich_text) ===
                          property(property(filter).rich_text).equals,
                    ),
                  ),
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
    expect(snapshot.router_members?.[0]?.id).toBe("shared_skill:library-current:router-member")
    expect(snapshot.router_members?.[0]?.metadata).toMatchObject({
      name: "Lazy member",
      description: "First member description",
    })
    expect(mainText(f, snapshot)).toContain("Keep the author's content.")
    expect(mainText(f, snapshot)).not.toContain("## Members")
    expect(f.bodyCalls().length).toBe(1)
    expect(f.calls.filter((call) => call.path.startsWith(`v1/pages/${id(900)}`))).toEqual([
      { method: "GET", path: `v1/pages/${id(900)}`, body: undefined },
    ])
    expect(
      f.calls.filter((call) =>
        call.path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`),
      ),
    ).toHaveLength(1)
    f.clearCalls()
    expect((await f.target()).snapshot_id).toBe(snapshot.snapshot_id)
    expect(f.calls).toHaveLength(0)
  })

  test("member metadata refresh changes the directory without rewriting authored body or an existing local selection", async () => {
    const f = routerFixture()
    const first = await f.target()
    const original = structuredClone(f.json.get(`snapshots/${first.snapshot_id}.json`))
    for (const [key, value] of f.json)
      if (key.startsWith("cache/latest/")) property(value).validated_at = Date.now() - 300_001
    property(f.member.properties)["Description"] = rich("description", "Updated member description")
    f.clearCalls()
    const current = await f.target()
    expect(current.snapshot_id).toBe(first.snapshot_id)
    expect(current.router_members?.[0]?.metadata).toMatchObject({
      description: "Updated member description",
    })
    expect(mainText(f, current)).toBe(mainText(f, first))
    expect(f.bodyCalls().length).toBe(0)
    expect(f.semanticWrites().length).toBe(0)
    expect(f.json.get(`snapshots/${first.snapshot_id}.json`)).toEqual(original)
    f.clearCalls()
    const pinned = await f.run(
      targetSnapshot({ selector: skillPage, path: "ROUTER.md", snapshot: first.snapshot_id }),
    )
    expect(pinned.router_members?.[0]?.metadata).toMatchObject({
      description: "First member description",
    })
    expect(f.calls).toHaveLength(0)
  })

  test("missing registered Members fails current admission before body observation or writes", async () => {
    const f = routerFixture(false)
    await expect(f.target()).rejects.toMatchObject({ code: "CURRENT_SCHEMA_REQUIRED" })
    expect(f.bodyCalls().length).toBe(0)
    expect(f.semanticWrites().length).toBe(0)
    expect(f.json.size).toBe(0)
  })

  test("an explicitly disabled member cannot produce a shortened successful Router", async () => {
    const f = routerFixture()
    property(f.member.properties)["Enabled"] = { id: "enabled", type: "checkbox", checkbox: false }
    await expect(f.target()).rejects.toThrow()
    expect(f.bodyCalls().length).toBe(0)
    expect(f.semanticWrites().length).toBe(0)
  })

  test("a damaged current Router directory cannot be used offline and is reselected online", async () => {
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
        property(value).current_snapshot = legacy
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
    expect(f.bodyCalls().length).toBe(0)
    expect(f.semanticWrites().length).toBe(0)
    expect(property(f.json.get(`snapshots/${legacyId}.json`)).router_members).toBeUndefined()
  })
})
