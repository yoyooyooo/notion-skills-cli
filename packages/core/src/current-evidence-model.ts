import { Schema } from "effect"
import { fail } from "./model.ts"

/** A change detector is narrower than a successful current/body validation. */
export const CurrentFactSchema = Schema.Struct({
  identity: Schema.String,
  fingerprint: Schema.String,
})
export type CurrentFact = typeof CurrentFactSchema.Type
export const CurrentEvidenceSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String,
  facts: Schema.Array(
    Schema.Struct({
      ...CurrentFactSchema.fields,
      epoch: Schema.Number,
    }),
  ),
  records: Schema.Array(
    Schema.Struct({
      identity: Schema.String,
      retired_through: Schema.Number,
    }),
  ),
})
export type CurrentEvidence = typeof CurrentEvidenceSchema.Type
export type CurrentFactObservation = CurrentFact & {
  readonly scope: string
  readonly generation: number
  readonly observed_at: number
  readonly epoch: number
}
export const CURRENT_EVIDENCE_GENERATION = "current-evidence"

export function validateCurrentFacts(scope: string, facts: readonly CurrentFact[]) {
  if (!/^[a-f0-9]{64}$/u.test(scope) || facts.length === 0)
    throw fail("STATE_CORRUPT", "Current evidence requires an exact scope and nonempty read set.")
  const identities = new Set<string>()
  for (const fact of facts) {
    if (
      !/^(?:page|files|sources|relations):[^\p{Cc}\p{Cf}\p{Cs}]{1,2048}$/u.test(fact.identity) ||
      !/^[a-f0-9]{64}$/u.test(fact.fingerprint) ||
      identities.has(fact.identity)
    )
      throw fail("STATE_CORRUPT", "Current evidence contains an invalid or repeated fact.")
    identities.add(fact.identity)
  }
}

export function validateCurrentEvidence(evidence: CurrentEvidence) {
  validateCurrentFacts(evidence.scope, evidence.facts)
  if (
    evidence.version !== 1 ||
    evidence.facts.some((fact) => !Number.isSafeInteger(fact.epoch) || fact.epoch < 1)
  )
    throw fail("STATE_CORRUPT", "Current evidence requires positive fact epochs.")
  if (
    evidence.records.length === 0 ||
    evidence.records.some(
      (record) =>
        !record.identity ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(record.identity) ||
        !Number.isSafeInteger(record.retired_through) ||
        record.retired_through < 0,
    )
  )
    throw fail("STATE_CORRUPT", "Current evidence requires exact permission and retirement guards.")
  const records = new Set(evidence.records.map((record) => record.identity))
  if (
    records.size !== evidence.records.length ||
    !records.has("access:scope") ||
    evidence.facts.some(
      (fact) => fact.identity.startsWith("page:") && !records.has(fact.identity.slice(5)),
    )
  )
    throw fail("STATE_CORRUPT", "Current evidence omits or repeats an authority guard.")
}
