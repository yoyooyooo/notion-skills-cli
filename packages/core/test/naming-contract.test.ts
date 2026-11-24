import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  aliasFor,
  DisplayNameSchema,
  validateDisplayName,
  type Catalog,
  type ContentRecord,
} from "../src/model.ts"
import { fileRef, parseRef, parseTarget } from "../src/ref.ts"

import { resolveCatalogReference } from "../src/catalog-reference.ts"
import { currentLibrary } from "./shared-current-fixture.ts"

const page = "12345678-1234-4234-8234-123456789abc"
const other = "22345678-1234-4234-8234-123456789abc"
function record(name: string, id = page): ContentRecord {
  return {
    id: `skill://${id}?library=00000000-0000-4000-8000-000000000002`,
    kind: "skill",
    name,
    alias: aliasFor(name),
    description: "Use this skill",
    default_context: false,
    enabled: true,
    entrypoint: "SKILL.md",
    ref: fileRef(`skill://${id}?library=00000000-0000-4000-8000-000000000002`, "SKILL.md"),
    locator: {
      type: "shared_skill",
      library_id: "00000000-0000-4000-8000-000000000002",
      skill_id: id,
      page_id: id,
      database_id: currentLibrary.skills.database_id,
      data_source_id: currentLibrary.skills.data_source_id,
    },
  }
}
function catalog(records: readonly ContentRecord[]): Catalog {
  return {
    scope: "test",
    fetched_at: 0,
    databases: [
      {
        alias: "current",
        title: "Current",
        role: "content",
        database_id: currentLibrary.skills.database_id,
        data_source_ids: [currentLibrary.skills.data_source_id],
        shared_library: currentLibrary,
      },
    ],
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
      expect(String(parseRef(fileRef(record(name).id, "SKILL.md")).skillId)).toBe(page)
    }
  })

  test("rejects controls through the public display name schema", () => {
    for (const name of ["", "  ", "Tty\u00007", "React\n19", "a\u007fb", "a\u200bb", "\ud800"]) {
      expect(() => validateDisplayName(name)).toThrow()
      expect(Schema.is(DisplayNameSchema)(name)).toBe(false)
    }
  })

  test("display names and aliases cannot shadow a stable identity", () => {
    const first = record("Agent Skill"),
      second = record("Agent  Skill", other)
    const directory = catalog([first, second])
    expect(() => resolveCatalogReference("agent-skill", directory)).toThrow()
    expect(() =>
      resolveCatalogReference("skill://agent-skill?library=00000000-0000-4000-8000-000000000002", directory),
    ).toThrow()
    expect(resolveCatalogReference(first.id, directory).record.id).toBe(first.id)
    const identityShadow = record(first.id, other)
    expect(resolveCatalogReference(first.id, catalog([first, identityShadow])).record.id).toBe(
      first.id,
    )
    expect(first.locator).toEqual(record("renamed", page).locator)
  })

  test("reference paths preserve delimiters without encoding a display name as identity", () => {
    const value = record("name@scope/ref")
    const ref = fileRef(value.id, "references/中文.md")
    expect(parseTarget(ref)).toMatchObject({
      kind: "skill",
      selector: value.id,
      path: "references/中文.md",
    })
    expect(resolveCatalogReference(ref, catalog([value])).record.id).toBe(value.id)
    expect(() => fileRef(value.alias, "SKILL.md")).toThrow()
    for (const invalid of [
      "skill://name%00/SKILL.md",
      "skill://name%0A/SKILL.md",
      "skill://name%2Fscope/SKILL.md",
    ])
      expect(() => parseRef(invalid)).toThrow()
    expect(() => parseTarget("Tty\u00007")).toThrow()
  })
})
