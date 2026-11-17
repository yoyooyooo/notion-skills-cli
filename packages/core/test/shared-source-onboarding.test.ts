import { expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path, Schema } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ChildProcessSpawner } from "effect/process"
import { HttpClient } from "effect/http"
import { mkdtempSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fail, property, text, type SkillsError } from "../src/model.ts"
import { Store } from "../src/store.ts"
import { Notion } from "../src/notion.ts"
import { executeSharedCreate } from "../src/shared-create.ts"
import { authScope } from "../src/catalog.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { openFixedSnapshotFiles } from "../src/fixed-snapshot-files.ts"
import { readResources } from "../src/resource-read.ts"
import { consume } from "../src/consumer.ts"
import { snapshotPortable } from "../src/export.ts"
import { readSkill, resolveSkillRef } from "../src/snapshot.ts"
import { registerSourceBinding } from "../src/shared-source-binding.ts"
import {
  prepareSharedGitMainTakeover,
  executeSharedGitMainTakeover,
} from "../src/shared-git-main-takeover.ts"
import { restoreSelectedSharedFile } from "../src/shared-file-restore.ts"
import {
  prepareSharedFileManagement,
  executeSharedFileManagement,
} from "../src/shared-file-management.ts"
import { withSharedAuthoringTarget } from "../src/shared-authoring-context.ts"
import {
  reviewSharedFileAddAcceptance,
  applySharedFileAddAcceptance,
} from "../src/shared-file-add-acceptance.ts"
import { resolveFileState, type FileEvent } from "../src/shared-file-state.ts"
import { fileRef } from "../src/ref.ts"
import { querySharedRecords } from "../src/shared-records.ts"
import { bindSourceDefinition, readSourceDefinition } from "../src/shared-source-definitions.ts"
import {
  prepareSourceRefreshFromSnapshot,
  reviewSourceMembers,
  applySourceRefresh,
} from "../src/shared-source-refresh.ts"
import { discoverSourceDefinition } from "../src/shared-source-adapters.ts"
import { SourceOnboardingPlanSchema } from "../src/shared-source-onboarding-model.ts"
import {
  prepareSourceOnboarding,
  reviewSourceOnboarding,
  executeSourceOnboarding,
  sourceOnboardingError,
} from "../src/shared-source-onboarding.ts"
import { fixture, library, ids } from "./shared-source-projection-fixture.ts"
import { id, rich } from "./shared-snapshot-fixture.ts"

function setup(
  setupOptions: {
    readonly bodyWrites?: boolean
    readonly nativeReadback?: (wire: string) => string
    readonly filteredMetadata?: boolean
    readonly lagGitInventory?: boolean
    readonly initialMainInsert?: boolean
  } = {},
) {
  const f = fixture([], {
    markdownImport: true,
    ...(setupOptions.nativeReadback ? { readback: setupOptions.nativeReadback } : {}),
  })
  const root = mkdtempSync(join(tmpdir(), "ntn-source-onboarding-"))
  for (const row of f.skills.values()) {
    const p = property(row.properties)
    p.origin = { id: "origin", type: "relation", relation: [], has_more: false }
    p.source_member = rich("source_member", "")
  }
  let acquisitions = 0
  let gitCreates = 0
  let lostGitCreate: { readonly visible: boolean } | undefined
  const acquire = () => {
    acquisitions++
    return Effect.succeed(structuredClone(f.snapshot))
  }
  const scope = { kind: "source", source: f.source.id } as const
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
        const store = yield* Store
        const api = yield* Notion
        const bindingApi: Notion["Service"] = {
          ...api,
          request: (path, body, options) =>
            Effect.suspend(() => {
              const bodyTarget = /^v1\/pages\/([^/]+)\/markdown$/u.exec(path)
              if (setupOptions.initialMainInsert && bodyTarget && options?.method === "PATCH") {
                const page = bodyTarget[1]!,
                  request = property(body),
                  insert = property(request.insert_content)
                if (
                  request.type !== "insert_content" ||
                  insert.position !== undefined ||
                  typeof insert.content !== "string" ||
                  f.base.bodies.get(page) !== ""
                )
                  return Effect.fail(
                    fail(
                      "TEST_INITIAL_INSERT",
                      "Expected one initial append to the empty Git main.",
                    ),
                  )
                f.calls.push({ path, method: "PATCH", body })
                const rendered = insert.content.replace(/^<h1>([^\n]*)<\/h1>(?=\n|$)/u, "# $1")
                f.base.bodies.set(page, rendered)
                return Effect.succeed({
                  id: page,
                  markdown: rendered,
                  truncated: false,
                  unknown_block_ids: [],
                })
              }
              if (setupOptions.bodyWrites === true && bodyTarget && options?.method === "PATCH") {
                const page = bodyTarget[1]!,
                  current = f.base.bodies.get(page)
                const request = property(body),
                  changes = property(request.update_content).content_updates
                if (
                  request.type !== "update_content" ||
                  request.markdown_version !== "v2" ||
                  !Array.isArray(changes) ||
                  changes.length !== 1 ||
                  current === undefined
                )
                  return Effect.fail(
                    fail(
                      "TEST_RESTORE_REQUEST",
                      "Expected one exact full-document restore request.",
                    ),
                  )
                const update = property(changes[0])
                if (
                  typeof update.old_str !== "string" ||
                  update.old_str === "" ||
                  current !== update.old_str ||
                  typeof update.new_str !== "string"
                )
                  return Effect.fail(
                    fail("TEST_RESTORE_REQUEST", "The frozen original document no longer matches."),
                  )
                const rendered = update.new_str.replace(/^<h1>([^\n]*)<\/h1>(?=\n|$)/u, "# $1")
                f.calls.push({ path, method: "PATCH", body })
                f.base.bodies.set(page, rendered)
                const row = f.skills.get(page) ?? f.files.get(page)
                if (row) row.last_edited_time = new Date().toISOString()
                return Effect.succeed({
                  id: page,
                  markdown: rendered,
                  truncated: false,
                  unknown_block_ids: [],
                })
              }
              if (
                path === "v1/pages" &&
                options?.method === "POST" &&
                property(property(body).parent).data_source_id === library.skills.data_source_id &&
                text(
                  property(
                    property(property(body).properties)[
                      (library.skills.property_ids as Record<string, string>).Projection!
                    ],
                  ).rich_text,
                ).startsWith("git-only/v1:")
              ) {
                const newPage = id(56800 + ++gitCreates)
                const lost = lostGitCreate
                lostGitCreate = undefined
                f.calls.push({ path, method: "POST", body })
                if (lost?.visible === false)
                  return Effect.fail(
                    fail(
                      "WRITE_OUTCOME_UNKNOWN",
                      "Controlled missing Git-only POST acknowledgement",
                    ),
                  )
                const attrs = property(property(body).properties)
                const properties = Object.fromEntries(
                  Object.entries(attrs).map(([key, value]) => {
                    const field = property(value)
                    if (Array.isArray(field.rich_text))
                      return [
                        key,
                        { id: key, type: "rich_text", rich_text: field.rich_text, has_more: false },
                      ]
                    if (Array.isArray(field.title))
                      return [key, { id: key, type: "title", title: field.title }]
                    if (Array.isArray(field.relation))
                      return [
                        key,
                        { id: key, type: "relation", relation: field.relation, has_more: false },
                      ]
                    if (field.select !== undefined)
                      return [key, { id: key, type: "select", select: field.select }]
                    return [key, { id: key, type: "checkbox", checkbox: field.checkbox }]
                  }),
                )
                const newRow = {
                  object: "page",
                  id: newPage,
                  parent: {
                    type: "data_source_id",
                    data_source_id: library.skills.data_source_id,
                    database_id: library.skills.database_id,
                  },
                  last_edited_time: new Date().toISOString(),
                  properties,
                }
                f.skills.set(newPage, newRow)
                f.base.bodies.set(newPage, "")
                return lost
                  ? Effect.fail(
                      fail(
                        "WRITE_OUTCOME_UNKNOWN",
                        "Controlled lost Git-only POST acknowledgement",
                      ),
                    )
                  : Effect.succeed(structuredClone(newRow))
              }
              const target = f.skills.get(path.replace(/^v1\/pages\//u, ""))
              const changes = property(property(body).properties)
              const record = [...f.base.records.values()].find(
                (row) => path === `v1/pages/${row.id}`,
              )
              if (
                setupOptions.bodyWrites === true &&
                record &&
                options?.method === "PATCH" &&
                Object.keys(changes).join(",") === library.records.property_ids.Origin
              ) {
                f.calls.push({ path, method: "PATCH", body })
                const key = library.records.property_ids.Origin!
                property(record.properties)[key] = {
                  id: key,
                  type: "relation",
                  ...property(changes[key]),
                  has_more: false,
                }
                return Effect.succeed(structuredClone(record))
              }
              if (
                setupOptions.bodyWrites === true &&
                target &&
                options?.method === "PATCH" &&
                Object.keys(changes).join(",") === "source"
              ) {
                f.calls.push({ path, method: "PATCH", body })
                property(target.properties).source = {
                  id: "source",
                  type: "rich_text",
                  ...property(changes.source),
                  has_more: false,
                }
                target.last_edited_time = new Date().toISOString()
                return Effect.succeed(structuredClone(target))
              }
              if (
                target !== undefined &&
                options?.method === "PATCH" &&
                Object.keys(changes).sort().join(",") === "origin,source_member"
              ) {
                f.calls.push({ path, method: "PATCH", body })
                const props = property(target.properties)
                props.origin = {
                  id: "origin",
                  type: "relation",
                  ...property(changes.origin),
                  has_more: false,
                }
                props.source_member = {
                  id: "source_member",
                  type: "rich_text",
                  ...property(changes.source_member),
                }
                return Effect.succeed(structuredClone(target))
              }
              let response = api.request(path, body, options)
              if (
                setupOptions.lagGitInventory &&
                path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`)
              )
                response = response.pipe(
                  Effect.map((raw) => {
                    const value = property(raw)
                    return {
                      ...value,
                      results: (value.results as unknown[]).filter(
                        (row) =>
                          !Object.values(property(property(row).properties)).some((field) =>
                            text(property(field).rich_text).startsWith("git-only/v1:"),
                          ),
                      ),
                    }
                  }),
                )
              if (
                setupOptions.filteredMetadata === true &&
                path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query?`)
              ) {
                const selected = new Set(
                  new URL(path, "https://api.notion.com/").searchParams.getAll("filter_properties"),
                )
                if (selected.size > 0)
                  return response.pipe(
                    Effect.map((raw) => {
                      const value = property(raw)
                      return {
                        ...value,
                        results: (value.results as unknown[]).map((item) => {
                          const row = property(item)
                          return {
                            ...row,
                            properties: Object.fromEntries(
                              Object.entries(property(row.properties)).filter(
                                ([key, field]) =>
                                  selected.has(key) || selected.has(String(property(field).id)),
                              ),
                            ),
                          }
                        }),
                      }
                    }),
                  )
              }
              return response
            }),
        }
        return yield* action.pipe(
          Effect.provideService(Store, { ...store, root }),
          Effect.provideService(Notion, bindingApi),
          Effect.provide(NodeServices.layer),
        )
      }),
    )
  return {
    ...f,
    run,
    acquire,
    scope,
    acquisitions: () => acquisitions,
    gitCreates: () => gitCreates,
    loseGitCreate: (visible: boolean) => {
      lostGitCreate = { visible }
    },
  }
}

