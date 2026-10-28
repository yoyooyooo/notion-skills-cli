import { property } from "./model.ts"
import type { Receipt } from "./publication-model.ts"
import { canonical } from "./publication-observation.ts"

/**
 * Eligibility only. These candidates never settle an effect or clear a fence;
 * completedPublicationProof must independently verify the full current page.
 */
export function publicationZeroListHistory(receipt: Receipt) {
  const entries = receipt.intents.flatMap((intent, index) =>
    intent.zero_list_repair ? [{ intent, index }] : [],
  )
  const first = entries[0],
    terminal = entries.at(-1)
  if (!first || !terminal) return
  const repair = first.intent.zero_list_repair!
  if (
    !Number.isSafeInteger(repair.original_intent_count) ||
    repair.original_intent_count <= 0 ||
    repair.original_intent_count !== first.index ||
    repair.original_fence.intent_count !== first.index ||
    repair.original.source_intent_index >= first.index ||
    repair.original.source_intent_index < 0 ||
    !repair.original.original_fence ||
    !first.intent.guards ||
    !repair.original_guard_paths.length ||
    new Set(repair.original_guard_paths).size !== repair.original_guard_paths.length ||
    repair.original_guard_paths.some((path) => !(path in first.intent.guards!))
  )
    return
  const source = receipt.intents[repair.original.source_intent_index]
  const sourceBody = property(source?.body)
  if (
    source?.method !== "PATCH" ||
    source.status !== "completed" ||
    source.path !== "v1/pages/" + repair.original.page_id + "/markdown" ||
    sourceBody.type !== "replace_content" ||
    sourceBody.markdown_version !== "v2" ||
    typeof property(sourceBody.replace_content).new_str !== "string"
  )
    return
  for (const [position, entry] of entries.entries()) {
    const { intent, index } = entry
    const body = property(intent.body),
      response = property(intent.response)
    if (
      index !== first.index + position ||
      intent.path !== source.path ||
      intent.method !== "PATCH" ||
      intent.list_start_repair ||
      intent.recovery ||
      intent.typed_links ||
      canonical(intent.zero_list_repair) !== canonical(repair) ||
      canonical(intent.guards) !== canonical(first.intent.guards) ||
      canonical(intent.body) !== canonical(first.intent.body) ||
      Object.keys(body).length !== 3 ||
      body.type !== "replace_content" ||
      body.markdown_version !== "v2" ||
      Object.keys(property(body.replace_content)).length !== 1 ||
      typeof property(body.replace_content).new_str !== "string"
    )
      return
    const next = entries[position + 1]
    if (next) {
      if (
        intent.status !== "failed" ||
        response.recovery !== "known_not_applied" ||
        response.replayed_by_intent !== next.index ||
        !["pending", "unknown", "failed"].includes(String(response.prior_status))
      )
        return
    } else if (response.recovery === "known_not_applied") {
      if (
        intent.status !== "failed" ||
        index !== receipt.intents.length - 1 ||
        response.replayed_by_intent !== receipt.intents.length ||
        !["pending", "unknown", "failed"].includes(String(response.prior_status))
      )
        return
    }
  }
  const rejectedIndex = repair.rejected_field_intent_index
  if (rejectedIndex !== undefined) {
    const rejected = receipt.intents[rejectedIndex]
    if (
      !Number.isSafeInteger(rejectedIndex) ||
      rejectedIndex !== first.index - 1 ||
      rejected?.status !== "failed" ||
      rejected.method !== "PATCH" ||
      rejected.path !== "v1/blocks/" + repair.original.block_id ||
      rejected.recovery ||
      rejected.typed_links ||
      rejected.zero_list_repair ||
      canonical(rejected.list_start_repair) !== canonical(repair.original) ||
      canonical(rejected.body) !== canonical({ numbered_list_item: { list_start_index: 0 } }) ||
      property(rejected.response).id !== undefined ||
      property(rejected.response).recovery !== undefined
    )
      return
  }
  return { repair, entries, first, terminal }
}

export function publicationZeroListCandidates(receipt: Receipt) {
  const history = publicationZeroListHistory(receipt)
  if (!history || history.terminal.intent.status !== "completed") return []
  const response = property(history.terminal.intent.response)
  if (
    response.acknowledgement !== "received" &&
    !(
      response.recovery === "observed_applied" && response.proof_kind === "zero_start_paragraphs_v1"
    )
  )
    return []
  const indices = history.entries.slice(0, -1).map((entry) => entry.index)
  if (history.repair.rejected_field_intent_index !== undefined)
    indices.push(history.repair.rejected_field_intent_index)
  return indices.map((index) => ({
    path: receipt.intents[index]!.path,
    intent_index: index,
    covered_by_intent_index: history.terminal.index,
    source_intent_index: history.repair.original.source_intent_index,
  }))
}
