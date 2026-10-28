import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { fail } from "../src/model.ts"
import type { Receipt } from "../src/publication-model.ts"
import {
  publicationIntegrityMigration,
  type IntegrityIntent,
} from "../src/publication-integrity-state.ts"
import type { UpstreamBinding, UpstreamOperation, UpstreamPlan } from "../src/upstream-model.ts"
import {
  makeUpstreamRepository,
  upstreamMigration,
  type UpstreamRepository,
} from "../src/upstream-state.ts"

const page = "11111111-1111-4111-8111-111111111111"
const subscription = "22222222-2222-4222-8222-222222222222"
const database = "33333333-3333-4333-8333-333333333333"
const otherPage = "44444444-4444-4444-8444-444444444444"
const target = "target:original",
  otherTarget = "target:other"
const originalId = `up_${"a".repeat(64)}`
const repairKey = (suffix: string) => `source-rich-text-repair:member:${suffix}:0`
const adoptionKey = (suffix: string) => `content-adoption:plan:${suffix}`
const key = repairKey(originalId)

interface Fixture {
  readonly sql: SqlClient.SqlClient
  readonly repository: UpstreamRepository
}

function withFixture<A, E>(work: (fixture: Fixture) => Effect.Effect<A, E>) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqliteClient.make({ filename: ":memory:", disableWAL: true })
        yield* sql`PRAGMA foreign_keys = ON`
        yield* upstreamMigration.pipe(Effect.provideService(SqlClient.SqlClient, sql))
        yield* sql`CREATE TABLE publications (id TEXT PRIMARY KEY, operation TEXT NOT NULL, state TEXT NOT NULL, scope TEXT, page_id TEXT, payload TEXT NOT NULL)`
        yield* sql`CREATE TABLE publication_integrity_ledgers (key TEXT PRIMARY KEY, payload TEXT NOT NULL)`
        yield* publicationIntegrityMigration.pipe(Effect.provideService(SqlClient.SqlClient, sql))
        const repository = makeUpstreamRepository(sql),
          contentHash = "b".repeat(64)
        const frozen = {
          kind: "skill" as const,
          name: "retained-original",
          description: "Use for native state retention tests.",
          main: "SKILL.md",
          files: [{ path: "SKILL.md", hash: contentHash }],
        }
        const original: UpstreamPlan = {
          version: 1,
          plan_id: originalId,
          plan_hash: "a".repeat(64),
          created_at: 1,
          subscription_id: subscription,
          subscription_version: "retained-version",
          scope: "fixture-scope",
          database_id: database,
          config_hash: "c".repeat(64),
          revision: "retained-revision",
          provenance: {},
          publisher_subscription_id: subscription,
          target_database_id: database,
          items: [
            {
              member_key: "skills/retained-original",
              target_key: target,
              action: "create",
              reason: "source-changed",
              generation: 0,
              content_hash: contentHash,
              candidate: frozen,
              accepted: frozen,
              deltas: [],
            },
          ],
        }
        const operation: UpstreamOperation = {
          operation_id: "uo_retained_original",
          plan_id: originalId,
          subscription_id: subscription,
          scope: original.scope,
          database_id: database,
          target_database_id: database,
          state: "verified",
          items: [
            {
              member_key: "skills/retained-original",
              status: "verified",
              page_id: page,
              publication_operation_id: "p_retained_original",
            },
          ],
        }
        const binding: UpstreamBinding = {
          subscription_id: subscription,
          member_key: "skills/retained-original",
          target_key: target,
          page_id: page,
          generation: 1,
          mode: "tracked",
          active: true,
          revision: original.revision,
          published_hash: contentHash,
          accepted: frozen,
          materialized: frozen,
        }
        const publication: Receipt = {
          format: 1,
          operation_id: "p_retained_original",
          operation: "create",
          state: "completed",
          scope: original.scope,
          database_id: database,
          data_source_id: "55555555-5555-4555-8555-555555555555",
          page_id: page,
          portable: { ...frozen, files: [{ path: "SKILL.md", sha256: contentHash }] },
          guards: {},
          intents: [],
          stages: [],
          result: { verified: true, operation_id: "p_retained_original" },
        }
        const integrity: IntegrityIntent = {
          version: 1,
          operation_id: publication.operation_id,
          intended_hash: contentHash,
          page_id: page,
          marker: {
            version: 2,
            operation_id: publication.operation_id,
            intended_hash: contentHash,
            state: "committed",
            revision: "d".repeat(64),
            manifest_hash: "e".repeat(64),
            ownership_hash: "f".repeat(64),
          },
        }
        yield* repository.savePlan(original)
        yield* repository.advance(binding, 0, subscription, operation)
        yield* repository.saveCommand("retained:original-map", {
          revision: original.revision,
          history: ["exact", 0],
        })
        yield* sql`INSERT INTO publications ${sql.insert({
          id: publication.operation_id,
          operation: publication.operation,
          state: publication.state,
          scope: publication.scope,
          page_id: page,
          payload: JSON.stringify(publication),
        })}`
        yield* sql`INSERT INTO integrity_operations ${sql.insert({
          operation_id: integrity.operation_id,
          publication_operation_id: integrity.operation_id,
          intended_hash: integrity.intended_hash,
          state: integrity.marker.state,
          page_id: page,
          payload: JSON.stringify(integrity),
        })}`
        return yield* work({ sql, repository })
      }),
    ).pipe(Effect.provide(Reactivity.layer)),
  )
}

