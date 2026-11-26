import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { snapshotPortable } from "../src/export.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { loadCurrentSharedResourceContent } from "../src/shared-current-resource.ts"
import { trashPath } from "../src/local-locks.ts"
import { property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { queryCurrentSkillIndex } from "../src/shared-current-index.ts"
import { changeCurrentSourceFileAuthority } from "../src/shared-current-source-file.ts"
import {
  prepareCurrentSourceFromDiscovery,
  type CurrentSourceDeclaration,
} from "../src/shared-current-source-input.ts"
import { queryCurrentSourceManagement } from "../src/shared-current-source-management.ts"
import { writePreparedCurrentSource } from "../src/shared-current-source-write.ts"
import { readSkill } from "../src/snapshot.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"
import {
  currentWriteFixture,
  seedSourceFileRows,
  id,
  library,
  testBytes,
} from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-source-file-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
const declaration: CurrentSourceDeclaration = {
  version: 1,
  definition: {
    version: 1,
    source_id: "file-source",
    name: "File Source",
    description: "Current originals",
    enabled: true,
    policy: "manual",
    adapter: { type: "git", url: "https://github.com/example/files", ref: "main" },
    selection: { roots: ["skills"], include: [], exclude: [], mapping: {} },
    options: {},
  },
  contributions: [
    { member_key: "skills/one", skill_id: "file-skill", mount_path: "", mapping: {}, exclude: [] },
  ],
}
const font = new Uint8Array([119, 79, 70, 70, 0, 255, 1])
function observation(next = false, mainEnding: "" | "\n" = ""): SourceSnapshot {
  const commit = (next ? "b" : "a").repeat(40),
    root = "skills/one",
    files = [
      {
        path: "SKILL.md",
        bytes: testBytes(
          `---\nname: one\ndescription: Current original\n---\n# Upstream ${next ? "two" : "one"}\n\nComplete author body.${mainEnding}`,
        ),
        mode: "100644" as const,
      },
      {
        path: "run.sh",
        bytes: testBytes(`#!/bin/sh\necho ${next ? "two" : "one"}\n`),
        mode: "100755" as const,
      },
      { path: "font.woff", bytes: font, mode: "100644" as const },
    ]
  return {
    revision: commit,
    provenance: {
      provider: "git",
      git_url: "https://github.com/example/files",
      resolved_ref: commit,
    },
    members: [
      {
        member_key: root,
        source_path: root,
        portable: {
          kind: "skill",
          name: "one",
          description: "Current original",
          main: "SKILL.md",
          files,
        },
        upstream_hash: "d".repeat(64),
        content_hash: "e".repeat(64),
        git_manifest: {
          commit,
          tree: "c".repeat(40),
          root,
          files: files.map((file) => ({
            path: file.path,
            source_path: `${root}/${file.path}`,
            bytes: file.bytes.byteLength,
            mode: file.mode,
            git_oid: createHash("sha1")
              .update(`blob ${file.bytes.byteLength}\0`)
              .update(file.bytes)
              .digest("hex"),
          })),
        },
      },
    ],
  }
}
function provider(mainEnding: "" | "\n" = "") {
  const bodies = new Map<string, Uint8Array>(),
    requests: string[] = []
  for (const snapshot of [observation(false, mainEnding), observation(true, mainEnding)])
    for (const member of snapshot.members)
      for (const file of member.portable.files)
        bodies.set(
          `https://raw.githubusercontent.com/example/files/${snapshot.revision}/${member.member_key}/${file.path}`,
          file.bytes,
        )
  const use = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const original = yield* HttpClient.HttpClient
      return yield* effect.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const bytes = bodies.get(request.url)
            if (bytes === undefined) return original.execute(request)
            requests.push(request.url)
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(new Uint8Array(bytes), {
                  headers: { "content-length": String(bytes.byteLength) },
                }),
              ),
            )
          }),
        ),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      )
    })
  return { use, requests }
}
type Fixture = ReturnType<typeof currentWriteFixture>
const pending = (f: Fixture) =>
  [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/"))
async function seed(mainEnding: "" | "\n" = "") {
  const f = currentWriteFixture(parent),
    http = provider(mainEnding)
  const prepared = await f.run(
    prepareCurrentSourceFromDiscovery(declaration, observation(false, mainEnding)),
  )
  await f.run(http.use(writePreparedCurrentSource(library, { prepared, operation_id: "seed" })))
  await seedSourceFileRows(f, prepared)
  const page = String(f.table("skills")[0]!.id)
  const index = await f.run(queryCurrentSkillIndex(library, page))
  f.clearCalls()
  http.requests.length = 0
  return { f, http, page, index }
}
async function ready(f: Fixture) {
  expect((await f.run(queryCurrentSourceManagement(library, "file-source")))?.state).toEqual({
    state: "ready",
  })
  for (const row of f.table("skills"))
    expect((await f.run(queryCurrentSkillIndex(library, String(row.id)))).state).toEqual({
      state: "ready",
    })
  expect(pending(f)).toEqual([])
  expect(
    f
      .table("records")
      .filter(
        (row) => property(property(property(row.properties).kind).select).name === "operation",
      ),
  ).toEqual([])
}
function change(
  file: { file_id: string; path: string },
  operation_id: string,
  action: { kind: "takeover"; to: "native" | "resource" } | { kind: "restore_follow" },
) {
  return {
    source_id: "file-source",
    source_path: `skills/one/${file.path}`,
    skill_id: "file-skill",
    file_id: file.file_id,
    operation_id,
    action,
  }
}
async function author(f: Fixture, page: string, body: string) {
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Notion).request(
        `v1/pages/${page}/markdown`,
        {
          type: "replace_content",
          replace_content: { new_str: body },
        },
        { method: "PATCH" },
      )
    }),
  )
  f.blocks.set(page, [
    {
      object: "block",
      id: id(900001),
      type: "paragraph",
      has_children: false,
      parent: { type: "page_id", page_id: page },
      paragraph: { rich_text: [{ type: "text", text: { content: body } }], color: "default" },
    },
  ])
}

