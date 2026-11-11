import { Crypto, Effect, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { markLocalContentRestriction } from "./content-restrictions.ts"
import { fail, SkillsError } from "./model.ts"
import type { createRequestMetrics } from "./request-metrics.ts"
import { selectFixedResourceFiles } from "./shared-fixed-resources.ts"
import {
  fetchFixedGithubFile,
  assertSupportedGitBlob,
  gitBlobOid,
  validateFixedGithubSource,
  type FixedGithubFile,
  type FixedGithubSource,
} from "./shared-github-source.ts"
import { sha256, Store } from "./store.ts"

const BlobCacheSchema = Schema.Struct({
  version: Schema.Literal(1),
  git_oid: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Number,
})

type MaterializedBlob = {
  readonly git_oid: string
  readonly sha256: string
  readonly bytes: Uint8Array
}

export type MaterializedSourceFile = MaterializedBlob & {
  readonly path: string
  readonly source_path: string
  readonly mode?: "100644" | "100755"
}

type MaterializationOptions = {
  readonly metrics?: ReturnType<typeof createRequestMetrics>
  /** Internal classification from a complete admitted source plan; never serialized. */
  readonly localContentHashes?: ReadonlySet<string>
}

const cacheKey = (gitOid: string) => `cache/shared-github-blobs/${gitOid}.json`
const corrupt = () =>
  fail(
    "SOURCE_CACHE_CORRUPT",
    "The derived GitHub blob cache is missing or corrupt; it cannot substitute bytes for the fixed source.",
  )

function materializeBlob(
  source: FixedGithubSource,
  entry: FixedGithubFile,
  options: MaterializationOptions,
): Effect.Effect<MaterializedBlob, SkillsError, Store | Crypto.Crypto | HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const store = yield* Store
    const cached = yield* store
      .readJson(cacheKey(entry.git_oid), BlobCacheSchema)
      .pipe(Effect.mapError((error) => (error.code === "STATE_CORRUPT" ? corrupt() : error)))
    if (cached !== undefined) {
      if (
        cached.git_oid !== entry.git_oid ||
        (entry.sha256 !== undefined && cached.sha256 !== entry.sha256) ||
        !/^[0-9a-f]{64}$/.test(cached.sha256) ||
        !Number.isSafeInteger(cached.bytes) ||
        cached.bytes < 0 ||
        cached.bytes !== entry.bytes
      ) {
        return yield* Effect.fail(corrupt())
      }
      const bytes = yield* store
        .readBytes(`objects/${cached.sha256}`)
        .pipe(
          Effect.mapError((error) =>
            error.code === "SNAPSHOT_MISSING" || error.code === "STATE_CORRUPT" ? corrupt() : error,
          ),
        )
      if (
        bytes.byteLength !== cached.bytes ||
        (yield* sha256(bytes)) !== cached.sha256 ||
        (yield* gitBlobOid(bytes)) !== entry.git_oid
      ) {
        return yield* Effect.fail(corrupt())
      }
      yield* Effect.try({
        try: () => assertSupportedGitBlob(bytes),
        catch: (error) => (error instanceof SkillsError ? error : corrupt()),
      })
      if (options.localContentHashes?.has(cached.sha256))
        yield* markLocalContentRestriction(cached.sha256)
      return { git_oid: entry.git_oid, sha256: cached.sha256, bytes }
    }
    let bytes: Uint8Array | undefined
    if (entry.sha256 !== undefined) {
      const known = yield* store.readBytes(`objects/${entry.sha256}`).pipe(Effect.result)
      if (known._tag === "Success") {
        if (
          known.success.length !== entry.bytes ||
          (yield* sha256(known.success)) !== entry.sha256 ||
          (yield* gitBlobOid(known.success)) !== entry.git_oid
        )
          return yield* Effect.fail(corrupt())
        yield* Effect.try({
          try: () => assertSupportedGitBlob(known.success),
          catch: (error) => (error instanceof SkillsError ? error : corrupt()),
        })
        bytes = known.success
      } else if (known.failure.code !== "SNAPSHOT_MISSING") return yield* Effect.fail(known.failure)
    }
    bytes ??= yield* fetchFixedGithubFile(source, entry, options)
    const hash = yield* sha256(bytes)
    if (entry.sha256 !== undefined && hash !== entry.sha256)
      return yield* Effect.fail(
        fail(
          "GITHUB_BLOB_MISMATCH",
          "Fixed Git bytes disagree with the independently recorded SHA-256.",
        ),
      )
    // Classify verified bytes before either shared object or derived lookup can expose them.
    if (options.localContentHashes?.has(hash)) yield* markLocalContentRestriction(hash)
    // Publish the immutable object before its derived lookup; interruption leaves only a reusable orphan.
    yield* store.writeBytes(`objects/${hash}`, bytes)
    yield* store.writeJson(cacheKey(entry.git_oid), {
      version: 1,
      git_oid: entry.git_oid,
      sha256: hash,
      bytes: bytes.byteLength,
    })
    return { git_oid: entry.git_oid, sha256: hash, bytes }
  })
}

