import { expect, test } from "bun:test"
import { zipSync, type Zippable } from "fflate"
import { importDocument, importEntrypoint, readImportZip } from "../src/import.ts"

const text = (path: string, content: string) => ({ path, bytes: new TextEncoder().encode(content) })
const skill = text(
  "SKILL.md",
  "---\nname: sample-workflow\ndescription: Use when checking a workflow\n---\n\n# Steps\n\nRead the guide.\n",
)

test("ZIP imports remove one wrapper, choose SKILL.md, and preserve attachment bytes", () => {
  const attachment = new Uint8Array([0, 1, 255, 42])
  const files = readImportZip(
    zipSync({ "sample/SKILL.md": skill.bytes, "sample/guide.bin": attachment }),
  )
  const entry = importEntrypoint(files)
  expect(entry.main.path).toBe("SKILL.md")
  expect(importDocument(entry.main)).toEqual({
    name: "Sample Workflow",
    description: "Use when checking a workflow",
    body: "# Steps\n\nRead the guide.\n",
  })
  expect(entry.attachments).toEqual([{ path: "guide.bin", bytes: attachment }])
})

test("folder imports choose the canonical entrypoint and refuse ambiguous Markdown roots", () => {
  const readme = text("README.md", "# Read me")
  expect(importEntrypoint([readme, skill]).attachments).toEqual([readme])
  expect(
    importEntrypoint([text("workflow.md", "# Work"), text("guide.txt", "Read")]).main.path,
  ).toBe("workflow.md")
  expect(() => importEntrypoint([readme, text("guide.md", "# Guide")])).toThrow(
    expect.objectContaining({ code: "IMPORT_AMBIGUOUS" }),
  )
})

test("any single Markdown filename becomes the body with explicit or frontmatter metadata", () => {
  const plain = text("my_workflow.MD", "# Workflow\n\nFollow these steps.\n")
  expect(
    importDocument(importEntrypoint([plain], true).main, { description: "Use for this workflow" }),
  ).toEqual({
    name: "My Workflow",
    description: "Use for this workflow",
    body: "# Workflow\n\nFollow these steps.\n",
  })
  expect(
    importDocument(
      { ...skill, path: "任意文件.md" },
      { name: "Imported Workflow", description: "New description" },
    ),
  ).toEqual({
    name: "Imported Workflow",
    description: "New description",
    body: "# Steps\n\nRead the guide.\n",
  })
  expect(() => importDocument(plain)).toThrow(expect.objectContaining({ code: "INVALID_SKILL" }))
  expect(() =>
    importDocument(text("说明.md", "# Content"), { description: "Description" }),
  ).toThrow(expect.objectContaining({ code: "INVALID_SKILL_NAME" }))
})

test("imports preserve ordinary Markdown frontmatter and retain Skill metadata for portability", () => {
  const ordinary = text("workflow.md", "---\nauthor: Someone\n---\n\n# Content")
  expect(importDocument(ordinary, { description: "Use this" }).body).toBe(
    new TextDecoder().decode(ordinary.bytes),
  )
  const extended = text(
    "SKILL.md",
    "---\nname: sample\ndescription: Use this\ncompatibility: Bun\n---\n# Content",
  )
  expect(importDocument(extended)).toEqual({
    name: "Sample",
    description: "Use this",
    body: "# Content",
  })
  expect(() =>
    importDocument(
      { path: "workflow.md", bytes: new Uint8Array([0xff]) },
      { description: "Use this" },
    ),
  ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }))
})

test("ZIP imports reject traversal, duplicate normalized paths, links, corrupt data and oversized declarations", () => {
  const unsafe: Zippable[] = [
    { "../SKILL.md": skill.bytes },
    { "/SKILL.md": skill.bytes },
    { "SKILL.md": skill.bytes, "./SKILL.md": skill.bytes },
  ]
  for (const entries of unsafe) expect(() => readImportZip(zipSync(entries))).toThrow()
  const link = zipSync({ "SKILL.md": [skill.bytes, { attrs: 0xa1ff << 16, os: 3 }] })
  expect(() => readImportZip(link)).toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }))
  const corrupt = zipSync({ "SKILL.md": skill.bytes }, { level: 0 })
  const view = new DataView(corrupt.buffer)
  corrupt[30 + view.getUint16(26, true)]! ^= 1
  expect(() => readImportZip(corrupt)).toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }))
  const tooLarge = zipSync({ "SKILL.md": skill.bytes })
  const sizes = new DataView(tooLarge.buffer)
  const directory = sizes.getUint32(tooLarge.length - 6, true)
  sizes.setUint32(directory + 24, 128 * 1024 * 1024 + 1, true)
  expect(() => readImportZip(tooLarge)).toThrow(
    expect.objectContaining({ code: "ARCHIVE_TOO_LARGE" }),
  )
  expect(() => readImportZip(new Uint8Array([1, 2, 3]))).toThrow(
    expect.objectContaining({ code: "INVALID_ARCHIVE" }),
  )
})
