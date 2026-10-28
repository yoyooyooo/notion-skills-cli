import { retainedUploadCertificates } from "./publication-retained-upload.ts"
import { publicationZeroListHistory } from "./publication-zero-list-history.ts"
import { zeroListSourceBundleInput } from "./publication-zero-list-source.ts"
import { Effect, Path } from "effect"
import { HttpClient } from "effect/http"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { requestTimeoutMs } from "./request-timeout.ts"
import { Store, sha256 } from "./store.ts"
import type { PublicationOptions } from "./publication.ts"
import type { Receipt } from "./publication-model.ts"

type Intent = Receipt["intents"][number]
type Artifact = NonNullable<Intent["artifact"]>

export function isUploadIntent(intent: Intent) {
  return (
    intent.path === "v1/file_uploads" ||
    /^v1\/file_uploads\/[^/]+\/(?:send|complete)$/.test(intent.path)
  )
}
export function unresolvedIntent(intent: Intent) {
  return !intent.recovery && (intent.status === "unknown" || intent.status === "pending")
}
function uploadPath(intent: Intent) {
  if (intent.path === "v1/file_uploads") {
    const id = property(intent.response).id
    return typeof id === "string" ? `v1/file_uploads/${id}` : undefined
  }
  return /^v1\/file_uploads\/[^/]+\/(?:send|complete)$/.test(intent.path)
    ? intent.path.replace(/\/(?:send|complete)$/, "")
    : undefined
}
function retainedZeroUpload(intent: Intent, receipt?: Receipt) {
  const index = receipt?.intents.indexOf(intent) ?? -1
  const history = receipt && publicationZeroListHistory(receipt)
  return (
    history &&
    index >= 0 &&
    index < history.repair.original_intent_count &&
    intent.status === "completed"
  )
}
/** An unreferenced unknown allocation retained as history, never an ACK. */
export function retainedTerminalUploadOrphan(
  receipt: Receipt,
  intent: Intent,
  index = receipt.intents.indexOf(intent),
) {
  const artifact = intent.artifact
  const body = property(intent.body)
  return (
    index === receipt.intents.length - 1 &&
    index >= 0 &&
    intent.path === "v1/file_uploads" &&
    intent.method === "POST" &&
    intent.status === "unknown" &&
    !intent.response &&
    intent.recovery?.kind === "remote_orphan" &&
    intent.recovery.replacement_suboperation_id ===
      `${receipt.operation_id}:upload:replacement:${index}` &&
    Object.keys(body).length === 2 &&
    body.filename === "ntn-skills-source.zip" &&
    body.mode === "single_part" &&
    artifact?.suboperation_id === `${receipt.operation_id}:upload:${index}` &&
    artifact.filename === body.filename &&
    /^[0-9a-f]{64}$/.test(artifact.sha256) &&
    Number.isSafeInteger(artifact.byte_length) &&
    artifact.byte_length > 0 &&
    !receipt.intents.some(
      (item, itemIndex) =>
        itemIndex !== index &&
        (isUploadIntent(item) || item.recovery || JSON.stringify(item).includes(artifact.sha256)),
    )
  )
}
export function proveRetainedTerminalUploadOrphan(receipt: Receipt) {
  return Effect.gen(function* () {
    const index = receipt.intents.length - 1
    const intent = receipt.intents[index]
    if (!intent || !retainedTerminalUploadOrphan(receipt, intent, index))
      return yield* Effect.fail(
        fail(
          "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
          "The terminal upload is not the exact retained unattached artifact.",
        ),
      )
    const artifact = intent.artifact!
    const bytes = yield* (yield* Store).readBytes(`uploads/${artifact.sha256}/${artifact.filename}`)
    if (bytes.length !== artifact.byte_length || (yield* sha256(bytes)) !== artifact.sha256)
      return yield* Effect.fail(
        fail(
          "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
          "The retained upload artifact bytes differ from their original allocation.",
        ),
      )
    return { index, artifact }
  })
}
export function observeUpload(intent: Intent, receipt?: Receipt) {
  return Effect.gen(function* () {
    if (intent.recovery?.kind === "retained_unusable") {
      const certificates = receipt && retainedUploadCertificates(receipt)
      const covered = certificates?.[0]
      if (
        !covered ||
        !covered.sequence.covered_indices.some(
          (index) =>
            receipt!.intents[index] === intent ||
            JSON.stringify(receipt!.intents[index]) === JSON.stringify(intent),
        )
      )
        return {
          path: intent.path,
          outcome: "unknown" as const,
          reason: "The retained upload certificate does not bind this original intent.",
        }
      return {
        path: intent.path,
        outcome: "success" as const,
        reason:
          "Original unusable upload and its recorded outcome are retained; replacement is independent.",
      }
    }
    if (intent.recovery)
      return {
        path: intent.path,
        outcome: "success" as const,
        reason:
          "Original unknown retained as a remote orphan; replacement is a separate suboperation.",
      }
    const path = uploadPath(intent)
    if (!path)
      return {
        path: intent.path,
        outcome: "unknown" as const,
        reason: "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
      }
    const api = yield* Notion
    const result = yield* api.request(path).pipe(Effect.result)
    if (result._tag === "Failure")
      return { path, outcome: "unknown" as const, reason: result.failure.code }
    const raw = property(result.success)
    if (
      raw.id !== path.split("/")[2] ||
      !["pending", "uploaded", "expired", "failed"].includes(String(raw.status))
    )
      return { path, outcome: "unknown" as const, reason: "INVALID_RESPONSE" }
    const retainedZero = retainedZeroUpload(intent, receipt)
    if (!retainedZero)
      intent.response = {
        ...property(intent.response),
        id: raw.id,
        status: raw.status,
        expiry_time: raw.expiry_time,
      }
    if (raw.status === "uploaded") return { path, outcome: "success" as const }
    if (retainedZero)
      return { path, outcome: "unknown" as const, reason: "PUBLICATION_ZERO_SOURCE_UNPROVEN" }
    return {
      path,
      outcome:
        intent.path === "v1/file_uploads" &&
        intent.status === "completed" &&
        raw.status === "pending"
          ? ("success" as const)
          : ("unknown" as const),
      reason: "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
    }
  })
}

