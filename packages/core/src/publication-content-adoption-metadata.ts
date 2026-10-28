import { isDeepStrictEqual } from "node:util"
import type { Receipt } from "./publication-model.ts"

type Comparison =
  | { readonly mode: "exact"; readonly value: unknown }
  | { readonly mode: "root_edit_time"; readonly value: Readonly<Record<string, unknown>> }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Only an exact root-linked automatic timestamp may differ after our root
 * property write. The definition and every other key retain exact equality.
 * The mode prevents a missing or malformed value from matching a projection. */
export function contentAdoptionPropertyComparison(
  value: unknown,
  rootRevision: unknown,
): Comparison {
  if (
    !record(value) ||
    typeof rootRevision !== "string" ||
    !rootRevision ||
    !Object.hasOwn(value, "id") ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    !Object.hasOwn(value, "type") ||
    value.type !== "last_edited_time" ||
    !Object.hasOwn(value, "last_edited_time") ||
    value.last_edited_time !== rootRevision
  )
    return { mode: "exact", value }
  const { last_edited_time: _derived, ...definition } = value
  return { mode: "root_edit_time", value: definition }
}

export function contentAdoptionEditTimeFenceCandidate(receipt: Receipt) {
  const rootPath = `v1/pages/${receipt.page_id}`
  const intent = receipt.intents[0]
  const response = record(intent?.response) ? intent.response : undefined
  if (
    !receipt.page_id ||
    !receipt.context?.content_adoption ||
    receipt.operation !== "replace" ||
    receipt.state !== "failed" ||
    receipt.conflict !== true ||
    receipt.owner ||
    receipt.result ||
    (receipt.conflict_history?.length ?? 0) !== 0 ||
    receipt.stages.length !== 0 ||
    receipt.intents.length !== 1 ||
    receipt.failure?.code !== "WRITE_CONFLICT" ||
    receipt.failure.message !== "An unrequested original field or physical resource changed." ||
    !record(receipt.failure.details) ||
    receipt.failure.details.path !== rootPath ||
    !intent ||
    intent.path !== rootPath ||
    intent.method !== "PATCH" ||
    intent.status !== "completed" ||
    !response ||
    response.id !== receipt.page_id ||
    Object.keys(response).some((key) => key !== "id" && key !== "status") ||
    intent.recovery ||
    intent.artifact ||
    intent.typed_links ||
    intent.list_start_repair ||
    ("zero_list_repair" in intent && intent.zero_list_repair !== undefined)
  )
    return undefined
  const before = intent.guards?.[rootPath],
    acknowledged = receipt.guards[rootPath]
  if (
    !record(before) ||
    !record(acknowledged) ||
    before.id !== receipt.page_id ||
    acknowledged.id !== receipt.page_id ||
    typeof before.last_edited_time !== "string" ||
    !before.last_edited_time ||
    typeof acknowledged.last_edited_time !== "string" ||
    !acknowledged.last_edited_time ||
    before.last_edited_time === acknowledged.last_edited_time ||
    !record(before.properties) ||
    !record(acknowledged.properties)
  )
    return undefined
  const beforeFields = before.properties,
    acknowledgedFields = acknowledged.properties
  const fields = Object.entries(beforeFields).flatMap(([name, field]) => {
    const previous = contentAdoptionPropertyComparison(field, before.last_edited_time)
    const current = contentAdoptionPropertyComparison(
      acknowledgedFields[name],
      acknowledged.last_edited_time,
    )
    if (
      previous.mode !== "root_edit_time" ||
      current.mode !== "root_edit_time" ||
      !isDeepStrictEqual(previous.value, current.value)
    )
      return []
    return [{ name, id: String(previous.value.id), definition: previous.value }]
  })
  return fields.length ? { rootPath, before, acknowledged, fields } : undefined
}
