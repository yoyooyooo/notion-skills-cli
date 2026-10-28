import { createHash } from "node:crypto"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { fail, property } from "../src/model.ts"
import type { Receipt } from "../src/publication-model.ts"
import {
  publicationIntegrityMigration,
  type IntegrityIntent,
} from "../src/publication-integrity-state.ts"
import { canonical } from "../src/publication-effect-proof.ts"
import {
  mapCheckpointAdoptionReceipt,
  type MapCheckpointAdoptionPlan,
} from "../src/upstream-map-checkpoint-adoption-model.ts"
import type {
  FrozenPortable,
  UpstreamBinding,
  UpstreamOperation,
  UpstreamPlan,
} from "../src/upstream-model.ts"
import {
  makeUpstreamRepository,
  upstreamMigration,
  type MapCheckpointAdoptionCommit,
  type UpstreamRepository,
} from "../src/upstream-state.ts"

interface Fixture {
  readonly sql: SqlClient.SqlClient
  readonly repository: UpstreamRepository
  readonly input: MapCheckpointAdoptionCommit
  readonly planKey: string
  readonly receiptKey: string
  readonly checkpointKey: string
}

const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")

const fixtureInput = (): MapCheckpointAdoptionCommit => {
  const subscription = "11111111-1111-4111-8111-111111111111"
  const database = "22222222-2222-4222-8222-222222222222"
  const target = "33333333-3333-4333-8333-333333333333"
  const alpha = "44444444-4444-4444-8444-444444444444"
  const beta = "55555555-5555-4555-8555-555555555555"
  const planHash = "a".repeat(64)
  const alphaHash = "c".repeat(64)
  const betaHash = "d".repeat(64)
  const portable = (name: string, hash: string): FrozenPortable => ({
    kind: "skill",
    name,
    description: "Use for native map checkpoint state tests.",
    main: "SKILL.md",
    files: [{ path: "SKILL.md", hash }],
  })
  const originalPlan: UpstreamPlan = {
    version: 1,
    plan_id: `up_${planHash}`,
    plan_hash: planHash,
    created_at: 1,
    subscription_id: subscription,
    subscription_version: "original-unpublished-version",
    scope: "fixture-scope",
    database_id: database,
    config_hash: "e".repeat(64),
    revision: "original-revision",
    provenance: {},
    publisher_subscription_id: subscription,
    target_database_id: target,
    items: [
      {
        member_key: "skills/alpha",
        target_key: "target:alpha",
        action: "create",
        reason: "source-changed",
        generation: 0,
        content_hash: alphaHash,
        candidate: portable("alpha", alphaHash),
        accepted: portable("alpha", alphaHash),
        deltas: [],
      },
      {
        member_key: "skills/beta",
        target_key: "target:beta",
        action: "create",
        reason: "source-changed",
        generation: 0,
        content_hash: betaHash,
        candidate: portable("beta", betaHash),
        accepted: portable("beta", betaHash),
        deltas: [],
      },
    ],
  }
  const originalOperation: UpstreamOperation = {
    operation_id: "uo_original",
    plan_id: originalPlan.plan_id,
    subscription_id: subscription,
    scope: originalPlan.scope,
    database_id: database,
    target_database_id: target,
    state: "unknown",
    items: [
      {
        member_key: "skills/alpha",
        status: "verified",
        page_id: alpha,
        publication_operation_id: "p_alpha",
      },
      {
        member_key: "skills/beta",
        status: "verified",
        page_id: beta,
        publication_operation_id: "p_beta",
      },
    ],
  }
  const bindings: UpstreamBinding[] = originalPlan.items.map((item, index) => ({
    subscription_id: subscription,
    member_key: item.member_key,
    target_key: item.target_key,
    page_id: index === 0 ? alpha : beta,
    generation: 1,
    mode: "tracked",
    active: true,
    revision: originalPlan.revision,
    published_hash: item.content_hash!,
    accepted: item.accepted!,
    materialized: item.candidate!,
  }))
  const published = {
    version: 1 as const,
    revision: originalPlan.revision,
    plan_hash: originalPlan.plan_hash,
    publisher_subscription_id: subscription,
    members: [
      {
        member_key: "skills/alpha",
        page_id: alpha,
        content_hash: alphaHash,
        revision: originalPlan.revision,
      },
    ],
  }
  const checkpoint = {
    subscription_id: subscription,
    version: "observed-partial-version",
    published,
  }
  const publication: Receipt = {
    format: 1,
    operation_id: "p_alpha",
    operation: "create",
    scope: originalPlan.scope,
    database_id: target,
    data_source_id: "66666666-6666-4666-8666-666666666666",
    page_id: alpha,
    state: "completed",
    portable: {
      kind: "skill",
      name: "alpha",
      description: "Fixture publication.",
      main: "SKILL.md",
      files: [{ path: "SKILL.md", sha256: alphaHash }],
    },
    guards: { "fixture/numeric-keys": { "10": "ten", "2": "two" } },
    intents: [],
    stages: [],
    result: { verified: true, operation_id: "p_alpha" },
  }
  const integrity: IntegrityIntent = {
    version: 1,
    operation_id: publication.operation_id,
    intended_hash: alphaHash,
    page_id: alpha,
    marker: {
      version: 2,
      operation_id: publication.operation_id,
      intended_hash: alphaHash,
      state: "committed",
      revision: "1".repeat(64),
      manifest_hash: "2".repeat(64),
      ownership_hash: "3".repeat(64),
    },
  }
  const native: MapCheckpointAdoptionPlan["native_inputs"] = {
    original_plan: originalPlan,
    original_operation: originalOperation,
    bindings,
    targets: bindings.map((binding) => ({
      target_key: binding.target_key,
      claim: { page_id: binding.page_id, publisher_subscription_id: subscription },
    })),
    commands: {
      saved: { unpublished: true },
      intended: {
        ...published,
        members: [
          ...published.members,
          {
            member_key: "skills/beta",
            page_id: beta,
            content_hash: betaHash,
            revision: originalPlan.revision,
          },
        ],
      },
      accepted_config: null,
      checkpoint: null,
      projection: null,
    },
    publications: [
      {
        operation_id: publication.operation_id,
        receipt_sha256: digest(publication),
        integrity_sha256: digest(integrity),
      },
    ],
  }
  const capture: MapCheckpointAdoptionPlan["capture"] = {
    input: {
      original_plan_id: originalPlan.plan_id,
      success_capture: {
        command: "/fixture/command.json",
        stdout: "/fixture/stdout.json",
        exit_code: "/fixture/exit_code",
        finished_at: "/fixture/finished_at",
      },
    },
    sha256: {
      command: "1".repeat(64),
      stdout: "2".repeat(64),
      exit_code: "3".repeat(64),
      finished_at: "4".repeat(64),
    },
    command: {
      argv: [
        "node",
        "packages/cli/dist/ntn-skills.js",
        "sync",
        "upstream",
        "apply",
        originalPlan.plan_id,
        "--member",
        "skills/alpha",
      ],
      started_at: "2026-10-21T18:13:00Z",
    },
    finished_at: "2026-10-21T18:15:00Z",
    historical_operation: {
      ...originalOperation,
      items: [
        originalOperation.items[0]!,
        {
          member_key: "skills/beta",
          status: "unknown",
          publication_operation_id: "p_beta",
          error_code: "WRITE_OUTCOME_UNKNOWN",
        },
      ],
    },
    selected_member: "skills/alpha",
  }
  const remote: MapCheckpointAdoptionPlan["remote_evidence"] = {
    subscription: {
      subscription_id: subscription,
      database_id: database,
      data_source_id: "66666666-6666-4666-8666-666666666666",
      target_database_id: target,
      name: "Fixture upstream",
      description: "Synthetic native state test data.",
      default_context: false,
      enabled: true,
      removed: false,
      status: "Ready",
      source: {
        provider: { type: "git", url: "/fixture/source", ref: "main" },
        strip_prefix: "skills",
      },
      roots: ["skills"],
      include: [],
      exclude: [],
      mapping: {},
      published,
      version: checkpoint.version,
    },
    last_edited_time: "2026-10-21T18:14:00Z",
    members: [
      {
        member_key: "skills/alpha",
        page_id: alpha,
        publication_operation_id: publication.operation_id,
        version: "observed-alpha-version",
        content_hash: alphaHash,
        ownership: {
          subscription_id: subscription,
          member_key: "alpha",
          mode: "tracked",
          published_hash: alphaHash,
          revision: originalPlan.revision,
        },
        marker: integrity.marker,
        metadata_sha256: "5".repeat(64),
        observed_portable_sha256: "6".repeat(64),
      },
    ],
  }
  const body: Omit<MapCheckpointAdoptionPlan, "plan_id" | "plan_hash"> = {
    format: 1,
    domain: "upstream_map_checkpoint_adoption",
    authority: "adopt_observed_complete_baseline",
    scope: originalPlan.scope!,
    capture,
    native_inputs: native,
    native_inputs_sha256: digest(native),
    remote_evidence: remote,
    evidence_sha256: digest({ capture, remote }),
    checkpoint,
  }
  const hash = digest(body)
  const adoptionPlan: MapCheckpointAdoptionPlan = {
    ...body,
    plan_id: `mca_${hash}`,
    plan_hash: hash,
  }
  return {
    adoption_id: adoptionPlan.plan_id,
    adoption_plan: adoptionPlan,
    receipt: mapCheckpointAdoptionReceipt(adoptionPlan),
    original_plan: originalPlan,
    original_operation: originalOperation,
    bindings,
    targets: native.targets,
    commands: native.commands,
    publications: [{ operation_id: publication.operation_id, receipt: publication, integrity }],
    checkpoint,
  }
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
        const repository = makeUpstreamRepository(sql)
        const input = fixtureInput()
        yield* repository.savePlan(input.original_plan)
        for (const binding of input.bindings)
          yield* repository.advance(
            binding,
            0,
            input.original_plan.publisher_subscription_id,
            input.original_operation,
          )
        yield* repository.saveCommand(
          `${input.original_plan.plan_id}:subscription-map`,
          input.commands.saved,
        )
        yield* repository.saveCommand(
          `${input.original_plan.plan_id}:subscription-map:intended`,
          input.commands.intended,
        )
        const planKey = `map-checkpoint-adoption:plan:${input.adoption_id}`
        const receiptKey = `map-checkpoint-adoption:receipt:${input.adoption_id}`
        const checkpointKey = `${input.original_plan.plan_id}:subscription-map:checkpoint`
        yield* repository.saveCommand(planKey, input.adoption_plan)
        for (const publication of input.publications) {
          yield* sql`INSERT INTO publications ${sql.insert({
            id: publication.operation_id,
            operation: publication.receipt.operation,
            state: publication.receipt.state,
            scope: publication.receipt.scope ?? null,
            page_id: publication.receipt.page_id ?? null,
            payload: JSON.stringify(publication.receipt),
          })}`
          yield* sql`INSERT INTO integrity_operations ${sql.insert({
            operation_id: publication.operation_id,
            publication_operation_id: publication.integrity.operation_id,
            intended_hash: publication.integrity.intended_hash,
            state: publication.integrity.marker.state,
            page_id: publication.integrity.page_id ?? null,
            payload: JSON.stringify(publication.integrity),
          })}`
        }
        return yield* work({ sql, repository, input, planKey, receiptKey, checkpointKey })
      }),
    ).pipe(Effect.provide(Reactivity.layer)),
  )
}

