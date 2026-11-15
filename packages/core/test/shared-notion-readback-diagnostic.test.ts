import { expect, test } from "bun:test"
import { describeNotionReadbackMismatch } from "../src/shared-notion-readback-diagnostic.ts"
import {
  projectSharedNotionMarkdown,
  validateSharedNotionMarkdownProjection,
} from "../src/shared-notion-projection.ts"
import { restoreSharedNativeFileLinks } from "../src/shared-native-file-content.ts"

test("bounded byte diagnostics preserve exact code, whitespace and Unicode differences", () => {
  const prefix = "标题\n" + "a".repeat(200)
  const result = describeNotionReadbackMismatch({
    expected: prefix + "x".repeat(1000),
    observed: prefix + "y".repeat(1000),
    projectionVersion: 13,
  })
  expect(result.first_difference?.byte_offset).toBe(Buffer.byteLength(prefix))
  expect(result.first_difference?.expected_hex.length).toBeLessThanOrEqual(96)
  expect(result.first_difference?.observed_hex.length).toBeLessThanOrEqual(96)
  expect(result.projection_version).toBe(13)
  expect(result.automatic_retry).toBe(false)
  expect(
    describeNotionReadbackMismatch({ expected: "abc", observed: "abc" }).first_difference,
  ).toBeNull()
  expect(
    describeNotionReadbackMismatch({ expected: "abc", observed: "ab" }).first_difference
      ?.byte_offset,
  ).toBe(2)
})

test("an independent EMPTY native-table sample accepts only the recorded localhost presentation", () => {
  // Minimized from AH-1045 source-B-original-restore-plan and independent native
  // source-B-restored-page-observation. Expected is literal, not writer output.
  const input =
    "| Client | Address |\n| --- | --- |\n| **Grok Bot** | Do not use localhost or `127.0.0.1`. |"
  const observed =
    "| Client | Address |\n| --- | --- |\n| <b>Grok Bot</b> | Do not use [localhost](http://localhost) or <code>127.0.0.1</code>. |"
  const current = projectSharedNotionMarkdown(input, { purpose: "body_write" })
  expect(current.markdown).toBe(observed)
  for (const changed of [
    observed.replace("127.0.0.1", "127.0.0.2"),
    observed.replace("http://localhost", "https://foreign.invalid"),
    observed.replace("Do not use", "Use"),
  ])
    expect(
      describeNotionReadbackMismatch({ expected: current.markdown, observed: changed })
        .first_difference,
    ).not.toBeNull()
  const old = projectSharedNotionMarkdown(input, { version: 13, purpose: "body_write" })
  expect(old.markdown).not.toBe(observed)
  expect(validateSharedNotionMarkdownProjection(old)).toEqual(old)
  expect(() => validateSharedNotionMarkdownProjection({ ...old, version: 15 })).toThrow()
})

test("moved native pages bind only their exact path; code, foreign links and missing bindings remain literal", () => {
  const page = "11111111-1111-4111-8111-111111111111"
  const foreign = "https://app.notion.com/p/22222222222242228222222222222222"
  const input =
    "[selected](moved/alpha.md) [foreign](" + foreign + ")\n\n`[literal](moved/alpha.md)`"
  expect(
    restoreSharedNativeFileLinks(input, "SKILL.md", [{ path: "moved/alpha.md", page_id: page }]),
  ).toBe(
    "[selected](https://app.notion.com/p/11111111111141118111111111111111) [foreign](" +
      foreign +
      ")\n\n`[literal](moved/alpha.md)`",
  )
  expect(restoreSharedNativeFileLinks(input, "SKILL.md", [])).toBe(input)
  expect(() =>
    restoreSharedNativeFileLinks(input, "SKILL.md", [
      { path: "moved/alpha.md", page_id: page },
      { path: "moved/alpha.md", page_id: "33333333-3333-4333-8333-333333333333" },
    ]),
  ).toThrow()
})