test("a source-only fixed Git member creates just one disabled identity page and one exact Source fact", async () => {
  const f = setup()
  const report = await f.run(reviewSourceOnboarding(library, f.scope, f.acquire))
  expect(report.sources[0]?.members[0]?.kind).toBe("admit")
  expect(f.writes()).toHaveLength(0)
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  expect(plan.actions).toHaveLength(1)
  expect(f.acquisitions()).toBe(2)
  expect(plan.actions[0]?.kind).toBe("create_git")
  const beforeFiles = f.files.size
  f.clear()
  const dry = await f.run(executeSourceOnboarding(library, plan, "dry-run"))
  expect(dry.status).toBe("previewed")
  expect(f.writes()).toHaveLength(0)
  const applied = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(applied.status).toBe("completed")
  expect(applied.results[0]?.verified).toBe(true)
  expect(f.files.size).toBe(beforeFiles)
  expect(f.gitCreates()).toBe(1)
  const created = [...f.skills.values()].find((row) => row.id === applied.results[0]?.page_id)
  expect(property(property(created).properties).enabled).toMatchObject({ checkbox: false })
  f.clear()
  const repeated = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(repeated.status).toBe("completed")
  expect(f.writes()).toHaveLength(0)
  expect(f.gitCreates()).toBe(1)
  expect((await f.run(executeSourceOnboarding(library, plan, "reconcile"))).status).toBe(
    "completed",
  )
  expect(f.writes()).toHaveLength(0)
  const again = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  expect(again.actions).toHaveLength(0)
  expect(again.report.sources[0]?.members[0]?.kind).toBe("registered")
})

test("pre-marker Git-only frozen plans are rejected rather than replaying a changed Source-owned POST", async () => {
  const f = setup()
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  const legacy = structuredClone(plan)
  if (legacy.actions[0]?.kind !== "create_git") throw new Error("Expected fixed Git action")
  delete (legacy.actions[0] as { projection?: string }).projection
  expect(() =>
    Schema.decodeUnknownSync(SourceOnboardingPlanSchema)(legacy, { onExcessProperty: "error" }),
  ).toThrow()
  await expect(f.run(executeSourceOnboarding(library, legacy, "apply"))).rejects.toMatchObject({
    code: "SOURCE_DEFINITION_INVALID",
  })
  expect(f.gitCreates()).toBe(0)
  expect(f.writes()).toHaveLength(0)
})

test("a durable Git creation ACK verifies its exact page even while the provider query index lags", async () => {
  const f = setup({ lagGitInventory: true })
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  const fileCount = f.files.size
  const applied = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(applied.status).toBe("completed")
  expect(applied.results[0]!.verified).toBe(true)
  expect(f.gitCreates()).toBe(1)
  expect(f.files.size).toBe(fileCount)
  f.clear()
  const repeated = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(repeated.results[0]!.page_id).toBe(applied.results[0]!.page_id)
  expect(repeated.results[0]!.verified).toBe(true)
  expect(f.gitCreates()).toBe(1)
  expect(f.writes()).toHaveLength(0)
})

