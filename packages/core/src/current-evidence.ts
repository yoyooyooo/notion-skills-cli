import { Clock, Effect, Option, Schema } from "effect"
import {
  CURRENT_EVIDENCE_GENERATION,
  type CurrentEvidence,
  type CurrentFact,
} from "./current-evidence-model.ts"
import { fail, property } from "./model.ts"
import { pageId } from "./ref.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { Store, sha256 } from "./store.ts"

const ScopeSchema = Schema.Struct({ scope: Schema.String })

export function currentFact(identity: string, value: unknown) {
  return sha256(canonicalSharedJson(value)).pipe(
    Effect.map((fingerprint): CurrentFact => ({ identity, fingerprint })),
  )
}

export function currentRelationFact(owner: string, propertyId: string, members: readonly string[]) {
  return currentFact(
    `relations:${pageId(owner) ?? owner}:${propertyId}`,
    [...members].map((member) => pageId(member) ?? member).sort(),
  )
}

/** Page time is only a hint about this page, never a complete child collection. */
export function currentPageFact(raw: unknown) {
  return Effect.gen(function* () {
    const row = property(raw)
    const id = typeof row.id === "string" ? pageId(row.id) : undefined
    const time = typeof row.last_edited_time === "string" ? Date.parse(row.last_edited_time) : NaN
    if (id === undefined || !Number.isFinite(time) || time < 0) return undefined
    return yield* currentFact(`page:${id}`, {
      last_edited_time: new Date(time).toISOString(),
      archived: row.archived === true || row.is_archived === true,
      in_trash: row.in_trash === true,
    })
  })
}

/** Select only a previously authenticated local mapping. This performs no HTTP. */
export function beginCurrentEvidence(
  credential: Effect.Effect<string, import("./model.ts").SkillsError>,
  origin = "https://api.notion.com",
) {
  return Effect.gen(function* () {
    const store = Option.getOrUndefined(yield* Effect.serviceOption(Store))
    if (store?.currentEvidence === undefined) return undefined
    const identity = yield* sha256(JSON.stringify([yield* credential, "", origin]))
    const selected = yield* store.readJson(`cache/identities/${identity}.json`, ScopeSchema)
    if (selected === undefined) return undefined
    const generation = yield* store.reserveCacheGeneration(
      selected.scope,
      CURRENT_EVIDENCE_GENERATION,
    )
    return { store: store.currentEvidence, scope: selected.scope, generation }
  })
}
export type CurrentEvidenceAttempt = Effect.Success<ReturnType<typeof beginCurrentEvidence>>
const responseAttempts = new WeakMap<object, NonNullable<CurrentEvidenceAttempt>>()

/** A waiter cannot turn an older shared HTTP producer into newer collection evidence. */
export function currentEvidenceForResponse(attempt: CurrentEvidenceAttempt, response: unknown) {
  return Effect.gen(function* () {
    if (attempt === undefined || typeof response !== "object" || response === null) return attempt
    const producer = responseAttempts.get(response)
    if (producer === undefined) return attempt
    if (producer.scope !== attempt.scope)
      return yield* Effect.fail(
        fail("CACHE_INVALIDATED", "The shared response belongs to a different current scope."),
      )
    return producer.generation < attempt.generation ? producer : attempt
  })
}

export function observeCurrentFacts(
  attempt: CurrentEvidenceAttempt,
  facts: readonly CurrentFact[],
) {
  return Effect.gen(function* () {
    if (attempt === undefined || facts.length === 0) return
    yield* attempt.store.observe({
      scope: attempt.scope,
      generation: attempt.generation,
      observed_at: yield* Clock.currentTimeMillis,
      facts,
    })
  })
}

