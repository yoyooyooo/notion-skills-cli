import { Crypto, Effect, Schema } from "effect"
import {
  aliasFor,
  ContentRecordSchema,
  fail,
  SkillsError,
  SnapshotSchema,
  validateDescription,
  type Snapshot,
} from "./model.ts"
import type { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { composeSharedFiles } from "./shared-composition.ts"
import { validateSharedRecordIdentity } from "./shared-content.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  type SharedRecord,
} from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

export const SHARED_HISTORY_CHUNK_BYTES = 32 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const ShaSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
const ChunkSchema = Schema.Struct({
  object_id: Schema.String,
  sha256: ShaSchema,
  bytes: Schema.Number,
})
export const SharedSnapshotManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("fixed_snapshot"),
  materialization_rule: Schema.Struct({ version: Schema.Literal(1) }),
  library_id: Schema.String,
  skill_page_id: Schema.String,
  record: ContentRecordSchema,
  entrypoint: Schema.String,
  version_id: ShaSchema,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha256: ShaSchema,
      bytes: Schema.Number,
      chunks: Schema.Array(ChunkSchema),
    }),
  ),
})
export type SharedSnapshotManifest = typeof SharedSnapshotManifestSchema.Type

const ExactBytesSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("exact_bytes"),
  encoding: Schema.Literal("base64"),
  sha256: ShaSchema,
  bytes: Schema.Number,
  data: Schema.String,
})
const PlannedObjectSchema = Schema.Struct({ object_id: Schema.String, payload: ExactBytesSchema })
export const SharedSnapshotHistoryPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  pin_id: Schema.String,
  manifest: SharedSnapshotManifestSchema,
  objects: Schema.Array(PlannedObjectSchema),
})
export type SharedSnapshotHistoryPlan = typeof SharedSnapshotHistoryPlanSchema.Type
export type SharedSnapshotRetention = {
  readonly pin_id: string
  readonly manifest: SharedSnapshotManifest
  readonly record: SharedRecord
  /** Existing commits prove prior completion; only restore checks all bytes for current availability. */
  readonly verification: "manifest" | "objects_and_manifest"
}
type Chunk = typeof ChunkSchema.Type
type PlannedObject = typeof PlannedObjectSchema.Type
type ExactBytes = typeof ExactBytesSchema.Type

function invalid(message: string) {
  return fail("SHARED_HISTORY_INVALID", message)
}
function checked<A>(action: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The fixed snapshot history is invalid."),
  })
}
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
const operationId = (id: string) => `retain-${id}`

