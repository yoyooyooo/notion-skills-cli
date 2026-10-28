import assert from "node:assert/strict"
import { test } from "vitest"
import { createHash } from "node:crypto"
import { deriveSourceRootCompletion } from "../src/publication-source-root-completion-effect.ts"
import type { PortableSkill } from "../src/portable.ts"
import {
  sourceRootCompletionAfterMatches,
  sourceRootCompletionExactBefore,
  sourceRootCompletionInventory,
} from "../src/source-root-completion-guards.ts"
import type {
  SourceRootCompletionObservation,
  SourceRootCompletionPlan,
} from "../src/upstream-source-root-completion-model.ts"

const id = (value: number) => `11111111-1111-4111-8111-${String(value).padStart(12, "0")}`
const root = id(1),
  references = [id(10), id(11)],
  actor = id(40)
const pagePath = `v1/pages/${root}`,
  rootChildren = `v1/blocks/${root}/children?page_size=100`
const nextChildren = `${rootChildren}&start_cursor=second`
const beforeTime = "2026-10-18T00:00:00.000Z",
  afterTime = "2026-10-18T00:01:00.000Z"
const unrelatedTime = "2026-10-17T18:00:00.000Z"
const authored = "# Authored root\n\nKeep **exact** text.\n"
const referencePaths = ["references/policy.md", "references/guide.md"]
const tags = references.map(
  (page, index) =>
    `<page url="https://app.notion.com/p/${page.replaceAll("-", "")}">${referencePaths[index]!.slice("references/".length)}</page>`,
)
const retainedMarkdown = tags.join("\n")
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const styles = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
}
const rich = (content: string, bold = false, url: string | null = null) => ({
  type: "text",
  text: { content, link: url === null ? null : { url } },
  plain_text: content,
  href: url,
  annotations: { ...styles, bold },
})
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function object(value: unknown) {
  assert.ok(record(value))
  return value
}
function rows(observed: SourceRootCompletionObservation, path: string) {
  const values = object(observed.raw[path]).results
  assert.ok(Array.isArray(values) && values.every(record))
  return values
}
function properties(observed: SourceRootCompletionObservation, page = root) {
  return object(object(observed.raw[`v1/pages/${page}`]).properties)
}
function block(blockId: string, owner: string, type: string, body: Record<string, unknown>) {
  return {
    object: "block",
    id: blockId,
    type,
    parent: { type: "page_id", page_id: owner },
    archived: false,
    in_trash: false,
    has_children: false,
    last_edited_time: beforeTime,
    [type]: body,
  }
}
function pageMarkdown(page: string, markdown: string) {
  return {
    object: "page_markdown",
    id: page,
    markdown,
    truncated: false,
    unknown_block_ids: [],
    request_id: "transport",
  }
}
function list(results: unknown[], has_more = false, next_cursor: string | null = null) {
  return {
    object: "list",
    type: "block",
    block: {},
    results,
    has_more,
    next_cursor,
    request_id: "transport",
  }
}

/** Synthetic complete raw resources exercise the physical relation, not the
 * upstream authority or publication journal. All production authority checks
 * remain the responsibility of the separate lifecycle suite. */
