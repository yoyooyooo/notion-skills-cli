import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import {
  ResourceContentSchema,
  isResourceContent,
  type ResourceContent,
  type RetainedContent,
} from "./shared-file-state.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  type SharedRecord,
} from "./shared-records.ts"
import {
  loadSharedRetainedByteFile,
  SHARED_HISTORY_CHUNK_BYTES,
} from "./shared-snapshot-history.ts"
import { sha256 } from "./store.ts"

export {
  isResourceContent,
  isResourceFollowing,
  resourceContentForOwnership,
  type ResourceContent,
} from "./shared-file-state.ts"
export const SHARED_RESOURCE_MAX_BYTES = 8 * 1024 * 1024
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Size = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const ChunkSchema = Schema.Struct({ object_id: Schema.String, sha256: Hash, bytes: Size })
export const SharedResourceManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("retained_resource"),
  sha256: Hash,
  bytes: Size,
  mode: ResourceContentSchema.fields.mode,
  chunks: Schema.Array(ChunkSchema),
})
export type SharedResourceManifest = typeof SharedResourceManifestSchema.Type
const ExactBytesSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("exact_bytes"),
  encoding: Schema.Literal("base64"),
  sha256: Hash,
  bytes: Size,
  data: Schema.String,
})
export const PreparedSharedResourceSchema = Schema.Struct({
  content: ResourceContentSchema,
  manifest: SharedResourceManifestSchema,
  objects: Schema.Array(Schema.Struct({ object_id: Schema.String, payload: ExactBytesSchema })),
})
export type PreparedSharedResource = typeof PreparedSharedResourceSchema.Type
const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_RESOURCE_INVALID", "The retained resource is invalid."),
  })
const invalid = (message: string) => fail("SHARED_RESOURCE_INVALID", message)
const operationId = (id: string) => `retain-${id}`

function encodeBytes(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
function assertEnvelope(id: string, payload: unknown): void {
  const envelope = canonicalSharedJson({ version: 1, operation_id: operationId(id), payload })
  if (new TextEncoder().encode(envelope).length > 64 * 1024)
    throw fail("SHARED_RESOURCE_TOO_LARGE", "The complete resource record exceeds 64 KiB.")
}
function layout(manifest: SharedResourceManifest): void {
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes > SHARED_RESOURCE_MAX_BYTES)
    throw fail("SHARED_RESOURCE_TOO_LARGE", "One retained resource may contain at most 8 MiB.")
  let length = 0
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (
      !Number.isSafeInteger(chunk.bytes) ||
      chunk.bytes <= 0 ||
      chunk.bytes > SHARED_HISTORY_CHUNK_BYTES ||
      (index < manifest.chunks.length - 1 && chunk.bytes !== SHARED_HISTORY_CHUNK_BYTES) ||
      chunk.object_id !== `chunk-${chunk.sha256}`
    )
      throw invalid("The resource chunk layout is not canonical.")
    length += chunk.bytes
  }
  if (length !== manifest.bytes || (manifest.bytes === 0 && manifest.chunks.length !== 0))
    throw invalid("The resource chunks do not cover its exact byte length.")
}

/** Verify the immutable byte and mode identity, without a local cache or any I/O. */
export function validateSharedResourceManifest(contentInput: unknown, manifestInput: unknown) {
  return Effect.gen(function* () {
    const content = yield* checked(() =>
      Schema.decodeUnknownSync(ResourceContentSchema)(structuredClone(contentInput), {
        onExcessProperty: "error",
      }),
    )
    const manifest = yield* checked(() =>
      Schema.decodeUnknownSync(SharedResourceManifestSchema)(structuredClone(manifestInput), {
        onExcessProperty: "error",
      }),
    )
    yield* checked(() => {
      layout(manifest)
      if (
        content.sha256 !== manifest.sha256 ||
        content.bytes !== manifest.bytes ||
        content.mode !== manifest.mode
      )
        throw invalid("The resource manifest differs from the frozen content reference.")
      assertEnvelope(content.object_id, manifest)
    })
    if (content.object_id !== `resource-${yield* sha256(canonicalSharedJson(manifest))}`)
      return yield* Effect.fail(invalid("The resource manifest failed its immutable identity."))
    return { content, manifest }
  })
}

/** Raw bytes never pass through a text decoder, newline normalization or execution. */
export function prepareSharedResourceContent(input: Uint8Array, mode: ResourceContent["mode"]) {
  return Effect.gen(function* () {
    const bytes = yield* checked(() => {
      if (!(input instanceof Uint8Array) || input.byteLength > SHARED_RESOURCE_MAX_BYTES)
        throw fail("SHARED_RESOURCE_TOO_LARGE", "Select one complete resource of at most 8 MiB.")
      return new Uint8Array(input)
    })
    const chunks: SharedResourceManifest["chunks"][number][] = []
    const objects = new Map<string, PreparedSharedResource["objects"][number]>()
    for (let offset = 0; offset < bytes.length; offset += SHARED_HISTORY_CHUNK_BYTES) {
      const part = bytes.slice(offset, offset + SHARED_HISTORY_CHUNK_BYTES)
      const hash = yield* sha256(part)
      const object_id = `chunk-${hash}`
      chunks.push({ object_id, sha256: hash, bytes: part.length })
      objects.set(object_id, {
        object_id,
        payload: {
          version: 1,
          kind: "exact_bytes",
          encoding: "base64",
          sha256: hash,
          bytes: part.length,
          data: encodeBytes(part),
        },
      })
    }
    const manifest: SharedResourceManifest = {
      version: 1,
      kind: "retained_resource",
      sha256: yield* sha256(bytes),
      bytes: bytes.length,
      mode,
      chunks,
    }
    const content: ResourceContent = {
      kind: "resource",
      object_id: `resource-${yield* sha256(canonicalSharedJson(manifest))}`,
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      mode,
    }
    yield* validateSharedResourceManifest(content, manifest)
    return { content, manifest, objects: [...objects.values()] } satisfies PreparedSharedResource
  })
}