test("current use preserves sparse Git Source ownership under actual filtered graph metadata", async () => {
  const f = setup({ filteredMetadata: true })
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  const admitted = await f.run(executeSourceOnboarding(library, plan, "apply"))
  const page = admitted.results[0]!.page_id!,
    row = f.skills.get(page)!
  property(row.properties).enabled = { id: "enabled", type: "checkbox", checkbox: true }
  const action = plan.actions[0]!
  if (action.kind !== "create_git") throw new Error("Expected sparse Git admission")
  const currentRef = fileRef(`shared_skill:${library.library_id}:${action.skill_id}`, "SKILL.md")
  const use = () =>
    f.run(
      consume(
        { version: 1, targets: [currentRef], purpose: "use", freshness: { policy: "refresh" } },
        { database: library.skills.database_id, readOnly: true },
      ),
    )
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  const result = await use()
  expect(result.status).toBe("ready")
  if (result.status !== "ready") throw new Error(JSON.stringify(result))
  expect(result.entries[0]!.manifest.files).toHaveLength(action.binding.files.length)
  const inventories = f.calls.filter((call) =>
    call.path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query?`),
  )
  expect(inventories).toHaveLength(1)
  const fields = new URL(inventories[0]!.path, "https://api.notion.com/").searchParams.getAll(
    "filter_properties",
  )
  expect(fields).toContain(library.skills.property_ids.Origin)
  expect(fields).toContain(library.skills.property_ids["Source Member"])
  expect(f.writes()).toHaveLength(0)
  property(row.properties).origin = {
    id: "origin",
    type: "relation",
    relation: [{ id: id(99887) }],
    has_more: false,
  }
  const changed = await use()
  expect(changed.status).toBe("failed")
  if (changed.status === "failed") expect(changed.error.code).toBe("GIT_ONLY_SCOPE")
  expect(f.writes()).toHaveLength(0)
})

test("an explicitly enabled Git-only member consumes original Git main and lazily retrieves a supporting Markdown without native Files", async () => {
  const f = setup()
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  const applied = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(applied.status).toBe("completed")
  const page = applied.results[0]?.page_id!
  const target = f.skills.get(page)!
  // Controlled authorization change only: the onboarding itself must never
  // enable a new member. This simulates a later explicit author decision.
  property(property(target).properties).enabled = {
    id: "enabled",
    type: "checkbox",
    checkbox: true,
  }
  f.clear()
  const current = await f.run(
    Effect.gen(function* () {
      return yield* openSharedConsumer({
        library,
        target: page,
        scope: yield* authScope,
        startedAt: Date.now(),
      })
    }),
  )
  expect(current.shared_acquisition?.version).toBe(3)
  expect(current.file_bindings).toHaveLength(1)
  expect(current.files).toHaveLength(f.snapshot.members[0]!.portable.files.length)
  expect(current.materialization?.materialized_paths).toEqual(["SKILL.md"])
  const body = await f.run(openFixedSnapshotFiles(current, () => ["references/a.md"]))
  expect(new TextDecoder().decode(body.files[0]?.bytes)).toContain("# Guide")
  const requested = fileRef(current.record.id, "references/a.md", current.snapshot_id)
  const resource = await f.run(readResources({ version: 1, refs: [requested] }))
  expect(resource.status).toBe("ready")
  if (resource.status === "ready") {
    expect(resource.files[0]?.requested_ref).toBe(requested)
    expect(resource.files[0]?.encoding).toBe("utf8")
    expect(resource.files[0]?.content).toContain("# Guide")
  }
  expect(f.files.size).toBeGreaterThan(0) // all existing fixture Files are unrelated
  expect(f.writes()).toHaveLength(0)
})

test.each([false, true])(
  "Git sibling links from a main with native custom=%s use --from only for a published same-Source same-commit member",
  async (nativeCustom) => {
    const f = setup({ initialMainInsert: nativeCustom })
    f.source.properties[ids.Selection!] = rich(
      ids.Selection!,
      JSON.stringify({ roots: ["skills"], include: [], exclude: [], mapping: {} }),
    )
    const original = structuredClone(f.snapshot)
    const first = structuredClone(original.members[0]!)
    const main = first.portable.files.find((file) => file.path === "SKILL.md")!
    const encode = (value: string) => new TextEncoder().encode(value)
    const gitOid = (value: Uint8Array) =>
      createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex")
    const alpha = encode(
      "---\nname: initial-source\ndescription: Initial complete member\n---\n\n" +
        "# Main\n\n[Sibling](../papers/SKILL.md)\n",
    )
    const beta = encode(
      "---\nname: pinned-papers\ndescription: Exact sibling from the same Git commit\n---\n\n# Papers\n",
    )
    const revisedFirst = {
      ...first,
      portable: {
        ...first.portable,
        files: [
          { ...main, bytes: alpha },
          ...first.portable.files.filter((file) => file.path !== "SKILL.md"),
        ],
      },
      git_manifest: {
        ...first.git_manifest!,
        files: first.git_manifest!.files.map((entry) =>
          entry.path === "SKILL.md"
            ? { ...entry, bytes: alpha.length, git_oid: gitOid(alpha) }
            : entry,
        ),
      },
    }
    const sibling = {
      ...structuredClone(revisedFirst),
      member_key: "skills/papers",
      source_path: "skills/papers",
      portable: {
        ...structuredClone(revisedFirst.portable),
        name: "pinned-papers",
        description: "Exact sibling from the same Git commit",
        files: [{ path: "SKILL.md", bytes: beta, mode: "100644" as const }],
      },
      git_manifest: {
        ...structuredClone(revisedFirst.git_manifest!),
        root: "skills/papers",
        files: [
          {
            path: "SKILL.md",
            source_path: "skills/papers/SKILL.md",
            git_oid: gitOid(beta),
            bytes: beta.length,
            mode: "100644" as const,
          },
        ],
      },
    }
    const source = { ...original, members: [revisedFirst, sibling] }
    f.registerSnapshot(source)
    const acquire = () => Effect.succeed(structuredClone(source))
    const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, acquire))
    expect(plan.actions.map((action) => action.kind)).toEqual(["create_git", "create_git"])
    const applied = await f.run(executeSourceOnboarding(library, plan, "apply"))
    expect(applied.status).toBe("completed")
    const mainPage = applied.results.find((row) => row.member === "skills/demo")!.page_id!
    const siblingPage = applied.results.find((row) => row.member === "skills/papers")!.page_id!
    for (const page of [mainPage, siblingPage]) {
      property(f.skills.get(page)!.properties).enabled = {
        id: "enabled",
        type: "checkbox",
        checkbox: true,
      }
    }
    const initialRead = Effect.gen(function* () {
      return yield* openSharedConsumer({
        library,
        target: mainPage,
        scope: yield* authScope,
        startedAt: Date.now(),
        forceFull: nativeCustom,
        readOnly: true,
      })
    })
    let current = await f.run(
      nativeCustom ? withSharedAuthoringTarget(mainPage, initialRead) : initialRead,
    )
    if (nativeCustom) {
      const markdown =
        new TextDecoder().decode(alpha) + "\nPreserve this explicit native customization.\n"
      const takeover = await f.run(
        prepareSharedGitMainTakeover({
          library,
          snapshot: current,
          path: "SKILL.md",
          markdown,
          mode: "100644",
        }),
      )
      const written = await f.run(
        executeSharedGitMainTakeover({ library, plan: takeover.plan, mode: "create" }),
      )
      expect(written.status).toBe("applied")
      f.base.json.clear()
      f.base.objects.clear()
      current = await f.run(
        Effect.gen(function* () {
          return yield* openSharedConsumer({
            library,
            target: mainPage,
            scope: yield* authScope,
            startedAt: Date.now(),
            forceFull: true,
          })
        }),
      )
      expect(current.shared_acquisition?.version).toBe(3)
      expect(current.shared_acquisition?.files.some((file) => file.path === "SKILL.md")).toBe(false)
      const mainBytes = await f.run(openFixedSnapshotFiles(current, () => ["SKILL.md"]))
      expect(new TextDecoder().decode(mainBytes.files[0]!.bytes)).toContain(
        "[Sibling](../papers/SKILL.md)",
      )
      expect(new TextDecoder().decode(mainBytes.files[0]!.bytes)).toContain(
        "Preserve this explicit native customization.",
      )
    }
    const from = fileRef(current.record.id, "SKILL.md", current.snapshot_id)
    const resolved = await f.run(resolveSkillRef(from, "../papers/SKILL.md"))
    expect(resolved).toContain("snapshot=s_")
    const joined = await f.run(readSkill("../papers/SKILL.md", { from }))
    expect("content" in joined ? joined.content : "").toContain("# Papers")
    expect(joined.path).toBe("SKILL.md")
    expect(f.files.size).toBeGreaterThan(0)
    f.clear()
    property(f.skills.get(siblingPage)!.properties).enabled = {
      id: "enabled",
      type: "checkbox",
      checkbox: false,
    }
    await expect(f.run(resolveSkillRef(from, "../papers/SKILL.md"))).rejects.toMatchObject({
      code: "SOURCE_MEMBER_UNAVAILABLE",
    })
    expect(f.writes()).toHaveLength(0)
    property(f.skills.get(siblingPage)!.properties).enabled = {
      id: "enabled",
      type: "checkbox",
      checkbox: true,
    }
    const siblingAction = plan.actions.find((action) => action.member === "skills/papers")
    if (siblingAction?.kind !== "create_git")
      throw new Error("Expected a frozen Git-only sibling action")
    const differentCommit = await f.run(
      registerSourceBinding(library, {
        skillPageId: siblingPage,
        mode: "create",
        fixedSource: {
          url: siblingAction.binding.url,
          commit: "c".repeat(40),
          tree: "d".repeat(40),
          root: siblingAction.binding.root,
          files: siblingAction.binding.files,
        },
      }),
    )
    property(f.skills.get(siblingPage)!.properties).source = rich(
      "source",
      differentCommit.binding.source_id,
    )
    f.clear()
    await expect(f.run(resolveSkillRef(from, "../papers/SKILL.md"))).rejects.toMatchObject({
      code: "SOURCE_REVISION_UNAVAILABLE",
    })
    expect(f.writes()).toHaveLength(0)
  },
)

test("one edited child document is sticky Notion custom while main and all other resources follow Git, including after cold recovery and A-to-B", async () => {
  const f = setup({ bodyWrites: true })
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  const applied = await f.run(executeSourceOnboarding(library, plan, "apply"))
  const page = applied.results[0]!.page_id!
  const row = f.skills.get(page)!
  property(row.properties).enabled = { id: "enabled", type: "checkbox", checkbox: true }
  const open = () =>
    f.run(
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: page,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
        })
      }),
    )
  const textOf = async (snapshot: Awaited<ReturnType<typeof open>>, path: string) => {
    const selected = await f.run(openFixedSnapshotFiles(snapshot, () => [path]))
    return new TextDecoder().decode(selected.files[0]!.bytes)
  }
  const original = await open()
  const mainA = original.files.find((file) => file.path === "SKILL.md")!.sha256
  const originalGuide = new TextDecoder().decode(
    f.snapshot.members[0]!.portable.files.find((file) => file.path === "references/a.md")!.bytes,
  )
  const fileCount = f.files.size
  const authoring = await f.run(
    withSharedAuthoringTarget(
      page,
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: page,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly: true,
        })
      }),
    ),
  )
  const overlay = await f.run(
    prepareSharedFileManagement({
      library,
      snapshot: authoring,
      action: "add",
      path: "references/a.md",
      markdown: "# My complete guide\n\nOnly this document belongs to me.\n",
    }),
  )
  expect(overlay.version).toBe(4)
  const allocated = await f.run(
    executeSharedFileManagement(library, { plan: overlay, mode: "create" }),
  )
  expect(allocated.status).toBe("applied")
  expect(f.files.size).toBe(fileCount + 1)
  const childId = allocated.page_id!
  const child = f.files.get(childId)!
  const customFileId = overlay.file_id
  const mixed = await open()
  expect(await textOf(mixed, "references/a.md")).toContain("Only this document belongs to me.")
  expect(mixed.files.find((file) => file.path === "SKILL.md")!.sha256).toBe(mainA)
  expect(
    mixed
      .shared_acquisition!.files.filter((route) => route.kind === "source")
      .map((route) => route.path),
  ).toEqual(
    expect.arrayContaining(["SKILL.md", "scripts/run.js", "assets/icon.png", "data/options.json"]),
  )
  expect(mixed.shared_acquisition!.files.some((route) => route.path === "references/a.md")).toBe(
    false,
  )
  const mixedRef = fileRef(mixed.record.id, "references/a.md", mixed.snapshot_id)
  const requestedMixed = await f.run(readResources({ version: 1, refs: [mixedRef] }))
  expect(requestedMixed.status).toBe("ready")
  if (requestedMixed.status === "ready")
    expect(requestedMixed.files[0]!.content).toContain("Only this document belongs to me.")
  const used = await f.run(
    consume({
      version: 1,
      targets: [fileRef(mixed.record.id, "SKILL.md", mixed.snapshot_id)],
      purpose: "use",
    }),
  )
  expect(used.status).toBe("ready")
  if (used.status === "ready") {
    expect(used.entries[0]!.manifest.files).toEqual(mixed.files)
    expect(used.entries[0]!.manifest.snapshot_id).toBe(mixed.snapshot_id)
  }
  const states = async () => {
    const facts = await f.run(
      querySharedRecords(library, { skillPageId: page, kind: "file_event" }),
    )
    return facts.map((fact) => fact.payload as FileEvent)
  }
  expect(resolveFileState(customFileId, await states()).ownership.kind).toBe("custom")
  f.base.bodies.set(childId, originalGuide)
  child.last_edited_time = new Date().toISOString()
  const sameBytes = await open()
  expect(resolveFileState(customFileId, await states()).ownership.kind).toBe("custom")
  expect(
    sameBytes.shared_acquisition!.files.some((route) => route.path === "references/a.md"),
  ).toBe(false)
  const beforeA = await textOf(original, "SKILL.md")

  const updatedFiles = f.snapshot.members[0]!.portable.files.map((file) => ({
    ...file,
    bytes:
      file.path === "SKILL.md" || file.path === "references/a.md"
        ? new TextEncoder().encode(new TextDecoder().decode(file.bytes) + "\nUpstream B\n")
        : file.bytes,
  }))
  const manifestFiles = updatedFiles.map((file) => ({
    path: file.path,
    source_path: `skills/demo/${file.path}`,
    bytes: file.bytes.length,
    mode: file.mode!,
    git_oid: createHash("sha1")
      .update(`blob ${file.bytes.length}\0`)
      .update(file.bytes)
      .digest("hex"),
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  }))
  const revision = "c".repeat(40),
    tree = "d".repeat(40)
  const upstreamB = {
    ...f.snapshot,
    revision,
    members: [
      {
        ...f.snapshot.members[0]!,
        portable: { ...f.snapshot.members[0]!.portable, files: updatedFiles },
        git_manifest: { commit: revision, tree, root: "skills/demo", files: manifestFiles },
      },
    ],
  }
  f.registerSnapshot(upstreamB)
  const refresh = await f.run(
    Effect.gen(function* () {
      const definition = yield* readSourceDefinition(library, f.source.id)
      return yield* prepareSourceRefreshFromSnapshot(library, {
        definition,
        acquired: upstreamB,
        target: page,
        memberReview: yield* reviewSourceMembers(library, f.source.id, upstreamB),
      })
    }),
  )
  expect(refresh.custom_files_preserved).toEqual(["references/a.md"])
  const appliedRefresh = await f.run(applySourceRefresh(library, refresh, false, false))
  expect(appliedRefresh.verified).toBe(true)
  const next = await open()
  expect(await textOf(next, "SKILL.md")).toContain("Upstream B")
  expect(await textOf(next, "references/a.md")).toBe(originalGuide)
  expect(await textOf(original, "SKILL.md")).toBe(beforeA)

  // Simulate an independent client's empty derived store while leaving the
  // shared Notion pages, original facts and recorded custom body untouched.
  f.base.json.clear()
  f.base.objects.clear()
  const cold = await open()
  expect(await textOf(cold, "references/a.md")).toBe(originalGuide)
  expect(await textOf(cold, "SKILL.md")).toContain("Upstream B")
  expect(resolveFileState(customFileId, await states()).ownership.kind).toBe("custom")
  await f.run(openFixedSnapshotFiles(cold, (snapshot) => snapshot.files.map((file) => file.path)))
  const exported = await f.run(snapshotPortable(cold))
  expect(
    new TextDecoder().decode(exported.files.find((file) => file.path === "references/a.md")!.bytes),
  ).toBe(originalGuide)
  expect(
    new TextDecoder().decode(exported.files.find((file) => file.path === "SKILL.md")!.bytes),
  ).toContain("Upstream B")

  const restored = await f.run(
    restoreSelectedSharedFile({ library, skillPageId: page, path: "references/a.md" }),
  )
  expect(restored.source_revision).toBe(revision)
  expect(resolveFileState(customFileId, await states()).ownership.kind).toBe("following")
  const following = await open()
  expect(await textOf(following, "references/a.md")).toContain("Upstream B")
  expect(await textOf(cold, "references/a.md")).toBe(originalGuide)
  expect(following.files.find((file) => file.path === "SKILL.md")!.sha256).toBe(
    cold.files.find((file) => file.path === "SKILL.md")!.sha256,
  )
})

test("a main-only Notion edit takes over the whole main, including an empty edit, and restore-follow leaves every supporting document unchanged", async () => {
  const f = setup({ bodyWrites: true })
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  const admitted = await f.run(executeSourceOnboarding(library, plan, "apply"))
  const page = admitted.results[0]!.page_id!
  const row = f.skills.get(page)!
  property(row.properties).enabled = { id: "enabled", type: "checkbox", checkbox: true }
  const open = (readOnly = false) =>
    f.run(
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: page,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly,
        })
      }),
    )
  const original = await open()
  const originalSupport = original.files.filter((file) => file.path !== "SKILL.md")
  const initialFiles = f.files.size
  f.base.bodies.set(page, "# My complete instructions\n\nOnly my document body should be used.\n")
  row.last_edited_time = new Date().toISOString()
  f.clear()
  await expect(open(true)).rejects.toMatchObject({ code: "SHARED_OBSERVATION_REQUIRED" })
  expect(f.writes()).toHaveLength(0)
  const taken = await open()
  const body = await f.run(openFixedSnapshotFiles(taken, () => ["SKILL.md"]))
  const markdown = new TextDecoder().decode(body.files[0]!.bytes)
  expect(markdown).toContain("Only my document body")
  expect(markdown).not.toContain("# Initial")
  expect(markdown).not.toContain("license: MIT")
  expect(taken.files.filter((file) => file.path !== "SKILL.md")).toEqual(originalSupport)
  expect(taken.shared_acquisition!.files.some((route) => route.path === "SKILL.md")).toBe(false)
  f.base.bodies.set(page, "")
  row.last_edited_time = new Date().toISOString()
  const blankCustom = await open()
  expect(blankCustom.shared_acquisition!.files.some((route) => route.path === "SKILL.md")).toBe(
    false,
  )
  f.base.bodies.set(page, "# My final reviewed main\n")
  row.last_edited_time = new Date().toISOString()
  await open()
  const restored = await f.run(
    restoreSelectedSharedFile({ library, skillPageId: page, path: "SKILL.md" }),
  )
  expect(restored.source_revision).toBe(f.snapshot.revision)
  const following = await open()
  expect(following.files).toEqual(original.files)
  expect(f.files.size).toBe(initialFiles)
  expect(
    following.shared_acquisition!.files.some(
      (route) => route.path === "SKILL.md" && route.kind === "source",
    ),
  ).toBe(true)
})

test("a known sparse document add readback mismatch is independently reviewed on its original page without replaying creation or rewriting old failure", async () => {
  const f = setup({
    nativeReadback: (wire) =>
      wire.replace("Expected original manual prose.", "Reviewed current prose."),
  })
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  const admitted = await f.run(executeSourceOnboarding(library, plan, "apply"))
  const page = admitted.results[0]!.page_id!
  property(f.skills.get(page)!.properties).enabled = {
    id: "enabled",
    type: "checkbox",
    checkbox: true,
  }
  const open = () =>
    f.run(
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: page,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
        })
      }),
    )
  const baseline = await f.run(
    withSharedAuthoringTarget(
      page,
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: page,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly: true,
        })
      }),
    ),
  )
  const overlay = await f.run(
    prepareSharedFileManagement({
      library,
      snapshot: baseline,
      action: "add",
      path: "references/a.md",
      markdown: "Expected original manual prose.\n",
    }),
  )
  const fileCount = f.files.size
  const rejected = await f.run(
    executeSharedFileManagement(library, { plan: overlay, mode: "create" }).pipe(Effect.result),
  )
  expect(rejected._tag).toBe("Failure")
  if (rejected._tag !== "Failure") throw new Error("Expected original complete-body mismatch")
  expect(rejected.failure.code).toBe("SHARED_FILE_MANAGEMENT_REVIEW_REQUIRED")
  const childPage = String(property(rejected.failure.details).page_id)
  expect(f.files.size).toBe(fileCount + 1)
  const review = await f.run(
    reviewSharedFileAddAcceptance({
      library,
      skillPageId: page,
      originalOperationId: overlay.operation_id,
      acceptCurrent: true,
      acceptedObservedSha256: createHash("sha256")
        .update(f.base.bodies.get(childPage)!)
        .digest("hex"),
    }),
  )
  const originalSelection = property(f.skills.get(page)!.properties).source
  property(f.skills.get(page)!.properties).source = rich("source", "source-" + "a".repeat(64))
  f.clear()
  await expect(
    f.run(applySharedFileAddAcceptance({ library, review, reviewId: review.review_id })),
  ).rejects.toMatchObject({ code: "SHARED_FILE_ADD_ACCEPTANCE_REQUIRED" })
  expect(f.writes()).toHaveLength(0)
  property(f.skills.get(page)!.properties).source = originalSelection
  const accepted = await f.run(
    applySharedFileAddAcceptance({ library, review, reviewId: review.review_id }),
  )
  expect(accepted.verified).toBe(true)
  expect(accepted.original_status).toBe("needs_review")
  expect(accepted.original_completion).toBe("unproven")
  await expect(open()).rejects.toMatchObject({ code: "SHARED_FILE_MANAGEMENT_RECONCILED" })
  const mixed = await open()
  const actual = await f.run(openFixedSnapshotFiles(mixed, () => ["references/a.md"]))
  expect(new TextDecoder().decode(actual.files[0]!.bytes)).toContain("Reviewed current prose.")
  expect(mixed.files.find((file) => file.path === "SKILL.md")!.sha256).toBe(
    baseline.files.find((file) => file.path === "SKILL.md")!.sha256,
  )
  f.base.json.clear()
  f.base.objects.clear()
  const cold = await open()
  expect(cold.files).toEqual(mixed.files)
  expect(f.files.size).toBe(fileCount + 1)
})

test.each([
  { visible: false, lagGitInventory: false },
  { visible: true, lagGitInventory: false },
  { visible: false, lagGitInventory: true },
  { visible: true, lagGitInventory: true },
])(
  "a Git-only POST with an unknown acknowledgement %j cannot be replayed or register Source facts",
  async ({ visible, lagGitInventory }) => {
    const f = setup({ lagGitInventory })
    const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
    expect(plan.actions[0]?.kind).toBe("create_git")
    f.loseGitCreate(visible)
    const first = await f.run(executeSourceOnboarding(library, plan, "apply"))
    expect(first.status).toBe("partial")
    expect(first.results[0]?.error?.code).toBe("SOURCE_WRITE_UNKNOWN")
    expect(f.gitCreates()).toBe(1)
    const page = visible ? id(56801) : undefined
    if (page) {
      expect(
        await f.run(querySharedRecords(library, { skillPageId: page, kind: "source" })),
      ).toHaveLength(0)
    }
    f.clear()
    const again = await f.run(executeSourceOnboarding(library, plan, "apply"))
    expect(again.status).toBe("partial")
    expect(again.results[0]?.error?.code).toBe("SOURCE_WRITE_UNKNOWN")
    expect(f.gitCreates()).toBe(1)
    expect(f.writes()).toHaveLength(0)
  },
)

test("an explicit Source subset shares one inventory, retains order and never claims full-library coverage", async () => {
  const f = setup()
  const unavailable = id(9999)
  const scope = { kind: "sources", sources: [f.source.id, unavailable] } as const
  const report = await f.run(reviewSourceOnboarding(library, scope, f.acquire))
  expect(report.scope).toEqual(scope)
  expect(report.coverage).toBe("partial")
  expect(report.sources.map((source) => source.status)).toEqual(["reviewed", "unavailable"])
  expect(report.sources[0]?.members[0]?.kind).toBe("admit")
  expect(report.sources[1]?.error).not.toBeNull()
  expect(f.acquisitions()).toBe(1)
  expect(f.writes()).toHaveLength(0)
  const plan = await f.run(prepareSourceOnboarding(library, scope, {}, f.acquire))
  expect(plan.report.scope).toEqual(scope)
  expect(plan.report.coverage).toBe("partial")
  expect(plan.actions).toHaveLength(1)
  expect(plan.actions[0]?.kind).toBe("create_git")
  expect(f.writes()).toHaveLength(0)
})

test("an exact Git --member is pushed into acquisition before unrelated member bodies are requested", async () => {
  const f = setup()
  const key = f.snapshot.members[0]!.member_key
  const seen: (readonly string[] | undefined)[] = []
  const acquired = (...args: Parameters<typeof discoverSourceDefinition>) => {
    seen.push(args[1]?.onlyMembers)
    return f.acquire()
  }
  const report = await f.run(
    reviewSourceOnboarding(library, { ...f.scope, members: [key] }, acquired),
  )
  expect(report.coverage).toBe("complete")
  expect(report.sources[0]?.members.map((item) => item.member_key)).toEqual([key])
  expect(seen).toEqual([[key]])
  expect(f.writes()).toHaveLength(0)
  const broad = await f.run(reviewSourceOnboarding(library, f.scope, acquired))
  expect(broad.coverage).toBe("complete")
  expect(seen).toEqual([[key], undefined])
  expect(f.writes()).toHaveLength(0)
})

test("an explicit Source subset cannot include duplicates, an empty selector, or one Source disguised as a batch", async () => {
  const f = setup()
  for (const sources of [[f.source.id], [f.source.id, f.source.id], [f.source.id, ""]]) {
    await expect(
      f.run(reviewSourceOnboarding(library, { kind: "sources", sources }, f.acquire)),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
  }
  expect(f.acquisitions()).toBe(0)
  expect(f.writes()).toHaveLength(0)
})

test("two selectors resolving to one Source cannot dispatch its provider twice", async () => {
  const f = setup()
  const report = await f.run(
    reviewSourceOnboarding(
      library,
      { kind: "sources", sources: [f.source.id, f.source.id.replaceAll("-", "")] },
      f.acquire,
    ),
  )
  expect(report.coverage).toBe("partial")
  expect(report.sources[0]?.status).toBe("reviewed")
  expect(report.sources[1]?.error?.code).toBe("SOURCE_DUPLICATE_SELECTION")
  expect(f.acquisitions()).toBe(1)
  expect(f.writes()).toHaveLength(0)
})

test("a source directory Router is preserved separately from missing Skill members", async () => {
  const f = setup()
  const router = f.seedSkill(id(8765), "source-directory", "Source directory", "router", true)
  const props = property(router.properties)
  props.origin = {
    id: "origin",
    type: "relation",
    relation: [{ id: f.source.id }],
    has_more: false,
  }
  props.source_member = rich("source_member", "")
  const before = structuredClone(router)
  const review = await f.run(reviewSourceOnboarding(library, f.scope, f.acquire))
  expect(review.sources[0]?.unresolved_bindings).toEqual([])
  expect(review.sources[0]?.source_routers).toMatchObject([
    { page_id: router.id, kind: "router", member: "" },
  ])
  expect(review.sources[0]?.members[0]?.kind).toBe("admit")
  expect(router).toEqual(before)
  expect(f.writes()).toHaveLength(0)
})

test("explicit member scope freezes only that member without editing the Source selection", async () => {
  const f = setup()
  const original = structuredClone(f.source)
  const second = structuredClone(f.snapshot.members[0]!)
  Object.assign(second, {
    member_key: "skills/other",
    portable: { ...second.portable, name: "Other workflow" },
  })
  Object.assign(f.snapshot, { members: [...f.snapshot.members, second] })
  const scope = { ...f.scope, members: ["skills/demo"] }
  const plan = await f.run(prepareSourceOnboarding(library, scope, {}, f.acquire))
  expect(plan.report.scope).toEqual(scope)
  expect(plan.report.sources[0]?.members).toHaveLength(1)
  expect(plan.actions.map((action) => action.member)).toEqual(["skills/demo"])
  expect(f.source).toEqual(original)
  expect(f.writes()).toHaveLength(0)
  const missing = await f.run(
    prepareSourceOnboarding(library, { ...f.scope, members: ["skills/absent"] }, {}, f.acquire),
  )
  expect(missing.actions).toHaveLength(0)
  expect(missing.report.sources[0]?.error).toMatchObject({
    code: "SOURCE_MEMBER_UNAVAILABLE",
    details: { members: ["skills/absent"] },
  })
  await expect(
    f.run(
      prepareSourceOnboarding(
        library,
        { ...f.scope, members: ["skills/demo", "skills/demo"] },
        {},
        f.acquire,
      ),
    ),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
})

test("source drift and tampered parent plans cannot dispatch a child", async () => {
  const f = setup()
  const plan = await f.run(
    prepareSourceOnboarding(library, f.scope, { storage: "retained" }, f.acquire),
  )
  const changed = { ...plan, plan_id: `source-onboarding-${"0".repeat(64)}` }
  f.clear()
  await expect(f.run(executeSourceOnboarding(library, changed, "apply"))).rejects.toMatchObject({
    code: "SOURCE_ONBOARDING_INVALID",
  })
  f.source.properties[ids.Ref!] = rich(ids.Ref!, "different")
  const result = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(result.status).toBe("partial")
  expect(result.results[0]?.error?.code).toBe("SOURCE_DEFINITION_CHANGED")
  expect(f.writes()).toHaveLength(0)
})

test("unknown creation remains on its original operation and is never replaced", async () => {
  const f = setup()
  const plan = await f.run(
    prepareSourceOnboarding(library, f.scope, { storage: "retained" }, f.acquire),
  )
  f.unknown("skill", false)
  const first = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(first.status).toBe("partial")
  f.clear()
  const second = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(second.status).toBe("partial")
  expect(f.nativeCreates()).toHaveLength(0)
  const fresh = await f.run(
    prepareSourceOnboarding(library, f.scope, { storage: "retained" }, f.acquire),
  )
  expect(fresh.actions).toHaveLength(0)
  expect(fresh.report.sources[0]?.members[0]).toMatchObject({
    kind: "blocked",
    reason: "original_creation_pending",
  })
})

test("a child failure keeps original recovery identity without echoing the complete plan", async () => {
  const f = setup()
  const plan = await f.run(
    prepareSourceOnboarding(library, f.scope, { storage: "retained" }, f.acquire),
  )
  const action = plan.actions[0]!
  if (action.kind !== "create") throw new Error("Expected an original creation")
  const original = structuredClone(action.plan)
  const error = fail("SHARED_CREATE_BODY_MISMATCH", "Known semantic mismatch", {
    component: "links",
    native_create_operation_id: original.operation_id,
    skill_page_id: id(99),
    recovery: { mode: "reconcile", plan: original },
  })
  const projected = sourceOnboardingError(error, action)
  expect(projected).toMatchObject({
    code: error.code,
    details: {
      component: "links",
      recovery: {
        mode: "reconcile",
        original_plan: {
          operation_id: original.operation_id,
          skill_id: original.skill_id,
          retained_in_parent_plan: true,
          full_input_omitted: true,
        },
      },
    },
  })
  expect(Object.hasOwn(property(property(projected.details).recovery), "plan")).toBe(false)
  expect(JSON.stringify(projected).length).toBeLessThan(2000)
  expect(action.plan).toEqual(original)
  expect(property(property(error.details).recovery).plan).toEqual(original)
})

test("missing discovery bindings reuse a proven fixed-source page and preserve custom bodies and eligibility", async () => {
  const f = setup()
  const child = await f.prepare(true)
  const original = await f.run(executeSharedCreate(library, { plan: child, mode: "create" }))
  const row = f.skills.get(original.page_id)!
  const props = property(row.properties)
  props.origin = { id: "origin", type: "relation", relation: [], has_more: false }
  props.source_member = rich("source_member", "")
  f.base.bodies.set(original.page_id, "# User-owned custom body\nKeep all my edits.\n")
  const protectedBodies = new Map(f.base.bodies)
  const pin = structuredClone(props.source)
  f.clear()
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  expect(plan.actions).toHaveLength(1)
  expect(plan.actions[0]).toMatchObject({ kind: "bind", before: { page_id: original.page_id } })
  expect(f.writes()).toHaveLength(0)
  expect((await f.run(executeSourceOnboarding(library, plan, "dry-run"))).status).toBe("previewed")
  expect(f.writes()).toHaveLength(0)
  const result = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(result.results.map((item) => item.error)).toEqual([undefined])
  expect(result.status).toBe("completed")
  expect(f.nativeCreates()).toHaveLength(0)
  expect(f.base.bodies).toEqual(protectedBodies)
  expect(props.source).toEqual(pin)
  expect(props.enabled).toMatchObject({ checkbox: true })
  expect(
    f.calls
      .filter((call) => call.method === "PATCH")
      .map((call) => Object.keys(property(property(call.body).properties)).sort()),
  ).toEqual([["origin", "source_member"]])
  f.clear()
  expect((await f.run(executeSourceOnboarding(library, plan, "reconcile"))).status).toBe(
    "completed",
  )
  expect((await f.run(executeSourceOnboarding(library, plan, "apply"))).status).toBe("completed")
  expect(f.writes()).toHaveLength(0)
})

test("same-name native content is review-only, including a collision beyond the first metadata page", async () => {
  const f = setup()
  for (let i = 0; i < 105; i++) {
    const row = f.seedSkill(
      id(1000 + i),
      `other-${i}`,
      i === 104 ? "initial-source" : `Other ${i}`,
      "skill",
      false,
    )
    const props = property(row.properties)
    props.origin = { id: "origin", type: "relation", relation: [], has_more: false }
    props.source_member = rich("source_member", "")
    props.source = rich("source", "")
  }
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  expect(plan.report.inventory_count).toBe(106)
  expect(plan.report.sources[0]?.members[0]).toMatchObject({
    kind: "blocked",
    reason: "existing_identity_needs_review",
    candidates: [id(1104)],
  })
  expect(plan.actions).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
})

test("duplicate upstream keys and names do not generate competing create plans", async () => {
  const f = setup()
  const copied = structuredClone(f.snapshot.members[0]!)
  Object.assign(f.snapshot, { members: [...f.snapshot.members, copied] })
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  expect(plan.actions).toHaveLength(0)
  expect(plan.report.sources[0]?.members.every((member) => member.kind === "blocked")).toBe(true)
  expect(f.writes()).toHaveLength(0)
})

test("incomplete metadata cannot authorize absence or even start provider discovery", async () => {
  const f = setup()
  const action = Effect.gen(function* () {
    const api = yield* Notion
    return yield* reviewSourceOnboarding(library, f.scope, f.acquire).pipe(
      Effect.provideService(Notion, {
        ...api,
        request: (path, body, options) =>
          path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`)
            ? api.request(path, body, options).pipe(
                Effect.map((raw) => ({
                  ...property(raw),
                  request_status: { type: "incomplete", incomplete_reason: "query_timeout" },
                })),
              )
            : api.request(path, body, options),
      }),
    )
  })
  await expect(f.run(action)).rejects.toBeDefined()
  expect(f.acquisitions()).toBe(0)
  expect(f.writes()).toHaveLength(0)
})

