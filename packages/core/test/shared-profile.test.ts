import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { trashPath } from "../src/local-locks.ts"
import { createHash } from "node:crypto"
import { Crypto, Effect, Layer, Schema } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import { LIBRARY_MARKER } from "../src/shared-library-model.ts"
import { librarySchemaResponse } from "./library-schema-fixture.ts"
import {
  bindSharedProfile,
  catalogWithProfile,
  unbindSharedProfile,
} from "../src/shared-profile-config.ts"
import {
  loadSharedProfile,
  loadSharedProfileCached,
  loadSharedProfileEntryCached,
  listSharedProfiles,
  prepareSharedProfileChange,
  saveSharedProfile,
  selectProfileView,
  type SharedProfilePlan,
} from "../src/shared-profile.ts"
import { canonicalSharedJson, querySharedProfileRecords } from "../src/shared-records.ts"
import { Store } from "../src/store.ts"
import { sourceDefinitionLayout } from "../src/shared-sources-model.ts"

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`
const fields = {
  Name: "title",
  "Record ID": "record",
  Kind: "kind",
  "Entity ID": "entity",
  Hash: "hash",
  Payload: "payload",
  Skill: "skill",
  Resource: "resource",
  Origin: "origin",
}
const library: SharedLibrary = {
  version: 2,
  library_id: "3edee24e-6f66-5e9a-b5d6-06be63dcbd4d",
  operation_id: "library-profile-init",
  skills: {
    database_id: id(2),
    data_source_id: id(3),
    property_ids: {
      Name: "title",
      Description: "description",
      Kind: "kind",
      Tags: "tags",
      Enabled: "enabled",
      "Default Context": "default",
      "Skill ID": "skill_id",
      "Main File ID": "main_file_id",
      Content: "content",
      "Current State": "state",
      Operation: "operation",
      Members: "members",
      Requires: "requires",
      Origin: "origin",
    },
  },
  files: {
    database_id: id(4),
    data_source_id: id(5),
    property_ids: {
      Name: "title",
      "File ID": "file_id",
      Path: "path",
      Content: "content",
      Skill: "skill",
      Origin: "origin",
    },
  },
  records: { database_id: id(6), data_source_id: id(7), property_ids: fields },
  sources: {
    database_id: id(30),
    data_source_id: id(31),
    property_ids: Object.fromEntries(
      Object.keys(sourceDefinitionLayout(id(3), id(7))).map((name, index) => [
        name,
        name === "Name" ? "title" : `source-${index}`,
      ]),
    ),
  },
}
const defaultView = id(8)
const sessionView = id(9)
const otherView = id(14)
const otherLibrary: SharedLibrary = {
  ...library,
  library_id: "45c64249-e1dd-59ab-ad9f-604ff752ddb4",
  operation_id: "library-other-init",
  skills: { ...library.skills, database_id: id(12), data_source_id: id(13) },
  files: { ...library.files, database_id: id(110), data_source_id: id(111) },
  records: { ...library.records, database_id: id(112), data_source_id: id(113) },
  sources: { ...library.sources, database_id: id(114), data_source_id: id(115) },
}
const source = {
  alias: "library",
  database_id: library.skills.database_id,
  title: "Shared library",
  data_source_ids: [library.skills.data_source_id],
  role: "content" as const,
  shared_library: library,
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const initial = {
  profile_id: "daily",
  name: "Daily work",
  enabled: true,
  default_view_id: defaultView,
}
const pendingPrefix = "operations/shared-profile-pending/"
let fixtureParent: string | undefined
afterAll(async () => {
  if (process.platform === "darwin" && fixtureParent !== undefined)
    await Effect.runPromise(trashPath(fixtureParent))
})

function fieldValue(key: string, value: unknown) {
  const raw = property(value)
  if (raw.rich_text !== undefined) return { ...raw, id: key, type: "rich_text", has_more: false }
  if (raw.title !== undefined) return { ...raw, id: key, type: "title" }
  if (raw.select !== undefined) return { ...raw, id: key, type: "select" }
  if (raw.relation !== undefined) return { ...raw, id: key, type: "relation", has_more: false }
  throw new Error("Unexpected Profile fixture property")
}
function matches(row: Record<string, unknown>, value: unknown): boolean {
  const filter = property(value)
  if (Array.isArray(filter.and)) return filter.and.every((part) => matches(row, part))
  if (Array.isArray(filter.or)) return filter.or.some((part) => matches(row, part))
  const field = property(property(row.properties)[String(filter.property)])
  if (filter.relation !== undefined) {
    if (!Array.isArray(field.relation)) return false
    if (property(filter.relation).is_empty === true) return field.relation.length === 0
    return field.relation.some((value) => property(value).id === property(filter.relation).contains)
  }
  if (filter.select !== undefined)
    return property(field.select).name === property(filter.select).equals
  if (filter.rich_text !== undefined)
    return text(field.rich_text) === property(filter.rich_text).equals
  return false
}
function fixture(options: { readonly allowConfiguration?: boolean } = {}) {
  fixtureParent ??= mkdtempSync(join(tmpdir(), "ntn-profile-suite-"))
  const root = mkdtempSync(join(fixtureParent, "case-"))
  const records: Record<string, unknown>[] = []
  const json = new Map<string, unknown>()
  const retired = new Map<string, unknown>()
  const generations = new Map<string, number>()
  const fences = new Map<string, number>()
  const calls: Array<{ path: string; body: unknown; method: string; content?: string }> = []
  let credential = "profile-credential"
  let nextPage = 100
  let lost: "visible" | "absent" | undefined
  let rejected: SkillsError | undefined
  let queryFailure = false
  let incomplete = false
  let forcedRows: Record<string, unknown>[] | undefined
  let onWrite: (() => void) | undefined
  const view = (selected: string, name: string, descriptor = library) => ({
    id: selected,
    name,
    type: "table",
    data_source_id: descriptor.skills.data_source_id,
    parent: { type: "database_id", database_id: descriptor.skills.database_id },
    url: `https://www.notion.so/?v=${selected}`,
  })
  const views = new Map([
    [sessionView, view(sessionView, "Z first")],
    [defaultView, view(defaultView, "A Profile default")],
    [otherView, view(otherView, "Other first", otherLibrary)],
  ])
  const list = (results: readonly unknown[]) => ({
    object: "list",
    results,
    has_more: false,
    next_cursor: null,
  })
  const row = (page: string, kind: "skill" | "prompt", descriptor = library) => ({
    object: "page",
    id: page,
    parent: {
      type: "data_source_id",
      data_source_id: descriptor.skills.data_source_id,
      database_id: descriptor.skills.database_id,
    },
    properties: {
      title: {
        id: "title",
        type: "title",
        title: [{ plain_text: kind === "skill" ? "Available Skill" : "Saved Prompt" }],
      },
      description: {
        id: "description",
        type: "rich_text",
        rich_text: [
          {
            plain_text:
              kind === "skill" ? "A useful shared workflow" : "An explicit reusable prompt",
          },
        ],
      },
      kind: { id: "kind", type: "select", select: { name: kind } },
      skill_id: {
        id: "skill_id",
        type: "rich_text",
        rich_text: [{ plain_text: `${kind}-${page}` }],
      },
      enabled: { id: "enabled", type: "checkbox", checkbox: true },
      default: { id: "default", type: "checkbox", checkbox: false },
      members: { id: "members", type: "relation", has_more: false, relation: [] },
      requires: { id: "requires", type: "relation", has_more: false, relation: [] },
      origin: { id: "origin", type: "relation", has_more: false, relation: [] },
    },
  })
  const create = (body: unknown) => {
    const raw = property(body)
    return {
      object: "page",
      id: id(nextPage++),
      parent: { ...property(raw.parent), database_id: library.records.database_id },
      properties: Object.fromEntries(
        Object.entries(property(raw.properties)).map(([key, value]) => [
          key,
          fieldValue(key, value),
        ]),
      ),
    }
  }
  const seed = (plan: SharedProfilePlan) => {
    const payload = canonicalSharedJson({
      version: 1,
      operation_id: plan.operation_id,
      payload: plan.payload,
    })
    const rich = (value: string) => ({ rich_text: [{ type: "text", text: { content: value } }] })
    const row = create({
      parent: { type: "data_source_id", data_source_id: library.records.data_source_id },
      properties: {
        [fields.Name]: { title: [{ type: "text", text: { content: plan.payload.name } }] },
        [fields["Record ID"]]: rich(plan.record_id),
        [fields["Entity ID"]]: rich(plan.payload.profile_id),
        [fields.Kind]: { select: { name: "profile" } },
        [fields.Hash]: rich(digest(payload)),
        [fields.Payload]: rich(payload),
        [fields.Skill]: { relation: [] },
        [fields.Origin]: { relation: [] },
      },
    })
    records.push(row)
    return row
  }
  const api: Notion["Service"] = {
    version: Effect.succeed("profile-fixture"),
    credentialIdentity: Effect.sync(() => credential),
    request: (path, body, options) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        calls.push({
          path,
          body,
          method: options?.method ?? (body === undefined ? "GET" : "POST"),
          ...(options?.content === undefined ? {} : { content: options.content }),
        })
        const url = new URL(path, "https://api.notion.com/")
        if (
          rejected !== undefined &&
          ((url.pathname === "/v1/pages" && options?.method === "POST") ||
            (url.pathname.startsWith("/v1/pages/") && options?.method === "PATCH"))
        ) {
          const error = rejected
          rejected = undefined
          return Effect.fail(error)
        }
        if (url.pathname === "/v1/users/me") return Effect.succeed({ id: id(900), object: "user" })
        if (url.pathname === "/v1/search")
          return Effect.succeed(
            list([
              {
                id: library.skills.data_source_id,
                parent: { database_id: library.skills.database_id },
                database_type: null,
                title: [{ plain_text: "Shared library" }],
                properties: {
                  "Skill ID": { type: "rich_text" },
                  "Main File ID": { type: "rich_text" },
                },
              },
            ]),
          )
        for (const descriptor of [library, otherLibrary]) {
          const schema = librarySchemaResponse(path, descriptor)
          if (schema !== undefined) return Effect.succeed(schema)
          if (url.pathname === `/v1/databases/${descriptor.skills.database_id}`)
            return Effect.succeed({
              object: "database",
              id: descriptor.skills.database_id,
              database_type: null,
              title: [{ plain_text: "Shared library" }],
              description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(descriptor) }],
              data_sources: [{ id: descriptor.skills.data_source_id, name: "Skills" }],
            })
          if (url.pathname === `/v1/data_sources/${descriptor.skills.data_source_id}/query`)
            return Effect.succeed(
              list([row(id(20), "skill", descriptor), row(id(21), "prompt", descriptor)]),
            )
        }
        if (url.pathname === "/v1/views")
          return Effect.succeed(
            list(
              [...views.values()]
                .filter((view) => view.parent.database_id === url.searchParams.get("database_id"))
                .map((view) => ({ id: view.id, object: "view" })),
            ),
          )
        const query = /^\/v1\/views\/([^/]+)\/queries$/u.exec(url.pathname)
        if (query !== null)
          return Effect.succeed({
            ...list([id(20), id(21)].map((id) => ({ id, object: "page" }))),
            id: id(22),
            view_id: query[1],
            expires_at: new Date(Date.now() + 900_000).toISOString(),
            total_count: 2,
          })
        if (/^\/v1\/views\/[^/]+$/u.test(url.pathname)) {
          const view = views.get(url.pathname.slice("/v1/views/".length))
          return view === undefined
            ? Effect.fail(fail("ACCESS_DENIED", "Fixture View is unavailable"))
            : Effect.succeed(view)
        }
        if (url.pathname === `/v1/data_sources/${library.records.data_source_id}/query`) {
          if (queryFailure)
            return Effect.fail(fail("ACCESS_DENIED", "Fixture denied Profile metadata"))
          const rows = forcedRows ?? records.filter((row) => matches(row, property(body).filter))
          const offset =
            property(body).start_cursor === undefined ? 0 : Number(property(body).start_cursor)
          const page = rows.slice(offset, offset + 100)
          const more = offset + page.length < rows.length
          return Effect.succeed({
            object: "list",
            results: page,
            has_more: more,
            next_cursor: more ? String(offset + page.length) : null,
            ...(incomplete ? { request_status: { type: "incomplete" } } : {}),
          })
        }
        if (url.pathname === "/v1/pages" && options?.method === "POST") {
          const row = create(body)
          const outcome = lost
          lost = undefined
          if (outcome !== "absent") records.push(row)
          onWrite?.()
          if (outcome !== undefined)
            return Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Fixture lost the original Profile response"),
            )
          return Effect.succeed(row)
        }
        if (url.pathname.startsWith("/v1/pages/") && options?.method === "PATCH") {
          const row = records.find((row) => row.id === url.pathname.slice("/v1/pages/".length))
          if (row === undefined)
            return Effect.fail(fail("ACCESS_DENIED", "Fixture Profile is unavailable"))
          const outcome = lost
          lost = undefined
          const properties = Object.fromEntries(
            Object.entries(property(property(body).properties)).map(([key, value]) => [
              key,
              fieldValue(key, value),
            ]),
          )
          if (outcome !== "absent") row.properties = { ...property(row.properties), ...properties }
          onWrite?.()
          if (outcome !== undefined)
            return Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Fixture lost the current Profile response"),
            )
          return Effect.succeed(row)
        }
        return Effect.fail(
          fail("UNEXPECTED", "Profile attempted a body, provider or unrelated request", { path }),
        )
      }),
  }
  const store: Store["Service"] = {
    root,
    configRoot: root,
    cacheRoot: root,
    backup: () => Effect.die("Unexpected backup"),
    reserveCacheGeneration: (scope, identity) =>
      Effect.sync(() => {
        const key = `${scope}/${identity}`
        const next = (generations.get(key) ?? 0) + 1
        generations.set(key, next)
        return next
      }),
    listKeys: (prefix) =>
      Effect.sync(() => [...json.keys()].filter((key) => key.startsWith(prefix))),
    readJson: (key, schema) =>
      Effect.try({
        try: () =>
          json.has(key)
            ? Schema.decodeUnknownSync(schema)(structuredClone(json.get(key)))
            : undefined,
        catch: () => fail("STATE_CORRUPT", "Invalid Profile fixture cache"),
      }),
    writeJson: (key, value) =>
      Effect.try({
        try: () => {
          if (key.startsWith(pendingPrefix)) {
            if (json.has(key) && canonicalSharedJson(json.get(key)) !== canonicalSharedJson(value))
              throw fail("STATE_CONFLICT", "Frozen dispatch cannot change")
          } else if (key.startsWith("cache/views/")) {
            const parts = key.split("/")
            const selection = parts[3]?.replace(/\.json$/u, "")
            const fence = `${parts[2]}/views-${selection}`
            const incoming = property(value).generation
            if (typeof incoming !== "number" || incoming <= (fences.get(fence) ?? 0))
              throw fail("CACHE_INVALIDATED", "Fixture retired in-flight Profile metadata")
            const previous = property(json.get(key)).generation
            if (typeof previous === "number" && previous > incoming) return
          } else if (
            !key.startsWith("cache/identities/") &&
            !(
              options.allowConfiguration &&
              (key === "config.json" || key.startsWith("cache/catalogs/"))
            )
          )
            throw fail("UNEXPECTED", "Profile attempted to write preferences or other state", {
              key,
            })
          json.set(key, structuredClone(value))
        },
        catch: (error) =>
          error instanceof SkillsError ? error : fail("FIXTURE_ERROR", "Fixture state failure"),
      }),
    retireKeys: (keys) =>
      Effect.sync(() =>
        keys.map((key) => {
          if (key.startsWith("cache/views/")) {
            const parts = key.split("/")
            const fence = `${parts[2]}/views-${parts[3]?.replace(/\.json$/u, "")}`
            fences.set(fence, generations.get(fence) ?? 0)
          }
          json.delete(key)
          return { key, retention_path: `retired/${key}` }
        }),
      ),
    readBytes: () => Effect.die("Unexpected body read"),
    writeBytes: () => Effect.die("Unexpected body write"),
    output: () => Effect.die("Unexpected export"),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Notion, api),
    Layer.succeed(Store, store),
  )
  return {
    records,
    json,
    retired,
    views,
    calls,
    seed,
    overwrite: (plan: SharedProfilePlan) => {
      const current = records.find(
        (row) =>
          text(property(property(row.properties)[fields["Entity ID"]]).rich_text) ===
          plan.payload.profile_id,
      )
      if (current === undefined) throw new Error("Missing current Profile")
      const replacement = seed(plan)
      records.pop()
      current.properties = replacement.properties
    },
    run: <A, E>(effect: Effect.Effect<A, E, Notion | Crypto.Crypto | Store>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer))),
    clear: () => {
      calls.length = 0
    },
    unknown: (outcome: "visible" | "absent") => {
      lost = outcome
    },
    reject: (error: SkillsError) => {
      rejected = error
    },
    deny: (value: boolean) => {
      queryFailure = value
    },
    incomplete: (value: boolean) => {
      incomplete = value
    },
    force: (rows?: Record<string, unknown>[]) => {
      forcedRows = rows
    },
    onWrite: (action?: () => void) => {
      onWrite = action
    },
    credential: (value: string) => {
      credential = value
    },
    pending: () => [...json.entries()].filter(([key]) => key.startsWith(pendingPrefix)),
    cached: () => [...json.entries()].filter(([key]) => key.startsWith("cache/views/")),
    writes: () =>
      calls.filter(
        (call) =>
          (call.path === "v1/pages" && call.method === "POST") ||
          (call.path.startsWith("v1/pages/") && call.method === "PATCH"),
      ).length,
    posts: () => calls.filter((call) => call.path === "v1/pages" && call.method === "POST").length,
    patches: () =>
      calls.filter((call) => call.path.startsWith("v1/pages/") && call.method === "PATCH").length,
    queries: () =>
      calls.filter((call) =>
        call.path.startsWith(`v1/data_sources/${library.records.data_source_id}/query`),
      ).length,
  }
}