test.each([true, false])(
  "native takeover verifies terminal LF normalization without changing Source originals (dry_run=%s)",
  async (dry_run) => {
    const { f, http, page, index } = await seed("\n")
    const sourceBefore = await f.run(queryCurrentSourceManagement(library, "file-source"))
    const original = await f.run(
      http.use(readSkill(page, { library: library.library_id, refresh: true })),
    )
    if (!("content" in original)) throw new Error("Expected the current Source text")
    expect(original.content.endsWith("\n")).toBe(true)
    const originalHash = createHash("sha256").update(original.content).digest("hex")
    const pagesBefore = structuredClone([...f.pages])
    f.clearCalls()
    f.rewrite((path, response) =>
      path.includes("/markdown") && typeof response.markdown === "string"
        ? { ...response, markdown: response.markdown.replace(/\n+$/u, "") }
        : response,
    )
    await f.run(
      http.use(
        changeCurrentSourceFileAuthority(library, {
          ...change(index.main, "native-terminal-lf", { kind: "takeover", to: "native" }),
          dry_run,
        }),
      ),
    )
    if (dry_run) {
      expect(f.mutations()).toEqual([])
      expect([...f.pages]).toEqual(pagesBefore)
      expect(await f.run(queryCurrentSourceManagement(library, "file-source"))).toEqual(
        sourceBefore,
      )
      expect(await f.run(queryCurrentSkillIndex(library, page))).toEqual(index)
    } else
      expect((await f.run(queryCurrentSkillIndex(library, page))).main).toMatchObject({
        file_id: index.main.file_id,
        page_id: page,
        content: { kind: "native" },
      })
    const retained = await f.run(
      http.use(readSkill(page, { library: library.library_id, refresh: true })),
    )
    if (!("content" in retained)) throw new Error("Expected the retained Source text")
    expect(retained.content).toBe(
      dry_run ? original.content : original.content.replace(/\n+$/u, ""),
    )
    if (!dry_run) {
      await f.run(
        http.use(
          changeCurrentSourceFileAuthority(library, {
            ...change(index.main, "native-terminal-lf-follow", { kind: "restore_follow" }),
          }),
        ),
      )
      const followed = await f.run(
        http.use(readSkill(page, { library: library.library_id, refresh: true })),
      )
      if (!("content" in followed)) throw new Error("Expected the exact selected Source text")
      expect(followed.content).toBe(original.content)
      expect(createHash("sha256").update(followed.content).digest("hex")).toBe(originalHash)
    }
    await ready(f)
    if (dry_run) expect(f.mutations()).toEqual([])
  },
)

