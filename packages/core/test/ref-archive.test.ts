import { describe, expect, test } from "bun:test"
import { readArchive } from "../src/archive.ts"
import { normalizePath, pageId, parseRef, resolveRef } from "../src/ref.ts"
import { aliasFor, resolveRecord, type Catalog } from "../src/model.ts"
import { mainContent, skillBundle, tarGzip } from "./fixtures.ts"

const id = "12345678-1234-1234-1234-123456789abc"
const snapshot = "s_" + "a".repeat(64)

function failureOf(operation: () => unknown): unknown {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error("Expected an operation failure")
}

describe("protocol references", () => {
  test("round trips names and paths and keeps snapshot across nested relative links", () => {
    const ref = `skill://Resource%20Governance/references/deep/guide.md?snapshot=${snapshot}`
    expect(parseRef(ref)).toEqual({
      selector: "Resource Governance",
      path: "references/deep/guide.md",
      snapshot,
    })
    expect(resolveRef(ref, "../../assets/词表.md")).toBe(
      `skill://Resource%20Governance/assets/%E8%AF%8D%E8%A1%A8.md?snapshot=${snapshot}`,
    )
    expect(pageId(`https://app.notion.com/p/title-${id.replaceAll("-", "")}?v=x`)).toBe(id)
    expect(pageId(`https://www.notion.so/${id.replaceAll("-", "")}`)).toBe(id)
    expect(pageId(`https://example.com/${id.replaceAll("-", "")}`)).toBeUndefined()
  })
  test("rejects encoded traversal, unsupported parameters and malformed refs", () => {
    for (const ref of [
      "skill://sample/%2e%2e/secret",
      "skill://sample/a?token=x",
      "skill://sample/%ZZ",
      "skill://sample/a?snapshot=x",
      "skill://sample/%2Fetc/passwd",
    ]) {
      expect(() => parseRef(ref)).toThrow()
    }
    expect(() => normalizePath("../../outside", "references/a.md")).toThrow()
    expect(() =>
      resolveRef(`skill://sample/SKILL.md?snapshot=${snapshot}`, "https://example.com"),
    ).toThrow()
  })
})

describe("skill identity", () => {
  test("derives invocation aliases without constraining display name spelling", () => {
    expect(aliasFor("Resource Tag Governance")).toBe("resource-tag-governance")
    expect(aliasFor("MCP Server")).toBe("mcp-server")
    expect(aliasFor("a".repeat(64))).toBe("a".repeat(64))
    expect(aliasFor("Tty7")).toBe("tty7")
    expect(aliasFor("n8n-workflow")).toBe("n8n-workflow")
    expect(aliasFor("React19")).toBe("react19")
    expect(aliasFor("中文")).toBe("中文")
    expect(aliasFor(" Agent  Workflow ")).toBe("agent-workflow")
    expect(aliasFor("Agent_Skill")).toBe("agent_skill")
    expect(aliasFor("Agent\u00a0Skill")).toBe("agent-skill")
    expect(aliasFor("a".repeat(65))).toBe("a".repeat(65))
    for (const name of [
      "",
      "  ",
      "Agent\tSkill",
      "Agent\nSkill",
      "Agent\rSkill",
      "Agent\u200bSkill",
      "Agent\ud800Skill",
    ]) {
      expect(failureOf(() => aliasFor(name))).toMatchObject({
        code: "INVALID_SKILL_NAME",
        details: { name },
      })
    }
  })
  const skill = {
    id: `notion_page:${id}`,
    kind: "skill" as const,
    entrypoint: "SKILL.md",
    locator: { type: "notion_page" as const, page_id: id, database_id: "db", data_source_id: "ds" },
    name: "Sample Skill",
    alias: "sample-skill",
    description: "Use samples",
    default_context: false,
    ref: `skill://${id}/SKILL.md`,
  }
  const directory: Catalog = {
    scope: "scope",
    fetched_at: 0,
    databases: [],
    records: [skill],
    coverage: {
      method: "search",
      exhaustive: false,
      queried_data_sources: ["ds"],
      failed_sources: [],
      search_index_limited: true,
    },
  }
  test("resolves exact name and alias but does not silently choose on collisions", () => {
    expect(resolveRecord("Sample Skill", directory).id).toBe(`notion_page:${id}`)
    expect(resolveRecord("sample-skill", directory).id).toBe(`notion_page:${id}`)
    expect(failureOf(() => resolveRecord("missing", directory))).toMatchObject({
      code: "SKILL_NOT_FOUND",
      details: { selector: "missing", candidates: [], coverage: directory.coverage },
    })
    const other = { ...skill, id: "other", name: "sample skill" }
    expect(
      failureOf(() => resolveRecord("sample-skill", { ...directory, records: [skill, other] })),
    ).toMatchObject({
      code: "SKILL_AMBIGUOUS",
      details: { selector: "sample-skill", candidates: [skill, other] },
    })
  })
  test("incomplete discovery cannot claim a unique match", () => {
    const coverage = {
      ...directory.coverage,
      failed_sources: [
        {
          id: "failed",
          code: "ACCESS_DENIED",
          database_id: "db",
          alias: "ops",
          title: "Operations Skills",
          data_source_id: "failed",
        },
      ],
    }
    expect(
      failureOf(() => resolveRecord("Sample Skill", { ...directory, coverage })),
    ).toMatchObject({ code: "CATALOG_INCOMPLETE", details: coverage })
  })
})

