import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { hasOriginalAcknowledgedReferencesCheckpoint } from "../src/publication-acknowledged-references.ts"
import { creationMarker, creationMarkerBlock } from "../src/publication-create-identity.ts"
import { metadata } from "../src/publication-observation.ts"
import { referenceLinks } from "../src/reference-links.ts"

const sha = (value) => createHash("sha256").update(value).digest("hex")
const root = "11111111-1111-4111-8111-111111111111"
const source = "44444444-4444-4444-8444-444444444444"
const rootPath = "v1/pages/" + root
const inventoryBase = "v1/blocks/" + root + "/children?page_size=100"
const propertyBase = rootPath + "/properties/refs?page_size=100"
const rt = (content, url) => ({
  type: "text",
  text: { content, ...(url ? { link: { url } } : {}) },
})
const responseText = (item) => ({
  ...structuredClone(item),
  plain_text: item.text.content,
  href: item.text.link?.url ?? null,
  annotations: {
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    code: false,
    color: "default",
  },
})
const textField = (id, content) => ({
  id,
  type: "rich_text",
  rich_text: [responseText(rt(content))],
})

function fixture(count = 1) {
  const children = Array.from({ length: count }, (_, i) => ({
    id: "22222222-2222-4222-8222-" + String(i + 1).padStart(12, "0"),
    path: "references/config/ref-" + String(i + 1).padStart(3, "0") + ".md",
  }))
  const frozen = [
    { path: "SKILL.md", content: "# Skill\n" },
    ...children.map((child) => ({ path: child.path, content: "Body for " + child.path + ".\n" })),
    { path: "assets/notes.txt", content: "Text asset.\n" },
  ].map((file) => ({ ...file, sha256: sha(file.content) }))
  const receipt = {
    format: 1,
    operation_id: "publication-unit-fixture",
    operation: "create",
    state: "failed",
    scope: "scope",
    database_id: "database",
    data_source_id: source,
    page_id: root,
    conflict: true,
    portable: {
      kind: "skill",
      name: "fixture",
      description: "Example",
      main: "SKILL.md",
      files: frozen.map(({ path, sha256 }) => ({ path, sha256 })),
    },
    guards: {},
    intents: [],
    stages: [],
  }
  const intended = sha(
    JSON.stringify([
      receipt.portable.kind,
      receipt.portable.name,
      receipt.portable.description,
      receipt.portable.main,
      [...frozen]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((file) => [file.path, Buffer.byteLength(file.content), file.sha256]),
    ]),
  )
  const raw = {}
  const append = (method, path, body, id) => {
    receipt.intents.push({ method, path, body, status: "completed", response: { id } })
    return receipt.intents.length - 1
  }
  append(
    "POST",
    "v1/pages",
    {
      parent: { type: "data_source_id", data_source_id: source },
      properties: {
        References: { rich_text: [] },
        Publication: { rich_text: [rt("Original marker")] },
      },
    },
    root,
  )
  const childIndices = [],
    registerIndices = []
  for (const [ordinal, child] of children.entries()) {
    const index = receipt.intents.length
    const proof = {
      version: 1,
      operation_token: "33333333-3333-4333-8333-333333333333",
      operation_id: receipt.operation_id,
      intent_index: index,
      scope: receipt.scope,
      database_id: receipt.database_id,
      data_source_id: source,
      role: "reference",
      path: child.path,
      parent_type: "page_id",
      parent_id: root,
      intended_hash: intended,
      source_sha256: frozen.find((file) => file.path === child.path).sha256,
    }
    const title = child.path.slice("references/".length),
      path = "v1/pages/" + child.id
    childIndices.push(
      append(
        "POST",
        "v1/pages",
        {
          parent: { type: "page_id", page_id: root },
          properties: { title: { title: [{ text: { content: title } }] } },
          children: [creationMarkerBlock(proof)],
        },
        child.id,
      ),
    )
    raw[path] = {
      id: child.id,
      parent: { type: "page_id", page_id: root },
      properties: { title: { id: "title", type: "title", title: [responseText(rt(title))] } },
      last_edited_time: "2026-10-20T01:00:00.000Z",
      archived: false,
      in_trash: false,
    }
    raw[path + "/markdown"] = {
      markdown: creationMarker(proof) + "\n\nBody.\n",
      truncated: false,
      unknown_block_ids: [],
    }
    receipt.guards[path] = metadata(raw[path])
    receipt.guards[path + "/markdown"] = raw[path + "/markdown"].markdown
    registerIndices.push(
      append(
        "PATCH",
        rootPath,
        { properties: { refs: referenceLinks(children.slice(0, ordinal + 1)) } },
        root,
      ),
    )
  }
  const finalIndex = append(
    "PATCH",
    rootPath,
    {
      properties: {
        refs: referenceLinks(children),
        Name: { title: [rt("fixture")] },
        Description: { rich_text: [rt("Example")] },
      },
    },
    root,
  )
  const value = referenceLinks(children).rich_text.map(responseText)
  raw[rootPath] = {
    id: root,
    parent: { type: "data_source_id", data_source_id: source },
    properties: {
      References: { id: "refs", type: "rich_text", rich_text: value },
      Name: { id: "name", type: "title", title: [responseText(rt("fixture"))] },
      Description: textField("desc", "Example"),
      Publication: textField("pub", "Original marker"),
    },
    last_edited_time: "2026-10-20T01:00:00.000Z",
    archived: false,
    in_trash: false,
  }
  receipt.guards[rootPath] = metadata(raw[rootPath])
  raw[propertyBase] = {
    object: "list",
    type: "property_item",
    has_more: false,
    next_cursor: null,
    results: value.map((rich_text) => ({
      object: "property_item",
      type: "rich_text",
      id: "refs",
      rich_text: structuredClone(rich_text),
    })),
  }
  receipt.guards[inventoryBase] = {
    results: children.map((child) => ({
      id: child.id,
      type: "child_page",
      child_page: { title: child.path.slice("references/".length) },
    })),
    has_more: false,
    next_cursor: null,
  }
  raw[inventoryBase] = {
    ...structuredClone(receipt.guards[inventoryBase]),
    results: receipt.guards[inventoryBase].results.map((item) => ({
      ...item,
      parent: { type: "page_id", page_id: root },
      has_children: false,
      archived: false,
      in_trash: false,
    })),
  }
  const run = () =>
    hasOriginalAcknowledgedReferencesCheckpoint(
      receipt,
      rootPath,
      raw,
      Object.fromEntries(
        Object.entries(raw)
          .filter(([path]) => /^v1\/pages\/[^/]+$/.test(path))
          .map(([path, page]) => [path, metadata(page)]),
      ),
      intended,
    )
  return { receipt, raw, children, childIndices, registerIndices, finalIndex, intended, run }
}

