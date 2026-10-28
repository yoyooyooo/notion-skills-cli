import assert from "node:assert/strict"
import { test } from "bun:test"
import { completedBlockOwnerPropertiesMatch as matches } from "../src/publication-effect-proof.ts"
import { metadata, metadataContent } from "../src/publication-observation.ts"

const page = "11111111-1111-4111-8111-111111111111",
  other = "33333333-3333-4333-8333-333333333333"
const ownerPath = `v1/pages/${page}`
const clone = (value) => structuredClone(value)
function fixture() {
  const before = metadataContent(
    metadata({
      id: page,
      parent: { type: "data_source_id", data_source_id: "source" },
      last_edited_time: "before",
      archived: false,
      in_trash: false,
      properties: {
        Files: { id: "files", type: "files", files: [] },
        Name: {
          id: "name",
          type: "title",
          title: [{ type: "text", text: { content: "Original" } }],
        },
        Publication: {
          id: "publication",
          type: "rich_text",
          rich_text: [{ type: "text", text: { content: "Same writing marker" } }],
        },
      },
    }),
  )
  const current = clone(before)
  current.properties.Files.files = [{ id: "uploaded-file-id", type: "file", name: "source.zip" }]
  const block = {
    method: "PATCH",
    path: "v1/blocks/22222222-2222-4222-8222-222222222222",
    status: "completed",
    body: { code: { language: "plain text" } },
    response: { id: "22222222-2222-4222-8222-222222222222" },
    guards: { [ownerPath]: clone(before) },
  }
  const attachment = {
    method: "PATCH",
    path: ownerPath,
    status: "completed",
    response: { id: page },
    body: {
      properties: {
        files: {
          files: [{ name: "source.zip", type: "file_upload", file_upload: { id: "upload-id" } }],
        },
      },
    },
  }
  const receipt = { intents: [block, attachment] }
  const verified = [{ intent_index: 1, path: ownerPath, keys: ["files"], owner: clone(current) }]
  const f = { before, current, receipt, verified, blockIndex: 0 }
  f.run = () =>
    matches(f.receipt.intents[f.blockIndex], f.receipt, ownerPath, f.before, f.current, f.verified)
  return f
}

test("later actually verified attachment values may advance only the completed block owner's Files field", () => {
  const f = fixture(),
    before = JSON.stringify(f)
  assert.equal(f.run(), true)
  assert.equal(JSON.stringify(f), before)
  assert.equal(f.receipt.intents[1].guards, undefined)
  assert.deepEqual(f.receipt.intents[1].response, { id: page })
  assert.equal(
    matches(clone(f.receipt.intents[0]), f.receipt, ownerPath, f.before, f.current, f.verified),
    false,
  )
})

test("the same full-field proof supports an ordinary property and an explicit matching type", () => {
  const f = fixture()
  f.current.properties.Files = clone(f.before.properties.Files)
  f.current.properties.Name.title = [{ type: "text", text: { content: "Updated" } }]
  f.receipt.intents[1].body.properties = {
    Name: { type: "title", title: clone(f.current.properties.Name.title) },
  }
  f.verified[0].keys = ["Name"]
  f.verified[0].owner = clone(f.current)
  assert.equal(f.run(), true)
})

test("two later verified fields require individual finite evidence", () => {
  const f = fixture()
  f.current.properties.Name.title[0].text.content = "Updated"
  f.receipt.intents.push({
    method: "PATCH",
    path: ownerPath,
    status: "completed",
    response: { id: page },
    body: { properties: { name: { title: clone(f.current.properties.Name.title) } } },
  })
  f.verified[0].owner = clone(f.current)
  assert.equal(f.run(), false)
  f.verified.push({ intent_index: 2, path: ownerPath, keys: ["name"], owner: clone(f.current) })
  assert.equal(f.run(), true)
})

