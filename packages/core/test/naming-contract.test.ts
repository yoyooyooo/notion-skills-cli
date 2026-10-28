import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  aliasFor,
  DisplayNameSchema,
  resolveRecord,
  validateDisplayName,
  type Catalog,
  type ContentRecord,
} from "../src/model.ts"
import { fileRef, parseRef, parseTarget } from "../src/ref.ts"
import { SubscriptionInputSchema } from "../src/upstream-model.ts"

const page = "12345678-1234-4234-8234-123456789abc"
const other = "22345678-1234-4234-8234-123456789abc"
function record(name: string, id = page): ContentRecord {
  return {
    id: `notion_page:${id}`,
    kind: "skill",
    name,
    alias: aliasFor(name),
    description: "Use this skill",
    default_context: false,
    entrypoint: "SKILL.md",
    ref: fileRef(id, "SKILL.md"),
    locator: { type: "notion_page", page_id: id, database_id: "db", data_source_id: "ds" },
  }
}
function catalog(records: readonly ContentRecord[]): Catalog {
  return {
    scope: "test",
    fetched_at: 0,
    databases: [],
    records,
    coverage: {
      method: "search",
      exhaustive: true,
      queried_data_sources: ["ds"],
      failed_sources: [],
      search_index_limited: false,
    },
  }
}

describe("human names and callable aliases", () => {
  test("preserves names while normalizing safe aliases deterministically", () => {
    for (const [name, alias] of [
      ["Tty7", "tty7"],
      ["n8n-workflow", "n8n-workflow"],
      ["React19", "react19"],
      ["中文", "中文"],
      ["Agent  Skill", "agent-skill"],
      [" Agent Skill ", "agent-skill"],
      ["name@scope/ref", "name%40scope%2Fref"],
      ["$(echo x);'", "%24%28echo-x%29%3B%27"],
      ["--option", "%2D-option"],
      ["e\u0301", "é"],
    ] as const) {
      expect(validateDisplayName(name)).toBe(name)
      expect(Schema.decodeUnknownSync(DisplayNameSchema)(name)).toBe(name)
      expect(aliasFor(name)).toBe(alias)
      expect(parseRef(fileRef(alias, "SKILL.md")).selector).toBe(alias)
    }
  })

  test("uses the same name schema for direct subscription input and rejects controls", () => {
    for (const name of ["", "  ", "Tty\u00007", "React\n19", "a\u007fb", "a\u200bb", "\ud800"]) {
      expect(() => validateDisplayName(name)).toThrow()
      expect(Schema.is(DisplayNameSchema)(name)).toBe(false)
      expect(
        Schema.is(SubscriptionInputSchema)({
          name,
          target_database_id: page,
          description: "Use it",
          default_context: false,
          enabled: true,
          source: { provider: { type: "git", url: "file:///unused", ref: "main" } },
          roots: ["skills"],
          include: [],
          exclude: [],
          mapping: {},
        }),
      ).toBe(false)
    }
  })

  test("reports alias collisions and selects stable identity without name shadowing", () => {
    const first = record("Agent Skill"),
      second = record("Agent  Skill", other)
    const directory = catalog([first, second])
    expect(() => resolveRecord("agent-skill", directory)).toThrow()
    try {
      resolveRecord("agent-skill", directory)
    } catch (error) {
      expect(error).toMatchObject({
        code: "SKILL_AMBIGUOUS",
        details: {
          exact_selectors: [
            { id: first.id, ref: first.ref },
            { id: second.id, ref: second.ref },
          ],
        },
      })
    }
    const identityShadow = record(first.id, other)
    expect(resolveRecord(first.id, catalog([first, identityShadow])).id).toBe(first.id)
    expect(resolveRecord(parseRef(first.ref).selector, directory).id).toBe(first.id)
    expect(first.locator).toEqual(record("renamed", page).locator)
  })

  test("encoded alias and reference delimiters retain exact selection", () => {
    const value = record("name@scope/ref")
    const ref = fileRef(value.alias, "references/中文.md")
    expect(ref).toContain("name%2540scope%252Fref")
    expect(parseTarget(ref)).toEqual({
      selector: value.alias,
      path: "references/中文.md",
      snapshot: undefined,
    })
    expect(resolveRecord(parseRef(ref).selector, catalog([value])).id).toBe(value.id)
    for (const invalid of [
      "skill://name%00/SKILL.md",
      "skill://name%0A/SKILL.md",
      "skill://name%2Fscope/SKILL.md",
    ])
      expect(() => parseRef(invalid)).toThrow()
    expect(() => parseTarget("Tty\u00007")).toThrow()
  })
})
