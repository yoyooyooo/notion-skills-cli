import { isDeepStrictEqual } from "node:util"
import { decodeReferenceLinks, referenceLinks } from "./reference-links.ts"
import type { Receipt } from "./publication-model.ts"

const firstOversizedPrefix = 51
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

function only(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value)
}

/**
 * Candidate coverage only: the original writer's first over-limit References request.
 * Its immutable prefix proves which field and allocated pages it could affect. A caller
 * still needs a later complete replacement, current full-field equality and graph proof.
 * This never changes a failed intent into an ACK or into an observed no-effect record.
 */
export function legacyReferencesLimitPrefix(receipt: Receipt, index: number, fieldId: string) {
  const root = receipt.page_id
  const intent = receipt.intents[index]
  if (
    receipt.operation !== "create" ||
    receipt.portable.kind !== "skill" ||
    !root ||
    !fieldId ||
    index !== firstOversizedPrefix * 2 ||
    !intent ||
    !only(object(intent), ["path", "body", "method", "status"]) ||
    intent.status !== "failed" ||
    intent.method !== "PATCH" ||
    intent.path !== `v1/pages/${root}`
  )
    return false
  const body = object(intent.body)
  const properties = object(body.properties)
  const field = Object.keys(properties)[0]
  if (
    !only(body, ["properties"]) ||
    Object.keys(properties).length !== 1 ||
    typeof field !== "string" ||
    (field !== fieldId && field !== "References")
  )
    return false
  const original = decodeReferenceLinks(properties[field], { oversizedLegacy: true })
  if (
    original?.representation !== "legacy" ||
    original.bindings.length !== firstOversizedPrefix ||
    !Array.isArray(object(properties[field]).rich_text) ||
    (object(properties[field]).rich_text as unknown[]).length !== firstOversizedPrefix * 2 - 1
  )
    return false
  const sourcePaths = receipt.portable.files
    .filter(
      (file) => file.path !== receipt.portable.main && /^references\/.*\.md$/i.test(file.path),
    )
    .map((file) => file.path)
  if (
    sourcePaths.length < firstOversizedPrefix ||
    sourcePaths.length > 100 ||
    new Set(sourcePaths).size !== sourcePaths.length ||
    !isDeepStrictEqual(
      original.bindings.map((entry) => entry.path),
      sourcePaths.slice(0, firstOversizedPrefix),
    )
  )
    return false
  const allocation = receipt.intents[0]
  const allocationBody = object(allocation?.body)
  if (
    !allocation ||
    allocation.status !== "completed" ||
    allocation.method !== "POST" ||
    allocation.path !== "v1/pages" ||
    object(allocation.response).id !== root ||
    allocation.recovery ||
    allocation.typed_links ||
    allocation.artifact ||
    allocation.list_start_repair ||
    !isDeepStrictEqual(allocationBody.parent, {
      type: "data_source_id",
      data_source_id: receipt.data_source_id,
    })
  )
    return false
  for (const [offset, entry] of original.bindings.entries()) {
    const child = receipt.intents[offset * 2 + 1]!
    const childBody = object(child.body)
    if (
      child.status !== "completed" ||
      child.method !== "POST" ||
      child.path !== "v1/pages" ||
      child.recovery ||
      child.typed_links ||
      child.artifact ||
      child.list_start_repair ||
      object(child.response).id !== entry.id ||
      entry.id === root ||
      !Object.keys(childBody).every((key) => ["parent", "properties", "children"].includes(key)) ||
      !isDeepStrictEqual(childBody.parent, { type: "page_id", page_id: root }) ||
      !isDeepStrictEqual(childBody.properties, {
        title: {
          title: [
            {
              text: {
                content: entry.path.startsWith("references/")
                  ? entry.path.slice("references/".length)
                  : entry.path,
              },
            },
          ],
        },
      }) ||
      entry.url !== `https://www.notion.so/${entry.id.replaceAll("-", "")}`
    )
      return false
    if (offset + 1 === firstOversizedPrefix) continue
    const registration = receipt.intents[offset * 2 + 2]!
    const request = object(registration.body)
    const values = object(request.properties)
    const key = Object.keys(values)[0]
    if (
      registration.status !== "completed" ||
      registration.method !== "PATCH" ||
      registration.path !== `v1/pages/${root}` ||
      object(registration.response).id !== root ||
      registration.recovery ||
      registration.typed_links ||
      registration.artifact ||
      registration.list_start_repair ||
      !only(request, ["properties"]) ||
      Object.keys(values).length !== 1 ||
      typeof key !== "string" ||
      (key !== fieldId && key !== "References") ||
      !isDeepStrictEqual(values[key], referenceLinks(original.bindings.slice(0, offset + 1)))
    )
      return false
  }
  return true
}