for (const [name, change] of [
  [
    "missing verified field",
    (f) => {
      f.verified = []
    },
  ],
  [
    "wrong proven field",
    (f) => {
      f.verified[0].keys = ["name"]
    },
  ],
  [
    "stale current field",
    (f) => {
      f.verified[0].owner.properties.Files.files = []
    },
  ],
  [
    "different proof owner",
    (f) => {
      f.verified[0].path = `v1/pages/${other}`
    },
  ],
  [
    "duplicate current proof",
    (f) => {
      f.verified.push(clone(f.verified[0]))
    },
  ],
  [
    "earlier property acknowledgement",
    (f) => {
      f.receipt.intents.reverse()
      f.blockIndex = 1
      f.verified[0].intent_index = 0
    },
  ],
  [
    "missing intent",
    (f) => {
      f.verified[0].intent_index = 20
    },
  ],
  [
    "noninteger intent",
    (f) => {
      f.verified[0].intent_index = 1.5
    },
  ],
  [
    "pending block",
    (f) => {
      f.receipt.intents[0].status = "unknown"
    },
  ],
  [
    "pending property",
    (f) => {
      f.receipt.intents[1].status = "unknown"
    },
  ],
  [
    "failed property",
    (f) => {
      f.receipt.intents[1].status = "failed"
    },
  ],
  [
    "recovered property",
    (f) => {
      f.receipt.intents[1].recovery = { replacement_suboperation_id: "replacement" }
    },
  ],
  [
    "synthetic observed response",
    (f) => {
      f.receipt.intents[1].response.recovery = "observed_applied"
    },
  ],
  [
    "superseded response",
    (f) => {
      f.receipt.intents[1].response.superseded_by = "later"
    },
  ],
  [
    "replayed response",
    (f) => {
      f.receipt.intents[1].response.replayed_by_intent = 3
    },
  ],
  [
    "pending typed links",
    (f) => {
      f.receipt.intents[1].typed_links = { state: "pending" }
    },
  ],
  [
    "wrong response identity",
    (f) => {
      f.receipt.intents[1].response.id = other
    },
  ],
  [
    "wrong property target",
    (f) => {
      f.receipt.intents[1].path = `v1/pages/${other}`
    },
  ],
  [
    "page creation instead of later patch",
    (f) => {
      f.receipt.intents[1].method = "POST"
    },
  ],
  [
    "unverified later replacement",
    (f) => {
      f.receipt.intents.push(clone(f.receipt.intents[1]))
    },
  ],
  [
    "empty requested field",
    (f) => {
      f.receipt.intents[1].body.properties.files = {}
    },
  ],
  [
    "partial requested field shape",
    (f) => {
      f.receipt.intents[1].body.properties.files.extra = true
    },
  ],
  [
    "mismatched explicit field type",
    (f) => {
      f.receipt.intents[1].body.properties.files.type = "rich_text"
    },
  ],
  [
    "extra page mutation",
    (f) => {
      f.receipt.intents[1].body.archived = false
    },
  ],
  [
    "duplicate field aliases",
    (f) => {
      f.receipt.intents[1].body.properties.Files = clone(f.receipt.intents[1].body.properties.files)
    },
  ],
])
  test("completed owner advancement rejects " + name, () => {
    const f = fixture()
    change(f)
    assert.equal(f.run(), false)
  })

for (const [name, change] of [
  [
    "external owner property",
    (f) => {
      f.current.properties.Name.title[0].text.content = "External"
    },
  ],
  [
    "owner parent",
    (f) => {
      f.current.parent.data_source_id = "external"
    },
  ],
  [
    "owner archive",
    (f) => {
      f.current.archived = true
    },
  ],
  [
    "owner trash",
    (f) => {
      f.current.in_trash = true
    },
  ],
  [
    "owner identity",
    (f) => {
      f.current.id = other
    },
  ],
  [
    "added property",
    (f) => {
      f.current.properties.Added = { id: "added", type: "number", number: 1 }
    },
  ],
  [
    "removed property",
    (f) => {
      delete f.current.properties.Name
    },
  ],
  [
    "Files property identity",
    (f) => {
      f.current.properties.Files.id = "external"
    },
  ],
  [
    "Files property type",
    (f) => {
      f.current.properties.Files.type = "rich_text"
    },
  ],
  [
    "Files property extra metadata",
    (f) => {
      f.current.properties.Files.has_more = true
    },
  ],
  [
    "ambiguous request identity",
    (f) => {
      f.before.properties.files = { id: "another", type: "number", number: 1 }
      f.current.properties.files = clone(f.before.properties.files)
    },
  ],
  [
    "duplicate property ID",
    (f) => {
      f.before.properties.Alias = clone(f.before.properties.Files)
      f.current.properties.Alias = clone(f.before.properties.Files)
    },
  ],
])
  test("verified Files evidence never masks changed " + name, () => {
    const f = fixture()
    change(f)
    f.verified[0].owner = clone(f.current)
    assert.equal(f.run(), false)
  })

test("ordinary property evidence cannot authorize a Publication marker transition", () => {
  const f = fixture()
  f.current.properties.Files = clone(f.before.properties.Files)
  f.current.properties.Publication.rich_text[0].text.content = "Different marker"
  f.receipt.intents[1].body.properties = {
    publication: { rich_text: clone(f.current.properties.Publication.rich_text) },
  }
  f.verified[0].keys = ["publication"]
  f.verified[0].owner = clone(f.current)
  assert.equal(f.run(), false)
})
