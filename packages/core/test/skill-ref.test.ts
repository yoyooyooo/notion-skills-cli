import { describe, expect, test } from "bun:test"
import {
  SKILL_REF_VERSION,
  bindSkillRef,
  createSkillKey,
  formatSkillIdentity,
  formatSkillRef,
  normalizeSkillPath,
  parseSkillIdentity,
  parseSkillRef,
  referenceSelection,
  sameSkillKey,
} from "../src/skill-ref.ts"
import { identityFromSegment, identitySegment } from "../src/cache-address.ts"
import { bindTarget, fileRef, parseTarget, resolveRef } from "../src/ref.ts"

const snapshot = `s_${"a".repeat(64)}`
const production = createSkillKey({ libraryId: "library-production", skillId: "architect" })
const testing = createSkillKey({ libraryId: "library-testing", skillId: "architect" })

describe("one Skill reference protocol", () => {
  test("short author refs need a containing scope; duplicate names cannot choose one", () => {
    const author = parseSkillRef("skill://architect")
    expect(SKILL_REF_VERSION).toBe(2)
    expect(() => bindSkillRef(author)).toThrow("containing Library")
    expect(bindSkillRef(author, production.libraryId).owner).toEqual(production)
    expect(bindSkillRef(author, testing.libraryId).owner).toEqual(testing)
    expect(sameSkillKey(production, testing)).toBe(false)
    expect(formatSkillIdentity(production)).toBe("skill://architect?library=library-production")
  })

  test("an explicit Library remains explicit when the ambient default changes", () => {
    const explicit = parseSkillRef(formatSkillIdentity(production))
    expect(bindSkillRef(explicit, testing.libraryId).owner).toEqual(production)
    expect(bindTarget(parseTarget("architect"), production.libraryId).selector).toBe(
      formatSkillIdentity(production),
    )
    expect(() => fileRef("architect", "SKILL.md")).toThrow()
    expect(() => fileRef("shared_skill:library-production:architect", "SKILL.md")).toThrow()
  })

  test("root selection and exact file selection remain distinct", () => {
    expect(
      parseSkillRef(`skill://architect?library=library-production&snapshot=${snapshot}`).path,
    ).toBe("")
    const fixed = fileRef(formatSkillIdentity(production), "references/a b.md", snapshot)
    expect(fixed).toBe(
      `skill://architect/references/a%20b.md?library=library-production&snapshot=${snapshot}`,
    )
    expect(parseSkillRef(fixed).selection).toEqual(referenceSelection(snapshot))
    expect(() => parseSkillIdentity(fixed)).toThrow()
    expect(() => parseSkillIdentity("skill://architect")).toThrow()
    expect(() => parseSkillIdentity("skill://%61rchitect?library=library-production")).toThrow()
  })

  test("protocol and storage codecs preserve the complete identity across libraries", () => {
    for (const libraryId of ["prod", "test", "library:fixture", "Library_A.2"]) {
      for (const skillId of ["architect", "poteto-mode", "a.b_c-1", "1"]) {
        const owner = createSkillKey({ libraryId, skillId })
        const id = formatSkillIdentity(owner)
        expect(parseSkillIdentity(id)).toEqual(owner)
        const segment = identitySegment(id)
        expect(segment.includes("/")).toBe(false)
        expect(identityFromSegment(segment)).toBe(id)
        for (const path of ["", "SKILL.md", "references/设计 #1?.md", "resources/100%.txt"]) {
          for (const selection of [referenceSelection(), referenceSelection(snapshot)]) {
            const formatted = formatSkillRef({ owner, path, selection })
            expect(bindSkillRef(parseSkillRef(formatted))).toEqual({ owner, path, selection })
            expect(formatSkillRef(bindSkillRef(parseSkillRef(formatted)))).toBe(formatted)
          }
        }
      }
    }
    expect(identitySegment(formatSkillIdentity(production))).not.toBe(
      identitySegment(formatSkillIdentity(testing)),
    )
    expect(() => identityFromSegment(formatSkillIdentity(production))).toThrow()
    expect(() => identityFromSegment("%zz")).toThrow()
  })

  test("relative paths preserve a fixed owner and cannot escape using URL normalization", () => {
    const from = fileRef(formatSkillIdentity(production), "references/guide.md", snapshot)
    expect(resolveRef(from, "../scripts/run.ts")).toBe(
      fileRef(formatSkillIdentity(production), "scripts/run.ts", snapshot),
    )
    expect(() => resolveRef(from, "../../other/SKILL.md")).toThrow("escapes")
    expect(normalizeSkillPath("../a.md", "references/guide.md")).toBe("a.md")
    for (const bad of [
      "/SKILL.md",
      "C:/SKILL.md",
      "references\\a.md",
      "../a.md",
      "a/../../b.md",
      "a\u0000b",
    ]) {
      expect(() => normalizeSkillPath(bad)).toThrow()
    }
  })

  test("a new target never inherits a different owner's snapshot syntactically", () => {
    const from = fileRef(formatSkillIdentity(production), "SKILL.md", snapshot)
    expect(resolveRef(from, "skill://unslop")).toBe("skill://unslop?library=library-production")
    expect(resolveRef(from, "skill://architect?library=library-testing")).toBe(
      formatSkillIdentity(testing),
    )
  })

  test("retired selectors and ambiguous URI encodings fail before lookup", () => {
    for (const bad of [
      "skill://Architect",
      "skill://Sample%20Skill",
      "skill://shared_skill%3Alib%3Aarchitect/SKILL.md",
      "skill://architect?file_id=main",
      "skill://architect?snapshot=latest",
      "skill://architect?library=",
      "skill://architect?library=a&library=b",
      "skill://architect?library=a&%6cibrary=a",
      "skill://architect?library=a&",
      "skill://architect?",
      "skill://architect#guide",
      "skill://architect/%2e%2e/a.md",
      "skill://architect/references%2fa.md",
      "skill://architect/%5ca.md",
      "skill://architect/%ZZ",
      "skill://architect?other=1",
      "skill://architect@host/SKILL.md",
    ])
      expect(() => parseSkillRef(bad)).toThrow()
    for (const bad of ["shared_skill:lib:architect", "upstream:architect", "notion_page:abc"]) {
      expect(() => parseTarget(bad)).toThrow()
    }
    const uuid = "11111111-1111-4111-8111-111111111111"
    expect(parseTarget(uuid).kind).toBe("page")
    expect(parseTarget(`skill://${uuid}?library=prod`).kind).toBe("skill")
  })
})
