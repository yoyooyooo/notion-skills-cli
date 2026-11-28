import { describe, expect, test } from "bun:test"
import { normalizePath, pageId, parseRef, resolveRef } from "../src/ref.ts"
import { aliasFor } from "../src/model.ts"

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
  test("round trips stable identities and paths and keeps snapshots across nested relative links", () => {
    const ref = `skill://resource-governance/references/deep/guide.md?library=0602093b-7ffd-5687-9f6a-8a78fa5cd2ba&snapshot=${snapshot}`
    expect(parseRef(ref)).toMatchObject({
      skillId: "resource-governance",
      scope: { kind: "library", libraryId: "0602093b-7ffd-5687-9f6a-8a78fa5cd2ba" },
      path: "references/deep/guide.md",
      selection: { kind: "fixed", snapshotId: snapshot },
    })
    expect(resolveRef(ref, "../../assets/词表.md")).toBe(
      `skill://resource-governance/assets/%E8%AF%8D%E8%A1%A8.md?library=0602093b-7ffd-5687-9f6a-8a78fa5cd2ba&snapshot=${snapshot}`,
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
})
