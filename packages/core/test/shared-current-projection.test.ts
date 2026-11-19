import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  applyCurrentProjection,
  assertCurrentBodyReplaceable,
  currentProjectionBatches,
  decodeCurrentProjectionText,
  inspectCurrentProjection,
  isCurrentProjectionBinary,
  renderCurrentProjection,
  type CurrentProjectionBlock,
  type CurrentProjectionDispatch,
  type CurrentProjectionPlan,
} from "../src/shared-current-projection.ts"
import type { CurrentFileContent } from "../src/shared-current-file.ts"

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const page = id(1),
  upload = { id: id(2), name: "original.bin" }
const bytes = (value: string) => new TextEncoder().encode(value)
const content = {
  kind: "resource",
  object_id: `resource-${"a".repeat(64)}`,
  sha256: "b".repeat(64),
  bytes: 1,
  mode: "100644",
} satisfies CurrentFileContent
const attachment = (name = upload.name, suffix = "current/file.bin", query = "signature=one") => ({
  type: "file",
  name,
  file: {
    url: `https://prod-files-secure.s3.us-west-2.amazonaws.com/${suffix}?${query}`,
    expiry_time: "2030-01-01T00:00:00.000Z",
  },
})
const planText = (plan: CurrentProjectionPlan) =>
  plan.blocks
    .flatMap((block) => {
      const body = property(property(block)[block.type])
      return Array.isArray(body.rich_text)
        ? body.rich_text.map((span) => String(property(property(span).text).content))
        : []
    })
    .join("")

function fixture(initial: readonly CurrentProjectionBlock[] = [], original = attachment()) {
  let next = 100,
    pending: string | undefined,
    unknown: "accepted" | "absent" | "partial" | undefined
  let badPage: ((response: Record<string, unknown>) => unknown) | undefined
  let badAck = false
  const calls: Array<{ path: string; body: unknown; method: string }> = []
  const descendants = new Map<string, Record<string, unknown>[]>()
  function physical(block: unknown): Record<string, unknown> {
    const value = property(block),
      type = String(value.type),
      body = property(value[type])
    const saved =
      (type === "file" || type === "image") && body.type === "file_upload"
        ? { ...body, type: "file", file_upload: undefined, file: { ...original.file } }
        : body
    return {
      ...value,
      [type]: saved,
      id: id(next++),
      object: "block",
      parent: { type: "page_id", page_id: page },
      has_children: false,
    }
  }
  let blocks = initial.map(physical)
  const service: Notion["Service"] = {
    version: Effect.succeed("test"),
    credentialIdentity: Effect.succeed("test"),
    request: (path, body, options) =>
      Effect.suspend(() => {
        calls.push({ path, body, method: options?.method ?? "GET" })
        const childrenPath = /^v1\/blocks\/([^/]+)\/children\?/u.exec(path)
        if (childrenPath) {
          const start = Number(
            new URL("https://api.notion.test/" + path).searchParams.get("start_cursor") ?? 0,
          )
          const selected =
            childrenPath[1] === page ? blocks : (descendants.get(childrenPath[1]!) ?? [])
          const results = selected.slice(start, start + 100),
            more = start + results.length < selected.length
          const response = {
            object: "list",
            results,
            has_more: more,
            next_cursor: more ? String(start + results.length) : null,
          }
          return Effect.succeed(badPage ? badPage(response) : response)
        }
        if (path === `v1/pages/${page}/markdown` && options?.method === "PATCH") {
          expect(body).toEqual({
            markdown_version: "v2",
            type: "replace_content",
            replace_content: { new_str: "" },
          })
          blocks = []
          return Effect.succeed({
            object: "page_markdown",
            id: page,
            markdown: "",
            truncated: false,
            unknown_block_ids: [],
          })
        }
        if (path === `v1/blocks/${page}/children` && options?.method === "PATCH") {
          const children = property(body).children
          if (!Array.isArray(children)) return Effect.fail(fail("TEST_INVALID", "Missing blocks."))
          expect(children.length).toBeLessThanOrEqual(100)
          expect(bytes(JSON.stringify(body)).byteLength).toBeLessThanOrEqual(450000)
          const selected = unknown
          unknown = undefined
          if (selected === "absent")
            return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Request was not observed."))
          const added = (selected === "partial" ? children.slice(0, 1) : children).map(physical)
          blocks.push(...added)
          if (selected === "accepted" || selected === "partial")
            return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Response was lost."))
          return Effect.succeed({
            object: "list",
            results: badAck ? [] : added,
            has_more: false,
            next_cursor: null,
          })
        }
        return Effect.fail(fail("TEST_UNEXPECTED", path))
      }),
  }
  const dispatch: CurrentProjectionDispatch<never> = (input) =>
    Effect.gen(function* () {
      const observed = yield* input.observe({ fresh: pending === input.key })
      if (observed.status === "complete") {
        if (pending === input.key) pending = undefined
        return observed.value
      }
      if (pending !== undefined)
        return yield* Effect.fail(
          fail("WRITE_OUTCOME_UNKNOWN", "Observe the original action before proceeding."),
        )
      pending = input.key
      const value = yield* service.request(
        input.request.path,
        input.request.body,
        input.request.options,
      )
      const result = yield* input.acknowledge(value)
      pending = undefined
      return result
    })
  const run = <A, E>(effect: Effect.Effect<A, E, Notion>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(Notion, service)))
  return {
    run,
    calls,
    dispatch,
    apply: (
      plan: CurrentProjectionPlan,
      selected: CurrentFileContent = content,
      assertCurrent: Effect.Effect<void, SkillsError> = Effect.void,
    ) =>
      run(
        applyCurrentProjection({
          pageId: page,
          content: selected,
          plan,
          attachment: original,
          assertCurrent,
          dispatch,
        }),
      ),
    originals: () => blocks,
    replace: (value: Record<string, unknown>[]) => {
      blocks = value
    },
    descendants,
    mutatePage: (change: typeof badPage) => {
      badPage = change
    },
    loseAppend: (value: typeof unknown) => {
      unknown = value
    },
    badAcknowledgement: () => {
      badAck = true
    },
    pending: () => pending,
    writes: () => calls.filter((call) => call.method !== "GET"),
    resetCalls: () => {
      calls.length = 0
    },
  }
}

