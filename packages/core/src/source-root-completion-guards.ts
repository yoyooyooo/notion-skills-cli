import { isDeepStrictEqual } from "node:util"
import { fail, property, text } from "./model.ts"
import { pageId } from "./ref.ts"
import { childPageTags } from "./references.ts"
import { decodeReferenceLinks } from "./reference-links.ts"
import { contentAdoptionPropertyComparison } from "./publication-content-adoption-metadata.ts"
import {
  compileSourceRootBody,
  sourceRootBodyMatches,
  type PhysicalNode,
} from "./source-root-completion-physical.ts"
import type {
  SourceRootCompletionObservation,
  SourceRootCompletionPlan,
} from "./upstream-source-root-completion-model.ts"

const equal = isDeepStrictEqual
const refused = (message: string) => fail("SOURCE_ROOT_COMPLETION_REFUSED", message)
const query = (base: string, cursor?: string) =>
  `${base}?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`
const uuid = (value: unknown): value is string =>
  typeof value === "string" && pageId(value) === value
function transport(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const raw = property(value)
  if (raw.request_id !== undefined && (typeof raw.request_id !== "string" || !raw.request_id))
    return
  const { request_id: _request, ...rest } = raw
  return rest
}
function sameTransport(left: unknown, right: unknown) {
  const a = transport(left),
    b = transport(right)
  return (
    a !== undefined &&
    b !== undefined &&
    (property(left).request_id === undefined) === (property(right).request_id === undefined) &&
    equal(a, b)
  )
}
const completeMarkdown = (
  value: unknown,
  id: string,
): value is Record<string, unknown> & { markdown: string } => {
  const raw = transport(value)
  return (
    !!raw &&
    raw.id === id &&
    raw.object === "page_markdown" &&
    typeof raw.markdown === "string" &&
    raw.truncated === false &&
    Array.isArray(raw.unknown_block_ids) &&
    raw.unknown_block_ids.length === 0
  )
}

export interface RootCompletionReference {
  readonly path: string
  readonly page_id: string
  readonly tag: string
}
export interface RootCompletionInventory {
  readonly references: readonly RootCompletionReference[]
  readonly root_nodes: readonly PhysicalNode[]
  readonly ordinary_nodes: readonly PhysicalNode[]
  readonly retained_nodes: readonly PhysicalNode[]
  readonly all_ids: ReadonlySet<string>
  readonly root_tree_paths: ReadonlySet<string>
  readonly markdown: string
}

/** Reconstruct all raw paths, not just the reader's projected roots. Every
 * reference, cursor and ordinary descendant must be consumed exactly once. */
