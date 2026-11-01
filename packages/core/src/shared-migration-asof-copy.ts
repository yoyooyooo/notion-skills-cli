import { Effect } from "effect"
import { fail, property } from "./model.ts"
import type { MigrationBlocker } from "./shared-migration-blockers.ts"
import { validateLegacyCommittedPublicationSource } from "./shared-migration-legacy-publication.ts"
import { migrationTargetReviewBlockers } from "./shared-migration-target-review.ts"

type Plan = Parameters<typeof migrationTargetReviewBlockers>[0]
type Domain = keyof Plan["evidence"]["preservation"]

const preservationCodes = new Set<MigrationBlocker["code"]>([
  "DUPLICATE_OR_EMPTY_ID",
  "PRESERVATION_INCOMPLETE",
  "REFERENCE_UNRESOLVED",
  "LEGACY_SOURCE_OPTIONS_UNSUPPORTED",
  "SOURCE_SEMANTICS_UNRESOLVED",
  "PIN_RETENTION_UNVERIFIED",
  "OPERATION_IDENTITY_UNCERTAIN",
  "UNSETTLED_OPERATION",
])
const followingCodes = new Set<MigrationBlocker["code"]>([
  "FOLLOWING_SOURCE_UNRESOLVED",
  "FOLLOWING_PATH_MISSING",
  "FOLLOWING_BINDING_UNVERIFIED",
])

/** Copying an exact retained observation creates only new pages. It does not
 * read a later legacy state, replay an old operation, change callers or claim
 * cutover. This boundary requires actual proof bytes, not an isolation flag.
 * Known physical aliases remain dependencies. Incomplete catalog coverage does
 * not assert that further aliases are absent; it remains a later cutover gate.
 * The original full plan and every old diagnostic remain unchanged. */
export function inspectMigrationAsOfCopy(plan: Plan, legacyId: string) {
  return Effect.gen(function* () {
    const entries = plan.evidence.catalog.entries.filter((entry) => entry.legacy_id === legacyId)
    const entry = entries[0]
    const sourceId = property(
      property(entry?.metadata).legacy_committed_publication,
    ).source_legacy_id
    const sources = plan.evidence.preservation.sources.items.filter(
      (source) => source.legacy_id === sourceId,
    )
    const source = sources[0]
    if (
      entries.length !== 1 ||
      entry === undefined ||
      typeof sourceId !== "string" ||
      sourceId === "" ||
      sources.length !== 1 ||
      source === undefined
    )
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_ASOF_PROOF_REQUIRED",
          "As-of copy requires one selected entry and its exact retained publication proof; a policy label or receipt flag cannot establish it.",
        ),
      )
    const publication = yield* validateLegacyCommittedPublicationSource(source, entry)
    if (publication.scope !== plan.evidence.scope)
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CREATE_SCOPE",
          "The retained publication snapshot belongs to another observation scope.",
        ),
      )

    const target = migrationTargetReviewBlockers(plan, legacyId)
    const required = new Set(target.dependency_legacy_ids)
    const dependencies = plan.evidence.catalog.entries.filter((item) =>
      required.has(item.legacy_id),
    )
    const requiredSources = new Set(
      dependencies.flatMap((item) =>
        item.files.flatMap((file) =>
          file.ownership === "following" && file.source_id !== undefined ? [file.source_id] : [],
        ),
      ),
    )
    requiredSources.add(source.legacy_id)
    const requiredRouters = new Set(
      dependencies
        .filter((item) => property(item.record).kind === "router")
        .map((item) => item.legacy_id),
    )
    for (const id of requiredRouters) {
      const rows = plan.evidence.preservation.routers.items.filter((item) => item.legacy_id === id)
      if (rows.length !== 1 || rows[0]?.complete !== true)
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_CREATE_ROUTER_UNRESOLVED",
            "A required Router or physical alias needs its exact complete member inventory; retained partial publication cannot authorize a copy.",
            { legacy_id: id },
          ),
        )
    }

    const blocking: number[] = [],
      retained: number[] = [],
      proved: number[] = []
    const deferred = new Set(target.deferred_indexes)
    const originalRows = (domain: Domain, blocker: MigrationBlocker) =>
      preservationCodes.has(blocker.code)
        ? plan.evidence.preservation[domain].items.filter(
            (item) => blocker.subject === `${domain}:${item.legacy_id}`,
          )
        : []
    for (const index of target.blocking_indexes) {
      const blocker = plan.blockers[index]
      if (blocker === undefined) {
        blocking.push(index)
        continue
      }
      // Only this target's actually rechecked Source/body interpretation is
      // discharged. Other following entries and aliases keep their own gates.
      const targetFile =
        followingCodes.has(blocker.code) &&
        entry.files.some((file) => blocker.subject === `${legacyId}:${file.legacy_id}`) &&
        plan.evidence.catalog.entries.filter((item) =>
          item.files.some((file) => blocker.subject === `${item.legacy_id}:${file.legacy_id}`),
        ).length === 1
      if (
        (blocker.subject === `sources:${source.legacy_id}` &&
          ["SOURCE_SEMANTICS_UNRESOLVED", "LEGACY_SOURCE_OPTIONS_UNSUPPORTED"].includes(
            blocker.code,
          )) ||
        targetFile
      ) {
        proved.push(index)
        continue
      }
      // Unknown history remains unknown even when it names the selected page.
      // No operation impact/isolation declaration is consulted or promoted to
      // external verification. Missing reference interpretation is not replay.
      const historical =
        (blocker.code === "CATALOG_INCOMPLETE" && blocker.subject === "catalog") ||
        originalRows("operations", blocker).length > 0 ||
        originalRows("views", blocker).length > 0 ||
        originalRows("pins", blocker).length > 0
      const namespace =
        blocker.code === "INVENTORY_INCOMPLETE" &&
        ["operations", "views", "pins", "sources", "routers"].includes(blocker.subject)
      const unusedSource = originalRows("sources", blocker)
      const unusedRouter = originalRows("routers", blocker)
      if (
        historical ||
        namespace ||
        (unusedSource.length > 0 &&
          unusedSource.every((item) => !requiredSources.has(item.legacy_id))) ||
        (unusedRouter.length > 0 &&
          unusedRouter.every((item) => !requiredRouters.has(item.legacy_id)))
      ) {
        retained.push(index)
        deferred.add(index)
      } else blocking.push(index)
    }
    return {
      publication,
      target_review: {
        dependency_legacy_ids: target.dependency_legacy_ids,
        blocking_indexes: blocking,
        deferred_indexes: [...deferred].sort((a, b) => a - b),
        selected_proof_indexes: proved,
        retained_history_indexes: retained,
        // These remain visible in the complete original plan, never evidence
        // authorizing this independent copy or resolving an old operation.
        unused_readiness_evidence: plan.readiness.evidence_issues,
      },
    }
  })
}
