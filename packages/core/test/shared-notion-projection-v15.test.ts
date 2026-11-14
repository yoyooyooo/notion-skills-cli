import { expect, test } from "bun:test"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
  validateSharedNotionMarkdownProjection,
} from "../src/shared-notion-projection.ts"
import { projectNativeTableHostnames } from "../src/shared-notion-table-hostnames.ts"

test("new authoring predicts the observed localhost hyperlink in ordinary table text, without weakening readback", () => {
  const input =
    "| Client | Network |\n| --- | --- |\n| Cloud bot | Do not use localhost or `127.0.0.1`; use public HTTPS. |"
  const old = projectSharedNotionMarkdown(input, { version: 13, purpose: "data_source_create" })
  const current = projectSharedNotionMarkdown(input, { purpose: "data_source_create" })
  expect(current.version).toBe(15)
  expect(current.markdown).toBe(
    old.markdown.replace("use localhost or", "use [localhost](http://localhost) or"),
  )
  expect(sharedNotionMarkdownWire(current)).toBe(sharedNotionMarkdownWire(old))
  expect(validateSharedNotionMarkdownProjection(old)).toEqual(old)
  expect(validateSharedNotionMarkdownProjection(current)).toEqual(current)
  expect(() => validateSharedNotionMarkdownProjection({ ...old, version: 15 })).toThrow()
})

test("existing destinations, literal code and unobserved hostname shapes are not reinterpreted", () => {
  for (const cell of [
    "`localhost`",
    "<code>localhost</code>",
    "<b>localhost</b>",
    "[localhost](https://example.test)",
    "![localhost](asset.png)",
    "localhost:3000",
    "localhost/path",
    "a.localhost",
    "localhost.example",
    "LOCALHOST",
  ]) {
    const input = `| Value |\n| --- |\n| ${cell} |`
    expect(projectSharedNotionMarkdown(input).markdown).toBe(
      projectSharedNotionMarkdown(input, { version: 13 }).markdown,
    )
  }
  const code = "```text\n| localhost |\n| --- |\n| localhost |\n```"
  expect(projectSharedNotionMarkdown(code).markdown).toBe(
    projectSharedNotionMarkdown(code, { version: 13 }).markdown,
  )
  expect(projectSharedNotionMarkdown("Paragraph localhost.").markdown).toBe(
    projectSharedNotionMarkdown("Paragraph localhost.", { version: 13 }).markdown,
  )
  const unrelated = "| Value |\n| --- |\n| a\\|b |\n\nParagraph localhost."
  expect(projectNativeTableHostnames(unrelated)).toBe(unrelated)
  // The earlier complete-table policy already refuses this escaped-pipe shape.
  // v15 must preserve that refusal, not broaden supported Markdown merely to
  // prove the independent hostname pass leaves an unrelated paragraph alone.
  for (const version of [13, 15] as const) {
    try {
      projectSharedNotionMarkdown(unrelated, { version })
      throw new Error("The existing unsupported table must stay unsupported")
    } catch (error) {
      expect(error).toHaveProperty("code", "SHARED_MARKDOWN_PROJECTION_UNSUPPORTED")
    }
  }
})
