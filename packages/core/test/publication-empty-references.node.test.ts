import assert from "node:assert/strict"
import { test } from "vitest"
import type { Receipt } from "../src/publication-model.ts"
import { hasOriginalEmptyReferencesCheckpoint } from "../src/publication-empty-references.ts"

const root = "11111111-1111-4111-8111-111111111111"
const child = "22222222-2222-4222-8222-222222222222"
const rootPath = `v1/pages/${root}`
const inventory = `v1/blocks/${root}/children?page_size=100`
const next = inventory + "&start_cursor=next"
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value))
  return value as Record<string, unknown>
}
const block = (id = "paragraph-1") => ({
  object: "block",
  id,
  type: "paragraph",
  has_children: false,
  parent: { type: "page_id", page_id: root },
  paragraph: { rich_text: [] },
  archived: false,
  in_trash: false,
})
function scenario() {
  const metadata = {
    id: root,
    parent: { type: "data_source_id", data_source_id: "ds" },
    last_edited_time: "unchanged-revision",
    archived: false,
    in_trash: false,
    properties: {
      References: { id: "references", type: "rich_text", rich_text: [] },
      Description: { id: "description", type: "rich_text", rich_text: [] },
    },
  }
  // A component fixture proves emptiness only. The integration test obtains
  // real source objects, ACKs, marker and fence through normal publication.
  const receipt: Receipt = {
    format: 1,
    operation_id: "p_empty-references",
    operation: "create",
    page_id: root,
    database_id: "database",
    data_source_id: "ds",
    scope: "scope",
    state: "failed",
    conflict: true,
    stages: ["verify"],
    portable: {
      kind: "skill",
      name: "sample",
      description: "sample",
      main: "SKILL.md",
      files: [
        { path: "SKILL.md", sha256: "a".repeat(64) },
        { path: "scripts/run.sh", sha256: "b".repeat(64) },
      ],
    },
    guards: {
      [rootPath]: structuredClone(metadata),
      [rootPath + "/markdown"]: "# Exact original body\n",
      [inventory]: { results: [], has_more: false, next_cursor: null },
    },
    intents: [
      {
        path: "v1/pages",
        method: "POST",
        status: "completed",
        response: { id: root },
        body: { parent: { data_source_id: "ds" }, properties: {} },
      },
      {
        path: rootPath,
        method: "PATCH",
        status: "completed",
        response: { id: root },
        body: { properties: { references: { rich_text: [] } } },
      },
      {
        path: rootPath + "/markdown",
        method: "PATCH",
        status: "completed",
        response: { id: root },
        body: { type: "replace_content", replace_content: { new_str: "# Exact original body\n" } },
      },
    ],
  }
  const raw: Record<string, unknown> = {
    [inventory]: { object: "list", results: [block()], has_more: false, next_cursor: null },
  }
  return { receipt, metadata: metadata as unknown, raw }
}
type Scenario = ReturnType<typeof scenario>
const prove = (value: Scenario) =>
  hasOriginalEmptyReferencesCheckpoint(value.receipt, rootPath, value.metadata, value.raw)
const bothReferences = (value: Scenario, edit: (field: Record<string, unknown>) => void) => {
  edit(record(record(record(value.receipt.guards[rootPath]).properties).References))
  edit(record(record(record(value.metadata).properties).References))
}
function paged(value: Scenario) {
  value.receipt.guards[inventory] = { results: [], has_more: true, next_cursor: "next" }
  value.raw[inventory] = { results: [block()], has_more: true, next_cursor: "next" }
  value.receipt.guards[next] = { results: [], has_more: false, next_cursor: null }
  value.raw[next] = { results: [block("paragraph-2")], has_more: false, next_cursor: null }
}

test("exact empty metadata and an original complete root inventory need no invented property guard", () => {
  const value = scenario()
  const before = structuredClone(value)
  assert.equal(prove(value), true)
  assert.deepEqual(value, before)
  assert.equal(
    Object.keys(value.receipt.guards).some((path) => path.includes("/properties/")),
    false,
  )
})

test("all pages of the retained and fresh empty-child inventory may contain ordinary root blocks", () => {
  const value = scenario()
  paged(value)
  const before = structuredClone(value)
  assert.equal(prove(value), true)
  assert.deepEqual(value, before)
})

test("an empty original field does not require a fictitious empty References write", () => {
  const value = scenario()
  value.receipt.intents.splice(1, 1)
  assert.equal(prove(value), true)
})

