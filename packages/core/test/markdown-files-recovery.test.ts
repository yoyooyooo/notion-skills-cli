import { expect, test } from "bun:test"
import { Effect } from "effect"
import { reconcileMarkdownFileAppend } from "../src/markdown-files-recovery.ts"
import { markdownFileCode, markdownFilesHeader, markdownFileSpans } from "../src/markdown-files.ts"
import { fail } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"
import type { Receipt } from "../src/publication-model.ts"
import { observation } from "../src/publication-observation.ts"

function fixture(mode: "applied" | "absent" | "partial" | "edited" | "metadata" | "racing") {
  const header = {
    type: "paragraph",
    paragraph: { rich_text: markdownFileSpans(markdownFilesHeader("SKILL.md")) },
  }
  const contents = "---\nname: Example\n---\n\n```sh\nprintf '%s\\n' '<keep>'\n```\n"
  const codes = [markdownFileCode(contents.slice(0, 20)), markdownFileCode(contents.slice(20))]
  const toggle = {
    type: "toggle",
    toggle: { rich_text: markdownFileSpans("SKILL.md"), children: codes },
  }
  const page = {
    id: "page",
    parent: { type: "data_source_id", data_source_id: "table" },
    last_edited_time: "before",
    properties: { title: { id: "title", type: "title", title: markdownFileSpans("Example") } },
  }
  const receipt: Receipt = {
    format: 1,
    operation_id: "p_test",
    operation: "create",
    context: { markdown_files: true },
    page_id: "page",
    state: "unknown",
    portable: {
      kind: "skill",
      name: "Example",
      description: "Example instructions",
      main: "SKILL.md",
      files: [],
    },
    guards: { "v1/pages/page": observation("v1/pages/page", page) },
    stages: [],
    intents: [
      { method: "POST", path: "v1/pages", status: "completed", response: { id: "page" } },
      {
        method: "PATCH",
        path: "v1/blocks/page/children",
        status: "completed",
        body: { children: [header] },
      },
      {
        method: "PATCH",
        path: "v1/blocks/page/children",
        status: "unknown",
        body: { children: [toggle] },
      },
    ],
  }
  let reads = 0,
    writes = 0
  const rootBlocks = [
    { ...header, id: "marker", has_children: false, parent: { type: "page_id", page_id: "page" } },
    ...(mode === "absent"
      ? []
      : [
          {
            type: toggle.type,
            toggle: { rich_text: toggle.toggle.rich_text },
            id: "file",
            has_children: true,
            parent: { type: "page_id", page_id: "page" },
          },
        ]),
  ]
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        if (body !== undefined || (options?.method && options.method !== "GET")) {
          writes++
          return yield* Effect.fail(fail("UNEXPECTED", "Recovery attempted a mutation."))
        }
        if (path === "v1/pages/page") {
          reads++
          return {
            ...page,
            last_edited_time: mode === "racing" ? String(reads) : "after",
            ...(mode === "metadata" ? { properties: {} } : {}),
          }
        }
        if (path === "v1/pages/page/markdown")
          return {
            object: "page_markdown",
            markdown: "live view",
            truncated: false,
            unknown_block_ids: [],
          }
        if (path === "v1/blocks/page/children?page_size=100")
          return { results: rootBlocks, has_more: false, next_cursor: null }
        if (path === "v1/blocks/file/children?page_size=100")
          return {
            results: (mode === "partial"
              ? codes.slice(0, 1)
              : mode === "edited"
                ? [markdownFileCode("Changed instruction")]
                : codes
            ).map((code, index) => ({
              ...code,
              id: `code-${index}`,
              has_children: false,
              parent: { type: "block_id", block_id: "file" },
            })),
            has_more: false,
            next_cursor: null,
          }
        return yield* Effect.fail(fail("UNEXPECTED", "Unexpected fixture path", { path }))
      }),
  }
  return { receipt, api, writes: () => writes }
}

test("an unknown append reconciles only the complete intended editable tree without writing", async () => {
  const f = fixture("applied")
  await Effect.runPromise(reconcileMarkdownFileAppend(f.receipt, f.api))
  expect(f.receipt.intents.at(-1)!.status).toBe("completed")
  expect(f.receipt.intents.at(-1)!.response).toEqual({
    recovery: "observed_applied",
    prior_status: "unknown",
  })
  expect(f.writes()).toBe(0)
})
for (const mode of ["absent", "partial", "edited", "metadata", "racing"] as const) {
  test(`unknown append ${mode} remains unknown without replay or receipt changes`, async () => {
    const f = fixture(mode),
      before = JSON.stringify(f.receipt)
    const result = await Effect.runPromise(
      reconcileMarkdownFileAppend(f.receipt, f.api).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure")
      expect(result.failure.code).toBe(
        mode === "metadata"
          ? "WRITE_CONFLICT"
          : mode === "racing"
            ? "PUBLICATION_CHANGED"
            : "PUBLICATION_UNRESOLVED",
      )
    expect(JSON.stringify(f.receipt)).toBe(before)
    expect(f.writes()).toBe(0)
  })
}
