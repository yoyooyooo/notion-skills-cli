import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { prepareGraph } from "../src/graph-prepare.ts"
import { sharedGraphInventory, withSharedGraphReads } from "../src/shared-graph-read-context.ts"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { querySharedOperationIndexes } from "../src/shared-operation-index.ts"
import { querySharedFileFactsForSkills } from "../src/shared-records.ts"
import { makeSharedReadCoalescer } from "../src/shared-read-coalescing.ts"
import { querySkillFilesForSkills } from "../src/skill-file-index.ts"
import { nativeGraphFixture } from "./graph-prepare-live-fixture.ts"
import { digest, library, rich } from "./shared-snapshot-fixture.ts"

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
const entityIds = (filter: unknown): string[] => {
  const value = property(filter)
  if (Array.isArray(value.and)) return value.and.flatMap(entityIds)
  if (Array.isArray(value.or)) return value.or.flatMap(entityIds)
  const entity = property(value.rich_text).equals
  return value.property === "entity" && typeof entity === "string" ? [entity] : []
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

describe("library-scoped graph metadata batches", () => {
  test("batching preserves owner-scoped File IDs while duplicate physical pages remain invalid", async () => {
    const f = nativeGraphFixture({ width: 1, filesPerSkill: 1 })
    for (const file of f.files) file.properties.file_id = rich("file_id", "same-local-file")
    const read = () =>
      querySkillFilesForSkills({
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
    expect(duplicate.failure.code).toBe("INVALID_FILE_INDEX")
  })
  test("101 selected owners are sliced at 80 while every File keeps its exact owner", async () => {
    const f = nativeGraphFixture({ width: 100, filesPerSkill: 1 })
    const files = await f.run(
      querySkillFilesForSkills({
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
      querySkillFilesForSkills({
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

  test("complete ownership discovery survives 101 Entity IDs and warm payload reuse reads only metadata", async () => {
    const f = nativeGraphFixture({ width: 100 })
    for (let index = 0; index < 101; index++) {
      f.seedFact({ fact: index }, "file_event", `file-${index}`, `event-${index}`)
      const row = [...f.records.values()].at(-1)!
      property(row.properties).skill = {
        id: "skill",
        type: "relation",
        relation: [{ id: f.pageIds[index] }],
        has_more: false,
      }
    }
    const selected = () =>
      querySharedFileFactsForSkills(library, f.pageIds, digest("graph-batch-scope"))
    const first = await f.run(selected())
    expect([...first.values()].flat()).toHaveLength(101)
    const payloadQueries = f.calls.filter((call) =>
      new URL(call.path, "https://fixture.invalid").searchParams
        .getAll("filter_properties")
        .includes("payload"),
    )
    expect(payloadQueries.map((call) => entityIds(property(call.body).filter).length)).toEqual([
      80, 21,
    ])
    for (const call of f.calls)
      expect(ownerIds(property(call.body).filter).length).toBeLessThanOrEqual(80)
    f.clearCalls()
    expect(await f.run(selected())).toEqual(first)
    expect(f.calls).toHaveLength(2)
    expect(
      f.calls.every(
        (call) =>
          !new URL(call.path, "https://fixture.invalid").searchParams
            .getAll("filter_properties")
            .includes("payload"),
      ),
    ).toBe(true)
  })

  test("a single owner's 101 event payloads page metadata and slice exact missing Entity sets", async () => {
    const f = nativeGraphFixture({ width: 0 })
    for (let index = 0; index < 101; index++)
      f.seedFact({ fact: index }, "file_event", `file-${index}`, `event-${index}`)
    const records = await f.run(
      querySharedFileFactsForSkills(library, f.pageIds, digest("one-owner")),
    )
    expect([...records.values()].flat()).toHaveLength(101)
    expect(f.calls).toHaveLength(4)
    expect(f.calls.map((call) => entityIds(property(call.body).filter).length)).toEqual([
      0, 0, 80, 21,
    ])
  })

  test("identical Record IDs in different owners remain separate facts and operation headers", async () => {
    const f = nativeGraphFixture({ width: 1 })
    for (const owner of f.pageIds) {
      f.seedFact({ fact: owner }, "file_event", "same-entity", "same-record")
      property([...f.records.values()].at(-1)!.properties).skill = {
        id: "skill",
        type: "relation",
        relation: [{ id: owner }],
        has_more: false,
      }
    }
    const records = await f.run(
      querySharedFileFactsForSkills(library, f.pageIds, digest("owner-domain")),
    )
    for (const owner of f.pageIds) expect(records.get(owner)).toHaveLength(1)
    for (const row of f.records.values())
      property(row.properties).kind = { id: "kind", type: "select", select: { name: "operation" } }
    const operations = await f.run(querySharedOperationIndexes(library, f.pageIds))
    for (const owner of f.pageIds) expect(operations.get(owner)).toHaveLength(1)
  })

  test("one inventory covers multi-root diamond metadata and inspect does not batch Required Files", async () => {
    const f = nativeGraphFixture()
    const result = await prepare(f, { roots: [f.pageIds[0]!, f.pageIds[2]!] })
    expect(result.usage.prepared_nodes).toBe(4)
    expect(f.calls.filter((call) => isQuery("skills", call.path))).toHaveLength(1)
    expect(f.calls.filter((call) => isQuery("files", call.path))).toHaveLength(2)
    expect(
      f.calls
        .filter((call) => isQuery("files", call.path))
        .flatMap((call) => ownerIds(property(call.body).filter)),
    ).not.toContain(f.pageIds[4])
    const g = nativeGraphFixture()
    await prepare(g, { purpose: "inspect" })
    const inspected = g.calls.filter((call) => isQuery("files", call.path))
    expect(inspected).toHaveLength(1)
    expect(ownerIds(property(inspected[0]!.body).filter)).toEqual([g.pageIds[0]!])
  })

  test("25 inline Requires, 101 complete relations and 102 inventory nodes remain complete", async () => {
    const f = nativeGraphFixture({ width: 101 })
    const result = await prepare(f, { budget: { maxNodes: 128, maxContextBytes: 8 * 1024 * 1024 } })
    expect(result.required_closure).toHaveLength(102)
    expect(f.calls.filter((call) => isQuery("skills", call.path))).toHaveLength(2)
    expect(f.calls.filter((call) => /\/properties\/requires/u.test(call.path))).toHaveLength(2)
    expect(
      f.calls
        .filter((call) => isQuery("files", call.path))
        .map((call) => ownerIds(property(call.body).filter).length),
    ).toEqual([80, 22])
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
      expect(files).toHaveLength(1)
      expect(ownerIds(property(files[0]!.body).filter)).toEqual([f.pageIds[0]!])
      expect(f.readBodyCount()).toBe(1)
    }
  })

  test("an orphan fact is still found after a supporting File binding disappears", async () => {
    const f = nativeGraphFixture({ filesPerSkill: 1 })
    await prepare(f, { purpose: "inspect" })
    f.files.splice(0, 1)
    expire(f)
    f.clearCalls()
    const result = await f.run(
      prepareGraph(
        { roots: [f.pageIds[0]!], purpose: "inspect" },
        { database: library.skills.database_id },
      ).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected unbound state")
    expect(result.failure.code).toBe("UNBOUND_FILE_STATE")
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
    expect(f.calls.map((call) => call.path)).toEqual(["v1/users/me"])
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

  test("a failed inventory does not become a complete observation or poison a later preparation", async () => {
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
    expect(f.calls.filter((call) => isQuery("skills", call.path))).toHaveLength(1)
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
    expect(f.calls.map((call) => call.path)).toEqual(["v1/users/me"])
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
        const read = querySkillFilesForSkills({
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
