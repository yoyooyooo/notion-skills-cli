import { expect, test } from "vitest"
import { sourceExternalResourceTargets } from "../src/upstream-member-links.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"

const bytes = (value: string) => new TextEncoder().encode(value)
const member = (markdown: string): SourceSnapshot["members"][number] => ({
  member_key: "skills/one",
  source_path: "skills/one",
  upstream_hash: "captured",
  content_hash: "captured",
  portable: {
    kind: "skill",
    name: "one",
    description: "Current provider input",
    main: "SKILL.md",
    files: [{ path: "SKILL.md", bytes: bytes(markdown) }],
  },
})
test("current Git prerequisites select only authored hrefs backed by ordinary exact blobs", () => {
  const markdown =
    "[shared](../../assets/shared.bin#part)\n\n[link](../../assets/shortcut)\n\n`[example](../../assets/code.bin)`\n\n[external](https://example.test/file)"
  const selected = member(markdown)
  const before = structuredClone(selected)
  expect(
    sourceExternalResourceTargets(
      [selected],
      [
        { path: "assets/shared.bin", oid: "a".repeat(40), type: "blob", mode: "100644" },
        { path: "assets/shortcut", oid: "b".repeat(40), type: "blob", mode: "120000" },
        { path: "assets/code.bin", oid: "c".repeat(40), type: "blob", mode: "100644" },
      ],
    ),
  ).toEqual([{ source_path: "assets/shared.bin", git_oid: "a".repeat(40) }])
  expect(selected).toEqual(before)
})
test("an authored outside-root href remains an unavailable prerequisite without altering source bytes", () => {
  const selected = member("[outside](../../../secret)"),
    unavailable: unknown[] = []
  expect(sourceExternalResourceTargets([selected], [], (entry) => unavailable.push(entry))).toEqual(
    [],
  )
  expect(unavailable).toEqual([
    { reason: "outside_source_root", from_path: "skills/one/SKILL.md", href: "../../../secret" },
  ])
  expect(new TextDecoder().decode(selected.portable.files[0]!.bytes)).toBe(
    "[outside](../../../secret)",
  )
})