for (const count of [1, 9, 50, 51, 60, 100]) {
  test(
    "strict complete original prefixes prove the final " + count + "-reference checkpoint",
    () => {
      const f = fixture(count),
        before = sha(JSON.stringify(f))
      expect(f.run()).toBe(true)
      expect(sha(JSON.stringify(f))).toBe(before)
      expect(
        Object.keys(f.receipt.guards).some((path) => path.startsWith(rootPath + "/properties/")),
      ).toBe(false)
    },
  )
}

test("no final full-field ACK means current complete metadata is insufficient", () => {
  const f = fixture(9)
  f.receipt.intents.splice(f.registerIndices.at(-1))
  expect(f.run()).toBe(false)
})

for (const [name, mutate] of [
  [
    "empty historical prefix",
    (f) => {
      f.receipt.intents[f.registerIndices[0]].body.properties.refs.rich_text = []
    },
  ],
  [
    "premature full set",
    (f) => {
      f.receipt.intents[f.registerIndices[0]].body.properties.refs = referenceLinks(f.children)
    },
  ],
  [
    "omitted allocated path",
    (f) => {
      f.receipt.intents[f.registerIndices[4]].body.properties.refs = referenceLinks(
        f.children.slice(1, 5),
      )
    },
  ],
  [
    "reordered prefix",
    (f) => {
      f.receipt.intents[f.registerIndices[4]].body.properties.refs = referenceLinks(
        f.children.slice(0, 5).reverse(),
      )
    },
  ],
  [
    "URL alias",
    (f) => {
      f.receipt.intents[f.registerIndices[0]].body.properties.refs.rich_text[0].text.link.url +=
        "?x=1"
    },
  ],
  [
    "changed original path",
    (f) => {
      f.receipt.intents[f.registerIndices[0]].body.properties.refs.rich_text[0].text.content +=
        "changed"
    },
  ],
  [
    "unknown companion",
    (f) => {
      f.receipt.intents[f.finalIndex].body.properties.Unknown = { rich_text: [] }
    },
  ],
  [
    "duplicate References key",
    (f) => {
      f.receipt.intents[f.finalIndex].body.properties.References = referenceLinks(f.children)
    },
  ],
  [
    "partial replacement shape",
    (f) => {
      f.receipt.intents[f.finalIndex].body.properties.refs.has_more = false
    },
  ],
  [
    "unknown response outcome",
    (f) => {
      f.receipt.intents[f.registerIndices[0]].status = "unknown"
    },
  ],
  [
    "wrong response identity",
    (f) => {
      f.receipt.intents[f.finalIndex].response.id = f.children[0].id
    },
  ],
  [
    "extra body property",
    (f) => {
      f.receipt.intents[f.finalIndex].body.icon = { type: "emoji", emoji: "x" }
    },
  ],
])
  test("original reference ACK refuses " + name, () => {
    const f = fixture(9)
    mutate(f)
    expect(f.run()).toBe(false)
  })