const originalHistory = ({ sql, receiptKey, checkpointKey }: Fixture) =>
  Effect.gen(function* () {
    return {
      plans: yield* sql`SELECT * FROM upstream_plans ORDER BY plan_id`,
      operations: yield* sql`SELECT * FROM upstream_operations ORDER BY operation_id`,
      bindings: yield* sql`SELECT * FROM upstream_bindings ORDER BY subscription_id,member_key`,
      targets: yield* sql`SELECT * FROM upstream_targets ORDER BY target_key`,
      commands:
        yield* sql`SELECT * FROM upstream_commands WHERE operation_id NOT IN (${receiptKey},${checkpointKey}) ORDER BY operation_id`,
      publications: yield* sql`SELECT * FROM publications ORDER BY id`,
      integrity: yield* sql`SELECT * FROM integrity_operations ORDER BY operation_id`,
    }
  })

test("native adoption commits one receipt and one checkpoint without changing original history", async () => {
  await withFixture((fixture) =>
    Effect.gen(function* () {
      const { repository, input, receiptKey, checkpointKey } = fixture
      const before = yield* originalHistory(fixture)
      expect(yield* repository.commitMapCheckpointAdoption(input)).toEqual({ reused: false })
      expect(yield* repository.command(receiptKey)).toEqual(input.receipt)
      expect(yield* repository.command(checkpointKey)).toEqual(input.checkpoint)
      expect(yield* originalHistory(fixture)).toEqual(before)
    }),
  )
})

