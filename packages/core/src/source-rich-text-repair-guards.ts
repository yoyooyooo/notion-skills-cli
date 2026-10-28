import { isDeepStrictEqual } from "node:util"
import { contentAdoptionPropertyComparison } from "./publication-content-adoption-metadata.ts"
import type {
  SourceRichTextRepairPlan,
  SourceRichTextRepairObservation,
} from "./upstream-source-rich-text-repair-model.ts"

type BoundPlan = Pick<SourceRichTextRepairPlan, "input" | "before" | "effect">
const equal = isDeepStrictEqual
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function transport(value: unknown) {
  const raw = record(value)
  if (
    !raw ||
    (raw.request_id !== undefined && (typeof raw.request_id !== "string" || !raw.request_id))
  )
    return
  const { request_id: _request, ...rest } = raw
  return rest
}
function compatibleTransport(a: unknown, b: unknown) {
  const left = record(a),
    right = record(b)
  return (
    !!left &&
    !!right &&
    (left.request_id === undefined) === (right.request_id === undefined) &&
    transport(a) !== undefined &&
    transport(b) !== undefined
  )
}
function editedTime(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  allowed: boolean,
) {
  if (!allowed) return equal(before.last_edited_time, after.last_edited_time)
  const oldTime = before.last_edited_time,
    newTime = after.last_edited_time
  return (
    typeof oldTime === "string" &&
    typeof newTime === "string" &&
    Number.isFinite(Date.parse(oldTime)) &&
    Number.isFinite(Date.parse(newTime)) &&
    Date.parse(newTime) >= Date.parse(oldTime)
  )
}

/** Attachments are downloaded in full by the capturer before this projection.
 * Names, IDs, definitions and every other field stay exact. */
function pageMetadata(value: unknown, allowTime: boolean) {
  const original = transport(value)
  if (!original) return
  const copy = structuredClone(original),
    fields = record(copy.properties)
  if (!fields) return
  for (const field of Object.values(fields)) {
    const body = record(field)
    if (body?.type !== "files") continue
    if (!Array.isArray(body.files)) return
    for (const value of body.files) {
      const item = record(value)
      if (!item) return
      if (item.type !== "file") continue
      const file = record(item.file)
      if (!file || typeof file.url !== "string") return
      file.url = "<independently-verified-attachment-bytes>"
      if (Object.hasOwn(file, "expiry_time")) {
        if (typeof file.expiry_time !== "string") return
        file.expiry_time = "<signed-download-expiry>"
      }
    }
  }
  if (allowTime) {
    copy.properties = Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [
        name,
        contentAdoptionPropertyComparison(field, original.last_edited_time),
      ]),
    )
    delete copy.last_edited_time
  }
  return copy
}

function blockMatches(before: unknown, expected: unknown, actual: unknown, allowTime: boolean) {
  const previous = record(before),
    wanted = record(expected),
    found = record(actual)
  if (!previous || !wanted || !found || !editedTime(previous, found, allowTime)) return false
  const a = structuredClone(wanted),
    b = structuredClone(found)
  if (allowTime) {
    delete a.last_edited_time
    delete b.last_edited_time
  }
  return equal(a, b)
}

/** The only request allowed by this protocol must ACK the complete expected
 * block. No observed-applied result is manufactured into an acknowledgement. */
export function sourceRichTextRepairAckMatches(plan: BoundPlan, response: unknown) {
  const actual = transport(response)
  return !!actual && blockMatches(plan.effect.before_block, plan.effect.after_block, actual, true)
}

/** Complete physical BEFORE/AFTER relation. AFTER is still not a body or source
 * proof: the unchanged native strict proof is required separately. */
export function sourceRichTextRepairObservationMatches(
  plan: BoundPlan,
  observed: SourceRichTextRepairObservation,
  phase: "before" | "after",
) {
  const before = plan.before,
    after = phase === "after"
  if (
    !equal(before.page_ids, [plan.input.page_id]) ||
    !equal(observed.page_ids, before.page_ids) ||
    !equal(before.attachments, observed.attachments) ||
    !equal(Object.keys(before.raw).sort(), Object.keys(observed.raw).sort()) ||
    (!after && before.graph_sha256 !== observed.graph_sha256)
  )
    return false
  const root = `v1/pages/${plan.input.page_id}`,
    target = plan.effect.block_id
  const allowedTimes = new Set([target, ...plan.effect.ancestor_ids])
  let selected = 0
  for (const path of Object.keys(before.raw)) {
    const old = before.raw[path],
      current = observed.raw[path]
    if (!compatibleTransport(old, current)) return false
    if (path === root) {
      const oldPage = record(old),
        newPage = record(current)
      const oldMetadata = pageMetadata(old, after),
        newMetadata = pageMetadata(current, after)
      if (
        !oldPage ||
        !newPage ||
        !oldMetadata ||
        !newMetadata ||
        !editedTime(oldPage, newPage, after) ||
        !equal(oldMetadata, newMetadata)
      )
        return false
      continue
    }
    if (after && path === root + "/markdown") {
      const a = transport(old),
        b = transport(current)
      if (!a || !b || typeof a.markdown !== "string" || typeof b.markdown !== "string") return false
      delete a.markdown
      delete b.markdown
      if (!equal(a, b)) return false
      continue
    }
    if (/^v1\/blocks\/[^/]+\/children\?/.test(path)) {
      const a = transport(old),
        b = transport(current)
      if (
        !a ||
        !b ||
        !Array.isArray(a.results) ||
        !Array.isArray(b.results) ||
        a.results.length !== b.results.length
      )
        return false
      for (const [index, value] of a.results.entries()) {
        const previous = record(value),
          found = record(b.results[index])
        if (!previous || !found || typeof previous.id !== "string" || previous.id !== found.id)
          return false
        const isTarget = previous.id === target
        if (isTarget) {
          selected++
          if (!equal(previous, plan.effect.before_block)) return false
        }
        if (
          !blockMatches(
            previous,
            after && isTarget ? plan.effect.after_block : previous,
            found,
            after && allowedTimes.has(previous.id),
          )
        )
          return false
      }
      delete a.results
      delete b.results
      if (!equal(a, b)) return false
      continue
    }
    if (!equal(transport(old), transport(current))) return false
  }
  return (
    selected === 1 && before.raw[root] !== undefined && before.raw[root + "/markdown"] !== undefined
  )
}
