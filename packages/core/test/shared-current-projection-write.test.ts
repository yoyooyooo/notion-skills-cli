import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { trashPath } from "../src/local-locks.ts"
import { property, text } from "../src/model.ts"
import { queryCurrentSkillIndex, type CurrentSkillIndex } from "../src/shared-current-index.ts"
import { readCurrentOperationIntent } from "../src/shared-current-operation.ts"
import { projectCurrentSkill } from "../src/shared-current-projection-write.ts"
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
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { sha256 } from "../src/store.ts"
import { currentWriteFixture, id, library, testBytes } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-projection-write-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
const main = testBytes("# Current main\r\n\r\nRead [guide](references/guide.md).\r\n")
const native = "# Human guide\n\nThe author keeps this exact current body.\n"
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
      (call) => call.method === "GET" && /^v1\/blocks\/[^/]+\/children(?:\?|$)/u.test(call.path),
    ),
  ).toHaveLength(4)
  expect(f.calls).toHaveLength(12)
})

test("an accepted unknown append resumes after File query order changes without making consumption unready", async () => {
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
      operation_id: "unknown-append",
      mode: "resume",
    }),
  )
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
  await expect(
    f.run(
      projectCurrentSkill(library, {
        target: written.page_id,
        operation_id: "absent-append",
        mode: "resume",
      }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
  expect(f.mutations().filter((call) => call.path.includes("/children"))).toEqual([])
  expect((await f.run(queryCurrentSkillIndex(library, written.page_id))).state).toEqual({
    state: "ready",
  })
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
