import { Clock, Effect, FileSystem, Path } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { NOTION_SINGLE_UPLOAD_LIMIT } from "./notion-http.ts"
import { normalizePath, pageId } from "./ref.ts"
import type { CurrentOperationSession } from "./shared-current-operation.ts"
import {
  validatePreparedCurrentSharedResource,
  type PreparedCurrentSharedResource,
} from "./shared-current-resource.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const PART_BYTES = 10 * 1024 * 1024
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_UPLOAD_INVALID", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The current upload is invalid."),
  })

// https://developers.notion.com/guides/data-apis/working-with-files-and-media, checked 2026-11-19.
const mimeTypes: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  js: "application/javascript",
  ts: "application/typescript",
  tsx: "application/typescript",
  py: "text/x-python",
  doc: "application/msword",
  dot: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  xls: "application/vnd.ms-excel",
  xlt: "application/vnd.ms-excel",
  xla: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  ppt: "application/vnd.ms-powerpoint",
  pot: "application/vnd.ms-powerpoint",
  pps: "application/vnd.ms-powerpoint",
  ppa: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
  rtf: "application/rtf",
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html",
  epub: "application/epub+zip",
  xml: "application/xml",
  css: "text/css",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  ics: "text/calendar",
  yaml: "text/yaml",
  yml: "text/yaml",
  tsv: "text/tab-separated-values",
  zip: "application/zip",
  gz: "application/gzip",
  gzip: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  bz2: "application/x-bzip2",
  rar: "application/vnd.rar",
  gif: "image/gif",
  heic: "image/heic",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  ico: "image/vnd.microsoft.icon",
  bmp: "image/bmp",
  avif: "image/avif",
  apng: "image/apng",
  aac: "audio/aac",
  adts: "audio/aac",
  mid: "audio/midi",
  midi: "audio/midi",
  mp3: "audio/mpeg",
  mpga: "audio/mpeg",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  wma: "audio/x-ms-wma",
  weba: "audio/webm",
  flac: "audio/x-flac",
  amv: "video/x-amv",
  asf: "video/x-ms-asf",
  wmv: "video/x-ms-asf",
  avi: "video/x-msvideo",
  f4v: "video/x-f4v",
  flv: "video/x-flv",
  gifv: "video/mp4",
  m4v: "video/mp4",
  mp4: "video/mp4",
  mkv: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  qt: "video/quicktime",
  mpeg: "video/mpeg",
  ogv: "video/ogg",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  dwg: "image/vnd.dwg",
  dxf: "image/vnd.dxf",
  dwf: "model/vnd.dwf",
  rvt: "application/vnd.autodesk.revit",
  rfa: "application/vnd.autodesk.revit",
  fbx: "application/vnd.autodesk.fbx",
  "3dm": "application/vnd.mcneel.3dm",
  step: "model/step",
  stp: "model/step",
  iges: "model/iges",
  igs: "model/iges",
  stl: "model/stl",
  obj: "model/obj",
  "3mf": "model/3mf",
  gltf: "model/gltf+json",
  glb: "model/gltf-binary",
  dae: "model/vnd.collada+xml",
  usdz: "model/vnd.usdz+zip",
}

export function currentUploadFileSpec(path: string): {
  readonly name: string
  readonly contentType: string
  readonly archiveName?: string
} {
  if (!path || normalizePath(path) !== path || /[\u0000-\u001f\u007f-\u009f]/u.test(path))
    throw invalid("Choose one canonical relative file path for the original.")
  const leaf = path.split("/").at(-1)!
  const extension = leaf.includes(".") ? leaf.split(".").at(-1)!.toLowerCase() : ""
  const type = Object.hasOwn(mimeTypes, extension) ? mimeTypes[extension] : undefined
  const short =
    leaf.length <= 220
      ? leaf
      : leaf.slice(0, 180).replace(/[\uD800-\uDBFF]$/u, "") +
        "…" +
        (extension.length <= 20 && extension ? "." + extension : "")
  return type === undefined
    ? { name: short + ".zip", contentType: "application/zip", archiveName: path }
    : { name: short, contentType: type }
}

