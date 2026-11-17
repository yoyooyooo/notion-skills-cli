import { Clock, Effect, FileSystem, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { authScope, databaseId } from "../../core/src/catalog.ts"
import { defineCommand, exclusiveFlags, withConstraints } from "../../core/src/command-schema.ts"
import { fail, property } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import {
  executeSharedFileTakeover,
  prepareSharedFileTakeover,
  validateSharedFileTakeoverPlan,
} from "../../core/src/shared-file-takeover.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { withSharedAuthoringRequest } from "../../core/src/shared-authoring-context.ts"
import { openSharedConsumer } from "../../core/src/shared-consumer.ts"
import {
  prepareSharedGitMainTakeover,
  executeSharedGitMainTakeover,
} from "../../core/src/shared-git-main-takeover.ts"
import { validateSharedBodyWritePlan } from "../../core/src/shared-body-write-model.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"

export const libraryFileTakeoverCommand = defineCommand(
  "takeover",
  {
    target: Argument.String("target"),
    path: Argument.String("path"),
    entry: requiredSingleton("entry", "Exact shared library entry ID, URL or registered alias"),
    input: singleton(
      "input",
      "Complete local SKILL.md for the first native takeover of a Git-only main; excludes --plan",
    ),
    headerInput: singleton(
      "header-input",
      "Complete SKILL.md whose header alone replaces the existing native main header; body and executable mode stay unchanged",
    ),
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
    withSharedAuthoringRequest(
      options.target,
      Effect.gen(function* () {
        const target = pageId(options.target)
        const inputPath = Option.getOrUndefined(options.plan)
        const completeInput = Option.getOrUndefined(options.input)
        const headerInput = Option.getOrUndefined(options.headerInput)
        if (!target)
          return yield* Effect.fail(
            fail("INVALID_ARGUMENT", "Select an exact shared Skill page ID or URL."),
          )
        if (
          (options.dryRun && inputPath !== undefined) ||
          (options.dryRun && options.reconcile) ||
          (options.reconcile && inputPath === undefined) ||
          (completeInput !== undefined && inputPath !== undefined) ||
          (headerInput !== undefined && (completeInput !== undefined || inputPath !== undefined))
        )
          return yield* Effect.fail(
            fail(
              "INVALID_ARGUMENT",
              "--input, --header-input and --plan are mutually exclusive; --dry-run excludes --plan/--reconcile; --reconcile requires the original --plan.",
            ),
          )
        const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
        const submittedInput = completeInput ?? headerInput
        if (submittedInput !== undefined) {
          const fs = yield* FileSystem.FileSystem
          const stat = yield* fs
            .stat(submittedInput)
            .pipe(
              Effect.mapError(() =>
                fail("INVALID_INPUT", "The complete main input is unavailable."),
              ),
            )
          if (stat.type !== "File")
            return yield* Effect.fail(
              fail(
                "INVALID_INPUT",
                "The input must name one complete regular UTF-8 SKILL.md file.",
              ),
            )
          const bytes = yield* fs
            .readFile(submittedInput)
            .pipe(
              Effect.mapError(() =>
                fail("INVALID_INPUT", "The complete main input could not be read."),
              ),
            )
          const markdown = yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
            catch: () =>
              fail(
                "INVALID_INPUT",
                "The complete main input must be valid UTF-8; no bytes were replaced.",
              ),
          })
          if (headerInput !== undefined) {
            const prepared = yield* prepareSharedFileTakeover({
              library,
              skillPageId: target,
              path: options.path,
              headerInput: markdown,
            })
            if (options.dryRun) return yield* emit(prepared)
            return yield* emit(
              yield* executeSharedFileTakeover({ library, plan: prepared.plan, mode: "create" }),
            )
          }
          const snapshot = yield* openSharedConsumer({
            library,
            target,
            scope: yield* authScope,
            startedAt: yield* Clock.currentTimeMillis,
            forceFull: true,
            readOnly: true,
          })
          const prepared = yield* prepareSharedGitMainTakeover({
            library,
            snapshot,
            path: options.path,
            markdown,
            mode: stat.mode & 0o111 ? "100755" : "100644",
          })
          if (options.dryRun) return yield* emit(prepared)
          return yield* emit(
            yield* executeSharedGitMainTakeover({ library, plan: prepared.plan, mode: "create" }),
          )
        }
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
                const original = property(parsed).plan ?? parsed
                const plan =
                  property(original).kind === "body_write"
                    ? yield* validateSharedBodyWritePlan(original)
                    : yield* validateSharedFileTakeoverPlan(library, original)
                return { status: "planned" as const, plan }
              })
        if (frozen.plan.kind === "body_write") {
          if (
            frozen.plan.skill_page_id !== target ||
            frozen.plan.path !== options.path ||
            frozen.plan.git_main_initialization === undefined
          )
            return yield* Effect.fail(
              fail(
                "SHARED_FILE_INTENT_STALE",
                "The original plan is not this exact initial Git main takeover.",
              ),
            )
          return yield* emit(
            yield* executeSharedGitMainTakeover({
              library,
              plan: frozen.plan,
              mode: options.reconcile ? "reconcile" : "create",
            }),
          )
        }
        if (frozen.plan.observation.skill_page_id !== target || frozen.plan.path !== options.path)
          return yield* Effect.fail(
            fail(
              "SHARED_FILE_INTENT_STALE",
              "The original plan names another exact Skill or file.",
            ),
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
    ),
).pipe(
  withConstraints([
    exclusiveFlags(["dryRun", "plan"]),
    exclusiveFlags(["dryRun", "reconcile"]),
    exclusiveFlags(["input", "plan"]),
    exclusiveFlags(["headerInput", "plan"]),
    exclusiveFlags(["input", "headerInput"]),
  ]),
  Command.withDescription(
    "Explicitly retain and adopt one complete main or supporting file, including unchanged following text. Without input flags this uses the existing observation plan and sends no body, selection or relation PATCH. --input COMPLETE_SKILL.md initializes only an untouched Git-only main in the same owner and File ID, retaining all frontmatter and executable mode; other documents remain fixed Git. The complete Git preimage is separate from the empty control page. The initial v17 import wire uses one append and retains any differing readback as needs_review. Use file review with its exact observed hash; initial-import review also verifies complete text, code and links against the retained input. Unknown requests cannot be reviewed or replayed. --header-input COMPLETE_SKILL.md explicitly replaces only the complete header of an already-native main: its body and mode stay unchanged, all native Name/Description values must match, and pending operations remain barriers. Header changes send no body or property PATCH. Runtime notion_page_id must be removed explicitly, never silently discarded. Align Name and Description using update first. --dry-run emits the original plan; apply in the original Store with --plan. --reconcile verifies original facts without another dispatch. Status labels alone authorize neither operation.",
  ),
)