function fixture() {
  const referenceRich = references.flatMap((page, index) => [
    ...(index ? [rich("\n")] : []),
    rich(referencePaths[index]!, false, `https://www.notion.so/${page.replaceAll("-", "")}`),
  ])
  const children = references.map((page, index) =>
    block(page, root, "child_page", {
      title: referencePaths[index]!.slice("references/".length),
    }),
  )
  const raw: Record<string, unknown> = {
    [pagePath]: {
      object: "page",
      id: root,
      archived: false,
      in_trash: false,
      last_edited_time: beforeTime,
      last_edited_by: { object: "user", id: actor },
      parent: { type: "data_source_id", data_source_id: id(50), database_id: id(51) },
      request_id: "transport",
      properties: {
        Name: { id: "title", type: "title", title: [rich("Root")] },
        References: { id: "references", type: "rich_text", rich_text: referenceRich },
        Files: { id: "files", type: "files", files: [] },
        Publication: {
          id: "publication",
          type: "rich_text",
          rich_text: [rich("original-writing-marker")],
        },
        Updated: { id: "updated", type: "last_edited_time", last_edited_time: beforeTime },
        Independent: {
          id: "independent",
          type: "last_edited_time",
          last_edited_time: unrelatedTime,
        },
      },
    },
    [`${pagePath}/properties/references?page_size=100`]: {
      object: "list",
      results: referenceRich.map((value) => ({
        object: "property_item",
        id: "references",
        type: "rich_text",
        rich_text: value,
      })),
      has_more: false,
      next_cursor: null,
      request_id: "transport",
    },
    [`${pagePath}/markdown`]: pageMarkdown(root, retainedMarkdown),
    [rootChildren]: list([children[0]], true, "second"),
    [nextChildren]: list([children[1]]),
  }
  for (const [index, page] of references.entries()) {
    raw[`v1/pages/${page}`] = {
      object: "page",
      id: page,
      archived: false,
      in_trash: false,
      parent: { type: "page_id", page_id: root },
      last_edited_time: beforeTime,
      last_edited_by: { object: "user", id: actor },
      request_id: "transport",
      properties: {
        title: {
          id: "title",
          type: "title",
          title: [rich(referencePaths[index]!.slice("references/".length))],
        },
      },
    }
    raw[`v1/pages/${page}/markdown`] = pageMarkdown(page, `Reference ${index}.\n`)
    raw[`v1/blocks/${page}/children?page_size=100`] = list([
      block(id(300 + index), page, "paragraph", {
        rich_text: [rich(`Reference ${index}.`)],
        color: "default",
      }),
    ])
  }
  const before: SourceRootCompletionObservation = {
    raw,
    page_ids: [root, ...references].sort(),
    attachments: [],
    graph_sha256: hash("original empty root with two complete references"),
  }
  const plan = {
    input: {
      original_plan_id: `up_${"1".repeat(64)}`,
      member_key: "skills/fixture-root",
      page_id: root,
      old_operation_id: "p_original-writing-fixture",
    },
    before,
    effect: {
      kind: "empty_authored_root",
      before_shape: "only_retained_reference_child_pages",
      source_path: "SKILL.md",
      source_sha256: hash(authored),
      source_body_sha256: hash(authored),
      authored_body: authored,
      body_model_sha256: hash("model hash is checked by the separate plan decoder"),
      references: references.map((page, index) => ({
        path: referencePaths[index]!,
        page_id: page,
        tag: tags[index]!,
      })),
      retained_markdown: retainedMarkdown,
      proposed_only: true,
      request: {
        path: `${pagePath}/markdown`,
        method: "PATCH",
        body: {
          markdown_version: "v2",
          type: "replace_content",
          replace_content: { new_str: authored + retainedMarkdown },
        },
      },
    },
  } satisfies Pick<SourceRootCompletionPlan, "input" | "before" | "effect">
  const after = structuredClone(before)
  object(after.raw[pagePath]).last_edited_time = afterTime
  object(properties(after).Updated).last_edited_time = afterTime
  object(after.raw[`${pagePath}/markdown`]).markdown = authored + retainedMarkdown
  rows(after, rootChildren).unshift(
    block(id(200), root, "heading_1", {
      rich_text: [rich("Authored root")],
      color: "default",
      is_toggleable: false,
    }),
    block(id(201), root, "paragraph", {
      rich_text: [rich("Keep "), rich("exact", true), rich(" text.")],
      color: "default",
    }),
  )
  const complete: SourceRootCompletionObservation = {
    ...after,
    graph_sha256: hash("the complete allocated authored root"),
  }
  return { before, after: complete, plan }
}

test("closes a paginated two-reference graph and permits only the complete authored root addition", () => {
  const f = fixture(),
    saved = JSON.stringify(f)
  const original = sourceRootCompletionInventory(root, f.before)
  const complete = sourceRootCompletionInventory(root, f.after)
  assert.equal(original.ordinary_nodes.length, 0)
  assert.equal(complete.ordinary_nodes.length, 2)
  assert.deepEqual(original.references, complete.references)
  assert.equal(sourceRootCompletionAfterMatches(f.plan, f.after), true)
  assert.equal(JSON.stringify(f), saved)
})

test("source placeholders keep their exact bytes while real page resource names remain forbidden", () => {
  const f = fixture(),
    encode = (value: string) => new TextEncoder().encode(value)
  const portable = (body: string): PortableSkill => ({
    kind: "skill",
    name: "root-resource-fixture",
    description: "Verify exact authored resource boundaries.",
    main: "SKILL.md",
    files: [
      { path: "SKILL.md", bytes: encode(body) },
      ...referencePaths.map((path, index) => ({ path, bytes: encode(`Reference ${index}.\n`) })),
    ],
  })
  const body = "# Source\n\nRead `design-system/<project-slug>/pages/<page-name>.md`.\n\n"
  const source = portable(body),
    frozen = JSON.stringify(source)
  const effect = deriveSourceRootCompletion(root, source, f.before)
  assert.equal(effect.authored_body, body)
  assert.equal(effect.request.body.replace_content.new_str, body + retainedMarkdown)
  assert.equal(JSON.stringify(source), frozen)
  for (const resource of [
    `<page url="https://app.notion.com/p/${root.replaceAll("-", "")}">Child</page>`,
    "<page>",
    "<page/>",
    "</page>",
    '<PAGE\nurl="foreign">Child</PAGE>',
  ]) {
    for (const markdown of [
      resource,
      `Literal \`${resource}\`.\n`,
      `\`\`\`text\n${resource}\n\`\`\`\n`,
    ])
      assert.throws(
        () => deriveSourceRootCompletion(root, portable(markdown), f.before),
        /Authored source cannot introduce or imitate a child-page resource/,
      )
  }
  assert.throws(
    () => deriveSourceRootCompletion(root, portable("<page"), f.before),
    /Authored source cannot introduce or imitate a child-page resource/,
  )
})

