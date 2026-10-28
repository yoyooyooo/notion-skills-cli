import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { property } from "./model.ts"
import type { Receipt } from "./publication-model.ts"

type Intent = Receipt["intents"][number]
export type RetainedUploadRecovery = Extract<
  NonNullable<Intent["recovery"]>,
  { kind: "retained_unusable" }
>
const same = isDeepStrictEqual
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const checksum = /^[a-f0-9]{64}$/
const bundle = "ntn-skills-source.zip"
const own = (value: object, key: string) => Object.hasOwn(value, key)
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  record(value) && Object.keys(value).length === keys.length && keys.every((key) => own(value, key))
const upload = (intent: Intent) =>
  intent.path === "v1/file_uploads" ||
  /^v1\/file_uploads\/[^/]+\/(?:send|complete)$/.test(intent.path)

// Version 1 certificate encoding: ordered arrays and sorted object keys. This
// digest is independent of Markdown or Notion observation normalization.
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (!record(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, ordered(value[key])]),
  )
}
export const retainedUploadDigest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex")

const publicationIdentity = (receipt: Receipt) => ({
  operation_id: receipt.operation_id,
  operation: receipt.operation,
  scope: receipt.scope,
  database_id: receipt.database_id,
  data_source_id: receipt.data_source_id,
  page_id: receipt.page_id,
  context: receipt.context,
  portable: receipt.portable,
})

export interface RetainedUploadSequence {
  readonly original_intent_count: number
  readonly allocation_index: number
  readonly send_index: number
  readonly files_intent_index?: number
  readonly upload_id: string
  readonly files_property_id: string
  readonly files_property_name: string
  readonly artifact: NonNullable<Intent["artifact"]>
  readonly root_path: string
  readonly covered_indices: readonly number[]
}

/** The original sequence is inspected in place. A certificate may only remove
 * its own added recovery fields from a hash; no status or response is projected. */
function sequenceAt(
  receipt: Receipt,
  count: number,
  beforeRoot: unknown,
  certificate?: RetainedUploadRecovery,
): RetainedUploadSequence | undefined {
  if (
    receipt.operation !== "create" ||
    receipt.portable.kind !== "skill" ||
    !receipt.context?.ownership ||
    receipt.context.write_path !== undefined ||
    !uuid.test(receipt.page_id ?? "") ||
    !receipt.scope ||
    !receipt.database_id ||
    !receipt.data_source_id ||
    !Number.isSafeInteger(count) ||
    count < 3 ||
    count > receipt.intents.length
  )
    return
  const rootPath = `v1/pages/${receipt.page_id}`
  const root = property(beforeRoot),
    fields = property(root.properties)
  const resourceFields = Object.entries(fields).filter(
    ([, field]) => property(field).type === "files",
  )
  if (
    root.id !== receipt.page_id ||
    root.archived !== false ||
    root.in_trash !== false ||
    typeof root.last_edited_time !== "string" ||
    !root.last_edited_time ||
    property(root.parent).type !== "data_source_id" ||
    property(root.parent).data_source_id !== receipt.data_source_id ||
    resourceFields.length !== 1
  )
    return
  const [name, fieldRaw] = resourceFields[0]!
  const field = property(fieldRaw)
  if (
    name !== "Files" ||
    typeof field.id !== "string" ||
    !field.id ||
    /[/?#\\\s]/.test(field.id) ||
    field.id === "." ||
    field.id === ".." ||
    !same(field.files, []) ||
    field.has_more === true ||
    field.next_cursor != null
  )
    return
  const prefix = receipt.intents.slice(0, count)
  const allocations = prefix.flatMap((intent, index) =>
    intent.path === "v1/file_uploads" ? [{ intent, index }] : [],
  )
  if (allocations.length !== 1) return
  const { intent: allocation, index: allocationIndex } = allocations[0]!
  const artifact = allocation.artifact,
    id = property(allocation.response).id
  if (
    allocation.method !== "POST" ||
    allocation.status !== "completed" ||
    !artifact ||
    typeof id !== "string" ||
    !uuid.test(id) ||
    artifact.filename !== bundle ||
    !checksum.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.byte_length) ||
    artifact.byte_length <= 0 ||
    artifact.byte_length > 20 * 1024 * 1024 ||
    artifact.suboperation_id !== `${receipt.operation_id}:upload:${allocationIndex}` ||
    !same(allocation.body, { filename: bundle, mode: "single_part" })
  )
    return
  const sendIndex = allocationIndex + 1,
    send = prefix[sendIndex]
  if (
    !send ||
    send.path !== `v1/file_uploads/${id}/send` ||
    send.method !== "POST" ||
    send.body !== undefined ||
    send.artifact !== undefined ||
    send.typed_links !== undefined ||
    send.list_start_repair !== undefined ||
    !["completed", "unknown"].includes(send.status)
  )
    return
  let filesIndex: number | undefined
  if (count === sendIndex + 2) {
    const intent = prefix[count - 1]!,
      body = intent.body
    if (
      send.status !== "completed" ||
      intent.status !== "unknown" ||
      intent.path !== rootPath ||
      intent.method !== "PATCH" ||
      intent.response !== undefined ||
      intent.artifact !== undefined ||
      intent.typed_links !== undefined ||
      intent.list_start_repair !== undefined ||
      !exact(body, ["properties"]) ||
      !record(body.properties)
    )
      return
    const entries = Object.entries(body.properties)
    if (
      entries.length !== 1 ||
      ![name, field.id].includes(entries[0]![0]) ||
      !same(entries[0]![1], { files: [{ name: bundle, type: "file_upload", file_upload: { id } }] })
    )
      return
    filesIndex = count - 1
  } else if (count !== sendIndex + 1) return
  const covered = [allocationIndex, sendIndex, ...(filesIndex === undefined ? [] : [filesIndex])]
  const roots = prefix.flatMap((intent, index) =>
    intent.path === "v1/pages" &&
    intent.method === "POST" &&
    property(property(intent.body).parent).data_source_id !== undefined
      ? [{ intent, index }]
      : [],
  )
  if (
    roots.length !== 1 ||
    roots[0]!.index !== 0 ||
    property(roots[0]!.intent.response).id !== receipt.page_id ||
    property(property(roots[0]!.intent.body).parent).data_source_id !== receipt.data_source_id
  )
    return
  for (const [index, intent] of prefix.entries()) {
    if (
      intent.recovery !== undefined &&
      (!certificate || !covered.includes(index) || !same(intent.recovery, certificate))
    )
      return
    if (certificate && covered.includes(index) && !same(intent.recovery, certificate)) return
    if (
      intent.typed_links?.state === "pending" ||
      intent.list_start_repair ||
      ["recovery", "superseded_by", "replayed_by_intent"].some((key) =>
        own(property(intent.response), key),
      ) ||
      (intent.artifact !== undefined && index !== allocationIndex) ||
      (index !== sendIndex && index !== filesIndex && intent.status !== "completed") ||
      (upload(intent) && index !== allocationIndex && index !== sendIndex)
    )
      return
    if (!upload(intent) && index !== filesIndex) {
      const raw = JSON.stringify(intent.body ?? null)
      if (raw.includes(id) || raw.includes(id.replaceAll("-", ""))) return
    }
  }
  return {
    original_intent_count: count,
    allocation_index: allocationIndex,
    send_index: sendIndex,
    ...(filesIndex === undefined ? {} : { files_intent_index: filesIndex }),
    upload_id: id,
    files_property_name: name,
    files_property_id: field.id,
    artifact,
    root_path: rootPath,
    covered_indices: covered,
  }
}

