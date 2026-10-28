import { expect, test } from "bun:test"
import { Effect } from "effect"
import { appendMarkdownFiles } from "../src/markdown-files-publication.ts"
import {
  decodeMarkdownFiles,
  markdownFileCode,
  markdownFilesHeader,
  markdownFileSpans,
} from "../src/markdown-files.ts"
import { fail, property } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"

// An interrupted UTF-8 file resumes at its exact saved prefix, including a chunk
// boundary next to a surrogate pair. Existing bytes must not be emitted again.
test("resuming a multi-chunk editable file appends only the missing suffix", async () => {
  const prefix = "x".repeat(29999) + "🙂\r\n",
    suffix = "y".repeat(60001) + "\n```sh\necho '<keep>'\n```\n"
  const header = {
    id: "marker",
    type: "paragraph",
    parent: { page_id: "page" },
    paragraph: { rich_text: markdownFileSpans(markdownFilesHeader("SKILL.md")) },
  }
  const existing = [
    header,
    {
      id: "file",
      type: "toggle",
      parent: { page_id: "page" },
      toggle: { rich_text: markdownFileSpans("SKILL.md") },
    },
    { ...markdownFileCode(prefix), id: "code", parent: { block_id: "file" } },
  ]
  const appended: string[] = []
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        if (path !== "v1/blocks/file/children" || options?.method !== "PATCH")
          return yield* Effect.fail(
            fail("UNEXPECTED", "A resumed file tried to recreate its path or header", { path }),
          )
        const children = property(body).children
        if (!Array.isArray(children))
          return yield* Effect.fail(fail("UNEXPECTED", "Missing code chunks"))
        for (const child of children) {
          const spans = property(property(child).code).rich_text
          if (!Array.isArray(spans))
            return yield* Effect.fail(fail("UNEXPECTED", "Missing literal content"))
          appended.push(spans.map((span) => String(property(property(span).text).content)).join(""))
        }
        return { results: [] }
      }),
  }
  await Effect.runPromise(
    appendMarkdownFiles(
      {
        kind: "skill",
        name: "Example",
        description: "Example instructions",
        main: "SKILL.md",
        files: [{ path: "SKILL.md", bytes: new TextEncoder().encode(prefix + suffix) }],
      },
      "page",
      api,
      existing,
    ),
  )
  expect(prefix + appended.join("")).toBe(prefix + suffix)
})

test("bounded allocation batches preserve large escaped Unicode files and empty resources", async () => {
  const files = Array.from({ length: 105 }, (_, index) => ({
    path: index === 0 ? "SKILL.md" : `references/中文-${index}.md`,
    bytes: new TextEncoder().encode(
      index === 0
        ? '中文🙂\\"\n'.repeat(60000)
        : index === 104
          ? ""
          : `# Source ${index}\n\n\`\`\`sh\necho '<${index}>'\n\`\`\`\n`,
    ),
  }))
  const blocks: Record<string, unknown>[] = []
  let sequence = 0
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        const owner = /^v1\/blocks\/([^/]+)\/children$/.exec(path)?.[1]
        if (!owner || options?.method !== "PATCH")
          return yield* Effect.fail(fail("UNEXPECTED", "Unexpected allocation owner", { path }))
        const children = property(body).children
        const blockCount = (values: unknown[]): number =>
          values.reduce<number>((count, value) => {
            const raw = property(value),
              nested = property(raw[String(raw.type)]).children
            return count + 1 + (Array.isArray(nested) ? blockCount(nested) : 0)
          }, 0)
        if (
          !Array.isArray(children) ||
          blockCount(children) > 100 ||
          new TextEncoder().encode(JSON.stringify(body)).length > 500000
        )
          return yield* Effect.fail(fail("REQUEST_TOO_LARGE", "Exceeded Notion append bounds"))
        const parentIndex = owner === "page" ? -1 : blocks.findIndex((block) => block.id === owner)
        if (owner !== "page" && parentIndex < 0)
          return yield* Effect.fail(fail("UNEXPECTED", "Unknown file owner"))
        const added: Record<string, unknown>[] = [],
          results: Array<{ id: string }> = []
        for (const child of children) {
          const raw = property(child),
            id = `block-${sequence++}`,
            type = String(raw.type),
            payload = property(raw[type])
          const { children: nested, ...content } = payload
          added.push({
            ...raw,
            [type]: content,
            id,
            parent:
              owner === "page"
                ? { type: "page_id", page_id: owner }
                : { type: "block_id", block_id: owner },
            has_children: Array.isArray(nested),
          })
          results.push({ id })
          if (Array.isArray(nested))
            for (const code of nested)
              added.push({
                ...property(code),
                id: `block-${sequence++}`,
                parent: { type: "block_id", block_id: id },
                has_children: false,
              })
        }
        if (owner === "page") blocks.push(...added)
        else {
          let end = parentIndex + 1
          while (end < blocks.length && property(blocks[end]!.parent).block_id === owner) end++
          blocks.splice(end, 0, ...added)
        }
        return { results }
      }),
  }
  await Effect.runPromise(
    appendMarkdownFiles(
      {
        kind: "skill",
        name: "Example",
        description: "Example instructions",
        main: "SKILL.md",
        files,
      },
      "page",
      api,
    ),
  )
  expect(decodeMarkdownFiles(blocks)!.files).toEqual(files)
})