describe("archive import", () => {
  test("preserves nested files and UTF-8 BOM bytes", () => {
    const archive = readArchive(skillBundle)
    expect(archive.name).toBe("sample-skill")
    expect(archive.files.map((f) => f.path)).toEqual([
      "assets/data.bin",
      "references/guide.md",
      "SKILL.md",
    ])
    expect(
      new TextDecoder().decode(archive.files.find((f) => f.path === "references/guide.md")!.data),
    ).toBe("第一行\n第二行\n第三行")
  })
  test("preserves authored names with exact native directories or their invocation aliases", () => {
    for (const name of ["Tty7", "n8n-workflow", "React19", "中文", "Agent Workflow"]) {
      const content = `---\nname: ${JSON.stringify(name)}\ndescription: Use this workflow\n---\n\nContent\n`
      for (const root of [name, aliasFor(name)]) {
        const archive = readArchive(tarGzip([{ name: `${root}/SKILL.md`, content }]))
        expect(archive.name).toBe(name)
        expect(new TextDecoder().decode(archive.files[0]!.data)).toBe(content)
      }
      expect(() => readArchive(tarGzip([{ name: "different-name/SKILL.md", content }]))).toThrow(
        expect.objectContaining({ code: "INVALID_SKILL" }),
      )
    }
  })
  test("rejects empty and control characters in native frontmatter names", () => {
    for (const name of ["", "  ", "Agent\tSkill", "Agent\u200bSkill"]) {
      expect(() =>
        readArchive(
          tarGzip([
            {
              name: "sample-skill/SKILL.md",
              content: `---\nname: ${JSON.stringify(name)}\ndescription: Use this workflow\n---\nBody`,
            },
          ]),
        ),
      ).toThrow(expect.objectContaining({ code: "INVALID_SKILL_NAME" }))
    }
  })
  test("rejects links, traversal, duplicate files and invalid entrypoint names", () => {
    for (const extra of [
      { name: "sample-skill/link", content: "", type: "2" },
      { name: "sample-skill/../../secret", content: "private" },
      { name: "sample-skill/SKILL.md", content: mainContent },
    ]) {
      expect(() =>
        readArchive(tarGzip([{ name: "sample-skill/SKILL.md", content: mainContent }, extra])),
      ).toThrow()
    }
    expect(() => readArchive(tarGzip([{ name: "wrong/SKILL.md", content: mainContent }]))).toThrow()
  })
})
