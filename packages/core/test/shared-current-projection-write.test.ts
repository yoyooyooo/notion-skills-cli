import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock, Crypto, Duration, Effect, Exit, Fiber, Latch, Option } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { trashPath } from "../src/local-locks.ts"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { RequestBudget } from "../src/request-budget.ts"
import { withCurrentInvocationBudget } from "../src/shared-current-invocation.ts"
import {
  queryCurrentFilesForSkills,
  queryCurrentSkillIndex,
  type CurrentSkillIndex,
} from "../src/shared-current-index.ts"
import { resolveCurrentSkillConsumption } from "../src/shared-current-consumption.ts"
import {
  readCurrentOperationIntent,
  withCurrentOperation,
} from "../src/shared-current-operation.ts"
import {
  currentProjectionLinkRewriter,
  currentProjectionPolicy,
  projectCurrentSkill,
} from "../src/shared-current-projection-write.ts"
import { cancelCurrentSkillProjection } from "../src/shared-current-projection-cancel.ts"
import { restoreCurrentSkillProjection } from "../src/shared-current-projection-restore.ts"
import {
  applyCurrentProjection,
  renderCurrentProjection,
} from "../src/shared-current-projection.ts"
import {
  currentSharedSourceRevision,
  validateCurrentSharedSourceContent,
} from "../src/shared-current-source.ts"
import {
  prepareCurrentSkillWrite,
  writeCurrentSkill,
  type CurrentSkillWriteInput,
} from "../src/shared-current-write.ts"
import { observeSharedBody } from "../src/shared-page-body.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { sha256, Store } from "../src/store.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import { currentWriteFixture, id, library, testBytes } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-projection-write-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
const main = testBytes("# Current main\r\n\r\nRead [guide](references/guide.md).\r\n")
const native = "# Human guide\n\nThe author keeps this exact current body."
const script = testBytes("// Full source\n" + "const value = '字😀';\n".repeat(2500) + "// FINAL\n")
const defaults: CurrentSkillWriteInput = {
  skill_id: "readable-current",
  kind: "skill",
  name: "Readable current",
  description: "Complete current text projections",
  files: [
    { path: "SKILL.md", bytes: main },
    { path: "scripts/run.ts", bytes: script },
    { path: "config.unknown", bytes: testBytes('{"full":"value"}\n') },
    { path: "drawing.svg", bytes: testBytes("<svg><text>Full source</text></svg>\n") },
    { path: "photo.png", bytes: new Uint8Array([137, 80, 78, 71, 0, 255]) },
    { path: "references/guide.md", bytes: testBytes(native), authority: { kind: "native" } },
  ],
}
async function seed(input = defaults) {
  const f = currentWriteFixture(parent)
  const plan = await f.run(prepareCurrentSkillWrite(input))
  const written = await f.run(writeCurrentSkill(library, { plan, operation_id: "seed" }))
  f.clearCalls()
  return { f, written }
}
const logical = (index: CurrentSkillIndex) => ({
  skill_id: index.skill_id,
  page_id: index.page_id,
  enabled: index.enabled,
  default_context: index.default_context,
  state: index.state,
  files: [index.main, ...index.files].map(({ file_id, page_id, skill_page_id, path, content }) => ({
    file_id,
    page_id,
    skill_page_id,
    path,
    content,
  })),
})
function blockText(blocks: readonly Record<string, unknown>[]) {
  return blocks.map((block) => text(property(block[String(block.type)]).rich_text)).join("")
}
function reverseFileQuery(f: ReturnType<typeof currentWriteFixture>) {
  f.rewrite((path, response) =>
    path.startsWith(`v1/data_sources/${library.files.data_source_id}/query`) &&
    Array.isArray(response.results)
      ? { ...response, results: response.results.toReversed() }
      : response,
  )
}

test("dry run inspects all text and native bodies without a semantic write", async () => {
  const { f, written } = await seed()
  const result = await f.run(
    projectCurrentSkill(library, {
      target: written.page_id,
      operation_id: "inspect",
      dry_run: true,
    }),
  )
  expect(result.status).toBe("dry_run")
  expect(result.counts).toEqual({
    total: 6,
    selected: 6,
    excluded: 0,
    created: 0,
    archived: 0,
    updated: 0,
    would_create: 0,
    would_archive: 0,
    would_update: 0,
    native_verified: 1,
    skipped_binary: 1,
    unchanged: 0,
    would_write: 4,
    applied: 0,
  })
  expect(f.mutations()).toEqual([])
  expect(
    await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })),
  ).toBeUndefined()
})

test("query order cannot change the projection input hash or canonical Unicode path traversal", async () => {
  const { f, written } = await seed({
    ...defaults,
    files: [
      ...defaults.files,
      { path: "references/😀.txt", bytes: testBytes("Supplementary code point.\n") },
      { path: "references/\ue000.txt", bytes: testBytes("Basic multilingual code point.\n") },
    ],
  })
  const first = await f.run(
    projectCurrentSkill(library, {
      target: written.page_id,
      operation_id: "order-first",
      dry_run: true,
    }),
  )
  reverseFileQuery(f)
  const reordered = await f.run(
    projectCurrentSkill(library, {
      target: written.page_id,
      operation_id: "order-second",
      dry_run: true,
    }),
  )
  expect(reordered.input_sha256).toBe(first.input_sha256)
  expect(reordered.files).toEqual(first.files)
  expect(first.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "config.unknown",
    "drawing.svg",
    "photo.png",
    "references/guide.md",
    "references/\ue000.txt",
    "references/😀.txt",
    "scripts/run.ts",
  ])
  expect(f.mutations()).toEqual([])
})

test("projects complete text to existing Skill and File pages, preserves authority and consumption identity, and repeats with zero writes", async () => {
  const { f, written } = await seed()
  const before = await f.run(queryCurrentSkillIndex(library, written.page_id))
  const snapshotInput = {
    library,
    target: written.page_id,
    scope: "a".repeat(64),
    startedAt: Date.now(),
    forceFull: true,
  }
  const snapshotBefore = await f.run(openSharedSnapshot(snapshotInput))
  f.clearCalls()
  const result = await f.run(
    projectCurrentSkill(library, { target: written.page_id, operation_id: "project" }),
  )
  expect(result.status).toBe("applied")
  expect(result.counts).toEqual({
    total: 6,
    selected: 6,
    excluded: 0,
    created: 0,
    archived: 0,
    updated: 0,
    would_create: 0,
    would_archive: 0,
    would_update: 0,
    native_verified: 1,
    skipped_binary: 1,
    unchanged: 0,
    would_write: 0,
    applied: 4,
  })
  expect(logical(await f.run(queryCurrentSkillIndex(library, written.page_id)))).toEqual(
    logical(before),
  )
  const code = before.files.find((file) => file.path === "scripts/run.ts")!
  expect(blockText(f.blocks.get(code.page_id) ?? [])).toBe(new TextDecoder().decode(script))
  expect(JSON.stringify(f.blocks.get(written.page_id))).toContain(
    "https://www.notion.so/" +
      before.files.find((file) => file.path === "references/guide.md")!.page_id.replaceAll("-", ""),
  )
  const nativeFile = before.files.find((file) => file.path === "references/guide.md")!
  expect((await f.run(observeSharedBody(nativeFile.page_id))).markdown).toBe(native)
  expect(f.blocks.get(before.files.find((file) => file.path === "photo.png")!.page_id)).toEqual([])
  expect(f.mutations().filter((call) => call.path === `v1/pages/${written.page_id}`)).toEqual([])
  const snapshotAfter = await f.run(openSharedSnapshot({ ...snapshotInput, startedAt: Date.now() }))
  expect(snapshotAfter.snapshot_id).toBe(snapshotBefore.snapshot_id)
  f.clearCalls()
  const repeat = await f.run(
    projectCurrentSkill(library, { target: written.page_id, operation_id: "project-again" }),
  )
  expect(repeat.status).toBe("unchanged")
  expect(repeat.counts.unchanged).toBe(4)
  expect(f.mutations()).toEqual([])
  const supportingPages = new Set(before.files.map((file) => `v1/pages/${file.page_id}`))
  expect(f.calls.filter((call) => call.method === "GET" && supportingPages.has(call.path))).toEqual(
    [],
  )
  expect(
    f.calls.filter(
      (call) => call.method === "GET" && call.path.split("?")[0] !== `v1/blocks/${library.library_id}/children` && /^v1\/blocks\/[^/]+\/children(?:\?|$)/u.test(call.path),
    ),
  ).toHaveLength(4)
  expect(f.calls).toHaveLength(28)
})

test("an ordinary repeat automatically resumes the exact accepted append after File query order changes", async () => {
  const { f, written } = await seed()
  f.failNext({ kind: "append", outcome: "accepted" })
  await expect(
    f.run(
      projectCurrentSkill(library, { target: written.page_id, operation_id: "unknown-append" }),
    ),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  expect((await f.run(queryCurrentSkillIndex(library, written.page_id))).state).toEqual({
    state: "ready",
  })
  const pending = await f.run(
    readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id }),
  )
  expect(pending?.intent).toMatchObject({ projection: true, operation_id: "unknown-append" })
  const firstBlocks = structuredClone(f.blocks.get(written.page_id))
  f.clearCalls()
  reverseFileQuery(f)
  const resumed = await f.run(
    projectCurrentSkill(library, {
      target: written.page_id,
      mode: "auto",
    }),
  )
  expect(resumed.operation_id).toBe("unknown-append")
  expect(resumed.counts.unchanged).toBe(1)
  expect(resumed.counts.applied).toBe(3)
  expect(f.blocks.get(written.page_id)).toEqual(firstBlocks)
  expect(
    f.mutations().filter((call) => call.path === `v1/blocks/${written.page_id}/children`),
  ).toEqual([])
  expect((await f.run(queryCurrentSkillIndex(library, written.page_id))).state).toEqual({
    state: "ready",
  })
  expect(
    await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })),
  ).toBeUndefined()
})

