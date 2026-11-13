import { Effect, FileSystem, Option, Stream } from "effect"
import { Stdio } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { fail, property } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import {
  defineCommand,
  withConstraints,
  type CommandConstraint,
} from "../../core/src/command-schema.ts"
import {
  applyRepair,
  applyRepairByOperation,
  planRepair,
  reconcileRepair,
  recognizeRepairOperation,
  showRepair,
} from "../../core/src/shared-native-repair.ts"
import { databaseFlag, dryRunFlag, emit, requiredSingleton, singleton } from "./command-options.ts"

export { recognizeRepairOperation }

const entryValues = ["historical-missing-main", "managed-file", "ordinary-child"] as const
const entryConstraint: CommandConstraint = {
  kind: "allowed_values",
  flag: "entry",
  values: entryValues,
}
const entryFlag = Flag.String("entry").pipe(
  Flag.between(1, 1),
  Flag.map((values) => values[0]!),
  Flag.withDescription(
    "historical-missing-main, managed-file, or ordinary-child. One explicit page only",
  ),
)
const planConstraints = [entryConstraint]

export const repairPlanCommand = defineCommand(
  "plan",
  {
    page: Argument.String("page").pipe(
      Argument.withDescription("Exact Skill page, Files row, or ordinary child page ID or URL"),
    ),
    entry: entryFlag,
    database: databaseFlag,
    path: singleton("path", "Canonical path of the one selected Files row"),
    owner: singleton("owner", "Exact owner Skill page ID for a managed Files row"),
    dryRun: dryRunFlag,
  },
  (options) =>
    Effect.gen(function* () {
      yield* emit(
        yield* planRepair(options.page, {
          entry: options.entry,
          dryRun: options.dryRun,
          database: Option.getOrUndefined(options.database),
          path: Option.getOrUndefined(options.path),
          owner: Option.getOrUndefined(options.owner),
        }),
      )
    }),
).pipe(
  withConstraints(planConstraints),
  Command.withDescription(
    "Read one explicit page and freeze a repair plan. --dry-run is required and performs no Notion or journal writes. historical-missing-main keeps the existing Skill ID and fills only a blank Main File ID. managed-file requires --path and --owner and fills only a blank File ID. ordinary-child reports the unsupported same-page placement branch and does not crawl descendants. There is no repair-all.",
  ),
)

export const repairApplyCommand = defineCommand(
  "apply",
  {
    page: Argument.String("page").pipe(
      Argument.withDescription("Same page ID or URL used to freeze the operation"),
    ),
    entry: entryFlag,
    operation: requiredSingleton("operation", "Frozen repair operation id returned by plan"),
    database: requiredSingleton("database", "Skills database ID frozen in the plan"),
    path: singleton("path", "Canonical path when the entry is managed-file"),
    owner: singleton("owner", "Owner Skill page when the entry is managed-file"),
    input: singleton(
      "input",
      "Optional exact plan JSON file, or - for stdin. Omit it to reuse the operation id",
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const input = Option.getOrUndefined(options.input)
      if (input === undefined) {
        yield* emit(
          yield* applyRepairByOperation({
            page: options.page,
            entry: options.entry,
            operationId: options.operation,
            database: options.database,
            path: Option.getOrUndefined(options.path),
            owner: Option.getOrUndefined(options.owner),
          }),
        )
        return
      }
      const text =
        input === "-"
          ? yield* (yield* Stdio.Stdio).stdin.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (current, chunk) => current + chunk,
              ),
              Effect.mapError(() => fail("INPUT_FAILED", "Could not read the frozen repair plan.")),
            )
          : yield* (yield* FileSystem.FileSystem)
              .readFileString(input)
              .pipe(
                Effect.mapError(() =>
                  fail("INVALID_ARGUMENT", "The frozen repair plan file is unreadable."),
                ),
              )
      const plan = yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () => fail("INVALID_ARGUMENT", "The frozen repair plan is not JSON."),
      })
      const selected = property(plan)
      const bound =
        selected.kind === "historical_missing_main" ? selected.skill_page_id : selected.file_page_id
      if (
        typeof bound !== "string" ||
        pageId(options.page) !== bound ||
        selected.entry !== options.entry ||
        (Option.isSome(options.owner) && pageId(options.owner.value) !== selected.skill_page_id) ||
        (Option.isSome(options.path) && options.path.value !== selected.path)
      )
        return yield* Effect.fail(
          fail(
            "REPAIR_SCOPE",
            "The frozen input differs from the exact selected page, entry or owner. Nothing was written.",
          ),
        )
      yield* emit(
        yield* applyRepair(plan, { database: options.database, operationId: options.operation }),
      )
    }),
).pipe(
  Command.withDescription(
    "Apply the operation id returned by plan. The same id resumes that original dispatch. Omit --input; a handwritten record is not required. A missing response is not sent again, and a matching current id does not invent an acknowledgement.",
  ),
)

export const repairShowCommand = defineCommand(
  "show",
  {
    operation: Argument.String("operation").pipe(
      Argument.withDescription("Frozen maintenance-repair operation id"),
    ),
    database: databaseFlag,
    page: singleton("page", "Original page ID when no local locator is retained"),
  },
  (options) =>
    Effect.gen(function* () {
      yield* emit(
        yield* showRepair(options.operation, {
          database: Option.getOrUndefined(options.database),
          page: Option.getOrUndefined(options.page),
        }),
      )
    }),
).pipe(
  Command.withDescription(
    "Show one retained repair operation. This does not send Notion writes or invent an acknowledgement.",
  ),
)

export const repairReconcileCommand = defineCommand(
  "reconcile",
  {
    operation: Argument.String("operation").pipe(
      Argument.withDescription("Frozen maintenance-repair operation id"),
    ),
    database: databaseFlag,
    page: singleton("page", "Original page ID when no local locator is retained"),
  },
  (options) =>
    Effect.gen(function* () {
      yield* emit(
        yield* reconcileRepair(options.operation, {
          database: Option.getOrUndefined(options.database),
          page: Option.getOrUndefined(options.page),
        }),
      )
    }),
).pipe(
  Command.withDescription(
    "Observe the original repair outcome. An unknown dispatch stays unknown. The missing POST is not repeated and the page is not recreated.",
  ),
)

export const repairCommand = defineCommand("repair").pipe(
  Command.withDescription(
    "Repair one historical partial Skill or one hand-created Files row without replacing its page. Plan is read-only; apply uses the same operation ID and exact target. Show and reconcile observe the original operation. A missing response does not permit another identity PATCH or replacement page.",
  ),
  Command.withSubcommands([
    repairPlanCommand,
    repairApplyCommand,
    repairShowCommand,
    repairReconcileCommand,
  ]),
)