describe("library-owned Profile management", () => {
  test("current freshness survives a fresh client and is replaced in place without predecessors", async () => {
    const f = fixture()
    const policy = {
      default: { read_max_age_ms: 60_000 },
      skills: [
        { skill_id: "alpha", read_max_age_ms: 86_400_000 },
        { skill_id: "beta", read_max_age_ms: 0 },
      ],
    }
    const plan = await f.run(
      prepareSharedProfileChange(library, {
        profile: { ...initial, freshness: policy },
        expectedFingerprint: null,
      }),
    )
    await f.run(
      saveSharedProfile(library, {
        profile: { ...initial, freshness: policy },
        expectedFingerprint: null,
      }),
    )
    const cold = fixture()
    cold.records.push(...structuredClone(f.records))
    expect((await cold.run(loadSharedProfile(library, initial.profile_id))).freshness).toEqual(
      policy,
    )
    expect(cold.json.size).toBe(0)
    const cleared = await f.run(
      saveSharedProfile(library, {
        profile: { ...initial, name: "Renamed" },
        expectedFingerprint: plan.fingerprint,
      }),
    )
    expect((await f.run(loadSharedProfile(library, initial.profile_id))).freshness).toBeUndefined()
    expect(cleared.status).toBe("applied")
    expect(f.records).toHaveLength(1)
    expect(f.posts()).toBe(1)
    expect(f.patches()).toBe(1)
    const restarted = fixture()
    restarted.records.push(...structuredClone(f.records))
    const current = await restarted.run(loadSharedProfile(library, initial.profile_id))
    expect(current.name).toBe("Renamed")
    expect(current.freshness).toBeUndefined()
    expect(current.record_page_id).toBe(cleared.profile.record_page_id)
    expect(current.fingerprint).toBe(cleared.fingerprint)
    expect(plan.payload.freshness).toEqual(policy)
  })
  test("writes one empty-Skill current record only after its finite intent is durable", async () => {
    const f = fixture()
    f.onWrite(() => {
      expect(f.pending()).toHaveLength(1)
    })
    const saved = await f.run(
      saveSharedProfile(library, { profile: initial, expectedFingerprint: null }),
    )
    expect(saved.status).toBe("applied")
    expect(saved.current).toBe(true)
    expect(saved.profile).toMatchObject({
      ...initial,
      library_id: library.library_id,
      record_id: expect.stringMatching(/^profile-current-[a-f0-9]{64}$/u),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(f.writes()).toBe(1)
    expect(f.pending()).toHaveLength(0)
    expect(f.retired.size).toBe(0)
    expect(property(property(f.records[0]?.properties)[fields.Skill]).relation).toEqual([])
    expect(f.calls.every((call) => call.content === undefined)).toBe(true)
    f.clear()
    const repeated = await f.run(
      saveSharedProfile(library, { profile: initial, expectedFingerprint: null }),
    )
    expect(repeated.fingerprint).toBe(saved.fingerprint)
    expect(repeated.status).toBe("unchanged")
    expect(f.writes()).toBe(0)
  })

  test("a batch Profile list pages once per 100 records and does not read bodies or local preferences", async () => {
    const f = fixture()
    for (let index = 0; index < 101; index += 1)
      f.seed(
        await f.run(
          prepareSharedProfileChange(library, {
            profile: { profile_id: `p-${index}`, name: `Profile ${index}`, enabled: true },
            expectedFingerprint: null,
          }),
        ),
      )
    const listed = await f.run(listSharedProfiles(library))
    expect(listed.profiles).toHaveLength(101)
    expect(f.queries()).toBe(2)
    expect(f.calls).toHaveLength(2)
    expect(f.calls.every((call) => call.content === undefined)).toBe(true)
    expect(f.json.size).toBe(0)
    expect(property(f.calls[0]?.body).filter).toEqual({
      property: fields.Kind,
      select: { equals: "profile" },
    })
  })

  test("an exact current Profile lookup cannot hide a conflicting Record kind or owner", async () => {
    const f = fixture()
    const plan = await f.run(
      prepareSharedProfileChange(library, { profile: initial, expectedFingerprint: null }),
    )
    const row = f.seed(plan)
    property(property(row.properties)[fields.Kind]).select = { name: "file_event" }
    expect((await f.run(Effect.flip(loadSharedProfile(library, "daily")))).code).toBe(
      "INVALID_SHARED_RECORD",
    )
    property(property(row.properties)[fields.Kind]).select = { name: "profile" }
    property(property(row.properties)[fields.Skill]).relation = [{ id: id(20) }]
    expect((await f.run(Effect.flip(loadSharedProfile(library, "daily")))).code).toBe(
      "INVALID_SHARED_RECORD",
    )
    expect(f.writes()).toBe(0)
  })

  test("canonical JSON retains array order and exact author text, and rejects non-JSON values", () => {
    expect(canonicalSharedJson({ z: [3, 1], a: { beta: "line\r\n", alpha: "  code  " } })).toBe(
      '{"a":{"alpha":"  code  ","beta":"line\\r\\n"},"z":[3,1]}',
    )
    for (const value of [
      NaN,
      undefined,
      [undefined],
      Array(1),
      new Date(),
      {
        get value() {
          throw Error("must not invoke accessor")
        },
      },
    ])
      expect(() => canonicalSharedJson(value)).toThrow()
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expect(() => canonicalSharedJson(cyclic)).toThrow()
  })

  test("a current Profile has no Source owner when Records registers Origin", async () => {
    const f = fixture()
    const withOrigin = {
      ...library,
      records: {
        ...library.records,
        property_ids: { ...library.records.property_ids, Origin: "origin" },
      },
    }
    await f.run(saveSharedProfile(withOrigin, { profile: initial, expectedFingerprint: null }))
    const row = f.records[0]!
    expect(property(property(row.properties).origin).relation).toEqual([])
    expect(await f.run(querySharedProfileRecords(withOrigin))).toHaveLength(1)
    property(property(row.properties).origin).relation = [{ id: id(80) }]
    await expect(f.run(querySharedProfileRecords(withOrigin))).rejects.toMatchObject({
      code: "INVALID_SHARED_RECORD",
    })
    property(property(row.properties).origin).relation = []
    property(property(row.properties).origin).has_more = true
    await expect(f.run(querySharedProfileRecords(withOrigin))).rejects.toMatchObject({
      code: "INVALID_SHARED_RECORD",
    })
  })

  test("the Profile decoder rejects a fake Skill binding and old payloads without interpreting history", async () => {
    const f = fixture()
    const plan = await f.run(
      prepareSharedProfileChange(library, { profile: initial, expectedFingerprint: null }),
    )
    const row = f.seed(plan)
    property(property(row.properties)[fields.Skill]).relation = [{ id: id(20) }]
    f.force([row])
    expect((await f.run(Effect.flip(loadSharedProfile(library, "daily")))).code).toBe(
      "INVALID_SHARED_RECORD",
    )
    property(property(row.properties)[fields.Skill]).relation = []
    const old = canonicalSharedJson({
      version: 1,
      operation_id: plan.operation_id,
      payload: { ...plan.payload, version: 1, parent_revision_id: null },
    })
    property(row.properties)[fields.Payload] = fieldValue(fields.Payload, {
      rich_text: [{ plain_text: old }],
    })
    property(row.properties)[fields.Hash] = fieldValue(fields.Hash, {
      rich_text: [{ plain_text: digest(old) }],
    })
    expect((await f.run(Effect.flip(loadSharedProfile(library, "daily")))).code).toBe(
      "SHARED_PROFILE_INVALID",
    )
    expect(f.writes()).toBe(0)
  })

  test("lost invisible writes retain their exact plan and cannot be blindly resent or replaced", async () => {
    const f = fixture()
    f.unknown("absent")
    const first = await f.run(
      Effect.flip(saveSharedProfile(library, { profile: initial, expectedFingerprint: null })),
    )
    expect(first.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(f.writes()).toBe(1)
    const frozen = structuredClone(f.pending())
    f.clear()
    expect(
      (
        await f.run(
          Effect.flip(saveSharedProfile(library, { profile: initial, expectedFingerprint: null })),
        )
      ).code,
    ).toBe("SHARED_PROFILE_UNRESOLVED")
    expect(f.writes()).toBe(0)
    expect(f.pending()).toEqual(frozen)
    expect(
      (
        await f.run(
          Effect.flip(
            saveSharedProfile(library, {
              profile: { ...initial, name: "Replacement" },
              expectedFingerprint: null,
            }),
          ),
        )
      ).code,
    ).toBe("SHARED_PROFILE_PENDING")
    expect(f.writes()).toBe(0)
    expect(f.pending()).toEqual(frozen)
  })

  test("a definitive rejection clears only the unfinished intent and permits a freshly reviewed retry", async () => {
    const f = fixture()
    const first = await f.run(
      prepareSharedProfileChange(library, { profile: initial, expectedFingerprint: null }),
    )
    f.seed(first)
    const input = {
      profile: { ...initial, name: "Allowed retry" },
      expectedFingerprint: first.fingerprint,
    }
    f.reject(fail("ACCESS_DENIED", "Fixture rejected the write", { phase: "definitive_rejection" }))
    expect((await f.run(Effect.flip(saveSharedProfile(library, input)))).code).toBe("ACCESS_DENIED")
    expect(f.pending()).toHaveLength(0)
    expect((await f.run(loadSharedProfile(library, "daily"))).fingerprint).toBe(first.fingerprint)
    f.clear()
    expect((await f.run(saveSharedProfile(library, input))).status).toBe("applied")
    expect(f.posts()).toBe(0)
    expect(f.patches()).toBe(1)
    expect(f.records).toHaveLength(1)
  })

  test("a lost visible write reconciles current rules without revalidating a changed View", async () => {
    const f = fixture()
    f.unknown("visible")
    await f.run(
      Effect.flip(saveSharedProfile(library, { profile: initial, expectedFingerprint: null })),
    )
    f.views.clear()
    f.clear()
    const reconciled = await f.run(
      saveSharedProfile(library, { profile: initial, expectedFingerprint: null }),
    )
    expect(reconciled.status).toBe("current_matches")
    expect(reconciled.current).toBe(true)
    expect(f.pending()).toHaveLength(0)
    expect(f.writes()).toBe(0)
    expect(f.calls.some((call) => call.path.startsWith("v1/views/"))).toBe(false)
  })

  test("explicit reconcile without visible current rules never creates a dispatch", async () => {
    const f = fixture()
    const error = await f.run(
      Effect.flip(
        saveSharedProfile(library, {
          profile: initial,
          expectedFingerprint: null,
          mode: "reconcile",
        }),
      ),
    )
    expect(error.code).toBe("SHARED_PROFILE_UNRESOLVED")
    expect(f.writes()).toBe(0)
    expect(f.pending()).toHaveLength(0)
  })

  test("stale updates and a default View from another library stop before dispatch", async () => {
    const f = fixture()
    const saved = await f.run(
      saveSharedProfile(library, { profile: initial, expectedFingerprint: null }),
    )
    f.clear()
    expect(
      (
        await f.run(
          Effect.flip(
            saveSharedProfile(library, {
              profile: { ...initial, name: "New" },
              expectedFingerprint: null,
            }),
          ),
        )
      ).code,
    ).toBe("SHARED_PROFILE_STALE")
    expect(f.writes()).toBe(0)
    const view = f.views.get(defaultView)
    if (view === undefined) throw new Error("Missing fixture View")
    f.views.set(defaultView, { ...view, data_source_id: id(999) })
    expect(
      (
        await f.run(
          Effect.flip(
            saveSharedProfile(library, {
              profile: { ...initial, name: "New" },
              expectedFingerprint: saved.fingerprint,
            }),
          ),
        )
      ).code,
    ).toBe("VIEW_SCOPE_MISMATCH")
    expect(f.writes()).toBe(0)
    expect(f.pending()).toHaveLength(0)
  })

  test("duplicate current physical pages fail even when their rules are identical", async () => {
    const f = fixture()
    const initialPlan = await f.run(
      prepareSharedProfileChange(library, { profile: initial, expectedFingerprint: null }),
    )
    f.seed(initialPlan)
    f.seed(initialPlan)
    expect((await f.run(Effect.flip(loadSharedProfile(library, "daily")))).code).toBe(
      "SHARED_PROFILE_DUPLICATE",
    )
    expect((await f.run(Effect.flip(listSharedProfiles(library)))).code).toBe(
      "SHARED_PROFILE_DUPLICATE",
    )
    const error = await f.run(
      Effect.flip(
        saveSharedProfile(library, {
          profile: { ...initial, name: "Arbitrary winner" },
          expectedFingerprint: initialPlan.fingerprint,
        }),
      ),
    )
    expect(error.code).toBe("SHARED_PROFILE_DUPLICATE")
    expect(f.writes()).toBe(0)
    expect(f.pending()).toHaveLength(0)
  })

  test("completion leaves no past rules and the same Profile can change again or return to former content", async () => {
    const f = fixture()
    const first = await f.run(
      saveSharedProfile(library, { profile: initial, expectedFingerprint: null }),
    )
    const changed = await f.run(
      saveSharedProfile(library, {
        profile: { ...initial, name: "Second rules" },
        expectedFingerprint: first.fingerprint,
      }),
    )
    const returned = await f.run(
      saveSharedProfile(library, { profile: initial, expectedFingerprint: changed.fingerprint }),
    )
    expect(returned.fingerprint).toBe(first.fingerprint)
    expect(returned.profile.record_page_id).toBe(first.profile.record_page_id)
    expect(f.records).toHaveLength(1)
    expect(f.posts()).toBe(1)
    expect(f.patches()).toBe(2)
    expect(f.pending()).toHaveLength(0)
    expect(f.retired.size).toBe(0)
    expect(JSON.stringify(f.records)).not.toContain("Second rules")
    expect(JSON.stringify([...f.json.values()])).not.toContain("Second rules")
  })

  test("unknown replacements reconcile visible current rules and never replay an absent PATCH", async () => {
    for (const outcome of ["visible", "absent"] as const) {
      const f = fixture()
      const first = await f.run(
        saveSharedProfile(library, { profile: initial, expectedFingerprint: null }),
      )
      f.clear()
      f.unknown(outcome)
      const input = {
        profile: { ...initial, name: "Changed" },
        expectedFingerprint: first.fingerprint,
      }
      expect((await f.run(Effect.flip(saveSharedProfile(library, input)))).code).toBe(
        "WRITE_OUTCOME_UNKNOWN",
      )
      expect(f.posts()).toBe(0)
      expect(f.patches()).toBe(1)
      expect(f.pending()).toHaveLength(1)
      expect(property(f.pending()[0]?.[1]).target_page_id).toBe(first.profile.record_page_id)
      f.clear()
      if (outcome === "visible") {
        const result = await f.run(saveSharedProfile(library, { ...input, mode: "reconcile" }))
        expect(result.status).toBe("current_matches")
        expect(f.pending()).toHaveLength(0)
      } else {
        expect(
          (await f.run(Effect.flip(saveSharedProfile(library, { ...input, mode: "reconcile" }))))
            .code,
        ).toBe("SHARED_PROFILE_UNRESOLVED")
        expect(f.pending()).toHaveLength(1)
      }
      expect(f.writes()).toBe(0)
      expect(f.records).toHaveLength(1)
    }
  }, 15_000)

  test("reconciliation reports third-party current rules and does not overwrite them", async () => {
    const f = fixture()
    const first = await f.run(
      saveSharedProfile(library, { profile: initial, expectedFingerprint: null }),
    )
    const input = {
      profile: { ...initial, name: "Intended" },
      expectedFingerprint: first.fingerprint,
    }
    f.unknown("absent")
    await f.run(Effect.flip(saveSharedProfile(library, input)))
    f.overwrite(
      await f.run(
        prepareSharedProfileChange(library, {
          profile: { ...initial, name: "Other writer" },
          expectedFingerprint: first.fingerprint,
        }),
      ),
    )
    f.clear()
    expect(
      (await f.run(Effect.flip(saveSharedProfile(library, { ...input, mode: "reconcile" })))).code,
    ).toBe("SHARED_PROFILE_CONFLICT")
    expect(f.writes()).toBe(0)
    expect(f.pending()).toHaveLength(1)
    expect((await f.run(loadSharedProfile(library, "daily"))).name).toBe("Other writer")
  })

  test("matching current content resolves an intent without claiming an original execution proof", async () => {
    const f = fixture()
    const first = await f.run(
      saveSharedProfile(library, { profile: initial, expectedFingerprint: null }),
    )
    const input = {
      profile: { ...initial, name: "Desired" },
      expectedFingerprint: first.fingerprint,
    }
    f.unknown("absent")
    await f.run(Effect.flip(saveSharedProfile(library, input)))
    f.overwrite(
      await f.run(
        prepareSharedProfileChange(library, {
          profile: input.profile,
          expectedFingerprint: null,
        }),
      ),
    )
    f.clear()
    const result = await f.run(saveSharedProfile(library, { ...input, mode: "reconcile" }))
    expect(result.status).toBe("current_matches")
    expect(result).not.toHaveProperty("verified")
    expect(f.pending()).toHaveLength(0)
    expect(f.writes()).toBe(0)
  })

  test("explicit session View precedes a Profile default and the first-View fallback remains available", async () => {
    const f = fixture()
    const saved = await f.run(
      saveSharedProfile(library, { profile: initial, expectedFingerprint: null }),
    )
    expect(selectProfileView(saved.profile)).toMatchObject({
      selection: "profile",
      view: defaultView,
    })
    expect(selectProfileView(saved.profile, sessionView)).toEqual({
      selection: "explicit",
      view: sessionView,
    })
    expect(selectProfileView(undefined)).toEqual({ selection: "first" })
    const { default_view_id: _view, ...withoutDefault } = saved.profile
    expect(selectProfileView(withoutDefault)).toEqual({ selection: "first" })
    expect(() => selectProfileView({ ...saved.profile, enabled: false })).toThrow()
    expect(selectProfileView({ ...saved.profile, enabled: false }, sessionView)).toEqual({
      selection: "explicit",
      view: sessionView,
    })
  })

  test("a complete cached Profile uses zero remote requests during TTL and explicit offline reads", async () => {
    const f = fixture()
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, { profile: initial, expectedFingerprint: null }),
      ),
    )
    const cold = await f.run(loadSharedProfileCached(library, "daily"))
    expect(cold.source).toBe("notion")
    expect(f.queries()).toBe(1)
    f.clear()
    expect((await f.run(loadSharedProfileCached(library, "daily"))).source).toBe("local_cache")
    expect(
      (await f.run(loadSharedProfileCached(library, "daily", { offline: true }))).freshness.policy,
    ).toBe("offline")
    expect(f.calls).toHaveLength(0)
    expect(f.cached()).toHaveLength(1)
    expect(property(f.cached()[0]?.[1]).domain).toBe("shared_profile_v2")
    f.credential("another-credential")
    expect(
      (await f.run(Effect.flip(loadSharedProfileCached(library, "daily", { offline: true })))).code,
    ).toBe("CACHE_SCOPE_UNAVAILABLE")
    expect(f.calls).toHaveLength(0)
  })

  test("expired metadata revalidates once and an incomplete refresh cannot leave a successful old cache", async () => {
    const f = fixture()
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, { profile: initial, expectedFingerprint: null }),
      ),
    )
    await f.run(loadSharedProfileCached(library, "daily"))
    for (const [, value] of f.cached()) property(value).fetched_at = Date.now() - 60_001
    f.clear()
    expect((await f.run(loadSharedProfileCached(library, "daily"))).source).toBe("notion")
    expect(f.queries()).toBe(1)
    f.incomplete(true)
    expect(
      (await f.run(Effect.flip(loadSharedProfileCached(library, "daily", { refresh: true })))).code,
    ).toBe("INVALID_SHARED_RECORD")
    expect(f.cached()).toHaveLength(0)
    f.clear()
    expect(
      (await f.run(Effect.flip(loadSharedProfileCached(library, "daily", { offline: true })))).code,
    ).toBe("CACHE_MISSING")
    expect(f.calls).toHaveLength(0)
  })

  test("newly observed duplicate current rows invalidate cached rules instead of serving an old default", async () => {
    const f = fixture()
    const root = await f.run(
      prepareSharedProfileChange(library, { profile: initial, expectedFingerprint: null }),
    )
    f.seed(root)
    await f.run(loadSharedProfileCached(library, "daily"))
    await f.run(loadSharedProfileEntryCached(library.library_id, "daily"))
    expect(f.cached()).toHaveLength(2)
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, {
          profile: { ...initial, name: "Left" },
          expectedFingerprint: root.fingerprint,
        }),
      ),
    )
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, {
          profile: { ...initial, name: "Right" },
          expectedFingerprint: root.fingerprint,
        }),
      ),
    )
    expect(
      (await f.run(Effect.flip(loadSharedProfileCached(library, "daily", { refresh: true })))).code,
    ).toBe("SHARED_PROFILE_DUPLICATE")
    expect(f.cached()).toHaveLength(0)
  })

  test("known pending changes block the current TTL fast path while explicit offline retains the prior observation", async () => {
    const f = fixture()
    const saved = await f.run(
      saveSharedProfile(library, { profile: initial, expectedFingerprint: null }),
    )
    await f.run(loadSharedProfileCached(library, "daily"))
    f.unknown("absent")
    await f.run(
      Effect.flip(
        saveSharedProfile(library, {
          profile: { ...initial, name: "Pending edit" },
          expectedFingerprint: saved.fingerprint,
        }),
      ),
    )
    f.clear()
    expect((await f.run(Effect.flip(loadSharedProfileCached(library, "daily")))).code).toBe(
      "SHARED_PROFILE_PENDING",
    )
    expect(f.calls).toHaveLength(0)
    const offline = await f.run(loadSharedProfileCached(library, "daily", { offline: true }))
    expect(offline.profile.name).toBe(initial.name)
    expect(offline.freshness.policy).toBe("offline")
    expect(f.calls).toHaveLength(0)
  })
})