test("unknown absent append is never duplicated from absence and never changes consumption readiness", async () => {
  const { f, written } = await seed()
  f.failNext({ kind: "append", outcome: "absent" })
  await expect(
    f.run(projectCurrentSkill(library, { target: written.page_id, operation_id: "absent-append" })),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  f.clearCalls()
  for (const execution of [
    { operation_id: "absent-append", mode: "resume" } as const,
    { mode: "auto" } as const,
  ])
    await expect(
      f.run(projectCurrentSkill(library, { target: written.page_id, ...execution })),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
  expect(f.mutations().filter((call) => call.path.includes("/children"))).toEqual([])
  expect((await f.run(queryCurrentSkillIndex(library, written.page_id))).state).toEqual({
    state: "ready",
  })
})

test("automatic continuation rejects changed policy or content and retains the original recovery policy", async () => {
  for (const change of ["policy", "content"] as const) {
    const { f, written } = await seed()
    f.failNext({ kind: "append", outcome: "accepted" })
    await expect(
      f.run(projectCurrentSkill(library, { target: written.page_id, operation_id: "frozen" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const pending = await f.run(
      readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id }),
    )
    if (change === "content") {
      const index = await f.run(queryCurrentSkillIndex(library, written.page_id))
      const row = f.pages.get(written.page_id)!
      const properties = property(row.properties)
      properties[library.skills.property_ids.Content!] = {
        id: library.skills.property_ids.Content,
        type: "rich_text",
        rich_text: sourceRich(JSON.stringify({ ...index.main.content, sha256: "f".repeat(64) })),
      }
    }
    f.clearCalls()
    await expect(
      f.run(
        projectCurrentSkill(library, {
          target: written.page_id,
          mode: "auto",
          ...(change === "policy" ? { include: ["references/**/*.md"] } : {}),
        }),
      ),
    ).rejects.toMatchObject({
      code: "CURRENT_PROJECTION_CONFLICT",
      details: {
        operation_id: "frozen",
        projection_policy: currentProjectionPolicy({}),
      },
    })
    expect(f.mutations()).toEqual([])
    expect(
      (await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })))
        ?.intent,
    ).toEqual(pending?.intent)
  }
})

test("explicit resume uses the frozen custom policy when filters are omitted", async () => {
  const { f, written } = await seed()
  const policy = { include: ["references/**/*.md"], exclude: [] }
  f.failNext({ kind: "append", outcome: "accepted" })
  await expect(
    f.run(
      projectCurrentSkill(library, {
        target: written.page_id,
        operation_id: "custom-policy",
        ...policy,
      }),
    ),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  f.clearCalls()
  await expect(
    f.run(
      projectCurrentSkill(library, {
        target: written.page_id,
        operation_id: "custom-policy",
        mode: "resume",
      }),
    ),
  ).resolves.toMatchObject({ operation_id: "custom-policy", policy })
  expect(
    f.mutations().filter((call) => call.path === `v1/blocks/${written.page_id}/children`),
  ).toEqual([])
})

test("completed custom projection resume only verifies the supplied policy and cannot start default writes", async () => {
  const { f, written } = await seedSourceReading()
  const policy = { include: ["SKILL.md"], exclude: [] }
  await f.run(
    projectCurrentSkill(library, {
      target: written.page_id,
      operation_id: "completed-custom",
      ...policy,
    }),
  )
  expect(
    await f.run(
      readCurrentOperationIntent(library, {
        kind: "skill",
        id: defaults.skill_id,
      }),
    ),
  ).toBeUndefined()
  f.clearCalls()
  await expect(
    f.run(
      projectCurrentSkill(library, {
        target: written.page_id,
        operation_id: "completed-custom",
        mode: "resume",
      }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_PROJECTION_CONFLICT" })
  expect(f.mutations()).toEqual([])
  await expect(
    f.run(
      projectCurrentSkill(library, {
        target: written.page_id,
        operation_id: "completed-custom",
        mode: "resume",
        ...policy,
      }),
    ),
  ).resolves.toMatchObject({ status: "unchanged", selected: 1, policy })
  expect(f.mutations()).toEqual([])
})

test("automatic projection does not take over an unfinished content operation", async () => {
  const f = currentWriteFixture(parent)
  const plan = await f.run(
    prepareCurrentSkillWrite({
      ...defaults,
      files: [
        { path: "SKILL.md", bytes: testBytes("# Native author"), authority: { kind: "native" } },
      ],
    }),
  )
  f.failNext({ kind: "native-body", outcome: "accepted" })
  await expect(
    f.run(writeCurrentSkill(library, { plan, operation_id: "content-writer" })),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  const pending = await f.run(
    readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id }),
  )
  const target = String(f.table("skills")[0]!.id)
  f.clearCalls()
  await expect(f.run(projectCurrentSkill(library, { target, mode: "auto" }))).rejects.toMatchObject(
    { code: "CURRENT_OPERATION_PENDING" },
  )
  expect(f.mutations()).toEqual([])
  expect(
    (await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })))
      ?.intent,
  ).toEqual(pending?.intent)
})

test("a corrupt cached original is rejected before any projection or finite Record write", async () => {
  const { f, written } = await seed()
  const index = await f.run(queryCurrentSkillIndex(library, written.page_id))
  if (index.main.content.kind !== "resource") throw new Error("Expected a resource main")
  f.objects.set(`objects/${index.main.content.sha256}`, testBytes("corrupt"))
  f.clearCalls()
  await expect(
    f.run(projectCurrentSkill(library, { target: written.page_id, operation_id: "bad-bytes" })),
  ).rejects.toMatchObject({ code: "CURRENT_PROJECTION_CONFLICT" })
  expect(f.mutations()).toEqual([])
})

test("a concurrent native takeover is never overwritten by a prepared text projection", async () => {
  const { f, written } = await seed()
  const index = await f.run(queryCurrentSkillIndex(library, written.page_id))
  const target = index.files.find((file) => file.path === "scripts/run.ts")!
  let changed = false
  f.rewrite((path, response) => {
    if (
      !changed &&
      path.startsWith(`v1/blocks/${written.page_id}/children`) &&
      (f.blocks.get(written.page_id)?.length ?? 0) > 0
    ) {
      changed = true
      const content = property(
        property(f.pages.get(target.page_id)!.properties)[library.files.property_ids.Content!],
      )
      content.rich_text = [
        {
          type: "text",
          text: { content: JSON.stringify({ kind: "native", mode: "100644", frontmatter: "" }) },
        },
      ]
    }
    return response
  })
  await expect(
    f.run(
      projectCurrentSkill(library, { target: written.page_id, operation_id: "native-takeover" }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_PROJECTION_CONFLICT" })
  expect(changed).toBe(true)
  expect(
    f
      .mutations()
      .filter(
        (call) =>
          call.path === `v1/blocks/${target.page_id}/children` ||
          call.path === `v1/pages/${target.page_id}/markdown`,
      ),
  ).toEqual([])
  expect((await f.run(queryCurrentSkillIndex(library, written.page_id))).state).toEqual({
    state: "ready",
  })
})

test("disabled native Skills remain readable without changing their policy or bodies", async () => {
  const { f, written } = await seed({
    ...defaults,
    files: [{ path: "SKILL.md", bytes: testBytes(native), authority: { kind: "native" } }],
  })
  const page = f.pages.get(written.page_id)!
  property(property(page.properties)[library.skills.property_ids.Enabled!]).checkbox = false
  f.clearCalls()
  const result = await f.run(
    projectCurrentSkill(library, { target: written.page_id, operation_id: "native-disabled" }),
  )
  expect(result.counts).toMatchObject({ total: 1, native_verified: 1, applied: 0 })
  expect(result.status).toBe("unchanged")
  expect((await f.run(queryCurrentSkillIndex(library, written.page_id))).enabled).toBe(false)
  expect((await f.run(observeSharedBody(written.page_id))).markdown).toBe(native)
  expect(f.mutations()).toEqual([])
})

test.each(["unchanged", "disabled", "applying", "revision"] as const)(
  "selected Source files recheck current authority after fetching only missing paths: %s",
  async (change) => {
    const f = currentWriteFixture(parent),
      sourcePage = id(90),
      originals = new Map([
        ["upstream/SKILL.md", testBytes("# Source main\n")],
        ["upstream/reference.txt", testBytes("Every source line.\nFINAL\n")],
        ["other-skill/unused.txt", testBytes("Never requested.\n")],
      ])
    const manifest = await f.run(
      Effect.forEach([...originals], ([path, bytes]) =>
        sha256(bytes).pipe(
          Effect.map((hash) => ({
            path,
            sha256: hash,
            bytes: bytes.length,
            mode: "100644" as const,
          })),
        ),
      ),
    )
    const content = validateCurrentSharedSourceContent({
      version: 1,
      plan: {
        version: 1,
        kind: "composition",
        mounts: [],
        base: {
          kind: "http",
          manifest: { version: 1, files: manifest },
          locations: manifest.map((file) => ({
            sha256: file.sha256,
            url: `https://raw.githubusercontent.com/example/skills/${"a".repeat(40)}/${file.path}`,
          })),
        },
      },
    })
    const revision = await f.run(currentSharedSourceRevision(content)),
      fields = library.sources.property_ids,
      rich = (key: string, value: string) => ({
        id: key,
        type: "rich_text",
        rich_text: [{ type: "text", text: { content: value } }],
        has_more: false,
      })
    f.pages.set(sourcePage, {
      object: "page",
      id: sourcePage,
      parent: {
        type: "data_source_id",
        data_source_id: library.sources.data_source_id,
        database_id: library.sources.database_id,
      },
      properties: {
        [fields.Name!]: {
          id: fields.Name,
          type: "title",
          title: [{ type: "text", text: { content: "Source provider" } }],
        },
        [fields.Description!]: rich(fields.Description!, "Current source provider"),
        [fields.Provider!]: { id: fields.Provider, type: "select", select: { name: "git" } },
        [fields.Location!]: rich(fields.Location!, "https://github.com/example/skills"),
        [fields.Ref!]: rich(fields.Ref!, "main"),
        [fields.Policy!]: { id: fields.Policy, type: "select", select: { name: "manual" } },
        [fields.Selection!]: rich(
          fields.Selection!,
          JSON.stringify({ roots: ["upstream"], include: [], exclude: [], mapping: {} }),
        ),
        [fields.Options!]: rich(fields.Options!, "{}"),
        [fields.Contributions!]: rich(
          fields.Contributions!,
          JSON.stringify([
            {
              skill_id: defaults.skill_id,
              member_key: "upstream",
              mount_path: "",
              mapping: {},
              exclude: [],
            },
          ]),
        ),
        [fields["Source ID"]!]: rich(fields["Source ID"]!, "source-provider"),
        [fields.Content!]: rich(fields.Content!, JSON.stringify(content)),
        [fields["Last Revision"]!]: rich(fields["Last Revision"]!, revision),
        [fields.Enabled!]: { id: fields.Enabled, type: "checkbox", checkbox: true },
        [fields.Status!]: { id: fields.Status, type: "select", select: { name: "ready" } },
        [fields.Operation!]: rich(fields.Operation!, ""),
      },
    })
    const sourceFiles = [...originals].slice(0, 2).map(([source_path, bytes]) => ({
      path: source_path.replace("upstream/", ""),
      bytes,
      authority: { kind: "source" as const, source_id: "source-provider", revision, source_path },
    }))
    const plan = await f.run(prepareCurrentSkillWrite({ ...defaults, files: sourceFiles }))
    const written = await f.run(writeCurrentSkill(library, { plan, operation_id: "source-seed" }))
    const downloaded: string[] = []
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const path = new URL(request.url).pathname.split("/").slice(4).join("/")
        downloaded.push(path)
        const bytes = originals.get(path)
        const properties = property(f.pages.get(sourcePage)!.properties)
        if (change === "disabled") property(properties[fields.Enabled!]).checkbox = false
        if (change === "applying") {
          property(properties[fields.Status!]).select = { name: "applying" }
          properties[fields.Operation!] = rich(fields.Operation!, "concurrent-source")
        }
        if (change === "revision")
          properties[fields["Last Revision"]!] = rich(fields["Last Revision"]!, "b".repeat(64))
        return HttpClientResponse.fromWeb(
          request,
          bytes === undefined ? new Response("missing", { status: 404 }) : new Response(bytes),
        )
      }),
    )
    f.objects.set(`objects/${manifest[0]!.sha256}`, originals.get("upstream/SKILL.md")!)
    f.clearCalls()
    if (change !== "unchanged") {
      await expect(
        f.run(
          projectCurrentSkill(library, {
            target: written.page_id,
            operation_id: "source-project",
            include: ["**/*"],
          }).pipe(Effect.provideService(HttpClient.HttpClient, http)),
        ),
      ).rejects.toMatchObject({
        code:
          change === "disabled"
            ? "SOURCE_DISABLED"
            : change === "applying"
              ? "CURRENT_SOURCE_NOT_READY"
              : "SHARED_SOURCE_CONFLICT",
      })
      expect(downloaded).toEqual(["upstream/reference.txt"])
      expect(f.mutations()).toEqual([])
      expect((await f.run(queryCurrentSkillIndex(library, written.page_id))).state).toEqual({
        state: "ready",
      })
      return
    }
    const result = await f.run(
      projectCurrentSkill(library, {
        target: written.page_id,
        operation_id: "source-project",
        include: ["**/*"],
      }).pipe(Effect.provideService(HttpClient.HttpClient, http)),
    )
    expect(result.counts.applied).toBe(2)
    expect(downloaded).toEqual(["upstream/reference.txt"])
    expect(result.files.every((file) => file.authority === "source")).toBe(true)
    expect(
      (await f.run(queryCurrentSkillIndex(library, written.page_id))).main.content,
    ).toMatchObject({ kind: "source", source_id: "source-provider", revision })
  },
)

const sourceCommit = "a".repeat(40)
async function seedSourceReading(
  options: {
    rows?: boolean
    omitGuide?: boolean
    removed?: boolean
    mixed?: boolean
    treeSize?: number
    mainBytes?: Uint8Array
    guideBytes?: Uint8Array
  } = {},
) {
  const f = currentWriteFixture(parent)
  const originals = new Map<string, Uint8Array>([
    [
      "SKILL.md",
      options.mainBytes ??
        testBytes(
          "# Main\n\nRead [guide](references/render.md), [script](scripts/run.ts#L1), and [test](scripts/test/README.md).\n",
        ),
    ],
    [
      "references/render.md",
      options.guideBytes ??
        testBytes(
          "# Rendering\n\n[Main](../SKILL.md) and [script](../scripts/run.ts?plain=1#L2).\n",
        ),
    ],
    ["scripts/run.ts", testBytes("export const exact = 1;\n")],
    ["scripts/test/README.md", testBytes("# Test corpus documentation\n")],
    ["assets/photo.png", new Uint8Array([137, 80, 78, 71, 0, 255])],
  ])
  for (let n = originals.size; n < (options.treeSize ?? originals.size); n++)
    originals.set("scripts/test/corpus/case-" + n + ".dot", testBytes("digraph { a -> b }\n"))
  const manifest = await f.run(
    Effect.forEach([...originals], ([path, bytes]) =>
      sha256(bytes).pipe(
        Effect.map((hash) => ({
          path: "upstream/" + path,
          source_path: "upstream/" + path,
          sha256: hash,
          bytes: bytes.length,
          mode: "100644" as const,
          git_oid: createHash("sha1")
            .update("blob " + bytes.length + "\0")
            .update(bytes)
            .digest("hex"),
        })),
      ),
    ),
  )
  const content = validateCurrentSharedSourceContent({
    version: 1,
    plan: {
      version: 1,
      kind: "composition",
      mounts: [],
      base: {
        kind: "git",
        source: {
          url: "https://github.com/example/skills",
          commit: sourceCommit,
          tree: "b".repeat(40),
          root: "",
          files: manifest,
        },
      },
    },
  })
  const revision = await f.run(currentSharedSourceRevision(content))
  const fields = library.sources.property_ids
  const rich = (name: string, value: string, kind = "rich_text") => ({
    id: fields[name],
    type: kind,
    [kind]: sourceRich(value),
    has_more: false,
  })
  const select = (name: string, value: string) => ({
    id: fields[name],
    type: "select",
    select: { name: value },
  })
  const properties = {
    [fields.Name!]: rich("Name", "Source reading", "title"),
    [fields.Description!]: rich("Description", "Source reading fixture"),
    [fields["Source ID"]!]: rich("Source ID", "reading-source"),
    [fields.Provider!]: select("Provider", "git"),
    [fields.Location!]: rich("Location", "https://github.com/example/skills"),
    [fields.Ref!]: rich("Ref", "main"),
    [fields.Policy!]: select("Policy", "manual"),
    [fields.Selection!]: rich(
      "Selection",
      JSON.stringify({ roots: ["upstream"], include: [], exclude: [], mapping: {} }),
    ),
    [fields.Options!]: rich("Options", "{}"),
    [fields.Contributions!]: rich(
      "Contributions",
      JSON.stringify([
        {
          skill_id: defaults.skill_id,
          member_key: "upstream",
          mount_path: "",
          mapping: {},
          exclude: [],
        },
      ]),
    ),
    [fields.Content!]: rich("Content", JSON.stringify(content)),
    [fields["Last Revision"]!]: rich("Last Revision", revision),
    [fields.Enabled!]: { id: fields.Enabled, type: "checkbox", checkbox: true },
    [fields.Status!]: select("Status", "ready"),
    [fields.Operation!]: rich("Operation", ""),
  }
  const sourcePage = id(90)
  f.pages.set(sourcePage, {
    object: "page",
    id: sourcePage,
    parent: {
      type: "data_source_id",
      data_source_id: library.sources.data_source_id,
      database_id: library.sources.database_id,
    },
    properties,
  })
  const mainFile = {
    path: "SKILL.md",
    bytes: testBytes("# Fixture owner\n"),
  }
  const plan = await f.run(
    prepareCurrentSkillWrite({
      ...defaults,
      files: [
        mainFile,
        ...(options.mixed
          ? [
              {
                path: "notes/custom.txt",
                bytes: testBytes(native),
                authority: { kind: "native" as const },
              },
              { path: "notes/local.config", bytes: testBytes("Complete resource.\n") },
            ]
          : []),
      ],
    }),
  )
  const written = await f.run(
    writeCurrentSkill(library, { plan, operation_id: "source-reading-seed" }),
  )
  const fileIds = library.files.property_ids
  const descriptor = (file: (typeof manifest)[number]) => ({
    kind: "source" as const,
    source_id: "reading-source",
    revision,
    source_path: file.path,
    sha256: file.sha256,
    bytes: file.bytes,
    mode: file.mode,
  })
  property(
    property(f.pages.get(written.page_id)!.properties)[library.skills.property_ids.Content!],
  ).rich_text = sourceRich(JSON.stringify(descriptor(manifest[0]!)))
  function addRow(path: string, encoded: ReturnType<typeof descriptor>, n: number) {
    const page = id(1000 + n)
    const rich = (name: string, value: string, kind = "rich_text") => ({
      id: fileIds[name],
      type: kind,
      [kind]: sourceRich(value),
      has_more: false,
    })
    f.pages.set(page, {
      object: "page",
      id: page,
      archived: false,
      in_trash: false,
      last_edited_time: "2026-11-21T00:00:00.000Z",
      parent: {
        type: "data_source_id",
        data_source_id: library.files.data_source_id,
        database_id: library.files.database_id,
      },
      properties: {
        [fileIds.Name!]: rich("Name", path, "title"),
        [fileIds["File ID"]!]: rich("File ID", "reading-file-" + n),
        [fileIds.Path!]: rich("Path", path),
        [fileIds.Content!]: rich("Content", JSON.stringify(encoded)),
        [fileIds.Skill!]: {
          id: fileIds.Skill,
          type: "relation",
          relation: [{ id: written.page_id }],
          has_more: false,
        },
      },
    })
    f.blocks.set(page, [])
    return page
  }
  for (const [n, file] of manifest.entries()) {
    const path = file.path.slice("upstream/".length)
    f.objects.set("objects/" + file.sha256, originals.get(path)!)
    if (
      options.rows !== false &&
      path !== "SKILL.md" &&
      !(options.omitGuide && path === "references/render.md")
    )
      addRow(path, descriptor(file), n)
  }
  if (options.removed)
    addRow(
      "removed/old.md",
      { ...descriptor(manifest[1]!), source_path: "upstream/removed/old.md" },
      800,
    )
  f.clearCalls()
  return { f, written, originals, sourcePage, revision, manifest }
}

test.each(["resource", "source"] as const)(
  "%s entrypoint replaces old YAML heading projections without changing metadata, originals or native files, then writes nothing",
  async (authority) => {
    const original = testBytes(
      "\uFEFF---\r\nname: why\r\ndescription: Explain decisions from their original evidence.\r\ndisable-model-invocation: true\r\nmetadata:\r\n  owner: human\r\n---\r\n\r\n# Why\r\n\r\nAnswer from the record.\r\n",
    )
    const guide = testBytes(
      "---\nname: supporting-document\ndescription: Reference metadata stays visible.\n---\n\n# Evidence\n\nKeep the complete reference.\n",
    )
    const sourceFixture =
      authority === "source"
        ? await seedSourceReading({
            rows: false,
            mixed: true,
            mainBytes: original,
            guideBytes: guide,
          })
        : undefined
    const { f, written } =
      sourceFixture ??
      (await seed({
        ...defaults,
        files: [
          { path: "SKILL.md", bytes: original, mode: "100755" },
          { path: "references/render.md", bytes: guide },
          {
            path: "notes/author.md",
            bytes: testBytes(
              "---\nname: author\ndescription: Author-owned metadata.\n---\n\n" + native,
            ),
            authority: { kind: "native" },
          },
        ],
      }))
    const oldPlan = renderCurrentProjection({
      role: "supporting",
      path: "old-reading.md",
      bytes: original,
    })
    expect(oldPlan.blocks.map((block) => block.type).slice(0, 3)).toEqual([
      "divider",
      "heading_2",
      "heading_1",
    ])
    f.blocks.set(
      written.page_id,
      oldPlan.blocks.map((block, n) => ({
        ...block,
        id: id(9000 + n),
        parent: { type: "page_id", page_id: written.page_id },
        has_children: false,
        archived: false,
        in_trash: false,
      })),
    )
    const before = await f.run(queryCurrentSkillIndex(library, written.page_id))
    expect(before.main.content.kind).toBe(authority)
    const ownerBefore = structuredClone(f.pages.get(written.page_id)!.properties)
    const sourceBefore =
      sourceFixture === undefined
        ? undefined
        : structuredClone(f.pages.get(sourceFixture.sourcePage))
    const authored = await Promise.all(
      before.files
        .filter((file) => file.content.kind === "native")
        .map(async (file) => ({
          page_id: file.page_id,
          content: file.content,
          body: (await f.run(observeSharedBody(file.page_id))).markdown,
        })),
    )
    const snapshotInput = {
      library,
      target: written.page_id,
      scope: "a".repeat(64),
      startedAt: Date.now(),
      forceFull: true,
    }
    const snapshotBefore = await f.run(openSharedSnapshot(snapshotInput))
    f.clearCalls()
    const dry = await f.run(
      projectCurrentSkill(library, {
        target: written.page_id,
        operation_id: "frontmatter-inspect",
        dry_run: true,
      }),
    )
    expect(dry.files.find((file) => file.path === "SKILL.md")).toMatchObject({
      authority,
      status: "would_write",
    })
    expect(f.mutations()).toEqual([])
    const applied = await f.run(
      projectCurrentSkill(library, { target: written.page_id, operation_id: "frontmatter-fix" }),
    )
    expect(applied.files.find((file) => file.path === "SKILL.md")).toMatchObject({
      authority,
      status: "applied",
    })
    expect(f.blocks.get(written.page_id)?.map((block) => block.type)).toEqual([
      "heading_1",
      "paragraph",
    ])
    expect(blockText(f.blocks.get(written.page_id) ?? [])).toBe("WhyAnswer from the record.")
    expect(
      f.mutations().filter((call) => call.path === `v1/pages/${written.page_id}/markdown`),
    ).toHaveLength(1)
    const after = await f.run(queryCurrentSkillIndex(library, written.page_id))
    const supporting = after.files.find((file) => file.path === "references/render.md")!
    expect(blockText(f.blocks.get(supporting.page_id) ?? [])).toContain(
      "Reference metadata stays visible.",
    )
    expect(f.pages.get(written.page_id)!.properties).toEqual(ownerBefore)
    expect(after.main.content).toEqual(before.main.content)
    if (sourceFixture !== undefined)
      expect(f.pages.get(sourceFixture.sourcePage)).toEqual(sourceBefore)
    for (const file of authored) {
      expect(after.files.find((current) => current.page_id === file.page_id)?.content).toEqual(
        file.content,
      )
      expect((await f.run(observeSharedBody(file.page_id))).markdown).toBe(file.body)
    }
    const snapshotAfter = await f.run(
      openSharedSnapshot({ ...snapshotInput, startedAt: Date.now() }),
    )
    expect(snapshotAfter.snapshot_id).toBe(snapshotBefore.snapshot_id)
    expect(snapshotAfter.files).toEqual(snapshotBefore.files)
    const consumedMain = snapshotAfter.files.find((file) => file.path === "SKILL.md")!
    const consumedGuide = snapshotAfter.files.find((file) => file.path === "references/render.md")!
    expect(f.objects.get("objects/" + consumedMain.sha256)).toEqual(original)
    expect(f.objects.get("objects/" + consumedGuide.sha256)).toEqual(guide)
    f.clearCalls()
    const repeat = await f.run(
      projectCurrentSkill(library, { target: written.page_id, operation_id: "frontmatter-repeat" }),
    )
    expect(repeat.status).toBe("unchanged")
    expect(repeat.input_sha256).toBe(applied.input_sha256)
    expect(f.mutations()).toEqual([])
  },
)

test("a Router hides only its main frontmatter and preserves a root SKILL.md supporting file", async () => {
  const router = testBytes(
    "---\nname: decision-router\ndescription: Choose a decision workflow.\n---\n\n# Decisions\n\nRead the selected workflow.\n",
  )
  const supporting = testBytes(
    "---\nname: supporting-skill\ndescription: This is reference content, not the Router metadata.\ndisable-model-invocation: true\n---\n\n# Reference Skill\n\nKeep these instructions.\n",
  )
  const { f, written } = await seed({
    ...defaults,
    kind: "router",
    files: [
      { path: "ROUTER.md", bytes: router },
      { path: "SKILL.md", bytes: supporting },
    ],
  })
  const before = await f.run(queryCurrentSkillIndex(library, written.page_id))
  expect(before.main.path).toBe("ROUTER.md")
  const supportingFile = before.files.find((file) => file.path === "SKILL.md")!
  expect(supportingFile.page_id).not.toBe(written.page_id)
  await f.run(
    projectCurrentSkill(library, { target: written.page_id, operation_id: "router-frontmatter" }),
  )
  expect(blockText(f.blocks.get(written.page_id) ?? [])).toBe(
    "DecisionsRead the selected workflow.",
  )
  const supportingBody = blockText(f.blocks.get(supportingFile.page_id) ?? [])
  expect(supportingBody).toContain("name: supporting-skill")
  expect(supportingBody).toContain("This is reference content, not the Router metadata.")
  expect(supportingBody).toContain("disable-model-invocation: true")
  expect(supportingBody).toContain("Keep these instructions.")
  expect(logical(await f.run(queryCurrentSkillIndex(library, written.page_id)))).toEqual(
    logical(before),
  )
  f.clearCalls()
  expect(
    await f.run(
      projectCurrentSkill(library, { target: written.page_id, operation_id: "router-repeat" }),
    ),
  ).toMatchObject({ status: "unchanged" })
  expect(f.mutations()).toEqual([])
})

test("an unfinished pre-frontmatter projection keeps its fingerprint and cannot resume or cancel with changed requests", async () => {
  const original = testBytes("---\nname: why\ndescription: Original description.\n---\n\n# Why\n")
  const { f, written } = await seed({
    ...defaults,
    files: [{ path: "SKILL.md", bytes: original }],
  })
  const index = await f.run(queryCurrentSkillIndex(library, written.page_id))
  const consumption = await f.run(resolveCurrentSkillConsumption(library, index))
  const policy = currentProjectionPolicy({})
  const inputHash = await f.run(
    sha256(
      canonicalSharedJson({
        purpose: "current_text_projection",
        version: 1,
        owner: {
          skill_id: index.skill_id,
          page_id: index.page_id,
          main_file_id: index.main.file_id,
          main: index.main.path,
        },
        consumption: canonicalSharedJson({
          files: consumption.files,
          source_fingerprint: consumption.source_fingerprint,
        }),
        policy,
      }),
    ),
  )
  const current = await f.run(
    projectCurrentSkill(library, {
      target: written.page_id,
      operation_id: "new-renderer-inspect",
      dry_run: true,
    }),
  )
  expect(current.input_sha256).not.toBe(inputHash)
  const oldPlan = {
    ...renderCurrentProjection({ role: "supporting", path: "old-reading.md", bytes: original }),
    path: "SKILL.md",
  }
  f.failNext({ kind: "append", outcome: "accepted" })
  await expect(
    f.run(
      withCurrentOperation(library, {
        intent: {
          operation_id: "old-frontmatter-projection",
          input_sha256: inputHash,
          owner: { kind: "skill", id: index.skill_id },
          projection: true,
          policy,
        },
        ownerPageId: index.page_id,
        run: (session) =>
          applyCurrentProjection<Notion | Crypto.Crypto | Store>({
            pageId: index.page_id,
            content: index.main.content,
            plan: oldPlan,
            assertCurrent: Effect.void,
            dispatch: session.dispatch,
          }),
        verify: () => Effect.void,
      }),
    ),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  const pending = await f.run(
    readCurrentOperationIntent(library, { kind: "skill", id: index.skill_id }),
  )
  expect(pending?.intent.input_sha256).toBe(inputHash)
  const bodies = structuredClone([...f.blocks])
  f.clearCalls()
  for (const execution of [
    { operation_id: "old-frontmatter-projection", mode: "resume" } as const,
    { mode: "auto" } as const,
  ])
    await expect(
      f.run(projectCurrentSkill(library, { target: written.page_id, ...execution })),
    ).rejects.toMatchObject({ code: "CURRENT_PROJECTION_CONFLICT" })
  await expect(
    f.run(
      cancelCurrentSkillProjection(library, {
        target: written.page_id,
        operation_id: "old-frontmatter-projection",
      }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_OPERATION_CONFLICT" })
  expect(f.mutations()).toEqual([])
  expect([...f.blocks]).toEqual(bodies)
  expect(
    await f.run(readCurrentOperationIntent(library, { kind: "skill", id: index.skill_id })),
  ).toEqual(pending)
})

test("a 410-file source tree plans only its two reading documents and archives excluded rows", async () => {
  const { f, written } = await seedSourceReading({ treeSize: 410 })
  const dry = await f.run(
    projectCurrentSkill(library, {
      target: written.page_id,
      operation_id: "docs-dry",
      dry_run: true,
    }),
  )
  expect(dry.full_tree_total).toBe(410)
  expect(dry.files.map((file) => file.path)).toEqual(["SKILL.md", "references/render.md"])
  expect(dry.counts).toMatchObject({
    selected: 2,
    excluded: 408,
    skipped_binary: 0,
    would_archive: 408,
    would_create: 0,
    would_write: 2,
  })
  expect(dry.excluded.find((file) => file.path === "scripts/test/README.md")).toMatchObject({
    reason: "excluded_by_pattern",
  })
  expect(dry.excluded.find((file) => file.path === "scripts/run.ts")).toEqual({
    path: "scripts/run.ts",
    reason: "not_included",
  })
  expect(f.mutations()).toEqual([])
})

test("sparse source reading creates docs, removes obsolete rows, preserves Notion-owned files and uses fixed upstream links", async () => {
  const { f, written, sourcePage } = await seedSourceReading({
    omitGuide: true,
    removed: true,
    mixed: true,
  })
  const before = await f.run(queryCurrentSkillIndex(library, written.page_id))
  const consumptionBefore = await f.run(resolveCurrentSkillConsumption(library, before))
  const sourceBefore = structuredClone(f.pages.get(sourcePage))
  f.clearCalls()
  const applied = await f.run(
    projectCurrentSkill(library, { target: written.page_id, operation_id: "docs-apply" }),
  )
  expect(applied.counts).toMatchObject({
    selected: 4,
    excluded: 3,
    created: 1,
    archived: 4,
    native_verified: 1,
    skipped_binary: 0,
    applied: 3,
  })
  expect(applied.rows.find((row) => row.path === "removed/old.md")).toMatchObject({
    status: "archived",
    reason: "upstream_removed",
  })
  const after = await f.run(queryCurrentSkillIndex(library, written.page_id))
  expect(after.files.map((file) => file.path).sort()).toEqual([
    "notes/custom.txt",
    "notes/local.config",
    "references/render.md",
  ])
  const sourceAfter = await f.run(resolveCurrentSkillConsumption(library, after))
  expect(sourceAfter.files).toEqual(consumptionBefore.files)
  expect(sourceAfter.source_fingerprint).toBe(consumptionBefore.source_fingerprint)
  expect(f.pages.get(sourcePage)).toEqual(sourceBefore)
  const nativeBefore = before.files.find((file) => file.path === "notes/custom.txt")!
  const resourceBefore = before.files.find((file) => file.path === "notes/local.config")!
  expect(after.files.find((file) => file.path === nativeBefore.path)?.page_id).toBe(
    nativeBefore.page_id,
  )
  expect(after.files.find((file) => file.path === resourceBefore.path)?.file_id).toBe(
    resourceBefore.file_id,
  )
  expect((await f.run(observeSharedBody(nativeBefore.page_id))).markdown).toBe(native)
  const guide = after.files.find((file) => file.path === "references/render.md")!
  const mainBody = JSON.stringify(f.blocks.get(written.page_id))
  expect(mainBody).toContain("https://www.notion.so/" + guide.page_id.replaceAll("-", ""))
  expect(mainBody).toContain(
    "https://github.com/example/skills/blob/" + sourceCommit + "/upstream/scripts/run.ts#L1",
  )
  expect(mainBody).toContain(
    "https://github.com/example/skills/blob/" + sourceCommit + "/upstream/scripts/test/README.md",
  )
  const guideBody = JSON.stringify(f.blocks.get(guide.page_id))
  expect(guideBody).toContain("https://www.notion.so/" + written.page_id.replaceAll("-", ""))
  expect(guideBody).toContain("/upstream/scripts/run.ts?plain=1#L2")
  f.clearCalls()
  const repeat = await f.run(
    projectCurrentSkill(library, { target: written.page_id, operation_id: "docs-repeat" }),
  )
  expect(repeat.input_sha256).toBe(applied.input_sha256)
  expect(repeat.status).toBe("unchanged")
  expect(repeat.counts).toMatchObject({
    created: 0,
    archived: 0,
    updated: 0,
    applied: 0,
    unchanged: 3,
  })
  expect(f.mutations()).toEqual([])
})

test("ordinary projection replaces a deleted selected Source File and remaps links while preserving Notion authority", async () => {
  const { f, written, sourcePage } = await seedSourceReading({ rows: false, mixed: true })
  const project = () =>
    f.run(projectCurrentSkill(library, { target: written.page_id, mode: "auto" }))
  await project()
  const ownerProperties = property(f.pages.get(written.page_id)!.properties)
  property(ownerProperties[library.skills.property_ids.Enabled!]).checkbox = false
  property(ownerProperties[library.skills.property_ids["Default Context"]!]).checkbox = true
  ownerProperties.daily = { id: "daily", type: "checkbox", checkbox: true }
  ownerProperties.delete = { id: "delete", type: "checkbox", checkbox: true }
  const ownerBefore = structuredClone(ownerProperties)
  const sourceBefore = structuredClone(f.pages.get(sourcePage))
  const before = await f.run(queryCurrentSkillIndex(library, written.page_id))
  const consumed = await f.run(resolveCurrentSkillConsumption(library, before))
  const guide = before.files.find((file) => file.path === "references/render.md")!
  const owned = before.files.filter((file) => file.content.kind !== "source")
  const ownedBefore = owned.map((file) => structuredClone(f.pages.get(file.page_id)))
  const nativeFile = owned.find((file) => file.content.kind === "native")!
  const nativeBefore = await f.run(observeSharedBody(nativeFile.page_id))
  const oldLink = "https://www.notion.so/" + guide.page_id.replaceAll("-", "")
  expect(JSON.stringify(f.blocks.get(written.page_id))).toContain(oldLink)
  f.pages.get(guide.page_id)!.in_trash = true
  f.clearCalls()
  const replaced = await project()
  expect(replaced.counts).toMatchObject({ created: 1, applied: 2, native_verified: 1 })
  const after = await f.run(queryCurrentSkillIndex(library, written.page_id))
  const replacement = after.files.find((file) => file.path === guide.path)!
  expect(replacement.file_id).toBe(guide.file_id)
  expect(replacement.page_id).not.toBe(guide.page_id)
  expect(JSON.stringify(f.blocks.get(written.page_id))).not.toContain(oldLink)
  expect(JSON.stringify(f.blocks.get(written.page_id))).toContain(
    "https://www.notion.so/" + replacement.page_id.replaceAll("-", ""),
  )
  expect(JSON.stringify(f.blocks.get(replacement.page_id))).toContain(
    "https://www.notion.so/" + written.page_id.replaceAll("-", ""),
  )
  expect(after.files.filter((file) => file.content.kind !== "source")).toEqual(owned)
  expect(owned.map((file) => f.pages.get(file.page_id))).toEqual(ownedBefore)
  expect(await f.run(observeSharedBody(nativeFile.page_id))).toMatchObject({
    markdown: nativeBefore.markdown,
    fingerprint: nativeBefore.fingerprint,
  })
  expect(f.pages.get(written.page_id)!.properties).toEqual(ownerBefore)
  expect(f.pages.get(sourcePage)).toEqual(sourceBefore)
  const consumedAfter = await f.run(resolveCurrentSkillConsumption(library, after))
  expect(consumedAfter.files).toEqual(consumed.files)
  expect(consumedAfter.source_fingerprint).toBe(consumed.source_fingerprint)
  expect(
    await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })),
  ).toBeUndefined()
  f.clearCalls()
  expect(await project()).toMatchObject({ status: "unchanged" })
  expect(f.mutations()).toEqual([])
})

test("restore rebuilds sparse reading bodies for all 410 consumed files while preserving exact identity and human flags", async () => {
  const { f, written, sourcePage } = await seedSourceReading({ rows: false, treeSize: 410 })
  await f.run(projectCurrentSkill(library, { target: written.page_id, mode: "auto" }))
  const owner = f.pages.get(written.page_id)!
  const ownerProperties = property(owner.properties)
  property(ownerProperties[library.skills.property_ids.Enabled!]).checkbox = false
  property(ownerProperties[library.skills.property_ids["Default Context"]!]).checkbox = true
  ownerProperties.daily = { id: "daily", type: "checkbox", checkbox: true }
  ownerProperties.delete = { id: "delete", type: "checkbox", checkbox: true }
  const before = await f.run(queryCurrentSkillIndex(library, written.page_id))
  const consumed = await f.run(resolveCurrentSkillConsumption(library, before))
  expect(consumed.files).toHaveLength(410)
  const sourceBefore = structuredClone(f.pages.get(sourcePage))
  const propertiesBefore = structuredClone(owner.properties)
  const guide = before.files.find((file) => file.path === "references/render.md")!
  f.blocks.set(written.page_id, [])
  f.blocks.set(guide.page_id, [])
  owner.in_trash = true
  // The support page still exists, but Notion hides this owner relation until
  // restoration. The temporary empty query is not a complete consumption tree.
  expect(f.pages.get(guide.page_id)!.in_trash).toBe(false)
  expect(
    (
      await f.run(
        queryCurrentFilesForSkills({
          dataSourceId: library.files.data_source_id,
          skillPageIds: [written.page_id],
          propertyIds: library.files.property_ids,
        }),
      )
    ).get(written.page_id),
  ).toEqual([])
  f.clearCalls()
  const restored = await f.run(restoreCurrentSkillProjection(library, { target: written.page_id }))
  expect(restored).toMatchObject({
    status: "applied",
    restoration: { status: "restored" },
    full_tree_total: 410,
    counts: { applied: 2, selected: 2, created: 0, archived: 0 },
  })
  const after = await f.run(queryCurrentSkillIndex(library, written.page_id))
  expect(logical(after)).toEqual(logical(before))
  expect(owner.properties).toEqual(propertiesBefore)
  expect(f.pages.get(sourcePage)).toEqual(sourceBefore)
  const consumedAfter = await f.run(resolveCurrentSkillConsumption(library, after))
  expect(consumedAfter.files).toEqual(consumed.files)
  expect(consumedAfter.source_fingerprint).toBe(consumed.source_fingerprint)
  expect(blockText(f.blocks.get(written.page_id)!)).toContain("Read guide, script, and test.")
  expect(JSON.stringify(f.blocks.get(written.page_id))).toContain(
    "https://www.notion.so/" + guide.page_id.replaceAll("-", ""),
  )
  expect(JSON.stringify(f.blocks.get(guide.page_id))).toContain(
    "https://www.notion.so/" + written.page_id.replaceAll("-", ""),
  )
  expect(f.mutations().filter((call) => call.path === `v1/pages/${written.page_id}`)).toEqual([
    { path: `v1/pages/${written.page_id}`, method: "PATCH", body: { in_trash: false } },
  ])
  expect(
    await f.run(readCurrentOperationIntent(library, { kind: "skill", id: before.skill_id })),
  ).toBeUndefined()
  f.clearCalls()
  expect(
    await f.run(restoreCurrentSkillProjection(library, { target: written.page_id })),
  ).toMatchObject({
    status: "unchanged",
    restoration: { status: "unchanged" },
  })
  expect(f.mutations()).toEqual([])
})

test("restore waits for the live identity query after a successful untrash without repeating it", async () => {
  const { f, written } = await seedSourceReading({ rows: false })
  await f.run(projectCurrentSkill(library, { target: written.page_id, mode: "auto" }))
  const before = await f.run(queryCurrentSkillIndex(library, written.page_id))
  f.blocks.set(written.page_id, [])
  f.pages.get(written.page_id)!.in_trash = true
  f.clearCalls()
  let hidden = 0
  f.rewrite((path, response) => {
    if (
      path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`) &&
      f.pages.get(written.page_id)!.in_trash === false &&
      hidden < 2
    ) {
      hidden += 1
      return { ...response, results: [], has_more: false, next_cursor: null }
    }
    return response
  })
  const restored = await f.run(restoreCurrentSkillProjection(library, { target: written.page_id }))
  expect(restored).toMatchObject({ status: "applied", restoration: { status: "restored" } })
  expect(hidden).toBe(2)
  expect(logical(await f.run(queryCurrentSkillIndex(library, written.page_id)))).toEqual(
    logical(before),
  )
  expect(blockText(f.blocks.get(written.page_id)!)).toContain("Read guide, script, and test.")
  expect(f.mutations().filter((call) => call.path === `v1/pages/${written.page_id}`)).toEqual([
    { path: `v1/pages/${written.page_id}`, method: "PATCH", body: { in_trash: false } },
  ])
  expect(
    await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })),
  ).toBeUndefined()
})

test("restore bounds a permanently absent live identity query and retains the original action", async () => {
  const { f, written } = await seedSourceReading({ rows: false })
  f.pages.get(written.page_id)!.in_trash = true
  let observations = 0
  f.rewrite((path, response) => {
    if (
      path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`) &&
      f.pages.get(written.page_id)!.in_trash === false
    ) {
      observations += 1
      return { ...response, results: [], has_more: false, next_cursor: null }
    }
    return response
  })
  const error = await f.run(
    Effect.flip(restoreCurrentSkillProjection(library, { target: written.page_id })),
  )
  expect(error).toMatchObject({
    code: "WRITE_OUTCOME_UNKNOWN",
    details: { cause_code: "CURRENT_PROJECTION_RESTORE_CONFLICT", action: "$owner.restore" },
  })
  expect(observations).toBe(5)
  expect(f.mutations().filter((call) => call.path === `v1/pages/${written.page_id}`)).toEqual([
    { path: `v1/pages/${written.page_id}`, method: "PATCH", body: { in_trash: false } },
  ])
  const pending = await f.run(
    readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id }),
  )
  expect(pending?.intent).toMatchObject({
    operation_id: property(error.details).operation_id,
    input_sha256: property(error.details).input_sha256,
    restore: { page_id: written.page_id, policy: currentProjectionPolicy({}) },
  })
  expect(f.blocks.get(written.page_id)).toEqual([])
})

