import { isDeepStrictEqual } from "node:util"
import { property } from "./model.ts"
import { contentAdoptionPropertyComparison } from "./publication-content-adoption-metadata.ts"
import { sourceRootCompletionExactBefore } from "./source-root-completion-guards.ts"
import {
  sourceRootFidelityStageMatches,
  type SourceRootFidelityEffect,
  type SourceRootFidelityParent,
} from "./source-root-fidelity-effect.ts"
import type { SourceRootCompletionObservation } from "./upstream-source-root-completion-model.ts"

const equal = isDeepStrictEqual
function transport(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const raw = property(value)
  if (raw.request_id !== undefined && (typeof raw.request_id !== "string" || !raw.request_id))
    return
  const { request_id: _request, ...rest } = raw
  return rest
}
function compatible(left: unknown, right: unknown) {
  return (
    transport(left) !== undefined &&
    transport(right) !== undefined &&
    (property(left).request_id === undefined) === (property(right).request_id === undefined)
  )
}
function advanced(before: unknown, after: unknown) {
  return (
    typeof before === "string" &&
    typeof after === "string" &&
    Number.isFinite(Date.parse(before)) &&
    Number.isFinite(Date.parse(after)) &&
    Date.parse(after) >= Date.parse(before)
  )
}
function rootMetadata(value: unknown) {
  const raw = transport(value)
  if (!raw) return
  const { last_edited_time: _time, ...rest } = raw
  return {
    ...rest,
    properties: Object.fromEntries(
      Object.entries(property(raw.properties)).map(([name, field]) => [
        name,
        contentAdoptionPropertyComparison(field, raw.last_edited_time),
      ]),
    ),
  }
}
function blockMatches(before: unknown, wanted: unknown, actual: unknown, editTime: boolean) {
  const old = transport(before),
    expected = transport(wanted),
    found = transport(actual)
  if (!old || !expected || !found) return false
  if (!editTime) return equal(expected, found)
  if (!advanced(old.last_edited_time, found.last_edited_time)) return false
  delete expected.last_edited_time
  delete found.last_edited_time
  return equal(expected, found)
}

/** A returned block is retained as an ACK only when it contains the entire
 * expected source field and every unrequested identity/ownership field. */
export function sourceRootFidelityAckMatches(effect: SourceRootFidelityEffect, response: unknown) {
  return blockMatches(effect.before_block, effect.after_block, response, true)
}

export function sourceRootFidelityBeforeMatches(
  parent: SourceRootFidelityParent,
  effects: readonly SourceRootFidelityEffect[],
  checkpoint: SourceRootCompletionObservation,
  observed: SourceRootCompletionObservation,
  completed: number,
) {
  return (
    sourceRootCompletionExactBefore(checkpoint, observed) &&
    sourceRootFidelityStageMatches(parent, effects, observed, completed)
  )
}

/** Exactly one preplanned block effect may separate two complete observations.
 * Necessary edit times may advance on that block, its table ancestor and root;
 * no other raw field, page, row, order, cursor, reference or source value moves. */
export function sourceRootFidelityAfterMatches(
  parent: SourceRootFidelityParent,
  effects: readonly SourceRootFidelityEffect[],
  before: SourceRootCompletionObservation,
  observed: SourceRootCompletionObservation,
  effectIndex: number,
) {
  try {
    const effect = effects[effectIndex]
    if (
      !effect ||
      !sourceRootFidelityStageMatches(parent, effects, before, effectIndex) ||
      !sourceRootFidelityStageMatches(parent, effects, observed, effectIndex + 1) ||
      !equal(before.page_ids, observed.page_ids) ||
      !equal(before.attachments, observed.attachments) ||
      !equal(Object.keys(before.raw).sort(), Object.keys(observed.raw).sort())
    )
      return false
    const root = `v1/pages/${parent.input.page_id}`,
      times = new Set([effect.block_id, ...effect.ancestor_ids])
    let selected = 0
    for (const path of Object.keys(before.raw)) {
      const old = before.raw[path],
        current = observed.raw[path]
      if (!compatible(old, current)) return false
      if (path === root) {
        if (
          !advanced(property(old).last_edited_time, property(current).last_edited_time) ||
          !equal(rootMetadata(old), rootMetadata(current))
        )
          return false
      } else if (path === root + "/markdown") {
        const a = transport(old)!,
          b = transport(current)!
        if (typeof a.markdown !== "string" || typeof b.markdown !== "string") return false
        delete a.markdown
        delete b.markdown
        if (!equal(a, b)) return false
      } else if (/^v1\/blocks\/[^/]+\/children\?/.test(path)) {
        const a = transport(old)!,
          b = transport(current)!
        if (
          !Array.isArray(a.results) ||
          !Array.isArray(b.results) ||
          a.results.length !== b.results.length
        )
          return false
        for (const [index, value] of a.results.entries()) {
          const previous = property(value),
            found = property(b.results[index])
          if (typeof previous.id !== "string" || previous.id !== found.id) return false
          const target = previous.id === effect.block_id
          if (target && (++selected !== 1 || !equal(previous, effect.before_block))) return false
          if (
            !blockMatches(
              previous,
              target ? effect.after_block : previous,
              found,
              times.has(previous.id),
            )
          )
            return false
        }
        delete a.results
        delete b.results
        if (!equal(a, b)) return false
      } else if (!equal(transport(old), transport(current))) return false
    }
    return (
      selected === 1 &&
      before.raw[root] !== undefined &&
      before.raw[root + "/markdown"] !== undefined
    )
  } catch {
    return false
  }
}
