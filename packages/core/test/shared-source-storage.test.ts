import { expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ChildProcessSpawner } from "effect/process"
import { HttpClient } from "effect/http"
import { Store } from "../src/store.ts"
import { Notion } from "../src/notion.ts"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sourceMemberStorageDecision } from "../src/shared-source-member.ts"
import {
  reviewSourceStorage,
  prepareSourceStorageAlignment,
  applySourceStorageAlignment,
  reconcileSourceStorageAlignment,
} from "../src/shared-source-storage.ts"
import { executeSharedCreate } from "../src/shared-create.ts"
import {
  readSourceDefinition,
  sourceDefinitionPropertiesFor,
} from "../src/shared-source-definitions.ts"
import { prepareSharedSourceProjection } from "../src/shared-source-projection.ts"
import { resolveSelectedSharedSourceReference } from "../src/shared-selected-source.ts"
import { querySharedRecords, canonicalSharedJson } from "../src/shared-records.ts"
import { withSharedAuthoringTarget } from "../src/shared-authoring-context.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { authScope } from "../src/catalog.ts"
import { property, fail, text } from "../src/model.ts"
import { fixture, input, library, ids } from "./shared-source-projection-fixture.ts"
import { rich } from "./shared-snapshot-fixture.ts"
const skillPropertyIds: Readonly<Record<string, string>> = library.skills.property_ids

test("external-first policy does not authorize a complete Notion archive on transformation or missing transport", () => {
  const f = fixture(),
    source = f.snapshot,
    member = source.members[0]!
  expect(sourceMemberStorageDecision(input, source, member.member_key)).toMatchObject({
    kind: "fixed_git",
    byte_copy_authorized: false,
  })
  expect(
    sourceMemberStorageDecision(
      { ...input, options: { storage: "retained" } },
      source,
      member.member_key,
    ),
  ).toMatchObject({ kind: "retained", reason: "explicit_retention" })
  expect(
    sourceMemberStorageDecision(
      { ...input, options: { storage: "retained" } },
      source,
      member.member_key,
      "fixed-git",
    ),
  ).toMatchObject({ kind: "fixed_git" })
  const changed = { ...source, members: [{ ...member, patch_hash: "a".repeat(64) }] }
  expect(sourceMemberStorageDecision(input, changed, member.member_key)).toMatchObject({
    kind: "blocked",
    reason: "transformed_member",
    byte_copy_authorized: false,
  })
  expect(sourceMemberStorageDecision(input, changed, member.member_key, "retained")).toMatchObject({
    kind: "retained",
    byte_copy_authorized: true,
  })
  const { git_manifest: _manifest, ...withoutManifest } = member
  expect(
    sourceMemberStorageDecision(
      input,
      { ...source, members: [withoutManifest] },
      member.member_key,
    ),
  ).toMatchObject({ kind: "blocked", reason: "fixed_manifest_missing" })
  expect(() =>
    sourceMemberStorageDecision(
      { ...input, options: { storage: "silently-copy" } },
      source,
      member.member_key,
    ),
  ).toThrow()
})

