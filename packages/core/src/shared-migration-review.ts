import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { CoverageSchema, fail, property, SkillsError } from "./model.ts"
import { pageId } from "./ref.ts"
import { consumeSharedCreation } from "./shared-create-consumption.ts"
import { SharedCreateJournalSchema, validateSharedCreatePlan } from "./shared-create-model.ts"
import {
  executeSharedCreate,
  loadSharedCreatePlan,
  prepareSharedMigrationCreate,
  prepareSharedMigrationReview,
  reconcileSharedCreate,
  sharedCreateJournalKey,
} from "./shared-create.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import {
  makeSharedMigrationConversion,
  retainedMigrationConversionInput,
  reviewSharedMigrationConversion,
  type MigrationConversionInput,
  type SharedMigrationConversionCandidate,
} from "./shared-migration-conversion.ts"
import {
  makeSharedMigrationCreateOrigin,
  SharedMigrationCreateOriginSchema,
} from "./shared-migration-create-origin.ts"
import { selectSharedMigrationReviewPolicy } from "./shared-migration-create-binding.ts"
import {
  SharedMigrationInputSchema,
  SharedMigrationPreservationInventorySchema,
} from "./shared-migration-plan.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const SharedMigrationReviewSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("migration_create_review"),
  review_id: Schema.String.check(Schema.isPattern(/^migration-review-[a-f0-9]{64}$/u)),
  approval_independent_sha256: Hash,
  originally_approved_legacy_ids: Schema.Array(Schema.String),
  origin: SharedMigrationCreateOriginSchema,
  /** v2 copies preserve original history visibly; this is no terminal receipt. */
  retained_operations: Schema.optional(SharedMigrationPreservationInventorySchema),
  /** Enumeration gaps remain visible and do not establish absent old aliases. */
  retained_catalog_coverage: Schema.optional(CoverageSchema),
  execution: Schema.Struct({
    read_only: Schema.Literal(true),
    apply_allowed: Schema.Literal(false),
  }),
})
export type SharedMigrationReview = typeof SharedMigrationReviewSchema.Type
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "SHARED_MIGRATION_REVIEW_INVALID",
            "The explicit migration review or approved input is invalid.",
          ),
  })

/** Approval may change; every original fact and every isolation declaration
 * remains bound. The readiness basis is derived from the changed approval set.
 * Policy v2 does not consume that declaration as proof of historical effects. */
function approvalIndependent(input: unknown) {
  const decoded = Schema.decodeUnknownSync(SharedMigrationInputSchema)(input, {
    onExcessProperty: "error",
  })
  const { approved_legacy_ids: _approved, readiness_evidence, ...facts } = decoded
  if (readiness_evidence === undefined) return facts
  const { basis_sha256: _basis, ...receipts } = readiness_evidence
  return { ...facts, readiness_evidence: receipts }
}
function conversionContent(candidate: SharedMigrationConversionCandidate) {
  const {
    candidate_id: _id,
    migration_plan_id: _plan,
    migration_input_sha256: _input,
    ...content
  } = candidate
  return content
}
function reviewId(fields: Omit<SharedMigrationReview, "review_id">) {
  return sha256(canonicalSharedJson(fields)).pipe(Effect.map((hash) => `migration-review-${hash}`))
}

/** New reviews with a retained publication proof use the explicit v2 as-of copy
 * boundary. The conversion revalidates the actual bytes; a descriptor alone is
 * not evidence. Other new reviews retain policy v1. Saved reviews keep their
 * exact policy and digest; neither review authorizes cutover or old replay. */