const refused: ReadonlyArray<readonly [string, (value: Scenario) => void]> = [
  [
    "a missing retained owner",
    (value) => {
      delete value.receipt.guards[rootPath]
    },
  ],
  [
    "a missing fresh owner",
    (value) => {
      value.metadata = undefined
    },
  ],
  [
    "a different owner",
    (value) => {
      record(value.metadata).id = child
    },
  ],
  [
    "a changed metadata revision",
    (value) => {
      record(value.metadata).last_edited_time = "changed"
    },
  ],
  [
    "a missing rich_text array",
    (value) =>
      bothReferences(value, (field) => {
        delete field.rich_text
      }),
  ],
  [
    "a null rich_text array",
    (value) =>
      bothReferences(value, (field) => {
        field.rich_text = null
      }),
  ],
  [
    "nonempty rich_text",
    (value) =>
      bothReferences(value, (field) => {
        field.rich_text = [{ text: { content: " " } }]
      }),
  ],
  [
    "an incomplete property",
    (value) =>
      bothReferences(value, (field) => {
        field.has_more = true
      }),
  ],
  [
    "an unexpected property cursor",
    (value) =>
      bothReferences(value, (field) => {
        field.next_cursor = "next"
      }),
  ],
  [
    "a nonboolean completeness flag",
    (value) =>
      bothReferences(value, (field) => {
        field.has_more = "false"
      }),
  ],
  [
    "a wrong property type",
    (value) =>
      bothReferences(value, (field) => {
        field.type = "relation"
      }),
  ],
  [
    "a missing property ID",
    (value) =>
      bothReferences(value, (field) => {
        delete field.id
      }),
  ],
  [
    "an empty property ID",
    (value) =>
      bothReferences(value, (field) => {
        field.id = ""
      }),
  ],
  [
    "an unencodable property ID",
    (value) =>
      bothReferences(value, (field) => {
        field.id = "\ud800"
      }),
  ],
  [
    "a changed property ID",
    (value) => {
      record(record(record(value.metadata).properties).References).id = "different"
    },
  ],
  [
    "an existing but incomplete property-items history",
    (value) => {
      value.receipt.guards[rootPath + "/properties/references?page_size=100&start_cursor=tail"] = {
        results: [],
        has_more: false,
        next_cursor: null,
      }
    },
  ],
  [
    "a frozen reference Markdown child",
    (value) => {
      value.receipt.portable.files.push({ path: "references/guide.md", sha256: "c".repeat(64) })
    },
  ],
  [
    "a missing frozen main file",
    (value) => {
      value.receipt.portable.files.shift()
    },
  ],
  [
    "an absent data-source identity",
    (value) => {
      delete value.receipt.data_source_id
    },
  ],
  [
    "a duplicate main file",
    (value) => {
      value.receipt.portable.files.push(value.receipt.portable.files[0]!)
    },
  ],
  [
    "a completed child create",
    (value) => {
      value.receipt.intents.push({
        path: "v1/pages",
        method: "POST",
        status: "completed",
        response: { id: child },
        body: { parent: { page_id: root } },
      })
    },
  ],
  [
    "a different page body",
    (value) => {
      value.receipt.intents.push({
        path: `v1/pages/${child}/markdown`,
        method: "PATCH",
        status: "completed",
        body: {},
      })
    },
  ],
  [
    "an unknown original effect",
    (value) => {
      value.receipt.intents[2]!.status = "unknown"
    },
  ],
  [
    "a formerly nonempty References request",
    (value) => {
      value.receipt.intents[1] = {
        ...value.receipt.intents[1]!,
        body: { properties: { references: { rich_text: [{ text: { content: "guide.md" } }] } } },
      }
    },
  ],
  [
    "a missing first inventory page",
    (value) => {
      delete value.receipt.guards[inventory]
    },
  ],
  [
    "a missing fresh inventory page",
    (value) => {
      delete value.raw[inventory]
    },
  ],
  [
    "an invalid retained results value",
    (value) => {
      record(value.receipt.guards[inventory]).results = undefined
    },
  ],
  [
    "an invalid fresh results value",
    (value) => {
      record(value.raw[inventory]).results = null
    },
  ],
  [
    "a missing completeness flag",
    (value) => {
      delete record(value.raw[inventory]).has_more
    },
  ],
  [
    "a truncated cursor chain",
    (value) => {
      paged(value)
      delete value.receipt.guards[next]
    },
  ],
  [
    "a missing fresh cursor page",
    (value) => {
      paged(value)
      delete value.raw[next]
    },
  ],
  [
    "a repeated cursor",
    (value) => {
      paged(value)
      value.receipt.guards[next] = { results: [], has_more: true, next_cursor: "next" }
      value.raw[next] = { results: [block("paragraph-2")], has_more: true, next_cursor: "next" }
    },
  ],
  [
    "an orphan retained cursor page",
    (value) => {
      value.receipt.guards[next] = { results: [], has_more: false, next_cursor: null }
    },
  ],
  [
    "a child on a later inventory page",
    (value) => {
      paged(value)
      record(value.raw[next]).results = [
        { ...block(child), type: "child_page", child_page: { title: "guide.md" } },
      ]
    },
  ],
  [
    "a foreign inventory root",
    (value) => {
      record(value.raw[inventory]).results = [
        { ...block(), parent: { type: "page_id", page_id: child } },
      ]
    },
  ],
  [
    "missing block type evidence",
    (value) => {
      const item = block()
      delete (item as Partial<typeof item>).type
      record(value.raw[inventory]).results = [item]
    },
  ],
  [
    "unsupported block evidence",
    (value) => {
      record(value.raw[inventory]).results = [{ ...block(), type: "unsupported", unsupported: {} }]
    },
  ],
  [
    "an unknown block envelope",
    (value) => {
      record(value.raw[inventory]).results = [
        { ...block(), type: "unknown_future_type", unknown_future_type: {} },
      ]
    },
  ],
  [
    "duplicate block identities",
    (value) => {
      paged(value)
      record(value.raw[next]).results = [block()]
    },
  ],
  [
    "an absent original fence",
    (value) => {
      value.receipt.conflict = false
    },
  ],
  [
    "a retained process owner",
    (value) => {
      value.receipt.owner = { host: "fixture", pid: 123 }
    },
  ],
  [
    "a replacement operation",
    (value) => {
      value.receipt = { ...value.receipt, operation: "replace" }
    },
  ],
]
for (const [name, edit] of refused) {
  test(`empty References cannot be inferred from ${name}`, () => {
    const value = scenario()
    edit(value)
    const before = structuredClone(value)
    assert.equal(prove(value), false)
    assert.deepEqual(value, before)
  })
}