function assertEnvelope(id: string, payload: unknown): void {
  const envelope = canonicalSharedJson({ version: 1, operation_id: operationId(id), payload })
  if (new TextEncoder().encode(envelope).byteLength > MAX_RECORD_BYTES) {
    throw fail(
      "SHARED_HISTORY_TOO_LARGE",
      "The complete history manifest exceeds the supported shared record size; it cannot be truncated.",
      { max_bytes: MAX_RECORD_BYTES },
    )
  }
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBytes(payload: ExactBytes): Uint8Array {
  if (
    !Number.isSafeInteger(payload.bytes) ||
    payload.bytes <= 0 ||
    payload.bytes > SHARED_HISTORY_CHUNK_BYTES ||
    payload.data.length > 4 * Math.ceil(SHARED_HISTORY_CHUNK_BYTES / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload.data)
  ) {
    throw invalid("A retained byte chunk has an invalid size or Base64 encoding.")
  }
  const bytes = Uint8Array.from(atob(payload.data), (character) => character.charCodeAt(0))
  if (bytes.length !== payload.bytes || encodeBytes(bytes) !== payload.data) {
    throw invalid("A retained byte chunk does not match its canonical byte encoding.")
  }
  return bytes
}

function recordScope(
  library: SharedLibrary,
  record: SharedSnapshotManifest["record"],
  selected: string,
): void {
  const locator = record.locator
  if (
    locator.type !== "shared_skill" ||
    pageId(selected) !== selected ||
    locator.page_id !== selected ||
    locator.library_id !== library.library_id ||
    locator.database_id !== library.skills.database_id ||
    locator.data_source_id !== library.skills.data_source_id
  ) {
    throw fail(
      "SHARED_HISTORY_SCOPE",
      "The history record does not belong to the exact selected Skill and library.",
    )
  }
  validateSharedRecordIdentity(record)
  if (aliasFor(record.name) !== record.alias)
    throw invalid("The historical Skill alias does not match its frozen name.")
  validateDescription(record.description)
}

function manifestStructure(
  library: SharedLibrary,
  manifest: SharedSnapshotManifest,
): Map<string, Chunk> {
  if (
    manifest.library_id !== library.library_id ||
    manifest.entrypoint !== manifest.record.entrypoint
  ) {
    throw fail(
      "SHARED_HISTORY_SCOPE",
      "The history manifest has a different library or main entrypoint.",
    )
  }
  recordScope(library, manifest.record, manifest.skill_page_id)
  const ordered = composeSharedFiles({
    base: manifest.files.map((file) => ({ path: file.path, bytes: new Uint8Array() })),
    mounts: [],
    overrides: [],
    entrypoint: manifest.entrypoint,
  }).files
  if (ordered.some((file, index) => file.path !== manifest.files[index]?.path)) {
    throw invalid("Historical file manifests must use deterministic path order.")
  }
  const chunks = new Map<string, Chunk>()
  for (const file of manifest.files) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0)
      throw invalid("A historical file has an invalid byte count.")
    let length = 0
    for (const [index, chunk] of file.chunks.entries()) {
      if (
        !Number.isSafeInteger(chunk.bytes) ||
        chunk.bytes <= 0 ||
        chunk.bytes > SHARED_HISTORY_CHUNK_BYTES ||
        (index < file.chunks.length - 1 && chunk.bytes !== SHARED_HISTORY_CHUNK_BYTES) ||
        chunk.object_id !== `chunk-${chunk.sha256}`
      ) {
        throw invalid("A historical file has a noncanonical chunk layout.")
      }
      const previous = chunks.get(chunk.object_id)
      if (
        previous !== undefined &&
        (previous.sha256 !== chunk.sha256 || previous.bytes !== chunk.bytes)
      ) {
        throw invalid("One historical chunk identity has conflicting byte metadata.")
      }
      chunks.set(chunk.object_id, chunk)
      length += chunk.bytes
    }
    if (
      !Number.isSafeInteger(length) ||
      length !== file.bytes ||
      (file.bytes === 0 && file.chunks.length !== 0)
    ) {
      throw invalid("Historical chunk lengths do not cover the complete file exactly.")
    }
  }
  return chunks
}

function verifiedManifest(
  library: SharedLibrary,
  input: unknown,
  pinId: string,
  skillPageId?: string,
) {
  return Effect.gen(function* () {
    const manifest = yield* checked(() =>
      Schema.decodeUnknownSync(SharedSnapshotManifestSchema)(structuredClone(input), {
        onExcessProperty: "error",
      }),
    )
    const chunks = yield* checked(() => {
      if (!/^snapshot-[0-9a-f]{64}$/u.test(pinId))
        throw invalid("A shared pin requires its complete manifest content identity.")
      if (skillPageId !== undefined && manifest.skill_page_id !== skillPageId) {
        throw fail("SHARED_HISTORY_SCOPE", "The historical manifest belongs to another Skill.")
      }
      const chunks = manifestStructure(library, manifest)
      assertEnvelope(pinId, manifest)
      return chunks
    })
    if (pinId !== `snapshot-${yield* sha256(canonicalSharedJson(manifest))}`) {
      return yield* Effect.fail(
        invalid("The historical manifest does not match its pinned content identity."),
      )
    }
    return { manifest, chunks }
  })
}

function verifiedObject(input: unknown, chunk: Chunk) {
  return Effect.gen(function* () {
    const payload = yield* checked(() =>
      Schema.decodeUnknownSync(ExactBytesSchema)(structuredClone(input), {
        onExcessProperty: "error",
      }),
    )
    const bytes = yield* checked(() => {
      if (
        payload.sha256 !== chunk.sha256 ||
        payload.bytes !== chunk.bytes ||
        chunk.object_id !== `chunk-${payload.sha256}`
      ) {
        throw invalid(
          "The historical object has different content metadata from its frozen reference.",
        )
      }
      assertEnvelope(chunk.object_id, payload)
      return decodeBytes(payload)
    })
    if ((yield* sha256(bytes)) !== chunk.sha256)
      return yield* Effect.fail(invalid("A retained byte chunk failed its content checksum."))
    return { payload, bytes }
  })
}

