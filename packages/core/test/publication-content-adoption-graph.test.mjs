import { strict as assert } from "node:assert"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { priorHeadingContentAdoptionGraph as priorGraph } from "../src/publication-content-adoption-graph.ts"

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const span = (text) => ({ text, link: null, bold: false, code: false })
const heading = (id, type = "heading_2") => ({
  id,
  type,
  has_children: false,
  text: "Retained heading",
  rich_text: [span("Retained heading")],
})
const paragraph = (id) => ({
  id,
  type: "paragraph",
  has_children: false,
  text: "Exact body",
  rich_text: [span("Exact body")],
})
const page = (blocks) => ({
  id: "page",
  path: "SKILL.md",
  markdown: "# Retained heading\n\nExact body\n",
  blocks,
})
const original = () => [page([{ id: "h", type: "heading_2", has_children: false }, paragraph("p")])]
const current = () => [page([heading("h"), paragraph("p")])]

test("the prior complete graph removes only supported root heading fields without mutating inputs", () => {
  const value = current(),
    before = structuredClone(value)
  assert.deepEqual(priorGraph(value), original())
  assert.equal(hash(priorGraph(value)), hash(original()))
  assert.deepEqual(value, before)
  for (const kind of ["heading_1", "heading_2", "heading_3"]) {
    const output = priorGraph([page([heading("h", kind)])])
    assert.deepEqual(output[0].blocks, [{ id: "h", type: kind, has_children: false }])
  }
})

test("plain-only and linked rich-only heading projections reconstruct their historical sentinels", () => {
  const plain = heading("h"),
    linked = heading("link")
  delete plain.rich_text
  delete linked.text
  linked.rich_text[0].link = "https://example.test/original?q=1#anchor"
  assert.deepEqual(priorGraph([page([plain, linked])])[0].blocks, [
    { id: "h", type: "heading_2", has_children: false },
    { id: "link", type: "heading_2", has_children: false },
  ])
})

test("a graph with no newer heading fields is not a compatibility candidate", () => {
  assert.equal(priorGraph(original()), undefined)
  assert.equal(priorGraph([page([paragraph("p")])]), undefined)
})

test("unrelated old text, URL, code and numbered starts remain in the digest preimage", () => {
  const originalHash = hash(original())
  for (const change of [
    (value) => {
      value[0].blocks[1].text += " changed"
    },
    (value) => {
      value[0].blocks[1].rich_text[0].link = "https://example.test/changed"
    },
    (value) => {
      value[0].blocks[1].code = { text: "x  y", language: "text" }
    },
    (value) => {
      value[0].blocks[1].numbered_list = { start: 3 }
    },
  ]) {
    const value = current()
    change(value)
    assert.notEqual(hash(priorGraph(value)), originalHash)
  }
})

test("page identity, path, Markdown and physical root order can never use heading compatibility", () => {
  const originalHash = hash(original())
  for (const change of [
    (value) => {
      value[0].id = "another-page"
    },
    (value) => {
      value[0].path = "another.md"
    },
    (value) => {
      value[0].markdown += "External instruction.\n"
    },
    (value) => {
      value[0].blocks.reverse()
    },
    (value) => {
      value[0].blocks[0].id = "another-heading"
    },
    (value) => {
      value[0].blocks[0].has_children = true
    },
    (value) => {
      value[0].blocks[0].type = "heading_1"
    },
  ]) {
    const value = current()
    change(value)
    assert.notEqual(hash(priorGraph(value)), originalHash)
  }
})

test("descendants, empty-quote fields and unknown future block fields are retained", () => {
  const value = current()
  value[0].blocks[0].future = { exact: true }
  value[0].blocks.push({ id: "q", type: "quote", has_children: false, text: "", rich_text: [] })
  value[0].blocks.push({
    id: "list",
    type: "bulleted_list_item",
    has_children: true,
    descendants: [{ ...paragraph("child"), parent_id: "list" }],
  })
  const output = priorGraph(value)
  assert.deepEqual(output[0].blocks[0].future, { exact: true })
  assert.deepEqual(output[0].blocks.slice(2), value[0].blocks.slice(2))
  assert.notEqual(hash(output), hash(original()))
})

test("contradictory heading fields, unknown span fields and unsupported values refuse reconstruction", () => {
  for (const change of [
    (value) => {
      value[0].blocks[0].text = "Different heading"
    },
    (value) => {
      value[0].blocks[0].rich_text = []
    },
    (value) => {
      value[0].blocks[0].rich_text[0].extra = true
    },
    (value) => {
      value[0].blocks[0].rich_text[0].link = "https://example.test/link"
    },
    (value) => {
      value[0].blocks[0].rich_text[0].bold = undefined
    },
    (value) => {
      value[0].blocks[0].text = undefined
    },
  ]) {
    const value = current()
    change(value)
    assert.equal(priorGraph(value), undefined)
  }
})

test("missing evidence and repeated pages, paths or roots remain invalid", () => {
  const value = current()
  for (const pages of [
    [{ ...value[0], blocks: undefined }],
    [value[0], value[0]],
    [value[0], { ...value[0], id: "second-page" }],
    [{ ...value[0], blocks: [heading("h"), heading("h")] }],
  ])
    assert.equal(priorGraph(pages), undefined)
})