test("receipt insertion rolls back if checkpoint insertion fails", async () => {
  await withFixture((fixture) =>
    Effect.gen(function* () {
      const { sql, repository, input, receiptKey, checkpointKey } = fixture
      const before = yield* originalHistory(fixture)
      yield* sql.unsafe(
        "CREATE TRIGGER reject_checkpoint BEFORE INSERT ON upstream_commands WHEN NEW.operation_id LIKE '%:subscription-map:checkpoint' BEGIN SELECT RAISE(ABORT, 'fixture checkpoint failure'); END",
      )
      const failed = yield* repository.commitMapCheckpointAdoption(input).pipe(Effect.result)
      expect(failed._tag).toBe("Failure")
      expect(yield* repository.command(receiptKey)).toBeUndefined()
      expect(yield* repository.command(checkpointKey)).toBeUndefined()
      expect(yield* originalHistory(fixture)).toEqual(before)
      yield* sql`DROP TRIGGER reject_checkpoint`
      expect(yield* repository.commitMapCheckpointAdoption(input)).toEqual({ reused: false })
    }),
  )
})

test("lost commit responses and later upstream progress never replay an old checkpoint", async () => {
  await withFixture((fixture) =>
    Effect.gen(function* () {
      const { repository, input, receiptKey, checkpointKey } = fixture
      const lost = yield* repository
        .commitMapCheckpointAdoption(input)
        .pipe(
          Effect.andThen(
            Effect.fail(
              fail("TEST_RESPONSE_LOST", "The local commit returned after the caller stopped."),
            ),
          ),
          Effect.result,
        )
      expect(lost._tag).toBe("Failure")
      expect(yield* repository.commitMapCheckpointAdoption(input)).toEqual({ reused: true })
      const advanced = { ...input.checkpoint, version: "later-normal-upstream-apply" }
      yield* repository.saveCommand(checkpointKey, advanced)
      yield* repository.saveOperation({ ...input.original_operation, state: "verified" })
      const beforeReplay = yield* originalHistory(fixture)
      expect(yield* repository.commitMapCheckpointAdoption(input)).toEqual({ reused: true })
      expect(yield* repository.command(checkpointKey)).toEqual(advanced)
      expect(yield* repository.command(receiptKey)).toEqual(input.receipt)
      expect(yield* originalHistory(fixture)).toEqual(beforeReplay)
      const conflicting = yield* repository
        .commitMapCheckpointAdoption({
          ...input,
          receipt: { ...property(input.receipt), evidence_sha256: "different" },
        })
        .pipe(Effect.result)
      expect(conflicting._tag).toBe("Failure")
      if (conflicting._tag === "Failure") expect(conflicting.failure.code).toBe("INVALID_ARGUMENT")
      expect(yield* repository.command(checkpointKey)).toEqual(advanced)
    }),
  )
})

