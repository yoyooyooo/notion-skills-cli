import { isDeepStrictEqual } from "node:util"
import {
  creationMarkerProof,
  creationProofFromBody,
  creationProofMatchesIntent,
} from "./publication-create-identity.ts"
import type { Receipt } from "./publication-model.ts"
import { decodeReferenceLinks, type ReferenceBinding } from "./reference-links.ts"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function keys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every((key) => allowed.includes(key))
}

// Persisted JSON omits undefined fields. Keep every defined metadata value,
// including the server revision and properties unrelated to this checkpoint.
function same(left: unknown, right: unknown) {
  try {
    const a = JSON.stringify(left),
      b = JSON.stringify(right)
    return (
      typeof a === "string" &&
      typeof b === "string" &&
      isDeepStrictEqual(JSON.parse(a), JSON.parse(b))
    )
  } catch {
    return false
  }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const hash = /^[a-f0-9]{64}$/
const filePath = (path: string) =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !/[\r\n\0\\]/.test(path) &&
  path.split("/").every((part) => part && part !== "." && part !== "..")
const referencePath = (path: string) => filePath(path) && /^references\/.+\.md$/i.test(path)
const encoded = (value: string) => {
  try {
    return encodeURIComponent(value)
  } catch {
    return undefined
  }
}

const plainAnnotations = (value: unknown) =>
  value === undefined ||
  (keys(value, ["bold", "italic", "strikethrough", "underline", "code", "color"]) &&
    Object.entries(value).every(([key, child]) =>
      key === "color" ? child === "default" : child === false,
    ))

// Original requests may omit type; retrieved title items must retain their
// explicit response discriminator. Neither grammar permits links or styling.
function title(values: unknown, request: boolean) {
  if (!Array.isArray(values) || values.length === 0) return undefined
  let result = ""
  for (const item of values) {
    if (
      !keys(
        item,
        request
          ? ["type", "text", "annotations"]
          : ["type", "text", "annotations", "plain_text", "href"],
      ) ||
      !(item.type === "text" || (request && item.type === undefined)) ||
      !keys(item.text, ["content", "link"]) ||
      typeof item.text.content !== "string" ||
      item.text.link != null ||
      item.href != null ||
      !plainAnnotations(item.annotations) ||
      (item.plain_text !== undefined && item.plain_text !== item.text.content)
    )
      return undefined
    result += item.text.content
  }
  return result
}

function references(value: unknown) {
  return decodeReferenceLinks({ rich_text: value }, { readback: true })?.bindings
}

function metadataReferences(value: unknown, root: string, source: string) {
  if (
    !record(value) ||
    value.id !== root ||
    value.archived !== false ||
    value.in_trash !== false ||
    typeof value.last_edited_time !== "string" ||
    !value.last_edited_time ||
    !record(value.parent) ||
    value.parent.type !== "data_source_id" ||
    value.parent.data_source_id !== source ||
    !record(value.properties)
  )
    return undefined
  const field = value.properties.References
  if (
    !keys(field, ["id", "type", "rich_text", "has_more", "next_cursor"]) ||
    field.type !== "rich_text" ||
    typeof field.id !== "string" ||
    !field.id ||
    (field.has_more !== undefined && field.has_more !== false) ||
    (field.next_cursor !== undefined && field.next_cursor !== null) ||
    Object.values(value.properties).some((item) => !record(item) || item.has_more === true)
  )
    return undefined
  const entries = references(field.rich_text)
  return entries && { id: field.id, entries, properties: value.properties }
}

interface ChainPage<T> {
  readonly path: string
  readonly response: Readonly<Record<string, unknown>>
  readonly items: readonly T[]
}

function completeChain<T>(
  values: Readonly<Record<string, unknown>>,
  base: string,
  decode: (value: Record<string, unknown>, first: boolean) => readonly T[] | undefined,
): { readonly items: readonly T[]; readonly pages: readonly ChainPage<T>[] } | undefined {
  const candidates = Object.keys(values).filter(
    (path) => path === base || path.startsWith(base + "&start_cursor="),
  )
  const visited = new Set<string>(),
    items: T[] = [],
    pages: ChainPage<T>[] = []
  let path = base
  for (;;) {
    if (visited.has(path) || !Object.hasOwn(values, path)) return undefined
    visited.add(path)
    const response = values[path]
    if (!record(response)) return undefined
    const decoded = decode(response, path === base)
    if (!decoded) return undefined
    items.push(...decoded)
    pages.push({ path, response, items: decoded })
    if (response.has_more !== true) {
      if (response.next_cursor !== null && response.next_cursor !== undefined) return undefined
      return candidates.length === visited.size && candidates.every((key) => visited.has(key))
        ? { items, pages }
        : undefined
    }
    if (typeof response.next_cursor !== "string" || !response.next_cursor) return undefined
    const cursor = encoded(response.next_cursor)
    if (cursor === undefined) return undefined
    path = base + "&start_cursor=" + cursor
  }
}

const ordinaryTypes = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
  "column",
  "column_list",
  "divider",
  "breadcrumb",
  "table_of_contents",
  "table",
  "table_row",
  "image",
  "video",
  "audio",
  "file",
  "pdf",
  "bookmark",
  "embed",
  "equation",
  "link_preview",
  "link_to_page",
  "synced_block",
  "template",
])

