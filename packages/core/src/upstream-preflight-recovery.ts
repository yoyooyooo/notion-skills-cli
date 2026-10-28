import { Effect, FileSystem, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property } from "./model.ts"
import { pageId } from "./ref.ts"
import { sha256 } from "./store.ts"
import { strictDecode, UpstreamCommandOperationSchema } from "./upstream-model.ts"
import { UpstreamState } from "./upstream-state.ts"
import { resolveSubscriptionDatabase } from "./upstream-subscription.ts"

export const SubscriptionPreparationEvidenceSchema = Schema.Struct({
  operation_id: Schema.String,
  scope: Schema.String,
  database_id: Schema.String,
  data_source_id: Schema.String,
  target_database_id: Schema.String,
  source_config_hash: Schema.String,
  preflight_path: Schema.String,
  error_code: Schema.Literals(["NOTION_REQUEST_FAILED", "INVALID_RESPONSE"]),
  receipt_path: Schema.String,
  receipt_sha256: Schema.String,
  frozen_artifact_path: Schema.String,
  frozen_artifact_sha256: Schema.String,
  original_no_mutation: Schema.Literal(true),
  source_reference: Schema.Struct({
    start_line: Schema.Number,
    end_line: Schema.Number,
    snippet: Schema.String,
  }),
})
export type SubscriptionPreparationEvidence = typeof SubscriptionPreparationEvidenceSchema.Type
export const SubscriptionPreparationRecoverySchema = Schema.Struct({
  ...SubscriptionPreparationEvidenceSchema.fields,
  plan_hash: Schema.String,
  original_command: Schema.Unknown,
})
const PreparationPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  evidence: SubscriptionPreparationEvidenceSchema,
  original_command: Schema.Unknown,
  plan_hash: Schema.String,
})
const conflict = (message: string) => fail("UPSTREAM_OPERATION_MISMATCH", message)
const planIdentity = (evidence: SubscriptionPreparationEvidence, original: unknown) =>
  sha256(JSON.stringify([1, evidence, original]))

function decodeEvidence(input: unknown) {
  return Effect.try({
    try: () => {
      const evidence = strictDecode(SubscriptionPreparationEvidenceSchema, input)
      if (
        !evidence.operation_id.trim() ||
        !evidence.scope.trim() ||
        !evidence.receipt_path.trim() ||
        !evidence.frozen_artifact_path.trim() ||
        [evidence.database_id, evidence.data_source_id, evidence.target_database_id].some(
          (id) => pageId(id) !== id,
        ) ||
        [
          evidence.source_config_hash,
          evidence.receipt_sha256,
          evidence.frozen_artifact_sha256,
        ].some((hash) => !/^[a-f0-9]{64}$/.test(hash)) ||
        evidence.preflight_path !== `v1/data_sources/${evidence.data_source_id}` ||
        !Number.isSafeInteger(evidence.source_reference.start_line) ||
        !Number.isSafeInteger(evidence.source_reference.end_line) ||
        evidence.source_reference.start_line < 1 ||
        evidence.source_reference.end_line < evidence.source_reference.start_line ||
        !evidence.source_reference.snippet.trim()
      )
        throw conflict(
          "Preparation requires exact scoped identities, hashes and a frozen source reference.",
        )
      return evidence
    },
    catch: () =>
      fail(
        "INVALID_ARGUMENT",
        "Provide exact original preflight receipt and frozen control-flow evidence.",
      ),
  })
}