test("main takeover preserves identity and human edits through refresh, then follows the current selected original", async () => {
  const { f, http, page, index } = await seed()
  const request = change(index.main, "take-main", { kind: "takeover", to: "native" })
  const inspected = await f.run(
    http.use(changeCurrentSourceFileAuthority(library, { ...request, dry_run: true })),
  )
  expect(inspected).toMatchObject({ status: "inspected", remote_writes: 0, action: "takeover" })
  expect(f.mutations()).toEqual([])
  expect(pending(f)).toEqual([])
  const result = await f.run(http.use(changeCurrentSourceFileAuthority(library, request)))
  expect(result).toMatchObject({
    action: "takeover",
    state: "ready",
    status: "applied",
    source_path: "skills/one/SKILL.md",
    file_id: index.main.file_id,
    targets: [{ page_id: page, skill_id: "file-skill", contract: "current", state: "ready" }],
  })
  let current = await f.run(queryCurrentSkillIndex(library, page))
  expect(current.main).toMatchObject({
    file_id: index.main.file_id,
    page_id: page,
    path: "SKILL.md",
    content: { kind: "native" },
  })
  expect(
    current.files.map((file) => [file.file_id, file.page_id, file.path, file.content]),
  ).toEqual(index.files.map((file) => [file.file_id, file.page_id, file.path, file.content]))
  expect(
    (await f.run(queryCurrentSourceManagement(library, "file-source")))?.declaration
      .contributions[0]?.exclude,
  ).toEqual(["SKILL.md"])
  expect(http.requests.every((url) => url.endsWith("/SKILL.md"))).toBe(true)
  const human = "# Edited in Notion\n\nKeep every line.\n"
  await author(f, page, human)
  f.clearCalls()
  const noop = await f.run(
    http.use(changeCurrentSourceFileAuthority(library, { ...request, operation_id: "take-again" })),
  )
  expect(noop).toMatchObject({ status: "unchanged", targets: [{ status: "unchanged" }] })
  expect(f.mutations()).toEqual([])
  const configured = (await f.run(queryCurrentSourceManagement(library, "file-source")))!
  const prepared = await f.run(
    prepareCurrentSourceFromDiscovery(configured.declaration, observation(true)),
  )
  await f.run(http.use(writePreparedCurrentSource(library, { prepared, operation_id: "refresh" })))
  expect(
    await f.run(http.use(readSkill(page, { library: library.library_id, refresh: true }))),
  ).toMatchObject({ content: expect.stringContaining(human) })
  await f.run(
    http.use(
      changeCurrentSourceFileAuthority(
        library,
        change(index.main, "follow", { kind: "restore_follow" }),
      ),
    ),
  )
  current = await f.run(queryCurrentSkillIndex(library, page))
  expect(current.main).toMatchObject({
    file_id: index.main.file_id,
    page_id: page,
    path: "SKILL.md",
    content: { kind: "source", source_id: "file-source", source_path: "skills/one/SKILL.md" },
  })
  expect(
    await f.run(http.use(readSkill(page, { library: library.library_id, refresh: true }))),
  ).toMatchObject({
    content: new TextDecoder().decode(observation(true).members[0]!.portable.files[0]!.bytes),
  })
  expect(
    (await f.run(queryCurrentSourceManagement(library, "file-source")))?.declaration
      .contributions[0]?.exclude,
  ).toEqual([])
  await ready(f)
})

