import assert from "node:assert/strict"
import { test } from "vitest"
import { createHash } from "node:crypto"
import { property } from "../src/model.ts"
import {
  compileSourceRootBody,
  type SourceRootBodyModel,
} from "../src/source-root-completion-physical.ts"
import {
  deriveSourceRootFidelity,
  sourceRootFidelityBody,
  sourceRootFidelityStageMatches,
  type SourceRootFidelityEffect,
  type SourceRootFidelityParent,
} from "../src/source-root-fidelity-effect.ts"
import {
  sourceRootFidelityAckMatches,
  sourceRootFidelityAfterMatches,
  sourceRootFidelityBeforeMatches,
} from "../src/source-root-fidelity-guards.ts"
import type { SourceRootCompletionObservation } from "../src/upstream-source-root-completion-model.ts"

const id = (value: number) => `11111111-1111-4111-8111-${String(value).padStart(12, "0")}`
const root = id(1),
  refs = [id(10), id(11)],
  actor = id(40),
  page = `v1/pages/${root}`
const rootsPath = `v1/blocks/${root}/children?page_size=100`
const originalTime = "2026-10-18T00:00:00.000Z",
  time = "2026-10-18T00:01:00.000Z"
const authored =
  "# Complete fidelity root\n\n" +
  "| Category | Exact literal |\n|---|---|\n| First | CLS &lt; 0.1 |\n| Second | Text &lt; 12px |\n\n" +
  "- Keep `--density` in MASTER.md output without a new link.\n\n" +
  "| Problem | Rule |\n|---|---|\n| One | `a` + `b` |\n| Two | `c` + `d` + `e` |\n" +
  "| Three | `f` + `g` + `h` |\n| Four | `i` + `j` + `k` |\n| Five | `l` + `m` |\n| Six | `n` + `o` + `p` |\n\n" +
  "Keep the independent ending and [external](https://example.test/original).\n"
const distorted = authored
  .replaceAll("&lt;", "<")
  .replaceAll(" + ", "  • ")
  .replace("MASTER.md", "[MASTER.md](http://master.md/)")
const styles = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
}
const rich = (content: string, url: string | null = null) => ({
  type: "text",
  text: { content, link: url ? { url } : null },
  annotations: { ...styles },
  plain_text: content,
  href: url,
})
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const paths = ["references/policy.md", "references/guide.md"]
const tags = refs
  .map(
    (ref, index) =>
      `<page url="https://app.notion.com/p/${ref.replaceAll("-", "")}">${paths[index]!.slice(11)}</page>`,
  )
  .join("\n")
const list = (results: unknown[]) => ({
  object: "list",
  results,
  has_more: false,
  next_cursor: null,
})
const markdown = (pageId: string, body: string) => ({
  object: "page_markdown",
  id: pageId,
  markdown: body,
  truncated: false,
  unknown_block_ids: [],
})
function block(blockId: string, owner: string, type: string, body: unknown) {
  return {
    object: "block",
    id: blockId,
    type,
    parent: { type: "page_id", page_id: owner },
    has_children: false,
    archived: false,
    in_trash: false,
    created_time: originalTime,
    last_edited_time: time,
    last_edited_by: { object: "user", id: actor },
    [type]: body,
  }
}
function rows(observed: SourceRootCompletionObservation, path: string) {
  const results = property(observed.raw[path]).results
  assert.ok(Array.isArray(results))
  return results.map(property)
}
function find(observed: SourceRootCompletionObservation, selected: string) {
  for (const [path, raw] of Object.entries(observed.raw)) {
    if (!path.startsWith("v1/blocks/")) continue
    const results = property(raw).results
    if (!Array.isArray(results)) continue
    const found = results.find((value) => property(value).id === selected)
    if (found) return property(found)
  }
  throw new Error(`Missing fixture block ${selected}`)
}
function replace(observed: SourceRootCompletionObservation, selected: string, value: unknown) {
  for (const [path, raw] of Object.entries(observed.raw)) {
    if (!path.startsWith("v1/blocks/")) continue
    const response = property(raw),
      results = response.results
    if (Array.isArray(results))
      response.results = results.map((item) => (property(item).id === selected ? value : item))
  }
}

