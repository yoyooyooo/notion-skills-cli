import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { fail } from "../src/model.ts"
import { makeUpstreamRepository, upstreamMigration } from "../src/upstream-state.ts"

const page = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222"
const original = `up_${"a".repeat(64)}`,
  target = "exact-original-target"
const parentKey = `source-root-completion:member:${original}:0`,
  key = `source-root-fidelity:member:${original}:0`
const parent = {
  domain: "source_root_completion_receipt",
  phase: "acknowledged",
  attempts: [
    {
      index: 0,
      outcome: "acknowledged",
      request: { original: "unaltered" },
      response: { real: "ACK" },
    },
  ],
  plan: { input: { page_id: page }, target_key: target },
}
const planned = {
  domain: "source_root_fidelity_receipt",
  phase: "planned",
  attempts: [],
  checkpoints: [],
  plan: { page_id: page, target_key: target, original: "frozen" },
}
const pending = {
  ...planned,
  phase: "pending",
  attempts: [{ index: 0, effect_index: 0, outcome: "pending" }],
}
const guard = { operation_id: parentKey, expected: parent }

async function fixture<A, E>(
  run: (value: {
    sql: SqlClient.SqlClient
    repository: ReturnType<typeof makeUpstreamRepository>
  }) => Effect.Effect<A, E>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqliteClient.make({ filename: ":memory:", disableWAL: true })
        yield* upstreamMigration.pipe(Effect.provideService(SqlClient.SqlClient, sql))
        const repository = makeUpstreamRepository(sql)
        yield* repository.createCommand(parentKey, parent)
        yield* repository.createCommand(key, planned)
        yield* repository.createCommand("retained:original-history", {
          unknown: ["never", "rewritten"],
        })
        return yield* run({ sql, repository })
      }),
    ).pipe(Effect.provide(Reactivity.layer)),
  )
}

// These are SQL index/CAS payloads, not valid domain receipts. The strict domain
// decoder and complete remote effects are exercised in the lifecycle suite.
test("fidelity claims include every phase by exact page or target and keep the original parent/leaf namespaces distinct", async () => {
  await fixture(({ sql, repository }) =>
    Effect.gen(function* () {
      const phases = ["ready", "pending", "unknown", "acknowledged", "conflict", "body_verified"]
      const expected = [{ operation_id: key, value: planned }]
      for (const [index, phase] of phases.entries()) {
        const operation_id = `source-root-fidelity:member:up_z${index}:0`
        const value = {
          ...planned,
          phase,
          plan: {
            ...planned.plan,
            page_id: index % 2 ? other : page,
            target_key: index % 2 ? target : "other-target",
          },
        }
        yield* repository.createCommand(operation_id, value)
        expected.push({ operation_id, value })
      }
      yield* repository.createCommand(`source-root-fidelity:member:unrelated:0`, {
        ...planned,
        plan: { page_id: other, target_key: "other-target", original: "frozen" },
      })
      yield* repository.createCommand(`source-rich-text-repair:member:${original}:0`, parent)
      const before = yield* sql`SELECT * FROM upstream_commands ORDER BY operation_id`
      expect(yield* repository.sourceRootFidelityClaims(page, target)).toEqual(expected)
      expect(yield* repository.sourceRootCompletionClaims(page, target)).toEqual([
        { operation_id: parentKey, value: parent },
      ])
      expect(yield* sql`SELECT * FROM upstream_commands ORDER BY operation_id`).toEqual(before)
    }),
  )
})

test("only one exact child pending CAS can pass while its full acknowledged parent row stays unchanged", async () => {
  await fixture(({ repository }) =>
    Effect.gen(function* () {
      let sends = 0
      const results = yield* Effect.all(
        [0, 1].map(() =>
          repository.claimCommand(key, planned, pending, guard).pipe(
            Effect.andThen(
              Effect.sync(() => {
                sends++
              }),
            ),
            Effect.result,
          ),
        ),
        { concurrency: 2 },
      )
      expect(sends).toBe(1)
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1)
      expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1)
      expect(yield* repository.command(key)).toEqual(pending)
      expect(yield* repository.command(parentKey)).toEqual(parent)
      expect(yield* repository.command("retained:original-history")).toEqual({
        unknown: ["never", "rewritten"],
      })
    }),
  )
})