test("refuses unconsumed raw resources and incomplete or contradictory pagination", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      object(f.before.raw)[`v1/blocks/${id(999)}`] = { object: "block", id: id(999) }
    },
    (f: ReturnType<typeof fixture>) => {
      delete object(f.before.raw)[nextChildren]
    },
    (f: ReturnType<typeof fixture>) => {
      object(f.before.raw[nextChildren]).next_cursor = "unconsumed"
    },
    (f: ReturnType<typeof fixture>) => {
      object(f.before.raw[rootChildren]).next_cursor = "missing"
    },
  ]) {
    const f = fixture()
    change(f)
    assert.throws(() => sourceRootCompletionInventory(root, f.before))
  }
})

test("rejects duplicate physical IDs across references and reuse of any original ordinary ID", () => {
  const duplicate = fixture()
  rows(duplicate.before, `v1/blocks/${references[1]}/children?page_size=100`)[0]!.id = id(300)
  assert.throws(() => sourceRootCompletionInventory(root, duplicate.before))
  const reused = fixture()
  rows(reused.after, rootChildren)[0]!.id = id(300)
  assert.equal(sourceRootCompletionAfterMatches(reused.plan, reused.after), false)
})

test("preserves complete retained reference metadata, body, physical fields and order", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      object(f.after.raw[`v1/pages/${references[0]}`]).last_edited_time = afterTime
    },
    (f: ReturnType<typeof fixture>) => {
      properties(f.after, references[0]).extra = { id: "extra", type: "checkbox", checkbox: true }
    },
    (f: ReturnType<typeof fixture>) => {
      object(f.after.raw[`v1/pages/${references[0]}/markdown`]).markdown = "Changed reference.\n"
    },
    (f: ReturnType<typeof fixture>) => {
      rows(f.after, `v1/blocks/${references[0]}/children?page_size=100`)[0]!.last_edited_time =
        afterTime
    },
    (f: ReturnType<typeof fixture>) => {
      rows(f.after, nextChildren)[0]!.parent = { type: "page_id", page_id: id(999) }
    },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(sourceRootCompletionAfterMatches(f.plan, f.after), false)
  }
  const reordered = fixture()
  const first = rows(reordered.after, rootChildren).pop()!
  const second = rows(reordered.after, nextChildren).pop()!
  rows(reordered.after, rootChildren).push(second)
  rows(reordered.after, nextChildren).push(first)
  object(reordered.after.raw[`${pagePath}/markdown`]).markdown =
    authored + [...tags].reverse().join("\n")
  assert.equal(sourceRootCompletionAfterMatches(reordered.plan, reordered.after), false)
})

test("root-only allowance keeps marker, ownership, editor and unrelated timestamp fields exact", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      object(properties(f.after).Publication).rich_text = [rich("different marker")]
    },
    (f: ReturnType<typeof fixture>) => {
      object(f.after.raw[pagePath]).last_edited_by = { object: "user", id: id(41) }
    },
    (f: ReturnType<typeof fixture>) => {
      object(f.after.raw[pagePath]).parent = { type: "data_source_id", data_source_id: id(999) }
    },
    (f: ReturnType<typeof fixture>) => {
      object(properties(f.after).Independent).last_edited_time = afterTime
    },
    (f: ReturnType<typeof fixture>) => {
      object(properties(f.after).Updated).id = "new-property-identity"
    },
    (f: ReturnType<typeof fixture>) => {
      object(properties(f.after).Files).files = [{ name: "unexpected.zip" }]
    },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(sourceRootCompletionAfterMatches(f.plan, f.after), false)
  }
})

test("two individually valid AFTER graphs cannot exchange allocated IDs between stable reads", () => {
  const f = fixture(),
    second = structuredClone(f.after)
  rows(second, rootChildren)[0]!.id = id(202)
  assert.equal(sourceRootCompletionAfterMatches(f.plan, f.after), true)
  assert.equal(sourceRootCompletionAfterMatches(f.plan, second), true)
  assert.equal(sourceRootCompletionExactBefore(f.after, second), false)
})

test("blank physical extras are refused even when the authored Markdown remains exact", () => {
  const f = fixture()
  rows(f.after, rootChildren).unshift(
    block(id(500), root, "paragraph", { rich_text: [], color: "default" }),
  )
  assert.equal(sourceRootCompletionAfterMatches(f.plan, f.after), false)
  const before = fixture()
  rows(before.before, rootChildren).unshift(
    block(id(500), root, "paragraph", { rich_text: [], color: "default" }),
  )
  assert.equal(sourceRootCompletionAfterMatches(before.plan, before.after), false)
})

test("stable observations ignore only request ID values, not missing fields or body envelopes", () => {
  const f = fixture(),
    second = structuredClone(f.after)
  for (const raw of Object.values(second.raw)) object(raw).request_id = "another-transport"
  assert.equal(sourceRootCompletionExactBefore(f.after, second), true)
  delete object(second.raw[pagePath]).request_id
  assert.equal(sourceRootCompletionExactBefore(f.after, second), false)
  const truncated = structuredClone(f.after)
  object(truncated.raw[`${pagePath}/markdown`]).unknown_block_ids = [id(900)]
  assert.equal(sourceRootCompletionAfterMatches(f.plan, truncated), false)
})
