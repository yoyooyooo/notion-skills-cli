import { Effect } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import type { Receipt } from "./publication-model.ts"
import type { Notion } from "./notion.ts"
import { Store, sha256 } from "./store.ts"
import { readImportZip } from "./import.ts"
import { BUNDLE, bodyIdentity, readPortable, type PortableSkill } from "./portable.ts"
import { fromNotionMarkdown, samePublishedMarkdown } from "./markdown.ts"
import { rewritePageLinks } from "./references.ts"
import { sameRelativeFileDestination } from "./publication-markdown.ts"
import { publicationZeroListHistory } from "./publication-zero-list-history.ts"
import { verifyCompletedZeroListRepair } from "./publication-zero-list-repair.ts"
import { canonical, metadata } from "./publication-observation.ts"
import { stableListOwner } from "./publication-list-repair.ts"
import { verifyAttachedUpload } from "./publication-upload.ts"

const refuse = (message: string) => Effect.fail(fail("PUBLICATION_ZERO_SOURCE_UNPROVEN", message))

function decodeBundle(bytes: Uint8Array) {
  return Effect.try({
    try: () => readPortable(readImportZip(bytes)),
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("PUBLICATION_ZERO_SOURCE_UNPROVEN", "The retained source bundle cannot be decoded."),
  })
}

function frozenSourceMatches(receipt: Receipt, source: PortableSkill | undefined) {
  return Effect.gen(function* () {
    const expected = receipt.portable
    const projection = source?.projection
    if (
      !source ||
      source.kind !== expected.kind ||
      source.name !== expected.name ||
      source.description !== expected.description ||
      source.main !== expected.main ||
      source.files.length !== expected.files.length ||
      !projection ||
      projection.name !== expected.name ||
      projection.description !== expected.description ||
      projection.materialization !== undefined ||
      Object.keys(projection.references ?? {}).length
    )
      return yield* refuse("The source archive is not the exact original single-file publication.")
    const store = yield* Store
    const paths = new Set<string>()
    for (const file of source.files) {
      const retained = expected.files.find((item) => item.path === file.path)
      if (
        !retained ||
        paths.has(file.path) ||
        (yield* sha256(file.bytes)) !== retained.sha256 ||
        (yield* sha256(yield* store.readBytes("objects/" + retained.sha256))) !== retained.sha256
      )
        return yield* refuse("A retained source file differs from its frozen original bytes.")
      paths.add(file.path)
    }
    return source
  })
}

/** Read-only preflight for the one already-attached source artifact, if present. */
export function originalZeroSourceBundle(
  receipt: Receipt,
  originalCount: number,
  pageId: string,
  guards: Readonly<Record<string, unknown>>,
) {
  return Effect.gen(function* () {
    const prefix = receipt.intents.slice(0, originalCount)
    const allocations = prefix.flatMap((intent, index) =>
      intent.path === "v1/file_uploads" ? [{ intent, index }] : [],
    )
    if (!allocations.length) return undefined
    if (
      allocations.length !== 1 ||
      receipt.portable.kind !== "skill" ||
      receipt.portable.files.length !== 1 ||
      receipt.portable.files[0]!.path !== receipt.portable.main ||
      pageId !== receipt.page_id
    )
      return yield* refuse(
        "Existing source artifacts require the bounded original root-only archive proof.",
      )
    const { intent: allocation, index } = allocations[0]!
    const artifact = allocation.artifact,
      id = property(allocation.response).id
    const send = prefix[index + 1]
    const attachment = prefix[index + 2]
    const allocationBody = property(allocation.body)
    const body = property(attachment?.body),
      properties = property(body.properties)
    const entries = Object.entries(properties)
    const ownerFields = property(property(guards["v1/pages/" + receipt.page_id]).properties)
    const sourceField =
      Object.values(ownerFields)
        .map(property)
        .find((field) => field.id === "notion%3A%2F%2Fskills%2Ffiles_property") ??
      property(ownerFields.Files)
    const files = entries.length === 1 ? property(entries[0]![1]).files : undefined
    const file = Array.isArray(files) && files.length === 1 ? property(files[0]) : undefined
    if (
      allocation.status !== "completed" ||
      allocation.method !== "POST" ||
      allocation.recovery ||
      property(allocation.response).status !== "uploaded" ||
      allocationBody.filename !== BUNDLE ||
      allocationBody.mode !== "single_part" ||
      Object.keys(allocationBody).length !== 2 ||
      !artifact ||
      artifact.filename !== BUNDLE ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.byte_length) ||
      artifact.byte_length <= 0 ||
      artifact.suboperation_id !== receipt.operation_id + ":upload:" + index ||
      typeof id !== "string" ||
      !id ||
      send?.status !== "completed" ||
      send.method !== "POST" ||
      send.path !== "v1/file_uploads/" + id + "/send" ||
      send.recovery ||
      property(send.response).status !== "uploaded" ||
      (property(send.response).id !== undefined && property(send.response).id !== id) ||
      attachment?.status !== "completed" ||
      attachment.method !== "PATCH" ||
      attachment.recovery ||
      attachment.path !== "v1/pages/" + receipt.page_id ||
      Object.keys(body).length !== 1 ||
      sourceField.type !== "files" ||
      typeof sourceField.id !== "string" ||
      (entries[0]?.[0] !== sourceField.id && entries[0]?.[0] !== "Files") ||
      !file ||
      file.name !== BUNDLE ||
      file.type !== "file_upload" ||
      property(file.file_upload).id !== id
    )
      return yield* refuse(
        "The original allocation, send and Files ACK do not identify one source artifact.",
      )
    const beforeBody = guards["v1/pages/" + pageId + "/markdown"]
    if (typeof beforeBody !== "string")
      return yield* refuse("The original source projection has no full body guard.")
    const store = yield* Store
    const bytes = yield* store.readBytes("uploads/" + artifact.sha256 + "/" + BUNDLE)
    if (bytes.length !== artifact.byte_length || (yield* sha256(bytes)) !== artifact.sha256)
      return yield* refuse("The original source artifact failed its frozen byte checksum.")
    const source = yield* frozenSourceMatches(receipt, yield* decodeBundle(bytes))
    if (!samePublishedMarkdown(beforeBody, source.projection!.body, sameRelativeFileDestination))
      return yield* refuse(
        "The original archive projection differs from its retained complete before-image.",
      )
    return { bytes, source, allocation_index: index, attachment_index: index + 2, upload_id: id }
  })
}