test("a bounded provider timeout returns explicit partial coverage instead of hiding the Source", async () => {
  const f = setup()
  const result = await f.run(
    reviewSourceOnboarding(library, f.scope, () => Effect.never, { sourceTimeoutMs: 10 }),
  )
  expect(result.coverage).toBe("partial")
  expect(result.sources).toHaveLength(1)
  expect(result.sources[0]).toMatchObject({
    status: "unavailable",
    error: { code: "SOURCE_REVIEW_TIMEOUT", details: { source: f.source.id, duration_ms: 10 } },
  })
  expect(result.sources[0]?.members).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
})

test("provider failures retain exact error diagnostics and cannot prepare an empty success", async () => {
  const f = setup()
  const result = await f.run(
    prepareSourceOnboarding(library, f.scope, {}, () =>
      Effect.fail(fail("GITHUB_RATE_LIMITED", "Controlled limit", { status: 403, reset: 1234 })),
    ),
  )
  expect(result.report.sources[0]?.error).toEqual({
    code: "GITHUB_RATE_LIMITED",
    message: "Controlled limit",
    details: { status: 403, reset: 1234 },
  })
  expect(result.actions).toHaveLength(0)
  expect((await f.run(executeSourceOnboarding(library, result, "dry-run"))).status).toBe("partial")
  expect(f.writes()).toHaveLength(0)
})

