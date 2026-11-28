import { expect, test } from "bun:test"
import { parseSkillRef } from "../src/skill-ref.ts"
import { decodeNativeSkillLink, encodeNativeSkillLink } from "../src/shared-native-skill-link.ts"

const library = "45c64249-e1dd-59ab-ad9f-604ff752ddb4"
const snapshot = "s_" + "a".repeat(64)

test.each([
  ["skill://router", "skill://router/entrypoint.md/.."],
  [`skill://router?library=${library}`, `skill://router/entrypoint.md/..?library=${library}`],
  [
    `skill://prompt?library=${library}&snapshot=${snapshot}`,
    `skill://prompt/entrypoint.md/..?library=${library}&snapshot=${snapshot}`,
  ],
  [
    `skill://router/references/config?library=${library}`,
    `skill://router/entrypoint.md/../references/config?library=${library}`,
  ],
  ["skill://router/entrypoint.md", "skill://router/entrypoint.md/../entrypoint.md"],
  [
    "skill://router/references/a%20b.md?library=" + library,
    "skill://router/entrypoint.md/../references/a%20b.md?library=" + library,
  ],
  [
    `skill://%72outer/./?snapshot=${snapshot}&library=${library}`,
    `skill://%72outer/entrypoint.md/.././?snapshot=${snapshot}&library=${library}`,
  ],
  [
    "skill://router/entrypoint.md/../entrypoint.md/..",
    "skill://router/entrypoint.md/../entrypoint.md/../entrypoint.md/..",
  ],
])(
  "native wire spelling preserves the complete reference and original spelling: %s",
  (input, wire) => {
    expect(encodeNativeSkillLink(input)).toBe(wire)
    expect(decodeNativeSkillLink(wire)).toBe(input)
    expect(parseSkillRef(wire)).toEqual(parseSkillRef(input))
  },
)

test.each([
  "skill://router/entrypoint.md",
  "skill://router/entrypoint.md/..notes",
  "skill://router/%65ntrypoint.md/..",
  "skill://router/entrypoint.md/%2E%2E",
  "skill://router/entrypoint.md/..//notes",
  "skill://router/entrypoint.md/../../outside",
  "skill://Router/entrypoint.md/..",
  "skill://router/entrypoint.md/..?library=wrong",
  "skill://router/entrypoint.md/..?snapshot=s_bad",
  "skill://router/entrypoint.md/..?unknown=value",
  "https://example.com/entrypoint.md/..",
])("native decoding cannot erase an unrelated or invalid destination: %s", (input) => {
  expect(decodeNativeSkillLink(input)).toBe(input)
})

test.each([
  "skill://Router",
  "skill://router/../outside",
  "skill://router/%2Foutside",
  "skill://router?library=wrong",
  "skill://router?snapshot=s_bad",
  "skill://router?library=" + library + "&library=" + library,
  "https://example.com",
  "../relative.md",
])("native encoding leaves unsupported URLs unchanged: %s", (input) => {
  expect(encodeNativeSkillLink(input)).toBe(input)
})
