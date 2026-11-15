import { Effect } from "effect"
import { Store, sha256 } from "./store.ts"

/** Describe an existing mismatch without another read, normalization or retry. */
export function describeNotionReadbackMismatch(input: {
  readonly expected: string
  readonly observed: string
  readonly projectionVersion?: number
}) {
  const encoder = new TextEncoder()
  const expected = encoder.encode(input.expected)
  const observed = encoder.encode(input.observed)
  let offset = 0
  while (
    offset < expected.length &&
    offset < observed.length &&
    expected[offset] === observed[offset]
  )
    offset++
  const equal = offset === expected.length && offset === observed.length
  const start = Math.max(0, offset - 12)
  const end = offset + 36
  const hex = (bytes: Uint8Array) =>
    Array.from(bytes.subarray(start, end), (value) => value.toString(16).padStart(2, "0")).join("")
  return {
    version: 1,
    comparison: "exact_normalized_utf8",
    projection_version: input.projectionVersion ?? null,
    expected_bytes: expected.length,
    observed_bytes: observed.length,
    first_difference: equal
      ? null
      : {
          byte_offset: offset,
          excerpt_start: start,
          expected_hex: hex(expected),
          observed_hex: hex(observed),
          excerpt_limit_bytes: 48,
        },
    automatic_retry: false,
  } as const
}

/** Retain the response already in hand in the durable operation domain. It is
 * evidence of this observation, never an ACK or permission to accept its body. */
export function retainNotionReadbackMismatch(input: {
  readonly operationId: string
  readonly pageId: string
  readonly expected: string
  readonly observed: string
  readonly rawObserved: string
  readonly projectionVersion?: number
}) {
  return Effect.gen(function* () {
    const diagnostic = describeNotionReadbackMismatch(input)
    const observation = {
      version: 1,
      kind: "notion_readback_mismatch",
      operation_id: input.operationId,
      page_id: input.pageId,
      projection_version: input.projectionVersion ?? null,
      expected_sha256: yield* sha256(input.expected),
      observed_sha256: yield* sha256(input.observed),
      raw_observed_markdown: input.rawObserved,
      diagnostic,
    }
    const bytes = new TextEncoder().encode(JSON.stringify(observation))
    const hash = yield* sha256(bytes)
    const key = `operations/readback-mismatches/${yield* sha256(input.operationId)}/${hash}.json`
    yield* (yield* Store).writeBytes(key, bytes)
    return {
      ...diagnostic,
      original_observation_preserved: true,
      observation: { key, sha256: hash, bytes: bytes.length },
    }
  })
}
