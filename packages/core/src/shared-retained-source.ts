import { Effect, Schema } from "effect"
import { readImportZip } from "./import.ts"
import { fail, FileEntrySchema, SkillsError } from "./model.ts"
import { pageId, normalizePath } from "./ref.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { loadSharedRetainedByteFile } from "./shared-snapshot-history.ts"
import { sha256, Store } from "./store.ts"

const Chunk = Schema.Struct({
  object_id: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Number,
})
export const RetainedSourceSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("retained_bundle"),
  library_id: Schema.String,
  skill_page_id: Schema.String,
  entrypoint: Schema.String,
  files: Schema.Array(FileEntrySchema),
  archive: Schema.Struct({
    format: Schema.Literal("zip"),
    sha256: Schema.String,
    bytes: Schema.Number,
    chunks: Schema.Array(Chunk),
  }),
})
export type RetainedSource = typeof RetainedSourceSchema.Type

function checked<A>(run: () => A) {
  return Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("RETAINED_SOURCE_INVALID", "The complete retained source is invalid."),
  })
}

export function validateRetainedSource(
  library: SharedLibrary,
  input: unknown,
  skillPageId: string,
) {
  return checked(() => {
    const source = Schema.decodeUnknownSync(RetainedSourceSchema)(structuredClone(input), {
      onExcessProperty: "error",
    })
    if (
      source.library_id !== library.library_id ||
      source.skill_page_id !== skillPageId ||
      pageId(skillPageId) !== skillPageId
    )
      throw fail("RETAINED_SOURCE_SCOPE", "A retained source belongs to another library or Skill.")
    let previous = "",
      total = 0
    const objectSizes = new Map<string, number>()
    for (const file of source.files) {
      if (
        !file.path ||
        normalizePath(file.path) !== file.path ||
        file.path <= previous ||
        !/^[a-f0-9]{64}$/u.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        file.bytes > 64 * 1024 * 1024
      )
        throw fail(
          "RETAINED_SOURCE_INVALID",
          "A retained source has invalid or repeated file identities.",
        )
      const existingBytes = objectSizes.get(file.sha256)
      if (existingBytes !== undefined && existingBytes !== file.bytes)
        throw fail(
          "RETAINED_SOURCE_INVALID",
          "One retained source object has conflicting declared byte lengths.",
        )
      objectSizes.set(file.sha256, file.bytes)
      previous = file.path
      total += file.bytes
    }
    if (
      !source.files.some((file) => file.path === source.entrypoint) ||
      total > 128 * 1024 * 1024 ||
      source.files.length > 10000 ||
      !/^[a-f0-9]{64}$/u.test(source.archive.sha256) ||
      !Number.isSafeInteger(source.archive.bytes) ||
      source.archive.bytes <= 0 ||
      source.archive.bytes > 32 * 1024 * 1024
    )
      throw fail(
        "RETAINED_SOURCE_INVALID",
        "The retained source entrypoint or complete size is invalid.",
      )
    let archiveBytes = 0
    for (const [index, chunk] of source.archive.chunks.entries()) {
      if (
        !/^[a-f0-9]{64}$/u.test(chunk.sha256) ||
        chunk.object_id !== `chunk-${chunk.sha256}` ||
        !Number.isSafeInteger(chunk.bytes) ||
        chunk.bytes <= 0 ||
        chunk.bytes > 32768 ||
        (index < source.archive.chunks.length - 1 && chunk.bytes !== 32768)
      )
        throw fail("RETAINED_SOURCE_INVALID", "The retained archive has an invalid chunk layout.")
      archiveBytes += chunk.bytes
    }
    if (archiveBytes !== source.archive.bytes)
      throw fail("RETAINED_SOURCE_INVALID", "The retained archive chunks are incomplete.")
    validateSharedRecordEnvelope("retain-bundle", source)
    return source
  })
}

