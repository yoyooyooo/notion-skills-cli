import { Effect, FileSystem } from "effect"
import { Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail, property, SkillsError } from "../../core/src/model.ts"
import {
  executeSharedRelationSchema,
  prepareSharedRelationSchema,
} from "../../core/src/shared-library-relations.ts"
import { emit, requiredSingleton } from "./command-options.ts"

const plan = defineCommand(
  "plan",
  {
    entry: requiredSingleton("entry", "Exact shared library Skills database entry"),
  },
  ({ entry }) =>
    Effect.gen(function* () {
      const plan = yield* prepareSharedRelationSchema(entry)
      yield* emit({
        status: "planned",
        dry_run: true,
        plan,
        operation_id: plan.operation_id,
        additions: plan.additions,
      })
    }),
).pipe(
  Command.withDescription(
    "Read and freeze the native Members/Requires schema upgrade. Existing property IDs remain authoritative after renames. No Notion writes; save the complete returned plan for apply or original-operation reconciliation.",
  ),
)

function readPlan(path: string) {
  return Effect.gen(function* () {
    const raw = yield* (yield* FileSystem.FileSystem)
      .readFileString(path)
      .pipe(
        Effect.mapError(() =>
          fail("INVALID_INPUT", "The frozen relation schema plan file cannot be read."),
        ),
      )
    return yield* Effect.try({
      try: () => {
        const value: unknown = JSON.parse(raw)
        return property(value).plan ?? value
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_INPUT", "The frozen relation schema plan is not valid JSON."),
    })
  })
}
const apply = defineCommand(
  "apply",
  {
    input: requiredSingleton("input", "File containing the exact frozen relation schema plan"),
  },
  ({ input }) =>
    Effect.gen(function* () {
      yield* emit(yield* executeSharedRelationSchema(yield* readPlan(input), "apply"))
    }),
).pipe(
  Command.withDescription(
    "Apply the exact explicit native relation schema plan. Freeze each schema/descriptor dispatch in Records before PATCH and verify complete readback. Repeating the plan observes prior steps and may continue an undispatched descriptor step; unknown writes are never replayed. Existing Skill values, bodies and physical parents are preserved.",
  ),
)

const reconcile = defineCommand(
  "reconcile",
  {
    input: requiredSingleton("input", "File containing the exact original relation schema plan"),
  },
  ({ input }) =>
    Effect.gen(function* () {
      yield* emit(yield* executeSharedRelationSchema(yield* readPlan(input), "reconcile"))
    }),
).pipe(
  Command.withDescription(
    "Read back the exact original relation schema operation without writes. Match operation markers and stable property IDs, never names alone. A schema_observed but unregistered result remains registration_pending until the original plan is explicitly applied.",
  ),
)

export const libraryRelationsCommand = defineCommand("relations").pipe(
  Command.withShortDescription("Explicitly upgrade and inspect native Skill relations"),
  Command.withSubcommands([plan, apply, reconcile]),
)
