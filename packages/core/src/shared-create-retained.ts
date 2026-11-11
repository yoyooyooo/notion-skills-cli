import { Buffer } from "node:buffer"
import { Effect, Schema } from "effect"
import { zipSync } from "fflate"
import { readImportZip, type ImportFile } from "./import.ts"
import { fail, SkillsError } from "./model.ts"
import { validateFixedFileManifest } from "./shared-fixed-resources.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { appendSharedRecord, canonicalSharedJson } from "./shared-records.ts"
import { inspectRetainedSource, validateRetainedSource } from "./shared-retained-source.ts"
import { loadSharedRetainedByteFile } from "./shared-snapshot-history.ts"
import { sha256 } from "./store.ts"
import {
  SharedCreateRetainedInputSchema,
  type SharedCreateRetainedInput,
  type SharedCreateRetainedManifest,
} from "./shared-create-retained-model.ts"

const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "SOURCE_CREATE_RETAINED_INVALID",
            "The complete retained creation input is invalid.",
          ),
  })
export function sharedCreateRetainedManifest(
  input: SharedCreateRetainedInput,
): SharedCreateRetainedManifest {
  const { archive_base64: _bytes, ...manifest } = input
  return manifest
}

export function validateSharedCreateRetained(input: unknown) {
  return Effect.gen(function* () {
    const value = yield* checked(() =>
      Schema.decodeUnknownSync(SharedCreateRetainedInputSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    yield* checked(() => validateFixedFileManifest({ version: 1, files: value.files }))
    if (
      value.files.some((file) => file.mode === undefined) ||
      canonicalSharedJson(value.mode_defaulted_paths) !==
        canonicalSharedJson([...new Set(value.mode_defaulted_paths)].sort()) ||
      value.mode_defaulted_paths.some(
        (path) => value.files.find((file) => file.path === path)?.mode !== "100644",
      )
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_CREATE_RETAINED_INVALID",
          "The new retained input must explicitly record its regular-file mode defaults.",
        ),
      )
    const bytes = Buffer.from(value.archive_base64, "base64")
    if (
      bytes.toString("base64") !== value.archive_base64 ||
      bytes.length !== value.archive.bytes ||
      bytes.length === 0 ||
      bytes.length > 32 * 1024 * 1024 ||
      (yield* sha256(bytes)) !== value.archive.sha256
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_CREATE_RETAINED_INVALID",
          "The frozen complete ZIP failed its exact encoding, length or checksum.",
        ),
      )
    let offset = 0
    for (const [index, chunk] of value.archive.chunks.entries()) {
      if (
        !Number.isSafeInteger(chunk.bytes) ||
        chunk.bytes <= 0 ||
        chunk.bytes > 32768 ||
        (index < value.archive.chunks.length - 1 && chunk.bytes !== 32768) ||
        chunk.object_id !== `chunk-${chunk.sha256}`
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_CREATE_RETAINED_INVALID",
            "The frozen source chunk layout is not canonical.",
          ),
        )
      const part = bytes.subarray(offset, offset + chunk.bytes)
      if (part.length !== chunk.bytes || (yield* sha256(part)) !== chunk.sha256)
        return yield* Effect.fail(
          fail("SOURCE_CREATE_RETAINED_INVALID", "A frozen source chunk failed its checksum."),
        )
      offset += chunk.bytes
    }
    if (offset !== bytes.length)
      return yield* Effect.fail(
        fail(
          "SOURCE_CREATE_RETAINED_INVALID",
          "The frozen source chunks do not cover the complete archive.",
        ),
      )
    const files = yield* checked(() => readImportZip(bytes))
    if (
      files.length !== value.files.length ||
      !value.files.some((file) => file.path === value.entrypoint)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_CREATE_RETAINED_INVALID",
          "The frozen source tree or entrypoint is incomplete.",
        ),
      )
    for (const file of files) {
      const expected = value.files.find((item) => item.path === file.path)
      if (
        expected === undefined ||
        file.bytes.length !== expected.bytes ||
        file.mode !== expected.mode ||
        (yield* sha256(file.bytes)) !== expected.sha256
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_CREATE_RETAINED_INVALID",
            "An archived source file differs from its complete frozen hash, size or mode.",
          ),
        )
    }
    return { input: value, bytes, files }
  })
}