test("incomplete provider references retain bounded actionable provenance without admitting partial members", async () => {
  const f = setup()
  const unavailable = Array.from({ length: 23 }, (_, index) => ({
    reason: "outside_source_root" as const,
    from_path: `notes/${index}.md`,
    href: "../../outside/HANDOFF.md",
  }))
  const observed = { ...f.snapshot, unavailable }
  const plan = await f.run(
    prepareSourceOnboarding(library, f.scope, {}, () => Effect.succeed(observed)),
  )
  expect(plan.report.coverage).toBe("partial")
  expect(plan.actions).toHaveLength(0)
  expect(plan.report.sources[0]?.members).toHaveLength(0)
  expect(plan.report.sources[0]?.error).toMatchObject({
    code: "SOURCE_REFRESH_INCOMPLETE",
    details: {
      source_id: "initial-source",
      source_page_id: f.source.id,
      provider_revision: observed.revision,
      unavailable_count: 23,
      unavailable: unavailable.slice(0, 20),
      unavailable_truncated: true,
    },
  })
  expect(f.writes()).toHaveLength(0)
})

test("a lost binding response is not promoted to success from current equality", async () => {
  const f = setup()
  const original = await f.run(
    executeSharedCreate(library, { plan: await f.prepare(), mode: "create" }),
  )
  const props = property(f.skills.get(original.page_id)!.properties)
  props.origin = { id: "origin", type: "relation", relation: [], has_more: false }
  props.source_member = rich("source_member", "")
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  const dropped = Effect.gen(function* () {
    const api = yield* Notion
    return yield* executeSourceOnboarding(library, plan, "apply").pipe(
      Effect.provideService(Notion, {
        ...api,
        request: (path, body, options) => {
          const response = api.request(path, body, options)
          return path === `v1/pages/${original.page_id}` && options?.method === "PATCH"
            ? response.pipe(
                Effect.flatMap(() =>
                  Effect.fail(fail("NOTION_REQUEST_FAILED", "Controlled response loss.")),
                ),
              )
            : response
        },
      }),
    )
  })
  expect((await f.run(dropped)).status).toBe("partial")
  f.clear()
  const observed = await f.run(executeSourceOnboarding(library, plan, "reconcile"))
  expect(observed.status).toBe("partial")
  expect(observed.results[0]?.verified).toBe(false)
  expect((await f.run(executeSourceOnboarding(library, plan, "apply"))).status).toBe("partial")
  expect(f.writes()).toHaveLength(0)
})

