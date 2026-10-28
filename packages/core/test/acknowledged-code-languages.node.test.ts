import assert from "node:assert/strict"
import { test } from "vitest"
import { acknowledgedCodeLanguages } from "../src/acknowledged-code-languages.ts"

const page = "11111111-1111-4111-8111-111111111111"
const block = (id: string, text: string, language = "javascript") => ({
  id,
  type: "code",
  parent: { type: "page_id", page_id: page },
  has_children: false,
  last_edited_time: "original",
  archived: false,
  in_trash: false,
  code: {
    language,
    rich_text: [{ type: "text", text: { content: text, link: null }, plain_text: text }],
  },
})
const target =
  "# Original\n\n```text\n  exact first\n```\n\n```yaml\nkey: value\n```\n\n```\nlast exact\n```\n"
const roots = [
  block("first", "  exact first"),
  block("middle", "key: value", "yaml"),
  block("last", "last exact"),
]

test("original acknowledged and frozen code bytes derive only unfinished plain-text fields", () => {
  const before = JSON.stringify(roots)
  const plan = acknowledgedCodeLanguages(page, target, target, roots)
  assert.ok(plan)
  assert.deepEqual(
    plan.changes.map((item) => [item.block_id, item.code_index, item.before, item.language]),
    [
      ["first", 0, "javascript", "plain text"],
      ["last", 2, "javascript", "plain text"],
    ],
  )
  assert.equal(plan.codes.length, 3)
  assert.equal(JSON.stringify(roots), before)
  const applied = roots.map((root) => ({
    ...root,
    code: {
      ...root.code,
      language: root.code.language === "javascript" ? "plain text" : root.code.language,
    },
  }))
  assert.deepEqual(acknowledgedCodeLanguages(page, target, target, applied)?.changes, [])
})

test("code bytes, source language and source order are exact", () => {
  for (const source of [
    target.replace("  exact first", " exact first"),
    target.replace("text\n", "python\n"),
    target.replace("last exact", "different"),
    target.replace("  exact first", "last exact"),
  ])
    assert.equal(acknowledgedCodeLanguages(page, target, source, roots), undefined)
  assert.equal(
    acknowledgedCodeLanguages(page, target, target, [roots[2]!, roots[1]!, roots[0]!]),
    undefined,
  )
  assert.equal(
    acknowledgedCodeLanguages(
      page,
      target,
      target,
      roots.map((root, index) => (index ? root : block(root.id, " exact first"))),
    ),
    undefined,
  )
})

test("foreign, duplicate, nested, archived and incomplete roots provide no field candidate", () => {
  const mutations: ((root: (typeof roots)[number]) => unknown)[] = [
    (root) => ({ ...root, parent: { type: "page_id", page_id: "foreign" } }),
    (root) => ({ ...root, has_children: true }),
    (root) => ({ ...root, archived: true }),
    (root) => ({ ...root, in_trash: true }),
    (root) => ({ ...root, last_edited_time: undefined }),
    (root) => ({ ...root, code: { ...root.code, rich_text: undefined } }),
    (root) => ({
      ...root,
      code: { ...root.code, rich_text: [{ type: "mention", plain_text: "  exact first" }] },
    }),
  ]
  for (const mutate of mutations)
    assert.equal(
      acknowledgedCodeLanguages(page, target, target, [mutate(roots[0]!), ...roots.slice(1)]),
      undefined,
    )
  assert.equal(acknowledgedCodeLanguages(page, target, target, [...roots, roots[0]!]), undefined)
  assert.equal(acknowledgedCodeLanguages(page, target, target, roots.slice(1)), undefined)
})

test("unsupported language changes, ambiguous code bodies and nested source codes refuse", () => {
  assert.equal(
    acknowledgedCodeLanguages(
      page,
      target,
      target,
      roots.map((root, index) => (index ? root : block(root.id, "  exact first", "python"))),
    ),
    undefined,
  )
  const duplicate = "```text\nsame\n```\n\n```text\nsame\n```\n"
  assert.equal(
    acknowledgedCodeLanguages(page, duplicate, duplicate, [block("a", "same"), block("b", "same")]),
    undefined,
  )
  const nested = "> ```text\n> nested\n> ```\n"
  assert.equal(
    acknowledgedCodeLanguages(page, nested, nested, [block("nested", "nested")]),
    undefined,
  )
})

test("a language candidate is not a whole-body or URL equivalence proof", () => {
  // The runtime must separately reject these bodies before it consumes a field.
  const altered = target.replace("Original", "Foreign prose")
  assert.equal(acknowledgedCodeLanguages(page, altered, target, roots)?.changes.length, 2)
  const linked = target + "\n[site](https://example.test/right)\n"
  assert.equal(
    acknowledgedCodeLanguages(page, linked.replace("/right", "/wrong"), linked, roots)?.changes
      .length,
    2,
  )
})