/** Eligibility, not write authority. Current whole source/ACK/guard and upload
 * lifecycle proofs must run before minting its durable replacement record. */
export function retainedUnusableUploadCandidate(receipt: Receipt, currentRoot: unknown) {
  if (
    receipt.conflict ||
    receipt.conflict_history?.length ||
    receipt.result ||
    !["failed", "unknown", "running"].includes(receipt.state) ||
    receipt.intents.some((intent) => intent.recovery !== undefined) ||
    !same(currentRoot, receipt.guards[`v1/pages/${receipt.page_id}`]) ||
    typeof receipt.guards[`v1/pages/${receipt.page_id}/markdown`] !== "string"
  )
    return
  return sequenceAt(receipt, receipt.intents.length, currentRoot)
}

export function retainedUploadRecovery(
  receipt: Receipt,
  sequence: RetainedUploadSequence,
  intendedHash: string,
  currentRoot: unknown,
): RetainedUploadRecovery {
  return {
    kind: "retained_unusable",
    version: 1,
    replacement_suboperation_id: `${receipt.operation_id}:upload:retained:${sequence.allocation_index}`,
    operation_id: receipt.operation_id,
    intended_hash: intendedHash,
    original_intent_count: sequence.original_intent_count,
    allocation_index: sequence.allocation_index,
    send_index: sequence.send_index,
    ...(sequence.files_intent_index === undefined
      ? {}
      : { files_intent_index: sequence.files_intent_index }),
    upload_id: sequence.upload_id,
    files_property_id: sequence.files_property_id,
    files_property_name: sequence.files_property_name,
    artifact: { ...sequence.artifact },
    publication_identity_sha256: retainedUploadDigest(publicationIdentity(receipt)),
    original_journal_sha256: retainedUploadDigest(receipt.intents),
    original_guards_sha256: retainedUploadDigest(receipt.guards),
    original_root: JSON.parse(JSON.stringify(currentRoot)),
  }
}