/** Copy and verify a complete original plan before any remote read or write. */
export function validateSharedSnapshotHistoryPlan(library: SharedLibrary, input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* checked(() =>
      Schema.decodeUnknownSync(SharedSnapshotHistoryPlanSchema)(structuredClone(input), {
        onExcessProperty: "error",
      }),
    )
    const { manifest, chunks } = yield* verifiedManifest(library, plan.manifest, plan.pin_id)
    const seen = new Set<string>()
    const objects: PlannedObject[] = []
    for (const object of plan.objects) {
      const chunk = chunks.get(object.object_id)
      if (chunk === undefined || seen.has(object.object_id))
        return yield* Effect.fail(
          invalid("The original history plan has extra or duplicate byte objects."),
        )
      seen.add(object.object_id)
      const verified = yield* verifiedObject(object.payload, chunk)
      objects.push({ object_id: object.object_id, payload: verified.payload })
    }
    if (seen.size !== chunks.size)
      return yield* Effect.fail(
        invalid("The original history plan is missing frozen byte objects."),
      )
    // Verify the full-file hash as well as each chunk before dispatching any write.
    const byId = new Map(objects.map((object) => [object.object_id, decodeBytes(object.payload)]))
    yield* assembleFiles(manifest, byId)
    return {
      version: 1,
      pin_id: plan.pin_id,
      manifest,
      objects: objects.sort((a, b) => compare(a.object_id, b.object_id)),
    } satisfies SharedSnapshotHistoryPlan
  })
}

/** Prepare only from immutable local snapshot objects, never from current Notion bodies or upstream. */
export function prepareSharedSnapshotHistory(library: SharedLibrary, input: Snapshot) {
  return Effect.gen(function* () {
    const snapshot = yield* checked(() =>
      Schema.decodeUnknownSync(SnapshotSchema)(structuredClone(input)),
    )
    const locator = snapshot.record.locator
    if (locator.type !== "shared_skill")
      return yield* Effect.fail(
        fail(
          "SHARED_HISTORY_SCOPE",
          "Only shared Skill snapshots can be archived by this protocol.",
        ),
      )
    yield* checked(() => {
      recordScope(library, snapshot.record, locator.page_id)
      if (
        snapshot.historical_snapshot_id !== undefined ||
        snapshot.entrypoint !== snapshot.record.entrypoint ||
        !/^[0-9a-f]{64}$/u.test(snapshot.version_id)
      ) {
        throw invalid("The local snapshot cannot identify a complete shared history version.")
      }
      composeSharedFiles({
        base: snapshot.files.map((file) => ({ path: file.path, bytes: new Uint8Array() })),
        mounts: [],
        overrides: [],
        entrypoint: snapshot.entrypoint,
      })
    })
    if (
      snapshot.snapshot_id !==
      `s_${yield* sha256(JSON.stringify([snapshot.scope, snapshot.record.id, snapshot.version_id]))}`
    ) {
      return yield* Effect.fail(
        invalid("The original local snapshot identity does not match its scope and version."),
      )
    }
    const store = yield* Store
    const objects = new Map<string, PlannedObject>()
    const fileCache = new Map<
      string,
      { readonly bytes: number; readonly chunks: readonly Chunk[] }
    >()
    const files: SharedSnapshotManifest["files"][number][] = []
    for (const file of [...snapshot.files].sort((a, b) => compare(a.path, b.path))) {
      yield* checked(() => {
        if (
          !/^[0-9a-f]{64}$/u.test(file.sha256) ||
          !Number.isSafeInteger(file.bytes) ||
          file.bytes < 0
        )
          throw invalid("The original snapshot contains an invalid file identity.")
      })
      let cached = fileCache.get(file.sha256)
      if (cached === undefined) {
        const bytes = new Uint8Array(yield* store.readBytes(`objects/${file.sha256}`))
        if (bytes.length !== file.bytes || (yield* sha256(bytes)) !== file.sha256)
          return yield* Effect.fail(
            invalid("An original local snapshot object failed its size or checksum validation."),
          )
        const chunks: Chunk[] = []
        for (let offset = 0; offset < bytes.length; offset += SHARED_HISTORY_CHUNK_BYTES) {
          const part = bytes.slice(offset, offset + SHARED_HISTORY_CHUNK_BYTES)
          const hash = yield* sha256(part)
          const objectId = `chunk-${hash}`
          const payload: ExactBytes = {
            version: 1,
            kind: "exact_bytes",
            encoding: "base64",
            sha256: hash,
            bytes: part.length,
            data: encodeBytes(part),
          }
          const previous = objects.get(objectId)
          if (
            previous !== undefined &&
            canonicalSharedJson(previous.payload) !== canonicalSharedJson(payload)
          )
            return yield* Effect.fail(
              invalid("An exact-byte identity names different original bytes."),
            )
          yield* checked(() => assertEnvelope(objectId, payload))
          objects.set(objectId, { object_id: objectId, payload })
          chunks.push({ object_id: objectId, sha256: hash, bytes: part.length })
        }
        cached = { bytes: bytes.length, chunks }
        fileCache.set(file.sha256, cached)
      }
      if (cached.bytes !== file.bytes)
        return yield* Effect.fail(
          invalid("The same original object has inconsistent file lengths."),
        )
      files.push({
        path: file.path,
        sha256: file.sha256,
        bytes: file.bytes,
        chunks: [...cached.chunks],
      })
    }
    const manifest: SharedSnapshotManifest = {
      version: 1,
      kind: "fixed_snapshot",
      materialization_rule: { version: 1 },
      library_id: library.library_id,
      skill_page_id: locator.page_id,
      record: snapshot.record,
      entrypoint: snapshot.entrypoint,
      version_id: snapshot.version_id,
      files,
    }
    const pinId = `snapshot-${yield* sha256(canonicalSharedJson(manifest))}`
    yield* checked(() => {
      manifestStructure(library, manifest)
      assertEnvelope(pinId, manifest)
    })
    return {
      version: 1,
      pin_id: pinId,
      manifest,
      objects: [...objects.values()].sort((a, b) => compare(a.object_id, b.object_id)),
    } satisfies SharedSnapshotHistoryPlan
  })
}

