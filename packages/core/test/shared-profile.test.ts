import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Crypto, Effect, Layer, Schema } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import { LIBRARY_MARKER } from "../src/shared-library-model.ts"
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
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedProfileRecords,
  querySharedRecords,
} from "../src/shared-records.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`
const fields = {
  Name: "title",
  "Record ID": "record",
  Kind: "kind",
  "Entity ID": "entity",
  Hash: "hash",
  Payload: "payload",
  Skill: "skill",
}
const library: SharedLibrary = {
  version: 1,
  library_id: "library-profile",
  operation_id: "library-profile-init",
  parent_page_id: id(1),
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
      References: "references",
      "Skill ID": "skill_id",
      "Main File ID": "main_file_id",
      Projection: "projection",
      Source: "source",
    },
  },
  files: {
    database_id: id(4),
    data_source_id: id(5),
    property_ids: {
      Name: "title",
      "File ID": "file_id",
      Path: "path",
      Projection: "projection",
      Status: "status",
      Skill: "skill",
    },
  },
  records: { database_id: id(6), data_source_id: id(7), property_ids: fields },
}
const defaultView = id(8)
const sessionView = id(9)
const otherView = id(14)
const otherLibrary: SharedLibrary = {
  ...library,
  library_id: "library-other",
  operation_id: "library-other-init",
  parent_page_id: id(10),
  skills: { ...library.skills, database_id: id(12), data_source_id: id(13) },
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
  const records: Record<string, unknown>[] = []
  const json = new Map<string, unknown>()
  const retired = new Map<string, unknown>()
  const generations = new Map<string, number>()
  const fences = new Map<string, number>()
  const calls: Array<{ path: string; body: unknown; method: string; content?: string }> = []
  let credential = "profile-credential"
  let nextPage = 100
  let lost: "visible" | "absent" | undefined
  let queryFailure = false
  let incomplete = false
  let forcedRows: Record<string, unknown>[] | undefined
  let onCreate: (() => void) | undefined
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
        [fields["Record ID"]]: rich(plan.revision_id),
        [fields["Entity ID"]]: rich(plan.payload.profile_id),
        [fields.Kind]: { select: { name: "profile" } },
        [fields.Hash]: rich(digest(payload)),
        [fields.Payload]: rich(payload),
        [fields.Skill]: { relation: [] },
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
          onCreate?.()
          if (outcome !== undefined)
            return Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Fixture lost the original Profile response"),
            )
          return Effect.succeed(row)
        }
        return Effect.fail(
          fail("UNEXPECTED", "Profile attempted a body, provider or unrelated request", { path }),
        )
      }),
  }
  const store: Store["Service"] = {
    root: "/unused",
    configRoot: "/unused",
    cacheRoot: "/unused",
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die("Unexpected binding"),
    advanceBaseAndReceipt: () => Effect.die("Unexpected baseline"),
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
            if (retired.has(key)) throw fail("STATE_CONFLICT", "Retired dispatch cannot reopen")
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
          if (key.startsWith(pendingPrefix) && json.has(key)) retired.set(key, json.get(key))
          else if (key.startsWith("cache/views/")) {
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
    run: <A, E>(effect: Effect.Effect<A, E, Notion | Crypto.Crypto | Store>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer))),
    clear: () => {
      calls.length = 0
    },
    unknown: (outcome: "visible" | "absent") => {
      lost = outcome
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
    onCreate: (action?: () => void) => {
      onCreate = action
    },
    credential: (value: string) => {
      credential = value
    },
    pending: () => [...json.entries()].filter(([key]) => key.startsWith(pendingPrefix)),
    cached: () => [...json.entries()].filter(([key]) => key.startsWith("cache/views/")),
    writes: () => calls.filter((call) => call.path === "v1/pages" && call.method === "POST").length,
    queries: () =>
      calls.filter((call) =>
        call.path.startsWith(`v1/data_sources/${library.records.data_source_id}/query`),
      ).length,
  }
}

