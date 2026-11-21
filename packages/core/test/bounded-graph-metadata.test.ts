import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { cacheStatus, invalidateSnapshotCache } from "../src/cache.ts"
import { prepareGraph } from "../src/graph-prepare.ts"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef } from "../src/ref.ts"
import { sharedSkillId } from "../src/shared-content.ts"
import { sharedGraphInventory, withSharedGraphReads } from "../src/shared-graph-read-context.ts"
import { readSkill } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import { nativeGraphFixture } from "./graph-prepare-live-fixture.ts"
import { currentDigest as digest, currentRich as rich } from "./shared-current-fixture.ts"

const endpoint = (path: string) => path.split("?", 1)[0]

/** An independent Notion boundary: identity filters are enforced before paging.
 * A partial identity query can never silently return the fixture's whole table. */
function selectedFixture(options: Parameters<typeof nativeGraphFixture>[0] = {}) {
  const f = nativeGraphFixture(options)
  const query = `v1/data_sources/${f.descriptor.skills.data_source_id}/query`
  const responses: { filtered: boolean; rows: number }[] = []
  const selectedRun = <A, E>(effect: Parameters<typeof f.run<A, E>>[0]) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* effect.pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              if (endpoint(path) !== query || property(body).filter === undefined)
                return api.request(path, body, options).pipe(
                  Effect.map((raw) => {
                    if (endpoint(path) === query)
                      responses.push({
                        filtered: false,
                        rows: (property(raw).results as unknown[]).length,
                      })
                    return raw
                  }),
                )
              const filter = property(property(body).filter)
              const parts = Array.isArray(filter.or) ? filter.or : [filter]
              const ids = parts.map((raw) => {
                const part = property(raw)
                if (
                  part.property !== f.descriptor.skills.property_ids["Skill ID"] ||
                  typeof property(part.rich_text).equals !== "string"
                )
                  throw fail(
                    "UNEXPECTED_REQUEST",
                    "Only exact registered Skill ID filters are allowed.",
                  )
                return property(part.rich_text).equals
              })
              const values = f.pages.filter((page) =>
                ids.includes(
                  property(
                    (property(page.properties).skill_id as { rich_text: unknown[] }).rich_text[0],
                  ).plain_text,
                ),
              )
              const cursor = property(body).start_cursor
              const offset = typeof cursor === "string" ? Number(cursor.replace("offset-", "")) : 0
              const end = Math.min(values.length, offset + 100)
              const properties = new Set(
                new URL(path, "https://fixture.invalid/").searchParams.getAll("filter_properties"),
              )
              const results = values.slice(offset, end).map((row) => ({
                ...structuredClone(row),
                properties: Object.fromEntries(
                  Object.entries(row.properties).filter(
                    ([key]) => !properties.size || properties.has(key),
                  ),
                ),
              }))
              f.calls.push({ path, body, method: options?.method ?? "POST" })
              responses.push({ filtered: true, rows: results.length })
              return Effect.succeed({
                object: "list",
                results,
                has_more: end < values.length,
                next_cursor: end < values.length ? `offset-${end}` : null,
              })
            },
          }),
        )
      }),
    )
  return { ...f, run: selectedRun, responses }
}

function selectedFailure(
  f: ReturnType<typeof selectedFixture>,
  request: (api: Notion["Service"]) => Notion["Service"]["request"],
  root = f.pageIds[0]!,
) {
  return f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* prepareGraph(
        { roots: [root], purpose: "use", freshness: { policy: "refresh" } },
        { database: f.descriptor.skills.database_id },
      ).pipe(Effect.provideService(Notion, { ...api, request: request(api) }), Effect.result)
    }),
  )
}

const noGuessedDenial = (f: ReturnType<typeof selectedFixture>) => {
  expect(
    [...f.json.values()].filter((value) => property(value).access_denied !== undefined),
  ).toEqual([])
}