export function prepareSharedCreateRetained(files: readonly ImportFile[], entrypoint: string) {
  return Effect.gen(function* () {
    const defaulted = files
      .filter((file) => file.mode === undefined)
      .map((file) => file.path)
      .sort()
    const ordered = files
      .map((file) => ({ ...file, mode: file.mode ?? ("100644" as const) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const manifest = yield* Effect.forEach(ordered, (file) =>
      Effect.gen(function* () {
        return {
          path: file.path,
          sha256: yield* sha256(file.bytes),
          bytes: file.bytes.length,
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        }
      }),
    )
    yield* checked(() => validateFixedFileManifest({ version: 1, files: manifest }))
    const archive = yield* checked(() =>
      zipSync(
        Object.fromEntries(
          ordered.map((file) => [
            file.path,
            [
              file.bytes,
              {
                mtime: new Date("1980-01-01T00:00:00Z"),
                ...(file.mode === undefined
                  ? {}
                  : { os: 3, attrs: ((file.mode === "100755" ? 0o100755 : 0o100644) << 16) >>> 0 }),
              },
            ],
          ]),
        ),
        { level: 6 },
      ),
    )
    const chunks = []
    for (let offset = 0; offset < archive.length; offset += 32768) {
      const part = archive.slice(offset, offset + 32768),
        hash = yield* sha256(part)
      chunks.push({ object_id: `chunk-${hash}`, sha256: hash, bytes: part.length })
    }
    const input = {
      mode_policy: "regular_file_when_unspecified" as const,
      mode_defaulted_paths: defaulted,
      entrypoint,
      files: manifest,
      archive: {
        format: "zip" as const,
        sha256: yield* sha256(archive),
        bytes: archive.length,
        chunks,
      },
      archive_base64: Buffer.from(archive).toString("base64"),
    }
    return (yield* validateSharedCreateRetained(input)).input
  })
}

export function sharedCreateRetainedBinding(
  library: SharedLibrary,
  input: SharedCreateRetainedManifest,
  page: string,
) {
  return Effect.gen(function* () {
    const bundle = yield* validateRetainedSource(
      library,
      {
        version: 1,
        kind: "retained_bundle",
        library_id: library.library_id,
        skill_page_id: page,
        entrypoint: input.entrypoint,
        files: input.files,
        archive: input.archive,
      },
      page,
    )
    return { bundle, source_id: `bundle-${yield* sha256(canonicalSharedJson(bundle))}` }
  })
}

/** Uses the existing exact_bytes/source facts, inside the caller's original create journal. */
export function retainSharedCreateSource(
  library: SharedLibrary,
  page: string,
  input: SharedCreateRetainedInput,
  mode: "create" | "reconcile",
) {
  return Effect.gen(function* () {
    const verified = yield* validateSharedCreateRetained(input)
    const { bundle, source_id } = yield* sharedCreateRetainedBinding(
      library,
      sharedCreateRetainedManifest(input),
      page,
    )
    let offset = 0
    for (const chunk of input.archive.chunks) {
      const part = verified.bytes.subarray(offset, offset + chunk.bytes)
      offset += chunk.bytes
      yield* appendSharedRecord(library, {
        mode,
        skillPageId: page,
        kind: "object",
        recordId: chunk.object_id,
        entityId: chunk.object_id,
        operationId: `retain-${chunk.object_id}`,
        payload: {
          version: 1,
          kind: "exact_bytes",
          encoding: "base64",
          sha256: chunk.sha256,
          bytes: chunk.bytes,
          data: part.toString("base64"),
        },
        payloadContainsBody: true,
      })
    }
    yield* appendSharedRecord(library, {
      mode,
      skillPageId: page,
      kind: "source",
      recordId: source_id,
      entityId: source_id,
      operationId: `retain-${source_id}`,
      payload: bundle,
    })
    return { bundle, source_id }
  })
}

export function loadSharedCreateRetained(
  library: SharedLibrary,
  page: string,
  input: SharedCreateRetainedManifest,
) {
  return Effect.gen(function* () {
    const bytes = yield* loadSharedRetainedByteFile(library, {
      skillPageId: page,
      ...input.archive,
    })
    return (yield* validateSharedCreateRetained({
      ...input,
      archive_base64: Buffer.from(bytes).toString("base64"),
    })).input
  })
}

export function verifySharedCreateRetained(
  library: SharedLibrary,
  page: string,
  input: SharedCreateRetainedInput,
) {
  return Effect.gen(function* () {
    const expected = yield* sharedCreateRetainedBinding(
      library,
      sharedCreateRetainedManifest(input),
      page,
    )
    const actual = yield* inspectRetainedSource(library, {
      skillPageId: page,
      sourceId: expected.source_id,
    })
    if (canonicalSharedJson(actual) !== canonicalSharedJson(expected.bundle))
      return yield* Effect.fail(
        fail(
          "SOURCE_CREATE_RETAINED_INVALID",
          "The registered complete source differs from the original creation input.",
        ),
      )
    const restored = yield* loadSharedCreateRetained(
      library,
      page,
      sharedCreateRetainedManifest(input),
    )
    if (canonicalSharedJson(restored) !== canonicalSharedJson(input))
      return yield* Effect.fail(
        fail(
          "SOURCE_CREATE_RETAINED_INVALID",
          "The remote original source bytes differ from the complete frozen input.",
        ),
      )
  })
}
