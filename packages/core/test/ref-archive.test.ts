import { describe, expect, test } from "bun:test"
import { readArchive } from "../src/archive.ts"
import { normalizePath, pageId, parseRef, resolveRef } from "../src/ref.ts"
import { aliasFor, resolveSkill, type Catalog } from "../src/model.ts"
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
  test("derives invocation names from English words and rejects other title forms", () => {
    expect(aliasFor("Resource Tag Governance")).toBe("resource-tag-governance")
    expect(aliasFor("MCP Server")).toBe("mcp-server")
    expect(aliasFor("a".repeat(64))).toBe("a".repeat(64))
    for (const name of [
      "",
      "资源治理",
      "Agent V2",
      "Agent-Skill",
      "Agent_Skill",
      " Agent Skill",
      "Agent Skill ",
      "Agent  Skill",
      "Agent\tSkill",
      "Agent\nSkill",
      "Agent Skill\n",
      "Agent Skill\r",
      "Agent Skill\r\n",
      "Agent\u00a0Skill",
      "Ａgent Skill",
      "a".repeat(65),
    ]) {
      expect(failureOf(() => aliasFor(name))).toMatchObject({
        code: "INVALID_SKILL_NAME",
        details: { name },
      })
    }
  })
  const skill = {
    id,
    name: "Sample Skill",
    alias: "sample-skill",
    description: "Use samples",
    database_id: "db",
    data_source_id: "ds",
    ref: `skill://${id}/SKILL.md`,
  }
  const directory: Catalog = {
    scope: "scope",
    fetched_at: 0,
    databases: [],
    skills: [skill],
    coverage: {
      method: "search",
      exhaustive: false,
      queried_data_sources: ["ds"],
      failed_sources: [],
      search_index_limited: true,
    },
  }
  test("resolves exact name and alias but does not silently choose on collisions", () => {
    expect(resolveSkill("Sample Skill", directory).id).toBe(id)
    expect(resolveSkill("sample-skill", directory).id).toBe(id)
    expect(failureOf(() => resolveSkill("missing", directory))).toMatchObject({
      code: "SKILL_NOT_FOUND",
      details: { selector: "missing", candidates: [], coverage: directory.coverage },
    })
    const other = { ...skill, id: "other", name: "sample skill" }
    expect(
      failureOf(() => resolveSkill("sample-skill", { ...directory, skills: [skill, other] })),
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
    expect(failureOf(() => resolveSkill("Sample Skill", { ...directory, coverage }))).toMatchObject(
      { code: "CATALOG_INCOMPLETE", details: coverage },
    )
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