test.each(["foreign", "duplicate", "main-identity", "source-applying", "partial-query"] as const)(
  "restore stops immediately when %s appears during live identity convergence",
  async (change) => {
    const { f, written, sourcePage } = await seedSourceReading({ rows: false })
    const owner = f.pages.get(written.page_id)!
    owner.in_trash = true
    let observations = 0
    f.rewrite((path, response) => {
      if (
        !path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`) ||
        owner.in_trash !== false
      )
        return response
      observations += 1
      if (observations === 1) {
        if (change === "main-identity")
          property(
            property(owner.properties)[library.skills.property_ids["Main File ID"]!],
          ).rich_text = sourceRich("changed-main-identity")
        return { ...response, results: [], has_more: false, next_cursor: null }
      }
      if (change === "foreign" || change === "duplicate") {
        const competitor = { ...structuredClone(owner), id: id(8000) }
        return {
          ...response,
          results: change === "foreign" ? [competitor] : [structuredClone(owner), competitor],
        }
      }
      if (change === "source-applying") {
        const fields = property(f.pages.get(sourcePage)!.properties)
        property(fields[library.sources.property_ids.Status!]).select = { name: "applying" }
        property(fields[library.sources.property_ids.Operation!]).rich_text =
          sourceRich("other-writer")
      }
      if (change === "partial-query")
        return { ...response, results: [], request_status: { type: "incomplete" } }
      return response
    })
    const error = await f.run(
      Effect.flip(restoreCurrentSkillProjection(library, { target: written.page_id })),
    )
    expect(error).toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
      details: { action: "$owner.restore" },
    })
    expect(observations).toBe(2)
    expect(f.mutations().filter((call) => call.path === `v1/pages/${written.page_id}`)).toEqual([
      { path: `v1/pages/${written.page_id}`, method: "PATCH", body: { in_trash: false } },
    ])
    const pending = await f.run(
      readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id }),
    )
    expect(pending?.intent).toMatchObject({ operation_id: property(error.details).operation_id })
    expect(f.blocks.get(written.page_id)).toEqual([])
  },
)

test.each(["deadline", "cancellation"] as const)(
  "restore stops its read-only visibility wait on %s with the action retained",
  async (stop) => {
    const { f, written } = await seedSourceReading({ rows: false })
    f.pages.get(written.page_id)!.in_trash = true
    let observations = 0
    f.rewrite((path, response) => {
      if (
        path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`) &&
        f.pages.get(written.page_id)!.in_trash === false
      ) {
        observations += 1
        return { ...response, results: [], has_more: false, next_cursor: null }
      }
      return response
    })
    await f.run(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          const waiting = yield* Latch.make(false)
          const observedClock: Clock.Clock = {
            ...clock,
            sleep: (duration) =>
              Effect.gen(function* () {
                if (Duration.toMillis(duration) === 1000) yield* waiting.open
                yield* clock.sleep(duration)
              }),
          }
          const task = yield* Effect.forkChild(
            withCurrentInvocationBudget(
              restoreCurrentSkillProjection(library, { target: written.page_id }),
              { duration_ms: 50 },
            ).pipe(Effect.result, Effect.provideService(Clock.Clock, observedClock)),
            { startImmediately: true },
          )
          yield* waiting.await
          if (stop === "deadline") {
            yield* clock.adjust(50)
            const result = yield* Fiber.join(task)
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: {
                code: "WRITE_OUTCOME_UNKNOWN",
                details: {
                  cause_code: "REQUEST_BUDGET_EXHAUSTED",
                  budget: { limits: { duration_ms: 50 }, exhausted: "duration" },
                },
              },
            })
          } else {
            yield* Fiber.interrupt(task)
            expect(Exit.hasInterrupts(yield* Fiber.await(task))).toBe(true)
          }
        }),
      ),
    )
    expect(observations).toBe(1)
    expect(f.mutations().filter((call) => call.path === `v1/pages/${written.page_id}`)).toEqual([
      { path: `v1/pages/${written.page_id}`, method: "PATCH", body: { in_trash: false } },
    ])
    expect(
      (await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })))
        ?.intent,
    ).toHaveProperty("restore")
    expect(f.blocks.get(written.page_id)).toEqual([])
  },
)

