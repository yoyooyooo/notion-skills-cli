import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { prepareGraph } from "../src/graph-prepare.ts"
import {
  sharedGraphInventory,
  sharedGraphTarget,
  withSharedGraphReads,
} from "../src/shared-graph-read-context.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { makeSharedReadCoalescer } from "../src/shared-read-coalescing.ts"
import { queryCurrentFilesForSkills } from "../src/shared-current-index.ts"
import { graphLibrary as library, nativeGraphFixture } from "./graph-prepare-live-fixture.ts"
import { currentDigest as digest, currentRich as rich } from "./shared-current-fixture.ts"

const endpoint = (path: string) => path.split("?", 1)[0]
const isQuery = (table: "skills" | "files" | "records", path: string) =>
  endpoint(path) === `v1/data_sources/${library[table].data_source_id}/query`
const ownerIds = (filter: unknown): string[] => {
  const value = property(filter)
  if (Array.isArray(value.and)) return value.and.flatMap(ownerIds)
  if (Array.isArray(value.or)) return value.or.flatMap(ownerIds)
  const owner = property(value.relation).contains
  return value.property === "skill" && typeof owner === "string" ? [owner] : []
}
const expire = (f: ReturnType<typeof nativeGraphFixture>) => {
  for (const [key, value] of f.json)
    if (key.startsWith("cache/latest/")) f.json.set(key, { ...property(value), validated_at: 0 })
}
const prepare = (
  f: ReturnType<typeof nativeGraphFixture>,
  extra: Partial<Parameters<typeof prepareGraph>[0]> = {},
) =>
  f.run(
    prepareGraph(
      { roots: [f.pageIds[0]!], purpose: "use", ...extra },
      { database: library.skills.database_id, metrics: true },
    ),
  )
const derivedKeys = (f: ReturnType<typeof nativeGraphFixture>) =>
  [...f.json.keys()].filter((key) => key.startsWith("cache/shared-derived-graphs/")).sort()
const inventoryScope = {
  currentRoots: [] as readonly string[],
  purpose: "inspect" as const,
  maxNodes: 128,
  maxDepth: 16,
  scope: digest("projected-inventory"),
}
const openInventoryTarget = (f: ReturnType<typeof nativeGraphFixture>) =>
  withSharedGraphReads(
    Effect.gen(function* () {
      yield* sharedGraphInventory(f.descriptor)
      const target = yield* sharedGraphTarget(f.pageIds[1]!, f.descriptor.skills.database_id)
      if (target === undefined) throw new Error("Missing selected inventory target")
      return yield* openSharedConsumer({
        library: target.library,
        target: f.pageIds[1]!,
        rawPage: target.rawPage,
        scope: inventoryScope.scope,
        startedAt: Date.now(),
      })
    }),
    inventoryScope,
  )

