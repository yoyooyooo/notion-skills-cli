import { isDeepStrictEqual } from "node:util"
import type { Receipt } from "./publication-model.ts"

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

// Current metadata may contain undefined fields that persisted JSON omits.
// Compare the same JSON values without dropping any defined metadata field.
function sameJson(left: unknown, right: unknown) {
  try {
    const a = JSON.stringify(left)
    const b = JSON.stringify(right)
    return (
      typeof a === "string" &&
      typeof b === "string" &&
      isDeepStrictEqual(JSON.parse(a), JSON.parse(b))
    )
  } catch {
    return false
  }
}

function emptyRichText(value: unknown, id?: string) {
  const field = record(value)
  return (
    field !== undefined &&
    field.type === "rich_text" &&
    typeof field.id === "string" &&
    field.id.length > 0 &&
    (id === undefined || field.id === id) &&
    Array.isArray(field.rich_text) &&
    field.rich_text.length === 0 &&
    (field.has_more === undefined || field.has_more === false) &&
    (field.next_cursor === undefined || field.next_cursor === null)
  )
}

const encoded = (value: string) => {
  try {
    return encodeURIComponent(value)
  } catch {
    return undefined
  }
}

// Unknown block envelopes cannot establish that a root is ordinary content.
const ordinaryRootTypes = new Set([
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

/** A narrow substitute for an absent property-items guard, never a publication
 * completion proof. The caller must still prove the original marker, every
 * frozen source byte and acknowledged effect, the whole body, and all guards. */
export function hasOriginalEmptyReferencesCheckpoint(
  receipt: Receipt,
  pagePath: string,
  currentMetadata: unknown,
  raw: Readonly<Record<string, unknown>>,
) {
  const rootPath = `v1/pages/${receipt.page_id}`
  if (
    receipt.operation !== "create" ||
    receipt.portable.kind !== "skill" ||
    receipt.conflict !== true ||
    receipt.owner !== undefined ||
    !receipt.page_id ||
    !receipt.data_source_id ||
    pagePath !== rootPath ||
    receipt.intents.length === 0 ||
    receipt.intents.some((intent) => intent.status !== "completed") ||
    receipt.portable.files.filter((file) => file.path === receipt.portable.main).length !== 1 ||
    receipt.portable.files.some(
      (file) => file.path !== receipt.portable.main && /^references\/.*\.md$/i.test(file.path),
    )
  )
    return false
  const before = record(receipt.guards[rootPath])
  const current = record(currentMetadata)
  const originalFields = record(before?.properties)
  const currentFields = record(current?.properties)
  const fieldId = record(originalFields?.References)?.id
  if (
    before?.id !== receipt.page_id ||
    current?.id !== receipt.page_id ||
    record(before?.parent)?.data_source_id !== receipt.data_source_id ||
    !originalFields ||
    !currentFields ||
    !sameJson(before, current) ||
    typeof fieldId !== "string" ||
    !emptyRichText(originalFields.References) ||
    !emptyRichText(currentFields.References, fieldId)
  )
    return false
  const encodedId = encoded(fieldId)
  if (encodedId === undefined) return false
  const propertyBases = [fieldId, encodedId].map((id) => `${rootPath}/properties/${id}`)
  if (
    Object.keys(receipt.guards).some((path) =>
      propertyBases.some((base) => path === base || path.startsWith(base + "?")),
    )
  )
    return false
  let rootCreates = 0
  for (const intent of receipt.intents) {
    const body = record(intent.body)
    if (intent.path === "v1/pages") {
      if (
        intent.method !== "POST" ||
        record(intent.response)?.id !== receipt.page_id ||
        record(body?.parent)?.data_source_id !== receipt.data_source_id
      )
        return false
      rootCreates++
    } else if (
      intent.path.startsWith("v1/pages/") &&
      intent.path !== rootPath &&
      intent.path !== rootPath + "/markdown"
    )
      return false
    for (const [key, value] of Object.entries(record(body?.properties) ?? {})) {
      if (key !== "References" && key !== fieldId) continue
      const request = record(value)
      if (
        !request ||
        Object.keys(request).length !== 1 ||
        !Array.isArray(request.rich_text) ||
        request.rich_text.length !== 0
      )
        return false
    }
  }
  if (rootCreates !== 1) return false
  const inventoryBase = `v1/blocks/${receipt.page_id}/children`
  const inventoryPaths = Object.keys(receipt.guards).filter((path) =>
    path.startsWith(inventoryBase + "?"),
  )
  const seen = new Set<string>()
  const blockIds = new Set<string>()
  let path = inventoryBase + "?page_size=100"
  for (;;) {
    if (seen.has(path)) return false
    seen.add(path)
    const saved = record(receipt.guards[path])
    const actual = record(raw[path])
    if (
      !saved ||
      !actual ||
      !Array.isArray(saved.results) ||
      saved.results.length !== 0 ||
      !Array.isArray(actual.results) ||
      typeof saved.has_more !== "boolean" ||
      typeof actual.has_more !== "boolean" ||
      !sameJson(saved, { results: [], has_more: actual.has_more, next_cursor: actual.next_cursor })
    )
      return false
    for (const value of actual.results) {
      const block = record(value)
      const parent = record(block?.parent)
      if (
        !block ||
        typeof block.id !== "string" ||
        !block.id ||
        blockIds.has(block.id) ||
        typeof block.type !== "string" ||
        !ordinaryRootTypes.has(block.type) ||
        !record(block[block.type]) ||
        typeof block.has_children !== "boolean" ||
        parent?.type !== "page_id" ||
        parent.page_id !== receipt.page_id ||
        block.archived === true ||
        block.in_trash === true
      )
        return false
      blockIds.add(block.id)
    }
    if (!actual.has_more) {
      if (actual.next_cursor !== null && actual.next_cursor !== undefined) return false
      return seen.size === inventoryPaths.length && inventoryPaths.every((entry) => seen.has(entry))
    }
    if (typeof actual.next_cursor !== "string" || !actual.next_cursor) return false
    const cursor = encoded(actual.next_cursor)
    if (cursor === undefined) return false
    path = inventoryBase + "?page_size=100&start_cursor=" + cursor
  }
}