/** No allocation lookup by filename, and no replay of an uncertain send. Called after full page guards. */
export function recoverUploadIntents(receipt: Receipt, options: PublicationOptions) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const retained = retainedUploadCertificates(receipt)
    if (!retained)
      return yield* Effect.fail(
        fail("PUBLICATION_UNRESOLVED", "The retained upload certificate is invalid."),
      )
    for (const intent of receipt.intents.filter(
      (item) =>
        item.path === "v1/file_uploads" &&
        item.status === "completed" &&
        !item.recovery &&
        item.artifact,
    )) {
      const observed = yield* observeUpload(intent, receipt)
      if (retainedZeroUpload(intent, receipt) && observed.outcome !== "success")
        return yield* Effect.fail(
          fail(
            "PUBLICATION_ZERO_SOURCE_UNPROVEN",
            "The retained original source upload no longer has a successful current lifecycle.",
          ),
        )
    }
    const pending = receipt.intents.filter(
      (intent) =>
        isUploadIntent(intent) &&
        !intent.recovery &&
        (unresolvedIntent(intent) ||
          (intent.path === "v1/file_uploads" &&
            ((!intent.artifact &&
              !receipt.intents.some(
                (item) =>
                  item.status === "completed" &&
                  !isUploadIntent(item) &&
                  JSON.stringify(item.body ?? null).includes(String(property(intent.response).id)),
              )) ||
              ["expired", "failed"].includes(String(property(intent.response).status))))),
    )
    for (const intent of pending) {
      if (intent.recovery) continue
      if (retainedZeroUpload(intent, receipt))
        return yield* Effect.fail(
          fail(
            "PUBLICATION_ZERO_SOURCE_UNPROVEN",
            "The immutable original source upload cannot be reassigned or sent again.",
          ),
        )
      const observation = yield* observeUpload(intent, receipt)
      const allocation = receipt.intents.find(
        (item) => item.path === "v1/file_uploads" && uploadPath(item) === uploadPath(intent),
      )
      if (observation.outcome === "success" && allocation?.artifact) {
        intent.status = "completed"
        continue
      }
      const path = uploadPath(intent)
      // An unavailable observation is not evidence that a known upload is unattached.
      if (
        path &&
        observation.outcome !== "success" &&
        observation.reason !== "PUBLICATION_UPLOAD_RECOVERY_REQUIRED"
      )
        return yield* Effect.fail(
          fail(
            observation.reason ?? "PUBLICATION_UNRESOLVED",
            "Could not observe the known upload before recovery.",
            {
              path,
              next: { argv: ["ntn-skills", "operation", "reconcile", receipt.operation_id] },
            },
          ),
        )
      if (retained.length > 0)
        return yield* Effect.fail(
          fail(
            "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
            "The independent replacement has an unresolved resource lifecycle; another automatic allocation is forbidden.",
          ),
        )
      if (!options.newArtifact)
        return yield* Effect.fail(
          fail(
            "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
            "The upload outcome cannot be replayed. Authorize a separate artifact after observing the original page.",
            {
              path: intent.path,
              next: {
                argv: ["ntn-skills", "operation", "resume", receipt.operation_id, "--new-artifact"],
              },
            },
          ),
        )
      const id = path?.split("/")[2]
      if (id) {
        const raw = property(yield* api.request(path!))
        if (
          raw.expiry_time === null ||
          typeof raw.expiry_time !== "string" ||
          receipt.intents.some(
            (item) => !isUploadIntent(item) && JSON.stringify(item.body ?? null).includes(id),
          )
        )
          return yield* Effect.fail(
            fail(
              "PUBLICATION_UNRESOLVED",
              "An attached or possibly referenced upload cannot be abandoned.",
              {
                upload_id: id,
                next: { argv: ["ntn-skills", "operation", "reconcile", receipt.operation_id] },
              },
            ),
          )
      }
      if (
        !id &&
        receipt.intents
          .slice(receipt.intents.indexOf(intent) + 1)
          .some((item) => !isUploadIntent(item))
      )
        return yield* Effect.fail(
          fail(
            "PUBLICATION_UNRESOLVED",
            "Unknown allocation has later mutations and cannot be proven unreferenced.",
          ),
        )
      const replacement = `${receipt.operation_id}:upload:replacement:${receipt.intents.indexOf(intent)}`
      for (const related of receipt.intents.filter(
        (item) => item === intent || (id && uploadPath(item) === path),
      ))
        related.recovery = { kind: "remote_orphan", replacement_suboperation_id: replacement }
    }
  })
}

