import { expect, test } from "bun:test"
import { sourceRich, validateSourceDefinition } from "../src/shared-source-definitions.ts"
import {
  sourceDefinitionProperties,
  type SourceDefinitionInput,
} from "../src/shared-sources-model.ts"

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

test("Source policy and declaration reject scheduling and unused storage choices", () => {
  expect(sourceDefinitionProperties.Policy.select.options.map((option) => option.name)).toEqual([
    "manual",
    "pinned",
  ])
  expect(Object.keys(sourceDefinitionProperties)).not.toContain("Last Checked")
  expect(Object.keys(sourceDefinitionProperties)).not.toContain("Last Result")
  expect(sourceDefinitionProperties.Status.select.options.map((option) => option.name)).toEqual([
    "ready",
    "applying",
    "attention",
  ])
  expect(sourceDefinitionProperties["Last Revision"]).toEqual({ rich_text: {} })
  expect(sourceDefinitionProperties.Operation).toEqual({ rich_text: {} })
  expect(() => validateSourceDefinition({ ...input, policy: "auto" })).toThrow()
  expect(() =>
    validateSourceDefinition({ ...input, policy: "auto", options: { check_interval_ms: 60_000 } }),
  ).toThrow()
  for (const options of [
    { check_interval_ms: 60_000 },
    { storage: "auto" },
    { storage: "fixed-git" },
    { storage: "retained" },
  ])
    expect(() => validateSourceDefinition({ ...input, options })).toThrow(
      "no implemented adapter behavior",
    )
  expect(
    validateSourceDefinition({
      ...input,
      options: { accepted_ref: "a".repeat(40), require_all_included: true },
    }).options,
  ).toEqual({ accepted_ref: "a".repeat(40), require_all_included: true })
})
