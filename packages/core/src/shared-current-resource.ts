import { Clock, Effect, FileSystem, Option, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { RequestBudget } from "./request-budget.ts"
import { requestTimeoutMs } from "./request-timeout.ts"
import { CurrentResourceContentSchema } from "./shared-current-file.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  ImmutableByteReadPolicy,
  makeBoundedImmutableReadCoalescer,
} from "./shared-immutable-read.ts"
import {
  canonicalSharedJson,
  createCurrentSharedResourceRecord,
  queryCurrentSharedResourceRecord,
  validateSharedRecordEnvelope,
  type SharedRecord,
} from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

export { CurrentResourceContentSchema } from "./shared-current-file.ts"
export type CurrentResourceContent = typeof CurrentResourceContentSchema.Type
export const CURRENT_RESOURCE_INLINE_BYTES = 32 * 1024
export const CURRENT_RESOURCE_MAX_BYTES = 64 * 1024 * 1024
const pendingBytes = Effect.runSync(
  makeBoundedImmutableReadCoalescer<Uint8Array>({ entries: 64, bytes: 16 * 1024 * 1024 }),
)

const InlineStorageSchema = Schema.Struct({
  kind: Schema.Literal("inline"),
  encoding: Schema.Literal("base64"),
  data: Schema.String,
})
const AttachmentStorageSchema = Schema.Struct({ kind: Schema.Literal("attachment") })
export const CurrentResourceManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("resource"),
  sha256: CurrentResourceContentSchema.fields.sha256,
  bytes: CurrentResourceContentSchema.fields.bytes,
  mode: CurrentResourceContentSchema.fields.mode,
  storage: Schema.Union([InlineStorageSchema, AttachmentStorageSchema]),
})
export type CurrentResourceManifest = typeof CurrentResourceManifestSchema.Type
export type PreparedCurrentSharedResource = {
  readonly content: CurrentResourceContent
  readonly manifest: CurrentResourceManifest
} & (
  | { readonly status: "inline" }
  | { readonly status: "needs_attachment"; readonly bytes: Uint8Array }
)

const invalid = (message: string) => fail("SHARED_RESOURCE_INVALID", message)
function checked<A>(action: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The current resource is invalid."),
  })
}
function decodeInline(data: string, size: number): Uint8Array {
  if (
    size > CURRENT_RESOURCE_INLINE_BYTES ||
    data.length > 4 * Math.ceil(CURRENT_RESOURCE_INLINE_BYTES / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)
  )
    throw invalid("An inline resource has invalid size or Base64 framing.")
  const bytes = new Uint8Array(Buffer.from(data, "base64"))
  if (bytes.byteLength !== size || Buffer.from(bytes).toString("base64") !== data)
    throw invalid("An inline resource does not match its complete canonical bytes.")
  return bytes
}

/** The descriptor, current manifest and byte identity are validated together. */
export function validateCurrentSharedResourceManifest(
  contentInput: unknown,
  manifestInput: unknown,
) {
  return Effect.gen(function* () {
    const { content, manifest, inline } = yield* checked(() => {
      const content = Schema.decodeUnknownSync(CurrentResourceContentSchema)(contentInput, {
        onExcessProperty: "error",
      })
      const manifest = Schema.decodeUnknownSync(CurrentResourceManifestSchema)(manifestInput, {
        onExcessProperty: "error",
      })
      if (
        !Number.isSafeInteger(content.bytes) ||
        content.bytes < 0 ||
        content.bytes > CURRENT_RESOURCE_MAX_BYTES
      )
        throw fail("SHARED_RESOURCE_TOO_LARGE", "One current resource may contain at most 64 MiB.")
      if (
        content.sha256 !== manifest.sha256 ||
        content.bytes !== manifest.bytes ||
        content.mode !== manifest.mode
      )
        throw invalid("The current resource manifest differs from its selected descriptor.")
      if (manifest.storage.kind === "attachment" && manifest.bytes <= CURRENT_RESOURCE_INLINE_BYTES)
        throw invalid("Small current resources use one inline Record.")
      const inline =
        manifest.storage.kind === "inline"
          ? decodeInline(manifest.storage.data, manifest.bytes)
          : undefined
      validateSharedRecordEnvelope(`store-${content.object_id}`, manifest, "resource")
      return { content, manifest, inline }
    })
    if (content.object_id !== `resource-${yield* sha256(canonicalSharedJson(manifest))}`)
      return yield* Effect.fail(
        invalid("The current resource manifest failed its locator checksum."),
      )
    if (inline !== undefined && (yield* sha256(inline)) !== content.sha256)
      return yield* Effect.fail(invalid("The complete inline resource failed its checksum."))
    return { content, manifest }
  })
}