/**
 * Create once from a retained original plan. After an unknown outcome use reconcile;
 * reconcile observes the original manifest and never repeats any create request.
 * The caller persists its dispatch/recovery receipt before invoking create.
 * An existing manifest is a prior completion fact, not a fresh availability check
 * for every byte object. Its verification is reported explicitly as manifest-only.
 */
export function retainSharedSnapshotHistory(
  library: SharedLibrary,
  input: {
    readonly plan: SharedSnapshotHistoryPlan
    readonly mode: "create" | "reconcile"
  },
) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedSnapshotHistoryPlan(library, input.plan)
    if (input.mode !== "create" && input.mode !== "reconcile")
      return yield* Effect.fail(invalid("History retention requires create or reconcile mode."))
    const manifestInput = {
      recordId: plan.pin_id,
      operationId: operationId(plan.pin_id),
      skillPageId: plan.manifest.skill_page_id,
      kind: "snapshot" as const,
      entityId: plan.pin_id,
      payload: plan.manifest,
    }
    const existing = yield* appendSharedRecord(library, {
      ...manifestInput,
      mode: "reconcile",
    }).pipe(Effect.result)
    if (existing._tag === "Success")
      return {
        pin_id: plan.pin_id,
        manifest: plan.manifest,
        record: existing.success,
        verification: "manifest",
      } satisfies SharedSnapshotRetention
    if (existing.failure.code !== "SHARED_RECORD_UNRESOLVED" || input.mode === "reconcile")
      return yield* Effect.fail(existing.failure)
    yield* Effect.forEach(
      plan.objects,
      (object) =>
        appendSharedRecord(library, {
          mode: "create",
          recordId: object.object_id,
          operationId: operationId(object.object_id),
          skillPageId: plan.manifest.skill_page_id,
          kind: "object",
          entityId: object.object_id,
          payload: object.payload,
        }).pipe(
          Effect.mapError((error) =>
            fail(error.code, error.message, {
              pin_id: plan.pin_id,
              phase: "objects",
              object_id: object.object_id,
              next_mode: "reconcile",
            }),
          ),
        ),
      { concurrency: 4 },
    )
    const record = yield* appendSharedRecord(library, { ...manifestInput, mode: "create" }).pipe(
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          pin_id: plan.pin_id,
          phase: "manifest",
          next_mode: "reconcile",
        }),
      ),
    )
    return {
      pin_id: plan.pin_id,
      manifest: plan.manifest,
      record,
      verification: "objects_and_manifest",
    } satisfies SharedSnapshotRetention
  })
}