describe("library-scoped graph metadata batches", () => {
  test("inventory retains current fields and both registered relations without unrelated properties", async () => {
    const f = nativeGraphFixture({ width: 101 })
    const propertyIds: Record<string, string> = f.descriptor.skills.property_ids
    Object.assign(propertyIds, { "Auxiliary Metadata": "auxiliary" })
    for (const page of f.pages) {
      property(page.properties).tags = {
        id: "tags",
        type: "multi_select",
        multi_select: [{ id: "tag-acceptance", name: "acceptance", color: "blue" }],
      }
      property(page.properties).auxiliary = rich("auxiliary", "Unrelated fixture metadata")
    }
    const observed = await f.run(
      withSharedGraphReads(sharedGraphInventory(f.descriptor), inventoryScope),
    )
    expect(observed?.complete).toBe(true)
    expect(observed?.pages).toHaveLength(102)
    expect(f.calls.map((call) => property(call.body).start_cursor ?? null)).toEqual([
      null,
      "offset-100",
    ])
    for (const page of observed!.pages) {
      expect(Object.keys(property(property(page).properties)).sort()).toEqual(
        [
          "title",
          "description",
          "kind",
          "enabled",
          "default",
          "skill_id",
          "main_file_id",
          "content",
          "state",
          "operation",
          "origin",
          "members",
          "requires",
        ].sort(),
      )
    }
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test.each([
    ["title", "INVALID_SHARED_SKILL"],
    ["description", "INVALID_SHARED_SKILL"],
    ["kind", "INVALID_SHARED_SKILL"],
    ["enabled", "INVALID_SHARED_SKILL"],
    ["default", "INVALID_SHARED_SKILL"],
    ["skill_id", "INVALID_SHARED_SKILL"],
    ["content", "CURRENT_SCHEMA_REQUIRED"],
    ["state", "CURRENT_SCHEMA_REQUIRED"],
    ["operation", "CURRENT_SCHEMA_REQUIRED"],
    ["main_file_id", "CURRENT_INDEX_INVALID"],
    ["members", "INVALID_SHARED_SKILL"],
    ["requires", "INVALID_SHARED_SKILL"],
  ])("a projected target missing %s fails before body reads or writes", async (field, code) => {
    const f = nativeGraphFixture({ width: 1 })
    delete property(f.pages[1]!.properties)[field!]
    const result = await f.run(openInventoryTarget(f).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected missing graph target metadata")
    expect(result.failure.code).toBe(code!)
    expect(f.calls.every((call) => call.path.startsWith("v1/data_sources/"))).toBe(true)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("projected inventory preserves current Content completeness and stable identity conflict checks", async () => {
    const source = nativeGraphFixture({ width: 1 })
    property(property(source.pages[1]!.properties).content).has_more = true
    const incomplete = await source.run(openInventoryTarget(source).pipe(Effect.result))
    expect(incomplete._tag === "Failure" && incomplete.failure.code).toBe("CURRENT_INDEX_INVALID")
    expect(source.readBodyCount()).toBe(0)
    expect(source.writeCount()).toBe(0)
    const duplicate = nativeGraphFixture({ width: 1 })
    property(duplicate.pages[1]!.properties).skill_id = rich("skill_id", "a")
    const conflict = await duplicate.run(openInventoryTarget(duplicate).pipe(Effect.result))
    expect(conflict._tag === "Failure" && conflict.failure.code).toBe("SHARED_SKILL_ID_CONFLICT")
    expect(duplicate.readBodyCount()).toBe(0)
    expect(duplicate.writeCount()).toBe(0)
  })

  test.each(["incomplete", "foreign", "cursor"])(
    "projected inventory keeps the %s completeness guard",
    async (problem) => {
      const f = nativeGraphFixture({ width: 101 })
      const result = await f.run(
        Effect.gen(function* () {
          const api = yield* Notion
          return yield* withSharedGraphReads(
            sharedGraphInventory(f.descriptor),
            inventoryScope,
          ).pipe(
            Effect.provideService(Notion, {
              ...api,
              request: (path, body, options) =>
                api.request(path, body, options).pipe(
                  Effect.map((raw) => {
                    const value = property(raw)
                    if (problem === "incomplete")
                      return { ...value, request_status: { type: "incomplete" } }
                    if (problem === "cursor")
                      return { ...value, has_more: true, next_cursor: "offset-100" }
                    const rows = structuredClone(value.results as unknown[])
                    property(property(rows[0]).parent).data_source_id = library.files.data_source_id
                    return { ...value, results: rows }
                  }),
                ),
            }),
          )
        }).pipe(Effect.result),
      )
      expect(result._tag === "Failure" && result.failure.code).toBe(
        problem === "foreign"
          ? "SHARED_GRAPH_METADATA_INVALID"
          : "SHARED_GRAPH_METADATA_INCOMPLETE",
      )
      expect(f.calls).toHaveLength(problem === "cursor" ? 2 : 1)
      expect(f.readBodyCount()).toBe(0)
      expect(f.writeCount()).toBe(0)
    },
  )

  test("batching preserves owner-scoped File IDs while duplicate physical pages remain invalid", async () => {
    const f = nativeGraphFixture({ width: 1, filesPerSkill: 1 })
    for (const file of f.files) file.properties.file_id = rich("file_id", "same-local-file")
    const read = () =>
      queryCurrentFilesForSkills({
        dataSourceId: library.files.data_source_id,
        propertyIds: library.files.property_ids,
        skillPageIds: f.pageIds,
      })
    const files = await f.run(read())
    for (const owner of f.pageIds) expect(files.get(owner)?.[0]?.file_id).toBe("same-local-file")
    f.files[1]!.id = f.files[0]!.id
    const duplicate = await f.run(read().pipe(Effect.result))
    expect(duplicate._tag).toBe("Failure")
    if (duplicate._tag !== "Failure") throw new Error("Expected duplicate physical page")
    expect(duplicate.failure.code).toBe("CURRENT_INDEX_INVALID")
  })
  test("101 selected owners are sliced at 80 while every File keeps its exact owner", async () => {
    const f = nativeGraphFixture({ width: 100, filesPerSkill: 1 })
    const files = await f.run(
      queryCurrentFilesForSkills({
        dataSourceId: library.files.data_source_id,
        propertyIds: library.files.property_ids,
        skillPageIds: f.pageIds,
      }),
    )
    expect(files.size).toBe(101)
    for (const owner of f.pageIds) {
      expect(files.get(owner)).toHaveLength(1)
      expect(files.get(owner)![0]!.skill_page_id).toBe(owner)
    }
    expect(f.calls).toHaveLength(2)
    expect(f.calls.map((call) => ownerIds(property(call.body).filter).length)).toEqual([80, 21])
    expect(f.calls.every((call) => isQuery("files", call.path))).toBe(true)
  })

  test("101 Files for one owner exhaust both metadata pages without fetching bodies", async () => {
    const f = nativeGraphFixture({ width: 0, filesPerSkill: 101 })
    const files = await f.run(
      queryCurrentFilesForSkills({
        dataSourceId: library.files.data_source_id,
        propertyIds: library.files.property_ids,
        skillPageIds: f.pageIds,
      }),
    )
    expect(files.get(f.pageIds[0]!)).toHaveLength(101)
    expect(f.calls.map((call) => property(call.body).start_cursor ?? null)).toEqual([
      null,
      "offset-100",
    ])
    expect(f.readBodyCount()).toBe(0)
  })

  test("current native preparation never loads obsolete event payloads or writes retained history", async () => {
    const f = nativeGraphFixture({ width: 100 })
    for (let index = 0; index < 101; index++)
      f.records.set(`obsolete-${index}`, { malformed: "retired file event or historical proof" })
    const result = await prepare(f, { budget: { maxNodes: 128, maxContextBytes: 8 * 1024 * 1024 } })
    expect(result.usage.prepared_nodes).toBe(101)
    expect(f.calls.some((call) => isQuery("records", call.path))).toBe(false)
    expect(f.writeCount()).toBe(0)
  })

  test("a denied selected Files query cannot publish a complete graph or poison a later retry", async () => {
    const f = nativeGraphFixture({ filesPerSkill: 1 })
    const denied = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* prepareGraph(
          { roots: [f.pageIds[0]!], purpose: "use" },
          { database: library.skills.database_id },
        ).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              isQuery("files", path)
                ? Effect.fail(fail("NOTION_FORBIDDEN", "Selected Files permission denied."))
                : api.request(path, body, options),
          }),
        )
      }).pipe(Effect.result),
    )
    expect(denied._tag === "Failure" && denied.failure.code).toBe("NOTION_FORBIDDEN")
    expect(derivedKeys(f)).toEqual([])
    expect(f.writeCount()).toBe(0)
    expect((await prepare(f)).usage.prepared_nodes).toBe(4)
  })

  test("scoped identities cover multi-root diamond metadata and inspect does not batch Required Files", async () => {
    const f = nativeGraphFixture()
    const result = await prepare(f, { roots: [f.pageIds[0]!, f.pageIds[2]!] })
    expect(result.usage.prepared_nodes).toBe(4)
    expect(f.calls.filter((call) => isQuery("skills", call.path))).toHaveLength(4)
    expect(
      f.calls
        .filter((call) => f.pageIds.some((id) => endpoint(call.path) === `v1/pages/${id}`))
        .map((call) => call.path)
        .sort(),
    ).toEqual(
      // One requested-page observation per declared target, then fresh final
      // checks for prepared owners. The optional Member never has its body read.
      [...f.pageIds, ...f.pageIds.slice(0, 4)].map((id) => `v1/pages/${id}`).sort(),
    )
    // Initial batches are followed by one complete Files fence for each prepared owner.
    expect(f.calls.filter((call) => isQuery("files", call.path))).toHaveLength(6)
    expect(
      f.calls
        .filter((call) => isQuery("files", call.path))
        .flatMap((call) => ownerIds(property(call.body).filter)),
    ).not.toContain(f.pageIds[4])
    const g = nativeGraphFixture()
    await prepare(g, { purpose: "inspect" })
    const inspected = g.calls.filter((call) => isQuery("files", call.path))
    expect(inspected).toHaveLength(2)
    expect(inspected.map((call) => ownerIds(property(call.body).filter))).toEqual([
      [g.pageIds[0]!],
      [g.pageIds[0]!],
    ])
  })

  test("25 inline Requires, 101 complete relations and 102 selected identities remain complete", async () => {
    const f = nativeGraphFixture({ width: 101 })
    const result = await prepare(f, { budget: { maxNodes: 128, maxContextBytes: 8 * 1024 * 1024 } })
    expect(result.required_closure).toHaveLength(102)
    expect(f.calls.filter((call) => isQuery("skills", call.path))).toHaveLength(3)
    expect(
      f.calls
        .filter((call) => isQuery("skills", call.path))
        .every((call) => property(call.body).filter !== undefined),
    ).toBe(true)
    expect(f.calls.filter((call) => /\/properties\/requires/u.test(call.path))).toHaveLength(2)
    const fileOwners = f.calls
      .filter((call) => isQuery("files", call.path))
      .map((call) => ownerIds(property(call.body).filter))
    expect(fileOwners.map((owners) => owners.length)).toEqual([
      80,
      22,
      ...Array.from({ length: 102 }, () => 1),
    ])
    expect(fileOwners.slice(2).flat().sort()).toEqual([...f.pageIds].sort())
  })

  test("a node or depth budget never admits excess Required metadata owners", async () => {
    for (const budget of [{ maxNodes: 1 }, { maxDepth: 0 }]) {
      const f = nativeGraphFixture({ width: 30 })
      const result = await f.run(
        prepareGraph(
          { roots: [f.pageIds[0]!], purpose: "use", budget },
          { database: library.skills.database_id },
        ).pipe(Effect.result),
      )
      expect(result._tag).toBe("Failure")
      const files = f.calls.filter((call) => isQuery("files", call.path))
      expect(files).toHaveLength(2)
      expect(files.map((call) => ownerIds(property(call.body).filter))).toEqual([
        [f.pageIds[0]!],
        [f.pageIds[0]!],
      ])
      expect(f.readBodyCount()).toBe(1)
    }
  })

  test("an explicit current File removal changes the directory without replaying obsolete facts", async () => {
    const f = nativeGraphFixture({ filesPerSkill: 1 })
    const before = await prepare(f, { purpose: "inspect" })
    f.records.set("obsolete-file-fact", {
      malformed: "removed File history is not current authority",
    })
    f.files.splice(0, 1)
    expire(f)
    f.clearCalls()
    const after = await prepare(f, { purpose: "inspect" })
    const root = after.nodes.find((node) => node.state === "prepared")
    expect(root?.state).toBe("prepared")
    if (root?.state !== "prepared") throw new Error("Expected complete current root")
    expect(root.files.map((file) => file.path)).toEqual(["SKILL.md"])
    expect(after.graph_lock).not.toEqual(before.graph_lock)
    expect(f.calls.some((call) => isQuery("records", call.path))).toBe(false)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("single-parent body and relation changes invalidate only that derived node while old session locks survive", async () => {
    const f = nativeGraphFixture()
    const a = await prepare(f)
    expect(a.preparation_metrics?.derived_cache_misses).toBe(4)
    const before = derivedKeys(f)
    f.pages[0]!.last_edited_time = new Date(
      Date.parse(String(f.pages[0]!.last_edited_time)) + 1,
    ).toISOString()
    f.bodies.set(f.pageIds[0]!, "# Root version B\n")
    expire(f)
    f.clearCalls()
    const b = await prepare(f)
    expect(b.preparation_metrics?.derived_cache_misses).toBe(1)
    expect(b.preparation_metrics?.derived_cache_hits).toBe(3)
    expect(derivedKeys(f).filter((key) => !before.includes(key))).toHaveLength(1)
    expect(
      f.calls
        .filter((call) => /\/markdown$/u.test(endpoint(call.path) ?? ""))
        .map((call) => endpoint(call.path)),
    ).toEqual([`v1/pages/${f.pageIds[0]}/markdown`])
    f.clearCalls()
    const pinned = await prepare(f, {
      sessionBindings: a.session_bindings,
      freshness: { policy: "refresh" },
    })
    expect(pinned.graph_lock).toEqual(a.graph_lock)
    expect(f.calls).toHaveLength(0)
    property(f.pages[0]!.properties).requires = {
      id: "requires",
      type: "relation",
      relation: [{ id: f.pageIds[1] }],
      has_more: false,
    }
    f.pages[0]!.last_edited_time = new Date(
      Date.parse(String(f.pages[0]!.last_edited_time)) + 1,
    ).toISOString()
    expire(f)
    f.clearCalls()
    const c = await prepare(f)
    expect(c.usage.prepared_nodes).toBe(3)
    expect(c.preparation_metrics?.derived_cache_misses).toBe(1)
    expect(c.preparation_metrics?.derived_cache_hits).toBe(2)
    expect(f.readBodyCount()).toBe(1)
    expect(c.preparation_metrics!.root_ready_ms).toBeLessThanOrEqual(
      c.preparation_metrics!.required_ready_ms,
    )
    expect(c.preparation_metrics!.required_ready_ms).toBeLessThanOrEqual(
      c.preparation_metrics!.elapsed_ms,
    )
  })

  test("unselected body updates do not invalidate selected nodes or fetch unrelated bodies", async () => {
    const f = nativeGraphFixture()
    const before = await prepare(f)
    f.pages[4]!.last_edited_time = new Date(
      Date.parse(String(f.pages[4]!.last_edited_time)) + 1,
    ).toISOString()
    f.bodies.set(f.pageIds[4]!, "Optional body changed\n")
    expire(f)
    f.clearCalls()
    const after = await prepare(f)
    expect(after.graph_lock).toEqual(before.graph_lock)
    expect(after.preparation_metrics?.derived_cache_hits).toBe(4)
    expect(after.preparation_metrics?.derived_cache_misses).toBe(0)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("a failed identity observation does not become a complete graph or poison a later preparation", async () => {
    const f = nativeGraphFixture()
    f.pages.push(structuredClone(f.pages[0]!))
    const failed = await f.run(
      prepareGraph(
        { roots: [f.pageIds[0]!], purpose: "use" },
        { database: library.skills.database_id },
      ).pipe(Effect.result),
    )
    expect(failed._tag).toBe("Failure")
    if (failed._tag !== "Failure") throw new Error("Expected duplicate inventory rejection")
    expect(failed.failure.code).toBe("SHARED_GRAPH_METADATA_INVALID")
    expect(property(property(failed.failure.details).preparation).graph_lock).toBeUndefined()
    expect(f.writeCount()).toBe(0)
    expect(derivedKeys(f)).toEqual([])
    f.pages.pop()
    f.clearCalls()
    expect((await prepare(f)).usage.prepared_nodes).toBe(4)
    expect(f.calls.filter((call) => isQuery("skills", call.path))).toHaveLength(4)
  })

  test("a corrupt derived receipt is rejected without fetching or replacing its validated main", async () => {
    const f = nativeGraphFixture()
    await prepare(f, { purpose: "inspect" })
    const key = derivedKeys(f)[0]!
    const saved = { ...property(f.json.get(key)), output_sha256: "0".repeat(64) }
    f.json.set(key, saved)
    f.clearCalls()
    const result = await f.run(
      prepareGraph(
        { roots: [f.pageIds[0]!], purpose: "inspect" },
        { database: library.skills.database_id },
      ).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected corrupted derivation rejection")
    expect(result.failure.code).toBe("STATE_CORRUPT")
    expect(f.json.get(key)).toEqual(saved)
    expect(f.calls).toHaveLength(0)
  })

  test("equal owner batches use existing ref-counted pending reads without caching a cancelled producer", async () => {
    const f = nativeGraphFixture({ width: 0 })
    await f.run(
      Effect.gen(function* () {
        const coalescer = yield* makeSharedReadCoalescer()
        const gate = yield* Deferred.make<void>()
        let attempts = 0
        const api = yield* Notion
        const shared: Notion["Service"] = {
          ...api,
          request: (path, body, options) =>
            coalescer.run(
              { key: JSON.stringify(["scope", path, body]), path, method: "POST" },
              Effect.gen(function* () {
                attempts++
                yield* Deferred.await(gate)
                return { object: "list", results: [], has_more: false, next_cursor: null }
              }),
            ),
        }
        const read = queryCurrentFilesForSkills({
          dataSourceId: library.files.data_source_id,
          propertyIds: library.files.property_ids,
          skillPageIds: f.pageIds,
        }).pipe(Effect.provideService(Notion, shared))
        const first = yield* Effect.forkChild(read, { startImmediately: true })
        const second = yield* Effect.forkChild(read, { startImmediately: true })
        expect(attempts).toBe(1)
        yield* Fiber.interrupt(first)
        yield* Deferred.succeed(gate, undefined)
        expect((yield* Fiber.join(second)).get(f.pageIds[0]!)).toEqual([])
        expect(attempts).toBe(1)
        yield* read
        expect(attempts).toBe(2)
      }),
    )
  })

  test("cancelling an owner releases its pending complete-inventory producer without publishing a result", async () => {
    const f = nativeGraphFixture()
    let released = 0,
      completed = false
    await f.run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const api = yield* Notion
        const pending = withSharedGraphReads(sharedGraphInventory(f.descriptor), {
          scope: digest("cancelled-inventory"),
          currentRoots: [f.pageIds[0]!],
          purpose: "use",
          maxNodes: 64,
          maxDepth: 16,
        }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    released++
                  }),
                ),
              ),
          }),
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true
            }),
          ),
        )
        const fiber = yield* Effect.forkChild(pending, { startImmediately: true })
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(released).toBe(1)
    expect(completed).toBe(false)
    expect(derivedKeys(f)).toEqual([])
  })
})