export function retainedUploadCertificate(receipt: Receipt, certificate: RetainedUploadRecovery) {
  if (
    certificate.version !== 1 ||
    certificate.operation_id !== receipt.operation_id ||
    !checksum.test(certificate.intended_hash) ||
    !checksum.test(certificate.original_guards_sha256) ||
    certificate.publication_identity_sha256 !== retainedUploadDigest(publicationIdentity(receipt))
  )
    return
  const sequence = sequenceAt(
    receipt,
    certificate.original_intent_count,
    certificate.original_root,
    certificate,
  )
  if (
    !sequence ||
    certificate.replacement_suboperation_id !==
      `${receipt.operation_id}:upload:retained:${sequence.allocation_index}` ||
    certificate.allocation_index !== sequence.allocation_index ||
    certificate.send_index !== sequence.send_index ||
    certificate.files_intent_index !== sequence.files_intent_index ||
    certificate.upload_id !== sequence.upload_id ||
    certificate.files_property_id !== sequence.files_property_id ||
    certificate.files_property_name !== sequence.files_property_name ||
    !same(certificate.artifact, sequence.artifact)
  )
    return
  const original = receipt.intents
    .slice(0, certificate.original_intent_count)
    .map((intent, index) => {
      if (!sequence.covered_indices.includes(index)) return intent
      const { recovery: _added, ...unchanged } = intent
      return unchanged
    })
  if (retainedUploadDigest(original) !== certificate.original_journal_sha256) return
  return sequence
}

export function retainedUploadCertificates(receipt: Receipt) {
  const records = receipt.intents.flatMap((intent) =>
    intent.recovery?.kind === "retained_unusable" ? [intent.recovery] : [],
  )
  if (!records.length) return []
  const first = records[0]!
  if (records.some((record) => !same(record, first))) return undefined
  const sequence = retainedUploadCertificate(receipt, first)
  if (!sequence || records.length !== sequence.covered_indices.length) return undefined
  return [{ certificate: first, sequence }]
}

/** A later real whole-field ACK can cover the old retained history only after
 * the caller independently verifies its current attachment bytes and all guards. */
export function retainedUploadReplacementCandidates(receipt: Receipt) {
  const certificates = retainedUploadCertificates(receipt)
  if (!certificates) return undefined
  return certificates.map(({ certificate, sequence }) => {
    const later = receipt.intents.slice(sequence.original_intent_count)
    const allocations = later.flatMap((intent, offset) =>
      intent.artifact?.suboperation_id === certificate.replacement_suboperation_id
        ? [{ intent, index: sequence.original_intent_count + offset }]
        : [],
    )
    const allocation = allocations.length === 1 ? allocations[0] : undefined
    const id = property(allocation?.intent.response).id
    if (
      !allocation ||
      allocation.intent.path !== "v1/file_uploads" ||
      allocation.intent.method !== "POST" ||
      allocation.intent.status !== "completed" ||
      allocation.intent.recovery ||
      !same(allocation.intent.body, { filename: bundle, mode: "single_part" }) ||
      !same(allocation.intent.artifact, {
        ...sequence.artifact,
        suboperation_id: certificate.replacement_suboperation_id,
      }) ||
      typeof id !== "string" ||
      !uuid.test(id) ||
      id === sequence.upload_id
    )
      return { certificate, sequence }
    const send = receipt.intents[allocation.index + 1]
    if (
      !send ||
      send.path !== `v1/file_uploads/${id}/send` ||
      send.method !== "POST" ||
      send.status !== "completed" ||
      send.recovery ||
      send.body !== undefined
    )
      return { certificate, sequence }
    const fields = later.flatMap((intent, offset) => {
      if (intent.path !== sequence.root_path || intent.method !== "PATCH") return []
      const properties = property(property(intent.body).properties)
      return Object.keys(properties).some((key) =>
        [sequence.files_property_id, sequence.files_property_name].includes(key),
      )
        ? [{ intent, index: sequence.original_intent_count + offset }]
        : []
    })
    const field = fields.length === 1 ? fields[0] : undefined
    if (
      !field ||
      field.index <= allocation.index + 1 ||
      field.intent.status !== "completed" ||
      field.intent.recovery ||
      property(field.intent.response).id !== receipt.page_id ||
      !exact(field.intent.body, ["properties"])
    )
      return { certificate, sequence }
    const entries = Object.entries(property(field.intent.body.properties))
    if (
      entries.length !== 1 ||
      ![sequence.files_property_id, sequence.files_property_name].includes(entries[0]![0]) ||
      !same(entries[0]![1], { files: [{ name: bundle, type: "file_upload", file_upload: { id } }] })
    )
      return { certificate, sequence }
    return {
      certificate,
      sequence,
      replacement: {
        allocation_index: allocation.index,
        send_index: allocation.index + 1,
        attachment_index: field.index,
        upload_id: id,
      },
    }
  })
}