export function sourceRootCompletionInventory(
  root: string,
  observed: SourceRootCompletionObservation,
): RootCompletionInventory {
  if (
    !uuid(root) ||
    observed.attachments.length ||
    observed.page_ids.length < 2 ||
    observed.page_ids.length > 100 ||
    !equal(observed.page_ids, [...new Set(observed.page_ids)].sort()) ||
    !observed.page_ids.includes(root)
  )
    throw refused(
      "Completion requires one closed root with retained references and no attachments.",
    )
  const raw = observed.raw,
    consumed = new Set<string>(),
    rootTreePaths = new Set<string>()
  const read = (path: string) => {
    if (consumed.has(path) || !Object.hasOwn(raw, path) || transport(raw[path]) === undefined)
      throw refused("A complete raw graph path is missing, repeated or invalid.")
    consumed.add(path)
    return property(raw[path])
  }
  const rootPath = `v1/pages/${root}`,
    metadata = read(rootPath)
  const files = property(property(metadata.properties).Files)
  if (
    metadata.id !== root ||
    metadata.object !== "page" ||
    metadata.archived === true ||
    metadata.is_archived === true ||
    metadata.in_trash === true ||
    files.type !== "files" ||
    !Array.isArray(files.files) ||
    files.files.length
  )
    throw refused("The original root or its exact empty Files value is unavailable.")
  const referenceField = property(property(metadata.properties).References)
  if (
    referenceField.type !== "rich_text" ||
    typeof referenceField.id !== "string" ||
    !referenceField.id ||
    /[/?#&\\\s]/.test(referenceField.id) ||
    !Array.isArray(referenceField.rich_text)
  )
    throw refused("The original complete References identity is unavailable.")
  const entries: unknown[] = [],
    referenceCursors = new Set<string>()
  let referenceCursor: string | undefined,
    referenceComplete = false
  for (let count = 0; count < 1000; count++) {
    const response = read(query(`${rootPath}/properties/${referenceField.id}`, referenceCursor))
    if (response.object === "property_item") {
      if (
        count !== 0 ||
        response.id !== referenceField.id ||
        response.type !== "rich_text" ||
        response.has_more === true ||
        response.next_cursor != null
      )
        throw refused("A References item is incomplete.")
      entries.push(response.rich_text)
      referenceComplete = true
      break
    }
    if (
      response.object !== "list" ||
      !Array.isArray(response.results) ||
      typeof response.has_more !== "boolean" ||
      response.results.some(
        (value) =>
          property(value).object !== "property_item" ||
          property(value).type !== "rich_text" ||
          property(value).id !== referenceField.id,
      )
    )
      throw refused("The complete References item chain is invalid.")
    entries.push(...response.results.map((value) => property(value).rich_text))
    if (!response.has_more) {
      if (response.next_cursor != null) throw refused("The References terminal cursor changed.")
      referenceComplete = true
      break
    }
    if (
      typeof response.next_cursor !== "string" ||
      !response.next_cursor ||
      referenceCursors.has(response.next_cursor)
    )
      throw refused("A References cursor is missing or repeated.")
    referenceCursor = response.next_cursor
    referenceCursors.add(referenceCursor)
  }
  const links = decodeReferenceLinks({ rich_text: entries }, { readback: true })
  if (
    !referenceComplete ||
    !links ||
    !links.bindings.length ||
    !equal(referenceField.rich_text, entries.slice(0, referenceField.rich_text.length)) ||
    !equal(observed.page_ids, [root, ...links.bindings.map((link) => link.id)].sort()) ||
    new Set(links.bindings.map((link) => link.id)).size !== links.bindings.length
  )
    throw refused("The complete reference paths, page IDs and property value disagree.")
  const pages = new Set(observed.page_ids),
    allIds = new Set(observed.page_ids),
    childIds = new Set<string>()
  let ordinaryCount = 0
  function walk(owner: string, page: string, depth: number): PhysicalNode[] {
    if (depth > 32) throw refused("The completion graph is too deep.")
    const nodes: PhysicalNode[] = [],
      cursors = new Set<string>()
    let cursor: string | undefined
    for (let count = 0; count < 1000; count++) {
      const path = query(`v1/blocks/${owner}/children`, cursor),
        response = read(path)
      if (page === root) rootTreePaths.add(path)
      if (
        response.object !== "list" ||
        !Array.isArray(response.results) ||
        typeof response.has_more !== "boolean"
      )
        throw refused("The physical inventory is incomplete.")
      for (const value of response.results) {
        const block = property(value),
          parent = property(block.parent)
        if (
          !uuid(block.id) ||
          block.object !== "block" ||
          typeof block.type !== "string" ||
          typeof block.has_children !== "boolean" ||
          block.archived === true ||
          block.is_archived === true ||
          block.in_trash === true ||
          parent.type !== (owner === page ? "page_id" : "block_id") ||
          parent[String(parent.type)] !== owner ||
          ["child_database", "synced_block"].includes(block.type)
        )
          throw refused("A physical block leaves or contradicts its complete owner graph.")
        if (block.type === "child_page") {
          const link = links!.bindings.find((item) => item.id === block.id)
          if (
            owner !== root ||
            page !== root ||
            !pages.has(block.id) ||
            childIds.has(block.id) ||
            !link ||
            ![
              link.path,
              ...(link.path.startsWith("references/")
                ? [link.path.slice("references/".length)]
                : []),
            ].includes(String(property(block.child_page).title))
          )
            throw refused("A retained child page is foreign, repeated or retargeted.")
          childIds.add(block.id)
          nodes.push({ raw: block, children: [] })
        } else {
          if (allIds.has(block.id) || ++ordinaryCount > 4096)
            throw refused("The ordinary inventory repeats an ID or exceeds its bound.")
          allIds.add(block.id)
          const children = block.has_children ? walk(block.id, page, depth + 1) : []
          if (block.has_children && children.length === 0)
            throw refused("A parent advertises an empty child inventory.")
          nodes.push({ raw: block, children })
        }
      }
      if (!response.has_more) {
        if (response.next_cursor != null) throw refused("A terminal block cursor is invalid.")
        return nodes
      }
      if (
        typeof response.next_cursor !== "string" ||
        !response.next_cursor ||
        cursors.has(response.next_cursor)
      )
        throw refused("A block cursor is missing or repeated.")
      cursor = response.next_cursor
      cursors.add(cursor)
    }
    throw refused("The physical inventory did not terminate.")
  }
  const rootNodes = walk(root, root, 0)
  if (childIds.size !== links.bindings.length)
    throw refused("A retained reference is missing from the root.")
  const rootMarkdown = read(rootPath + "/markdown")
  if (!completeMarkdown(rootMarkdown, root))
    throw refused("The complete root Markdown is unavailable.")
  const retained = rootNodes.filter((node) => node.raw.type === "child_page")
  const tags = childPageTags(rootMarkdown.markdown)
  if (tags.length !== retained.length) throw refused("The complete retained page tag set changed.")
  const references = retained.map((node, index): RootCompletionReference => {
    const link = links.bindings.find((item) => item.id === node.raw.id)!,
      tag = tags[index]!
    const match = /^<page url="([^"]+)">([^<>]*)<\/page>$/.exec(tag)
    if (!match || pageId(match[1]!) !== link.id || match[2] !== property(node.raw.child_page).title)
      throw refused("The exact ordered child tags disagree with their physical pages.")
    return { path: link.path, page_id: link.id, tag }
  })
  for (const link of links.bindings) {
    const path = `v1/pages/${link.id}`,
      page = read(path),
      parent = property(page.parent)
    const title = text(
      Object.values(property(page.properties))
        .map(property)
        .find((field) => field.type === "title")?.title,
    )
    if (
      page.id !== link.id ||
      page.object !== "page" ||
      page.archived === true ||
      page.is_archived === true ||
      page.in_trash === true ||
      parent.type !== "page_id" ||
      parent.page_id !== root ||
      ![
        link.path,
        ...(link.path.startsWith("references/") ? [link.path.slice("references/".length)] : []),
      ].includes(title)
    )
      throw refused("A retained reference metadata identity changed.")
    const markdown = read(path + "/markdown")
    if (!completeMarkdown(markdown, link.id))
      throw refused("A retained reference Markdown is incomplete.")
    walk(link.id, link.id, 0)
  }
  if (!equal([...consumed].sort(), Object.keys(raw).sort()))
    throw refused("The capture contains an unconsumed or foreign raw resource.")
  const ordinary = rootNodes.filter((node) => node.raw.type !== "child_page")
  if (
    !equal(
      rootNodes.map((node) => node.raw.id),
      [...ordinary, ...retained].map((node) => node.raw.id),
    )
  )
    throw refused("Authored root blocks must precede the exact retained child-page suffix.")
  return {
    references,
    root_nodes: rootNodes,
    ordinary_nodes: ordinary,
    retained_nodes: retained,
    all_ids: allIds,
    root_tree_paths: rootTreePaths,
    markdown: rootMarkdown.markdown,
  }
}

