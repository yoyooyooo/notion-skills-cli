import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { describe, expect, test } from "vitest"
import { decodeSharedRecordStorage, encodeSharedRecordStorage } from "../src/shared-record-codec.ts"
import { canonicalSharedRecordEnvelope } from "../src/shared-records.ts"

describe("fixed-manifest storage on the supported Node runtime", () => {
  test("the pinned encoder keeps request bytes stable across runtimes and leaves small records unchanged", () => {
    const small = '{"operation_id":"original","payload":{},"version":1}'
    expect(encodeSharedRecordStorage(small)).toBe(small)
    const canonical = JSON.stringify({
      operation_id: "fixed-original",
      payload: { version: 1, kind: "fixed_snapshot", files: ["complete 😀 metadata".repeat(5000)] },
      version: 1,
    })
    const wire = encodeSharedRecordStorage(canonical)
    expect(createHash("sha256").update(wire).digest("hex")).toBe(
      "d5b036abebc2305a1e4c90b39780a696fa2a73458788d60793f3d3b88c19a668",
    )
    expect(encodeSharedRecordStorage(canonical)).toBe(wire)
    expect(decodeSharedRecordStorage(wire, true).envelope).toEqual(JSON.parse(canonical))
    expect(canonicalSharedRecordEnvelope("snapshot", wire)).toBe(
      JSON.stringify({
        operation_id: "fixed-original",
        payload: {
          files: ["complete 😀 metadata".repeat(5000)],
          kind: "fixed_snapshot",
          version: 1,
        },
        version: 1,
      }),
    )
    expect(() => canonicalSharedRecordEnvelope("file_event", wire)).toThrow()
  })

  test("the native decompressor stops expansion at the validated declared byte bound", () => {
    const bomb = JSON.stringify({
      version: 2,
      encoding: "gzip-base64",
      bytes: 1024,
      data: gzipSync(new Uint8Array(2 * 1024 * 1024)).toString("base64"),
    })
    expect(() => decodeSharedRecordStorage(bomb, true)).toThrow(
      "corrupt or exceeds its expanded byte bound",
    )
  })

  test("valid gzip cannot smuggle invalid UTF-8 or a non-manifest into the logical record", () => {
    const invalidUtf8 = JSON.stringify({
      version: 2,
      encoding: "gzip-base64",
      bytes: 1,
      data: gzipSync(new Uint8Array([255])).toString("base64"),
    })
    expect(() => decodeSharedRecordStorage(invalidUtf8, true)).toThrow("complete UTF-8")
    const ordinary = JSON.stringify({
      version: 1,
      operation_id: "original",
      payload: { version: 1, kind: "file_observation", body: "original" },
    })
    const forged = JSON.stringify({
      version: 2,
      encoding: "gzip-base64",
      bytes: Buffer.byteLength(ordinary),
      data: gzipSync(ordinary).toString("base64"),
    })
    expect(() => canonicalSharedRecordEnvelope("operation", forged)).toThrow(
      "Only complete fixed manifests",
    )
  })
})