export function reviewSharedMigration(input: MigrationConversionInput) {
  return Effect.gen(function* () {
    const original = yield* checked(() =>
      Schema.decodeUnknownSync(SharedMigrationInputSchema)(input.migration_input, {
        onExcessProperty: "error",
      }),
    )
    const entry = original.catalog.entries.find((item) => item.legacy_id === input.legacy_id)
    const policy = input.execution_policy ?? selectSharedMigrationReviewPolicy(entry)
    const candidate = yield* reviewSharedMigrationConversion({
      ...input,
      execution_policy: policy,
    })
    const plan = yield* prepareSharedMigrationReview(input.library, candidate)
    if (plan.version !== 2)
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_REVIEW_INVALID",
          "Migration review requires the exact versioned origin.",
        ),
      )
    const fields = {
      version: 1 as const,
      kind: "migration_create_review" as const,
      approval_independent_sha256: yield* sha256(
        canonicalSharedJson(yield* checked(() => approvalIndependent(original))),
      ),
      originally_approved_legacy_ids: [...original.approved_legacy_ids].sort(),
      origin: plan.origin,
      ...(policy === "copy_to_new_native_v2"
        ? {
            retained_operations: original.preservation.operations,
            retained_catalog_coverage: original.catalog.coverage,
          }
        : {}),
      execution: { read_only: true as const, apply_allowed: false as const },
    }
    return { ...fields, review_id: yield* reviewId(fields) } satisfies SharedMigrationReview
  })
}

export function validateSharedMigrationReview(input: unknown, expectedReviewId: string) {
  return Effect.gen(function* () {
    const review = yield* checked(() =>
      Schema.decodeUnknownSync(SharedMigrationReviewSchema)(input, { onExcessProperty: "error" }),
    )
    const { review_id, ...fields } = review
    if (review_id !== expectedReviewId || review_id !== (yield* reviewId(fields)))
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_REVIEW_CHANGED",
          "Use the exact digest of the concrete review that was approved; changed content cannot inherit approval.",
        ),
      )
    const asOf = review.origin.candidate.execution_policy === "copy_to_new_native_v2"
    if (
      asOf !== (review.retained_operations !== undefined) ||
      asOf !== (review.retained_catalog_coverage !== undefined)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_REVIEW_INVALID",
          "Only an as-of copy review retains original operations and catalog coverage in its versioned digest; it cannot omit that history or imply enumeration is complete.",
        ),
      )
    const origin = yield* makeSharedMigrationCreateOrigin(
      review.origin.candidate,
      review.origin.member_bindings,
    )
    if (canonicalSharedJson(origin) !== canonicalSharedJson(review.origin))
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_REVIEW_INVALID",
          "The reviewed bytes, Source, target, preimages or member bindings do not reconstruct their exact origin.",
        ),
      )
    return review
  })
}

/** Explicit one-target apply. The exact approved input and stored copy policy
 * are required. No old operation is replayed, retired or declared terminal. */
