import { fail } from "./model.ts"

/** Storage addresses carry an opaque identity in exactly one segment. */
export function identitySegment(identity: string): string {
  if (!identity || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(identity))
    throw fail(
      "STATE_CORRUPT",
      "A cache identity must be nonempty and contain no control characters.",
    )
  return encodeURIComponent(identity)
}

export function identityFromSegment(segment: string): string {
  try {
    const identity = decodeURIComponent(segment)
    if (identitySegment(identity) !== segment) throw new Error("Noncanonical storage address")
    return identity
  } catch {
    throw fail(
      "STATE_CORRUPT",
      "The cache identity segment is malformed or uses a retired address format.",
    )
  }
}
