import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { Store } from "./store.ts"

const hashPattern = /^[a-f0-9]{64}$/u

export const LocalContentRestrictionSchema = Schema.Struct({
  version: Schema.Literal(1),
  sha256: Schema.String.check(Schema.isPattern(hashPattern)),
  reason: Schema.Literal("local_resource"),
})
export type LocalContentRestriction = typeof LocalContentRestrictionSchema.Type

function checkedHash(hash: string): string {
  if (typeof hash !== "string" || !hashPattern.test(hash)) {
    throw fail(
      "INVALID_CONTENT_RESTRICTION",
      "Content restrictions require a lowercase SHA-256 object identity.",
    )
  }
  return hash
}

function checked<A>(operation: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: operation,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("CONTENT_RESTRICTION_CORRUPT", "The durable local-content restriction is invalid."),
  })
}

const keyFor = (hash: string) => `content-restrictions/local/${hash}.json`

function restriction(
  hash: string,
): Effect.Effect<LocalContentRestriction | undefined, SkillsError, Store> {
  return Effect.gen(function* () {
    const id = yield* checked(() => checkedHash(hash))
    const value = yield* (yield* Store)
      .readJson(keyFor(id), Schema.Unknown)
      .pipe(
        Effect.mapError((error) =>
          error.code === "STATE_CORRUPT"
            ? fail(
                "CONTENT_RESTRICTION_CORRUPT",
                "The durable local-content restriction could not be decoded.",
              )
            : error,
        ),
      )
    if (value === undefined) return undefined
    return yield* checked(() => {
      const record = Schema.decodeUnknownSync(LocalContentRestrictionSchema)(value, {
        onExcessProperty: "error",
      })
      if (record.sha256 !== id)
        throw fail(
          "CONTENT_RESTRICTION_CORRUPT",
          "The durable restriction identifies a different content object.",
        )
      return record
    })
  })
}

/** Call only after verifying the complete local bytes. This marker is immutable and is not a cache entry. */
export function markLocalContentRestriction(hash: string): Effect.Effect<void, SkillsError, Store> {
  return Effect.gen(function* () {
    const id = yield* checked(() => checkedHash(hash))
    if ((yield* restriction(id)) !== undefined) return
    const record: LocalContentRestriction = { version: 1, sha256: id, reason: "local_resource" }
    yield* (yield* Store).writeJson(keyFor(id), record)
  })
}

/** A missing record is unrestricted; invalid or unreadable records fail closed. */
export function hasLocalContentRestriction(
  hash: string,
): Effect.Effect<boolean, SkillsError, Store> {
  return restriction(hash).pipe(Effect.map((record) => record !== undefined))
}

/** Unique deterministic restricted hashes, including bytes subsequently obtained through another source. */
export function localContentRestrictedHashes(
  hashes: readonly string[],
): Effect.Effect<readonly string[], SkillsError, Store> {
  return Effect.gen(function* () {
    const unique = yield* checked(() => [...new Set(hashes.map(checkedHash))].sort())
    const records = yield* Effect.forEach(
      unique,
      (hash) =>
        hasLocalContentRestriction(hash).pipe(Effect.map((restricted) => ({ hash, restricted }))),
      { concurrency: 4 },
    )
    return records.filter((record) => record.restricted).map((record) => record.hash)
  })
}