export function sourceRootCompletionExactBefore(
  before: SourceRootCompletionObservation,
  current: SourceRootCompletionObservation,
) {
  return (
    equal(before.page_ids, current.page_ids) &&
    equal(before.attachments, current.attachments) &&
    before.graph_sha256 === current.graph_sha256 &&
    equal(Object.keys(before.raw).sort(), Object.keys(current.raw).sort()) &&
    Object.keys(before.raw).every((path) => sameTransport(before.raw[path], current.raw[path]))
  )
}

type BoundPlan = Pick<SourceRootCompletionPlan, "input" | "before" | "effect">
function comparableRoot(value: unknown) {
  const raw = transport(value)
  if (!raw) return
  const { last_edited_time: _time, ...rest } = raw
  return {
    ...rest,
    properties: Object.fromEntries(
      Object.entries(property(raw.properties)).map(([name, field]) => [
        name,
        contentAdoptionPropertyComparison(field, raw.last_edited_time),
      ]),
    ),
  }
}
function advancedTime(before: unknown, after: unknown) {
  return (
    typeof before === "string" &&
    typeof after === "string" &&
    Number.isFinite(Date.parse(before)) &&
    Number.isFinite(Date.parse(after)) &&
    Date.parse(after) >= Date.parse(before)
  )
}
function listEnvelope(raw: unknown) {
  const value = transport(raw)
  if (!value) return
  const { results: _results, has_more: _more, next_cursor: _cursor, ...rest } = value
  return rest
}