/** One artifact identity covers allocation, send, and the later attachment proof. */
export function publicationUpload(
  receipt: Receipt,
  notion: Notion["Service"],
  persist: () => Effect.Effect<void, SkillsError>,
  tag: (artifact: Artifact | undefined) => void,
  input: { bytes: Uint8Array },
  filename: string,
) {
  return Effect.gen(function* () {
    const bytes = yield* zeroListSourceBundleInput(receipt, notion, input.bytes, filename)
    if (bytes.length > 20 * 1024 * 1024)
      return yield* Effect.fail(
        fail("FILE_TOO_LARGE", "Direct upload supports files up to 20 MiB.", { path: filename }),
      )
    const hash = yield* sha256(bytes)
    const retained = retainedUploadCertificates(receipt)
    if (
      !retained ||
      retained.some(
        (item) =>
          item.sequence.artifact.sha256 !== hash ||
          item.sequence.artifact.byte_length !== bytes.length ||
          item.sequence.artifact.filename !== filename,
      )
    )
      return yield* Effect.fail(
        fail(
          "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
          "Replacement bytes differ from the original proven source artifact.",
        ),
      )
    const store = yield* Store
    const path = yield* Path.Path
    const key = `uploads/${hash}/${filename}`
    yield* store.writeBytes(key, bytes)
    const candidate = [...receipt.intents]
      .reverse()
      .find(
        (item) =>
          item.path === "v1/file_uploads" &&
          !item.recovery &&
          item.artifact?.sha256 === hash &&
          item.artifact.filename === filename &&
          item.status === "completed",
      )
    let id: string | undefined
    let status: unknown
    if (candidate) {
      if (
        retained.some(
          (item) =>
            candidate.artifact?.suboperation_id !== item.certificate.replacement_suboperation_id,
        )
      )
        return yield* Effect.fail(
          fail(
            "PUBLICATION_UNRESOLVED",
            "The replacement allocation belongs to a different suboperation.",
          ),
        )
      id = String(property(candidate.response).id)
      const observed = property(yield* notion.request(`v1/file_uploads/${id}`))
      if (observed.id !== id)
        return yield* Effect.fail(
          fail("INVALID_RESPONSE", "Upload observation returned a different identity."),
        )
      status = observed.status
      if (retainedZeroUpload(candidate, receipt) && status !== "uploaded")
        return yield* Effect.fail(
          fail(
            "PUBLICATION_ZERO_SOURCE_UNPROVEN",
            "The immutable original source upload is no longer completely uploaded.",
          ),
        )
      if (status !== "uploaded" && status !== "pending")
        return yield* Effect.fail(
          fail(
            "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
            "The retained artifact is no longer usable; authorize a separate artifact.",
            {
              upload_id: id,
              next: {
                argv: ["ntn-skills", "operation", "resume", receipt.operation_id, "--new-artifact"],
              },
            },
          ),
        )
    } else {
      if (
        receipt.intents.some(
          (item) =>
            item.path === "v1/file_uploads" &&
            !item.recovery &&
            !item.artifact &&
            !receipt.intents.some(
              (attached) =>
                attached.status === "completed" &&
                !isUploadIntent(attached) &&
                JSON.stringify(attached.body ?? null).includes(String(property(item.response).id)),
            ),
        )
      )
        return yield* Effect.fail(
          fail(
            "PUBLICATION_UNRESOLVED",
            "A retained allocation has no frozen artifact identity; automatic replacement is forbidden.",
            { next: { argv: ["ntn-skills", "operation", "reconcile", receipt.operation_id] } },
          ),
        )
      if (
        retained.some((item) =>
          receipt.intents.some(
            (intent) =>
              intent.artifact?.suboperation_id === item.certificate.replacement_suboperation_id,
          ),
        )
      )
        return yield* Effect.fail(
          fail(
            "PUBLICATION_UNRESOLVED",
            "The independent allocation has no acknowledged reusable identity.",
          ),
        )
      const replacement = [...receipt.intents]
        .reverse()
        .find(
          (item) =>
            item.recovery &&
            !receipt.intents.some(
              (other) =>
                other.artifact?.suboperation_id === item.recovery?.replacement_suboperation_id,
            ),
        )?.recovery?.replacement_suboperation_id
      const artifact: Artifact = {
        suboperation_id: replacement ?? `${receipt.operation_id}:upload:${receipt.intents.length}`,
        filename,
        sha256: hash,
        byte_length: bytes.length,
      }
      tag(artifact)
      const allocated = yield* notion
        .request("v1/file_uploads", { filename, mode: "single_part" })
        .pipe(Effect.ensuring(Effect.sync(() => tag(undefined))))
      const raw = property(allocated)
      if (typeof raw.id !== "string")
        return yield* Effect.fail(
          fail("WRITE_OUTCOME_UNKNOWN", "File allocation returned no identity.", {
            next: {
              argv: ["ntn-skills", "operation", "resume", receipt.operation_id, "--new-artifact"],
            },
          }),
        )
      id = raw.id
      status = raw.status
    }
    if (status !== "uploaded") {
      const sent = property(
        yield* notion.request(`v1/file_uploads/${id}/send`, undefined, {
          method: "POST",
          file: path.join(store.root, key),
        }),
      )
      if ((sent.id !== undefined && sent.id !== id) || sent.status !== "uploaded")
        return yield* Effect.fail(
          fail("PUBLICATION_UPLOAD_RECOVERY_REQUIRED", "The upload has not completed.", {
            upload_id: id,
            next: { argv: ["ntn-skills", "operation", "reconcile", receipt.operation_id] },
          }),
        )
    }
    const allocation = receipt.intents.find(
      (item) => item.path === "v1/file_uploads" && property(item.response).id === id,
    )
    if (allocation && !retainedZeroUpload(allocation, receipt))
      allocation.response = { ...property(allocation.response), status: "uploaded" }
    yield* persist()
    return { name: filename, type: "file_upload" as const, file_upload: { id: id! } }
  })
}

