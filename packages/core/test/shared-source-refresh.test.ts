import { makeSharedMetadataWritePlan } from "../src/shared-metadata-write-model.ts"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property, text } from "../src/model.ts"
import {
  prepareSourceRefresh,
  applySourceRefresh,
  validateSourceRefresh,
  reconcileSourceRefresh,
} from "../src/shared-source-refresh.ts"
import { resolveSelectedSharedSource } from "../src/shared-selected-source.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { authScope } from "../src/catalog.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { id, skillPage, rich, digest } from "./shared-snapshot-fixture.ts"

import {
  library,
  sourceIds,
  sourceRefreshFixture as fixture,
} from "./shared-source-refresh-fixture.ts"
test("prepare freezes a complete provider member with binary assets without writes or hypothetical current cache", async () => {
  const f = await fixture()
  f.clearCalls()
  const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  expect(plan.custom_files_preserved).toHaveLength(2)
  expect(plan.bundle.files).toHaveLength(3)
  expect(plan.projected_files.map((x) => x.path)).toContain("assets/file.bin")
  expect(f.writeCount()).toBe(0)
  expect(text(property(property(f.main.properties).source).rich_text)).toBe("")
  expect(f.acquisitions()).toBe(1)
  const validated = await f.run(validateSourceRefresh(library, plan))
  expect(validated.files.find((x) => x.path === "assets/file.bin")?.bytes).toEqual(
    new Uint8Array([0, 255, 3, 128]),
  )
})
test("dry-run validates full preserved custom tree and writes no facts, native bodies or pin", async () => {
  const f = await fixture()
  const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  f.clearCalls()
  expect(await f.run(applySourceRefresh(library, plan, true))).toMatchObject({
    status: "planned",
    notion_writes: 0,
  })
  expect(f.writeCount()).toBe(0)
  expect(f.calls.some((x) => x.method === "PATCH")).toBe(false)
})
test("apply retains exact resources then selects source while preserving custom bytes and old snapshots", async () => {
  const f = await fixture()
  const bodies = new Map(f.bodies),
    old = [...f.json].filter(([key]) => key.startsWith("snapshots/"))
  const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  f.clearCalls()
  const applied = await f.run(applySourceRefresh(library, plan))
  expect(applied).toMatchObject({
    status: "applied",
    verified: true,
    body_writes: 0,
    source_pin: plan.bundle_id,
  })
  expect(f.bodies).toEqual(bodies)
  const selected = await f.run(resolveSelectedSharedSource(library, skillPage, plan.bundle_id))
  expect(selected.files).toHaveLength(3)
  const current = await f.run(
    Effect.gen(function* () {
      return yield* openSharedSnapshot({
        library,
        target: skillPage,
        scope: yield* authScope,
        startedAt: Date.now(),
        fixedSource: {
          source_id: selected.source_id,
          revision: selected.revision,
          files: selected.files,
        },
      })
    }),
  )
  expect(current.files).toEqual(plan.projected_files)
  for (const [key, value] of old) expect(f.json.get(key)).toEqual(value)
  expect(f.calls.filter((x) => x.method === "PATCH" && x.path.endsWith("/markdown"))).toHaveLength(
    0,
  )
  const writes = f.writeCount()
  expect(await f.run(applySourceRefresh(library, plan))).toMatchObject({
    status: "already_selected",
  })
  expect(f.writeCount()).toBe(writes)
})
test("definition drift, source-member drift and tampered frozen bytes fail before writes", async () => {
  const f = await fixture()
  const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  f.clearCalls()
  await expect(
    f.run(applySourceRefresh(library, { ...plan, archive_base64: "AAAA" })),
  ).rejects.toThrow("identity")
  f.source.properties[sourceIds.Description!] = rich(sourceIds.Description!, "changed definition")
  await expect(f.run(applySourceRefresh(library, plan))).rejects.toThrow("definition changed")
  expect(f.writeCount()).toBe(0)
})
test("custom body changes after preparation stop source selection rather than overwrite them", async () => {
  const f = await fixture()
  const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  f.clearCalls()
  f.bodies.set(skillPage, "A concurrent native edit that must win.\n")
  await expect(f.run(applySourceRefresh(library, plan))).rejects.toThrow()
  expect(text(property(property(f.main.properties).source).rich_text)).toBe("")
  expect(f.writeCount()).toBe(0)
})
test("unknown resource chunk create preserves the original dispatch and never selects partial content", async () => {
  const f = await fixture()
  const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  f.clearCalls()
  f.unknownRecord("object", false)
  await expect(f.run(applySourceRefresh(library, plan))).rejects.toThrow()
  const writes = f.writeCount()
  await expect(f.run(applySourceRefresh(library, plan))).rejects.toThrow()
  expect(f.writeCount()).toBe(writes)
  expect(text(property(property(f.main.properties).source).rich_text)).toBe("")
})

test("a new preparation of the already selected exact provider tree is verified without remote mutations", async () => {
  const f = await fixture(),
    first = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  await f.run(applySourceRefresh(library, first))
  const next = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  expect(next.bundle_id).toBe(next.previous_pin)
  f.clearCalls()
  expect(await f.run(applySourceRefresh(library, next))).toMatchObject({
    status: "unchanged",
    verified: true,
    remote_writes: 0,
  })
  expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
})
test("reconcile reads the original shared selection and never retries writes", async () => {
  const f = await fixture(),
    plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  await f.run(applySourceRefresh(library, plan))
  for (const key of [...f.json.keys()]) if (key.includes("/source-selection-")) f.json.delete(key)
  f.clearCalls()
  const result = await f.run(reconcileSourceRefresh(library, plan))
  expect(result).toMatchObject({
    remote_writes: 0,
    current_snapshot_verified: false,
    requires_fresh_read: true,
  })
  expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
})
test("a rehashed proposal with a corrupted chunk identity fails before any source mutation", async () => {
  const f = await fixture(),
    plan = structuredClone(await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire)))
  const corrupt = "e".repeat(64)
  const changed = {
    ...plan,
    bundle: {
      ...plan.bundle,
      archive: {
        ...plan.bundle.archive,
        chunks: [
          { ...plan.bundle.archive.chunks[0]!, sha256: corrupt, object_id: `chunk-${corrupt}` },
        ],
      },
    },
  }
  changed.bundle_id = `bundle-${digest(canonicalSharedJson(changed.bundle))}`
  const {
    version: _version,
    kind: _kind,
    operation_id: _operation,
    ...originalSelection
  } = changed.selection!
  changed.selection = await f.run(
    makeSharedMetadataWritePlan({
      ...originalSelection,
      changes: originalSelection.changes.map((change) => ({ ...change, after: changed.bundle_id })),
    }),
  )
  const { plan_id: _old, ...body } = changed
  changed.plan_id = `source-refresh-${digest(canonicalSharedJson(body))}`
  f.clearCalls()
  await expect(f.run(applySourceRefresh(library, changed))).rejects.toThrow("chunk identity")
  expect(f.calls).toHaveLength(0)
})
