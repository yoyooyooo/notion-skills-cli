import { expect, test } from "bun:test"
import {
  sourceConfiguration,
  sourceRich,
  validateSourceDefinition,
} from "../src/shared-source-definitions.ts"
import type { SourceDefinitionInput } from "../src/shared-sources-model.ts"

const input: SourceDefinitionInput = {
  version: 1,
  source_id: "source-definition-fixture",
  name: "Example",
  description: "Complete source",
  enabled: true,
  policy: "manual",
  adapter: { type: "git", url: "https://gitlab.com/group/project.git", ref: "main" },
  selection: { roots: ["skills"], include: [], exclude: [], mapping: {} },
  options: {},
}

test("pure provider configuration preserves complete selections and transformation options", () => {
  const complete = {
    ...input,
    options: {
      patch: {
        version: 1,
        files: [{ path: "SKILL.md", replacements: [{ from: "a".repeat(70000), to: "new" }] }],
      },
    },
  }
  expect(validateSourceDefinition(complete)).toEqual(complete)
  expect(
    sourceConfiguration({
      ...complete,
      page_id: "observed-page",
      fingerprint: "current-hash",
      status: "ready",
      last_revision: "commit",
      last_checked: 0,
      last_result: "current",
    }),
  ).toEqual(complete)
  expect(validateSourceDefinition(input).adapter).toEqual(input.adapter)
})

test("source configuration refuses secrets, unsafe selections, local paths and floating pinned refs", () => {
  for (const value of [
    { ...input, options: { token: "secret" } },
    { ...input, options: { nested: [{ authorization: "secret" }] } },
    { ...input, adapter: { ...input.adapter, url: "file:///private/data" } },
    { ...input, policy: "pinned" },
    { ...input, selection: { ...input.selection, roots: ["../outside"] } },
    { ...input, adapter: { type: "git", url: "https://token@example.test/repo", ref: "main" } },
    { ...input, unknown_execution: true },
  ])
    expect(() => validateSourceDefinition(value)).toThrow()
})

test("bounded native rich text preserves Unicode and rejects properties beyond Notion capacity", () => {
  const text = "中文😀".repeat(6000)
  const parts = sourceRich(text)
  expect(parts.map((part) => part.text.content).join("")).toBe(text)
  expect(parts.every((part) => part.text.content.length <= 1900)).toBe(true)
  expect(() => sourceRich("a".repeat(190001))).toThrow()
})
