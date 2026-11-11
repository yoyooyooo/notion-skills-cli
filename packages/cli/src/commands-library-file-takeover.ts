import { Effect, FileSystem, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand, exclusiveFlags, withConstraints } from "../../core/src/command-schema.ts"
import { fail, property } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import {
  executeSharedFileTakeover,
  prepareSharedFileTakeover,
  validateSharedFileTakeoverPlan,
} from "../../core/src/shared-file-takeover.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"

export const libraryFileTakeoverCommand = defineCommand(
  "takeover",
  {
    target: Argument.String("target"),
    path: Argument.String("path"),
    entry: requiredSingleton("entry", "Exact shared library entry ID, URL or registered alias"),
    dryRun: switchFlag(
      "dry-run",
      "Freeze the exact current file, source selection and frontier without remote writes",
    ),
    plan: singleton(
      "plan",
      "Original takeover plan JSON or complete dry-run output; excludes --dry-run",
    ),
    reconcile: switchFlag("reconcile", "Read only the original plan/object/event; requires --plan"),
  },
  (options) =>
    Effect.gen(function* () {
      const target = pageId(options.target)
      const inputPath = Option.getOrUndefined(options.plan)
      if (!target)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Select an exact shared Skill page ID or URL."),
        )
      if (
        (options.dryRun && inputPath !== undefined) ||
        (options.dryRun && options.reconcile) ||
        (options.reconcile && inputPath === undefined)
      )
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Use --dry-run alone; --reconcile requires the original --plan.",
          ),
        )
      const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
      const frozen =
        inputPath === undefined
          ? yield* prepareSharedFileTakeover({ library, skillPageId: target, path: options.path })
          : yield* Effect.gen(function* () {
              const raw = yield* (yield* FileSystem.FileSystem)
                .readFileString(inputPath)
                .pipe(
                  Effect.mapError(() =>
                    fail("INVALID_ARGUMENT", "The original takeover plan file is unavailable."),
                  ),
                )
              const parsed = yield* Effect.try({
                try: (): unknown => JSON.parse(raw),
                catch: () => fail("INVALID_ARGUMENT", "The takeover plan must be valid JSON."),
              })
              const plan = yield* validateSharedFileTakeoverPlan(
                library,
                property(parsed).plan ?? parsed,
              )
              return { status: "planned" as const, plan }
            })
      if (frozen.plan.observation.skill_page_id !== target || frozen.plan.path !== options.path)
        return yield* Effect.fail(
          fail("SHARED_FILE_INTENT_STALE", "The original plan names another exact Skill or file."),
        )
      if (options.dryRun) return yield* emit(frozen)
      return yield* emit(
        yield* executeSharedFileTakeover({
          library,
          plan: frozen.plan,
          mode: options.reconcile ? "reconcile" : "create",
        }),
      )
    }),
).pipe(
  withConstraints([exclusiveFlags(["dryRun", "plan"]), exclusiveFlags(["dryRun", "reconcile"])]),
  Command.withDescription(
    "Explicitly retain and adopt one complete main or supporting file, including unchanged following text. The stable File ID, current source selection, full body and original event frontier are frozen; stale plans and pending writes stop before another acceptance. Reuses the existing observation plan, retained body and adopted event. Sends no body, selection or relation PATCH. Repeating an already matching custom file adds no history. --reconcile inspects the same original facts and never repeats an unknown write; a current read remains necessary after original completion. Status labels alone do not authorize takeover.",
  ),
)
