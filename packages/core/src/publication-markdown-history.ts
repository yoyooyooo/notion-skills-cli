import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { Receipt } from "./publication-model.ts"
import { markdownReplayRequest } from "./publication-markdown-replay.ts"

type Intent = Receipt["intents"][number]
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
const field = (value: unknown) => (record(value) ? value : {})
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
export function correctionCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(correctionCanonical).join(",")}]`
  if (record(value))
    return `{${Object.entries(value)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${JSON.stringify(key)}:${correctionCanonical(value)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}
export const correctionHash = (value: unknown) =>
  createHash("sha256").update(correctionCanonical(value)).digest("hex")

function originalRequest(receipt: Receipt, intents: readonly Intent[], guards: Receipt["guards"]) {
  if (
    receipt.operation !== "create" ||
    receipt.portable.kind !== "skill" ||
    receipt.context?.write_path !== undefined ||
    receipt.context?.content_adoption !== undefined ||
    !receipt.page_id ||
    !receipt.scope ||
    !receipt.database_id ||
    !receipt.data_source_id ||
    intents.length !== 3 ||
    receipt.portable.files.some((file) => /^references\/.*\.md$/i.test(file.path))
  )
    return
  const rootPath = `v1/pages/${receipt.page_id}`,
    bodyPath = `${rootPath}/markdown`
  const inventoryPath = `v1/blocks/${receipt.page_id}/children?page_size=100`
  const root = field(guards[rootPath]),
    properties = field(root.properties)
  const references = field(properties.References)
  if (
    root.id !== receipt.page_id ||
    field(root.parent).data_source_id !== receipt.data_source_id ||
    root.archived === true ||
    root.in_trash === true ||
    typeof root.last_edited_time !== "string" ||
    !root.last_edited_time ||
    guards[bodyPath] !== "" ||
    references.type !== "rich_text" ||
    typeof references.id !== "string" ||
    !references.id ||
    /[/?#]/.test(references.id) ||
    !Array.isArray(references.rich_text) ||
    references.rich_text.length !== 0
  )
    return
  const referencesPath = `${rootPath}/properties/${references.id}?page_size=100`
  const inventory = field(guards[inventoryPath]),
    property = field(guards[referencesPath])
  if (
    !Array.isArray(inventory.results) ||
    inventory.results.length !== 0 ||
    inventory.has_more !== false ||
    inventory.next_cursor !== null ||
    !Array.isArray(property.results) ||
    property.results.length !== 0 ||
    property.has_more !== false ||
    property.next_cursor !== null ||
    !isDeepStrictEqual(
      Object.keys(guards).sort(),
      [rootPath, bodyPath, inventoryPath, referencesPath].sort(),
    )
  )
    return
  const [created, registered, derived] = intents
  if (
    !created ||
    !registered ||
    !derived ||
    intents.some(
      (intent) =>
        intent.status !== "completed" ||
        intent.recovery ||
        intent.typed_links ||
        intent.artifact ||
        intent.list_start_repair ||
        intent.guards ||
        ("zero_list_repair" in intent && intent.zero_list_repair !== undefined),
    )
  )
    return
  const createdBody = field(created.body),
    createdResponse = field(created.response)
  if (
    created.method !== "POST" ||
    created.path !== "v1/pages" ||
    !exactKeys(createdBody, ["parent", "properties"]) ||
    !isDeepStrictEqual(createdBody.parent, {
      type: "data_source_id",
      data_source_id: receipt.data_source_id,
    }) ||
    Object.keys(field(createdBody.properties)).length === 0 ||
    !exactKeys(createdResponse, ["id"]) ||
    createdResponse.id !== receipt.page_id
  )
    return
  const registeredResponse = field(registered.response)
  if (
    registered.method !== "PATCH" ||
    registered.path !== rootPath ||
    !exactKeys(registeredResponse, ["id"]) ||
    registeredResponse.id !== receipt.page_id ||
    !isDeepStrictEqual(registered.body, { properties: { [references.id]: { rich_text: [] } } })
  )
    return
  const request = markdownReplayRequest(derived),
    response = field(derived.response)
  if (
    !request ||
    derived.path !== bodyPath ||
    request.owner !== receipt.page_id ||
    !request.target ||
    !isDeepStrictEqual(response, { prior_status: "unknown", recovery: "observed_applied" })
  )
    return
  return {
    intent: derived,
    intent_index: 2,
    rootPath,
    bodyPath,
    inventoryPath,
    referencesPath,
    page_id: receipt.page_id,
    data_source_id: receipt.data_source_id,
    target: request.target,
  }
}

/** Identifies one erroneous observation shape; it is never mutation authority.
 * Every original guard, source object and marker must still pass a fresh proof. */
export function originalObservedMarkdownCorrectionCandidate(receipt: Receipt) {
  if (
    receipt.conflict !== true ||
    receipt.owner ||
    receipt.result ||
    receipt.state !== "failed" ||
    receipt.failure?.code !== "WRITE_CONFLICT" ||
    (receipt.conflict_history?.length ?? 0) !== 0
  )
    return
  return originalRequest(receipt, receipt.intents, receipt.guards)
}

export function hasObservedMarkdownCorrection(receipt: Receipt) {
  return (
    receipt.conflict_history?.some((entry) => entry.observed_markdown_correction !== undefined) ??
    false
  )
}

/** The immutable original journal and guards are kept with the correction.
 * This validates recorded identity only; a subsequent send must reprove state. */
export function recordedObservedMarkdownCorrection(receipt: Receipt) {
  const entries = receipt.conflict_history?.filter(
    (entry) => entry.observed_markdown_correction !== undefined,
  )
  if (!entries || entries.length !== 1) return
  const entry = entries[0]
  const checkpoint = entry?.observed_markdown_correction
  if (
    !entry ||
    !checkpoint ||
    checkpoint.version !== 1 ||
    entry.conflict !== true ||
    entry.state !== "failed" ||
    entry.failure?.code !== "WRITE_CONFLICT" ||
    entry.intent_count !== 3 ||
    checkpoint.original_intent_count !== 3 ||
    entry.intended_hash !== checkpoint.intended_hash ||
    checkpoint.operation_id !== receipt.operation_id ||
    checkpoint.page_id !== receipt.page_id ||
    checkpoint.scope !== receipt.scope ||
    checkpoint.database_id !== receipt.database_id ||
    checkpoint.data_source_id !== receipt.data_source_id ||
    checkpoint.original_journal_sha256 !== correctionHash(receipt.intents.slice(0, 3)) ||
    checkpoint.original_guards_sha256 !== correctionHash(checkpoint.original_guards) ||
    checkpoint.original_portable_sha256 !== correctionHash(receipt.portable) ||
    checkpoint.original_context_sha256 !== correctionHash(receipt.context) ||
    !isDeepStrictEqual(
      [...entry.guard_paths].sort(),
      Object.keys(checkpoint.original_guards).sort(),
    )
  )
    return
  const candidate = originalRequest(
    receipt,
    receipt.intents.slice(0, 3),
    checkpoint.original_guards,
  )
  if (
    !candidate ||
    checkpoint.target_sha256 !== createHash("sha256").update(candidate.target).digest("hex") ||
    checkpoint.source_sha256 !==
      receipt.portable.files.find((file) => file.path === receipt.portable.main)?.sha256 ||
    checkpoint.metadata_before_sha256 !==
      correctionHash(checkpoint.original_guards[candidate.rootPath]) ||
    checkpoint.metadata_after_sha256 !== checkpoint.metadata_before_sha256 ||
    [
      checkpoint.intended_hash,
      checkpoint.original_receipt_sha256,
      checkpoint.integrity_sha256,
      checkpoint.inventory_sha256,
      checkpoint.references_sha256,
    ].some((value) => !/^[a-f0-9]{64}$/.test(value))
  )
    return
  if (
    receipt.intents.length === 3 &&
    correctionHash(receipt.guards) !== checkpoint.original_guards_sha256
  )
    return
  return { candidate, checkpoint }
}

export interface ObservedMarkdownCorrectionCoverage {
  readonly path: string
  readonly intent_index: 2
  readonly covered_by_intent_index: number
}

/** The correction cannot settle until an actual successor request exists.
 * That request's full current Markdown must be proved by the official reader. */
export function observedMarkdownCorrectionCoverage(
  receipt: Receipt,
): ObservedMarkdownCorrectionCoverage | undefined {
  const recorded = recordedObservedMarkdownCorrection(receipt)
  if (!recorded) return
  const { candidate } = recorded
  for (let index = 3; index < receipt.intents.length; index++) {
    const intent = receipt.intents[index]
    if (
      !intent ||
      !markdownReplayRequest(intent) ||
      intent.path !== candidate.bodyPath ||
      !isDeepStrictEqual(intent.body, candidate.intent.body) ||
      !record(intent.response)
    )
      return
    if (intent.status === "completed") {
      const ack =
        intent.response.id === candidate.page_id &&
        Object.keys(intent.response).every((key) => ["id", "status"].includes(key))
      const observed =
        exactKeys(intent.response, ["prior_status", "recovery"]) &&
        ["unknown", "pending"].includes(String(intent.response.prior_status)) &&
        intent.response.recovery === "observed_applied"
      if (ack || observed)
        return { path: candidate.bodyPath, intent_index: 2, covered_by_intent_index: index }
      return
    }
    if (
      intent.status !== "failed" ||
      !exactKeys(intent.response, ["prior_status", "recovery", "replayed_by_intent"]) ||
      !["unknown", "pending"].includes(String(intent.response.prior_status)) ||
      intent.response.recovery !== "known_not_applied" ||
      intent.response.replayed_by_intent !== index + 1
    )
      return
  }
}
