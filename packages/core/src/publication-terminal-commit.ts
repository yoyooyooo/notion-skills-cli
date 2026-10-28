import { retainedUploadReplacementCandidates } from "./publication-retained-upload.ts"
import { property } from "./model.ts"
import type { Receipt } from "./publication-model.ts"
import type {
  CommittedMarker,
  IntegrityIntent,
  PublicationMarker,
} from "./publication-integrity-state.ts"
import { canonical } from "./publication-effect-proof.ts"
import { creationProofFromBody, creationProofMatchesIntent } from "./publication-create-identity.ts"

/** Eligibility only. The caller must prove every original guard, completed effect,
 * frozen source and current snapshot before clearing a fence or sending a commit. */
export function terminalPublicationCommitCandidate(
  receipt: Receipt,
  integrity: IntegrityIntent | undefined,
  current: unknown,
  markerFrom: (raw: unknown) => PublicationMarker | undefined,
):
  | { intent_index: number; acknowledged_root_create?: number; marker: CommittedMarker }
  | undefined {
  if (
    !integrity ||
    !receipt.page_id ||
    !receipt.data_source_id ||
    receipt.operation !== "create" ||
    receipt.portable.kind !== "skill" ||
    !receipt.context?.ownership ||
    receipt.context.write_path !== undefined ||
    receipt.state === "completed" ||
    receipt.result !== undefined ||
    receipt.intents.length < 2 ||
    !receipt.stages.includes("verify") ||
    integrity.operation_id !== receipt.operation_id ||
    integrity.page_id !== receipt.page_id ||
    integrity.marker.state !== "committed" ||
    integrity.marker.operation_id !== receipt.operation_id ||
    integrity.marker.intended_hash !== integrity.intended_hash
  )
    return undefined
  const retained = retainedUploadReplacementCandidates(receipt)
  if (!retained || retained.some((item) => !item.replacement)) return undefined
  const retainedIndices = new Set(retained.flatMap((item) => item.sequence.covered_indices))
  const index = receipt.intents.length - 1
  const intent = receipt.intents[index]!
  const rootPath = `v1/pages/${receipt.page_id}`
  const page = property(current)
  const field = property(property(property(intent.body).properties).Publication)
  const spans = field.rich_text
  const content =
    Array.isArray(spans) && spans.length === 1
      ? property(property(spans[0]).text).content
      : undefined
  if (
    intent.status !== "unknown" ||
    intent.path !== rootPath ||
    intent.method !== "PATCH" ||
    intent.response !== undefined ||
    intent.recovery ||
    intent.typed_links ||
    intent.artifact ||
    intent.list_start_repair ||
    typeof content !== "string" ||
    canonical(intent.body) !==
      canonical({
        properties: {
          Publication: { rich_text: [{ type: "text", text: { content } }] },
        },
      }) ||
    !(rootPath in receipt.guards) ||
    typeof receipt.guards[rootPath + "/markdown"] !== "string" ||
    canonical(current) !== canonical(receipt.guards[rootPath]) ||
    page.id !== receipt.page_id ||
    page.archived !== false ||
    page.in_trash !== false ||
    property(page.parent).data_source_id !== receipt.data_source_id ||
    receipt.intents
      .slice(0, index)
      .some(
        (entry, priorIndex) =>
          !retainedIndices.has(priorIndex) &&
          (entry.status !== "completed" ||
            entry.recovery ||
            entry.typed_links?.state === "pending" ||
            property(entry.response).recovery !== undefined ||
            property(entry.response).superseded_by !== undefined ||
            property(entry.response).replayed_by_intent !== undefined),
      )
  )
    return undefined
  const roots = receipt.intents.flatMap((entry, originalIndex) =>
    entry.path === "v1/pages" &&
    entry.method === "POST" &&
    property(property(entry.body).parent).data_source_id !== undefined
      ? [{ entry, originalIndex }]
      : [],
  )
  if (roots.length !== 1) return undefined
  const root = roots[0]!
  const body = property(root.entry.body)
  const parent = property(body.parent)
  if (
    property(root.entry.response).id !== receipt.page_id ||
    parent.data_source_id !== receipt.data_source_id ||
    Object.keys(body).some((key) => !["parent", "properties", "children"].includes(key)) ||
    Object.entries(parent).some(
      ([key, value]) => canonical(property(page.parent)[key]) !== canonical(value),
    ) ||
    !Array.isArray(property(property(body.properties).Publication).rich_text)
  )
    return undefined
  let writing: PublicationMarker | undefined
  let posted: PublicationMarker | undefined
  let desired: PublicationMarker | undefined
  try {
    desired = markerFrom({ properties: { Publication: { type: "rich_text", ...field } } })
    writing = markerFrom(current)
    posted = markerFrom({
      properties: {
        Publication: { type: "rich_text", ...property(property(body.properties).Publication) },
      },
    })
  } catch {
    return undefined
  }
  if (
    !desired ||
    desired.state !== "committed" ||
    canonical(desired) !== canonical(integrity.marker) ||
    !writing ||
    writing.state !== "writing" ||
    writing.base_revision !== undefined ||
    writing.operation_id !== receipt.operation_id ||
    writing.intended_hash !== integrity.intended_hash ||
    !posted ||
    canonical(posted) !== canonical(writing) ||
    canonical(writing.creation) !== canonical(integrity.marker.creation)
  )
    return undefined
  const creation = creationProofFromBody(root.entry.body)
  if (
    writing.creation !== undefined &&
    (!creation ||
      !creationProofMatchesIntent(creation, receipt, root.originalIndex) ||
      canonical(creation) !== canonical(writing.creation) ||
      creation.intended_hash !== integrity.intended_hash)
  )
    return undefined
  if (writing.creation === undefined && creation !== undefined) return undefined
  return {
    intent_index: index,
    ...(writing.creation === undefined ? { acknowledged_root_create: root.originalIndex } : {}),
    marker: integrity.marker,
  }
}
