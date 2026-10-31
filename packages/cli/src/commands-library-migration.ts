import { Effect, FileSystem, Path } from "effect"
import { Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import { planSharedMigration } from "../../core/src/shared-migration-plan.ts"
import { emit, requiredSingleton } from "./command-options.ts"

const plan = defineCommand(
  "plan",
  {
    input: requiredSingleton(
      "input",
      "Exact frozen migration evidence JSON file; no live discovery or production changes",
    ),
  },
  ({ input }) =>
    Effect.gen(function* () {
      if (input === "")
        return yield* Effect.fail(
          fail("MIGRATION_INPUT_INVALID", "--input requires a nonempty frozen JSON file path."),
        )
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const location = path.resolve(input)
      const info = yield* fs
        .stat(location)
        .pipe(
          Effect.mapError(() =>
            fail(
              "MIGRATION_INPUT_READ_FAILED",
              "Could not inspect the frozen migration input file.",
              { input: location },
            ),
          ),
        )
      if (info.type !== "File")
        return yield* Effect.fail(
          fail("MIGRATION_INPUT_NOT_FILE", "--input must identify one regular JSON file.", {
            input: location,
          }),
        )
      const bytes = yield* fs.readFile(location).pipe(
        Effect.mapError(() =>
          fail("MIGRATION_INPUT_READ_FAILED", "Could not read the frozen migration input file.", {
            input: location,
          }),
        ),
      )
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () =>
          fail(
            "MIGRATION_INPUT_INVALID_UTF8",
            "The frozen migration input must contain valid UTF-8; invalid original bytes were not replaced.",
            { input: location },
          ),
      })
      const evidence = yield* Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: () =>
          fail("MIGRATION_INPUT_INVALID_JSON", "The frozen migration input is not valid JSON.", {
            input: location,
          }),
      })
      yield* emit(yield* planSharedMigration(evidence))
    }),
).pipe(
  Command.withShortDescription("Plan a migration from an exact frozen evidence file"),
  Command.withDescription(
    "Read one complete frozen JSON input and emit its deterministic migration plan, including original evidence and every item-level mapping or blocker. reviewable means the supplied evidence has no unresolved blockers; blocked lists what remains incomplete. Both return apply_allowed:false: neither executes or authorizes production migration. Approved scope must already be explicitly frozen in the input. This command does not discover Notion content, contact source providers, change configuration or write migration state. Output is complete and is not truncated.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl library migration plan --input FROZEN_JSON",
      description:
        "Review an exact frozen evidence file; redirect the complete JSON result to a plan file if needed",
    },
  ]),
)

export const libraryMigrationCommand = defineCommand("migration").pipe(
  Command.withShortDescription("Review deterministic migration plans without production changes"),
  Command.withDescription(
    "Plan from frozen evidence only. Data readiness and production authorization are separate: reviewable/blocked reports evidence readiness, and apply_allowed remains false.",
  ),
  Command.withSubcommands([plan]),
)