test("supporting executable and binary takeovers keep originals and disabled Sources permit only takeover", async () => {
  const { f, http, page, index } = await seed()
  const script = index.files.find((file) => file.path === "run.sh")!,
    binary = index.files.find((file) => file.path === "font.woff")!
  await f.run(
    http.use(
      changeCurrentSourceFileAuthority(
        library,
        change(script, "take-script", { kind: "takeover", to: "resource" }),
      ),
    ),
  )
  expect(
    (await f.run(queryCurrentSkillIndex(library, page))).files.find(
      (file) => file.file_id === script.file_id,
    ),
  ).toMatchObject({
    page_id: script.page_id,
    path: "run.sh",
    content: { kind: "resource", mode: "100755" },
  })
  expect(
    await f.run(
      http.use(readSkill(page, { library: library.library_id, path: "run.sh", refresh: true })),
    ),
  ).toMatchObject({ content: "#!/bin/sh\necho one\n" })
  const source = (await f.run(queryCurrentSourceManagement(library, "file-source")))!
  const enabled = (value: boolean) =>
    f.run(
      Effect.gen(function* () {
        yield* (yield* Notion).request(
          `v1/pages/${source.page_id}`,
          { properties: { enabled: { checkbox: value } } },
          { method: "PATCH" },
        )
      }),
    )
  await enabled(false)
  f.clearCalls()
  await expect(
    f.run(
      http.use(
        changeCurrentSourceFileAuthority(library, {
          ...change(binary, "binary-native", { kind: "takeover", to: "native" }),
          dry_run: true,
        }),
      ),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_WRITE_INPUT_INVALID" })
  expect(f.mutations()).toEqual([])
  await f.run(
    http.use(
      changeCurrentSourceFileAuthority(
        library,
        change(binary, "take-binary", { kind: "takeover", to: "resource" }),
      ),
    ),
  )
  expect(
    (await f.run(queryCurrentSkillIndex(library, page))).files.find(
      (file) => file.file_id === binary.file_id,
    ),
  ).toMatchObject({
    page_id: binary.page_id,
    path: "font.woff",
    content: { kind: "resource", bytes: font.byteLength },
  })
  const storedBinary = (await f.run(queryCurrentSkillIndex(library, page))).files.find(
    (file) => file.file_id === binary.file_id,
  )!
  if (storedBinary.content.kind !== "resource") throw new Error("Expected exact resource original")
  const original = await f.run(
    loadCurrentSharedResourceContent(library, {
      owner: { kind: "skill", page_id: page },
      content: storedBinary.content,
    }),
  )
  expect(original.bytes).toEqual(font)
  expect(f.blocks.get(binary.page_id) ?? []).toEqual([])
  f.clearCalls()
  await expect(
    f.run(
      http.use(
        changeCurrentSourceFileAuthority(
          library,
          change(binary, "disabled-follow", { kind: "restore_follow" }),
        ),
      ),
    ),
  ).rejects.toMatchObject({ code: "SOURCE_DISABLED" })
  expect(f.mutations()).toEqual([])
  expect(pending(f)).toEqual([])
  await enabled(true)
  await f.run(
    http.use(
      changeCurrentSourceFileAuthority(
        library,
        change(binary, "follow-binary", { kind: "restore_follow" }),
      ),
    ),
  )
  const final = await f.run(queryCurrentSkillIndex(library, page))
  expect(final.main).toMatchObject({ file_id: index.main.file_id, content: { kind: "source" } })
  expect(final.files.find((file) => file.file_id === binary.file_id)).toMatchObject({
    page_id: binary.page_id,
    content: { kind: "source", source_path: "skills/one/font.woff" },
  })
  expect(f.blocks.get(binary.page_id) ?? []).toEqual([])
  const snapshot = await f.run(
    http.use(
      openSharedSnapshot({
        library,
        target: page,
        scope: "f".repeat(64),
        startedAt: Date.now(),
        forceFull: true,
      }),
    ),
  )
  const portable = await f.run(snapshotPortable(snapshot))
  expect(portable.files.find((file) => file.path === "font.woff")?.bytes).toEqual(font)
  await ready(f)
})

test.each(["source-properties", "native-body"] as const)(
  "%s accepted-lost resumes the same parent and physical File without replay",
  async (kind) => {
    const { f, http, page, index } = await seed()
    const request = change(index.main, "take-lost", { kind: "takeover", to: "native" })
    f.failNext({ kind, outcome: "accepted" })
    await expect(
      f.run(http.use(changeCurrentSourceFileAuthority(library, request))),
    ).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
      details: { operation_id: request.operation_id, owner: { kind: "source", id: "file-source" } },
    })
    const before = f.calls.filter(
      (call) =>
        call.method === "PATCH" &&
        (kind === "native-body"
          ? call.path === `v1/pages/${page}/markdown`
          : "contributions" in property(property(call.body).properties)),
    )
    expect(before).toHaveLength(1)
    await f.run(http.use(changeCurrentSourceFileAuthority(library, { ...request, mode: "resume" })))
    expect(
      f.calls.filter(
        (call) =>
          call.method === "PATCH" &&
          (kind === "native-body"
            ? call.path === `v1/pages/${page}/markdown`
            : "contributions" in property(property(call.body).properties)),
      ),
    ).toHaveLength(1)
    expect((await f.run(queryCurrentSkillIndex(library, page))).main).toMatchObject({
      page_id: page,
      file_id: index.main.file_id,
      content: { kind: "native" },
    })
    await ready(f)
  },
)

