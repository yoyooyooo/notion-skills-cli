import { gunzipSync } from "node:zlib"
import { gzipSync } from "fflate"
import { fail, property } from "./model.ts"

export const SHARED_FACT_ENVELOPE_BYTES = 64 * 1024
export const SHARED_FIXED_MANIFEST_BYTES = 1024 * 1024
export const SHARED_ENCODED_MANIFEST_BYTES = 180 * 1024

const byteLength = (value: string) => new TextEncoder().encode(value).length
const invalid = (message: string) => fail("INVALID_SHARED_RECORD", message)

/** Compression is a storage codec. The canonical logical envelope still owns identity. */
export function encodeSharedRecordStorage(canonical: string): string {
  const bytes = new TextEncoder().encode(canonical)
  if (bytes.length <= SHARED_FACT_ENVELOPE_BYTES) return canonical
  const encoded = JSON.stringify({
    version: 2,
    encoding: "gzip-base64",
    bytes: bytes.length,
    // Pin both encoder implementation and gzip timestamp: request identities
    // must not vary with the host's zlib build or wall clock.
    data: Buffer.from(gzipSync(bytes, { level: 9, mtime: 0 })).toString("base64"),
  })
  if (byteLength(encoded) > SHARED_ENCODED_MANIFEST_BYTES)
    throw fail(
      "SHARED_RECORD_TOO_LARGE",
      "The complete compressed manifest exceeds its 180 KiB storage envelope; it cannot be truncated.",
      { max_bytes: SHARED_ENCODED_MANIFEST_BYTES, limit: "encoded_manifest" },
    )
  return encoded
}

export function parseSharedRecordJson(encoded: string): unknown {
  try {
    return JSON.parse(encoded)
  } catch {
    throw invalid("Record Payload must be valid JSON.")
  }
}

/** Bound wire bytes before parsing and expanded bytes inside the decompressor. */
export function decodeSharedRecordStorage(encoded: string, manifestKind: boolean) {
  const wireBytes = byteLength(encoded)
  const wireLimit = manifestKind ? SHARED_ENCODED_MANIFEST_BYTES : SHARED_FACT_ENVELOPE_BYTES
  if (wireBytes > wireLimit)
    throw fail("SHARED_RECORD_TOO_LARGE", "Stored shared record exceeds its wire limit.", {
      max_bytes: wireLimit,
    })
  const envelope = parseSharedRecordJson(encoded)
  const raw = property(envelope)
  if (raw.version !== 2) {
    if (wireBytes > SHARED_FACT_ENVELOPE_BYTES)
      throw fail("SHARED_RECORD_TOO_LARGE", "Stored version-1 record exceeds 64 KiB.")
    return { envelope, compressed: false }
  }
  if (
    !manifestKind ||
    Object.keys(raw).length !== 4 ||
    raw.encoding !== "gzip-base64" ||
    typeof raw.bytes !== "number" ||
    !Number.isSafeInteger(raw.bytes) ||
    raw.bytes <= 0 ||
    raw.bytes > SHARED_FIXED_MANIFEST_BYTES ||
    typeof raw.data !== "string" ||
    raw.data.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(raw.data)
  )
    throw invalid("Invalid compressed fixed-manifest envelope.")
  const compressed = Buffer.from(raw.data, "base64")
  if (compressed.toString("base64") !== raw.data)
    throw invalid("Compressed manifest Base64 must be canonical.")
  let expanded: Uint8Array
  try {
    expanded = gunzipSync(compressed, { maxOutputLength: raw.bytes })
  } catch {
    throw invalid("The compressed manifest is corrupt or exceeds its expanded byte bound.")
  }
  if (expanded.length !== raw.bytes)
    throw invalid("The compressed manifest does not match its declared byte count.")
  let json: string
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(expanded)
  } catch {
    throw invalid("The expanded manifest must contain complete UTF-8 JSON.")
  }
  return { envelope: parseSharedRecordJson(json), compressed: true }
}