test("an unknown original public bind cannot be replayed through onboarding", async () => {
  const f = setup()
  const original = await f.run(
    executeSharedCreate(library, { plan: await f.prepare(), mode: "create" }),
  )
  const props = property(f.skills.get(original.page_id)!.properties)
  props.origin = { id: "origin", type: "relation", relation: [], has_more: false }
  props.source_member = rich("source_member", "")
  const plan = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  const originalAttempt = Effect.gen(function* () {
    const api = yield* Notion
    return yield* bindSourceDefinition(library, {
      source: f.source.id,
      target: original.page_id,
      member: f.snapshot.members[0]!.member_key,
      expected: "none",
    }).pipe(
      Effect.provideService(Notion, {
        ...api,
        request: (path, body, options) => {
          if (path === `v1/pages/${original.page_id}` && options?.method === "PATCH") {
            f.calls.push({ path, method: "PATCH", body })
            return Effect.fail(fail("NOTION_REQUEST_FAILED", "Controlled unknown original bind."))
          }
          return api.request(path, body, options)
        },
      }),
    )
  })
  await expect(f.run(originalAttempt)).rejects.toMatchObject({ code: "SOURCE_WRITE_UNKNOWN" })
  f.clear()
  const result = await f.run(executeSourceOnboarding(library, plan, "apply"))
  expect(result.status).toBe("partial")
  expect(result.results[0]?.error?.code).toBe("SOURCE_WRITE_UNKNOWN")
  expect(f.writes()).toHaveLength(0)
})