test("restore-follow consumes exact Source bytes without depending on generated reading writes", async () => {
  const { f, http, page, index } = await seed()
  await f.run(
    http.use(
      changeCurrentSourceFileAuthority(
        library,
        change(index.main, "native", { kind: "takeover", to: "native" }),
      ),
    ),
  )
  await author(f, page, "# Native before explicit restore\n")
  const request = change(index.main, "restore-without-projection", { kind: "restore_follow" })
  const previousReading = structuredClone(f.blocks.get(page))
  f.clearCalls()
  f.failNext({ kind: "append", outcome: "accepted" })
  expect(await f.run(http.use(changeCurrentSourceFileAuthority(library, request)))).toMatchObject({
    state: "ready",
    status: "applied",
  })
  expect(
    f.calls.filter(
      (call) =>
        call.method === "PATCH" &&
        (call.path === `v1/blocks/${page}/children` || call.path === `v1/pages/${page}/markdown`),
    ),
  ).toEqual([])
  expect(f.blocks.get(page)).toEqual(previousReading)
  expect((await f.run(queryCurrentSkillIndex(library, page))).main).toMatchObject({
    file_id: index.main.file_id,
    page_id: page,
    content: { kind: "source", source_path: "skills/one/SKILL.md" },
  })
  expect(
    await f.run(http.use(readSkill(page, { library: library.library_id, refresh: true }))),
  ).toMatchObject({
    content: new TextDecoder().decode(observation().members[0]!.portable.files[0]!.bytes),
  })
  await ready(f)
})

test("a failed native roundtrip can be explicitly superseded by resource for the same File", async () => {
  const { f, http, page, index } = await seed()
  let replaced = false
  f.rewrite((path, response) => {
    if (path.split("?")[0] === `v1/pages/${page}/markdown`) {
      replaced ||= f.calls.at(-1)?.method === "PATCH"
      if (replaced)
        return { ...response, markdown: String(response.markdown) + "\nNotion normalized it.\n" }
    }
    return response
  })
  await expect(
    f.run(
      http.use(
        changeCurrentSourceFileAuthority(
          library,
          change(index.main, "native-failed", { kind: "takeover", to: "native" }),
        ),
      ),
    ),
  ).rejects.toMatchObject({
    code: "WRITE_OUTCOME_UNKNOWN",
    details: { operation_id: "native-failed", child: { cause_code: "CURRENT_NATIVE_ROUNDTRIP" } },
  })
  f.rewrite()
  f.clearCalls()
  const result = await f.run(
    http.use(
      changeCurrentSourceFileAuthority(library, {
        ...change(index.main, "resource-successor", { kind: "takeover", to: "resource" }),
        mode: { kind: "supersede", operation_id: "native-failed" },
      }),
    ),
  )
  expect(result).toMatchObject({
    state: "ready",
    status: "applied",
    operation_id: "resource-successor",
  })
  expect((await f.run(queryCurrentSkillIndex(library, page))).main).toMatchObject({
    page_id: page,
    file_id: index.main.file_id,
    content: { kind: "resource" },
  })
  expect(
    f.calls.filter(
      (call) =>
        call.method === "POST" &&
        call.path === "v1/pages" &&
        property(property(property(call.body).properties).kind).select !== undefined &&
        property(property(property(property(call.body).properties).kind).select).name ===
          "operation",
    ),
  ).toEqual([])
  await ready(f)
})