/** Large files remain one original attachment. Preparation never allocates or uploads remotely. */
export function prepareCurrentSharedResource(
  input: Uint8Array,
  mode: CurrentResourceContent["mode"],
) {
  return Effect.gen(function* () {
    const bytes = yield* checked(() => {
      if (!(input instanceof Uint8Array) || input.byteLength > CURRENT_RESOURCE_MAX_BYTES)
        throw fail(
          "SHARED_RESOURCE_TOO_LARGE",
          "Select one complete current resource of at most 64 MiB.",
        )
      if (mode !== "100644" && mode !== "100755")
        throw invalid("A current resource requires its exact file mode.")
      return new Uint8Array(input)
    })
    const manifest: CurrentResourceManifest = {
      version: 1,
      kind: "resource",
      sha256: yield* sha256(bytes),
      bytes: bytes.byteLength,
      mode,
      storage:
        bytes.byteLength <= CURRENT_RESOURCE_INLINE_BYTES
          ? { kind: "inline", encoding: "base64", data: Buffer.from(bytes).toString("base64") }
          : { kind: "attachment" },
    }
    const content: CurrentResourceContent = {
      kind: "resource",
      object_id: `resource-${yield* sha256(canonicalSharedJson(manifest))}`,
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      mode,
    }
    yield* validateCurrentSharedResourceManifest(content, manifest)
    return manifest.storage.kind === "inline"
      ? ({ status: "inline", content, manifest } satisfies PreparedCurrentSharedResource)
      : ({
          status: "needs_attachment",
          content,
          manifest,
          bytes,
        } satisfies PreparedCurrentSharedResource)
  })
}

export function validatePreparedCurrentSharedResource(input: unknown) {
  return Effect.gen(function* () {
    const raw = property(input)
    const { content, manifest } = yield* validateCurrentSharedResourceManifest(
      raw.content,
      raw.manifest,
    )
    const bytes = yield* checked(() => {
      if (raw.status === "inline" && manifest.storage.kind === "inline")
        return decodeInline(manifest.storage.data, manifest.bytes)
      if (
        raw.status !== "needs_attachment" ||
        manifest.storage.kind !== "attachment" ||
        !(raw.bytes instanceof Uint8Array)
      )
        throw invalid("Resource preparation does not match its current storage representation.")
      if (raw.bytes.byteLength !== content.bytes)
        throw invalid("The prepared attachment has a different byte length.")
      return new Uint8Array(raw.bytes)
    })
    if ((yield* sha256(bytes)) !== content.sha256)
      return yield* Effect.fail(invalid("The prepared attachment failed its exact checksum."))
    return { content, manifest, bytes }
  })
}

function resourceRecord(record: SharedRecord, content: CurrentResourceContent) {
  if (
    record.kind !== "resource" ||
    record.record_id !== content.object_id ||
    record.entity_id !== content.object_id ||
    record.operation_id !== `store-${content.object_id}`
  )
    throw invalid("A current resource requires its exact current Record identity.")
}

/** Same-response payload and Resource property; never an old object or history lookup. */
export function loadCurrentSharedResourceManifest(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly content: CurrentResourceContent },
) {
  return Effect.gen(function* () {
    const content = yield* checked(() =>
      Schema.decodeUnknownSync(CurrentResourceContentSchema)(input.content, {
        onExcessProperty: "error",
      }),
    )
    const row = yield* queryCurrentSharedResourceRecord(library, {
      skillPageId: input.skillPageId,
      objectId: content.object_id,
    })
    if (row === undefined)
      return yield* Effect.fail(
        fail("SHARED_RESOURCE_UNAVAILABLE", "The selected current resource is unavailable.", {
          object_id: content.object_id,
          next: "reselect_current",
        }),
      )
    yield* checked(() => resourceRecord(row.record, content))
    const validated = yield* validateCurrentSharedResourceManifest(content, row.record.payload)
    const files = yield* checked(() => {
      const field = property(row.resource)
      if (
        field.type !== "files" ||
        !Array.isArray(field.files) ||
        (field.has_more !== undefined && field.has_more !== false)
      )
        throw invalid("The current resource requires its complete registered Resource property.")
      const expected = validated.manifest.storage.kind === "inline" ? 0 : 1
      if (field.files.length !== expected)
        throw invalid("The current resource has an unexpected attachment count.")
      return field.files
    })
    return { ...validated, record: row.record, attachment: files[0] }
  })
}

