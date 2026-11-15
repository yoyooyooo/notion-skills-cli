import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { normalizeObservedBody } from "./shared-file-state.ts"
import { sharedCreateBodyPayload, sharedCreateInputPayload } from "./shared-create-objects.ts"
import { SHARED_FACT_ENVELOPE_BYTES } from "./shared-record-codec.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { prepareSharedResourceContent } from "./shared-resource-content.ts"
import { loadSharedRetainedByteFile } from "./shared-snapshot-history.ts"
import { sha256 } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Size = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Chunk = Schema.Struct({ object_id: Schema.String, sha256: Hash, bytes: Size })
const Chunked = {
  version: Schema.Literal(2),
  sha256: Hash,
  bytes: Size,
  chunks: Schema.Array(Chunk),
}
const PayloadSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("utf8_input"),
    text: Schema.String,
  }),
  Schema.Struct({ ...Chunked, kind: Schema.Literal("chunked_utf8_input") }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("normalized_markdown"),
    normalization_version: Schema.Literal(1),
    markdown: Schema.String,
  }),
  Schema.Struct({
    ...Chunked,
    kind: Schema.Literal("chunked_normalized_markdown"),
    normalization_version: Schema.Literal(1),
  }),
])
type TextKind = "input" | "body"
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_CREATE_TEXT_INVALID", "The retained complete text object is invalid."),
  })

/** Small original payloads and identities remain byte-for-byte unchanged.
 * Large text uses the existing exact-byte chunk codec, never a larger fact. */
export function prepareSharedCreateText(value: string, kind: TextKind) {
  return Effect.gen(function* () {
    const bytes = new TextEncoder().encode(value)
    yield* checked(() => {
      if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== value)
        throw fail("SHARED_CREATE_TEXT_INVALID", "Original text must be complete UTF-8.")
      if (kind === "body" && normalizeObservedBody(value) !== value)
        throw fail("SHARED_CREATE_TEXT_INVALID", "A retained body must already be normalized.")
    })
    const hash = yield* sha256(bytes)
    const object_id = `${kind === "input" ? "input" : "body"}-${hash}`
    const operation_id = `${kind === "input" ? "retain-input" : "retain"}-${hash}`
    const inline =
      kind === "input" ? sharedCreateInputPayload(value) : sharedCreateBodyPayload(value)
    const length = new TextEncoder().encode(
      canonicalSharedJson({ version: 1, operation_id, payload: inline }),
    ).length
    if (length <= SHARED_FACT_ENVELOPE_BYTES) {
      yield* checked(() => validateSharedRecordEnvelope(operation_id, inline))
      return {
        object_id,
        operation_id,
        sha256: hash,
        bytes: bytes.length,
        payload: inline,
        objects: [],
      }
    }
    const prepared = yield* prepareSharedResourceContent(bytes, null)
    const common = {
      version: 2 as const,
      sha256: hash,
      bytes: bytes.length,
      chunks: prepared.manifest.chunks,
    }
    const payload =
      kind === "input"
        ? { ...common, kind: "chunked_utf8_input" as const }
        : {
            ...common,
            kind: "chunked_normalized_markdown" as const,
            normalization_version: 1 as const,
          }
    yield* checked(() => {
      validateSharedRecordEnvelope(operation_id, payload)
      for (const object of prepared.objects)
        validateSharedRecordEnvelope(`retain-${object.object_id}`, object.payload)
    })
    return {
      object_id,
      operation_id,
      sha256: hash,
      bytes: bytes.length,
      payload,
      objects: prepared.objects,
    }
  })
}

export function retainSharedCreateText(
  library: SharedLibrary,
  page: string,
  value: string,
  kind: TextKind,
  mode: "create" | "reconcile",
) {
  return Effect.gen(function* () {
    const prepared = yield* prepareSharedCreateText(value, kind)
    for (const object of prepared.objects)
      yield* appendSharedRecord(library, {
        mode,
        skillPageId: page,
        kind: "object",
        recordId: object.object_id,
        entityId: object.object_id,
        operationId: `retain-${object.object_id}`,
        payload: object.payload,
        payloadContainsBody: true,
      })
    return yield* appendSharedRecord(library, {
      mode,
      skillPageId: page,
      kind: "object",
      recordId: prepared.object_id,
      entityId: prepared.object_id,
      operationId: prepared.operation_id,
      payload: prepared.payload,
      payloadContainsBody: true,
    })
  })
}

/** Called after the owner verified the exact record and original operation identity. */
export function readSharedCreateTextPayload(
  library: SharedLibrary,
  page: string,
  expected: { readonly kind: TextKind; readonly sha256: string; readonly bytes?: number },
  input: unknown,
) {
  return Effect.gen(function* () {
    const payload = yield* checked(() =>
      Schema.decodeUnknownSync(PayloadSchema)(input, { onExcessProperty: "error" }),
    )
    const isInput = payload.kind === "utf8_input" || payload.kind === "chunked_utf8_input"
    if (isInput !== (expected.kind === "input"))
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_TEXT_INVALID",
          "Retained input and body objects are not interchangeable.",
        ),
      )
    let value: string
    if (payload.version === 1)
      value = payload.kind === "utf8_input" ? payload.text : payload.markdown
    else {
      if (
        payload.sha256 !== expected.sha256 ||
        (expected.bytes !== undefined && payload.bytes !== expected.bytes)
      )
        return yield* Effect.fail(
          fail("SHARED_CREATE_TEXT_INVALID", "The text manifest differs from its frozen identity."),
        )
      const bytes = yield* loadSharedRetainedByteFile(library, {
        skillPageId: page,
        sha256: payload.sha256,
        bytes: payload.bytes,
        chunks: payload.chunks,
      })
      value = yield* checked(() =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      )
    }
    const bytes = new TextEncoder().encode(value)
    if (
      (yield* sha256(bytes)) !== expected.sha256 ||
      (expected.bytes !== undefined && bytes.length !== expected.bytes) ||
      (expected.kind === "body" && normalizeObservedBody(value) !== value)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_TEXT_INVALID",
          "The complete text failed its original length, checksum or normalization.",
        ),
      )
    return value
  })
}
