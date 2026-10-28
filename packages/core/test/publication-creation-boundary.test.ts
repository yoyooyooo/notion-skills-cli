import { expect, test } from "bun:test"
import { publicationMarkdownMatches as compareCreationBoundary } from "../src/publication-observation.ts"
import { creationMarker, type CreationProof } from "../src/publication-create-identity.ts"
import { projectNotionBlocks } from "../src/markdown.ts"
import type { Receipt } from "../src/publication-model.ts"

const page = "11111111-1111-4111-8111-111111111111"
const proof: CreationProof = {
  version: 1,
  operation_token: "22222222-2222-4222-8222-222222222222",
  operation_id: "p_boundary",
  intent_index: 1,
  scope: "fixture-scope",
  database_id: "33333333-3333-4333-8333-333333333333",
  data_source_id: "44444444-4444-4444-8444-444444444444",
  role: "reference",
  path: "references/guide.md",
  parent_type: "page_id",
  parent_id: page,
  intended_hash: "a".repeat(64),
  source_sha256: "b".repeat(64),
}
const marker = creationMarker(proof)
const escapedMarker = marker.replaceAll("-", "\\-")
const rawBody =
  "---\nRead [EXAMPLE.md](http://EXAMPLE.md).\nA short status.\n---\n## Next\nReady.\n\n```text\nexact code\n```\n\n[site](https://example.test/exact)"
const targetBody =
  "---\n\nRead EXAMPLE.md.\n\nA short status.\n\n---\n\n## Next\n\nReady.\n\n```text\nexact code\n```\n\n[site](https://example.test/exact)"
const actual = escapedMarker + "\n" + rawBody
const target = marker + "\n\n" + targetBody
const block = (id: string, type: string, content = "") => ({
  id,
  type,
  has_children: false,
  parent: { type: "page_id", page_id: page },
  [type]: { rich_text: [{ type: "text", text: { content } }] },
})
const roots = [
  block("marker", "paragraph", marker),
  block("first-rule", "divider"),
  block("intro", "paragraph"),
  block("status", "paragraph", "A short status."),
  block("rule", "divider"),
  block("next", "heading_2"),
  block("ready", "paragraph", "Ready."),
  block("code", "code"),
  block("site", "paragraph"),
]
const boundaries = projectNotionBlocks(roots)!
const intent: Receipt["intents"][number] = {
  method: "PATCH",
  path: `v1/pages/${page}/markdown`,
  status: "completed",
  body: { type: "replace_content", replace_content: { new_str: target } },
}

test("the same reserved identity paragraph can precede a separate root divider", () => {
  const retained = structuredClone({ intent, boundaries })
  expect(compareCreationBoundary(intent, actual, target, boundaries)).toBe(true)
  expect({ intent, boundaries }).toEqual(retained)
})

for (const [name, candidate, wanted, evidence] of [
  ["missing actual marker", rawBody, target, boundaries],
  ["missing target marker", actual, targetBody, boundaries],
  [
    "a different creation identity",
    actual.replace(escapedMarker, creationMarker({ ...proof, operation_id: "p_other" })),
    target,
    boundaries,
  ],
  ["missing marker block", actual, target, boundaries.slice(1)],
  [
    "different marker block",
    actual,
    target,
    projectNotionBlocks([
      block("marker", "paragraph", creationMarker({ ...proof, source_sha256: "c".repeat(64) })),
      ...roots.slice(1),
    ])!,
  ],
  [
    "a marker with children",
    actual,
    target,
    [{ ...boundaries[0]!, has_children: true }, ...boundaries.slice(1)],
  ],
  ["changed prose", actual.replace("Ready.", "Changed."), target, boundaries],
  ["changed code", actual.replace("exact code", "changed code"), target, boundaries],
  [
    "changed external scheme",
    actual.replace("https://example.test/exact", "http://example.test/exact"),
    target,
    boundaries,
  ],
  ["missing divider", actual.replace("\n---\n## Next", "\n## Next"), target, boundaries],
] as const) {
  test("the transport boundary rejects " + name, () => {
    expect(compareCreationBoundary(intent, candidate, wanted, evidence)).toBe(false)
  })
}

test("invalid reserved identity stays an error", () => {
  expect(() =>
    compareCreationBoundary(intent, "ntn-skills-create:v1:invalid\n" + rawBody, target, boundaries),
  ).toThrow()
})

test("a reserved-looking code literal is never removed", () => {
  const literal = "```text\n" + marker + "\n```"
  expect(compareCreationBoundary(intent, literal, literal)).toBe(true)
  expect(
    compareCreationBoundary(intent, literal.replace("ntn-skills", "other-skills"), literal),
  ).toBe(false)
})
