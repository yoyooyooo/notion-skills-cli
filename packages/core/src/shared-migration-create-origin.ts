import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { pageId } from "./ref.ts"
import { RetainedContentSchema } from "./shared-file-state.ts"
import {
  SharedMigrationConversionCandidateSchema,
  validateRetainedMigrationConversion,
  type SharedMigrationConversionCandidate,
} from "./shared-migration-conversion.ts"
import { sharedCreateInputPayload } from "./shared-create-objects.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const MemberBindingSchema = Schema.Struct({
  legacy_id: Schema.String,
  skill_id: Schema.String,
  record_id: Schema.String,
  page_id: Schema.String,
})
export type MigrationMemberBinding = typeof MemberBindingSchema.Type
export const SharedMigrationOriginArchiveSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("migration_create_origin"),
  candidate_id: Schema.String,
  sha256: Hash,
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  chunks: Schema.Array(RetainedContentSchema),
})
export const SharedMigrationOriginManifestSchema = Schema.Struct({
  archive: SharedMigrationOriginArchiveSchema,
  member_bindings: Schema.Array(MemberBindingSchema),
})
export const SharedMigrationCreateOriginSchema = Schema.Struct({
  archive: SharedMigrationOriginArchiveSchema,
  member_bindings: Schema.Array(MemberBindingSchema),
  candidate: SharedMigrationConversionCandidateSchema,
})
export type SharedMigrationCreateOrigin = typeof SharedMigrationCreateOriginSchema.Type
export type SharedMigrationOriginManifest = typeof SharedMigrationOriginManifestSchema.Type
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_MIGRATION_ORIGIN_INVALID", "The retained migration origin is invalid."),
  })

/** Reuse existing immutable utf8_input objects. Bound escaped JSON payload size,
 * not UTF-16 length, so every chunk passes the normal 64 KiB envelope gate. */
function chunks(text: string): readonly string[] {
  const result: string[] = []
  const encoder = new TextEncoder()
  let part = "",
    escapedBytes = 0
  for (const character of text) {
    const size = encoder.encode(JSON.stringify(character).slice(1, -1)).length
    if (escapedBytes + size > 48 * 1024 && part !== "") {
      result.push(part)
      part = ""
      escapedBytes = 0
    }
    part += character
    escapedBytes += size
  }
  if (part !== "" || result.length === 0) result.push(part)
  return result
}

export function sharedMigrationOriginObjects(candidate: SharedMigrationConversionCandidate) {
  return Effect.gen(function* () {
    const text = canonicalSharedJson(candidate)
    const objects = yield* Effect.forEach(chunks(text), (part) =>
      Effect.gen(function* () {
        const hash = yield* sha256(part)
        const content = {
          object_id: `input-${hash}`,
          sha256: hash,
          bytes: new TextEncoder().encode(part).length,
        }
        yield* checked(() =>
          validateSharedRecordEnvelope(`retain-input-${hash}`, sharedCreateInputPayload(part)),
        )
        return { ...content, text: part }
      }),
    )
    return {
      archive: {
        version: 1 as const,
        kind: "migration_create_origin" as const,
        candidate_id: candidate.candidate_id,
        sha256: yield* sha256(text),
        bytes: new TextEncoder().encode(text).length,
        chunks: objects.map(({ text: _text, ...object }) => object),
      },
      objects,
    }
  })
}

export function makeSharedMigrationCreateOrigin(
  input: unknown,
  bindings: readonly MigrationMemberBinding[],
) {
  return Effect.gen(function* () {
    const candidate = yield* validateRetainedMigrationConversion(input)
    const members = yield* checked(() => {
      const decoded = Schema.decodeUnknownSync(Schema.Array(MemberBindingSchema))(bindings, {
        onExcessProperty: "error",
      })
      if (
        decoded.length !== candidate.member_bindings.length ||
        decoded.length > 100 ||
        new Set(decoded.map((item) => item.page_id)).size !== decoded.length ||
        new Set(decoded.map((item) => item.legacy_id)).size !== decoded.length
      )
        throw fail(
          "SHARED_MIGRATION_MEMBERS_UNBOUND",
          "Bind every exact original Router member once; unresolved members cannot be dropped or replaced.",
        )
      for (const item of decoded) {
        const original = candidate.member_bindings.find(
          (member) => member.legacy_id === item.legacy_id,
        )
        if (
          !original ||
          original.skill_id !== item.skill_id ||
          original.record_id !== item.record_id ||
          pageId(item.page_id) !== item.page_id
        )
          throw fail(
            "SHARED_MIGRATION_MEMBERS_UNBOUND",
            "A new member page must bind the exact retained migration identity.",
          )
      }
      return [...decoded].sort((a, b) =>
        a.legacy_id < b.legacy_id ? -1 : a.legacy_id > b.legacy_id ? 1 : 0,
      )
    })
    const { archive } = yield* sharedMigrationOriginObjects(candidate)
    return { candidate, archive, member_bindings: members } satisfies SharedMigrationCreateOrigin
  })
}

/** Used only after exact shared object identities and hashes have been read.
 * This reconstructs evidence for read-only reconcile, not original approval. */
export function restoreSharedMigrationCreateOrigin(
  input: SharedMigrationOriginManifest,
  parts: readonly { readonly object_id: string; readonly text: string }[],
) {
  return Effect.gen(function* () {
    const manifest = yield* checked(() =>
      Schema.decodeUnknownSync(SharedMigrationOriginManifestSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    if (parts.length !== manifest.archive.chunks.length)
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_ORIGIN_INCOMPLETE",
          "The original migration archive is incomplete; do not create a replacement intent.",
        ),
      )
    let text = ""
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index],
        expected = manifest.archive.chunks[index]
      if (
        !part ||
        !expected ||
        part.object_id !== expected.object_id ||
        expected.object_id !== `input-${expected.sha256}` ||
        new TextEncoder().encode(part.text).length !== expected.bytes ||
        (yield* sha256(part.text)) !== expected.sha256
      )
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_ORIGIN_INVALID",
            "An original migration evidence object differs from its immutable checksum.",
          ),
        )
      text += part.text
    }
    if (
      new TextEncoder().encode(text).length !== manifest.archive.bytes ||
      (yield* sha256(text)) !== manifest.archive.sha256
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_ORIGIN_INVALID",
          "The complete original migration archive failed its checksum.",
        ),
      )
    const raw: unknown = yield* checked(() => JSON.parse(text))
    const origin = yield* makeSharedMigrationCreateOrigin(raw, manifest.member_bindings)
    if (canonicalSharedJson(origin.archive) !== canonicalSharedJson(manifest.archive))
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_ORIGIN_INVALID",
          "The retained evidence does not reconstruct the same migration origin.",
        ),
      )
    return origin
  })
}