export function verifyAttachedUpload(raw: unknown, intent: Intent, receipt: Receipt) {
  return Effect.gen(function* () {
    const changes = property(property(intent.body).properties)
    const current = property(property(raw).properties)
    const entry = Object.entries(changes).find(([, value]) => Array.isArray(property(value).files))
    if (!entry) return false
    const [key, value] = entry
    const files = property(value).files
    const clean = (raw: unknown): unknown => {
      if (Array.isArray(raw)) return raw.map(clean)
      if (!raw || typeof raw !== "object") return raw
      return Object.fromEntries(
        Object.entries(raw)
          .filter(
            ([name, item]) =>
              !["type", "plain_text", "href", "annotations"].includes(name) &&
              !(name === "link" && item === null),
          )
          .map(([name, item]) => [name, clean(item)]),
      )
    }
    for (const [name, target] of Object.entries(changes)) {
      if (name === key) continue
      const field = property(
        Object.values(current).find((item) => property(item).id === name) ?? current[name],
      )
      if (
        !Object.entries(property(target)).every(
          ([kind, value]) => JSON.stringify(clean(field[kind])) === JSON.stringify(clean(value)),
        )
      )
        return false
    }
    const actual =
      Object.values(current)
        .map(property)
        .find((item) => item.id === key) ?? property(current[key])
    if (
      !Array.isArray(files) ||
      files.length !== 1 ||
      !Array.isArray(actual.files) ||
      actual.files.length !== 1
    )
      return false
    const uploadId = property(property(files[0]).file_upload).id
    const allocation = receipt.intents.find(
      (item) => item.path === "v1/file_uploads" && property(item.response).id === uploadId,
    )
    if (!allocation?.artifact) return false
    const file = property(actual.files[0])
    if (file.name !== allocation.artifact.filename) return false
    const url = property(file[String(file.type)]).url
    if (typeof url !== "string") return false
    const timeoutMs = yield* requestTimeoutMs
    const client = HttpClient.withScope(yield* HttpClient.HttpClient)
    const bytes = yield* Effect.scoped(
      Effect.gen(function* () {
        const response = yield* client.get(url)
        if (response.status !== 200)
          return yield* Effect.fail(
            fail("DOWNLOAD_FAILED", "Could not read the attachment for upload recovery.", {
              status: response.status,
            }),
          )
        return new Uint8Array(yield* response.arrayBuffer)
      }),
    ).pipe(
      Effect.timeout(timeoutMs),
      Effect.mapError((error) =>
        error instanceof SkillsError
          ? error
          : fail("DOWNLOAD_FAILED", "Attachment recovery read failed."),
      ),
    )
    return (
      bytes.length === allocation.artifact.byte_length &&
      (yield* sha256(bytes)) === allocation.artifact.sha256
    )
  })
}