export function applySharedMigration(input: {
  readonly migrationInput: unknown
  readonly review: unknown
  readonly reviewId: string
  readonly dryRun?: boolean
}) {
  return Effect.gen(function* () {
    const review = yield* validateSharedMigrationReview(input.review, input.reviewId)
    const basis = yield* sha256(
      canonicalSharedJson(yield* checked(() => approvalIndependent(input.migrationInput))),
    )
    if (basis !== review.approval_independent_sha256)
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_REVIEW_CHANGED",
          "The approved input changed original evidence or content. Obtain a new concrete review instead of carrying approval to it.",
        ),
      )
    if (
      review.retained_operations !== undefined &&
      canonicalSharedJson(review.retained_operations) !==
        canonicalSharedJson(property(property(input.migrationInput).preservation).operations)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_REVIEW_CHANGED",
          "The as-of review must retain every original operation and unresolved flag exactly as supplied in the approved input.",
        ),
      )
    if (
      review.retained_catalog_coverage !== undefined &&
      canonicalSharedJson(review.retained_catalog_coverage) !==
        canonicalSharedJson(property(property(input.migrationInput).catalog).coverage)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_REVIEW_CHANGED",
          "The as-of review must retain the exact original catalog coverage and failures; a frozen copy does not complete enumeration or authorize cutover.",
        ),
      )
    const candidate = yield* makeSharedMigrationConversion(
      yield* checked(() =>
        retainedMigrationConversionInput(input.migrationInput, review.origin.candidate),
      ),
    )
    if (
      canonicalSharedJson(conversionContent(candidate)) !==
      canonicalSharedJson(conversionContent(review.origin.candidate))
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_REVIEW_CHANGED",
          "The approved target conversion differs from the reviewed files, Source, preimages or logical member set.",
        ),
      )
    const library = candidate.library
    const plan = yield* prepareSharedMigrationCreate(library, {
      migrationInput: input.migrationInput,
      candidate,
    })
    if (
      plan.version !== 2 ||
      canonicalSharedJson(plan.origin.member_bindings) !==
        canonicalSharedJson(review.origin.member_bindings)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_REVIEW_STALE",
          "The exact reviewed member pages have changed. Keep the original review and inspect new bindings before approval.",
        ),
      )
    if (input.dryRun)
      return {
        status: "planned" as const,
        operation: "create" as const,
        action: "planned" as const,
        dry_run: true as const,
        verified: false as const,
        review_id: review.review_id,
        migration_candidate_id: candidate.candidate_id,
        operation_id: plan.operation_id,
        plan,
      }
    return yield* Effect.gen(function* () {
      const result = yield* executeSharedCreate(library, {
        plan,
        mode: "create",
        migrationInput: input.migrationInput,
      })
      return {
        ...(yield* consumeSharedCreation(library, result, { readOnly: true })),
        status: "created" as const,
        operation_id: result.operation_id,
        review_id: review.review_id,
        migration_candidate_id: candidate.candidate_id,
        legacy_id: candidate.legacy_id,
      }
    }).pipe(
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          ...property(error.details),
          migration_review_id: review.review_id,
          native_create_operation_id: plan.operation_id,
          next: {
            argv: [
              "ntn-skills",
              "ctl",
              "library",
              "migration",
              "reconcile",
              "--entry",
              library.skills.database_id,
              "--operation",
              plan.operation_id,
            ],
          },
        }),
      ),
    )
  })
}

/** Reconcile is deliberately separate from apply/dry-run. It reads one original
 * journal, or an explicit target's shared origin, and never calls a dispatcher. */
export function reconcileSharedMigration(input: {
  readonly entry: string
  readonly operationId: string
  readonly target?: string
}) {
  return Effect.gen(function* () {
    const target = input.target === undefined ? undefined : pageId(input.target)
    if (
      !/^skill-create-[a-f0-9]{64}$/u.test(input.operationId) ||
      (input.target !== undefined && !target)
    )
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Provide the exact original skill-create operation ID and, when supplied, one exact new page UUID or URL.",
        ),
      )
    const library = yield* loadSharedLibrary(input.entry),
      scope = yield* authScope
    const key = yield* sharedCreateJournalKey(scope, library.library_id, input.operationId)
    const saved = yield* (yield* Store).readJson(key, SharedCreateJournalSchema)
    const plan = yield* Effect.gen(function* () {
      if (saved !== undefined) {
        if (
          saved.scope !== scope ||
          saved.library_id !== library.library_id ||
          saved.plan.operation_id !== input.operationId ||
          canonicalSharedJson(saved.plan.library) !== canonicalSharedJson(library)
        )
          return yield* Effect.fail(
            fail(
              "STATE_CONFLICT",
              "The original migration journal belongs to another exact scope, library or operation.",
            ),
          )
        return yield* validateSharedCreatePlan(saved.plan)
      }
      if (!target)
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_ORIGINAL_UNAVAILABLE",
            "No local original journal is available. Another machine must select the exact new page with --target to read its shared origin; an unavailable first POST is never repeated.",
          ),
        )
      return yield* loadSharedCreatePlan(library, {
        skillPageId: target,
        operationId: input.operationId,
      })
    })
    if (plan.version !== 2)
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_REVIEW_INVALID",
          "This operation is not a versioned migration creation.",
        ),
      )
    const result = yield* reconcileSharedCreate(library, plan)
    if (target !== undefined && target !== result.skill_page_id)
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SCOPE",
          "The explicit target differs from the exact original migrated page.",
        ),
      )
    return {
      ...result,
      legacy_id: plan.origin.candidate.legacy_id,
      migration_candidate_id: plan.origin.candidate.candidate_id,
      verification: "original_create_outcome" as const,
      current_snapshot_verified: false as const,
    }
  })
}