// Synthetic complete observations isolate the pure relation. They carry no
// native publication authority; the lifecycle suite builds real plan receipts.
function fixture() {
  const referenceRich = refs.flatMap((ref, index) => [
    ...(index ? [rich("\n")] : []),
    rich(paths[index]!, `https://www.notion.so/${ref.replaceAll("-", "")}`),
  ])
  const children = refs.map((ref, index) =>
    block(ref, root, "child_page", { title: paths[index]!.slice(11) }),
  )
  const raw: Record<string, unknown> = {
    [page]: {
      object: "page",
      id: root,
      archived: false,
      in_trash: false,
      last_edited_time: originalTime,
      last_edited_by: { object: "user", id: actor },
      parent: { type: "data_source_id", data_source_id: id(50) },
      properties: {
        Files: { id: "files", type: "files", files: [] },
        References: { id: "references", type: "rich_text", rich_text: referenceRich },
        Publication: {
          id: "publication",
          type: "rich_text",
          rich_text: [rich("original-writing-marker")],
        },
        Updated: { id: "updated", type: "last_edited_time", last_edited_time: originalTime },
      },
    },
    [page + "/properties/references?page_size=100"]: list(
      referenceRich.map((value) => ({
        object: "property_item",
        id: "references",
        type: "rich_text",
        rich_text: value,
      })),
    ),
    [page + "/markdown"]: markdown(root, tags),
    [rootsPath]: list(children),
  }
  for (const [index, ref] of refs.entries()) {
    raw[`v1/pages/${ref}`] = {
      object: "page",
      id: ref,
      parent: { type: "page_id", page_id: root },
      last_edited_time: originalTime,
      properties: { title: { id: "title", type: "title", title: [rich(paths[index]!.slice(11))] } },
    }
    raw[`v1/pages/${ref}/markdown`] = markdown(ref, `Reference ${index}.\n`)
    raw[`v1/blocks/${ref}/children?page_size=100`] = list([
      block(id(300 + index), ref, "paragraph", {
        rich_text: [rich(`Reference ${index}.`)],
        color: "default",
      }),
    ])
  }
  const before: SourceRootCompletionObservation = {
    raw,
    page_ids: [root, ...refs].sort(),
    attachments: [],
    graph_sha256: hash("empty"),
  }
  const model = compileSourceRootBody(authored),
    observedModel = compileSourceRootBody(distorted)
  assert.ok(model && observedModel)
  const plan = {
    input: {
      original_plan_id: `up_${"a".repeat(64)}`,
      member_key: "fixture",
      page_id: root,
      old_operation_id: "p_legacy",
    },
    before,
    effect: {
      kind: "empty_authored_root",
      before_shape: "only_retained_reference_child_pages",
      source_path: "SKILL.md",
      source_sha256: hash(authored),
      source_body_sha256: hash(authored),
      authored_body: authored,
      body_model_sha256: hash(JSON.stringify(model)),
      references: refs.map((ref, index) => ({
        path: paths[index]!,
        page_id: ref,
        tag: tags.split("\n")[index]!,
      })),
      retained_markdown: tags,
      proposed_only: true,
      request: {
        path: page + "/markdown",
        method: "PATCH",
        body: {
          markdown_version: "v2",
          type: "replace_content",
          replace_content: { new_str: authored + tags },
        },
      },
    },
  } satisfies SourceRootFidelityParent
  const observedRaw: Record<string, unknown> = structuredClone(before.raw)
  const observed = { ...before, raw: observedRaw }
  const physical = (span: { text: string; url: string | null; style: typeof styles }) => ({
    ...rich(span.text, span.url),
    annotations: span.style,
  })
  const rendered: Record<string, unknown>[] = []
  function render(value: SourceRootBodyModel["roots"][number], index: number) {
    const blockId = id(100 + index)
    if (value.type === "table") {
      observed.raw[`v1/blocks/${blockId}/children?page_size=100`] = list(
        value.rows.map((cells, row) => ({
          ...block(id(1000 + index * 100 + row), root, "table_row", {
            cells: cells.map((cell) => cell.map(physical)),
          }),
          parent: { type: "block_id", block_id: blockId },
        })),
      )
      return {
        ...block(blockId, root, "table", {
          table_width: value.width,
          has_column_header: true,
          has_row_header: false,
        }),
        has_children: true,
      }
    }
    if (!("rich_text" in value))
      throw new Error("Fixture source unexpectedly added another root type")
    return block(blockId, root, value.type, {
      rich_text: value.rich_text.map(physical),
      color: "default",
      ...(value.type.startsWith("heading_") ? { is_toggleable: false } : {}),
    })
  }
  observedModel.roots.forEach((value, index) => rendered.push(render(value, index)))
  property(observed.raw[rootsPath]).results = [...rendered, ...children]
  property(observed.raw[page]).last_edited_time = time
  property(property(property(observed.raw[page]).properties).Updated).last_edited_time = time
  property(observed.raw[page + "/markdown"]).markdown = distorted + tags
  return { plan, observed: { ...observed, graph_sha256: hash("acknowledged distorted body") } }
}
function step(
  f: ReturnType<typeof fixture>,
  effects: readonly SourceRootFidelityEffect[],
  before: SourceRootCompletionObservation,
  index: number,
) {
  const effect = effects[index]!,
    current = structuredClone(before),
    edited = new Date(Date.parse(time) + (index + 1) * 1000).toISOString()
  replace(current, effect.block_id, {
    ...structuredClone(effect.after_block),
    last_edited_time: edited,
  })
  for (const ancestor of effect.ancestor_ids) find(current, ancestor).last_edited_time = edited
  property(current.raw[page]).last_edited_time = edited
  property(property(property(current.raw[page]).properties).Updated).last_edited_time = edited
  property(current.raw[page + "/markdown"]).markdown =
    sourceRootFidelityBody(f.plan, effects, index + 1) + tags
  return { ...current, graph_sha256: hash(`prefix:${index + 1}`) }
}