describe("library-owned Profile management", () => {
  test("saves one immutable empty-Skill Profile only after its original plan is durable", async () => {
    const f = fixture()
    f.onCreate(() => {
      expect(f.pending()).toHaveLength(1)
    })
    const saved = await f.run(
      saveSharedProfile(library, { profile: initial, expectedRevision: null }),
    )
    expect(saved.verified).toBe(true)
    expect(saved.current).toBe(true)
    expect(saved.profile).toMatchObject({
      ...initial,
      library_id: library.library_id,
      parent_revision_id: null,
    })
    expect(f.writes()).toBe(1)
    expect(f.pending()).toHaveLength(0)
    expect(f.retired.size).toBe(1)
    expect(property(property(f.records[0]?.properties)[fields.Skill]).relation).toEqual([])
    expect(f.calls.every((call) => call.content === undefined)).toBe(true)
    f.clear()
    const repeated = await f.run(
      saveSharedProfile(library, { profile: initial, expectedRevision: null }),
    )
    expect(repeated.revision_id).toBe(saved.revision_id)
    expect(repeated.mode).toBe("reconcile")
    expect(f.writes()).toBe(0)
  })

  test("a batch Profile list pages once per 100 records and does not read bodies or local preferences", async () => {
    const f = fixture()
    for (let index = 0; index < 101; index += 1)
      f.seed(
        await f.run(
          prepareSharedProfileChange(library, {
            profile: { profile_id: `p-${index}`, name: `Profile ${index}`, enabled: true },
            expectedRevision: null,
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
      and: [
        { property: fields.Skill, relation: { is_empty: true } },
        { property: fields.Kind, select: { equals: "profile" } },
      ],
    })
  })

  test("ordinary shared records still require the exact Skill relation", async () => {
    const f = fixture()
    const saved = await f.run(
      appendSharedRecord(library, {
        mode: "create",
        kind: "file_event",
        skillPageId: id(20),
        recordId: "old-event",
        operationId: "old-operation",
        entityId: "file-a",
        payload: { old: true },
      }),
    )
    expect(saved.skill_page_id).toBe(id(20))
    const read = await f.run(querySharedRecords(library, { skillPageId: id(20) }))
    expect(read).toHaveLength(1)
    const row = f.records[0]
    if (row === undefined) throw new Error("Missing fixture record")
    property(property(row.properties)[fields.Skill]).relation = []
    f.force([row])
    const error = await f.run(Effect.flip(querySharedRecords(library, { skillPageId: id(20) })))
    expect(error.code).toBe("INVALID_SHARED_RECORD")
    const wrongKind = await f.run(Effect.flip(querySharedProfileRecords(library)))
    expect(wrongKind.code).toBe("INVALID_SHARED_RECORD")
  })

  test("the Profile decoder rejects a fake Skill binding and a payload revision mismatch", async () => {
    const f = fixture()
    const plan = await f.run(
      prepareSharedProfileChange(library, { profile: initial, expectedRevision: null }),
    )
    const row = f.seed(plan)
    property(property(row.properties)[fields.Skill]).relation = [{ id: id(20) }]
    f.force([row])
    expect((await f.run(Effect.flip(loadSharedProfile(library, "daily")))).code).toBe(
      "INVALID_SHARED_RECORD",
    )
    property(property(row.properties)[fields.Skill]).relation = []
    const changed = canonicalSharedJson({
      version: 1,
      operation_id: plan.operation_id,
      payload: { ...plan.payload, name: "Changed outside its revision" },
    })
    property(row.properties)[fields.Payload] = fieldValue(fields.Payload, {
      rich_text: [{ plain_text: changed }],
    })
    property(row.properties)[fields.Hash] = fieldValue(fields.Hash, {
      rich_text: [{ plain_text: digest(changed) }],
    })
    expect((await f.run(Effect.flip(loadSharedProfile(library, "daily")))).code).toBe(
      "SHARED_PROFILE_INVALID",
    )
  })

  test("lost invisible writes retain their exact plan and cannot be blindly resent or replaced", async () => {
    const f = fixture()
    f.unknown("absent")
    const first = await f.run(
      Effect.flip(saveSharedProfile(library, { profile: initial, expectedRevision: null })),
    )
    expect(first.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(f.writes()).toBe(1)
    const frozen = structuredClone(f.pending())
    f.clear()
    expect(
      (
        await f.run(
          Effect.flip(saveSharedProfile(library, { profile: initial, expectedRevision: null })),
        )
      ).code,
    ).toBe("SHARED_RECORD_UNRESOLVED")
    expect(f.writes()).toBe(0)
    expect(f.pending()).toEqual(frozen)
    expect(
      (
        await f.run(
          Effect.flip(
            saveSharedProfile(library, {
              profile: { ...initial, name: "Replacement" },
              expectedRevision: null,
            }),
          ),
        )
      ).code,
    ).toBe("SHARED_PROFILE_PENDING")
    expect(f.writes()).toBe(0)
    expect(f.pending()).toEqual(frozen)
  })

  test("a lost visible write reconciles the original revision without revalidating a changed current View", async () => {
    const f = fixture()
    f.unknown("visible")
    await f.run(
      Effect.flip(saveSharedProfile(library, { profile: initial, expectedRevision: null })),
    )
    f.views.clear()
    f.clear()
    const reconciled = await f.run(
      saveSharedProfile(library, { profile: initial, expectedRevision: null }),
    )
    expect(reconciled.mode).toBe("reconcile")
    expect(reconciled.verified).toBe(true)
    expect(f.pending()).toHaveLength(0)
    expect(f.writes()).toBe(0)
    expect(f.calls.some((call) => call.path.startsWith("v1/views/"))).toBe(false)
  })

  test("explicit reconcile without a prior visible revision never creates a dispatch", async () => {
    const f = fixture()
    const error = await f.run(
      Effect.flip(
        saveSharedProfile(library, { profile: initial, expectedRevision: null, mode: "reconcile" }),
      ),
    )
    expect(error.code).toBe("SHARED_RECORD_UNRESOLVED")
    expect(f.writes()).toBe(0)
    expect(f.pending()).toHaveLength(0)
  })

  test("stale updates and a default View from another library stop before dispatch", async () => {
    const f = fixture()
    const saved = await f.run(
      saveSharedProfile(library, { profile: initial, expectedRevision: null }),
    )
    f.clear()
    expect(
      (
        await f.run(
          Effect.flip(
            saveSharedProfile(library, {
              profile: { ...initial, name: "New" },
              expectedRevision: null,
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
              expectedRevision: saved.revision_id,
            }),
          ),
        )
      ).code,
    ).toBe("VIEW_SCOPE_MISMATCH")
    expect(f.writes()).toBe(0)
    expect(f.pending()).toHaveLength(0)
  })

  test("missing parent history and concurrent heads fail without ordering by time or page", async () => {
    const f = fixture()
    const root = await f.run(
      prepareSharedProfileChange(library, { profile: initial, expectedRevision: null }),
    )
    const left = await f.run(
      prepareSharedProfileChange(library, {
        profile: { ...initial, name: "Left" },
        expectedRevision: root.revision_id,
      }),
    )
    const right = await f.run(
      prepareSharedProfileChange(library, {
        profile: { ...initial, name: "Right" },
        expectedRevision: root.revision_id,
      }),
    )
    f.seed(left)
    expect((await f.run(Effect.flip(loadSharedProfile(library, "daily")))).code).toBe(
      "SHARED_PROFILE_BASELINE_MISSING",
    )
    f.seed(root)
    f.seed(right)
    expect((await f.run(Effect.flip(loadSharedProfile(library, "daily")))).code).toBe(
      "SHARED_PROFILE_CONFLICT",
    )
    const error = await f.run(
      Effect.flip(
        saveSharedProfile(library, {
          profile: { ...initial, name: "Arbitrary winner" },
          expectedRevision: left.revision_id,
        }),
      ),
    )
    expect(error.code).toBe("SHARED_PROFILE_CONFLICT")
    expect(f.writes()).toBe(0)
  })

  test("a retired original dispatch cannot authorize replay when its record is temporarily absent", async () => {
    const f = fixture()
    await f.run(saveSharedProfile(library, { profile: initial, expectedRevision: null }))
    f.records.length = 0
    f.clear()
    expect(
      (
        await f.run(
          Effect.flip(saveSharedProfile(library, { profile: initial, expectedRevision: null })),
        )
      ).code,
    ).toBe("STATE_CONFLICT")
    expect(f.writes()).toBe(0)
  })

  test("explicit session View precedes a Profile default and the first-View fallback remains available", async () => {
    const f = fixture()
    const saved = await f.run(
      saveSharedProfile(library, { profile: initial, expectedRevision: null }),
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
        prepareSharedProfileChange(library, { profile: initial, expectedRevision: null }),
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
    expect(property(f.cached()[0]?.[1]).domain).toBe("shared_profile_v1")
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
        prepareSharedProfileChange(library, { profile: initial, expectedRevision: null }),
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

  test("a newly observed conflict invalidates cached rules instead of serving an old default", async () => {
    const f = fixture()
    const root = await f.run(
      prepareSharedProfileChange(library, { profile: initial, expectedRevision: null }),
    )
    f.seed(root)
    await f.run(loadSharedProfileCached(library, "daily"))
    await f.run(loadSharedProfileEntryCached(library.skills.database_id, "daily"))
    expect(f.cached()).toHaveLength(2)
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, {
          profile: { ...initial, name: "Left" },
          expectedRevision: root.revision_id,
        }),
      ),
    )
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, {
          profile: { ...initial, name: "Right" },
          expectedRevision: root.revision_id,
        }),
      ),
    )
    expect(
      (await f.run(Effect.flip(loadSharedProfileCached(library, "daily", { refresh: true })))).code,
    ).toBe("SHARED_PROFILE_CONFLICT")
    expect(f.cached()).toHaveLength(0)
  })

  test("known pending changes block the current TTL fast path while explicit offline retains the prior observation", async () => {
    const f = fixture()
    const saved = await f.run(
      saveSharedProfile(library, { profile: initial, expectedRevision: null }),
    )
    await f.run(loadSharedProfileCached(library, "daily"))
    f.unknown("absent")
    await f.run(
      Effect.flip(
        saveSharedProfile(library, {
          profile: { ...initial, name: "Pending edit" },
          expectedRevision: saved.revision_id,
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
        prepareSharedProfileChange(library, { profile: initial, expectedRevision: null }),
      ),
    )
    const cold = await f.run(loadSharedProfileEntryCached(library.skills.database_id, "daily"))
    expect(cold.library).toEqual(library)
    expect(f.queries()).toBe(1)
    expect(
      f.calls.filter((call) => call.path === `v1/databases/${library.skills.database_id}`),
    ).toHaveLength(1)
    f.clear()
    f.deny(true)
    expect(
      (await f.run(loadSharedProfileEntryCached(library.skills.database_id, "daily"))).source,
    ).toBe("local_cache")
    expect(
      (
        await f.run(
          loadSharedProfileEntryCached(library.skills.database_id, "daily", { offline: true }),
        )
      ).freshness.policy,
    ).toBe("offline")
    expect(f.calls).toHaveLength(0)
    f.credential("different-profile-credential")
    expect(
      (
        await f.run(
          Effect.flip(
            loadSharedProfileEntryCached(library.skills.database_id, "daily", { offline: true }),
          ),
        )
      ).code,
    ).toBe("CACHE_SCOPE_UNAVAILABLE")
    expect(f.calls).toHaveLength(0)
  })

  test("confirmed rule changes invalidate both descriptor and entry observations", async () => {
    const f = fixture()
    const root = await f.run(
      prepareSharedProfileChange(library, { profile: initial, expectedRevision: null }),
    )
    f.seed(root)
    await f.run(loadSharedProfileCached(library, "daily"))
    await f.run(loadSharedProfileEntryCached(library.skills.database_id, "daily"))
    expect(f.cached()).toHaveLength(2)
    await f.run(
      saveSharedProfile(library, {
        profile: { ...initial, name: "Updated rules" },
        expectedRevision: root.revision_id,
      }),
    )
    expect(f.cached()).toHaveLength(0)
    f.clear()
    expect(
      (await f.run(loadSharedProfileEntryCached(library.skills.database_id, "daily"))).profile.name,
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
      default_database: id(90),
    }
    f.json.set("config.json", structuredClone(original))
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, { profile: initial, expectedRevision: null }),
      ),
    )
    const result = await f.run(bindSharedProfile({ libraryEntry: "library", profileId: "daily" }))
    const binding = { library_entry: library.skills.database_id, profile_id: "daily" }
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
      shared_profile: { library_entry: library.skills.database_id, profile_id: "daily" },
    })
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, {
          profile: { ...initial, enabled: false },
          expectedRevision: null,
        }),
      ),
    )
    const result = await f.run(catalogWithProfile())
    expect(result.records.map((record) => record.kind).sort()).toEqual(["prompt", "skill"])
    expect("profile" in result).toBe(false)
    expect(f.queries()).toBe(0)
    expect(f.calls.some((call) => call.path.startsWith("v1/views"))).toBe(false)
    expect(f.calls.some((call) => /\/markdown|\/blocks|\/export|\/pages\//u.test(call.path))).toBe(
      false,
    )
  })

  test("bound default selects shared rules, excludes Prompts, and a second startup has no descriptor GET", async () => {
    const f = fixture({ allowConfiguration: true })
    f.json.set("config.json", {
      sources: [source],
      shared_profile: { library_entry: library.skills.database_id, profile_id: "daily" },
    })
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, { profile: initial, expectedRevision: null }),
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
    expect(f.queries()).toBe(1)
    expect(
      f.calls.filter((call) =>
        call.path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`),
      ),
    ).toHaveLength(1)
    expect(f.calls.some((call) => /\/pages\/|\/markdown|\/blocks|\/export/u.test(call.path))).toBe(
      false,
    )
    expect(f.calls.every((call) => call.content === undefined)).toBe(true)
    expect(f.writes()).toBe(0)
    f.clear()
    const warm = await f.run(catalogWithProfile({ defaultView: true }))
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
      shared_profile: { library_entry: library.skills.database_id, profile_id: "daily" },
    })
    f.seed(
      await f.run(
        prepareSharedProfileChange(library, {
          profile: { ...initial, enabled: false },
          expectedRevision: null,
        }),
      ),
    )
    const result = await f.run(
      catalogWithProfile({
        database: library.skills.database_id,
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
          expectedRevision: null,
        }),
      ),
    )
    const selected = await f.run(catalogWithProfile({ database: "library", profile: "daily" }))
    expect("view" in selected && selected.view?.id).toBe(sessionView)
    expect("profile" in selected && selected.profile).toMatchObject({ selection: "first" })
    expect(selected.records.map((record) => record.kind)).toEqual(["skill"])
    f.clear()
    const unbound = await f.run(catalogWithProfile({ database: "library", defaultView: true }))
    expect("view" in unbound && unbound.view?.id).toBe(sessionView)
    expect(f.queries()).toBe(0)
  })

  test("an explicit other database overrides the machine library binding", async () => {
    const f = fixture({ allowConfiguration: true })
    f.json.set("config.json", {
      sources: [source],
      shared_profile: { library_entry: library.skills.database_id, profile_id: "daily" },
    })
    const result = await f.run(
      catalogWithProfile({ database: otherLibrary.skills.database_id, defaultView: true }),
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
      shared_profile: { library_entry: library.skills.database_id, profile_id: "daily" },
    })
    const saved = await f.run(
      saveSharedProfile(library, { profile: initial, expectedRevision: null }),
    )
    await f.run(catalogWithProfile({ defaultView: true }))
    f.unknown("absent")
    await f.run(
      Effect.flip(
        saveSharedProfile(library, {
          profile: { ...initial, default_view_id: sessionView },
          expectedRevision: saved.revision_id,
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