function exactRecord(records: readonly SharedRecord[], id: string): SharedRecord {
  const record = records[0]
  if (records.length === 0)
    throw fail(
      "SHARED_HISTORY_MISSING",
      "The exact retained history record is unavailable; current content cannot replace it.",
      { record_id: id },
    )
  if (
    records.length !== 1 ||
    record === undefined ||
    record.record_id !== id ||
    record.operation_id !== operationId(id)
  ) {
    throw invalid("The retained history does not have one exact immutable record identity.")
  }
  return record
}

function assembleFiles(manifest: SharedSnapshotManifest, chunks: ReadonlyMap<string, Uint8Array>) {
  return Effect.forEach(
    manifest.files,
    (file) =>
      Effect.gen(function* () {
        const bytes = yield* checked(() => {
          const output = new Uint8Array(file.bytes)
          let offset = 0
          for (const reference of file.chunks) {
            const chunk = chunks.get(reference.object_id)
            if (chunk === undefined || chunk.length !== reference.bytes)
              throw invalid(
                "The complete historical file cannot be assembled from its exact chunks.",
              )
            output.set(chunk, offset)
            offset += chunk.length
          }
          if (offset !== output.length)
            throw invalid("The retained chunks do not cover the complete historical file.")
          return output
        })
        if ((yield* sha256(bytes)) !== file.sha256)
          return yield* Effect.fail(
            invalid("The assembled historical file failed its frozen checksum."),
          )
        return { path: file.path, bytes }
      }),
    { concurrency: 4 },
  )
}

/**
 * The caller validates current authentication and library access before using this primitive.
 * Restore reads only exact Records facts and returns frozen bytes; it performs no local writes,
 * auth-scope rebinding, latest-cache updates, current-page reads, or provider fallback.
 */
export function restoreSharedSnapshotHistory(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly pinId: string
    readonly expectedSkillId?: string
  },
): Effect.Effect<
  {
    readonly pin_id: string
    readonly manifest: SharedSnapshotManifest
    readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[]
  },
  SkillsError,
  Notion | Crypto.Crypto
> {
  return Effect.gen(function* () {
    yield* checked(() => {
      if (
        !/^snapshot-[0-9a-f]{64}$/u.test(input.pinId) ||
        pageId(input.skillPageId) !== input.skillPageId
      )
        throw invalid("Historical restoration requires an exact Skill and shared pin.")
    })
    const records = yield* querySharedRecords(library, {
      skillPageId: input.skillPageId,
      kind: "snapshot",
      entityId: input.pinId,
    })
    const record = yield* checked(() => exactRecord(records, input.pinId))
    const { manifest, chunks } = yield* verifiedManifest(
      library,
      record.payload,
      input.pinId,
      input.skillPageId,
    )
    if (
      input.expectedSkillId !== undefined &&
      (manifest.record.locator.type !== "shared_skill" ||
        manifest.record.locator.skill_id !== input.expectedSkillId)
    ) {
      return yield* Effect.fail(
        fail(
          "SHARED_HISTORY_SCOPE",
          "The historical manifest belongs to another stable Skill identity.",
        ),
      )
    }
    const loaded = yield* Effect.forEach(
      [...chunks.values()],
      (chunk) =>
        Effect.gen(function* () {
          const records = yield* querySharedRecords(library, {
            skillPageId: input.skillPageId,
            kind: "object",
            entityId: chunk.object_id,
          })
          const record = yield* checked(() => exactRecord(records, chunk.object_id))
          const verified = yield* verifiedObject(record.payload, chunk)
          return { object_id: chunk.object_id, bytes: verified.bytes }
        }),
      { concurrency: 4 },
    )
    const files = yield* assembleFiles(
      manifest,
      new Map(loaded.map((chunk) => [chunk.object_id, chunk.bytes])),
    )
    return { pin_id: input.pinId, manifest, files }
  })
}
