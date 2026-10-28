import assert from "node:assert/strict"
import { test } from "vitest"
import { legacyReferencesLimitPrefix } from "../src/reference-links-history.ts"
import { referenceLinks } from "../src/reference-links.ts"

const root = "11111111-1111-4111-8111-111111111111"
const source = "22222222-2222-4222-8222-222222222222"
const fieldId = "references-id"
const pages = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: `references/guide-${String(index).padStart(3, "0")}.md`,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  }))
const oldValue = (input: ReturnType<typeof pages>) => ({
  rich_text: input.flatMap((page, index) => [
    ...(index ? [{ type: "text", text: { content: "\n" } }] : []),
    {
      type: "text",
      text: {
        content: page.path,
        link: { url: `https://www.notion.so/${page.id.replaceAll("-", "")}` },
      },
    },
  ]),
})
function fixture(): any {
  const children = pages(60)
  const intents: any[] = [
    {
      path: "v1/pages",
      method: "POST",
      status: "completed",
      body: { parent: { type: "data_source_id", data_source_id: source }, properties: {} },
      response: { id: root },
    },
  ]
  for (let index = 0; index < 51; index++) {
    const child = children[index]!
    intents.push({
      path: "v1/pages",
      method: "POST",
      status: "completed",
      body: {
        parent: { type: "page_id", page_id: root },
        properties: {
          title: { title: [{ text: { content: child.path.slice("references/".length) } }] },
        },
      },
      response: { id: child.id },
    })
    intents.push({
      path: `v1/pages/${root}`,
      method: "PATCH",
      status: index === 50 ? "failed" : "completed",
      body: { properties: { [fieldId]: oldValue(children.slice(0, index + 1)) } },
      ...(index === 50 ? {} : { response: { id: root } }),
    })
  }
  return {
    operation_id: "p_reference-limit-fixture",
    operation: "create",
    page_id: root,
    data_source_id: source,
    portable: {
      kind: "skill",
      main: "SKILL.md",
      files: [{ path: "SKILL.md" }, ...children.map((child) => ({ path: child.path }))],
    },
    intents,
  }
}

test("the exact first legacy overflow is independently derived from immutable original requests", () => {
  const receipt = fixture()
  const before = JSON.stringify(receipt)
  assert.equal(receipt.intents.length, 103)
  assert.equal(receipt.intents[102].body.properties[fieldId].rich_text.length, 101)
  assert.equal(legacyReferencesLimitPrefix(receipt, 102, fieldId), true)
  assert.equal(JSON.stringify(receipt), before)
  receipt.failure = {
    code: "WRITE_CONFLICT",
    message: "A later verification can change this field.",
  }
  assert.equal(legacyReferencesLimitPrefix(receipt, 102, fieldId), true)
  receipt.intents.push({
    path: `v1/pages/${root}`,
    method: "PATCH",
    status: "completed",
    body: { properties: { [fieldId]: referenceLinks(pages(60)) } },
    response: { id: root },
  })
  assert.equal(legacyReferencesLimitPrefix(receipt, 102, fieldId), true)
})