test.each(["missing", "invalid-json", "invalid-schema", "wrong-subscription", "receipt"])(
  "a retained receipt with %s checkpoint state refuses replay without repair",
  async (changed) => {
    await withFixture((fixture) =>
      Effect.gen(function* () {
        const { sql, repository, input, receiptKey, checkpointKey } = fixture
        yield* repository.commitMapCheckpointAdoption(input)
        if (changed === "missing")
          yield* sql`DELETE FROM upstream_commands WHERE operation_id=${checkpointKey}`
        else if (changed === "invalid-json")
          yield* sql`UPDATE upstream_commands SET payload='{' WHERE operation_id=${checkpointKey}`
        else if (changed === "invalid-schema")
          yield* repository.saveCommand(checkpointKey, { ...input.checkpoint, unexpected: true })
        else if (changed === "wrong-subscription")
          yield* repository.saveCommand(checkpointKey, {
            ...input.checkpoint,
            subscription_id: "another-subscription",
          })
        else
          yield* repository.saveCommand(receiptKey, {
            ...property(input.receipt),
            evidence_sha256: "9".repeat(64),
          })
        const before = yield* originalHistory(fixture)
        const recoveryRows =
          yield* sql`SELECT * FROM upstream_commands WHERE operation_id IN (${receiptKey},${checkpointKey}) ORDER BY operation_id`
        const rejected = yield* repository.commitMapCheckpointAdoption(input).pipe(Effect.result)
        expect(rejected._tag).toBe("Failure")
        if (rejected._tag === "Failure") expect(rejected.failure.code).toBe("STATE_CORRUPT")
        expect(
          yield* sql`SELECT * FROM upstream_commands WHERE operation_id IN (${receiptKey},${checkpointKey}) ORDER BY operation_id`,
        ).toEqual(recoveryRows)
        expect(yield* originalHistory(fixture)).toEqual(before)
      }),
    )
  },
)