export function validatePreparedSharedResource(input: unknown) {
  return Effect.gen(function* () {
    const prepared = yield* checked(() =>
      Schema.decodeUnknownSync(PreparedSharedResourceSchema)(structuredClone(input), {
        onExcessProperty: "error",
      }),
    )
    const { content, manifest } = yield* validateSharedResourceManifest(
      prepared.content,
      prepared.manifest,
    )
    const objects = new Map<string, Uint8Array>()
    for (const object of prepared.objects) {
      const bytes = yield* checked(() => {
        const payload = object.payload
        if (
          objects.has(object.object_id) ||
          object.object_id !== `chunk-${payload.sha256}` ||
          payload.bytes <= 0 ||
          payload.bytes > SHARED_HISTORY_CHUNK_BYTES ||
          payload.data.length > 4 * Math.ceil(SHARED_HISTORY_CHUNK_BYTES / 3) ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload.data)
        )
          throw invalid("A resource byte object has invalid identity, length or Base64 framing.")
        const data = Uint8Array.from(atob(payload.data), (character) => character.charCodeAt(0))
        if (data.length !== payload.bytes || encodeBytes(data) !== payload.data)
          throw invalid("A resource byte object has a noncanonical exact encoding.")
        assertEnvelope(object.object_id, payload)
        return data
      })
      if ((yield* sha256(bytes)) !== object.payload.sha256)
        return yield* Effect.fail(invalid("A resource byte object failed its checksum."))
      objects.set(object.object_id, bytes)
    }
    const bytes = yield* checked(() => {
      const expected = new Set(manifest.chunks.map((chunk) => chunk.object_id))
      if (objects.size !== expected.size || [...objects.keys()].some((id) => !expected.has(id)))
        throw invalid("The frozen resource must contain exactly its referenced byte objects.")
      const data = new Uint8Array(manifest.bytes)
      let offset = 0
      for (const chunk of manifest.chunks) {
        const part = objects.get(chunk.object_id)
        if (part === undefined || part.length !== chunk.bytes)
          throw invalid("The complete retained resource cannot be assembled.")
        data.set(part, offset)
        offset += part.length
      }
      return data
    })
    if ((yield* sha256(bytes)) !== content.sha256)
      return yield* Effect.fail(invalid("The complete resource failed its frozen checksum."))
    return { prepared, bytes }
  })
}

export function retainSharedResourceContent(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly prepared: PreparedSharedResource
    readonly mode: "create" | "reconcile"
  },
) {
  return Effect.gen(function* () {
    const { prepared } = yield* validatePreparedSharedResource(input.prepared)
    if (input.mode !== "create" && input.mode !== "reconcile")
      return yield* Effect.fail(invalid("Resource retention requires create or reconcile mode."))
    for (const object of prepared.objects)
      yield* appendSharedRecord(library, {
        mode: input.mode,
        skillPageId: input.skillPageId,
        kind: "object",
        entityId: object.object_id,
        recordId: object.object_id,
        operationId: operationId(object.object_id),
        payload: object.payload,
        payloadContainsBody: true,
      })
    const record = yield* appendSharedRecord(library, {
      mode: input.mode,
      skillPageId: input.skillPageId,
      kind: "object",
      entityId: prepared.content.object_id,
      recordId: prepared.content.object_id,
      operationId: operationId(prepared.content.object_id),
      payload: prepared.manifest,
    })
    return { content: prepared.content, manifest: prepared.manifest, record }
  })
}

function exactManifestRecord(rows: readonly SharedRecord[], content: ResourceContent) {
  const record = rows[0]
  if (
    rows.length !== 1 ||
    record === undefined ||
    record.kind !== "object" ||
    record.record_id !== content.object_id ||
    record.entity_id !== content.object_id ||
    record.operation_id !== operationId(content.object_id)
  )
    throw fail(
      "SHARED_RESOURCE_UNAVAILABLE",
      "The exact retained resource manifest is unavailable.",
    )
  return record
}

export function loadSharedResourceManifest(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly content: ResourceContent },
) {
  return Effect.gen(function* () {
    const content = yield* checked(() =>
      Schema.decodeUnknownSync(ResourceContentSchema)(input.content, { onExcessProperty: "error" }),
    )
    const rows = yield* querySharedRecords(library, {
      skillPageId: input.skillPageId,
      kind: "object",
      entityId: content.object_id,
      recordId: content.object_id,
    })
    const record = yield* checked(() => exactManifestRecord(rows, content))
    return { ...(yield* validateSharedResourceManifest(content, record.payload)), record }
  })
}

/** Always remote. A warm Store object cannot stand in for current retained availability. */
export function loadSharedResourceContent(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly content: ResourceContent },
) {
  return Effect.gen(function* () {
    const { content, manifest } = yield* loadSharedResourceManifest(library, input)
    const bytes = yield* loadSharedRetainedByteFile(library, {
      skillPageId: input.skillPageId,
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      chunks: manifest.chunks,
    })
    return { content, manifest, bytes, verification: "remote_verified" as const }
  })
}