const changes: ReadonlyArray<readonly [string, (receipt: any) => void]> = [
  [
    "replace operation",
    (r) => {
      r.operation = "replace"
    },
  ],
  [
    "wrong kind",
    (r) => {
      r.portable.kind = "router"
    },
  ],
  [
    "missing root",
    (r) => {
      delete r.page_id
    },
  ],
  [
    "wrong root",
    (r) => {
      r.page_id = source
    },
  ],
  [
    "wrong data source",
    (r) => {
      r.data_source_id = root
    },
  ],
  [
    "unknown failed request",
    (r) => {
      r.intents[102].status = "unknown"
    },
  ],
  [
    "pending failed request",
    (r) => {
      r.intents[102].status = "pending"
    },
  ],
  [
    "completed failed request",
    (r) => {
      r.intents[102].status = "completed"
    },
  ],
  [
    "response disposition",
    (r) => {
      r.intents[102].response = { recovery: "known_not_applied" }
    },
  ],
  [
    "retained guards on failed request",
    (r) => {
      r.intents[102].guards = {}
    },
  ],
  [
    "recovery flag",
    (r) => {
      r.intents[102].recovery = true
    },
  ],
  [
    "extra intent field",
    (r) => {
      r.intents[102].artifact = {}
    },
  ],
  [
    "foreign failed target",
    (r) => {
      r.intents[102].path = `v1/pages/${source}`
    },
  ],
  [
    "failed additional property",
    (r) => {
      r.intents[102].body.properties.Other = { rich_text: [] }
    },
  ],
  [
    "failed top-level side effect",
    (r) => {
      r.intents[102].body.archived = true
    },
  ],
  [
    "partial References request",
    (r) => {
      r.intents[102].body.properties[fieldId].append = true
    },
  ],
  [
    "wrong field id",
    (r) => {
      r.intents[102].body.properties = { other: r.intents[102].body.properties[fieldId] }
    },
  ],
  [
    "compact request",
    (r) => {
      r.intents[102].body.properties[fieldId] = referenceLinks(pages(51))
    },
  ],
  [
    "valid 99 element legacy request",
    (r) => {
      r.intents[102].body.properties[fieldId] = oldValue(pages(50))
    },
  ],
  [
    "later legacy overflow",
    (r) => {
      r.intents[102].body.properties[fieldId] = oldValue(pages(52))
    },
  ],
  [
    "changed URL spelling",
    (r) => {
      r.intents[102].body.properties[fieldId].rich_text[0].text.link.url += "?changed=1"
    },
  ],
  [
    "changed source path",
    (r) => {
      r.portable.files[1].path = "references/changed.md"
    },
  ],
  [
    "source order",
    (r) => {
      ;[r.portable.files[1], r.portable.files[2]] = [r.portable.files[2], r.portable.files[1]]
    },
  ],
  [
    "incomplete source set",
    (r) => {
      r.portable.files = r.portable.files.slice(0, 51)
    },
  ],
  [
    "duplicate source path",
    (r) => {
      r.portable.files.push({ ...r.portable.files[1] })
    },
  ],
  [
    "unacknowledged original root",
    (r) => {
      r.intents[0].status = "unknown"
    },
  ],
  [
    "wrong original root ACK",
    (r) => {
      r.intents[0].response.id = source
    },
  ],
  [
    "unacknowledged child",
    (r) => {
      r.intents[1].status = "unknown"
    },
  ],
  [
    "different child identity",
    (r) => {
      r.intents[1].response.id = source
    },
  ],
  [
    "child points to root",
    (r) => {
      r.intents[1].response.id = root
    },
  ],
  [
    "foreign child parent",
    (r) => {
      r.intents[1].body.parent.page_id = source
    },
  ],
  [
    "changed child title",
    (r) => {
      r.intents[1].body.properties.title.title[0].text.content = "changed.md"
    },
  ],
  [
    "extra child property",
    (r) => {
      r.intents[1].body.properties.Other = {}
    },
  ],
  [
    "unacknowledged earlier register",
    (r) => {
      r.intents[2].status = "failed"
    },
  ],
  [
    "wrong earlier register ACK",
    (r) => {
      r.intents[2].response.id = source
    },
  ],
  [
    "truncated earlier prefix",
    (r) => {
      r.intents[4].body.properties[fieldId] = referenceLinks(pages(1))
    },
  ],
  [
    "extra earlier register side effect",
    (r) => {
      r.intents[2].body.properties.Other = {}
    },
  ],
  [
    "earlier register flag",
    (r) => {
      r.intents[2].typed_links = { state: "pending" }
    },
  ],
]
for (const [name, change] of changes)
  test(`legacy limit proof refuses ${name}`, () => {
    const receipt = fixture()
    change(receipt)
    const before = JSON.stringify(receipt)
    assert.equal(legacyReferencesLimitPrefix(receipt, 102, fieldId), false)
    assert.equal(JSON.stringify(receipt), before)
  })

test("a shifted or arbitrary failed intent is not the original first overflow", () => {
  const receipt = fixture()
  assert.equal(legacyReferencesLimitPrefix(receipt, 100, fieldId), false)
  receipt.intents.unshift({ ...receipt.intents[0] })
  assert.equal(legacyReferencesLimitPrefix(receipt, 103, fieldId), false)
  assert.equal(legacyReferencesLimitPrefix(receipt, 102, fieldId), false)
})