function attachmentLocator(raw: unknown) {
  const attachment = property(raw),
    file = property(attachment.file)
  if (
    attachment.type !== "file" ||
    typeof attachment.name !== "string" ||
    !attachment.name ||
    typeof file.url !== "string" ||
    typeof file.expiry_time !== "string" ||
    !Number.isFinite(Date.parse(file.expiry_time))
  )
    throw invalid(
      "A current attachment requires one Notion-hosted file and an expiring download URL.",
    )
  const url = new URL(file.url)
  const host = url.hostname
  const notionHost =
    host === "secure.notion-static.com" ||
    host === "notionusercontent.com" ||
    host.endsWith(".notionusercontent.com")
  const notionBucket = /^prod-files-secure\.s3[.-][a-z0-9-]+\.amazonaws\.com$/u.test(host)
  const pathBucket =
    /^s3[.-][a-z0-9-]+\.amazonaws\.com$/u.test(host) &&
    url.pathname.startsWith("/secure.notion-static.com/")
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !(notionHost || notionBucket || pathBucket)
  )
    throw fail(
      "SHARED_RESOURCE_URL_REFUSED",
      "The current attachment URL is not an authorized Notion file location.",
    )
  return { url: url.href, expires: Date.parse(file.expiry_time) }
}

function downloadError(error: unknown): SkillsError {
  if (error instanceof SkillsError) return error
  const cause = property(property(error).reason).cause
  if (cause instanceof SkillsError) return cause
  return fail("SHARED_RESOURCE_DOWNLOAD_FAILED", "The current attachment request failed.")
}

function downloadAttachment(content: CurrentResourceContent, url: string) {
  return Effect.gen(function* () {
    const timeout = yield* requestTimeoutMs
    const client = HttpClient.withScope(yield* HttpClient.HttpClient)
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const response = yield* client.get(url, {
          headers: { accept: "application/octet-stream", "accept-encoding": "identity" },
        })
        const actual = yield* checked(() => new URL(response.request.url))
        const expected = new URL(url)
        if (actual.origin !== expected.origin || actual.pathname !== expected.pathname)
          return yield* Effect.fail(
            fail(
              "SHARED_RESOURCE_URL_REFUSED",
              "The attachment transport changed its origin or path.",
            ),
          )
        if (response.status !== 200)
          return yield* Effect.fail(
            fail("SHARED_RESOURCE_DOWNLOAD_FAILED", "The current attachment is unavailable.", {
              status: response.status,
            }),
          )
        const declared = response.headers["content-length"]
        if (
          declared !== undefined &&
          (!/^\d+$/u.test(declared) || Number(declared) !== content.bytes)
        )
          return yield* Effect.fail(
            invalid("Attachment Content-Length differs from the selected current resource."),
          )
        const chunks: Uint8Array[] = []
        const length = yield* response.stream.pipe(
          Stream.runFoldEffect(
            () => 0,
            (size, chunk) => {
              const next = size + chunk.byteLength
              if (next > content.bytes)
                return Effect.fail(invalid("The attachment exceeds its selected byte length."))
              chunks.push(chunk)
              return Effect.succeed(next)
            },
          ),
        )
        if (length !== content.bytes)
          return yield* Effect.fail(
            invalid("The attachment ended before its selected byte length."),
          )
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        if ((yield* sha256(bytes)) !== content.sha256)
          return yield* Effect.fail(invalid("The current attachment failed its content checksum."))
        return bytes
      }),
    ).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
      }),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            fail("SHARED_RESOURCE_TIMEOUT", "The attachment read exceeded its deadline."),
          ),
      }),
      Effect.mapError(downloadError),
    )
  })
}

