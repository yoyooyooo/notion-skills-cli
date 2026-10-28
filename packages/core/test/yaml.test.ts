import { expect, test } from "bun:test"
import { importDocument } from "../src/import.ts"
import { skillDocument } from "../src/mutation.ts"
import { canonicalMain, portableFiles, readPortable } from "../src/portable.ts"
import { parseYaml } from "../src/yaml.ts"

const frontmatter = `name: flow-example
description: "Use to inspect a configured server."
metadata:
  {
    "agent":
      {
        "emoji": "📦",
        "requires": { "bins": ["example"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "example",
              "bins": ["example"],
            },
          ],
      },
  }`
const body = "# Example\n\nUse the configured server.\n"
const bytes = new TextEncoder().encode(`---\n${frontmatter}\n---\n\n${body}`)
const file = { path: "SKILL.md", bytes }

test("imports and replacement accept multiline flow frontmatter without changing source bytes", () => {
  const expected = {
    name: "flow-example",
    description: "Use to inspect a configured server.",
    body,
  }
  expect(importDocument(file)).toEqual(expected)
  expect(skillDocument(bytes)).toMatchObject(expected)
  const restored = readPortable(
    portableFiles({ kind: "skill", ...expected, main: "SKILL.md", files: [file] }),
  )
  expect(restored?.files).toEqual([file])
})

test("canonical metadata edits retain nested flow metadata", () => {
  const next = canonicalMain("new-name", "New description", body, file)
  const metadata = new TextDecoder().decode(next.bytes).split("---\n")[1]
  expect(metadata).toBeDefined()
  expect(parseYaml(metadata ?? "")).toMatchObject({
    name: "new-name",
    description: "New description",
    metadata: {
      agent: {
        emoji: "📦",
        requires: { bins: ["example"] },
        install: [{ id: "node", kind: "node", package: "example", bins: ["example"] }],
      },
    },
  })
})

test("YAML 1.2 scalars and ordinary aliases retain their values", () => {
  expect(parseYaml("name: on\nmetadata: &shared { enabled: true }\ncopy: *shared\n")).toEqual({
    name: "on",
    metadata: { enabled: true },
    copy: { enabled: true },
  })
})

test("invalid mappings, multiple documents, and unresolved tags remain rejected", () => {
  for (const source of [
    "name: first\nname: second\n",
    "metadata: {\n  value: [unfinished\n}",
    "name: first\n---\nname: second\n",
    "metadata: !unrecognized value\n",
  ])
    expect(() => parseYaml(source)).toThrow()
})

test("recursive aliases and excessive alias expansion remain rejected", () => {
  expect(() => parseYaml("metadata: &loop [*loop]\n")).toThrow("Recursive YAML aliases")
  const source =
    "a: &a [x,x,x,x,x,x,x,x,x,x]\n" +
    "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\n" +
    "c: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\n"
  expect(() => parseYaml(source)).toThrow()
})