test("storage roster rejects a multi-Source onboarding scope without inventing a partial storage inventory", async () => {
  const f = fixture()
  await expect(
    f.run(
      reviewSourceStorage({
        entry: library.skills.database_id,
        scope: { kind: "sources", sources: [f.source.id, "another-source"] },
      }),
    ),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
  expect(f.writes()).toHaveLength(0)
})

async function retained() {
  const f = fixture([], { markdownImport: true, recovery: true })
  for (const row of f.skills.values()) {
    const properties = property(row.properties)
    properties.origin = { id: "origin", type: "relation", relation: [], has_more: false }
    properties.source_member = rich("source_member", "")
  }
  const root = mkdtempSync(join(tmpdir(), "source-storage-alignment-"))
  let lostSelection: boolean | undefined
  const run = <A, E>(
    action: Effect.Effect<
      A,
      E,
      | Store
      | Notion
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | HttpClient.HttpClient
      | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
    f.run(
      Effect.gen(function* () {
        const store = yield* Store,
          api = yield* Notion
        const metadata: Notion["Service"] = {
          ...api,
          request: (path, body, options) =>
            Effect.suspend(() => {
              const target = f.skills.get(path.replace(/^v1\/pages\//u, "")),
                changes = property(property(body).properties)
              const record = [...f.base.records.values()].find(
                (row) => path === `v1/pages/${row.id}`,
              )
              if (
                record !== undefined &&
                options?.method === "PATCH" &&
                Object.keys(changes).join(",") === library.records.property_ids.Origin
              ) {
                f.calls.push({ path, method: "PATCH", body })
                const id = library.records.property_ids.Origin!
                property(record.properties)[id] = {
                  id,
                  type: "relation",
                  ...property(changes[id]),
                  has_more: false,
                }
                return Effect.succeed(structuredClone(record))
              }
              if (
                target !== undefined &&
                options?.method === "PATCH" &&
                Object.keys(changes).join(",") === skillPropertyIds.Source
              ) {
                const planned = [...f.base.records.values()].some((row) => {
                  const kind = property(property(row.properties).kind).select
                  return property(kind).name === "operation"
                })
                if (!planned)
                  return Effect.fail(
                    fail(
                      "TEST_METADATA_ORDER",
                      "A source selection must use the real metadata journal first.",
                    ),
                  )
                f.calls.push({ path, method: "PATCH", body })
                const props = property(target.properties),
                  id = skillPropertyIds.Source!
                const lost = lostSelection
                lostSelection = undefined
                if (lost !== false) props[id] = { id, type: "rich_text", ...property(changes[id]) }
                if (lost !== undefined)
                  return Effect.fail(
                    fail(
                      "WRITE_OUTCOME_UNKNOWN",
                      "Controlled original source selection response lost.",
                    ),
                  )
                return Effect.succeed(structuredClone(target))
              }
              return api.request(path, body, options)
            }),
        }
        return yield* action.pipe(
          Effect.provideService(Store, { ...store, root }),
          Effect.provideService(Notion, metadata),
          Effect.provide(NodeServices.layer),
        )
      }),
    )
  const plan = await run(
    Effect.gen(function* () {
      return yield* prepareSharedSourceProjection({
        library,
        definition: yield* readSourceDefinition(library, f.source.id),
        acquired: f.snapshot,
        member: "skills/demo",
        skillId: "storage-alignment-original",
        enabled: false,
        markdownImport: true,
        storage: "retained",
      })
    }),
  )
  const created = await run(executeSharedCreate(library, { plan, mode: "create" }))
  expect(created.verified).toBe(true)
  f.clear()
  return {
    ...f,
    run,
    plan,
    page: created.skill_page_id,
    loseSelection: (visible: boolean) => {
      lostSelection = visible
    },
  }
}

test.each([false, true])(
  "an unknown original storage selection visible=%s is not replayed or accepted from current equality",
  async (visible) => {
    const f = await retained(),
      prepared = await f.run(
        prepareSourceStorageAlignment(
          { entry: library.skills.database_id, source: f.source.id, target: f.page },
          () => Effect.succeed(f.snapshot),
        ),
      )
    if (prepared.status !== "prepared") throw new Error("Expected a frozen exact storage plan")
    f.loseSelection(visible)
    await expect(f.run(applySourceStorageAlignment({ plan: prepared.plan }))).rejects.toBeDefined()
    expect(
      f.calls.filter((call) => call.method === "PATCH" && call.path === `v1/pages/${f.page}`),
    ).toHaveLength(1)
    f.clear()
    await expect(f.run(applySourceStorageAlignment({ plan: prepared.plan }))).rejects.toBeDefined()
    await expect(
      f.run(reconcileSourceStorageAlignment({ plan: prepared.plan })),
    ).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
  },
)

test("human takeover survives exact source storage replacement without a body rewrite", async () => {
  const f = await retained()
  const document = [...f.files.values()].find(
    (row) => text(property(property(row.properties).path).rich_text) === "references/a.md",
  )!
  const body = "# Human-owned guide\n\nThis custom instruction must stay.\n"
  f.base.bodies.set(String(document.id), body)
  await f.run(
    withSharedAuthoringTarget(
      f.page,
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: f.page,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
        })
      }),
    ),
  )
  f.clear()
  const prepared = await f.run(
    prepareSourceStorageAlignment(
      { entry: library.skills.database_id, source: f.source.id, target: f.page },
      () => Effect.succeed(f.snapshot),
    ),
  )
  if (prepared.status !== "prepared") throw new Error("Expected original source migration")
  expect(prepared.plan.refresh.custom_files_preserved).toContain("references/a.md")
  expect(f.writes()).toHaveLength(0)
  expect((await f.run(applySourceStorageAlignment({ plan: prepared.plan }))).result).toMatchObject({
    verified: true,
    body_writes: 0,
  })
  expect(f.base.bodies.get(String(document.id))).toBe(body)
  f.clear()
  const consumed = await f.run(
    withSharedAuthoringTarget(
      f.page,
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: f.page,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly: true,
        })
      }),
    ),
  )
  const file = consumed.files.find((file) => file.path === "references/a.md")!
  expect(new TextDecoder().decode(f.base.objects.get("objects/" + file.sha256)!)).toBe(body)
  expect(f.writes()).toHaveLength(0)
})