/** Reads use the caller's bounded HTTP runtime and never upload, repair or adopt remotely. */
export function loadCurrentSharedResourceContent(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly content: CurrentResourceContent },
) {
  return Effect.gen(function* () {
    const first = yield* loadCurrentSharedResourceManifest(library, input)
    if (first.manifest.storage.kind === "inline") {
      const storage = first.manifest.storage
      return {
        content: first.content,
        manifest: first.manifest,
        bytes: yield* checked(() => decodeInline(storage.data, first.content.bytes)),
        verification: "remote_verified" as const,
      }
    }
    let current = first
    const page = current.record.page_id
    for (let attempt = 0; attempt < 2; attempt++) {
      const locator = yield* checked(() => attachmentLocator(current.attachment))
      const expired = locator.expires <= (yield* Clock.currentTimeMillis)
      const read = expired
        ? {
            _tag: "Failure" as const,
            failure: fail(
              "SHARED_RESOURCE_DOWNLOAD_FAILED",
              "The current attachment URL has expired.",
              { status: 403 },
            ),
          }
        : yield* downloadAttachment(current.content, locator.url).pipe(Effect.result)
      if (read._tag === "Success")
        return {
          content: current.content,
          manifest: current.manifest,
          bytes: read.success,
          verification: "remote_verified" as const,
        }
      if (
        attempt !== 0 ||
        read.failure.code !== "SHARED_RESOURCE_DOWNLOAD_FAILED" ||
        ![401, 403].includes(Number(property(read.failure.details).status))
      )
        return yield* Effect.fail(read.failure)
      current = yield* loadCurrentSharedResourceManifest(library, input)
      if (current.record.page_id !== page)
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_CHANGED",
            "The resource page changed while refreshing its attachment URL.",
            { next: "reselect_current" },
          ),
        )
    }
    return yield* Effect.fail(
      fail(
        "SHARED_RESOURCE_UNAVAILABLE",
        "The current attachment is unavailable after one URL refresh.",
      ),
    )
  })
}

/** Each caller must first verify its current owner and File descriptor. Only
 * pending exact bytes share a separate transport; eligibility and Store writes
 * stay with each caller. Completed results are never retained by this coalescer. */
export function readCurrentSharedResourceBytes(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly content: CurrentResourceContent },
) {
  const read = loadCurrentSharedResourceContent(library, input).pipe(
    Effect.map((value) => value.bytes),
  )
  return Effect.gen(function* () {
    const api = yield* Notion
    if (
      api.detachedReadContext === undefined ||
      Option.isSome(yield* Effect.serviceOption(RequestBudget))
    )
      return yield* read
    const detached = yield* api.detachedReadContext
    const store = yield* Store
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs
      .realPath(store.root)
      .pipe(
        Effect.mapError(() =>
          fail("STORAGE_ERROR", "Could not identify the current resource cache root."),
        ),
      )
    const policy = yield* ImmutableByteReadPolicy
    const identity = canonicalSharedJson([root, detached.identity, library, input, policy])
    const bytes = yield* pendingBytes.run(
      identity,
      input.content.bytes,
      detached.run(read),
      api.metrics,
    )
    return bytes.slice()
  })
}

/** Authorized management only. Unknown creates reconcile by stable ID; this helper never retries a write. */
export function storeCurrentSharedResource(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly prepared: PreparedCurrentSharedResource
    readonly mode: "create" | "reconcile"
    readonly upload?: { readonly id: string; readonly name: string }
    readonly beforeCreate?: Effect.Effect<void, SkillsError>
  },
) {
  return Effect.gen(function* () {
    const prepared = yield* validatePreparedCurrentSharedResource(input.prepared)
    if (
      input.mode === "create" &&
      prepared.manifest.storage.kind === "attachment" &&
      input.upload === undefined
    ) {
      const existing = yield* queryCurrentSharedResourceRecord(library, {
        skillPageId: input.skillPageId,
        objectId: prepared.content.object_id,
      })
      if (existing !== undefined) {
        const verified = yield* loadCurrentSharedResourceContent(library, {
          skillPageId: input.skillPageId,
          content: prepared.content,
        })
        return { ...verified, record: existing.record }
      }
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_UPLOAD_REQUIRED",
          "The management operation must supply the already uploaded original attachment.",
          { object_id: prepared.content.object_id, bytes: prepared.content.bytes },
        ),
      )
    }
    if (prepared.manifest.storage.kind === "inline" && input.upload !== undefined)
      return yield* Effect.fail(
        invalid("An inline resource cannot attach a second content carrier."),
      )
    const record = yield* createCurrentSharedResourceRecord(library, {
      skillPageId: input.skillPageId,
      objectId: prepared.content.object_id,
      payload: prepared.manifest,
      mode: input.mode,
      ...(input.upload === undefined ? {} : { upload: input.upload }),
      ...(input.beforeCreate === undefined ? {} : { beforeCreate: input.beforeCreate }),
    })
    const verified = yield* loadCurrentSharedResourceContent(library, {
      skillPageId: input.skillPageId,
      content: prepared.content,
    })
    return { ...verified, record }
  })
}