for (const [name, mutate] of [
  [
    "missing current property chain",
    (f) => {
      delete f.raw[propertyBase]
    },
  ],
  [
    "metadata-only short property value",
    (f) => {
      f.raw[propertyBase].results.pop()
    },
  ],
  [
    "wrong property item ID",
    (f) => {
      f.raw[propertyBase].results[0].id = "other"
    },
  ],
  [
    "extra property cursor",
    (f) => {
      f.raw[propertyBase + "&start_cursor=orphan"] = structuredClone(f.raw[propertyBase])
    },
  ],
  [
    "missing property cursor",
    (f) => {
      f.raw[propertyBase].has_more = true
      f.raw[propertyBase].next_cursor = "missing"
    },
  ],
  [
    "nonterminal property cursor",
    (f) => {
      f.raw[propertyBase].next_cursor = "unexpected"
    },
  ],
  [
    "contradictory plain text",
    (f) => {
      f.raw[propertyBase].results[0].rich_text.plain_text += "x"
    },
  ],
  [
    "bold reference",
    (f) => {
      f.raw[propertyBase].results[0].rich_text.annotations.bold = true
    },
  ],
  [
    "missing fresh child inventory",
    (f) => {
      delete f.raw[inventoryBase]
    },
  ],
  [
    "extra current child",
    (f) => {
      f.raw[inventoryBase].results.push({
        ...structuredClone(f.raw[inventoryBase].results[0]),
        id: "55555555-5555-4555-8555-555555555555",
      })
    },
  ],
  [
    "wrong child parent",
    (f) => {
      f.raw[inventoryBase].results[0].parent.page_id = source
    },
  ],
  [
    "missing original child",
    (f) => {
      f.receipt.guards[inventoryBase].results.pop()
    },
  ],
  [
    "partial original property guard",
    (f) => {
      f.receipt.guards[propertyBase + "&start_cursor=missing"] = {}
    },
  ],
])
  test("fresh completeness refuses " + name, () => {
    const f = fixture(9)
    mutate(f)
    expect(f.run()).toBe(false)
  })

