import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import { authScope, databaseId } from "../../core/src/catalog.ts"
import { defineCommand, exclusiveFlags, withConstraints } from "../../core/src/command-schema.ts"
import { fail, SkillsError } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import { reviewSharedBodyWrite } from "../../core/src/shared-body-write-review.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton, switchFlag } from "./command-options.ts"

export const libraryFileReviewCommand = defineCommand(
  "review",
  {
    target: Argument.String("target").pipe(
      Argument.withDescription(
        "Exact shared Skill page ID or Notion page URL containing the original body write",
      ),
    ),
    originalOperation: Argument.String("original-operation").pipe(
      Argument.withDescription("Exact original body-write operation ID retained with needs_review"),
    ),
    entry: requiredSingleton("entry", "Exact shared library entry ID, URL or registered alias"),
    acceptedObservedSha256: requiredSingleton(
      "accept-observed-sha256",
      "Exact lowercase SHA-256 of the original complete response.markdown UTF-8 bytes being explicitly accepted",
    ),
    dryRun: switchFlag(
      "dry-run",
      "Read and preview the explicit review without writes; excludes --reconcile",
    ),
    reconcile: switchFlag(
      "reconcile",
      "Read back this same original review without repeating unknown writes; excludes --dry-run",
    ),
  },
  (options) =>
    Effect.gen(function* () {
      if (options.dryRun && options.reconcile)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "--dry-run and --reconcile are mutually exclusive."),
        )
      if (!/^[a-f0-9]{64}$/u.test(options.acceptedObservedSha256))
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "--accept-observed-sha256 requires one exact lowercase SHA-256 digest.",
          ),
        )
      const selected = yield* Effect.try({
        try: () => {
          const id = pageId(options.target)
          if (!id)
            throw fail(
              "INVALID_ARGUMENT",
              "Review requires an exact shared Skill page ID or Notion page URL.",
            )
          return id
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("INVALID_ARGUMENT", "Invalid shared Skill page identity."),
      })
      const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
      const scope = yield* authScope
      // The original pending operation is the review target. A consumer read would
      // stop at its pending barrier before the explicit review could inspect it.
      yield* emit(
        yield* reviewSharedBodyWrite({
          library,
          skillPageId: selected,
          originalOperationId: options.originalOperation,
          acceptedObservedSha256: options.acceptedObservedSha256,
          scope,
          mode: options.reconcile ? "reconcile" : "create",
          dryRun: options.dryRun,
        }),
      )
    }),
).pipe(
  withConstraints([exclusiveFlags(["dryRun", "reconcile"])]),
  Command.withDescription(
    "Explicitly accept the complete currently observed body for one original body-write operation retained as needs_review. --accept-observed-sha256 must identify the exact bytes you reviewed; changed observations fail instead of accepting another version. The original preimage, candidate and needs_review evidence remain retained. New version 2 plans preserve the original candidate's frozen native mode and complete frontmatter, including license fields. Existing version 1 review facts keep their original identities and contents. The review records accepted_observed and does not replay the original write or rewrite the body. It can review the main or a supporting file through the original operation identity. --dry-run previews without writes; --reconcile only observes the same original review. A missing original plan or conflicting versions cannot authorize another review. These flags are mutually exclusive.",
  ),
  Command.withExamples([
    {
      command:
        "ntn-skills ctl library file review PAGE ORIGINAL_OPERATION --entry LIBRARY --accept-observed-sha256 SHA256 --dry-run",
      description:
        "Preview acceptance of one exact observed whole-file body while preserving the original needs_review outcome.",
    },
  ]),
)
