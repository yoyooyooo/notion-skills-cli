import { Crypto, Effect, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { fail, SkillsError } from "./model.ts"
import type { createRequestMetrics } from "./request-metrics.ts"
import {
  fetchFixedGithubFile,
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
  options: { readonly metrics?: ReturnType<typeof createRequestMetrics> },
): Effect.Effect<MaterializedBlob, SkillsError, Store | Crypto.Crypto | HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const store = yield* Store
    const cached = yield* store
      .readJson(cacheKey(entry.git_oid), BlobCacheSchema)
      .pipe(Effect.mapError((error) => (error.code === "STATE_CORRUPT" ? corrupt() : error)))
    if (cached !== undefined) {
      if (
        cached.git_oid !== entry.git_oid ||
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
      return { git_oid: entry.git_oid, sha256: cached.sha256, bytes }
    }
    const bytes = yield* fetchFixedGithubFile(source, entry, options)
    const hash = yield* sha256(bytes)
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

/** Materialize an already selected complete source. No branch, commit, tree, or registry discovery occurs. */
export function materializeFixedGithubSource(
  input: FixedGithubSource,
  options: { readonly metrics?: ReturnType<typeof createRequestMetrics> } = {},
): Effect.Effect<
  readonly MaterializedSourceFile[],
  SkillsError,
  Store | Crypto.Crypto | HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const source = yield* Effect.try({
      try: () => validateFixedGithubSource(input),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_GITHUB_SOURCE", "The fixed GitHub source descriptor is invalid."),
    })
    const unique = new Map<string, FixedGithubFile>()
    for (const entry of source.files) {
      const previous = unique.get(entry.git_oid)
      if (previous !== undefined && previous.bytes !== entry.bytes) {
        return yield* Effect.fail(
          fail(
            "INVALID_GITHUB_SOURCE",
            "The same fixed Git blob has conflicting declared byte lengths.",
          ),
        )
      }
      if (previous === undefined) unique.set(entry.git_oid, entry)
    }
    const blobs = yield* Effect.forEach(
      [...unique.values()],
      (entry) => materializeBlob(source, entry, options),
      { concurrency: 4 },
    )
    const byOid = new Map(blobs.map((blob) => [blob.git_oid, blob]))
    return yield* Effect.try({
      try: () =>
        source.files.map((entry): MaterializedSourceFile => {
          const blob = byOid.get(entry.git_oid)
          if (blob === undefined)
            throw fail(
              "SOURCE_MATERIALIZATION_INCOMPLETE",
              "The complete fixed source could not be materialized.",
            )
          return {
            path: entry.path,
            source_path: entry.source_path,
            git_oid: blob.git_oid,
            sha256: blob.sha256,
            bytes: blob.bytes,
          }
        }),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail(
              "SOURCE_MATERIALIZATION_INCOMPLETE",
              "The complete fixed source could not be materialized.",
            ),
    })
  })
}
