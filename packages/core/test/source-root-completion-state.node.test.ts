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
const completionKey = (suffix: string) => `source-root-completion:member:${suffix}:0`
const adoptionKey = (suffix: string) => `content-adoption:plan:${suffix}`
const key = completionKey(originalId)

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

// These are index/CAS payloads, not evidence accepted by the root-completion protocol.
// The strict plan and remote proof tests live at the domain boundary separately.
const indexedCompletion = (phase: string, owner = page, targetKey = target) => ({
  format: 1,
  domain: "source_root_completion_receipt",
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

test("root completion claims are read-only and cover all retained phases by either original page or target", async () => {
  await withFixture((f) =>
    Effect.gen(function* () {
      const before = yield* originalHistory(f)
      const phases = ["planned", "pending", "unknown", "acknowledged", "conflict", "body_verified"]
      const expected = phases.map((phase, index) => ({
        operation_id: completionKey(`up_other_${index}`),
        value: indexedCompletion(
          phase,
          index % 2 ? otherPage : page,
          index % 2 ? target : otherTarget,
        ),
      }))
      for (const claim of expected)
        yield* f.repository.createCommand(claim.operation_id, claim.value)
      yield* f.repository.createCommand(
        completionKey("unrelated"),
        indexedCompletion("pending", otherPage, otherTarget),
      )
      yield* f.repository.createCommand(
        "unrelated:member:matching-data",
        indexedCompletion("unknown"),
      )
      const snapshot = yield* commands(f)
      expect(yield* f.repository.sourceRootCompletionClaims(page, target)).toEqual(expected)
      expect(yield* commands(f)).toEqual(snapshot)
      expect(yield* originalHistory(f)).toEqual(before)
    }),
  )
})

test("only the winning root pending CAS can reach its one request and a lost local response cannot overwrite it", async () => {
  await withFixture((f) =>
    Effect.gen(function* () {
      const before = yield* originalHistory(f),
        planned = indexedCompletion("planned")
      yield* f.repository.createCommand(key, planned)
      const pending = {
        ...planned,
        phase: "pending",
        attempts: [
          {
            index: 0,
            outcome: "pending",
            request: { path: `v1/pages/${page}/markdown`, method: "PATCH" },
          },
        ],
      }
      let requests = 0
      const results = yield* Effect.all(
        [0, 1].map(() =>
          f.repository.claimCommand(key, planned, pending).pipe(
            Effect.andThen(
              Effect.sync(() => {
                requests++
              }),
            ),
            Effect.result,
          ),
        ),
        { concurrency: 2 },
      )
      expect(requests).toBe(1)
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1)
      expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1)
      const unknown = {
        ...pending,
        phase: "unknown",
        attempts: [
          {
            ...pending.attempts[0],
            outcome: "unknown",
            failure: { code: "WRITE_OUTCOME_UNKNOWN", message: "The one response was lost." },
          },
        ],
      }
      const lost = yield* f.repository
        .claimCommand(key, pending, unknown)
        .pipe(
          Effect.andThen(
            Effect.fail(fail("LOCAL_RESPONSE_LOST", "The completed native CAS response was lost.")),
          ),
          Effect.result,
        )
      expect(lost._tag).toBe("Failure")
      const retained = yield* commands(f)
      for (const action of [
        f.repository.createCommand(key, planned),
        f.repository.claimCommand(key, pending, planned),
      ]) {
        const refused = yield* action.pipe(Effect.result)
        expect(refused._tag).toBe("Failure")
        expect(yield* commands(f)).toEqual(retained)
      }
      expect(yield* f.repository.command(key)).toEqual(unknown)
      expect(yield* originalHistory(f)).toEqual(before)
    }),
  )
})

test("CA, leaf and root claims remain distinct discoverable journals; none is silently replaced or hidden", async () => {
  await withFixture((f) =>
    Effect.gen(function* () {
      const before = yield* originalHistory(f),
        completion = indexedCompletion("pending")
      const leafKey = `source-rich-text-repair:member:${originalId}:0`
      const leaf = { ...indexedCompletion("unknown"), domain: "source_rich_text_repair_receipt" }
      yield* f.repository.createCommand(key, completion)
      yield* f.repository.createCommand(leafKey, leaf)
      const adoption = adoptionKey("same_page")
      yield* f.repository.createCommand(adoption, indexedAdoption(page, target))
      const retained = yield* commands(f)
      expect(yield* f.repository.sourceRootCompletionClaims(page, target)).toEqual([
        { operation_id: key, value: completion },
      ])
      expect(yield* f.repository.sourceRichTextRepairClaims(page, target)).toEqual([
        { operation_id: leafKey, value: leaf },
      ])
      expect(yield* f.repository.contentAdoptionPlanClaims(page, target)).toEqual([adoption])
      expect(yield* commands(f)).toEqual(retained)
      expect(yield* originalHistory(f)).toEqual(before)
      // Cross-domain exclusion is enforced under the common domain locks. These
      // read-only indices do not pretend different SQL keys are mutually unique.
    }),
  )
})