for (const [name, mutate] of [
  [
    "root revision",
    (f) => {
      f.raw[rootPath].last_edited_time = "later"
    },
  ],
  [
    "unrequested root property",
    (f) => {
      f.raw[rootPath].properties.Unrequested = textField("other", "changed")
    },
  ],
  [
    "child revision",
    (f) => {
      f.raw["v1/pages/" + f.children[0].id].last_edited_time = "later"
    },
  ],
  [
    "child title",
    (f) => {
      f.raw["v1/pages/" + f.children[0].id].properties.title.title[0].text.content = "other.md"
    },
  ],
  [
    "missing response title type",
    (f) => {
      delete f.raw["v1/pages/" + f.children[0].id].properties.title.title[0].type
    },
  ],
  [
    "original decorated title",
    (f) => {
      f.receipt.intents[f.childIndices[0]].body.properties.title.title[0].annotations = {
        bold: true,
      }
    },
  ],
  [
    "original response-only title fields",
    (f) => {
      f.receipt.intents[f.childIndices[0]].body.properties.title.title[0].plain_text = "unknown"
    },
  ],
  [
    "original marker",
    (f) => {
      f.receipt.guards["v1/pages/" + f.children[0].id + "/markdown"] = "Changed body."
    },
  ],
  [
    "current marker",
    (f) => {
      f.raw["v1/pages/" + f.children[0].id + "/markdown"].markdown = "Changed body."
    },
  ],
  [
    "incomplete child Markdown",
    (f) => {
      f.raw["v1/pages/" + f.children[0].id + "/markdown"].truncated = true
    },
  ],
  [
    "unallocated frozen reference",
    (f) => {
      f.receipt.portable.files.push({ path: "references/extra.md", sha256: sha("extra") })
    },
  ],
  [
    "creation identity source hash",
    (f) => {
      f.receipt.portable.files.find((file) => file.path === f.children[0].path).sha256 =
        sha("changed")
    },
  ],
])
  test("original source and complete identity refuse changed " + name, () => {
    const f = fixture()
    mutate(f)
    expect(f.run()).toBe(false)
  })

test("every item of a property cursor chain remains necessary across two full pages", () => {
  const f = fixture(9),
    original = f.raw[propertyBase]
  const tail = structuredClone(original)
  tail.results = original.results.slice(7)
  original.results = original.results.slice(0, 7)
  original.has_more = true
  original.next_cursor = "part/2"
  const next = propertyBase + "&start_cursor=part%2F2"
  f.raw[next] = tail
  expect(f.run()).toBe(true)
  f.raw[next].results.pop()
  expect(f.run()).toBe(false)
})

test("all original and fresh child inventory cursor pages must match exactly", () => {
  const f = fixture(9),
    next = inventoryBase + "&start_cursor=next"
  for (const values of [f.receipt.guards, f.raw]) {
    const original = values[inventoryBase],
      tail = structuredClone(original)
    tail.results = original.results.slice(4)
    original.results = original.results.slice(0, 4)
    original.has_more = true
    original.next_cursor = "next"
    values[next] = tail
  }
  expect(f.run()).toBe(true)
  f.raw[next].results.reverse()
  expect(f.run()).toBe(false)
})

test("compact references still bind every separator, full path and URL", () => {
  for (const mutate of [
    (f) => {
      f.raw[propertyBase].results[1].rich_text.text.content = f.children[1].path
    },
    (f) => {
      f.raw[propertyBase].results[1].rich_text.text.content += "\n"
    },
    (f) => {
      f.raw[propertyBase].results[1].rich_text.text.link.url += "#changed"
    },
    (f) => {
      f.receipt.intents[f.registerIndices[50]].body.properties.refs.rich_text.pop()
    },
  ]) {
    const f = fixture(60)
    mutate(f)
    expect(f.run()).toBe(false)
  }
})

test("a genuine legacy/compact transition preserves prior acknowledged prefixes", () => {
  const f = fixture(60)
  expect(f.receipt.intents[f.registerIndices[49]].body.properties.refs.rich_text).toHaveLength(99)
  expect(f.receipt.intents[f.registerIndices[50]].body.properties.refs.rich_text).toHaveLength(51)
  expect(f.run()).toBe(true)
})
