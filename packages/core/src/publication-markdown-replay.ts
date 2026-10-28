import { isDeepStrictEqual } from "node:util"
import type { Receipt } from "./publication-model.ts"

type Intent = Receipt["intents"][number]

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/** The replay must keep the entire original replace request, including its v2
 * format and target bytes. Typed links and partial updates have another owner. */
export function markdownReplayRequest(intent: Intent) {
  const owner = /^v1\/pages\/([a-f0-9-]{36})\/markdown$/.exec(intent.path)?.[1]
  if (
    !owner ||
    intent.method !== "PATCH" ||
    intent.recovery ||
    intent.typed_links ||
    intent.artifact ||
    intent.list_start_repair ||
    ("zero_list_repair" in intent && intent.zero_list_repair !== undefined) ||
    !record(intent.body) ||
    !exactKeys(intent.body, ["markdown_version", "type", "replace_content"]) ||
    intent.body.markdown_version !== "v2" ||
    intent.body.type !== "replace_content" ||
    !record(intent.body.replace_content) ||
    !exactKeys(intent.body.replace_content, ["new_str"]) ||
    typeof intent.body.replace_content.new_str !== "string"
  )
    return
  return { owner, target: intent.body.replace_content.new_str }
}

/** Eligibility only. The recovery caller must also reread every original guard
 * unchanged before it records this no-effect conclusion or sends a successor. */
export function pendingMarkdownReplayCandidate(receipt: Receipt, intent: Intent, actual: unknown) {
  const request = markdownReplayRequest(intent)
  const before = receipt.guards[intent.path]
  const pending =
    (intent.status === "pending" || intent.status === "unknown") && intent.response === undefined
  const recorded = terminalRecordedMarkdownReplay(receipt) === intent
  return request &&
    !receipt.conflict &&
    receipt.intents.at(-1) === intent &&
    (pending || recorded) &&
    typeof before === "string" &&
    actual === before &&
    request.target !== before
    ? request
    : undefined
}

/** A crash may occur after saving a no-effect decision but before the successor
 * is appended. The same original guard proof is required again before sending. */
export function terminalRecordedMarkdownReplay(receipt: Receipt) {
  const intent = receipt.intents.at(-1)
  if (
    !intent ||
    intent.status !== "failed" ||
    !markdownReplayRequest(intent) ||
    !record(intent.response) ||
    !exactKeys(intent.response, ["prior_status", "recovery", "replayed_by_intent"]) ||
    !["pending", "unknown"].includes(String(intent.response.prior_status)) ||
    intent.response.recovery !== "known_not_applied" ||
    intent.response.replayed_by_intent !== receipt.intents.length
  )
    return
  return intent
}

export interface PublicationMarkdownReplayCoverage {
  readonly path: string
  readonly intent_index: number
  readonly covered_by_intent_index: number
}

/** A failed no-effect request remains in the journal. Only its consecutive,
 * byte-identical successor chain ending at a completed effect is a candidate.
 * A real ACK or the existing independently observed effect may end the chain.
 * Current whole-body proof must verify that terminal effect independently. */
export function publicationMarkdownReplayCandidates(
  receipt: Receipt,
): PublicationMarkdownReplayCoverage[] {
  const result: PublicationMarkdownReplayCoverage[] = []
  for (const [index, original] of receipt.intents.entries()) {
    const request = markdownReplayRequest(original)
    if (!request || original.status !== "failed") continue
    let position = index
    while (position < receipt.intents.length) {
      const current = receipt.intents[position]
      if (
        !current ||
        current.path !== original.path ||
        !isDeepStrictEqual(current.body, original.body) ||
        !markdownReplayRequest(current) ||
        !record(current.response)
      )
        break
      if (position > index && current.status === "completed") {
        const acknowledged =
          current.response.id === request.owner &&
          Object.keys(current.response).every((key) => ["id", "status"].includes(key))
        const observed =
          exactKeys(current.response, ["prior_status", "recovery"]) &&
          ["pending", "unknown"].includes(String(current.response.prior_status)) &&
          current.response.recovery === "observed_applied"
        if (acknowledged || observed)
          result.push({
            path: original.path,
            intent_index: index,
            covered_by_intent_index: position,
          })
        break
      }
      if (
        current.status !== "failed" ||
        !exactKeys(current.response, ["prior_status", "recovery", "replayed_by_intent"]) ||
        !["pending", "unknown"].includes(String(current.response.prior_status)) ||
        current.response.recovery !== "known_not_applied" ||
        current.response.replayed_by_intent !== position + 1
      )
        break
      position++
    }
  }
  return result
}