/** Publish manager-verified bytes through the same object/lookup contract used by lazy consumers. */
export function cacheVerifiedFixedGithubFiles(
  input: FixedGithubSource,
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
) {
  return Effect.gen(function* () {
    const source = yield* Effect.try({
      try: () => validateFixedGithubMaterializationSource(input),
      catch: (error) => (error instanceof SkillsError ? error : corrupt()),
    })
    if (
      files.length !== source.files.length ||
      new Set(files.map((file) => file.path)).size !== files.length
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_MATERIALIZATION_INCOMPLETE",
          "The manager must verify the complete fixed tree.",
        ),
      )
    const verified = yield* Effect.forEach(source.files, (entry) =>
      Effect.gen(function* () {
        const file = files.find((file) => file.path === entry.path)
        if (
          file === undefined ||
          file.bytes.length !== entry.bytes ||
          (yield* gitBlobOid(file.bytes)) !== entry.git_oid
        )
          return yield* Effect.fail(
            fail("GITHUB_BLOB_MISMATCH", "Manager bytes differ from the original fixed Git tree."),
          )
        yield* Effect.try({
          try: () => assertSupportedGitBlob(file.bytes),
          catch: (error) => (error instanceof SkillsError ? error : corrupt()),
        })
        const hash = yield* sha256(file.bytes)
        if (entry.sha256 !== undefined && entry.sha256 !== hash)
          return yield* Effect.fail(
            fail("GITHUB_BLOB_MISMATCH", "Manager bytes disagree with the fixed SHA-256."),
          )
        return { ...entry, sha256: hash, content: file.bytes }
      }),
    )
    const store = yield* Store
    for (const file of verified) {
      yield* store.writeBytes(`objects/${file.sha256}`, file.content)
      yield* store.writeJson(cacheKey(file.git_oid), {
        version: 1,
        git_oid: file.git_oid,
        sha256: file.sha256,
        bytes: file.bytes,
      })
    }
    return verified.map(({ path, sha256, bytes, mode }) => ({
      path,
      sha256,
      bytes,
      ...(mode === undefined ? {} : { mode }),
    }))
  })
}

/** Validate the complete directory, including aliases sharing one immutable blob identity. */
export function validateFixedGithubMaterializationSource(input: unknown): FixedGithubSource {
  const source = validateFixedGithubSource(input)
  const sizes = new Map<string, number>()
  const hashes = new Map<string, string>()
  for (const entry of source.files) {
    const previous = sizes.get(entry.git_oid)
    if (previous !== undefined && previous !== entry.bytes)
      throw fail(
        "INVALID_GITHUB_SOURCE",
        "The same fixed Git blob has conflicting declared byte lengths.",
      )
    sizes.set(entry.git_oid, entry.bytes)
    if (entry.sha256 !== undefined) {
      const previousHash = hashes.get(entry.git_oid)
      if (previousHash !== undefined && previousHash !== entry.sha256)
        throw fail(
          "INVALID_GITHUB_SOURCE",
          "The same Git blob has conflicting fixed SHA-256 identities.",
        )
      hashes.set(entry.git_oid, entry.sha256)
    }
  }
  return source
}

/** Validate the complete source, then acquire requested files without branch or tree discovery. */
export function materializeFixedGithubSource(
  input: FixedGithubSource,
  options: MaterializationOptions = {},
  paths?: readonly string[],
): Effect.Effect<
  readonly MaterializedSourceFile[],
  SkillsError,
  Store | Crypto.Crypto | HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const source = yield* Effect.try({
      try: () => validateFixedGithubMaterializationSource(input),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_GITHUB_SOURCE", "The fixed GitHub source descriptor is invalid."),
    })
    const selected = yield* Effect.try({
      try: () => selectFixedResourceFiles(source.files, paths),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("FILE_NOT_FOUND", "The fixed source selection is invalid."),
    })
    const unique = new Map<string, FixedGithubFile>()
    for (const entry of selected) if (!unique.has(entry.git_oid)) unique.set(entry.git_oid, entry)
    const blobs = yield* Effect.forEach(
      [...unique.values()],
      (entry) => materializeBlob(source, entry, options),
      { concurrency: 4 },
    )
    const byOid = new Map(blobs.map((blob) => [blob.git_oid, blob]))
    return yield* Effect.try({
      try: () =>
        selected.map((entry): MaterializedSourceFile => {
          const blob = byOid.get(entry.git_oid)
          if (blob === undefined)
            throw fail(
              "SOURCE_MATERIALIZATION_INCOMPLETE",
              "A requested fixed source file could not be materialized.",
            )
          if (entry.sha256 !== undefined && entry.sha256 !== blob.sha256)
            throw fail(
              "GITHUB_BLOB_MISMATCH",
              "A selected Git alias disagrees with its fixed SHA-256.",
            )
          return {
            path: entry.path,
            source_path: entry.source_path,
            git_oid: blob.git_oid,
            sha256: blob.sha256,
            bytes: blob.bytes,
            ...(entry.mode === undefined ? {} : { mode: entry.mode }),
          }
        }),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail(
              "SOURCE_MATERIALIZATION_INCOMPLETE",
              "A requested fixed source file could not be materialized.",
            ),
    })
  })
}