test("derives only nine exact source requests and proves every adjacent complete prefix without changing original bytes", () => {
  const f = fixture(),
    frozen = JSON.stringify(f),
    derived = deriveSourceRootFidelity(f.plan, f.observed)
  assert.equal(derived.effects.length, 9)
  assert.deepEqual(
    derived.effects.map((effect) => effect.kind),
    [
      "restore_literal_entity",
      "restore_literal_entity",
      "remove_filename_autolink",
      ...Array(6).fill("restore_literal_plus"),
    ],
  )
  assert.equal(
    derived.effects.reduce(
      (total, effect) => total + (effect.kind === "restore_literal_plus" ? effect.occurrences : 0),
      0,
    ),
    10,
  )
  let before = f.observed
  for (const [index, effect] of derived.effects.entries()) {
    assert.equal(
      sourceRootFidelityBeforeMatches(
        f.plan,
        derived.effects,
        before,
        structuredClone(before),
        index,
      ),
      true,
    )
    const after = step(f, derived.effects, before, index)
    assert.equal(sourceRootFidelityAckMatches(effect, find(after, effect.block_id)), true)
    assert.equal(
      sourceRootFidelityAfterMatches(f.plan, derived.effects, before, after, index),
      true,
    )
    before = after
  }
  assert.equal(sourceRootFidelityBody(f.plan, derived.effects, 9), authored)
  assert.equal(JSON.stringify(f), frozen)
})

test("raw Markdown-only changes, table-cell changes and detached raw graphs cannot become repair authority", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      property(f.observed.raw[page + "/markdown"]).markdown =
        distorted.replace("First", "Foreign") + tags
    },
    (f: ReturnType<typeof fixture>) => {
      property(f.observed.raw[page + "/markdown"]).markdown =
        distorted.replace("Keep `--density`", "Change `--density`") + tags
    },
    (f: ReturnType<typeof fixture>) => {
      property(find(f.observed, id(1100))).table_row = {
        cells: [[rich("Foreign header")], [rich("Exact literal")]],
      }
    },
    (f: ReturnType<typeof fixture>) => {
      f.observed.raw[`v1/blocks/${id(999)}`] = { object: "block", id: id(999) }
    },
  ]) {
    const f = fixture()
    change(f)
    assert.throws(() => deriveSourceRootFidelity(f.plan, f.observed))
  }
})