test("a changed, missing or mismatched parent prevents pending CAS without changing the child", async () => {
  await fixture(({ sql, repository }) =>
    Effect.gen(function* () {
      const changed = { ...parent, phase: "body_verified" }
      yield* repository.claimCommand(parentKey, parent, changed)
      for (const selected of [
        guard,
        { operation_id: "missing-parent", expected: parent },
        { operation_id: key, expected: planned },
        { operation_id: parentKey, expected: { ...changed, attempts: [] } },
      ]) {
        const before = yield* sql`SELECT * FROM upstream_commands ORDER BY operation_id`
        expect(
          (yield* repository.claimCommand(key, planned, pending, selected).pipe(Effect.result))
            ._tag,
        ).toBe("Failure")
        expect(yield* sql`SELECT * FROM upstream_commands ORDER BY operation_id`).toEqual(before)
      }
      expect(yield* repository.command(key)).toEqual(planned)
    }),
  )
})

test("a lost pending response is durable; later true ACK evidence persists without restoring a changed parent", async () => {
  await fixture(({ repository }) =>
    Effect.gen(function* () {
      const lost = yield* repository
        .claimCommand(key, planned, pending, guard)
        .pipe(
          Effect.andThen(
            Effect.fail(
              fail("LOCAL_RESPONSE_LOST", "The CAS completed before its caller was interrupted."),
            ),
          ),
          Effect.result,
        )
      expect(lost._tag).toBe("Failure")
      expect(yield* repository.command(key)).toEqual(pending)
      expect(
        (yield* repository.claimCommand(key, planned, pending, guard).pipe(Effect.result))._tag,
      ).toBe("Failure")
      const changed = { ...parent, evidence: "external later native change" }
      yield* repository.claimCommand(parentKey, parent, changed)
      const acknowledged = {
        ...pending,
        phase: "acknowledged",
        attempts: [
          {
            ...pending.attempts[0],
            outcome: "acknowledged",
            response: { object: "block", id: "original-target", exact: "real response" },
          },
        ],
      }
      yield* repository.claimCommand(key, pending, acknowledged)
      expect(yield* repository.command(key)).toEqual(acknowledged)
      expect(yield* repository.command(parentKey)).toEqual(changed)
      expect(
        (yield* repository
          .claimCommand(key, acknowledged, { ...acknowledged, phase: "ready" }, guard)
          .pipe(Effect.result))._tag,
      ).toBe("Failure")
      expect(yield* repository.command(key)).toEqual(acknowledged)
    }),
  )
})

test("a competing durable claim inserted before the guarded UPDATE blocks the child and preserves all rows", async () => {
  const claims = [
    { key: `content-adoption:member:${original}:0`, value: { any: "retained claim" } },
    {
      key: "content-adoption:plan:foreign-page",
      value: {
        plan: {
          page_id: page,
          item_index: 0,
          original_plan: { items: [{ target_key: "another-target" }] },
        },
      },
    },
    {
      key: "content-adoption:plan:foreign-target",
      value: {
        plan: { page_id: other, item_index: 0, original_plan: { items: [{ target_key: target }] } },
      },
    },
    { key: "source-root-completion:member:foreign:0", value: parent },
    { key: "source-rich-text-repair:member:foreign:0", value: parent },
    { key: "source-root-fidelity:member:foreign:0", value: planned },
  ]
  for (const claim of claims)
    await fixture(({ sql, repository }) =>
      Effect.gen(function* () {
        yield* repository.createCommand(claim.key, claim.value)
        const before = yield* sql`SELECT * FROM upstream_commands ORDER BY operation_id`
        expect(
          (yield* repository.claimCommand(key, planned, pending, guard).pipe(Effect.result))._tag,
        ).toBe("Failure")
        expect(yield* sql`SELECT * FROM upstream_commands ORDER BY operation_id`).toEqual(before)
        expect(yield* repository.command(parentKey)).toEqual(parent)
        expect(yield* repository.command(key)).toEqual(planned)
      }),
    )
})