describe("Profile machine binding and default discovery", () => {
  test("entry bootstrap retains its validated descriptor so TTL and offline need zero requests", async () => {
    const f = fixture()
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, { profile: initial, expectedFingerprint: null }),
      ),
    )
    const cold = await f.run(loadSharedProfileEntryCached(library.library_id, "daily"))
    expect(cold.library).toEqual(library)
    expect(f.queries()).toBe(1)
    expect(
      f.calls.filter((call) => call.path === `v1/databases/${library.skills.database_id}`),
    ).toHaveLength(1)
    f.clear()
    f.deny(true)
    expect((await f.run(loadSharedProfileEntryCached(library.library_id, "daily"))).source).toBe(
      "local_cache",
    )
    expect(
      (await f.run(loadSharedProfileEntryCached(library.library_id, "daily", { offline: true })))
        .freshness.policy,
    ).toBe("offline")
    expect(f.calls).toHaveLength(0)
    f.credential("different-profile-credential")
    expect(
      (
        await f.run(
          Effect.flip(loadSharedProfileEntryCached(library.library_id, "daily", { offline: true })),
        )
      ).code,
    ).toBe("CACHE_SCOPE_UNAVAILABLE")
    expect(f.calls).toHaveLength(0)
  })

  test("confirmed rule changes invalidate both descriptor and entry observations", async () => {
    const f = fixture()
    const root = await f.run(
      prepareSharedProfileChange(library, { profile: initial, expectedFingerprint: null }),
    )
    f.seed(root)
    await f.run(loadSharedProfileCached(library, "daily"))
    await f.run(loadSharedProfileEntryCached(library.library_id, "daily"))
    expect(f.cached()).toHaveLength(2)
    await f.run(
      saveSharedProfile(library, {
        profile: { ...initial, name: "Updated rules" },
        expectedFingerprint: root.fingerprint,
      }),
    )
    expect(f.cached()).toHaveLength(0)
    f.clear()
    expect(
      (await f.run(loadSharedProfileEntryCached(library.library_id, "daily"))).profile.name,
    ).toBe("Updated rules")
    expect(f.queries()).toBe(1)
    expect(
      f.calls.filter((call) => call.path === `v1/databases/${library.skills.database_id}`),
    ).toHaveLength(1)
  })

  test("binding stores only IDs, preserves unrelated opaque settings, and unbind is entirely local", async () => {
    const f = fixture({ allowConfiguration: true })
    const original = {
      sources: [source],
      token: "fixture-secret-never-emitted",
      future_preferences: { keep: [1, 2, 3] },
      default_library: id(90),
    }
    f.json.set("config.json", structuredClone(original))
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, { profile: initial, expectedFingerprint: null }),
      ),
    )
    const result = await f.run(bindSharedProfile({ library: "library", profileId: "daily" }))
    const binding = { library_id: library.library_id, profile_id: "daily" }
    expect(result.shared_profile).toEqual(binding)
    expect(f.json.get("config.json")).toEqual({ ...original, shared_profile: binding })
    expect(JSON.stringify(result)).not.toContain(original.token)
    expect(f.writes()).toBe(0)
    f.clear()
    expect(await f.run(unbindSharedProfile())).toEqual({ shared_profile: null, removed: true })
    expect(f.json.get("config.json")).toEqual(original)
    expect(await f.run(unbindSharedProfile())).toEqual({ shared_profile: null, removed: false })
    expect(f.calls).toHaveLength(0)
  })

  test("bare discovery ignores a disabled binding and still returns explicit Prompt records", async () => {
    const f = fixture({ allowConfiguration: true })
    f.json.set("config.json", {
      sources: [source],
      default_library: library.library_id,
      shared_profile: { library_id: library.library_id, profile_id: "daily" },
    })
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, {
          profile: { ...initial, enabled: false },
          expectedFingerprint: null,
        }),
      ),
    )
    const result = await f.run(catalogWithProfile())
    expect(result.records.map((record) => record.kind).sort()).toEqual(["prompt", "skill"])
    expect("profile" in result).toBe(false)
    expect(f.queries()).toBe(0)
    expect(f.calls.some((call) => call.path.startsWith("v1/views"))).toBe(false)
    expect(
      f.calls.some(
        (call) =>
          /\/markdown|\/blocks|\/export|\/pages\//u.test(call.path) &&
          call.path !== `v1/pages/${library.library_id}` &&
          !call.path.startsWith(`v1/blocks/${library.library_id}/children`),
      ),
    ).toBe(false)
  })

  test("bound default selects shared rules, excludes Prompts, and a second startup has no descriptor GET", async () => {
    const f = fixture({ allowConfiguration: true })
    f.json.set("config.json", {
      sources: [source],
      default_library: library.library_id,
      shared_profile: { library_id: library.library_id, profile_id: "daily" },
    })
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, { profile: initial, expectedFingerprint: null }),
      ),
    )
    const first = await f.run(catalogWithProfile({ defaultView: true }))
    expect("view" in first && first.view?.id).toBe(defaultView)
    expect("profile" in first && first.profile).toMatchObject({
      profile_id: "daily",
      selection: "profile",
      source: "notion",
    })
    expect(first.records.map((record) => record.kind)).toEqual(["skill"])
    expect("count" in first ? first.count : undefined).toBe(1)
    expect(f.queries()).toBe(1)
    expect(
      f.calls.filter((call) =>
        call.path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`),
      ),
    ).toHaveLength(1)
    expect(
      f.calls.some(
        (call) =>
          /\/pages\/|\/markdown|\/blocks|\/export/u.test(call.path) &&
          call.path !== `v1/pages/${library.library_id}` &&
          !call.path.startsWith(`v1/blocks/${library.library_id}/children`),
      ),
    ).toBe(false)
    expect(f.calls.every((call) => call.content === undefined)).toBe(true)
    expect(f.writes()).toBe(0)
    f.clear()
    const warm = await f.run(catalogWithProfile({ defaultView: true }))
    expect("count" in warm ? warm.count : undefined).toBe(warm.records.length)
    expect("count" in warm ? warm.count : undefined).toBe(1)
    expect(warm.source).toBe("local_cache")
    expect("profile" in warm && warm.profile).toMatchObject({ source: "local_cache" })
    expect(
      (await f.run(catalogWithProfile({ defaultView: true, offline: true }))).freshness.policy,
    ).toBe("offline")
    expect(f.calls).toHaveLength(0)
  })

  test("session View bypasses a disabled Profile and does not hide explicitly selected Prompts", async () => {
    const f = fixture({ allowConfiguration: true })
    f.json.set("config.json", {
      sources: [source],
      default_library: library.library_id,
      shared_profile: { library_id: library.library_id, profile_id: "daily" },
    })
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, {
          profile: { ...initial, enabled: false },
          expectedFingerprint: null,
        }),
      ),
    )
    const result = await f.run(
      catalogWithProfile({
        library: library.library_id,
        profile: "daily",
        view: sessionView,
      }),
    )
    expect("view" in result && result.view?.id).toBe(sessionView)
    expect(result.records.map((record) => record.kind).sort()).toEqual(["prompt", "skill"])
    expect(f.queries()).toBe(0)
    const disabled = await f.run(Effect.flip(catalogWithProfile({ defaultView: true })))
    expect(disabled.code).toBe("SHARED_PROFILE_DISABLED")
  })

  test("Profile default absence falls back to native first View, including unbound defaults", async () => {
    const f = fixture({ allowConfiguration: true })
    f.json.set("config.json", { sources: [source] })
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, {
          profile: { profile_id: "daily", name: "Daily", enabled: true },
          expectedFingerprint: null,
        }),
      ),
    )
    const selected = await f.run(catalogWithProfile({ library: "library", profile: "daily" }))
    expect("view" in selected && selected.view?.id).toBe(sessionView)
    expect("profile" in selected && selected.profile).toMatchObject({ selection: "first" })
    expect(selected.records.map((record) => record.kind)).toEqual(["skill"])
    f.clear()
    const unbound = await f.run(catalogWithProfile({ library: "library", defaultView: true }))
    expect("view" in unbound && unbound.view?.id).toBe(sessionView)
    expect(f.queries()).toBe(0)
  })

  test("an explicit other database overrides the machine library binding", async () => {
    const f = fixture({ allowConfiguration: true })
    f.json.set("config.json", {
      sources: [source],
      default_library: library.library_id,
      shared_profile: { library_id: library.library_id, profile_id: "daily" },
    })
    const result = await f.run(
      catalogWithProfile({ library: otherLibrary.library_id, defaultView: true }),
    )
    expect("view" in result && result.view?.id).toBe(otherView)
    expect("profile" in result).toBe(false)
    expect(f.queries()).toBe(0)
    expect(f.calls.some((call) => call.path === `v1/databases/${library.skills.database_id}`)).toBe(
      false,
    )
  })

  test("invalid selection combinations fail before any request or preference write", async () => {
    const f = fixture({ allowConfiguration: true })
    expect((await f.run(Effect.flip(catalogWithProfile({ profile: "daily" })))).code).toBe(
      "INVALID_ARGUMENT",
    )
    expect(
      (await f.run(Effect.flip(catalogWithProfile({ view: sessionView, defaultView: true })))).code,
    ).toBe("INVALID_ARGUMENT")
    expect(f.calls).toHaveLength(0)
    expect(f.json.size).toBe(0)
  })

  test("unknown Profile changes block an already-warm default startup without falling back to first View", async () => {
    const f = fixture({ allowConfiguration: true })
    f.json.set("config.json", {
      sources: [source],
      default_library: library.library_id,
      shared_profile: { library_id: library.library_id, profile_id: "daily" },
    })
    const saved = await f.run(
      saveSharedProfile(library, { profile: initial, expectedFingerprint: null }),
    )
    await f.run(catalogWithProfile({ defaultView: true }))
    f.unknown("absent")
    await f.run(
      Effect.flip(
        saveSharedProfile(library, {
          profile: { ...initial, default_view_id: sessionView },
          expectedFingerprint: saved.fingerprint,
        }),
      ),
    )
    f.clear()
    expect((await f.run(Effect.flip(catalogWithProfile({ defaultView: true })))).code).toBe(
      "SHARED_PROFILE_PENDING",
    )
    expect(f.calls).toHaveLength(0)
    const offline = await f.run(catalogWithProfile({ defaultView: true, offline: true }))
    expect("view" in offline && offline.view?.id).toBe(defaultView)
    expect(f.calls).toHaveLength(0)
  })
})