const originalHistory = ({ sql }: Fixture) =>
  Effect.gen(function* () {
    return {
      plans: yield* sql`SELECT * FROM upstream_plans ORDER BY plan_id`,
      operations: yield* sql`SELECT * FROM upstream_operations ORDER BY operation_id`,
      bindings: yield* sql`SELECT * FROM upstream_bindings ORDER BY subscription_id,member_key`,
      targets: yield* sql`SELECT * FROM upstream_targets ORDER BY target_key`,
      commands:
        yield* sql`SELECT * FROM upstream_commands WHERE operation_id='retained:original-map'`,
      publications: yield* sql`SELECT * FROM publications ORDER BY id`,
      integrity: yield* sql`SELECT * FROM integrity_operations ORDER BY operation_id`,
    }
  })
const commands = ({ sql }: Fixture) => sql`SELECT * FROM upstream_commands ORDER BY operation_id`

// These are index/CAS payloads, not evidence accepted by the repair protocol.
// The strict plan and remote proof tests live at the domain boundary separately.
const indexedRepair = (phase: string, owner = page, targetKey = target) => ({
  format: 1,
  domain: "source_rich_text_repair_receipt",
  phase,
  attempts: [],
  plan: { input: { page_id: owner }, target_key: targetKey },
})
const indexedAdoption = (owner: string, selected: string, unselected = otherTarget) => ({
  phase: "planned",
  plan: {
    page_id: owner,
    item_index: 1,
    original_plan: { items: [{ target_key: unselected }, { target_key: selected }] },
  },
})

test("createCommand never overwrites an existing retained claim, including after a lost local response", async () => {
  await withFixture((f) =>
    Effect.gen(function* () {
      const before = yield* originalHistory(f),
        original = indexedRepair("planned")
      const lost = yield* f.repository
        .createCommand(key, original)
        .pipe(
          Effect.andThen(
            Effect.fail(
              fail("TEST_RESPONSE_LOST", "The command commit completed before the caller stopped."),
            ),
          ),
          Effect.result,
        )
      expect(lost._tag).toBe("Failure")
      expect(yield* f.repository.command(key)).toEqual(original)
      const retained = yield* commands(f)
      for (const value of [
        original,
        indexedRepair("pending"),
        indexedRepair("planned", otherPage),
      ]) {
        const duplicate = yield* f.repository.createCommand(key, value).pipe(Effect.result)
        expect(duplicate._tag).toBe("Failure")
        if (duplicate._tag === "Failure")
          expect(duplicate.failure.code).toBe("UPSTREAM_OPERATION_BUSY")
        expect(yield* commands(f)).toEqual(retained)
      }
      expect(yield* originalHistory(f)).toEqual(before)
    }),
  )
})

test("claimCommand advances one exact journal and stale or missing claims cannot replace it", async () => {
  await withFixture((f) =>
    Effect.gen(function* () {
      const before = yield* originalHistory(f),
        planned = indexedRepair("planned")
      yield* f.repository.createCommand(key, planned)
      const pending = {
        ...planned,
        phase: "pending",
        attempts: [
          { index: 0, outcome: "pending", request: { path: "v1/blocks/exact", method: "PATCH" } },
        ],
      }
      yield* f.repository.claimCommand(key, planned, pending)
      const retained = yield* commands(f)
      for (const [claimedKey, expected] of [
        [key, planned],
        [repairKey("missing"), pending],
      ] as const) {
        const stale = yield* f.repository
          .claimCommand(claimedKey, expected, indexedRepair("body_verified"))
          .pipe(Effect.result)
        expect(stale._tag).toBe("Failure")
        if (stale._tag === "Failure") expect(stale.failure.code).toBe("UPSTREAM_OPERATION_BUSY")
        expect(yield* commands(f)).toEqual(retained)
      }
      const unknown = {
        ...pending,
        phase: "unknown",
        attempts: [
          {
            ...pending.attempts[0],
            outcome: "unknown",
            failure: { code: "WRITE_OUTCOME_UNKNOWN", message: "The effect response was lost." },
          },
        ],
      }
      // Reordering JSON object keys is not a competing native state transition.
      const reordered = {
        attempts: pending.attempts,
        plan: pending.plan,
        phase: pending.phase,
        domain: pending.domain,
        format: pending.format,
      }
      yield* f.repository.claimCommand(key, reordered, unknown)
      expect(yield* f.repository.command(key)).toEqual(unknown)
      expect(yield* originalHistory(f)).toEqual(before)
    }),
  )
})