test("restore-follow rejects a new native author edit before replacing its descriptor or blocks", async () => {
  const { f, http, page, index } = await seed()
  await f.run(
    http.use(
      changeCurrentSourceFileAuthority(
        library,
        change(index.main, "take-before-race", { kind: "takeover", to: "native" }),
      ),
    ),
  )
  await author(f, page, "# Selected native body\n")
  const source = (await f.run(queryCurrentSourceManagement(library, "file-source")))!
  const newer = "# Newer human edit\n\nDo not replace.\n"
  let changed = false
  f.rewrite((path, response) => {
    const call = f.calls.at(-1)
    if (
      path === `v1/pages/${source.page_id}` &&
      call?.method === "PATCH" &&
      "contributions" in property(property(call.body).properties)
    ) {
      changed = true
      const block = f.blocks.get(page)![0]!
      f.blocks.set(page, [
        {
          ...block,
          paragraph: { rich_text: [{ type: "text", text: { content: newer } }], color: "default" },
        },
      ])
    }
    if (changed && path.split("?")[0] === `v1/pages/${page}/markdown`)
      return { ...response, markdown: newer }
    return response
  })
  f.clearCalls()
  await expect(
    f.run(
      http.use(
        changeCurrentSourceFileAuthority(
          library,
          change(index.main, "race-follow", { kind: "restore_follow" }),
        ),
      ),
    ),
  ).rejects.toMatchObject({
    code: "CURRENT_NATIVE_CHANGED",
    details: { operation_id: "race-follow" },
  })
  expect(changed).toBe(true)
  expect((await f.run(queryCurrentSkillIndex(library, page))).main.content.kind).toBe("native")
  expect(
    f.calls.filter(
      (call) =>
        call.method === "PATCH" &&
        (call.path.startsWith("v1/blocks/") ||
          call.path === `v1/pages/${page}/markdown` ||
          (call.path === `v1/pages/${page}` &&
            "content" in property(property(call.body).properties))),
    ),
  ).toEqual([])
  expect(text(property(f.blocks.get(page)![0]!.paragraph).rich_text)).toBe(newer)
})

test.each(["source-ready", "source-retirement"] as const)(
  "%s lost after a completed native child cleans up without rewriting later author edits",
  async (kind) => {
    const { f, http, page, index } = await seed()
    const request = change(index.main, "completed-native", { kind: "takeover", to: "native" })
    f.failNext({ kind, outcome: "accepted" })
    await expect(
      f.run(http.use(changeCurrentSourceFileAuthority(library, request))),
    ).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
      details: { operation_id: request.operation_id },
    })
    expect(pending(f)).toHaveLength(1)
    expect((await f.run(queryCurrentSkillIndex(library, page))).state).toEqual({ state: "ready" })
    const human = "# Published native author edit\n\nKeep after parent cleanup.\n"
    await author(f, page, human)
    f.clearCalls()
    const result = await f.run(
      http.use(changeCurrentSourceFileAuthority(library, { ...request, mode: "resume" })),
    )
    expect(result).toMatchObject({
      state: "ready",
      targets: [{ page_id: page, status: "unchanged" }],
    })
    expect(
      f.calls.filter(
        (call) =>
          call.method === "PATCH" &&
          (call.path.startsWith("v1/blocks/") ||
            call.path === `v1/pages/${page}/markdown` ||
            (call.path === `v1/pages/${page}` &&
              "content" in property(property(call.body).properties))),
      ),
    ).toEqual([])
    expect(
      await f.run(http.use(readSkill(page, { library: library.library_id, refresh: true }))),
    ).toMatchObject({ content: expect.stringContaining(human) })
    await ready(f)
  },
)
