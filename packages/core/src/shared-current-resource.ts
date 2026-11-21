import { Clock, Effect, FileSystem, Option, Schema, Stream } from "effect"
import { zipSync, type Zippable } from "fflate"
import { readImportZip } from "./import.ts"
import { normalizePath } from "./ref.ts"
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
import { canonicalSharedJson } from "./shared-records.ts"
import {
  currentOwnedResourceCreateRequest,
  currentOwnedResourceFromPage,
  queryCurrentOwnedResourceRecord,
  type CurrentResourceOwner,
} from "./shared-current-records.ts"
import { sha256, Store } from "./store.ts"

export { CurrentResourceContentSchema } from "./shared-current-file.ts"
export type CurrentResourceContent = typeof CurrentResourceContentSchema.Type
export const CURRENT_RESOURCE_INLINE_BYTES = 32 * 1024
export const CURRENT_RESOURCE_MAX_BYTES = 64 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = CURRENT_RESOURCE_MAX_BYTES + 64 * 1024
const pendingBytes = Effect.runSync(
  makeBoundedImmutableReadCoalescer<Uint8Array>({ entries: 64, bytes: 16 * 1024 * 1024 }),
)

const InlineStorageSchema = Schema.Struct({
  kind: Schema.Literal("inline"),
  encoding: Schema.Literal("base64"),
  data: Schema.String,
})
const AttachmentStorageSchema = Schema.Struct({ kind: Schema.Literal("attachment") })
const ZipAttachmentStorageSchema = Schema.Struct({
  kind: Schema.Literal("zip_attachment"),
  entry: Schema.String,
  bytes: CurrentResourceContentSchema.fields.bytes,
  sha256: CurrentResourceContentSchema.fields.sha256,
})
export const CurrentResourceManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("resource"),
  sha256: CurrentResourceContentSchema.fields.sha256,
  bytes: CurrentResourceContentSchema.fields.bytes,
  mode: CurrentResourceContentSchema.fields.mode,
  storage: Schema.Union([InlineStorageSchema, AttachmentStorageSchema, ZipAttachmentStorageSchema]),
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
      if (manifest.storage.kind === "zip_attachment") {
        archiveEntry(manifest.storage.entry)
        if (
          !Number.isSafeInteger(manifest.storage.bytes) ||
          manifest.storage.bytes <= 0 ||
          manifest.storage.bytes > MAX_ATTACHMENT_BYTES
        )
          throw invalid("The single-original attachment exceeds its wire byte limit.")
      }
      const inline =
        manifest.storage.kind === "inline"
          ? decodeInline(manifest.storage.data, manifest.bytes)
          : undefined
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

function archiveEntry(input: string): string {
  if (
    typeof input !== "string" ||
    !input ||
    new TextEncoder().encode(input).byteLength > 4096 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(input) ||
    normalizePath(input) !== input
  )
    throw invalid("A single-original ZIP needs one bounded canonical relative file path.")
  return input
}

function originalZip(bytes: Uint8Array, mode: CurrentResourceContent["mode"], entry: string) {
  const entries: Zippable = Object.create(null)
  entries[entry] = [
    bytes,
    {
      mtime: new Date(1980, 0, 1),
      level: 0,
      os: 3,
      attrs: ((mode === "100755" ? 0o100755 : 0o100644) << 16) >>> 0,
    },
  ]
  return zipSync(entries)
}

function attachmentBytes(
  content: CurrentResourceContent,
  manifest: CurrentResourceManifest,
  input: Uint8Array,
) {
  return Effect.gen(function* () {
    const storage = manifest.storage
    const identity = storage.kind === "zip_attachment" ? storage : content
    if (input.byteLength !== identity.bytes || (yield* sha256(input)) !== identity.sha256)
      return yield* Effect.fail(
        invalid("The attachment wire bytes differ from the selected current resource."),
      )
    const bytes = yield* checked(() => {
      if (storage.kind !== "zip_attachment") return input.slice()
      const files = readImportZip(input)
      const file = files[0]
      if (
        files.length !== 1 ||
        file === undefined ||
        file.path !== storage.entry ||
        file.mode !== content.mode ||
        file.bytes.byteLength !== content.bytes
      )
        throw invalid(
          "The current ZIP must contain exactly its selected original path, size and mode.",
        )
      return file.bytes
    })
    if (bytes.byteLength !== content.bytes || (yield* sha256(bytes)) !== content.sha256)
      return yield* Effect.fail(invalid("The complete original resource failed its checksum."))
    return bytes
  })
}