test("an explicit new association binds an exact native candidate without pretending historical provenance", async () => {
  const f = setup()
  const original = await f.run(
    executeSharedCreate(library, { plan: await f.prepare(true), mode: "create" }),
  )
  const row = f.skills.get(original.page_id)!,
    props = property(row.properties)
  props.origin = { id: "origin", type: "relation", relation: [], has_more: false }
  props.source_member = rich("source_member", "")
  props.source = rich("source", `bundle-${"a".repeat(64)}`)
  const metadata = structuredClone(props),
    bodies = new Map(f.base.bodies)
  const observed = await f.run(prepareSourceOnboarding(library, f.scope, {}, f.acquire))
  expect(observed.actions).toHaveLength(0)
  expect(observed.report.sources[0]?.members[0]).toMatchObject({
    kind: "blocked",
    reason: "existing_identity_needs_review",
  })
  const decisions = [{ member: f.snapshot.members[0]!.member_key, target: original.page_id }]
  const reviewed = await f.run(
    prepareSourceOnboarding(library, f.scope, { bindings: decisions }, f.acquire),
  )
  expect(reviewed.actions).toEqual([
    expect.objectContaining({ kind: "bind", proof: "explicit_binding_decision" }),
  ])
  f.clear()
  expect((await f.run(executeSourceOnboarding(library, reviewed, "dry-run"))).status).toBe(
    "previewed",
  )
  expect(f.writes()).toHaveLength(0)
  expect((await f.run(executeSourceOnboarding(library, reviewed, "apply"))).status).toBe(
    "completed",
  )
  expect(f.nativeCreates()).toHaveLength(0)
  expect(f.base.bodies).toEqual(bodies)
  expect(props.source).toEqual(metadata.source)
  expect(props.enabled).toEqual(metadata.enabled)
  expect(props.required).toEqual(metadata.required)
  expect(props.members).toEqual(metadata.members)
  f.clear()
  expect((await f.run(executeSourceOnboarding(library, reviewed, "apply"))).status).toBe(
    "completed",
  )
  expect(f.writes()).toHaveLength(0)
  await expect(
    f.run(
      prepareSourceOnboarding(
        library,
        f.scope,
        { bindings: [{ ...decisions[0]!, target: id(9999) }] },
        f.acquire,
      ),
    ),
  ).rejects.toMatchObject({ code: "SOURCE_BINDING_DECISION_INVALID" })
  await expect(
    f.run(prepareSourceOnboarding(library, { kind: "all" }, { bindings: decisions }, f.acquire)),
  ).rejects.toMatchObject({ code: "SOURCE_BINDING_DECISION_INVALID" })
})
