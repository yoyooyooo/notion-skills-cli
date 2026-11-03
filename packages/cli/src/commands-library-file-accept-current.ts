import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import { authScope, databaseId } from "../../core/src/catalog.ts"
import { defineCommand, exclusiveFlags, withConstraints } from "../../core/src/command-schema.ts"
import { fail, SkillsError } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import { acceptCurrentSharedBodyWrite } from "../../core/src/shared-body-current-acceptance.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton, switchFlag } from "./command-options.ts"

export const libraryFileAcceptCurrentCommand = defineCommand(
  "accept-current",
  {
    target: Argument.String("target").pipe(
      Argument.withDescription("Exact shared Skill page ID or Notion page URL"),
    ),
    originalOperation: Argument.String("original-operation").pipe(
      Argument.withDescription("Exact original body-write operation with no recorded outcome"),
    ),
    entry: requiredSingleton("entry", "Exact shared library entry ID, URL or registered alias"),
    acceptedObservedSha256: requiredSingleton(
      "accept-observed-sha256",
      "Exact reviewed current response.markdown UTF-8 SHA-256; the complete body must equal the original candidate",
    ),
    dryRun: switchFlag(
      "dry-run",
      "Preview the independent decision without writes; excludes --reconcile",
    ),
    reconcile: switchFlag(
      "reconcile",
      "Observe this same retained acceptance without replay; excludes --dry-run",
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
          fail("INVALID_ARGUMENT", "--accept-observed-sha256 requires an exact lowercase SHA-256."),
        )
      const selected = yield* Effect.try({
        try: () => pageId(options.target),
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("INVALID_ARGUMENT", "Invalid shared Skill page identity."),
      })
      if (!selected)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Acceptance requires an exact shared Skill page identity."),
        )
      yield* emit(
        yield* acceptCurrentSharedBodyWrite({
          library: yield* loadSharedLibrary(yield* databaseId(options.entry)),
          skillPageId: selected,
          originalOperationId: options.originalOperation,
          acceptedObservedSha256: options.acceptedObservedSha256,
          scope: yield* authScope,
          mode: options.reconcile ? "reconcile" : "create",
          dryRun: options.dryRun,
        }),
      )
    }),
).pipe(
  withConstraints([exclusiveFlags(["dryRun", "reconcile"])]),
  Command.withDescription(
    "Record an explicit current-version acceptance for an original unknown body write whose exact adopted event already exists. Requires a complete fresh candidate match, unchanged file/Source and exact current frontier. The original write outcome remains unknown; this independent reviewed decision never fabricates applied, replays a PATCH or creates an acceptance event. Unknown decision writes retain one dispatch and reconcile only. Read again after verified acceptance.",
  ),
  Command.withExamples([
    {
      command:
        "ntn-skills ctl library file accept-current PAGE ORIGINAL_OPERATION --entry LIBRARY --accept-observed-sha256 SHA256 --dry-run",
      description:
        "Review the exact candidate and existing event before recording an independent acceptance.",
    },
  ]),
)