test("restore does not wait for a missing live identity before any successful untrash", async () => {
  const { f, written } = await seedSourceReading({ rows: false })
  let observations = 0
  f.rewrite((path, response) => {
    if (path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`)) {
      observations += 1
      return { ...response, results: [], has_more: false, next_cursor: null }
    }
    return response
  })
  await expect(
    f.run(restoreCurrentSkillProjection(library, { target: written.page_id })),
  ).rejects.toMatchObject({ code: "CURRENT_PROJECTION_RESTORE_CONFLICT" })
  expect(observations).toBe(1)
  expect(f.mutations()).toEqual([])
})

test("restore and projection spend one uninterrupted outer invocation allowance", async () => {
  const { f, written } = await seedSourceReading({ rows: false })
  f.pages.get(written.page_id)!.in_trash = true
  const identities = new Set<string>()
  const attempts: number[] = []
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* withCurrentInvocationBudget(
        restoreCurrentSkillProjection(library, { target: written.page_id }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              Effect.gen(function* () {
                const active = yield* Effect.serviceOption(RequestBudget)
                if (Option.isNone(active))
                  return yield* Effect.fail(fail("TEST_BUDGET", "Missing shared allowance."))
                const budget = active.value
                identities.add(budget.identity)
                attempts.push((yield* budget.snapshot).attempts)
                yield* budget.admit(0)
                return yield* api.request(path, body, options)
              }),
          }),
        ),
        { requests: 1000, bytes: 1000000, duration_ms: 30000 },
      )
    }),
  )
  expect(result.result.restoration.status).toBe("restored")
  expect(result.result.counts.applied).toBe(2)
  expect(identities.size).toBe(1)
  expect(attempts).toEqual(Array.from({ length: attempts.length }, (_, index) => index))
  expect(result.budget.attempts).toBe(attempts.length)
})

test("restore keeps mixed native and resource authority while rebuilding its Source reading", async () => {
  const { f, written } = await seedSourceReading({ rows: false, mixed: true })
  await f.run(projectCurrentSkill(library, { target: written.page_id, mode: "auto" }))
  const before = await f.run(queryCurrentSkillIndex(library, written.page_id))
  const nativeFile = before.files.find((file) => file.path === "notes/custom.txt")!
  const nativeBefore = await f.run(observeSharedBody(nativeFile.page_id))
  const resource = before.files.find((file) => file.path === "notes/local.config")!
  const resourceBefore = structuredClone(f.pages.get(resource.page_id))
  f.blocks.set(written.page_id, [])
  f.pages.get(written.page_id)!.in_trash = true
  f.clearCalls()
  await f.run(restoreCurrentSkillProjection(library, { target: written.page_id }))
  expect(logical(await f.run(queryCurrentSkillIndex(library, written.page_id)))).toEqual(
    logical(before),
  )
  expect(await f.run(observeSharedBody(nativeFile.page_id))).toMatchObject({
    markdown: nativeBefore.markdown,
    fingerprint: nativeBefore.fingerprint,
  })
  expect(f.pages.get(resource.page_id)).toEqual(resourceBefore)
  expect(f.mutations().some((call) => call.path.includes(nativeFile.page_id))).toBe(false)
})

test.each(["accepted", "absent"] as const)(
  "restore reconciles a %s untrash ACK through the same command",
  async (outcome) => {
    const { f, written } = await seedSourceReading({ rows: false })
    await f.run(projectCurrentSkill(library, { target: written.page_id, mode: "auto" }))
    f.blocks.set(written.page_id, [])
    f.pages.get(written.page_id)!.in_trash = true
    f.failNext({ kind: "skill-restore", outcome })
    await expect(
      f.run(restoreCurrentSkillProjection(library, { target: written.page_id })),
    ).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
      details: { restore: true, skill_page_id: written.page_id },
    })
    const pending = await f.run(
      readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id }),
    )
    expect(pending?.intent).toMatchObject({
      restore: { page_id: written.page_id, policy: currentProjectionPolicy({}) },
    })
    f.clearCalls()
    const result = await f.run(restoreCurrentSkillProjection(library, { target: written.page_id }))
    expect(result.restoration).toEqual({
      status: "restored",
      operation_id: pending!.intent.operation_id,
    })
    expect(
      f.mutations().filter((call) => call.path === `v1/pages/${written.page_id}`),
    ).toHaveLength(outcome === "accepted" ? 0 : 1)
    expect(
      await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })),
    ).toBeUndefined()
  },
)

test.each([
  { kind: "owner-bind" as const, outcome: "absent" as const },
  { kind: "owner-bind" as const, outcome: "accepted" as const },
  { kind: "operation-retirement" as const, outcome: "absent" as const },
  { kind: "operation-retirement" as const, outcome: "accepted" as const },
])("restore finishes an interrupted $kind with $outcome ACK", async (fault) => {
  const { f, written } = await seedSourceReading({ rows: false })
  await f.run(projectCurrentSkill(library, { target: written.page_id, mode: "auto" }))
  f.blocks.set(written.page_id, [])
  f.pages.get(written.page_id)!.in_trash = true
  f.failNext(fault)
  await expect(
    f.run(restoreCurrentSkillProjection(library, { target: written.page_id })),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  const pending = await f.run(
    readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id }),
  )
  expect(pending?.intent).toHaveProperty("restore")
  f.clearCalls()
  await f.run(restoreCurrentSkillProjection(library, { target: written.page_id }))
  expect(f.mutations().filter((call) => call.path === `v1/pages/${written.page_id}`)).toEqual([])
  expect(
    await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })),
  ).toBeUndefined()
})

test("restore continues its normal projection after an accepted append without repeating the body", async () => {
  const { f, written } = await seedSourceReading({ rows: false })
  await f.run(projectCurrentSkill(library, { target: written.page_id, mode: "auto" }))
  f.blocks.set(written.page_id, [])
  f.pages.get(written.page_id)!.in_trash = true
  f.failNext({ kind: "append", outcome: "accepted" })
  await expect(
    f.run(restoreCurrentSkillProjection(library, { target: written.page_id })),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  const pending = await f.run(
    readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id }),
  )
  expect(pending?.intent).toMatchObject({ projection: true })
  const body = structuredClone(f.blocks.get(written.page_id))
  f.clearCalls()
  const complete = await f.run(restoreCurrentSkillProjection(library, { target: written.page_id }))
  expect(complete.operation_id).toBe(pending!.intent.operation_id)
  expect(f.blocks.get(written.page_id)).toEqual(body)
  expect(
    f.mutations().filter((call) => call.path === `v1/blocks/${written.page_id}/children`),
  ).toEqual([])
  expect(
    await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })),
  ).toBeUndefined()
})

test("restore does not overwrite a projection externally trashed while its append was pending", async () => {
  const { f, written } = await seedSourceReading({ rows: false })
  f.failNext({ kind: "append", outcome: "accepted" })
  await expect(
    f.run(projectCurrentSkill(library, { target: written.page_id, mode: "auto" })),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  const pending = await f.run(
    readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id }),
  )
  f.pages.get(written.page_id)!.in_trash = true
  f.clearCalls()
  await expect(
    f.run(restoreCurrentSkillProjection(library, { target: written.page_id })),
  ).rejects.toMatchObject({
    code: "CURRENT_PROJECTION_RESTORE_CONFLICT",
    details: { restore_blocked: true },
  })
  expect(f.mutations()).toEqual([])
  expect(
    await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })),
  ).toEqual(pending)
})

test.each(["missing", "foreign", "duplicate", "unready-source", "pending-content"] as const)(
  "restore rejects a %s target before mutation",
  async (boundary) => {
    const { f, written, sourcePage } = await seedSourceReading({ rows: false })
    const owner = f.pages.get(written.page_id)!
    owner.in_trash = true
    if (boundary === "missing") f.pages.delete(written.page_id)
    else if (boundary === "foreign") property(owner.parent).data_source_id = id(8000)
    else if (boundary === "duplicate")
      f.pages.set(id(8000), { ...structuredClone(owner), id: id(8000), in_trash: false })
    else if (boundary === "unready-source") {
      const fields = property(f.pages.get(sourcePage)!.properties)
      property(fields[library.sources.property_ids.Status!]).select = { name: "applying" }
      property(fields[library.sources.property_ids.Operation!]).rich_text =
        sourceRich("source-pending")
    } else {
      owner.in_trash = false
      await f.run(
        withCurrentOperation(library, {
          intent: {
            owner: { kind: "skill", id: defaults.skill_id },
            operation_id: "content-pending",
            input_sha256: "f".repeat(64),
          },
          ownerPageId: written.page_id,
          run: (session) =>
            session
              .activate()
              .pipe(
                Effect.andThen(Effect.fail(fail("TEST_STOP", "Keep content intent unfinished."))),
              ),
          verify: () => Effect.void,
        }).pipe(Effect.result),
      )
      owner.in_trash = true
    }
    const pendingBefore = structuredClone([...f.json])
    f.clearCalls()
    await expect(
      f.run(restoreCurrentSkillProjection(library, { target: written.page_id })),
    ).rejects.toBeDefined()
    expect(f.mutations()).toEqual([])
    expect([...f.json]).toEqual(pendingBefore)
  },
)

test.each(["policy", "identity", "main-content", "source-contribution"] as const)(
  "restore freezes its original %s before retry",
  async (change) => {
    const { f, written, sourcePage } = await seedSourceReading({ rows: false })
    const policy = { include: ["references/**/*.md"], exclude: ["**/fixtures/**"] }
    f.pages.get(written.page_id)!.in_trash = true
    f.failNext({ kind: "skill-restore", outcome: "absent" })
    await expect(
      f.run(restoreCurrentSkillProjection(library, { target: written.page_id, ...policy })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const pending = await f.run(
      readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id }),
    )
    if (change === "identity")
      property(
        property(f.pages.get(written.page_id)!.properties)[
          library.skills.property_ids["Main File ID"]!
        ],
      ).rich_text = sourceRich("changed-main-file")
    else if (change === "main-content") {
      const field = property(
        property(f.pages.get(written.page_id)!.properties)[library.skills.property_ids.Content!],
      )
      field.rich_text = sourceRich(
        JSON.stringify({
          ...property(JSON.parse(text(field.rich_text))),
          sha256: "f".repeat(64),
        }),
      )
    } else if (change === "source-contribution") {
      const field = property(
        property(f.pages.get(sourcePage)!.properties)[library.sources.property_ids.Contributions!],
      )
      field.rich_text = sourceRich(
        JSON.stringify([
          {
            skill_id: defaults.skill_id,
            member_key: "upstream",
            mount_path: "",
            mapping: {},
            exclude: ["scripts/run.ts"],
          },
        ]),
      )
    }
    f.clearCalls()
    await expect(
      f.run(
        restoreCurrentSkillProjection(library, {
          target: written.page_id,
          ...policy,
          ...(change === "policy" ? { include: ["**/*.md"] } : {}),
        }),
      ),
    ).rejects.toMatchObject({
      code: "CURRENT_PROJECTION_RESTORE_CONFLICT",
      details: { projection_policy: policy, operation_id: pending?.intent.operation_id },
    })
    expect(f.mutations()).toEqual([])
    expect(
      await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })),
    ).toEqual(pending)
  },
)

test("include and exclude arrays replace defaults, including explicit empty arrays", async () => {
  const { f, written } = await seedSourceReading()
  const all = await f.run(
    projectCurrentSkill(library, {
      target: written.page_id,
      operation_id: "all",
      dry_run: true,
      include: ["**/*"],
      exclude: [],
    }),
  )
  expect(all.counts).toMatchObject({
    selected: 5,
    excluded: 0,
    skipped_binary: 1,
    would_archive: 0,
  })
  const docsIncludingTests = await f.run(
    projectCurrentSkill(library, {
      target: written.page_id,
      operation_id: "test-docs",
      dry_run: true,
      exclude: [],
    }),
  )
  expect(docsIncludingTests.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "references/render.md",
    "scripts/test/README.md",
  ])
  const mainOnly = await f.run(
    projectCurrentSkill(library, {
      target: written.page_id,
      operation_id: "main-only",
      dry_run: true,
      include: [],
      exclude: [],
    }),
  )
  expect(mainOnly.files.map((file) => file.path)).toEqual(["SKILL.md"])
  expect(mainOnly.counts).toMatchObject({ selected: 1, excluded: 4, would_archive: 4 })
  expect(mainOnly.policy).toEqual({ include: [], exclude: [] })
  expect(
    new Set([all.input_sha256, docsIncludingTests.input_sha256, mainOnly.input_sha256]).size,
  ).toBe(3)
  expect(f.mutations()).toEqual([])
})

test.each(["accepted", "absent"] as const)(
  "source document create with an unknown %s outcome keeps a stable intent without replay",
  async (outcome) => {
    const { f, written } = await seedSourceReading({ rows: false })
    const dry = await f.run(
      projectCurrentSkill(library, {
        target: written.page_id,
        operation_id: "preview-create",
        dry_run: true,
      }),
    )
    expect(dry.counts.would_create).toBe(1)
    f.failNext({ kind: "file-create", outcome })
    await expect(
      f.run(
        projectCurrentSkill(library, {
          target: written.page_id,
          operation_id: "unknown-doc-create",
        }),
      ),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const pending = await f.run(
      readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id }),
    )
    expect(pending?.intent.input_sha256).toBe(dry.input_sha256)
    f.clearCalls()
    reverseFileQuery(f)
    const resume = projectCurrentSkill(library, {
      target: written.page_id,
      operation_id: "unknown-doc-create",
      mode: "resume",
    })
    if (outcome === "absent")
      await expect(f.run(resume)).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
    else {
      const result = await f.run(resume)
      expect(result.input_sha256).toBe(dry.input_sha256)
      expect(
        (await f.run(queryCurrentSkillIndex(library, written.page_id))).files.map(
          (file) => file.path,
        ),
      ).toEqual(["references/render.md"])
    }
    expect(
      f
        .mutations()
        .filter(
          (call) =>
            call.path === "v1/pages" &&
            property(property(call.body).parent).data_source_id === library.files.data_source_id,
        ),
    ).toEqual([])
    expect((await f.run(queryCurrentSkillIndex(library, written.page_id))).state).toEqual({
      state: "ready",
    })
  },
)

test("an accepted unknown archive resumes from its exact retired page without another archive request", async () => {
  const { f, written } = await seedSourceReading()
  f.failNext({ kind: "retire-file", outcome: "accepted" })
  await expect(
    f.run(
      projectCurrentSkill(library, {
        target: written.page_id,
        operation_id: "unknown-doc-archive",
      }),
    ),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  const retired = f.mutations().find((call) => property(call.body).in_trash === true)!
  const pending = await f.run(
    readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id }),
  )
  f.clearCalls()
  const resumed = await f.run(
    projectCurrentSkill(library, {
      target: written.page_id,
      operation_id: "unknown-doc-archive",
      mode: "resume",
    }),
  )
  expect(pending?.intent.input_sha256).toBe(resumed.input_sha256)
  expect(f.mutations().filter((call) => call.path === retired.path)).toEqual([])
  expect(
    (await f.run(queryCurrentSkillIndex(library, written.page_id))).files.map((file) => file.path),
  ).toEqual(["references/render.md"])
})

test("a source descriptor relocates on its existing reading page without changing File ID", async () => {
  const { f, written } = await seedSourceReading()
  const before = await f.run(queryCurrentSkillIndex(library, written.page_id))
  const guide = before.files.find((file) => file.path === "references/render.md")!
  property(
    property(f.pages.get(guide.page_id)!.properties)[library.files.property_ids.Content!],
  ).rich_text = sourceRich(
    JSON.stringify({
      ...guide.content,
      source_id: "old-source",
      source_path: "old/guide.md",
    }),
  )
  f.clearCalls()
  const projected = await f.run(
    projectCurrentSkill(library, { target: written.page_id, operation_id: "relocated-doc" }),
  )
  expect(projected.counts.updated).toBe(1)
  const after = (await f.run(queryCurrentSkillIndex(library, written.page_id))).files.find(
    (file) => file.path === guide.path,
  )!
  expect(after.page_id).toBe(guide.page_id)
  expect(after.file_id).toBe(guide.file_id)
  expect(after.content).toEqual(guide.content)
})

test("a native takeover during an excluded source page scan blocks retirement", async () => {
  const { f, written } = await seedSourceReading()
  const target = (await f.run(queryCurrentSkillIndex(library, written.page_id))).files.find(
    (file) => file.path === "assets/photo.png",
  )!
  let changed = false
  f.rewrite((path, response) => {
    if (!changed && path.startsWith("v1/blocks/" + target.page_id + "/children")) {
      changed = true
      property(
        property(f.pages.get(target.page_id)!.properties)[library.files.property_ids.Content!],
      ).rich_text = sourceRich(JSON.stringify({ kind: "native", mode: "100644", frontmatter: "" }))
    }
    return response
  })
  f.clearCalls()
  await expect(
    f.run(
      projectCurrentSkill(library, { target: written.page_id, operation_id: "archive-takeover" }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_PROJECTION_CONFLICT" })
  expect(changed).toBe(true)
  expect(f.mutations()).toEqual([])
  expect(property(f.pages.get(target.page_id)).in_trash).toBe(false)
})

async function leaveDenseProjectionPending(outcome: "accepted" | "absent" = "accepted") {
  const seeded = await seedSourceReading()
  const { f, written, originals } = seeded
  const index = await f.run(queryCurrentSkillIndex(library, written.page_id))
  const consumption = await f.run(resolveCurrentSkillConsumption(library, index))
  const plan = renderCurrentProjection({
    role: "main",
    path: index.main.path,
    bytes: originals.get("SKILL.md")!,
    rewriteLink: currentProjectionLinkRewriter(
      index.main.path,
      new Map([index.main, ...index.files].map((file) => [file.path, file.page_id])),
      consumption,
    ),
  })
  const inputHash = "d".repeat(64)
  f.failNext({ kind: "append", outcome })
  await expect(
    f.run(
      withCurrentOperation(library, {
        intent: {
          operation_id: "old-dense-projection",
          input_sha256: inputHash,
          owner: { kind: "skill", id: defaults.skill_id },
          projection: true,
          policy: { include: ["**/*"], exclude: [] },
        },
        ownerPageId: index.page_id,
        run: (session) =>
          applyCurrentProjection<Notion | Crypto.Crypto | Store>({
            pageId: index.page_id,
            content: index.main.content,
            plan,
            assertCurrent: Effect.void,
            dispatch: session.dispatch,
          }),
        verify: () => Effect.void,
      }),
    ),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  f.clearCalls()
  return { ...seeded, index, inputHash, operation_id: "old-dense-projection" }
}
function expectOnlyRecordCancellation(f: ReturnType<typeof currentWriteFixture>) {
  const recordPages = new Set(f.table("records", false).map((row) => "v1/pages/" + row.id))
  expect(f.mutations().length).toBeGreaterThan(0)
  expect(f.mutations().every((call) => call.method === "PATCH" && recordPages.has(call.path))).toBe(
    true,
  )
}

test("public cancellation keeps an old frozen hash and dense physical links without rendering the remaining documents", async () => {
  const { f, written, index, inputHash, operation_id } = await leaveDenseProjectionPending()
  const bodies = structuredClone([...f.blocks])
  const cancelled = await f.run(
    cancelCurrentSkillProjection(library, { target: written.page_id, operation_id }),
  )
  expect(cancelled).toMatchObject({ status: "cancelled", operation_id, input_sha256: inputHash })
  expect([...f.blocks]).toEqual(bodies)
  expect(
    (await f.run(queryCurrentSkillIndex(library, written.page_id))).files.map(
      (file) => file.page_id,
    ),
  ).toEqual(index.files.map((file) => file.page_id))
  expectOnlyRecordCancellation(f)
  expect(
    await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })),
  ).toBeUndefined()
  f.clearCalls()
  expect(
    (await f.run(cancelCurrentSkillProjection(library, { target: written.page_id, operation_id })))
      .status,
  ).toBe("not_found")
  expect(f.mutations()).toEqual([])
})

test("public cancellation reconciles sparse fixed-GitHub body links without performing the tail", async () => {
  const { f, written } = await seedSourceReading({ rows: false })
  f.failNext({ kind: "append", outcome: "accepted" })
  await expect(
    f.run(projectCurrentSkill(library, { target: written.page_id, operation_id: "sparse-cancel" })),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  const body = JSON.stringify(f.blocks.get(written.page_id))
  expect(body).toContain("/upstream/scripts/run.ts#L1")
  const prior = structuredClone([...f.blocks])
  f.clearCalls()
  expect(
    (
      await f.run(
        cancelCurrentSkillProjection(library, {
          target: written.page_id,
          operation_id: "sparse-cancel",
        }),
      )
    ).status,
  ).toBe("cancelled")
  expect([...f.blocks]).toEqual(prior)
  expectOnlyRecordCancellation(f)
})

test.each(["absent", "different", "native", "wrong-operation"] as const)(
  "public cancellation leaves %s pending work intact",
  async (kind) => {
    const { f, written, operation_id } = await leaveDenseProjectionPending(
      kind === "absent" ? "absent" : "accepted",
    )
    if (kind === "different") {
      const first = f.blocks.get(written.page_id)![0]!
      property(first[String(first.type)]).rich_text = sourceRich("A different current body")
    }
    if (kind === "native")
      property(
        property(f.pages.get(written.page_id)!.properties)[library.skills.property_ids.Content!],
      ).rich_text = sourceRich(JSON.stringify({ kind: "native", mode: "100644", frontmatter: "" }))
    await expect(
      f.run(
        cancelCurrentSkillProjection(library, {
          target: written.page_id,
          operation_id: kind === "wrong-operation" ? "another-operation" : operation_id,
        }),
      ),
    ).rejects.toMatchObject({
      code:
        kind === "absent"
          ? "CURRENT_OPERATION_UNRESOLVED"
          : kind === "wrong-operation"
            ? "CURRENT_OPERATION_CONFLICT"
            : "CURRENT_PROJECTION_CONFLICT",
    })
    expect(f.mutations()).toEqual([])
    expect(
      (await f.run(readCurrentOperationIntent(library, { kind: "skill", id: defaults.skill_id })))
        ?.intent.operation_id,
    ).toBe(operation_id)
  },
)

test.each(["file-create", "retire-file"] as const)(
  "public cancellation observes accepted %s without creating, pruning or rendering more pages",
  async (kind) => {
    const { f, written } = await seedSourceReading({ rows: kind !== "file-create" })
    f.failNext({ kind, outcome: "accepted" })
    await expect(
      f.run(
        projectCurrentSkill(library, { target: written.page_id, operation_id: "metadata-cancel" }),
      ),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const before = await f.run(queryCurrentSkillIndex(library, written.page_id))
    const bodies = structuredClone([...f.blocks])
    f.clearCalls()
    const result = await f.run(
      cancelCurrentSkillProjection(library, {
        target: written.page_id,
        operation_id: "metadata-cancel",
      }),
    )
    expect(result.status).toBe("cancelled")
    expect([...f.blocks]).toEqual(bodies)
    expect(logical(await f.run(queryCurrentSkillIndex(library, written.page_id)))).toEqual(
      logical(before),
    )
    expectOnlyRecordCancellation(f)
  },
)

test("public cancellation observes the exact accepted source Content PATCH without replay", async () => {
  const { f, written } = await seedSourceReading()
  const guide = (await f.run(queryCurrentSkillIndex(library, written.page_id))).files.find(
    (file) => file.path === "references/render.md",
  )!
  property(
    property(f.pages.get(guide.page_id)!.properties)[library.files.property_ids.Content!],
  ).rich_text = sourceRich(
    JSON.stringify({ ...guide.content, source_id: "old-source", source_path: "old/guide.md" }),
  )
  let changed = false
  f.rewrite((path, response) => {
    const call = f.calls.at(-1)
    if (
      !changed &&
      path === "v1/pages/" + guide.page_id &&
      call?.method === "PATCH" &&
      property(property(call.body).properties)[library.files.property_ids.Content!] !== undefined
    ) {
      changed = true
      return { ...response, id: id(9999) }
    }
    return response
  })
  await expect(
    f.run(
      projectCurrentSkill(library, { target: written.page_id, operation_id: "content-cancel" }),
    ),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  expect(changed).toBe(true)
  f.rewrite(undefined)
  f.clearCalls()
  expect(
    (
      await f.run(
        cancelCurrentSkillProjection(library, {
          target: written.page_id,
          operation_id: "content-cancel",
        }),
      )
    ).status,
  ).toBe("cancelled")
  expectOnlyRecordCancellation(f)
  expect(f.mutations().filter((call) => call.path === "v1/pages/" + guide.page_id)).toEqual([])
})