/** Prepare one current original; unsupported file types may use one deterministic ZIP. */
export function prepareCurrentSharedResource(
  input: Uint8Array,
  mode: CurrentResourceContent["mode"],
  options: { readonly storage: "auto" | "attachment"; readonly archiveName?: string } = {
    storage: "auto",
  },
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
      if (options.storage !== "auto" && options.storage !== "attachment")
        throw invalid("Select automatic storage or one current attachment.")
      if (options.archiveName !== undefined) archiveEntry(options.archiveName)
      return new Uint8Array(input)
    })
    const upload =
      options.archiveName === undefined
        ? bytes
        : yield* checked(() => originalZip(bytes, mode, options.archiveName!))
    const storage: CurrentResourceManifest["storage"] =
      options.archiveName !== undefined
        ? {
            kind: "zip_attachment",
            entry: options.archiveName,
            bytes: upload.byteLength,
            sha256: yield* sha256(upload),
          }
        : options.storage === "auto" && bytes.byteLength <= CURRENT_RESOURCE_INLINE_BYTES
          ? { kind: "inline", encoding: "base64", data: Buffer.from(bytes).toString("base64") }
          : { kind: "attachment" }
    const manifest: CurrentResourceManifest = {
      version: 1,
      kind: "resource",
      sha256: yield* sha256(bytes),
      bytes: bytes.byteLength,
      mode,
      storage,
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
          bytes: upload,
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
    if (raw.status === "inline" && manifest.storage.kind === "inline") {
      const storage = manifest.storage
      const bytes = yield* checked(() => decodeInline(storage.data, manifest.bytes))
      return { content, manifest, bytes, uploadBytes: undefined }
    }
    const uploadBytes = yield* checked(() => {
      if (
        raw.status !== "needs_attachment" ||
        manifest.storage.kind === "inline" ||
        !(raw.bytes instanceof Uint8Array)
      )
        throw invalid("Resource preparation does not match its current storage representation.")
      return raw.bytes.slice()
    })
    const bytes = yield* attachmentBytes(content, manifest, uploadBytes)
    return { content, manifest, bytes, uploadBytes }
  })
}

