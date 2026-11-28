import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  currentSourceWriteProperties,
  queryCurrentSourceManagement,
} from "../src/shared-current-source-management.ts"
import { SourceManagerExecution } from "../src/shared-current-source-writer.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import { materializeRegisteredSource } from "../src/shared-source-materialization-management.ts"
import {
  decodeSourceMaterializationReceipt,
  type SourceMaterializationRequest,
} from "../src/shared-source-materialization-model.ts"
import {
  declaration,
  library,
  materializationFixture,
  sourceId,
} from "./shared-source-materialization-fixture.ts"

const root = mkdtempSync(join(tmpdir(), "source-materialization-receipt-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
})

test("an unchanged candidate returns the real current Source revision after another request made it ready", async () => {
  const f = await materializationFixture(root)
  const candidate = await f.request()
  const first = await f.materialize(candidate)
  expect(first.status).toBe("ready")
  const current = await f.run(queryCurrentSourceManagement(library, sourceId))
  if (current === undefined) throw new Error("Expected the actual current target Source")
  expect(current.state.state).toBe("ready")
  const preparations = f.preparedCount()
  f.clearCalls()
  const receipt = decodeSourceMaterializationReceipt(
    await f.materialize({ ...candidate, request_id: "another-session-same-candidate" }),
  )
  expect(receipt).toMatchObject({
    status: "already_ready",
    effects: { remote_writes: "none", projection: "none" },
  })
  expect(receipt.records.map((record) => record.locator)).toEqual(
    first.records.map((record) => record.locator),
  )
  expect(receipt.source_revisions).toEqual([{ source_id: sourceId, revision: current.revision }])
  expect(f.mutations()).toEqual([])
  expect(f.preparedCount()).toBe(preparations)
})

async function readyRootWithForeignRequired() {
  const f = await materializationFixture(root)
  expect((await f.materialize(await f.request("inspect"))).status).toBe("ready")
  const requiredSourceId = "materialization-required-source"
  const requiredSource = await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library.sources.data_source_id },
          properties: {
            ...currentSourceWriteProperties(library, {
              declaration: {
                ...declaration,
                definition: { ...declaration.definition, source_id: requiredSourceId },
              },
              content: f.full.prepared_source.content,
              revision: f.full.prepared_source.revision,
            }),
            [library.sources.property_ids.Content!]: { rich_text: [] },
            [library.sources.property_ids["Last Revision"]!]: { rich_text: [] },
            [library.sources.property_ids.Status!]: { select: { name: "ready" } },
            [library.sources.property_ids.Operation!]: { rich_text: [] },
          },
        },
        { method: "POST" },
      ),
    ),
  )
  const requiredSourcePage = String(property(requiredSource).id)
  await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        `v1/pages/${f.owners.get("required")}`,
        {
          properties: {
            [library.skills.property_ids.Origin!]: { relation: [{ id: requiredSourcePage }] },
          },
        },
        { method: "PATCH" },
      ),
    ),
  )
  return {
    ...f,
    requiredSourceId,
    requiredSourcePage,
    materialize: (request: SourceMaterializationRequest) =>
      f.runManaged(
        materializeRegisteredSource(library, request).pipe(
          Effect.provideService(SourceManagerExecution, {
            library_id: library.library_id,
            store_root: f.root,
            source_ids: [sourceId, requiredSourceId],
          }),
        ),
      ),
  }
}

test("a ready target Source remains in the receipt when only another Source's Requires is materialized", async () => {
  const f = await readyRootWithForeignRequired()
  const request = await f.request()
  const before = structuredClone(f.pages.get(f.sourcePage))
  const target = await f.run(queryCurrentSourceManagement(library, sourceId))
  if (target === undefined) throw new Error("Expected the actual current target Source")
  f.clearCalls()
  const receipt = decodeSourceMaterializationReceipt(await f.materialize(request))
  expect(receipt).toMatchObject({
    status: "ready",
    effects: { remote_writes: "management", projection: "none" },
  })
  const required = await f.run(queryCurrentSourceManagement(library, f.requiredSourceId))
  if (required === undefined) throw new Error("Expected the actual current required Source")
  expect(required.state.state).toBe("ready")
  expect(
    [...receipt.source_revisions].sort((a, b) => a.source_id.localeCompare(b.source_id)),
  ).toEqual(
    [
      { source_id: sourceId, revision: target.revision },
      { source_id: f.requiredSourceId, revision: required.revision },
    ].sort((a, b) => a.source_id.localeCompare(b.source_id)),
  )
  expect(receipt.records.map((record) => record.name).sort()).toEqual(["required", "root"])
  expect(f.pages.get(f.sourcePage)).toEqual(before)
  expect(f.mutations().filter((call) => call.path === `v1/pages/${f.sourcePage}`)).toEqual([])
  expect(f.mutations().some((call) => call.path === `v1/pages/${f.requiredSourcePage}`)).toBe(true)
})

test("a Source revision that disagrees with current content cannot produce an already-ready receipt", async () => {
  const f = await materializationFixture(root)
  const request = await f.request()
  expect((await f.materialize(request)).status).toBe("ready")
  let sourceQueries = 0
  let corruptedReadback = false
  f.rewrite((path, response) => {
    if (path !== `v1/data_sources/${library.sources.data_source_id}/query`) return response
    sourceQueries++
    if (sourceQueries !== 2) return response
    const changed = structuredClone(response)
    const rows = changed.results
    if (!Array.isArray(rows)) throw new Error("Expected actual Source query results")
    const target = rows.find((row) => property(row).id === f.sourcePage)
    if (target === undefined) throw new Error("Expected the exact Source owner")
    const props = property(property(target).properties)
    const revision = library.sources.property_ids["Last Revision"]!
    props[revision] = { ...property(props[revision]), rich_text: sourceRich("f".repeat(64)) }
    corruptedReadback = true
    return changed
  })
  f.clearCalls()
  const receipt = await f.materialize({ ...request, request_id: "readback-conflict" })
  expect(corruptedReadback).toBe(true)
  expect(receipt).toMatchObject({
    status: "blocked",
    reason: "SHARED_SOURCE_CONFLICT",
    records: [],
    source_revisions: [],
  })
  expect(f.mutations()).toEqual([])
})

test("the public receipt decoder rejects success without its target Source revision while preserving pending results", async () => {
  const f = await materializationFixture(root)
  const request = await f.request()
  const ready = await f.materialize(request)
  const already = await f.materialize({ ...request, request_id: "receipt-decoder-noop" })
  expect(ready.status).toBe("ready")
  expect(already.status).toBe("already_ready")
  for (const receipt of [ready, already]) {
    expect(decodeSourceMaterializationReceipt(receipt)).toEqual(receipt)
    for (const source_revisions of [
      [],
      [{ source_id: "another-source", revision: receipt.source_revisions[0]!.revision }],
    ])
      expect(() => decodeSourceMaterializationReceipt({ ...receipt, source_revisions })).toThrow()
  }
  for (const status of ["pending", "blocked"] as const) {
    const receipt = { ...ready, status, records: [], source_revisions: [] }
    expect(decodeSourceMaterializationReceipt(receipt)).toEqual(receipt)
  }
})