/** This relation authorizes no success on its own. Normal strict CA body proof
 * and a second stable complete observation are mandatory before committing. */
export function sourceRootCompletionAfterMatches(
  plan: BoundPlan,
  observed: SourceRootCompletionObservation,
) {
  try {
    const before = sourceRootCompletionInventory(plan.input.page_id, plan.before)
    const after = sourceRootCompletionInventory(plan.input.page_id, observed)
    if (
      before.ordinary_nodes.length ||
      !after.ordinary_nodes.length ||
      !equal(before.references, plan.effect.references) ||
      !equal(before.references, after.references) ||
      !equal(before.retained_nodes, after.retained_nodes) ||
      !equal(plan.before.page_ids, observed.page_ids) ||
      !equal(plan.before.attachments, observed.attachments)
    )
      return false
    const compiled = compileSourceRootBody(plan.effect.authored_body)
    if (!compiled || !sourceRootBodyMatches(compiled, after.ordinary_nodes)) return false
    const oldIds = before.all_ids
    const newIds: string[] = []
    const newNodes = (nodes: readonly PhysicalNode[]) => {
      for (const node of nodes) {
        if (typeof node.raw.id !== "string" || oldIds.has(node.raw.id)) return false
        newIds.push(node.raw.id)
        if (!newNodes(node.children)) return false
      }
      return true
    }
    if (!newNodes(after.ordinary_nodes) || !newIds.length) return false
    const root = `v1/pages/${plan.input.page_id}`,
      oldPage = property(plan.before.raw[root]),
      page = property(observed.raw[root])
    if (
      !advancedTime(oldPage.last_edited_time, page.last_edited_time) ||
      !equal(comparableRoot(oldPage), comparableRoot(page)) ||
      (oldPage.request_id === undefined) !== (page.request_id === undefined)
    )
      return false
    const markdownPath = root + "/markdown",
      oldMarkdown = transport(plan.before.raw[markdownPath]),
      markdown = transport(observed.raw[markdownPath])
    if (!oldMarkdown || !markdown) return false
    delete oldMarkdown.markdown
    delete markdown.markdown
    if (
      !equal(oldMarkdown, markdown) ||
      (property(plan.before.raw[markdownPath]).request_id === undefined) !==
        (property(observed.raw[markdownPath]).request_id === undefined)
    )
      return false
    // The exact original tags remain the only terminal page resources. Body
    // serialization may differ, but the independent compiler consumes all blocks.
    const firstTag = after.markdown.indexOf(after.references[0]!.tag)
    if (
      firstTag < 0 ||
      !/^[\t\r\n ]*$/.test(
        after.markdown.slice(firstTag).replace(/<page url="[^"]+">[^<>]*<\/page>/g, ""),
      )
    )
      return false
    const unchanged = Object.keys(plan.before.raw).filter(
      (path) => path !== root && path !== markdownPath && !before.root_tree_paths.has(path),
    )
    const currentUnchanged = Object.keys(observed.raw).filter(
      (path) => path !== root && path !== markdownPath && !after.root_tree_paths.has(path),
    )
    if (
      !equal(unchanged.sort(), currentUnchanged.sort()) ||
      unchanged.some((path) => !sameTransport(plan.before.raw[path], observed.raw[path]))
    )
      return false
    const oldEnvelope = listEnvelope(
      plan.before.raw[query(`v1/blocks/${plan.input.page_id}/children`)],
    )
    for (const path of after.root_tree_paths) {
      // New nested lists have the same complete list response shape, while their
      // rows and cursors are independently consumed by the closed graph walk.
      if (!equal(oldEnvelope, listEnvelope(observed.raw[path]))) return false
    }
    return true
  } catch {
    return false
  }
}

/** Target identity and complete response shape only: even a real ACK is never
 * substituted for complete physical, body, ownership and stable-read evidence. */
export function sourceRootCompletionAckMatches(plan: BoundPlan, response: unknown) {
  if (!completeMarkdown(response, plan.input.page_id)) return false
  const before = transport(plan.before.raw[`v1/pages/${plan.input.page_id}/markdown`]),
    current = transport(response)
  if (!before || !current) return false
  delete before.markdown
  delete current.markdown
  return equal(before, current)
}