describe("complete current reading projections", () => {
  test("all ordinary text formats have complete language-specific bodies, with display normalization separate from bytes", () => {
    for (const [path, language] of [
      ["scripts/run.ts", "typescript"],
      ["style.css", "css"],
      ["data.json", "json"],
      ["page.html", "html"],
      ["config.yml", "yaml"],
      ["script.sh", "shell"],
      ["notes.txt", "plain text"],
      ["odd.constructor", "plain text"],
    ]) {
      const source = bytes("\uFEFFfirst\r\n" + '字😀\\"\n'.repeat(10000) + "FINAL\r\n")
      const before = new Uint8Array(source)
      const plan = renderCurrentProjection({ path: path!, bytes: source })
      expect(plan.representation).toBe("code")
      expect(planText(plan)).toBe(new TextDecoder().decode(source).replace(/\r\n?/gu, "\n"))
      expect(source).toEqual(before)
      for (const block of plan.blocks) {
        expect(block.type).toBe("code")
        if (block.type !== "code") throw new Error("code expected")
        expect(block.code.language).toBe(language!)
        expect(block.code.rich_text.length).toBeLessThanOrEqual(100)
        for (const span of block.code.rich_text) {
          expect(span.text.content.length).toBeLessThanOrEqual(2000)
          expect(/[\uD800-\uDBFF]$/u.test(span.text.content)).toBe(false)
          expect(/^[\uDC00-\uDFFF]/u.test(span.text.content)).toBe(false)
        }
      }
    }
    const utf16 = new Uint8Array(Buffer.from("\uFEFFhello\r\n😀", "utf16le"))
    expect(decodeCurrentProjectionText(utf16)).toBe("hello\n😀")
    expect(decodeCurrentProjectionText(new Uint8Array([0, 255]))).toBeUndefined()
  })

  test("Markdown has readable blocks and full literal fallback for unsupported constructs", () => {
    const markdown =
      "# Heading\n\nA **bold** [child](./guide.md) and `code`.\n\n> Quote\n\n- one\n- two\n\n```ts\nconst x = 1\n```\n\n<table><tr><td>literal</td></tr></table>\n\n| A | B |\n| - | - |\n| 1 | 2 |\n"
    const plan = renderCurrentProjection({
      path: "SKILL.md",
      bytes: bytes(markdown),
      rewriteLink: (href) => (href === "./guide.md" ? "https://www.notion.so/" + page : undefined),
    })
    expect(plan.representation).toBe("markdown")
    expect(plan.blocks.map((block) => block.type)).toContain("heading_1")
    expect(plan.blocks.map((block) => block.type)).toContain("quote")
    expect(plan.blocks.map((block) => block.type)).toContain("bulleted_list_item")
    expect(planText(plan)).toContain("const x = 1")
    expect(planText(plan)).toContain("<table><tr><td>literal</td></tr></table>")
    expect(planText(plan)).toContain("| 1 | 2 |")
    expect(JSON.stringify(plan)).toContain('"bold":true')
    expect(JSON.stringify(plan)).toContain("https://www.notion.so/" + page)
  })

  test("binary files require usable originals and images reuse that attachment for preview", () => {
    expect(() =>
      renderCurrentProjection({ path: "small.bin", bytes: new Uint8Array([0, 255]) }),
    ).toThrow("original attachment")
    const plan = renderCurrentProjection({
      path: "photo.png",
      bytes: new Uint8Array([137, 80, 78, 71]),
      attachment: { ...upload, name: "photo.png" },
    })
    expect(plan.representation).toBe("binary")
    expect(plan.blocks.map((block) => block.type)).toEqual(["image", "file"])
    expect(JSON.stringify(plan).match(new RegExp(upload.id, "g"))).toHaveLength(2)
    const sharedOriginal = renderCurrentProjection({
      path: "photo.png",
      bytes: new Uint8Array([137, 80, 78, 71]),
      attachment: { ...upload, name: "photo.png" },
      imagePreview: false,
    })
    expect(sharedOriginal.representation).toBe("binary")
    expect(sharedOriginal.blocks).toEqual([
      {
        object: "block",
        type: "file",
        file: {
          type: "file_upload",
          file_upload: { id: upload.id },
          name: "photo.png",
          caption: [],
        },
      },
    ])
  })

  test("known original formats stay binary even when their bytes happen to be readable ASCII", () => {
    const source = bytes("ASCII content alone does not make a container document editable text")
    for (const path of [
      "file.pdf",
      "file.docx",
      "file.woff2",
      "file.zip",
      "file.png",
      "file.mp4",
      "file.stl",
      "file.bin",
    ]) {
      expect(isCurrentProjectionBinary(path, source)).toBe(true)
      expect(() => renderCurrentProjection({ path, bytes: source })).toThrow("original attachment")
      expect(
        renderCurrentProjection({ path, bytes: source, attachment: upload }).representation,
      ).toBe("binary")
    }
    for (const path of [
      "drawing.svg",
      "data.xml",
      "data.json",
      "data.gltf",
      "README.md",
      "run.sh",
      "Dockerfile",
      "unknown.future",
    ]) {
      expect(isCurrentProjectionBinary(path, source)).toBe(false)
      expect(renderCurrentProjection({ path, bytes: source }).representation).not.toBe("binary")
    }
  })

  test("oversized Markdown paragraphs and fragmented trees keep full source in bounded blocks", () => {
    for (const source of ["字".repeat(190000), "# Heading\n\n".repeat(8200)]) {
      const plan = renderCurrentProjection({ path: "reference.md", bytes: bytes(source) })
      expect(planText(plan)).toBe(source)
      expect(plan.blocks.every((block) => block.type === "code")).toBe(true)
      for (const batch of currentProjectionBatches(plan.blocks))
        expect(bytes(JSON.stringify({ children: batch })).byteLength).toBeLessThanOrEqual(450000)
    }
  })

  test("batching preserves all text and bounds both block count and serialized bytes", () => {
    const source = 'x\\"😀\n'.repeat(200000) + "LAST"
    const plan = renderCurrentProjection({ path: "huge.json", bytes: bytes(source) })
    const batches = currentProjectionBatches(plan.blocks)
    expect(batches.length).toBeGreaterThan(2)
    expect(batches.flat()).toEqual([...plan.blocks])
    expect(planText(plan)).toBe(source)
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(100)
      expect(bytes(JSON.stringify({ children: batch })).byteLength).toBeLessThanOrEqual(450000)
    }
  })

  test("complete multi-page write reads only preflight and final inventories; rerun writes nothing", async () => {
    const plan = renderCurrentProjection({
      path: "many.txt",
      bytes: bytes("x".repeat(16000 * 102) + "END"),
    })
    const f = fixture()
    expect((await f.apply(plan)).blocks).toBe(103)
    expect(f.calls.filter((call) => call.method === "GET")).toHaveLength(3)
    expect(f.originals()).toHaveLength(103)
    f.resetCalls()
    expect(await f.apply(plan)).toMatchObject({ changed: false, blocks: 103 })
    expect(f.writes()).toHaveLength(0)
    expect(f.calls).toHaveLength(2)
  })

  test("changed generated content is replaced and native author bodies are never touched", async () => {
    const old = renderCurrentProjection({ path: "old.txt", bytes: bytes("old") })
    const next = renderCurrentProjection({ path: "old.txt", bytes: bytes("complete new") })
    const f = fixture(old.blocks)
    expect((await f.apply(next)).changed).toBe(true)
    expect(f.writes().map((call) => call.path)).toEqual([
      `v1/pages/${page}/markdown`,
      `v1/blocks/${page}/children`,
    ])
    f.resetCalls()
    await expect(
      f.apply(next, { kind: "native", mode: "100644", frontmatter: "" }),
    ).rejects.toMatchObject({ code: "CURRENT_PROJECTION_AUTHOR_BODY" })
    expect(f.calls).toHaveLength(0)
  })

  test("Notion may coalesce equivalent rich-text runs without changing the reading body", async () => {
    const text = "x".repeat(5000)
    const plan = renderCurrentProjection({ path: "long.txt", bytes: bytes(text) })
    const f = fixture(plan.blocks)
    const block = f.originals()[0]!
    f.replace([
      {
        ...block,
        code: { ...property(block.code), rich_text: [{ type: "text", text: { content: text } }] },
      },
    ])
    expect((await f.apply(plan)).changed).toBe(false)
    expect(f.writes()).toHaveLength(0)
  })

  test("accepted unknown append reconciles actual blocks without replay or duplicates", async () => {
    const plan = renderCurrentProjection({ path: "script.py", bytes: bytes("print('current')") })
    const f = fixture()
    f.loseAppend("accepted")
    await expect(f.apply(plan)).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    expect(f.pending()).toContain(":append:0")
    expect(f.originals()).toHaveLength(1)
    f.resetCalls()
    expect(await f.apply(plan)).toMatchObject({ blocks: 1, changed: false })
    expect(f.pending()).toBeUndefined()
    expect(f.writes()).toHaveLength(0)
    expect(f.originals()).toHaveLength(1)
  })

  test("unobserved or partial unknown append remains blocked instead of adding content repeatedly", async () => {
    const plan = renderCurrentProjection({ path: "script.py", bytes: bytes("x".repeat(20000)) })
    for (const outcome of ["absent", "partial"] satisfies Array<"absent" | "partial">) {
      const f = fixture()
      f.loseAppend(outcome)
      await expect(f.apply(plan)).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
      f.resetCalls()
      await expect(f.apply(plan)).rejects.toMatchObject({
        code: outcome === "partial" ? "CURRENT_PROJECTION_CONFLICT" : "WRITE_OUTCOME_UNKNOWN",
      })
      expect(f.writes()).toHaveLength(0)
      expect(f.pending()).toContain(":append:0")
    }
  })

  test("a misleading append ACK cannot complete, but actual accepted content can reconcile", async () => {
    const plan = renderCurrentProjection({ path: "run.sh", bytes: bytes("echo hello") })
    const f = fixture()
    f.badAcknowledgement()
    await expect(f.apply(plan)).rejects.toMatchObject({ code: "CURRENT_PROJECTION_INVALID" })
    f.resetCalls()
    expect((await f.apply(plan)).blocks).toBe(1)
    expect(f.writes()).toHaveLength(0)
  })

  test("binary comparison uses the verified original locator, not filename or caption", async () => {
    const plan = renderCurrentProjection({
      path: "small.bin",
      bytes: new Uint8Array([0, 255]),
      attachment: upload,
    })
    const f = fixture(plan.blocks)
    const old = f.originals()[0]!
    f.replace([
      {
        ...old,
        file: { ...property(old.file), file: { ...attachment(undefined, "wrong/file.bin").file } },
      },
    ])
    expect((await f.apply(plan)).changed).toBe(true)
    expect(f.writes()).toHaveLength(2)
    const saved = f.originals()[0]!
    f.replace([
      {
        ...saved,
        file: {
          ...property(saved.file),
          file: { ...attachment(undefined, "current/file.bin", "signature=renewed").file },
        },
      },
    ])
    f.resetCalls()
    expect((await f.apply(plan)).changed).toBe(false)
    expect(f.writes()).toHaveLength(0)
    await expect(
      f.run(
        applyCurrentProjection({
          pageId: page,
          content,
          plan,
          assertCurrent: Effect.void,
          dispatch: f.dispatch,
        }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_PROJECTION_INVALID" })
  })

  test("an existing original can be inspected without allocating an upload or writing its signed URL", async () => {
    const source = new Uint8Array([0, 255])
    const writable = renderCurrentProjection({
      path: "small.bin",
      bytes: source,
      attachment: upload,
    })
    const readOnly = renderCurrentProjection({
      path: "small.bin",
      bytes: source,
      attachment: { name: upload.name },
    })
    const f = fixture(writable.blocks)
    expect(
      await f.run(
        inspectCurrentProjection({ pageId: page, plan: readOnly, attachment: attachment() }),
      ),
    ).toMatchObject({ matches: true })
    expect(f.calls).toHaveLength(1)
    expect(f.writes()).toHaveLength(0)
    await expect(f.apply(readOnly)).rejects.toMatchObject({
      code: "CURRENT_PROJECTION_UPLOAD_REQUIRED",
    })
    expect(f.writes()).toHaveLength(0)
  })

  test("incomplete pagination, foreign blocks and child content cannot authorize clearing", async () => {
    const plan = renderCurrentProjection({ path: "readme.txt", bytes: bytes("new") })
    for (const transform of [
      (row: Record<string, unknown>) => ({ ...row, next_cursor: undefined }),
      (row: Record<string, unknown>) => ({ ...row, request_status: { type: "incomplete" } }),
      (row: Record<string, unknown>) => ({
        ...row,
        results: [
          {
            ...property(Array.isArray(row.results) ? row.results[0] : undefined),
            parent: { type: "page_id", page_id: id(55) },
          },
        ],
      }),
    ]) {
      const f = fixture(renderCurrentProjection({ path: "old.txt", bytes: bytes("old") }).blocks)
      f.mutatePage(transform)
      await expect(f.apply(plan)).rejects.toMatchObject({ code: "CURRENT_PROJECTION_INVALID" })
      expect(f.writes()).toHaveLength(0)
    }
    const f = fixture()
    f.replace([
      {
        object: "block",
        id: id(9),
        type: "child_page",
        parent: { type: "page_id", page_id: page },
        has_children: false,
        child_page: { title: "Unique child" },
      },
    ])
    await expect(f.apply(plan)).rejects.toMatchObject({ code: "CURRENT_PROJECTION_CHILD_CONTENT" })
    expect(f.writes()).toHaveLength(0)
  })

  test("lost authority stops before another projection mutation", async () => {
    const f = fixture()
    const plan = renderCurrentProjection({ path: "small.txt", bytes: bytes("current") })
    let checks = 0
    const guard = Effect.suspend(() =>
      ++checks === 1
        ? Effect.void
        : Effect.fail(fail("CURRENT_OPERATION_CONFLICT", "Another writer changed the owner.")),
    )
    await expect(f.apply(plan, content, guard)).rejects.toMatchObject({
      code: "CURRENT_OPERATION_CONFLICT",
    })
    expect(f.writes()).toHaveLength(0)
  })

  test("changed body replacement scans nested children and rejects hidden author pages", async () => {
    const plan = renderCurrentProjection({ path: "file.txt", bytes: bytes("current") })
    const f = fixture()
    f.replace([
      {
        object: "block",
        id: id(20),
        type: "toggle",
        has_children: true,
        parent: { type: "page_id", page_id: page },
        toggle: { rich_text: [] },
      },
    ])
    f.descendants.set(id(20), [
      {
        object: "block",
        id: id(21),
        type: "column_list",
        has_children: true,
        parent: { type: "block_id", block_id: id(20) },
        column_list: {},
      },
    ])
    f.descendants.set(id(21), [
      {
        object: "block",
        id: id(22),
        type: "child_page",
        has_children: false,
        parent: { type: "block_id", block_id: id(21) },
        child_page: { title: "Unique current child" },
      },
    ])
    await expect(f.apply(plan)).rejects.toMatchObject({ code: "CURRENT_PROJECTION_CHILD_CONTENT" })
    expect(f.writes()).toHaveLength(0)
    expect(f.calls).toHaveLength(3)
    f.resetCalls()
    await expect(f.run(assertCurrentBodyReplaceable(page))).rejects.toMatchObject({
      code: "CURRENT_PROJECTION_CHILD_CONTENT",
    })
    expect(f.calls).toHaveLength(3)
    expect(f.writes()).toHaveLength(0)
    f.descendants.set(id(21), [
      {
        object: "block",
        id: id(22),
        type: "paragraph",
        has_children: false,
        parent: { type: "block_id", block_id: id(21) },
        paragraph: { rich_text: [] },
      },
    ])
    f.resetCalls()
    expect((await f.apply(plan)).changed).toBe(true)
    expect(f.writes()).toHaveLength(2)
  })
})