/** Same-response payload and Resource property; never an old object or history lookup. */
export function loadCurrentSharedResourceManifest(
  library: SharedLibrary,
  input: { readonly owner: CurrentResourceOwner; readonly content: CurrentResourceContent },
) {
  return Effect.gen(function* () {
    const content = yield* checked(() =>
      Schema.decodeUnknownSync(CurrentResourceContentSchema)(input.content, {
        onExcessProperty: "error",
      }),
    )
    const row = yield* queryCurrentOwnedResourceRecord(library, {
      owner: input.owner,
      objectId: content.object_id,
    })
    if (row === undefined)
      return yield* Effect.fail(
        fail("SHARED_RESOURCE_UNAVAILABLE", "The selected current resource is unavailable.", {
          object_id: content.object_id,
          next: "reselect_current",
        }),
      )
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

function attachmentUrl(raw: unknown) {
  const attachment = property(raw),
    file = property(attachment.file)
  if (
    attachment.type !== "file" ||
    typeof attachment.name !== "string" ||
    !attachment.name ||
    typeof file.url !== "string"
  )
    throw invalid("A current attachment requires one Notion-hosted file URL.")
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
  return url
}

/** Signed query values and expiry are transport details, never attachment identity. */
export function currentResourceAttachmentIdentity(raw: unknown): string {
  const url = attachmentUrl(raw)
  return url.origin + url.pathname
}

function attachmentLocator(raw: unknown) {
  const url = attachmentUrl(raw)
  const expiry = property(property(raw).file).expiry_time
  if (typeof expiry !== "string" || !Number.isFinite(Date.parse(expiry)))
    throw invalid("A current attachment requires an expiring download URL.")
  return { url: url.href, expires: Date.parse(expiry) }
}

function downloadError(error: unknown): SkillsError {
  if (error instanceof SkillsError) return error
  const cause = property(property(error).reason).cause
  if (cause instanceof SkillsError) return cause
  return fail("SHARED_RESOURCE_DOWNLOAD_FAILED", "The current attachment request failed.")
}

function downloadAttachment(
  content: Pick<CurrentResourceContent, "bytes" | "sha256">,
  url: string,
) {
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
  input: { readonly owner: CurrentResourceOwner; readonly content: CurrentResourceContent },
) {
  return Effect.gen(function* () {
    const first = yield* loadCurrentSharedResourceManifest(library, input)
    if (first.manifest.storage.kind === "inline") {
      const storage = first.manifest.storage
      return {
        content: first.content,
        manifest: first.manifest,
        record: first.record,
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
        : yield* downloadAttachment(
            current.manifest.storage.kind === "zip_attachment"
              ? current.manifest.storage
              : current.content,
            locator.url,
          ).pipe(Effect.result)
      if (read._tag === "Success")
        return {
          content: current.content,
          manifest: current.manifest,
          record: current.record,
          bytes: yield* attachmentBytes(current.content, current.manifest, read.success),
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
  input: { readonly owner: CurrentResourceOwner; readonly content: CurrentResourceContent },
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

/** Authorized management only. Unknown creates reconcile by stable ID; no write is retried. */
export function storeCurrentSharedResource(
  library: SharedLibrary,
  input: {
    readonly owner: CurrentResourceOwner
    readonly prepared: PreparedCurrentSharedResource
    readonly mode: "create" | "reconcile"
    readonly upload?: { readonly id: string; readonly name: string }
    readonly beforeCreate?: Effect.Effect<void, SkillsError>
  },
) {
  return Effect.gen(function* () {
    const prepared = yield* validatePreparedCurrentSharedResource(input.prepared)
    if (prepared.manifest.storage.kind === "inline" && input.upload !== undefined)
      return yield* Effect.fail(
        invalid("An inline resource cannot attach a second content carrier."),
      )
    const identity = { owner: input.owner, objectId: prepared.content.object_id }
    const existing = yield* queryCurrentOwnedResourceRecord(library, identity)
    if (existing === undefined) {
      if (input.mode === "reconcile")
        return yield* Effect.fail(
          fail(
            "CURRENT_RESOURCE_UNRESOLVED",
            "The unknown current resource creation is not yet observable; do not replay it.",
            { object_id: prepared.content.object_id },
          ),
        )
      if (prepared.manifest.storage.kind !== "inline" && input.upload === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_UPLOAD_REQUIRED",
            "The management operation must supply the already uploaded original attachment.",
            { object_id: prepared.content.object_id, bytes: prepared.content.bytes },
          ),
        )
      const request = yield* currentOwnedResourceCreateRequest(library, {
        ...identity,
        payload: prepared.manifest,
        ...(input.upload === undefined ? {} : { upload: input.upload }),
      })
      if (input.beforeCreate !== undefined) yield* input.beforeCreate
      const raw = yield* (yield* Notion).request(request.path, request.body, request.options)
      yield* currentOwnedResourceFromPage(library, raw, identity).pipe(
        Effect.mapError((error) =>
          fail(
            "WRITE_OUTCOME_UNKNOWN",
            "The current resource creation returned an unverifiable response.",
            { object_id: prepared.content.object_id, cause_code: error.code },
          ),
        ),
      )
    }
    return yield* loadCurrentSharedResourceContent(library, {
      owner: input.owner,
      content: prepared.content,
    })
  })
}