test.each([
  "checkpoint-content",
  "checkpoint-member",
  "checkpoint-version",
  "original-plan",
  "operation",
  "bindings",
  "targets",
  "commands",
  "publication-receipt",
  "publication-integrity",
  "receipt",
])("unchanged database refuses submitted %s outside the frozen plan", async (changed) => {
  await withFixture((fixture) =>
    Effect.gen(function* () {
      const { repository, input, receiptKey, checkpointKey } = fixture
      let submitted: MapCheckpointAdoptionCommit = input
      if (changed.startsWith("checkpoint-")) {
        const checkpoint = {
          ...input.checkpoint,
          published: {
            ...input.checkpoint.published,
            members: input.checkpoint.published.members.map((member) => ({
              ...member,
              ...(changed === "checkpoint-content" ? { content_hash: "9".repeat(64) } : {}),
              ...(changed === "checkpoint-member"
                ? { member_key: "skills/not-in-the-baseline" }
                : {}),
            })),
          },
          ...(changed === "checkpoint-version" ? { version: "another-version" } : {}),
        }
        // Coordinated edits used to bypass the native guard while the stored plan was unchanged.
        submitted = { ...input, checkpoint, receipt: { ...property(input.receipt), checkpoint } }
      } else if (changed === "original-plan")
        submitted = {
          ...input,
          original_plan: { ...input.original_plan, provenance: { changed: "true" } },
        }
      else if (changed === "operation")
        submitted = {
          ...input,
          original_operation: { ...input.original_operation, state: "partial" },
        }
      else if (changed === "bindings")
        submitted = {
          ...input,
          bindings: input.bindings.map((binding) => ({
            ...binding,
            published_hash: "9".repeat(64),
          })),
        }
      else if (changed === "targets")
        submitted = {
          ...input,
          targets: input.targets.map((target) => ({
            ...target,
            claim: target.claim && {
              ...target.claim,
              publisher_subscription_id: "another-publisher",
            },
          })),
        }
      else if (changed === "commands")
        submitted = { ...input, commands: { ...input.commands, projection: { entries: [] } } }
      else if (changed === "publication-receipt")
        submitted = {
          ...input,
          publications: input.publications.map((publication) => ({
            ...publication,
            receipt: {
              ...publication.receipt,
              result: { ...publication.receipt.result, extra: "changed" },
            },
          })),
        }
      else if (changed === "publication-integrity")
        submitted = {
          ...input,
          publications: input.publications.map((publication) => ({
            ...publication,
            integrity: {
              ...publication.integrity,
              intended_hash: "9".repeat(64),
              marker: { ...publication.integrity.marker, intended_hash: "9".repeat(64) },
            },
          })),
        }
      else
        submitted = {
          ...input,
          receipt: { ...property(input.receipt), evidence_sha256: "9".repeat(64) },
        }
      const before = yield* originalHistory(fixture)
      const rejected = yield* repository.commitMapCheckpointAdoption(submitted).pipe(Effect.result)
      expect(rejected._tag).toBe("Failure")
      if (rejected._tag === "Failure") expect(rejected.failure.code).toBe("INVALID_ARGUMENT")
      expect(yield* repository.command(receiptKey)).toBeUndefined()
      expect(yield* repository.command(checkpointKey)).toBeUndefined()
      expect(yield* originalHistory(fixture)).toEqual(before)
    }),
  )
})

