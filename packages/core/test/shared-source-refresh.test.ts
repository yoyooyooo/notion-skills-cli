import { makeSharedMetadataWritePlan } from "../src/shared-metadata-write-model.ts"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Notion } from "../src/notion.ts"
import { property, text, fail, SkillsError } from "../src/model.ts"
import { sourceDefinitionPropertiesFor } from "../src/shared-source-definitions.ts"
import { sourceDefinitionLayout, type SourceDefinitionInput } from "../src/shared-sources-model.ts"
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
import {
  library as base,
  sharedSnapshotFixture,
  id,
  skillPage,
  rich,
  digest,
} from "./shared-snapshot-fixture.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"
import { Store } from "../src/store.ts"

const layout = sourceDefinitionLayout(base.skills.data_source_id, base.records.data_source_id),
  sourceIds = Object.fromEntries(
    Object.keys(layout).map((name, index) => [name, name === "Name" ? "title" : `s${index}`]),
  )
const library = {
  ...base,
  skills: {
    ...base.skills,
    property_ids: {
      ...base.skills.property_ids,
      Origin: "origin",
      "Source Member": "source_member",
    },
  },
  records: { ...base.records, property_ids: { ...base.records.property_ids, Origin: "origin" } },
  sources: { database_id: id(80), data_source_id: id(81), property_ids: sourceIds },
}
const definition: SourceDefinitionInput = {
  version: 1,
  source_id: "refresh-source",
  name: "Source name",
  description: "Upstream description",
  enabled: true,
  policy: "manual",
  adapter: { type: "git", url: "https://gitlab.com/org/repo.git", ref: "main" },
  selection: { roots: ["skills/demo"], include: [], exclude: [], mapping: {} },
  options: {},
}
const encode = (s: string) => new TextEncoder().encode(s)
async function fixture() {
  const f = sharedSnapshotFixture({ fileCount: 2 })
  await f.open()
  const p = property(f.main.properties)
  p.origin = { id: "origin", type: "relation", relation: [{ id: id(82) }], has_more: false }
  p.source_member = rich("source_member", "skills/demo")
  const props = sourceDefinitionPropertiesFor(library, definition),
    properties: Record<string, unknown> = {}
  for (const [name, shape] of Object.entries(layout)) {
    const key = sourceIds[name]!,
      type = Object.keys(shape)[0]!
    properties[key] = {
      id: key,
      type,
      ...(props[key] ??
        (type === "rich_text"
          ? { rich_text: [] }
          : type === "select"
            ? { select: null }
            : type === "relation"
              ? { relation: [], has_more: false }
              : { date: null })),
    }
  }
  const source = {
    object: "page",
    id: id(82),
    parent: { data_source_id: library.sources.data_source_id },
    in_trash: false,
    properties,
  }
  const snapshot: SourceSnapshot = {
    revision: "a".repeat(40),
    provenance: { provider: "git" },
    members: [
      {
        member_key: "skills/demo",
        source_path: "skills/demo",
        upstream_hash: "a".repeat(64),
        content_hash: "b".repeat(64),
        portable: {
          kind: "skill",
          name: "Source name",
          description: "Upstream description",
          main: "SKILL.md",
          files: [
            {
              path: "SKILL.md",
              bytes: encode(
                "---\nname: source\ndescription: upstream\nlicense: MIT\n---\n\nReplacement that must not overwrite custom main.\n",
              ),
            },
            {
              path: "references/1.md",
              bytes: encode("New upstream guide that must not replace custom body.\n"),
            },
            { path: "assets/file.bin", bytes: new Uint8Array([0, 255, 3, 128]) },
          ],
        },
      },
    ],
  }
  let acquisitions = 0
  const acquire = () => {
    acquisitions++
    return Effect.succeed(structuredClone(snapshot))
  }
  const run = <A, E, R>(action: Effect.Effect<A, E, R>) =>
    f.run(
      Effect.gen(function* () {
        const original = yield* Notion
        const api: Notion["Service"] = {
          ...original,
          request: (path, body, options) =>
            Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
              const method = options?.method ?? (body ? "POST" : "GET"),
                row =
                  path === `v1/pages/${source.id}`
                    ? source
                    : path === `v1/pages/${skillPage}`
                      ? f.main
                      : [...f.records.values()].find((r) => path === `v1/pages/${r.id}`)
              if (path === `v1/databases/${base.skills.database_id}`)
                return original.request(path, body, options).pipe(
                  Effect.map((raw) => ({
                    ...property(raw),
                    description: [
                      { plain_text: "ntn-skills-library:v1 " + JSON.stringify(library) },
                    ],
                  })),
                )
              if (path === `v1/pages/${source.id}` && method === "GET")
                return Effect.succeed(structuredClone(source))
              if (row && method === "PATCH") {
                f.calls.push({ path, body, method })
                const fields = property(row.properties)
                for (const [key, value] of Object.entries(property(property(body).properties))) {
                  const prior = property(fields[key])
                  fields[key] = {
                    ...prior,
                    id: key,
                    type: prior.type ?? Object.keys(property(value))[0],
                    ...property(value),
                    ...(property(value).relation ? { has_more: false } : {}),
                  }
                }
                return Effect.succeed(structuredClone(row))
              }
              if (row && f.records.has(String(row.id)) && method === "GET")
                return Effect.succeed(structuredClone(row))
              return original.request(path, body, options)
            }),
        }
        return yield* action.pipe(Effect.provideService(Notion, api))
      }).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A, E, Store | Notion>,
    )
  return { ...f, run, source, snapshot, acquire, acquisitions: () => acquisitions }
}
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