test("two concurrent exact CAS claimants retain one successor and reject the loser", async () => {
  await withFixture((f) =>
    Effect.gen(function* () {
      const before = yield* originalHistory(f),
        planned = indexedRepair("planned")
      yield* f.repository.createCommand(key, planned)
      const candidates = ["first", "second"].map((claimant) => ({
        ...planned,
        phase: "pending",
        claimant,
      }))
      const outcomes = yield* Effect.all(
        candidates.map((value) =>
          f.repository.claimCommand(key, planned, value).pipe(Effect.result),
        ),
        { concurrency: 2 },
      )
      expect(outcomes.filter((result) => result._tag === "Success")).toHaveLength(1)
      expect(outcomes.filter((result) => result._tag === "Failure")).toHaveLength(1)
      for (const result of outcomes)
        if (result._tag === "Failure") expect(result.failure.code).toBe("UPSTREAM_OPERATION_BUSY")
      const winner = outcomes.findIndex((result) => result._tag === "Success")
      expect(yield* f.repository.command(key)).toEqual(candidates[winner])
      expect(yield* originalHistory(f)).toEqual(before)
    }),
  )
})

test("repair claims cover every retained phase across plans by either page or target", async () => {
  await withFixture((f) =>
    Effect.gen(function* () {
      const before = yield* originalHistory(f)
      const phases = ["planned", "pending", "unknown", "acknowledged", "conflict", "body_verified"]
      const indexed = phases.map((phase, index) => ({
        operation_id: repairKey(`up_other_${index}`),
        value: indexedRepair(phase, index % 2 ? otherPage : page, index % 2 ? target : otherTarget),
      }))
      for (const claim of indexed)
        yield* f.repository.createCommand(claim.operation_id, claim.value)
      yield* f.repository.createCommand(
        repairKey("unrelated"),
        indexedRepair("pending", otherPage, otherTarget),
      )
      yield* f.repository.createCommand("unrelated:member:matching-data", indexedRepair("unknown"))
      const snapshot = yield* commands(f)
      expect(yield* f.repository.sourceRichTextRepairClaims(page, target)).toEqual(indexed)
      expect(yield* commands(f)).toEqual(snapshot)
      expect(yield* originalHistory(f)).toEqual(before)
    }),
  )
})

test("planned adoption and repair claims are discoverable in both directions without changing either journal", async () => {
  await withFixture((f) =>
    Effect.gen(function* () {
      const before = yield* originalHistory(f),
        repair = indexedRepair("pending")
      yield* f.repository.createCommand(key, repair)
      const byPage = adoptionKey("a_same_page"),
        byTarget = adoptionKey("b_same_target")
      yield* f.repository.createCommand(byPage, indexedAdoption(page, otherTarget))
      yield* f.repository.createCommand(byTarget, indexedAdoption(otherPage, target))
      // An unselected sibling's target must not masquerade as this plan's claim.
      yield* f.repository.createCommand(
        adoptionKey("c_unselected_match"),
        indexedAdoption(otherPage, otherTarget, target),
      )
      yield* f.repository.createCommand(
        "unrelated:plan:matching-data",
        indexedAdoption(page, target),
      )
      const snapshot = yield* commands(f)
      expect(yield* f.repository.contentAdoptionPlanClaims(page, target)).toEqual([
        byPage,
        byTarget,
      ])
      expect(yield* f.repository.sourceRichTextRepairClaims(page, target)).toEqual([
        { operation_id: key, value: repair },
      ])
      expect(yield* commands(f)).toEqual(snapshot)
      expect(yield* originalHistory(f)).toEqual(before)
      // These queries expose conflicts to the domain locks/guards. They do not
      // claim that SQL itself grants authority or forbids every different key.
    }),
  )
})

test("a failed surrounding native transaction leaves neither a new claim nor altered original history", async () => {
  await withFixture((f) =>
    Effect.gen(function* () {
      const before = yield* originalHistory(f),
        retained = yield* commands(f)
      const result = yield* f.sql
        .withTransaction(
          Effect.gen(function* () {
            yield* f.repository.createCommand(key, indexedRepair("planned"))
            return yield* Effect.fail(
              fail("TEST_TRANSACTION_STOP", "Stop before committing the native transaction."),
            )
          }),
        )
        .pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(yield* f.repository.command(key)).toBeUndefined()
      expect(yield* commands(f)).toEqual(retained)
      expect(yield* originalHistory(f)).toEqual(before)
    }),
  )
})