/**
 * Notion's attached Files entry may omit an id. Only the original root-only
 * source bundle can use its frozen bytes and allocation/send/Files ACK chain
 * instead. Names and expiring URLs alone are never attachment identity.
 */
export function proveRetainedZeroListOwner(
  receipt: Receipt,
  originalCount: number,
  pageId: string,
  guards: Readonly<Record<string, unknown>>,
  currentRaw: unknown,
) {
  return Effect.gen(function* () {
    const retained = guards["v1/pages/" + pageId],
      current = metadata(currentRaw)
    if (stableListOwner(retained, pageId) && stableListOwner(current, pageId)) return true
    if (
      pageId !== receipt.page_id ||
      property(retained).id !== pageId ||
      property(current).id !== pageId
    )
      return false
    const original = yield* originalZeroSourceBundle(receipt, originalCount, pageId, guards)
    if (!original) return false
    const attachment = receipt.intents[original.attachment_index]!
    const entries = Object.entries(property(property(attachment.body).properties))
    if (entries.length !== 1) return false
    const requestedKey = entries[0]![0]
    const sourceField = (owner: unknown) => {
      const fields = property(property(owner).properties)
      const matching = Object.entries(fields).filter(
        ([key, value]) => property(value).id === requestedKey || key === requestedKey,
      )
      if (matching.length !== 1) return
      const [name, raw] = matching[0]!,
        field = property(raw)
      if (
        field.type !== "files" ||
        typeof field.id !== "string" ||
        !field.id ||
        !Array.isArray(field.files) ||
        field.files.length !== 1 ||
        field.has_more === true ||
        field.next_cursor != null
      )
        return
      const file = property(field.files[0])
      if (file.name !== BUNDLE || file.type !== "file" || file.id !== undefined) return
      for (const [key, rawOther] of Object.entries(fields)) {
        if (key === name) continue
        const other = property(rawOther)
        if (other.type !== "files" && !("files" in other)) continue
        if (
          !Array.isArray(other.files) ||
          other.files.some((value) => typeof property(value).id !== "string" || !property(value).id)
        )
          return
      }
      return { name, field, file }
    }
    const before = sourceField(retained),
      after = sourceField(current),
      raw = sourceField(currentRaw)
    if (
      !before ||
      !after ||
      !raw ||
      before.name !== after.name ||
      after.name !== raw.name ||
      canonical(before.field) !== canonical(after.field)
    )
      return false
    const file = raw.file
    if (
      Object.keys(file).some((key) => !["name", "type", "file"].includes(key)) ||
      typeof property(file.file).url !== "string" ||
      !property(file.file).url
    )
      return false
    return yield* verifyAttachedUpload(currentRaw, attachment, receipt)
  })
}

/**
 * A display-only zero correction must not allocate another source artifact just
 * because the live projection changed. Both archives must contain the exact
 * frozen source; the original upload/Files ACK and full current zero effect
 * remain independently checked. The ordinary attachment proof and final
 * exported-file verification still run after this artifact selection.
 */
export function zeroListSourceBundleInput(
  receipt: Receipt,
  api: Notion["Service"],
  input: Uint8Array,
  filename: string,
) {
  return Effect.gen(function* () {
    if (filename !== BUNDLE || !receipt.intents.some((intent) => intent.zero_list_repair))
      return input
    const history = publicationZeroListHistory(receipt)
    if (
      !history ||
      receipt.conflict ||
      !receipt.stages.includes("zero_list_repair_verified") ||
      history.terminal.intent.status !== "completed"
    )
      return yield* refuse(
        "Source artifact selection requires the independently reconciled zero correction.",
      )
    const original = yield* originalZeroSourceBundle(
      receipt,
      history.repair.original_intent_count,
      history.repair.original.page_id,
      history.first.intent.guards!,
    )
    if (!original) return input
    const current = yield* frozenSourceMatches(receipt, yield* decodeBundle(input))
    const body = receipt.guards["v1/pages/" + receipt.page_id + "/markdown"]
    if (typeof body !== "string")
      return yield* refuse("The requested source archive projection has no complete current body.")
    const converted = fromNotionMarkdown(body)
    // References-backed checkpoints also localize page and filename links before
    // constructing their archive projection. This bounded source has no children;
    // its only page/path mapping is the original root. Compare that deterministic
    // projection exactly, with the full raw body and physical proof still below.
    const local = rewritePageLinks(
      converted,
      receipt.portable.main,
      [
        {
          id: history.repair.original.page_id,
          path: receipt.portable.main,
          markdown: body,
        },
      ],
      "local",
    )
    if (
      current.projection!.body !== bodyIdentity(converted) &&
      current.projection!.body !== bodyIdentity(local)
    )
      return yield* refuse(
        "The requested source archive projection is not its complete current body.",
      )
    yield* verifyCompletedZeroListRepair(
      receipt,
      history.terminal.intent,
      history.repair.original.intended_hash,
      api,
    )
    return original.bytes
  })
}