test.each(["body-hash", "native-hash", "evidence-hash", "excess-property"])(
  "matching stored and submitted plans still require valid %s",
  async (changed) => {
    await withFixture((fixture) =>
      Effect.gen(function* () {
        const { repository, input, planKey, receiptKey, checkpointKey } = fixture
        const adoption = property(input.adoption_plan)
        const submitted = {
          ...input,
          adoption_plan: {
            ...adoption,
            ...(changed === "body-hash" ? { scope: "changed-scope" } : {}),
            ...(changed === "native-hash" ? { native_inputs_sha256: "9".repeat(64) } : {}),
            ...(changed === "evidence-hash" ? { evidence_sha256: "9".repeat(64) } : {}),
            ...(changed === "excess-property" ? { unreviewed: true } : {}),
          },
        }
        yield* repository.saveCommand(planKey, submitted.adoption_plan)
        const before = yield* originalHistory(fixture)
        const rejected = yield* repository
          .commitMapCheckpointAdoption(submitted)
          .pipe(Effect.result)
        expect(rejected._tag).toBe("Failure")
        if (rejected._tag === "Failure") expect(rejected.failure.code).toBe("INVALID_ARGUMENT")
        expect(yield* repository.command(receiptKey)).toBeUndefined()
        expect(yield* repository.command(checkpointKey)).toBeUndefined()
        expect(yield* originalHistory(fixture)).toEqual(before)
      }),
    )
  },
)

test.each([
  "adoption-plan",
  "original-plan",
  "operation",
  "binding",
  "extra-binding",
  "target",
  "saved-map",
  "intended-map",
  "accepted-config",
  "checkpoint",
  "projection",
  "publication",
  "integrity",
])("native snapshot drift in %s refuses the whole adoption before commit", async (changed) => {
  await withFixture((fixture) =>
    Effect.gen(function* () {
      const { sql, repository, input, planKey, receiptKey, checkpointKey } = fixture
      if (changed === "adoption-plan") yield* repository.saveCommand(planKey, { changed: true })
      else if (changed === "original-plan")
        yield* sql`UPDATE upstream_plans SET payload=${JSON.stringify({ ...input.original_plan, provenance: { changed: "true" } })} WHERE plan_id=${input.original_plan.plan_id}`
      else if (changed === "operation")
        yield* repository.saveOperation({ ...input.original_operation, state: "partial" })
      else if (changed === "binding") {
        const binding = input.bindings[1]!
        yield* sql`UPDATE upstream_bindings SET generation=2,payload=${JSON.stringify({ ...binding, generation: 2 })} WHERE subscription_id=${binding.subscription_id} AND member_key=${binding.member_key}`
      } else if (changed === "extra-binding") {
        const binding = {
          ...input.bindings[1]!,
          member_key: "skills/new-unplanned-member",
          target_key: "target:extra",
        }
        yield* sql`INSERT INTO upstream_bindings ${sql.insert({
          subscription_id: binding.subscription_id,
          member_key: binding.member_key,
          target_key: binding.target_key,
          page_id: binding.page_id,
          generation: binding.generation,
          payload: JSON.stringify(binding),
        })}`
      } else if (changed === "target")
        yield* sql`UPDATE upstream_targets SET publisher_subscription_id='foreign-publisher' WHERE target_key=${input.targets[1]!.target_key}`
      else if (changed === "saved-map")
        yield* repository.saveCommand(`${input.original_plan.plan_id}:subscription-map`, {
          unpublished: false,
        })
      else if (changed === "intended-map")
        yield* repository.saveCommand(`${input.original_plan.plan_id}:subscription-map:intended`, {
          changed: true,
        })
      else if (changed === "accepted-config")
        yield* repository.saveCommand(
          `${input.original_plan.plan_id}:accepted-config`,
          "changed-config",
        )
      else if (changed === "checkpoint")
        yield* repository.saveCommand(checkpointKey, input.checkpoint)
      else if (changed === "projection")
        yield* repository.saveCommand(`${input.original_operation.operation_id}:projections`, {
          entries: [],
        })
      else if (changed === "publication") {
        const publication = input.publications[0]!
        yield* sql`UPDATE publications SET payload=${JSON.stringify({ ...publication.receipt, stages: [...publication.receipt.stages, "changed"] })} WHERE id=${publication.operation_id}`
      } else if (changed === "integrity") {
        const publication = input.publications[0]!
        yield* sql`UPDATE integrity_operations SET payload=${JSON.stringify({
          ...publication.integrity,
          marker: { ...publication.integrity.marker, manifest_hash: "9".repeat(64) },
        })} WHERE operation_id=${publication.operation_id}`
      }
      const before = yield* originalHistory(fixture)
      const beforeCheckpoint = yield* repository.command(checkpointKey)
      const rejected = yield* repository.commitMapCheckpointAdoption(input).pipe(Effect.result)
      expect(rejected._tag).toBe("Failure")
      if (rejected._tag === "Failure") expect(rejected.failure.code).toBe("UPSTREAM_PLAN_STALE")
      expect(yield* repository.command(receiptKey)).toBeUndefined()
      expect(yield* repository.command(checkpointKey)).toEqual(beforeCheckpoint)
      expect(yield* originalHistory(fixture)).toEqual(before)
    }),
  )
})