/** Revalidate retained bytes and current source authority; never issue a mutation request. */
function validatePreparation(evidence: SubscriptionPreparationEvidence, original: unknown) {
  return Effect.gen(function* () {
    const command = yield* Effect.try({
      try: () => strictDecode(UpstreamCommandOperationSchema, original),
      catch: () => conflict("The original command is missing or does not match its strict schema."),
    })
    if (
      command.domain !== "subscription_add" ||
      command.operation_id !== evidence.operation_id ||
      command.state === "verified" ||
      command.intent !== undefined ||
      (command.phase !== undefined && command.phase !== "preparing") ||
      command.page_id !== undefined ||
      property(original).preparation_recovery !== undefined ||
      command.adoption !== undefined ||
      (command.error_code !== undefined && command.error_code !== evidence.error_code)
    )
      return yield* Effect.fail(
        conflict(
          "Only an unresolved original add without mutation or adoption evidence can be prepared.",
        ),
      )
    if (
      command.scope !== evidence.scope ||
      evidence.scope !== (yield* authScope) ||
      command.database_id !== evidence.database_id ||
      command.input.target_database_id !== evidence.target_database_id ||
      command.input_hash !== evidence.source_config_hash ||
      (yield* sha256(JSON.stringify(property(original).input))) !== evidence.source_config_hash
    )
      return yield* Effect.fail(
        conflict(
          "Preparation scope, source, target or frozen input hash differs from the original add.",
        ),
      )
    const db = yield* resolveSubscriptionDatabase(command.database_id)
    if (db.database_id !== evidence.database_id || db.data_source_id !== evidence.data_source_id)
      return yield* Effect.fail(
        conflict("The original subscription database or data source changed."),
      )

    const fs = yield* FileSystem.FileSystem
    const receiptBytes = yield* fs
      .readFile(evidence.receipt_path)
      .pipe(Effect.mapError(() => conflict("The original preflight receipt cannot be read.")))
    const artifactBytes = yield* fs
      .readFile(evidence.frozen_artifact_path)
      .pipe(Effect.mapError(() => conflict("The frozen original executable cannot be read.")))
    if (
      (yield* sha256(receiptBytes)) !== evidence.receipt_sha256 ||
      (yield* sha256(artifactBytes)) !== evidence.frozen_artifact_sha256
    )
      return yield* Effect.fail(
        conflict("The retained preflight receipt or frozen executable hash changed."),
      )
    yield* Effect.try({
      try: () => {
        const decoder = new TextDecoder("utf-8", { fatal: true })
        const receipt = property(JSON.parse(decoder.decode(receiptBytes)))
        const output = property(receipt.output)
        const error = property(output.error)
        const argv = receipt.argv
        if (
          !Array.isArray(argv) ||
          !argv.every((arg) => typeof arg === "string") ||
          argv[0] !== "sync" ||
          argv[1] !== "upstream" ||
          argv[2] !== "add" ||
          argv.filter((arg) => arg === "--operation").length !== 1 ||
          argv[argv.indexOf("--operation") + 1] !== evidence.operation_id ||
          typeof receipt.exit_code !== "number" ||
          receipt.exit_code === 0 ||
          output.ok !== false ||
          error.code !== evidence.error_code ||
          property(error.details).path !== evidence.preflight_path
        )
          throw conflict(
            "The actual receipt must identify this original add and its exact failed preflight GET.",
          )
        const artifact = decoder.decode(artifactBytes)
        const reference = evidence.source_reference
        const lines = artifact.split("\n")
        const anchored = lines.slice(reference.start_line - 1, reference.end_line).join("\n")
        if (reference.end_line > lines.length || anchored !== reference.snippet)
          throw conflict("The frozen control-flow snippet does not match its exact source lines.")
        // The reviewed assertion must be backed by the original awaited mapping before page creation.
        const mapping = /\bconst\s+mapped\s*=\s*yield\*\s+propertyIds\(db\.data_source_id\s*,/.exec(
          anchored,
        )
        const create = /\(yield\*\s+Notion\)\.request\(["']v1\/pages["']\s*,/.exec(anchored)
        const helper =
          /function\s+propertyIds\(dataSourceId\s*,\s*values\)\s*\{\s*return\s+\w+\.gen\(function\*\s*\(\)\s*\{\s*const\s+raw\s*=\s*yield\*\s*\(yield\*\s+Notion\)\.request\(`v1\/data_sources\/\$\{dataSourceId\}`\)/.test(
            artifact,
          )
        if (
          !mapping ||
          !create ||
          mapping.index >= create.index ||
          !helper ||
          !/properties:\s*mapped\b/.test(anchored.slice(create.index)) ||
          /\.request\(/.test(anchored.slice(0, mapping.index))
        )
          throw conflict(
            "The frozen reference must show awaited data-source property mapping before the original page POST.",
          )
      },
      catch: (error) =>
        conflict(
          error instanceof Error
            ? error.message
            : "The retained original preflight evidence is invalid.",
        ),
    })
    return command
  })
}

export function planSubscriptionPreparation(input: SubscriptionPreparationEvidence) {
  return Effect.gen(function* () {
    const evidence = yield* decodeEvidence(input)
    const state = yield* UpstreamState
    const original = yield* state.command(evidence.operation_id)
    yield* validatePreparation(evidence, original)
    const plan_hash = yield* planIdentity(evidence, original)
    // A private record keeps planning from changing the original command or its audit.
    yield* state.saveCommand(`subscription-preparation-plan:${evidence.operation_id}`, {
      version: 1,
      evidence,
      original_command: original,
      plan_hash,
    })
    return {
      operation_id: evidence.operation_id,
      plan_hash,
      evidence,
      remote_writes: 0,
      next: [
        "ntn-skills-operator",
        "upstream",
        "prepare-apply",
        evidence.operation_id,
        "--plan-hash",
        plan_hash,
      ],
    }
  })
}

export function applySubscriptionPreparation(operationId: string, planHash: string) {
  return Effect.gen(function* () {
    const state = yield* UpstreamState
    const rawPlan = yield* state.command(`subscription-preparation-plan:${operationId}`)
    const plan = yield* Effect.try({
      try: () => strictDecode(PreparationPlanSchema, rawPlan),
      catch: () =>
        conflict("The original add has no strict preparation plan; plan it before applying."),
    })
    const evidence = yield* decodeEvidence(plan.evidence)
    if (
      evidence.operation_id !== operationId ||
      plan.plan_hash !== planHash ||
      (yield* planIdentity(evidence, plan.original_command)) !== planHash
    )
      return yield* Effect.fail(
        fail("UPSTREAM_PLAN_STALE", "Use the exact reviewed preparation plan hash."),
      )
    yield* validatePreparation(evidence, plan.original_command)
    const next = {
      ...property(plan.original_command),
      phase: "preparing",
      state: "running",
      preparation_recovery: {
        ...evidence,
        plan_hash: planHash,
        original_command: plan.original_command,
      },
    }
    const current = yield* state.command(operationId)
    // Repeated apply converges only while the exact prepared record still exists.
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      if (JSON.stringify(current) !== JSON.stringify(plan.original_command))
        return yield* Effect.fail(
          fail("UPSTREAM_PLAN_STALE", "The original command changed after preparation planning."),
        )
      yield* state.claimCommand(operationId, plan.original_command, next)
    }
    return {
      operation_id: operationId,
      plan_hash: planHash,
      state: "ready_for_original_add" as const,
      remote_writes: 0,
    }
  })
}
