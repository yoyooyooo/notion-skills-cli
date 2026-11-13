import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SkillsError } from "../src/model.ts"
import { classifyMaintenanceChanges } from "../src/shared-skill-apply-tree.ts"
import { rewriteSharedMarkdownReferenceSpans } from "../src/shared-file-references.ts"

const encode = (value: string) => new TextEncoder().encode(value)

function rejected(action: () => void): SkillsError {
  try {
    action()
    throw new Error("Expected a typed failure")
  } catch (error) {
    if (error instanceof SkillsError) return error
    throw error
  }
}

describe("maintenance tree classification", () => {
  const active = [
    { path: "SKILL.md", bytes: encode("# Main\n"), mode: "100644" as const },
    { path: "references/1.md", bytes: encode("one\n") },
  ]

  test("omitted files stay and a new file is not a move", () => {
    const result = classifyMaintenanceChanges({
      entrypoint: "SKILL.md",
      active,
      tombstones: [],
      requested: [{ path: "references/2.md", bytes: encode("one\n") }],
      explicitRemoves: [],
      changes: null,
    })
    expect(result.adds.map((file) => file.path)).toEqual(["references/2.md"])
    expect(result.moves).toEqual([])
    expect(result.removes).toEqual([])
    expect(result.finalFiles.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/1.md",
      "references/2.md",
    ])
    expect(result.finalFiles[0]?.mode).toBe("100644")
  })

  test("unicode case identities fail before a final tree is accepted", () => {
    const error = rejected(() =>
      classifyMaintenanceChanges({
        entrypoint: "SKILL.md",
        active,
        tombstones: [],
        requested: [
          { path: "references/A.md", bytes: encode("A\n") },
          { path: "references/a.md", bytes: encode("a\n") },
        ],
        explicitRemoves: [],
        changes: null,
      }),
    )
    expect(error.code).toBe("SHARED_APPLY_PATH_IDENTITY")
  })

  test("an explicit move keeps bytes and a fenced span is not rewritten", () => {
    const moved = classifyMaintenanceChanges({
      entrypoint: "SKILL.md",
      active,
      tombstones: [{ path: "references/old.md", bytes: encode("old\n") }],
      requested: [],
      explicitRemoves: [],
      changes: { version: 1, moves: [{ from: "references/1.md", to: "notes/1.md" }] },
    })
    expect(moved.moves).toEqual([
      { from: "references/1.md", to: "notes/1.md", bytes: encode("one\n") },
    ])
    expect(moved.finalFiles.map((file) => file.path)).toEqual(["SKILL.md", "notes/1.md"])
    const fenced = "# Main\n\n```\n[Example](references/1.md)\n```\n"
    const start = fenced.indexOf("references/1.md")
    const error = rejected(() =>
      rewriteSharedMarkdownReferenceSpans("SKILL.md", fenced, [
        {
          start,
          end: start + "references/1.md".length,
          from: "references/1.md",
          to: "notes/1.md",
        },
      ]),
    )
    expect(error.code).toBe("SHARED_APPLY_REWRITE_SPAN")
    expect(Effect.runSync(Effect.succeed(fenced))).toContain("references/1.md")
  })
})