test.each([
  "binding-generation",
  "binding-target",
  "binding-page",
  "binding-member",
  "binding-subscription",
  "publication-operation",
  "publication-scope",
  "integrity-publication",
  "integrity-hash",
  "plan-hash",
  "operation-state",
])("native %s index drift cannot hide behind an unchanged payload", async (changed) => {
  await withFixture((fixture) =>
    Effect.gen(function* () {
      const { sql, repository, input, receiptKey, checkpointKey } = fixture
      const binding = input.bindings[0]!
      const publication = input.publications[0]!
      if (changed === "binding-generation")
        yield* sql`UPDATE upstream_bindings SET generation=2 WHERE subscription_id=${binding.subscription_id} AND member_key=${binding.member_key}`
      else if (changed === "binding-target")
        yield* sql`UPDATE upstream_bindings SET target_key='another-target' WHERE subscription_id=${binding.subscription_id} AND member_key=${binding.member_key}`
      else if (changed === "binding-page")
        yield* sql`UPDATE upstream_bindings SET page_id='another-page' WHERE subscription_id=${binding.subscription_id} AND member_key=${binding.member_key}`
      else if (changed === "binding-member")
        yield* sql`UPDATE upstream_bindings SET member_key='skills/renamed' WHERE subscription_id=${binding.subscription_id} AND member_key=${binding.member_key}`
      else if (changed === "binding-subscription")
        yield* sql`UPDATE upstream_bindings SET subscription_id='another-subscription' WHERE subscription_id=${binding.subscription_id} AND member_key=${binding.member_key}`
      else if (changed === "publication-operation")
        yield* sql`UPDATE publications SET operation='replace' WHERE id=${publication.operation_id}`
      else if (changed === "publication-scope")
        yield* sql`UPDATE publications SET scope='another-scope' WHERE id=${publication.operation_id}`
      else if (changed === "integrity-publication")
        yield* sql`UPDATE integrity_operations SET publication_operation_id='another-publication' WHERE operation_id=${publication.operation_id}`
      else if (changed === "integrity-hash")
        yield* sql`UPDATE integrity_operations SET intended_hash=${"9".repeat(64)} WHERE operation_id=${publication.operation_id}`
      else if (changed === "plan-hash")
        yield* sql`UPDATE upstream_plans SET plan_hash=${"9".repeat(64)} WHERE plan_id=${input.original_plan.plan_id}`
      else
        yield* sql`UPDATE upstream_operations SET state='verified' WHERE operation_id=${input.original_operation.operation_id}`
      const before = yield* originalHistory(fixture)
      const rejected = yield* repository.commitMapCheckpointAdoption(input).pipe(Effect.result)
      expect(rejected._tag).toBe("Failure")
      if (rejected._tag === "Failure") expect(rejected.failure.code).toBe("UPSTREAM_PLAN_STALE")
      expect(yield* repository.command(receiptKey)).toBeUndefined()
      expect(yield* repository.command(checkpointKey)).toBeUndefined()
      expect(yield* originalHistory(fixture)).toEqual(before)
    }),
  )
})

test("the native method rejects arbitrary IDs and incomplete target snapshots", async () => {
  await withFixture((fixture) =>
    Effect.gen(function* () {
      const { repository, input, receiptKey, checkpointKey } = fixture
      for (const invalid of [
        { ...input, adoption_id: "arbitrary-command-key" },
        { ...input, targets: input.targets.slice(0, 1) },
        { ...input, targets: [...input.targets, input.targets[0]!] },
        { ...input, publications: [] },
      ]) {
        const rejected = yield* repository.commitMapCheckpointAdoption(invalid).pipe(Effect.result)
        expect(rejected._tag).toBe("Failure")
        if (rejected._tag === "Failure") expect(rejected.failure.code).toBe("INVALID_ARGUMENT")
        expect(yield* repository.command(receiptKey)).toBeUndefined()
        expect(yield* repository.command(checkpointKey)).toBeUndefined()
      }
    }),
  )
})