describe("selected graph metadata stays bounded by requested identities", () => {
  test.each(["permission", "metadata", "identity"])(
    "an explicit stable claim still needs its fresh exact owner before body: %s",
    async (mode) => {
      const f = selectedFixture({ width: 0 }),
        path = `v1/pages/${f.pageIds[0]}`
      const root = fileRef(sharedSkillId(f.descriptor.library_id, "a"), "SKILL.md")
      let updated = false
      const result = await f.run(
        Effect.gen(function* () {
          const api = yield* Notion
          return yield* readSkill(root, { database: f.descriptor.skills.database_id }).pipe(
            Effect.provideService(Notion, {
              ...api,
              request: (selected, body, options) => {
                if (selected === path) {
                  if (mode === "permission")
                    return Effect.fail(fail("ACCESS_DENIED", "Exact owner denied", { path }))
                  if (!updated) {
                    updated = true
                    if (mode === "identity")
                      property(f.pages[0]!.properties).skill_id = rich("skill_id", "replacement")
                    else {
                      property(f.pages[0]!.properties).title = {
                        id: "title",
                        type: "title",
                        title: [
                          {
                            type: "text",
                            plain_text: "Fresh owner",
                            text: { content: "Fresh owner" },
                          },
                        ],
                      }
                      property(f.pages[0]!.properties).description = rich(
                        "description",
                        "Fresh description",
                      )
                    }
                  }
                }
                return api.request(selected, body, options)
              },
            }),
            Effect.result,
          )
        }),
      )
      if (mode === "metadata") {
        expect(result._tag).toBe("Success")
        if (result._tag !== "Success") throw result.failure
        expect(result.success.record.name).toBe("Fresh owner")
        expect(result.success.record.description).toBe("Fresh description")
      } else {
        expect(result._tag === "Failure" && result.failure.code).toBe(
          mode === "permission" ? "ACCESS_DENIED" : "SHARED_SKILL_ID_CONFLICT",
        )
        expect(f.readBodyCount()).toBe(0)
      }
    },
  )

  test("the Broker stable-root shape with an explicit database avoids full discovery", async () => {
    const f = selectedFixture({ width: 201 })
    property(f.pages[0]!.properties).requires = {
      id: "requires",
      type: "relation",
      relation: [],
      has_more: false,
    }
    const root = fileRef(sharedSkillId(f.descriptor.library_id, "a"), "SKILL.md")
    const result = await f.run(
      prepareGraph(
        { roots: [root], purpose: "use" },
        { database: f.descriptor.skills.database_id },
      ),
    )
    expect(result.usage.prepared_nodes).toBe(1)
    expect(f.responses.filter((row) => !row.filtered)).toEqual([])
    expect(f.responses.reduce((sum, row) => sum + row.rows, 0)).toBe(1)
    expect(f.readBodyCount()).toBe(1)
  })

  test("one exact owner with empty relations does not scan unrelated Skills", async () => {
    const costs: number[] = []
    for (const width of [0, 201]) {
      const f = selectedFixture({ width })
      property(f.pages[0]!.properties).requires = {
        id: "requires",
        type: "relation",
        relation: [],
        has_more: false,
      }
      const result = await f.run(
        prepareGraph(
          { roots: [f.pageIds[0]!], purpose: "inspect" },
          { database: f.descriptor.skills.database_id },
        ),
      )
      expect(result.usage.prepared_nodes).toBe(1)
      expect(f.responses.filter((row) => !row.filtered)).toEqual([])
      expect(f.responses.reduce((sum, row) => sum + row.rows, 0)).toBe(1)
      expect(f.readBodyCount()).toBe(1)
      costs.push(f.calls.length)
    }
    expect(costs[1]).toBe(costs[0])
  })

  test("a Requires diamond validates its owners without observing unrelated rows", async () => {
    const f = selectedFixture()
    for (let index = 0; index < 201; index++) {
      const row = structuredClone(f.pages[4]!)
      row.id = `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
      property(row.properties).skill_id = rich("skill_id", `unrelated-${index}`)
      f.pages.push(row)
    }
    const result = await f.run(
      prepareGraph(
        { roots: [f.pageIds[0]!], purpose: "use" },
        { database: f.descriptor.skills.database_id },
      ),
    )
    expect(result.usage.prepared_nodes).toBe(4)
    expect(f.responses.filter((row) => !row.filtered)).toEqual([])
    expect(f.responses.reduce((sum, row) => sum + row.rows, 0)).toBe(5)
    expect(f.readBodyCount()).toBe(4)
    expect(f.calls.some((call) => endpoint(call.path)?.startsWith("v1/pages/10000000-"))).toBe(
      false,
    )
  })

  test("a disabled unselected page still conflicts with a selected stable identity", async () => {
    const f = selectedFixture({ width: 0 })
    const duplicate = structuredClone(f.pages[0]!)
    duplicate.id = "10000000-0000-4000-8000-000000000001"
    property(duplicate.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
    f.pages.push(duplicate)
    const result = await f.run(
      prepareGraph(
        { roots: [f.pageIds[0]!], purpose: "use" },
        { database: f.descriptor.skills.database_id },
      ).pipe(Effect.result),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe("SHARED_SKILL_ID_CONFLICT")
    expect(f.readBodyCount()).toBe(0)
  })

  test("explicit full inventory remains complete including unselected rows", async () => {
    const f = selectedFixture({ width: 101 })
    const value = await f.run(
      withSharedGraphReads(sharedGraphInventory(f.descriptor), {
        currentRoots: [],
        purpose: "inspect",
        maxNodes: 128,
        maxDepth: 16,
        scope: digest("bounded-catalog"),
      }),
    )
    expect(value?.complete).toBe(true)
    expect(value?.pages).toHaveLength(102)
    expect(f.responses.map((row) => row.filtered)).toEqual([false, false])
    expect(f.readBodyCount()).toBe(0)
  })
})

describe("physical authorization across stable identity changes", () => {
  test("the Store boundary fences both stable pins if a physical page alias has changed", async () => {
    const f = selectedFixture({ width: 1 })
    const database = f.descriptor.skills.database_id
    const first = await f.run(
      prepareGraph({ roots: [f.pageIds[0]!], purpose: "use" }, { database }),
    )
    const child = first.nodes.find(
      (node) => node.state === "prepared" && node.roles.includes("required"),
    )!
    if (child.state !== "prepared") throw new Error("Missing old complete child")
    const alias = `cache/shared-page-identities/${first.scope}/${f.pageIds[1]}.json`
    // Construct the Store boundary state directly. The public SQLite store freezes
    // page aliases and rejects a different stable identity even after retirement.
    f.json.delete(alias)
    property(f.pages[1]!.properties).skill_id = rich("skill_id", "changed-child")
    f.pages[1]!.last_edited_time = "2026-11-21T00:00:00.000Z"
    const changedContent = "# Changed stable child B\n"
    f.bodies.set(f.pageIds[1]!, changedContent)
    const changed = await f.run(
      readSkill(fileRef(sharedSkillId(f.descriptor.library_id, "changed-child"), "SKILL.md"), {
        database,
        refresh: true,
      }),
    )
    expect(property(f.json.get(alias)).record_identity).toBe(changed.record.id)
    expect(changed.record.id).not.toBe(child.id)
    expect("content" in changed && changed.content).toBe(changedContent)
    expect(await f.run(readSkill(child.ref, { offline: true }))).toMatchObject({
      content: "# leaf-0 instruction\n",
      snapshot_id: child.binding.snapshot_id,
    })
    const childPath = `v1/pages/${f.pageIds[1]}`
    const failed = await selectedFailure(
      f,
      (api) => (path, body, options) =>
        path === childPath
          ? Effect.fail(fail("ACCESS_DENIED", "Exact child rejected", { path }))
          : api.request(path, body, options),
    )
    expect(failed._tag).toBe("Failure")
    f.clearCalls()
    for (const ref of [changed.ref, child.ref]) {
      const result = await f.run(readSkill(ref, { offline: true }).pipe(Effect.result))
      expect(result._tag === "Failure" && result.failure.code).toBe("ACCESS_DENIED")
    }
    expect(f.calls).toEqual([])
    await f.run(readSkill(changed.record.ref, { database, refresh: true }))
    f.clearCalls()
    const pins = [
      { ref: child.ref, snapshot_id: child.binding.snapshot_id, content: "# leaf-0 instruction\n" },
      { ref: changed.ref, snapshot_id: changed.snapshot_id, content: changedContent },
    ]
    expect(digest(pins[0]!.content)).not.toBe(digest(pins[1]!.content))
    for (const pin of pins) {
      const restored = await f.run(readSkill(pin.ref, { offline: true }))
      expect(restored).toMatchObject(pin)
      expect("content" in restored && digest(restored.content)).toBe(digest(pin.content))
    }
    expect(f.calls).toEqual([])
  })

  test.each(["alias-read", "stable-write"])(
    "a physical rejection is durable when the subsequent %s fails",
    async (phase) => {
      const f = selectedFixture({ width: 0 })
      const page = f.pageIds[0]!
      const first = await f.run(readSkill(page, { database: f.descriptor.skills.database_id }))
      const alias = `cache/shared-page-identities/${first.scope}/${page}.json`
      const failureCode = phase === "alias-read" ? "STATE_CORRUPT" : "STATE_WRITE_FAILED"
      const result = await f.run(
        Effect.gen(function* () {
          const original = yield* Store
          return yield* invalidateSnapshotCache(page, first.scope, {
            retainForOffline: true,
            accessDenied: "ACCESS_DENIED",
          }).pipe(
            Effect.provideService(Store, {
              ...original,
              readJson: (key, schema) =>
                phase === "alias-read" && key === alias
                  ? Effect.fail(fail("STATE_CORRUPT", "Controlled alias read failure"))
                  : original.readJson(key, schema),
              writeJson: (key, value) =>
                phase === "stable-write" &&
                property(value).record_identity === first.record.id &&
                property(value).access_denied === "ACCESS_DENIED"
                  ? Effect.fail(fail("STATE_WRITE_FAILED", "Controlled stable write failure"))
                  : original.writeJson(key, value),
            }),
            Effect.result,
          )
        }),
      )
      expect(result._tag === "Failure" && result.failure.code).toBe(failureCode)
      f.clearCalls()
      const retained = await f.run(readSkill(first.ref, { offline: true }).pipe(Effect.result))
      expect(retained._tag === "Failure" && retained.failure.code).toBe("ACCESS_DENIED")
      expect(f.calls).toEqual([])
    },
  )

  test("a physical grant does not become a duplicate current cache observation", async () => {
    const f = selectedFixture({ width: 0 })
    const page = f.pageIds[0]!
    const database = f.descriptor.skills.database_id
    const first = await f.run(readSkill(page, { database }))
    f.json.delete(`cache/shared-page-identities/${first.scope}/${page}.json`)
    await f.run(
      invalidateSnapshotCache(page, first.scope, {
        retainForOffline: true,
        accessDenied: "ACCESS_DENIED",
      }),
    )
    await f.run(readSkill(page, { database, refresh: true }))
    f.clearCalls()
    const status = await f.run(cacheStatus())
    expect(status.observations).toHaveLength(1)
    expect(status.observations).toMatchObject([
      { page_id: first.record.id, snapshot_id: first.snapshot_id },
    ])
    expect(f.calls).toEqual([])
  })
})

describe("bounded target observations preserve identity and failure boundaries", () => {
  test.each([false, true])(
    "an exact Required 403 fences that child's cached bytes and a fresh verified read restores access (alias cleared: %s)",
    async (clearAlias) => {
      const f = selectedFixture({ width: 1 })
      const before = await f.run(
        prepareGraph(
          { roots: [f.pageIds[0]!], purpose: "use" },
          { database: f.descriptor.skills.database_id },
        ),
      )
      const root = before.nodes.find(
        (node) => node.state === "prepared" && node.roles.includes("root"),
      )!
      const child = before.nodes.find(
        (node) => node.state === "prepared" && node.roles.includes("required"),
      )!
      if (root.state !== "prepared" || child.state !== "prepared")
        throw new Error("Expected cached root and child")
      if (clearAlias)
        f.json.delete(`cache/shared-page-identities/${before.scope}/${f.pageIds[1]}.json`)
      const childPath = `v1/pages/${f.pageIds[1]}`
      const failed = await selectedFailure(
        f,
        (api) => (path, body, options) =>
          path === childPath
            ? Effect.fail(
                fail("ACCESS_DENIED", "Exact child permission revoked", {
                  path,
                  notion_code: "restricted_resource",
                }),
              )
            : api.request(path, body, options),
      )
      expect(failed._tag).toBe("Failure")
      if (failed._tag !== "Failure") throw new Error("Expected dependency failure")
      f.clearCalls()
      for (const ref of [child.ref, child.binding.record.ref]) {
        const result = await f.run(readSkill(ref, { offline: true }).pipe(Effect.result))
        expect(result._tag === "Failure" && result.failure.code).toBe("ACCESS_DENIED")
      }
      expect("content" in (await f.run(readSkill(root.ref, { offline: true })))).toBe(true)
      expect(f.calls).toEqual([])
      const prepared = property(property(failed.failure.details).preparation)
      const denied = (prepared.nodes as Record<string, unknown>[]).filter(
        (node) => node.state === "failed" && property(node.error).code === "ACCESS_DENIED",
      )
      expect(denied).toHaveLength(1)
      expect(denied[0]!.id).toBe(f.pageIds[1])
      expect(denied[0]!.ref).toBe(fileRef(f.pageIds[1]!, ""))
      expect(denied[0]!.roles).toEqual(["required"])
      expect(
        "content" in
          (await f.run(
            readSkill(child.binding.record.ref, {
              database: f.descriptor.skills.database_id,
              refresh: true,
            }),
          )),
      ).toBe(true)
      f.clearCalls()
      expect("content" in (await f.run(readSkill(child.ref, { offline: true })))).toBe(true)
      expect(f.calls).toEqual([])
    },
  )

  test.each(["ACCESS_DENIED", "NOT_FOUND", "NOTION_REQUEST_FAILED"])(
    "%s on a Required page keeps the old root readable and names only the observed child",
    async (code) => {
      const f = selectedFixture({ width: 1 })
      const before = await f.run(
        prepareGraph(
          { roots: [f.pageIds[0]!], purpose: "use" },
          { database: f.descriptor.skills.database_id },
        ),
      )
      const root = before.nodes.find(
        (node) => node.state === "prepared" && node.roles.includes("root"),
      )!
      if (root.state !== "prepared") throw new Error("Expected a prepared root")
      const childPath = `v1/pages/${f.pageIds[1]}`
      const failure = await selectedFailure(
        f,
        (api) => (path, body, options) =>
          path === childPath
            ? Effect.fail(
                fail(code, "Controlled exact-child failure", {
                  path,
                  notion_code:
                    code === "ACCESS_DENIED"
                      ? "restricted_resource"
                      : code === "NOT_FOUND"
                        ? "object_not_found"
                        : "gateway_timeout",
                }),
              )
            : api.request(path, body, options),
      )
      expect(failure._tag).toBe("Failure")
      if (failure._tag !== "Failure") throw new Error("Expected child failure")
      expect(failure.failure.code).toBe(
        code === "NOTION_REQUEST_FAILED" ? code : "SHARED_ROUTER_MEMBER_UNAVAILABLE",
      )
      if (code === "NOTION_REQUEST_FAILED")
        expect(property(failure.failure.details).path).toBe(childPath)
      else {
        expect(property(failure.failure.details).page_id).toBe(f.pageIds[1])
        expect(property(failure.failure.details).field).toBe("Requires")
        expect(property(failure.failure.details).cause_code).toBe(code)
      }
      if (code === "ACCESS_DENIED") {
        const denied = [...f.json.values()].filter(
          (value) => property(value).access_denied !== undefined,
        )
        expect(new Set(denied.map((value) => property(value).record_identity))).toEqual(
          new Set([sharedSkillId(f.descriptor.library_id, "leaf-0"), f.pageIds[1]]),
        )
        expect(denied.every((value) => property(value).scope === before.scope)).toBe(true)
      } else noGuessedDenial(f)
      f.clearCalls()
      const retained = await f.run(readSkill(root.ref, { offline: true }))
      expect("content" in retained && retained.content).toBe("# a instruction\n")
      expect(f.calls).toEqual([])
    },
  )

  test.each([undefined, "v1/pages/another-page"])(
    "a reported denial with unverified path %s cannot assert the requested child's authorization",
    async (reportedPath) => {
      const f = selectedFixture({ width: 1 })
      const childPath = `v1/pages/${f.pageIds[1]}`
      const result = await selectedFailure(
        f,
        (api) => (path, body, options) =>
          path === childPath
            ? Effect.fail(
                fail("ACCESS_DENIED", "A differently attributed observation", {
                  ...(reportedPath === undefined ? {} : { path: reportedPath }),
                }),
              )
            : api.request(path, body, options),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") throw new Error("Expected unavailable child")
      expect(result.failure.code).toBe("SHARED_ROUTER_MEMBER_UNAVAILABLE")
      expect(property(result.failure.details).page_id).toBeUndefined()
      expect(property(result.failure.details).requested_page_id).toBe(f.pageIds[1])
      noGuessedDenial(f)
    },
  )

  test("a claim-query denial cannot revoke a previously readable root", async () => {
    const f = selectedFixture({ width: 0 })
    const before = await f.run(
      prepareGraph(
        { roots: [f.pageIds[0]!], purpose: "use" },
        { database: f.descriptor.skills.database_id },
      ),
    )
    const root = before.nodes.find((node) => node.state === "prepared")!
    if (root.state !== "prepared") throw new Error("Expected a prepared root")
    const query = `v1/data_sources/${f.descriptor.skills.data_source_id}/query`
    const result = await selectedFailure(
      f,
      (api) => (path, body, options) =>
        endpoint(path) === query
          ? Effect.fail(
              fail("ACCESS_DENIED", "Only identity lookup was denied", {
                path,
                notion_code: "restricted_resource",
              }),
            )
          : api.request(path, body, options),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe(
      "SHARED_GRAPH_METADATA_UNAVAILABLE",
    )
    noGuessedDenial(f)
    f.clearCalls()
    expect("content" in (await f.run(readSkill(root.ref, { offline: true })))).toBe(true)
    expect(f.calls).toEqual([])
  })

  test("an authentication rejection on a Required request still fences its entire authenticated scope", async () => {
    const f = selectedFixture({ width: 1 })
    const before = await f.run(
      prepareGraph(
        { roots: [f.pageIds[0]!], purpose: "use" },
        { database: f.descriptor.skills.database_id },
      ),
    )
    const path = `v1/pages/${f.pageIds[1]}`
    const failed = await selectedFailure(
      f,
      (api) => (selected, body, options) =>
        selected === path
          ? Effect.fail(
              fail("AUTH_REQUIRED", "Controlled authentication rejection", {
                path,
                notion_code: "unauthorized",
              }),
            )
          : api.request(selected, body, options),
    )
    expect(failed._tag === "Failure" && failed.failure.code).toBe("AUTH_REQUIRED")
    f.clearCalls()
    for (const node of before.nodes.filter((node) => node.state === "prepared")) {
      const result = await f.run(readSkill(node.ref, { offline: true }).pipe(Effect.result))
      expect(result._tag === "Failure" && result.failure.code).toBe("AUTH_REQUIRED")
    }
    expect(f.calls).toEqual([])
  })

  test.each(["wrong-identity", "foreign", "repeated-page", "incomplete", "terminal-cursor"])(
    "the selected query rejects %s without publishing bytes",
    async (issue) => {
      const f = selectedFixture({ width: 0 })
      const query = `v1/data_sources/${f.descriptor.skills.data_source_id}/query`
      const result = await selectedFailure(
        f,
        (api) => (path, body, options) =>
          api.request(path, body, options).pipe(
            Effect.map((raw) => {
              if (endpoint(path) !== query) return raw
              const value = structuredClone(property(raw)),
                rows = value.results as Record<string, unknown>[]
              if (issue === "wrong-identity")
                property(rows[0]!.properties).skill_id = rich("skill_id", "another")
              if (issue === "foreign")
                property(rows[0]!.parent).data_source_id = f.descriptor.files.data_source_id
              if (issue === "repeated-page") rows.push(structuredClone(rows[0]!))
              if (issue === "incomplete")
                value.request_status = {
                  type: "incomplete",
                  incomplete_reason: "query_result_limit_reached",
                }
              if (issue === "terminal-cursor") value.next_cursor = "unconsumed"
              return value
            }),
          ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") throw new Error("Expected invalid metadata")
      expect(result.failure.code).toBe(
        issue === "foreign"
          ? "INVALID_SHARED_SKILL"
          : ["incomplete", "terminal-cursor"].includes(issue)
            ? "SHARED_GRAPH_METADATA_INCOMPLETE"
            : "SHARED_GRAPH_METADATA_INVALID",
      )
      expect(f.readBodyCount()).toBe(0)
      expect([...f.json.keys()].some((key) => key.startsWith("snapshots/"))).toBe(false)
    },
  )

  test.each(["duplicate", "repeated-cursor"])("a second claim page exposes %s", async (issue) => {
    const f = selectedFixture({ width: 0 })
    const query = `v1/data_sources/${f.descriptor.skills.data_source_id}/query`
    let pages = 0
    const result = await selectedFailure(f, (api) => (path, body, options) => {
      if (endpoint(path) !== query) return api.request(path, body, options)
      pages++
      const duplicate = structuredClone(f.pages[0]!)
      duplicate.id = "10000000-0000-4000-8000-000000000111"
      property(duplicate.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
      return Effect.succeed(
        pages === 1
          ? { object: "list", results: [f.pages[0]], has_more: true, next_cursor: "next" }
          : issue === "duplicate"
            ? { object: "list", results: [duplicate], has_more: false, next_cursor: null }
            : { object: "list", results: [], has_more: true, next_cursor: "next" },
      )
    })
    expect(result._tag === "Failure" && result.failure.code).toBe(
      issue === "duplicate" ? "SHARED_SKILL_ID_CONFLICT" : "SHARED_GRAPH_METADATA_INCOMPLETE",
    )
    expect(pages).toBe(2)
    expect(f.readBodyCount()).toBe(0)
  })

  test.each(["wrong-library", "missing-id", "noncanonical-id"])(
    "an explicit stable root rejects %s without falling back to a full catalog",
    async (issue) => {
      const f = selectedFixture({ width: 201 })
      const identity =
        issue === "wrong-library"
          ? sharedSkillId("another-library", "a")
          : issue === "missing-id"
            ? sharedSkillId(f.descriptor.library_id, "absent")
            : `shared_skill:${f.descriptor.library_id}:a:invalid`
      const result = await selectedFailure(f, (api) => api.request, fileRef(identity, "SKILL.md"))
      expect(result._tag === "Failure" && result.failure.code).toBe(
        issue === "noncanonical-id" ? "INVALID_REF" : "SKILL_NOT_FOUND",
      )
      expect(f.responses.some((row) => !row.filtered)).toBe(false)
      expect(f.readBodyCount()).toBe(0)
    },
  )

  test("an external native link still obtains a complete inventory lazily", async () => {
    const f = selectedFixture()
    f.bodies.set(
      f.pageIds[0]!,
      `# Root\n[Other](https://www.notion.so/${f.pageIds[4]!.replaceAll("-", "")})\n`,
    )
    const result = await f.run(
      prepareGraph(
        { roots: [f.pageIds[0]!], purpose: "inspect" },
        { database: f.descriptor.skills.database_id },
      ),
    )
    expect(result.usage.prepared_nodes).toBe(1)
    expect(f.responses.filter((row) => !row.filtered)).toEqual([{ filtered: false, rows: 5 }])
    expect(f.readBodyCount()).toBe(1)
  })
})
