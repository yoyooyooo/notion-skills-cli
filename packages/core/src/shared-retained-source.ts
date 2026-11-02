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

export function materializeRetainedSource(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly sourceId: string
    readonly source: RetainedSource
  },
) {
  return Effect.gen(function* () {
    const source = yield* validateRetainedSource(library, input.source, input.skillPageId)
    if (`bundle-${yield* sha256(canonicalSharedJson(source))}` !== input.sourceId)
      return yield* Effect.fail(
        fail(
          "RETAINED_SOURCE_INVALID",
          "Retained source bytes belong to another immutable selection.",
        ),
      )
    const store = yield* Store
    const files = new Map<string, Uint8Array>()
    for (const file of source.files) {
      const cached = yield* store.readBytes(`objects/${file.sha256}`).pipe(Effect.result)
      if (cached._tag === "Failure") {
        if (cached.failure.code !== "SNAPSHOT_MISSING") return yield* Effect.fail(cached.failure)
      } else {
        if (cached.success.length !== file.bytes || (yield* sha256(cached.success)) !== file.sha256)
          return yield* Effect.fail(
            fail("RETAINED_SOURCE_INVALID", "Cached source bytes failed their checksum."),
          )
        files.set(file.path, cached.success)
      }
    }
    if (files.size !== source.files.length) {
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
      for (const file of decoded) {
        const expected = source.files.find((item) => item.path === file.path)
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
      // Publish no partial cache until the complete archive has been verified.
      for (const file of decoded) {
        const expected = source.files.find((item) => item.path === file.path)!
        yield* store.writeBytes(`objects/${expected.sha256}`, file.bytes)
        files.set(file.path, file.bytes)
      }
    }
    return source.files.map((file) => ({ path: file.path, bytes: files.get(file.path)! }))
  })
}