interface Child extends ReferenceBinding {
  readonly index: number
  readonly title: string
}

/** Proves only an absent References property-items checkpoint for a fenced
 * original create. The caller must already prove root publication authority and
 * every frozen source byte against intendedHash, then still prove all original
 * ACKs, whole bodies, source attachment and guards before lifting the fence.
 *
 * raw contains exclusively actual responses captured in the current read phase;
 * metadataByPage contains those page responses passed through metadata(). The
 * caller brackets the added property-items cursor chain with exact full root
 * metadata reads in that phase. Neither input may be populated from guards.
 * This function never changes a guard, receipt, current response or journal.
 */
export function hasOriginalAcknowledgedReferencesCheckpoint(
  receipt: Receipt,
  pagePath: string,
  raw: Readonly<Record<string, unknown>>,
  metadataByPage: Readonly<Record<string, unknown>>,
  intendedHash: string,
): boolean {
  const root = receipt.page_id,
    rootPath = `v1/pages/${root}`
  if (
    receipt.operation !== "create" ||
    receipt.portable.kind !== "skill" ||
    receipt.conflict !== true ||
    receipt.owner !== undefined ||
    typeof root !== "string" ||
    !uuid.test(root) ||
    !receipt.data_source_id ||
    pagePath !== rootPath ||
    !hash.test(intendedHash) ||
    receipt.intents.length === 0 ||
    receipt.intents.some((intent) => {
      const response = record(intent.response) ? intent.response : undefined
      return (
        intent.status !== "completed" ||
        intent.recovery !== undefined ||
        intent.typed_links?.state === "pending" ||
        response?.superseded_by !== undefined ||
        response?.replayed_by_intent !== undefined ||
        response?.recovery !== undefined
      )
    })
  )
    return false
  const files = receipt.portable.files
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some((file) => !filePath(file.path) || !hash.test(file.sha256)) ||
    files.filter((file) => file.path === receipt.portable.main).length !== 1
  )
    return false
  const sourceReferences = files.filter(
    (file) => file.path !== receipt.portable.main && referencePath(file.path),
  )
  if (!sourceReferences.length) return false
  const retained = receipt.guards[rootPath],
    current = metadataByPage[rootPath]
  const originalField = metadataReferences(retained, root, receipt.data_source_id)
  const currentField = metadataReferences(current, root, receipt.data_source_id)
  if (
    !Object.hasOwn(raw, rootPath) ||
    !originalField ||
    !currentField ||
    !same(retained, current) ||
    !same(originalField, currentField)
  )
    return false
  const encodedId = encoded(originalField.id)
  if (encodedId === undefined) return false
  const propertyBases = [originalField.id, encodedId].map((id) => `${rootPath}/properties/${id}`)
  if (
    Object.keys(receipt.guards).some((path) =>
      propertyBases.some((base) => path === base || path.startsWith(base + "?")),
    )
  )
    return false

  const roots: number[] = [],
    children: Child[] = []
  for (const [index, intent] of receipt.intents.entries()) {
    if (intent.path !== "v1/pages") continue
    const body = intent.body,
      response = intent.response
    if (
      intent.method !== "POST" ||
      !keys(body, ["parent", "properties", "children"]) ||
      !record(response) ||
      typeof response.id !== "string" ||
      !uuid.test(response.id) ||
      !record(body.parent)
    )
      return false
    const id = response.id
    if (id === root) {
      if (body.parent.data_source_id !== receipt.data_source_id) return false
      roots.push(index)
      continue
    }
    if (!keys(body.properties, ["title"]) || !record(body.properties.title)) return false
    const childTitle = title(body.properties.title.title, true)
    if (!childTitle) return false
    const path: string = `references/${childTitle}`
    const childPagePath: string = `v1/pages/${id}`
    const page: unknown = metadataByPage[childPagePath]
    if (!Object.hasOwn(raw, childPagePath) || !record(page) || !record(page.properties))
      return false
    const fields = Object.values(page.properties)
    const titles = fields.filter((field) => record(field) && field.type === "title")
    const titleField = titles[0]
    if (
      body.parent.type !== "page_id" ||
      body.parent.page_id !== root ||
      !sourceReferences.some((file) => file.path === path) ||
      children.some((child) => child.id === id || child.path === path) ||
      page.id !== id ||
      !record(page.parent) ||
      page.parent.type !== "page_id" ||
      page.parent.page_id !== root ||
      page.archived !== false ||
      page.in_trash !== false ||
      typeof page.last_edited_time !== "string" ||
      !page.last_edited_time ||
      titles.length !== 1 ||
      !record(titleField) ||
      title(titleField.title, false) !== childTitle ||
      !same(receipt.guards[childPagePath], page) ||
      fields.some((field) => !record(field) || field.has_more === true)
    )
      return false
    const beforeMarkdown = receipt.guards[childPagePath + "/markdown"]
    const nowMarkdown = raw[childPagePath + "/markdown"]
    if (
      typeof beforeMarkdown !== "string" ||
      !record(nowMarkdown) ||
      nowMarkdown.truncated !== false ||
      !Array.isArray(nowMarkdown.unknown_block_ids) ||
      nowMarkdown.unknown_block_ids.length !== 0 ||
      typeof nowMarkdown.markdown !== "string"
    )
      return false
    try {
      const proof = creationProofFromBody(body)
      if (
        !proof ||
        proof.role !== "reference" ||
        !creationProofMatchesIntent(proof, receipt, index) ||
        proof.intended_hash !== intendedHash ||
        !same(creationMarkerProof(beforeMarkdown), proof) ||
        !same(creationMarkerProof(nowMarkdown.markdown), proof)
      )
        return false
    } catch {
      return false
    }
    children.push({
      index,
      id,
      title: childTitle,
      path,
      url: `https://www.notion.so/${id.replaceAll("-", "")}`,
    })
  }
  const rootIndex = roots[0]
  if (
    roots.length !== 1 ||
    rootIndex === undefined ||
    children.length !== sourceReferences.length ||
    children.some((child) => child.index <= rootIndex) ||
    sourceReferences.some((file) => !children.some((child) => child.path === file.path))
  )
    return false
  const wanted = children.map(({ path, id, url }) => ({ path, id, url }))
  if (!same(originalField.entries, wanted)) return false

  let finalAcknowledged = false
  for (const [index, intent] of receipt.intents.entries()) {
    const body = intent.body
    if (!record(body) || !record(body.properties)) continue
    const properties = body.properties
    const fields = Object.keys(properties).filter(
      (key) => key === "References" || key === originalField.id,
    )
    if (!fields.length) continue
    const field = fields[0]
    if (fields.length !== 1 || field === undefined || !keys(properties[field], ["rich_text"]))
      return false
    const entries = decodeReferenceLinks(properties[field], { readback: true })?.bindings
    const response = intent.response
    if (intent.path === "v1/pages" && record(response) && response.id === root) {
      if (!entries || entries.length !== 0) return false
      continue
    }
    const prefix = children
      .filter((child) => child.index < index)
      .map(({ path, id, url }) => ({ path, id, url }))
    if (
      intent.method !== "PATCH" ||
      intent.path !== rootPath ||
      !record(response) ||
      response.id !== root ||
      Object.keys(body).length !== 1 ||
      index <= rootIndex ||
      Object.keys(properties).some(
        (key) =>
          Object.entries(originalField.properties).filter(
            ([name, value]) => name === key || (record(value) && value.id === key),
          ).length !== 1,
      ) ||
      !entries ||
      !same(entries, prefix)
    )
      return false
    if (same(entries, wanted)) finalAcknowledged = true
    // Other known fields in a metadata ACK remain obligations of the caller's
    // complete ACK proof. This checkpoint supplies no authority for their values.
  }
  if (!finalAcknowledged) return false

  const propertyBase = `${rootPath}/properties/${originalField.id}?page_size=100`
  const propertyChain = completeChain(raw, propertyBase, (response, first) => {
    if (response.object === "property_item")
      return first &&
        response.id === originalField.id &&
        response.type === "rich_text" &&
        response.has_more !== true &&
        record(response.rich_text)
        ? [response.rich_text]
        : undefined
    if (
      response.object !== "list" ||
      response.type !== "property_item" ||
      !Array.isArray(response.results) ||
      typeof response.has_more !== "boolean"
    )
      return undefined
    const result: Record<string, unknown>[] = []
    for (const item of response.results) {
      if (
        !record(item) ||
        item.object !== "property_item" ||
        item.id !== originalField.id ||
        item.type !== "rich_text" ||
        !record(item.rich_text)
      )
        return undefined
      result.push(item.rich_text)
    }
    return result
  })
  if (!propertyChain || !same(references(propertyChain.items), wanted)) return false

  const inventoryBase = `v1/blocks/${root}/children?page_size=100`
  const originalChain = completeChain(receipt.guards, inventoryBase, (response) =>
    Array.isArray(response.results) &&
    typeof response.has_more === "boolean" &&
    response.results.every(
      (item) =>
        record(item) &&
        item.type === "child_page" &&
        record(item.child_page) &&
        typeof item.child_page.title === "string",
    )
      ? response.results
      : undefined,
  )
  const expectedChildren = children.map((child) => ({
    id: child.id,
    type: "child_page",
    child_page: { title: child.title },
  }))
  if (!originalChain || !same(originalChain.items, expectedChildren)) return false
  const seenBlocks = new Set<string>()
  const currentChain = completeChain(raw, inventoryBase, (response) => {
    if (!Array.isArray(response.results) || typeof response.has_more !== "boolean") return undefined
    const result: Array<{ id: string; type: string; child_page: unknown }> = []
    for (const block of response.results) {
      if (
        !record(block) ||
        typeof block.id !== "string" ||
        !uuid.test(block.id) ||
        seenBlocks.has(block.id) ||
        !record(block.parent) ||
        block.parent.type !== "page_id" ||
        block.parent.page_id !== root ||
        block.archived === true ||
        block.in_trash === true ||
        typeof block.has_children !== "boolean" ||
        typeof block.type !== "string" ||
        !record(block[block.type]) ||
        (block.type !== "child_page" && !ordinaryTypes.has(block.type))
      )
        return undefined
      seenBlocks.add(block.id)
      if (block.type === "child_page")
        result.push({ id: block.id, type: block.type, child_page: block.child_page })
    }
    return result
  })
  return (
    currentChain !== undefined &&
    same(currentChain.items, expectedChildren) &&
    currentChain.pages.length === originalChain.pages.length &&
    currentChain.pages.every((page, index) => {
      const original = originalChain.pages[index]
      return (
        original !== undefined &&
        page.path === original.path &&
        same(
          {
            results: page.items,
            has_more: page.response.has_more,
            next_cursor: page.response.next_cursor,
          },
          original.response,
        )
      )
    })
  )
}