/** All Notion page responses can invalidate old proofs, including catalog and management reads. */
export function withNotionChangeEvidence<A>(
  credential: string,
  origin: string,
  path: string,
  effect: Effect.Effect<A, import("./model.ts").SkillsError>,
) {
  return Effect.gen(function* () {
    if (!/^v1\/(?:pages(?:\/|$)|data_sources\/[^/]+\/query(?:\?|$))/u.test(path))
      return yield* effect
    const attempt = yield* beginCurrentEvidence(Effect.succeed(credential), origin)
    const value = yield* effect
    if (attempt === undefined) return value
    if (typeof value === "object" && value !== null) responseAttempts.set(value, attempt)
    const envelope = property(value)
    const rows =
      envelope.object === "page"
        ? [value]
        : envelope.object === "list" && Array.isArray(envelope.results)
          ? envelope.results.filter((row) => property(row).object === "page")
          : []
    const facts: CurrentFact[] = []
    for (const row of rows) {
      const fact = yield* currentPageFact(row)
      if (fact !== undefined && !facts.some((previous) => previous.identity === fact.identity))
        facts.push(fact)
      // A complete inline relation is part of this exact response attempt. A
      // later consumer must not attach a new generation to a supplied old page.
      const owner = pageId(String(property(row).id ?? ""))
      if (owner === undefined) continue
      for (const value of Object.values(property(property(row).properties))) {
        const relation = property(value)
        if (
          relation.type !== "relation" ||
          relation.has_more !== false ||
          typeof relation.id !== "string" ||
          !Array.isArray(relation.relation)
        )
          continue
        const members = relation.relation.flatMap((member) => {
          const id = pageId(String(property(member).id ?? ""))
          return id === undefined ? [] : [id]
        })
        if (members.length !== relation.relation.length || new Set(members).size !== members.length)
          continue
        const collection = yield* currentRelationFact(owner, relation.id, members)
        if (!facts.some((previous) => previous.identity === collection.identity))
          facts.push(collection)
      }
    }
    yield* observeCurrentFacts(attempt, facts)
    return value
  })
}

/** Capture only the fingerprints actually used to construct this candidate. */
export function captureCurrentEvidence(
  scope: string,
  facts: readonly CurrentFact[],
  records: readonly string[] = [],
) {
  return Effect.gen(function* () {
    const store = yield* Store
    if (store.currentEvidence === undefined) return undefined
    return yield* store.currentEvidence.capture(scope, facts, records)
  })
}
export function currentEvidenceMatches(evidence: CurrentEvidence | undefined) {
  return Effect.gen(function* () {
    const store = yield* Store
    if (store.currentEvidence === undefined) return true
    return evidence !== undefined && (yield* store.currentEvidence.matches(evidence))
  })
}
export function assertCurrentEvidence(evidence: CurrentEvidence | undefined) {
  return Effect.gen(function* () {
    if (!(yield* currentEvidenceMatches(evidence)))
      return yield* Effect.fail(
        fail(
          "CACHE_INVALIDATED",
          "Known current facts changed during preparation. Select current content again.",
        ),
      )
  })
}

/** One database read transaction admits the entire current dependency closure. */
export function assertCurrentEvidenceSet(evidences: readonly (CurrentEvidence | undefined)[]) {
  return Effect.gen(function* () {
    const store = yield* Store
    if (store.currentEvidence === undefined || evidences.length === 0) return
    const scope = evidences[0]?.scope
    const facts = new Map<string, CurrentEvidence["facts"][number]>()
    const records = new Map<string, CurrentEvidence["records"][number]>()
    for (const evidence of evidences) {
      if (evidence === undefined || evidence.scope !== scope)
        return yield* Effect.fail(
          fail("CACHE_INVALIDATED", "The current dependency closure has no complete evidence."),
        )
      for (const fact of evidence.facts) {
        const previous = facts.get(fact.identity)
        if (
          previous !== undefined &&
          (previous.fingerprint !== fact.fingerprint || previous.epoch !== fact.epoch)
        )
          return yield* Effect.fail(
            fail("CACHE_INVALIDATED", "The current dependency closure selected conflicting facts."),
          )
        facts.set(fact.identity, fact)
      }
      for (const record of evidence.records) {
        const previous = records.get(record.identity)
        if (previous !== undefined && previous.retired_through !== record.retired_through)
          return yield* Effect.fail(
            fail("CACHE_INVALIDATED", "The dependency closure changed across a retirement."),
          )
        records.set(record.identity, record)
      }
    }
    yield* assertCurrentEvidence({
      version: 1,
      scope: scope!,
      facts: [...facts.values()],
      records: [...records.values()],
    })
  })
}