test("same-revision alignment preserves disabled original pages, bodies, old retained versions and adds no byte objects", async () => {
  const f = await retained()
  const beforeBodies = new Map(f.base.bodies),
    oldFacts = await f.run(querySharedRecords(library, { skillPageId: f.page })),
    requests: unknown[] = []
  const prepared = await f.run(
    prepareSourceStorageAlignment(
      { entry: library.skills.database_id, source: f.source.id, target: f.page },
      (definition) => {
        requests.push(definition)
        return Effect.succeed(f.snapshot)
      },
    ),
  )
  if (prepared.status !== "prepared") throw new Error("Expected actual storage replacement")
  expect(prepared.plan.refresh.version).toBe(4)
  expect(prepared.plan.original_revision).toBe(f.snapshot.revision)
  expect(property(property(requests[0]).adapter).ref).toBe(f.snapshot.revision)
  expect(prepared.new_archive_bytes).toBe(0)
  expect(f.writes()).toHaveLength(0)
  const preview = await f.run(applySourceStorageAlignment({ plan: prepared.plan, dryRun: true }))
  expect(preview.result).toMatchObject({ dry_run: true, notion_writes: 0 })
  expect(f.writes()).toHaveLength(0)
  const result = await f.run(applySourceStorageAlignment({ plan: prepared.plan }))
  expect(result.result).toMatchObject({ status: "applied", verified: true, body_writes: 0 })
  expect(f.base.bodies).toEqual(beforeBodies)
  expect(property(property(f.skills.get(f.page)!.properties).enabled).checkbox).toBe(false)
  const afterFacts = await f.run(querySharedRecords(library, { skillPageId: f.page }))
  expect(
    afterFacts
      .filter((row) => row.kind === "object")
      .map((row) => row.hash)
      .sort(),
  ).toEqual(
    oldFacts
      .filter((row) => row.kind === "object")
      .map((row) => row.hash)
      .sort(),
  )
  for (const row of oldFacts)
    expect(afterFacts.find((candidate) => candidate.record_id === row.record_id)).toEqual(row)
  f.clear()
  expect(
    (await f.run(reconcileSourceStorageAlignment({ plan: prepared.plan }))).remote_writes,
  ).toBe(0)
  expect((await f.run(applySourceStorageAlignment({ plan: prepared.plan }))).result).toMatchObject({
    verified: true,
  })
  expect(f.writes()).toHaveLength(0)
  const selected = await f.run(
    resolveSelectedSharedSourceReference(library, {
      skillPageId: f.page,
      sourceId: prepared.plan.refresh.version === 4 ? prepared.plan.refresh.source_pin : "",
    }),
  )
  expect(selected.kind).toBe("git")
  const original = await f.run(
    resolveSelectedSharedSourceReference(library, {
      skillPageId: f.page,
      sourceId: prepared.plan.original_source_id,
    }),
  )
  expect(original.kind).toBe("retained_bundle")
  const cold = await f.run(
    withSharedAuthoringTarget(
      f.page,
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: f.page,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly: true,
        })
      }),
    ),
  )
  expect(cold.files.map((file) => file.path)).toContain("scripts/run.js")
  expect(canonicalSharedJson(f.plan)).toContain('"version":2')
})

test("same-version migration rejects actual upstream byte differences and a changed Enabled state", async () => {
  const f = await retained()
  const changed = {
    ...f.snapshot,
    members: f.snapshot.members.map((member) => ({
      ...member,
      portable: {
        ...member.portable,
        files: member.portable.files.map((file) =>
          file.path === "scripts/run.js"
            ? { ...file, bytes: new TextEncoder().encode("different source") }
            : file,
        ),
      },
    })),
  }
  await expect(
    f.run(
      prepareSourceStorageAlignment(
        { entry: library.skills.database_id, source: f.source.id, target: f.page },
        () => Effect.succeed(changed),
      ),
    ),
  ).rejects.toMatchObject({ code: "SOURCE_STORAGE_CONTENT_DIFFERS" })
  const prepared = await f.run(
    prepareSourceStorageAlignment(
      { entry: library.skills.database_id, source: f.source.id, target: f.page },
      () => Effect.succeed(f.snapshot),
    ),
  )
  if (prepared.status !== "prepared") throw new Error("Expected plan")
  property(property(f.skills.get(f.page)!.properties).enabled).checkbox = true
  f.clear()
  await expect(f.run(applySourceStorageAlignment({ plan: prepared.plan }))).rejects.toMatchObject({
    code: "SOURCE_STORAGE_GOVERNANCE_CHANGED",
  })
  expect(f.writes()).toHaveLength(0)
})

test("a source-level explicit retained choice is not silently undone by storage alignment", async () => {
  const f = await retained()
  f.source.properties[ids.Options!] = {
    ...property(f.source.properties[ids.Options!]),
    ...property(
      sourceDefinitionPropertiesFor(library, { ...input, options: { storage: "retained" } })[
        ids.Options!
      ],
    ),
  }
  f.clear()
  let acquired = false
  await expect(
    f.run(
      prepareSourceStorageAlignment(
        { entry: library.skills.database_id, source: f.source.id, target: f.page },
        () => {
          acquired = true
          return Effect.succeed(f.snapshot)
        },
      ),
    ),
  ).rejects.toMatchObject({ code: "SOURCE_STORAGE_EXPLICIT_RETENTION" })
  expect(acquired).toBe(false)
  expect(f.writes()).toHaveLength(0)
})