export function inspectRetainedSource(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly sourceId: string },
) {
  return Effect.gen(function* () {
    if (!/^bundle-[a-f0-9]{64}$/u.test(input.sourceId))
      return yield* Effect.fail(
        fail("RETAINED_SOURCE_INVALID", "Select one immutable retained bundle."),
      )
    const rows = yield* querySharedRecords(library, {
      skillPageId: input.skillPageId,
      kind: "source",
      entityId: input.sourceId,
    })
    const row = rows[0]
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.record_id !== input.sourceId ||
      row.operation_id !== `retain-${input.sourceId}`
    )
      return yield* Effect.fail(
        fail(
          "RETAINED_SOURCE_MISSING",
          "The exact retained source is unavailable; no legacy or provider fallback is allowed.",
        ),
      )
    const binding = yield* validateRetainedSource(library, row.payload, input.skillPageId)
    if (`bundle-${yield* sha256(canonicalSharedJson(binding))}` !== input.sourceId)
      return yield* Effect.fail(
        fail(
          "RETAINED_SOURCE_INVALID",
          "The retained source does not match its immutable identity.",
        ),
      )
    return binding
  })
}

/** Read only the selected local objects. A missing selected file still requires
 * the complete legacy ZIP, whose members are all verified before selected writes. */
export function materializeRetainedSource(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly sourceId: string
    readonly source: RetainedSource
    readonly paths?: readonly string[]
  },
) {
  return Effect.gen(function* () {
    const paths = input.paths === undefined ? undefined : [...input.paths]
    const source = yield* validateRetainedSource(library, input.source, input.skillPageId)
    if (`bundle-${yield* sha256(canonicalSharedJson(source))}` !== input.sourceId)
      return yield* Effect.fail(
        fail(
          "RETAINED_SOURCE_INVALID",
          "Retained source bytes belong to another immutable selection.",
        ),
      )
    const requested = paths === undefined ? undefined : new Set(paths)
    const selected =
      requested === undefined
        ? source.files
        : source.files.filter((file) => requested.has(file.path))
    if (
      paths !== undefined &&
      requested !== undefined &&
      (requested.size !== paths.length || selected.length !== paths.length)
    )
      return yield* Effect.fail(
        fail("FILE_NOT_FOUND", "Requested files must exist exactly once in the fixed manifest."),
      )
    if (selected.length === 0) return []
    const store = yield* Store
    const unique = new Map(selected.map((file) => [file.sha256, file]))
    const available = new Map<string, Uint8Array>()
    for (const file of unique.values()) {
      const cached = yield* store.readBytes(`objects/${file.sha256}`).pipe(Effect.result)
      if (cached._tag === "Failure") {
        if (cached.failure.code !== "SNAPSHOT_MISSING") return yield* Effect.fail(cached.failure)
      } else {
        if (cached.success.length !== file.bytes || (yield* sha256(cached.success)) !== file.sha256)
          return yield* Effect.fail(
            fail("RETAINED_SOURCE_INVALID", "Cached source bytes failed their checksum."),
          )
        available.set(file.sha256, cached.success)
      }
    }
    if (available.size !== unique.size) {
      const archive = yield* loadSharedRetainedByteFile(library, {
        skillPageId: input.skillPageId,
        ...source.archive,
      })
      const decoded = yield* checked(() => readImportZip(archive))
      if (
        decoded.length !== source.files.length ||
        new Set(decoded.map((file) => file.path)).size !== decoded.length
      )
        return yield* Effect.fail(
          fail(
            "RETAINED_SOURCE_INVALID",
            "The complete archive file set differs from its selected manifest.",
          ),
        )
      const expectedByPath = new Map(source.files.map((file) => [file.path, file]))
      for (const file of decoded) {
        const expected = expectedByPath.get(file.path)
        if (
          !expected ||
          file.bytes.length !== expected.bytes ||
          (yield* sha256(file.bytes)) !== expected.sha256
        )
          return yield* Effect.fail(
            fail(
              "RETAINED_SOURCE_INVALID",
              "An archived file failed its exact path, size or checksum.",
            ),
          )
      }
      // The ZIP cost is whole-archive even for one file. Verify every member first,
      // then publish only selected bytes without reading or repairing other objects.
      const decodedByPath = new Map(decoded.map((file) => [file.path, file.bytes]))
      for (const file of unique.values()) {
        if (available.has(file.sha256)) continue
        const bytes = decodedByPath.get(file.path)!
        yield* store.writeBytes(`objects/${file.sha256}`, bytes)
        available.set(file.sha256, bytes)
      }
    }
    return selected.map((file) => ({ path: file.path, bytes: available.get(file.sha256)! }))
  })
}