function uuid(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(input)
  )
    throw invalid("A file upload requires its exact Notion identity.")
  const result = pageId(input)
  if (result === undefined) throw invalid("A file upload requires its exact Notion identity.")
  return result
}

/** One invocation's complete upload inventory. ACKs update it; recovery explicitly refreshes it. */
export function makeCurrentUploadScope(session: CurrentOperationSession) {
  let cached: readonly Record<string, unknown>[] | undefined
  const read = (fresh: boolean) =>
    Effect.gen(function* () {
      if (!fresh && cached !== undefined) return cached
      const api = yield* Notion
      const rows: Record<string, unknown>[] = [],
        ids = new Set<string>(),
        cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const response = property(
          yield* api.request(
            `v1/file_uploads?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
          ),
        )
        const batch = yield* checked(() => {
          if (
            response.object !== "list" ||
            !Array.isArray(response.results) ||
            typeof response.has_more !== "boolean" ||
            property(response.request_status).type === "incomplete" ||
            property(response.request_status).incomplete_reason != null ||
            (!response.has_more && response.next_cursor !== null)
          )
            throw invalid("The current upload inventory is incomplete.")
          return response.results.map((raw) => {
            const row = property(raw)
            if (
              row.object !== "file_upload" ||
              (row.filename !== null && typeof row.filename !== "string")
            )
              throw invalid("The current upload inventory has invalid objects.")
            return { ...row, id: uuid(row.id) }
          })
        })
        for (const row of batch) {
          if (ids.has(row.id))
            return yield* Effect.fail(invalid("The upload inventory repeated a physical upload."))
          ids.add(row.id)
          rows.push(row)
        }
        if (rows.length > 10000)
          return yield* Effect.fail(
            invalid("The upload inventory exceeds its complete scan boundary."),
          )
        if (!response.has_more) break
        if (
          typeof response.next_cursor !== "string" ||
          !response.next_cursor ||
          cursors.has(response.next_cursor)
        )
          return yield* Effect.fail(invalid("The upload inventory repeated or omitted a cursor."))
        cursor = response.next_cursor
        cursors.add(cursor)
      } while (cursor)
      cached = rows
      return cached
    })
  return {
    session,
    read,
    remember: (raw: Record<string, unknown>) => {
      if (cached !== undefined) cached = [...cached.filter((row) => row.id !== raw.id), raw]
    },
  }
}

type UploadIdentity = {
  readonly filename: string
  readonly contentType: string
  readonly bytes: number
  readonly parts: number
  readonly multipart: boolean
}
type Upload = {
  readonly id: string
  readonly status: "pending" | "uploaded"
  readonly sent: number
  readonly raw: Record<string, unknown>
}

type CurrentUploadIdentityInput = {
  readonly session: Pick<CurrentOperationSession, "operation_id" | "skillPageId">
  readonly path: string
  readonly prepared: PreparedCurrentSharedResource
}
function currentUploadIdentity(input: CurrentUploadIdentityInput) {
  return Effect.gen(function* () {
    const { owner, wireHash } = yield* checked(() => {
      currentUploadFileSpec(input.path)
      if (input.session.skillPageId === null)
        throw invalid("Bind the exact Skill owner before allocating its original upload.")
      const owner = uuid(input.session.skillPageId)
      const storage = input.prepared.manifest.storage
      if (input.prepared.status !== "needs_attachment" || storage.kind === "inline")
        throw invalid("An inline resource has no current upload action.")
      return {
        owner,
        wireHash:
          storage.kind === "zip_attachment" ? storage.sha256 : input.prepared.content.sha256,
      }
    })
    return yield* sha256(
      canonicalSharedJson([owner, input.session.operation_id, input.path, wireHash]),
    )
  })
}

/** Select this file's pending action using manifest identity, without hashing its bytes again. */
export function currentUploadActionPrefix(input: CurrentUploadIdentityInput) {
  return currentUploadIdentity(input).pipe(Effect.map((identity) => `upload:${identity}:`))
}
function parseUpload(
  raw: unknown,
  identity: UploadIdentity,
  now: number,
  selectedId?: string,
): Upload {
  const row = property(raw),
    id = uuid(row.id),
    count = property(row.number_of_parts)
  if (
    row.object !== "file_upload" ||
    row.in_trash === true ||
    (selectedId !== undefined && selectedId !== id) ||
    row.filename !== identity.filename ||
    row.content_type !== identity.contentType
  )
    throw invalid("The observed upload differs from its frozen current input.")
  if (
    !["pending", "uploaded"].includes(String(row.status)) ||
    (row.expiry_time !== null &&
      (typeof row.expiry_time !== "string" ||
        !Number.isFinite(Date.parse(row.expiry_time)) ||
        Date.parse(row.expiry_time) <= now))
  )
    throw fail(
      "CURRENT_UPLOAD_UNAVAILABLE",
      "The original upload expired or failed; inspect the unfinished intent before replacing it.",
      { upload_id: id },
    )
  if (row.status === "pending" && row.expiry_time === null)
    throw invalid("An unattached pending upload has no expiry boundary.")
  const sent = row.status === "uploaded" ? identity.parts : identity.multipart ? count.sent : 0
  if (
    typeof sent !== "number" ||
    !Number.isSafeInteger(sent) ||
    sent < 0 ||
    sent > identity.parts ||
    (identity.multipart && row.status === "pending" && count.total !== identity.parts) ||
    (row.number_of_parts != null &&
      (count.total !== identity.parts ||
        !Number.isSafeInteger(count.sent) ||
        Number(count.sent) < 0 ||
        Number(count.sent) > identity.parts))
  )
    throw invalid("The multipart upload has an invalid current part boundary.")
  const length =
    row.status === "uploaded"
      ? identity.bytes
      : identity.multipart
        ? Math.min(sent * PART_BYTES, identity.bytes)
        : 0
  if (
    !(
      row.content_length === length ||
      (sent === 0 && row.status === "pending" && row.content_length === null)
    )
  )
    throw invalid("The current upload byte count differs from the sequential original prefix.")
  if (row.status === "uploaded" && row.number_of_parts != null && count.sent !== identity.parts)
    throw invalid("The completed original still reports missing parts.")
  return {
    id,
    status: row.status === "uploaded" ? "uploaded" : "pending",
    sent,
    raw: { ...row, id },
  }
}

/** Upload one prepared original through the owner's finite current operation, never an ACK ledger. */
export function uploadCurrentSharedResource(input: {
  readonly session: CurrentOperationSession
  readonly path: string
  readonly prepared: PreparedCurrentSharedResource
  readonly scope?: ReturnType<typeof makeCurrentUploadScope>
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      const scope = input.scope ?? makeCurrentUploadScope(input.session)
      if (scope.session !== input.session)
        return yield* Effect.fail(
          invalid("An upload scope belongs to exactly one current operation session."),
        )
      const spec = yield* checked(() => currentUploadFileSpec(input.path))
      const prepared = yield* validatePreparedCurrentSharedResource(input.prepared)
      const bytes = prepared.uploadBytes
      if (bytes === undefined)
        return yield* Effect.fail(invalid("An inline current resource needs no upload."))
      const storage = prepared.manifest.storage
      if (
        storage.kind === "zip_attachment"
          ? storage.entry !== input.path
          : spec.archiveName !== undefined
      )
        return yield* Effect.fail(
          invalid("Prepare unsupported original types as one exact-path ZIP attachment."),
        )
      const name =
        storage.kind === "zip_attachment" && spec.archiveName === undefined
          ? spec.name + ".zip"
          : spec.name
      const contentType = storage.kind === "zip_attachment" ? "application/zip" : spec.contentType
      const extension =
        storage.kind === "zip_attachment" ? "zip" : input.path.split(".").at(-1)!.toLowerCase()
      const identityHash = yield* currentUploadIdentity(input)
      const filename = `ntn-current-${identityHash}.${extension}`
      const multipart = bytes.byteLength > NOTION_SINGLE_UPLOAD_LIMIT
      const identity: UploadIdentity = {
        filename,
        contentType,
        bytes: bytes.byteLength,
        multipart,
        parts: multipart ? Math.ceil(bytes.byteLength / PART_BYTES) : 1,
      }
      const api = yield* Notion
      const parse = (raw: unknown, id?: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const state = yield* checked(() => parseUpload(raw, identity, now, id))
          scope.remember(state.raw)
          return state
        })
      let state = yield* input.session.dispatch<Upload, Notion>({
        key: `upload:${identityHash}:allocate`,
        replay: "never",
        request: {
          path: "v1/file_uploads",
          body: {
            mode: multipart ? "multi_part" : "single_part",
            filename,
            content_type: contentType,
            ...(multipart ? { number_of_parts: identity.parts } : {}),
          },
          options: { method: "POST" },
        },
        observe: ({ fresh }) =>
          Effect.gen(function* () {
            const matches = (yield* scope.read(fresh)).filter((row) => row.filename === filename)
            if (matches.length > 1)
              return yield* Effect.fail(
                fail(
                  "CURRENT_UPLOAD_DUPLICATE",
                  "More than one upload claims this exact current input.",
                  { filename },
                ),
              )
            if (!matches.length) return { status: "missing" as const }
            return { status: "complete" as const, value: yield* parse(matches[0]) }
          }),
        acknowledge: (raw) =>
          Effect.gen(function* () {
            const created = yield* parse(raw)
            if (created.status !== "pending" || created.sent !== 0)
              return yield* Effect.fail(
                invalid("A newly allocated original was not empty and pending."),
              )
            return created
          }),
      })
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path
      // These are disposable transport parts, following the existing scoped runtime-temp convention.
      const directory = yield* fs
        .makeTempDirectoryScoped({ prefix: "ntn-current-upload-" })
        .pipe(
          Effect.mapError(() =>
            fail("CURRENT_UPLOAD_LOCAL", "Could not create a temporary upload directory."),
          ),
        )
      const target = path.join(directory, filename)
      const freshState = (fresh: boolean) =>
        Effect.gen(function* () {
          if (fresh)
            state = yield* parse(yield* api.request(`v1/file_uploads/${state.id}`), state.id)
        })
      for (let part = 1; part <= identity.parts; part++) {
        const chunk = multipart
          ? bytes.subarray((part - 1) * PART_BYTES, Math.min(part * PART_BYTES, bytes.byteLength))
          : bytes
        yield* fs
          .writeFile(target, chunk)
          .pipe(
            Effect.mapError(() =>
              fail("CURRENT_UPLOAD_LOCAL", "Could not write the current temporary upload part."),
            ),
          )
        const digest = yield* sha256(chunk)
        yield* input.session.dispatch({
          key: `upload:${identityHash}:part:${part}`,
          replay: "never",
          fileSha256: digest,
          request: {
            path: `v1/file_uploads/${state.id}/send`,
            options: { method: "POST", file: target, ...(multipart ? { partNumber: part } : {}) },
          },
          observe: ({ fresh }) =>
            Effect.gen(function* () {
              yield* freshState(fresh)
              if (state.sent >= part) return { status: "complete" as const, value: undefined }
              if (state.sent !== part - 1)
                return yield* Effect.fail(invalid("Only the next sequential part may be sent."))
              return { status: "missing" as const }
            }),
          acknowledge: (raw) =>
            Effect.gen(function* () {
              const next = yield* parse(raw, state.id)
              if (next.sent !== part || (!multipart && next.status !== "uploaded"))
                return yield* Effect.fail(
                  invalid("The upload acknowledgement did not establish this exact complete part."),
                )
              state = next
            }),
        })
      }
      if (multipart)
        yield* input.session.dispatch({
          key: `upload:${identityHash}:complete`,
          replay: "idempotent",
          request: { path: `v1/file_uploads/${state.id}/complete`, options: { method: "POST" } },
          observe: ({ fresh }) =>
            Effect.gen(function* () {
              yield* freshState(fresh)
              if (state.status === "uploaded")
                return { status: "complete" as const, value: undefined }
              if (state.sent !== identity.parts)
                return yield* Effect.fail(invalid("The original still has unsent parts."))
              return { status: "missing" as const }
            }),
          acknowledge: (raw) =>
            Effect.gen(function* () {
              const next = yield* parse(raw, state.id)
              if (next.status !== "uploaded")
                return yield* Effect.fail(invalid("The complete original is not yet attachable."))
              state = next
            }),
        })
      if (state.status !== "uploaded")
        return yield* Effect.fail(invalid("The original upload is not complete."))
      return { id: state.id, name, filename }
    }),
  )
}