test("source or physical differences outside the finite literal family cannot be hidden by the nine proposed fields", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      property(find(f.observed, id(100)).heading_1).rich_text = [rich("Foreign heading")]
    },
    (f: ReturnType<typeof fixture>) => {
      property(find(f.observed, id(102)).bulleted_list_item).rich_text = [
        rich("Keep --density in MASTER.md output without a new link.", "https://foreign.test/"),
      ]
    },
    (f: ReturnType<typeof fixture>) => {
      property(f.observed.raw[`v1/pages/${refs[0]}/markdown`]).markdown = "Changed reference"
    },
    (f: ReturnType<typeof fixture>) => {
      property(property(property(f.observed.raw[page]).properties).Publication).rich_text = [
        rich("different marker"),
      ]
    },
  ]) {
    const f = fixture()
    change(f)
    assert.throws(() => deriveSourceRootFidelity(f.plan, f.observed))
  }
})

test("each effect preserves every unrequested row, block, reference, marker, actor and timestamp field", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>, after: SourceRootCompletionObservation) => {
      property(find(after, id(100)).heading_1).rich_text = [rich("Foreign heading")]
    },
    (_f: ReturnType<typeof fixture>, after: SourceRootCompletionObservation) => {
      find(after, id(1102)).last_edited_time = "2026-10-19T00:00:00Z"
    },
    (_f: ReturnType<typeof fixture>, after: SourceRootCompletionObservation) => {
      find(after, id(1101)).last_edited_by = { object: "user", id: id(41) }
    },
    (_f: ReturnType<typeof fixture>, after: SourceRootCompletionObservation) => {
      find(after, id(101)).last_edited_time = "2020-01-01T00:00:00Z"
    },
    (_f: ReturnType<typeof fixture>, after: SourceRootCompletionObservation) => {
      property(after.raw[`v1/pages/${refs[1]}`]).last_edited_time = time
    },
    (_f: ReturnType<typeof fixture>, after: SourceRootCompletionObservation) => {
      property(after.raw[rootsPath]).next_cursor = "unconsumed"
    },
  ]) {
    const f = fixture(),
      effects = deriveSourceRootFidelity(f.plan, f.observed).effects,
      after = step(f, effects, f.observed, 0)
    change(f, after)
    assert.equal(sourceRootFidelityAfterMatches(f.plan, effects, f.observed, after, 0), false)
  }
})

test("a later prefix or nonadjacent subset never proves the selected unknown request", () => {
  const f = fixture(),
    effects = deriveSourceRootFidelity(f.plan, f.observed).effects
  const first = step(f, effects, f.observed, 0),
    second = step(f, effects, first, 1)
  assert.equal(sourceRootFidelityAfterMatches(f.plan, effects, f.observed, second, 0), false)
  const subset = structuredClone(f.observed)
  replace(subset, effects[3]!.block_id, effects[3]!.after_block)
  assert.equal(sourceRootFidelityStageMatches(f.plan, effects, subset, 0), false)
  assert.equal(sourceRootFidelityAfterMatches(f.plan, effects, f.observed, subset, 0), false)
})

test("ACK identity, complete requested field, owner and nondecreasing edit time are independently required", () => {
  const f = fixture(),
    effect = deriveSourceRootFidelity(f.plan, f.observed).effects[0]!
  assert.equal(sourceRootFidelityAckMatches(effect, effect.after_block), true)
  for (const response of [
    { ...effect.after_block, id: id(999) },
    { ...effect.after_block, last_edited_time: "invalid" },
    { ...effect.after_block, last_edited_time: originalTime },
    { ...effect.after_block, parent: { type: "page_id", page_id: root } },
    { ...effect.after_block, table_row: { cells: [] } },
    effect.before_block,
  ])
    assert.equal(sourceRootFidelityAckMatches(effect, response), false)
})

test("missing or invalid affected BEFORE timestamps refuse before an effect can be planned", () => {
  for (const selected of [id(1101), id(101)]) {
    const f = fixture()
    find(f.observed, selected).last_edited_time = "invalid"
    assert.throws(() => deriveSourceRootFidelity(f.plan, f.observed))
  }
})
