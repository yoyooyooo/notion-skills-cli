import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail, property, text } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import {
  executeLibraryManagement,
  prepareSourceConsolidation,
  prepareSourceRemoval,
  readLibraryManagementPlan,
} from "../../core/src/shared-library-management.ts"
import {
  guardedSourceMutation,
  readSourceDefinition,
  sourceField,
  sourceRich,
} from "../../core/src/shared-source-definitions.ts"
import { withSourceUpdateLock } from "../../core/src/shared-source-policy.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { parseSourceBudget, sourceRequestBudgets } from "./commands-library-source-run.ts"

const entry = requiredSingleton("entry", "Registered library ID, URL or configured alias")
function managementCommand(kind: "remove" | "consolidate") {
  return defineCommand(
    kind,
    {
      entry,
      source: singleton("source", "Exact Source ID or page ID; never a display-name match"),
      operation: singleton("operation", "Continue the exact locally retained management operation"),
      name: singleton("name", "Display name for the retained canonical Source; consolidation only"),
      dryRun: switchFlag(
        "dry-run",
        "Preview complete affected metadata and retain the plan locally; no remote writes",
      ),
      ...sourceRequestBudgets,
    },
    (args) =>
      Effect.gen(function* () {
        const source = Option.getOrUndefined(args.source),
          operation = Option.getOrUndefined(args.operation),
          name = Option.getOrUndefined(args.name)
        if (
          Number(source !== undefined) + Number(operation !== undefined) !== 1 ||
          (name !== undefined && (kind === "remove" || operation !== undefined))
        )
          return yield* Effect.fail(
            fail(
              "INVALID_ARGUMENT",
              "Choose --source or --operation; --name is only for a new consolidation plan.",
            ),
          )
        const library = yield* loadSharedLibrary(yield* databaseId(args.entry))
        const { result, budget } = yield* withSourceCommandBudget(
          withSourceUpdateLock(
            library,
            Effect.gen(function* () {
              const plan =
                operation !== undefined
                  ? yield* readLibraryManagementPlan(library, operation)
                  : kind === "remove"
                    ? yield* prepareSourceRemoval(library, source!)
                    : yield* prepareSourceConsolidation(library, source!, name)
              if (plan.kind !== (kind === "remove" ? "remove_source" : "consolidate_sources"))
                return yield* Effect.fail(
                  fail(
                    "LIBRARY_MANAGEMENT_SCOPE",
                    "The original plan belongs to the other management command.",
                  ),
                )
              return yield* executeLibraryManagement(library, plan, args.dryRun)
            }),
          ),
          yield* parseSourceBudget(args),
        )
        yield* emit({ ...result, budget, request_metrics: (yield* Notion).requestMetrics?.() })
      }),
  ).pipe(
    withConstraints([
      { kind: "exactly_one", flags: ["source", "operation"] },
      { kind: "requires_absent", flag: "name", absent: ["operation"] },
    ]),
    Command.withDescription(
      kind === "remove"
        ? "Remove one exact upstream Source and its complete currently bound Skills, exclusive Files and Records from the live tables using Notion Trash. A preview returns exact IDs/counts and next.argv. Outside Requires block removal; outside Members are detached, shared Records keep unrelated owners. Payloads and scripts are never executed. The saved original operation supports continuation without expanding scope or repeating unknown writes. No permanent deletion, whole-library purge or revocation of already retained private pins is claimed."
        : "Consolidate compatible definitions for the same provider location, ref, policy, options and filters into the selected existing Source. Union only their exact roots, preserve member keys and selected versions, rebind Skills and Records Origin, then trash empty duplicate Source pages. Different configurations and duplicate member bindings are refused or kept separate. Titles are labels, not identities. No content refresh or body write occurs.",
    ),
  )
}
export const sourceRemoveCommand = managementCommand("remove")
export const sourceConsolidateCommand = managementCommand("consolidate")
export const sourceRenameCommand = defineCommand(
  "rename",
  {
    source: Argument.String("source"),
    name: Argument.String("name"),
    entry,
    dryRun: switchFlag("dry-run", "Preview the title-only change without remote writes"),
  },
  (args) =>
    Effect.gen(function* () {
      if (!args.name.trim() || args.name.length > 200 || /[\p{Cc}\p{Cs}]/u.test(args.name))
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Use a nonblank Source display name of at most 200 characters."),
        )
      const library = yield* loadSharedLibrary(yield* databaseId(args.entry))
      const result = yield* withSourceUpdateLock(
        library,
        Effect.gen(function* () {
          const source = yield* readSourceDefinition(library, args.source),
            api = yield* Notion
          if (source.name === args.name)
            return {
              status: "unchanged",
              verified: true,
              source_id: source.source_id,
              page_id: source.page_id,
              name: args.name,
            }
          const nameId = library.sources!.property_ids.Name!,
            sourceId = library.sources!.property_ids["Source ID"]!
          const result = yield* guardedSourceMutation(
            library,
            {
              identity: "source-name:" + source.source_id,
              path: `v1/pages/${source.page_id}`,
              method: "PATCH",
              body: { properties: { [nameId]: { title: sourceRich(args.name) } } },
              dryRun: args.dryRun,
              beforeDispatch: Effect.gen(function* () {
                if (
                  (yield* readSourceDefinition(library, source.page_id)).fingerprint !==
                  source.fingerprint
                )
                  return yield* Effect.fail(
                    fail("SOURCE_DEFINITION_CHANGED", "The Source changed after title preview."),
                  )
              }),
            },
            Effect.gen(function* () {
              const row = yield* api.request(`v1/pages/${source.page_id}`)
              if (property(row).id !== source.page_id || property(row).in_trash === true)
                return undefined
              return text(sourceField(row, nameId).title) === args.name &&
                text(sourceField(row, sourceId).rich_text) === source.source_id
                ? { source_id: source.source_id, page_id: source.page_id, name: args.name }
                : undefined
            }),
          )
          return {
            ...result,
            source_id: source.source_id,
            page_id: source.page_id,
            name: args.name,
            identity_changed: false,
            selected_versions_changed: false,
          }
        }),
      )
      yield* emit(result)
    }),
).pipe(
  Command.withDescription(
    "Rename only the native Source title. Stable Source/page IDs, repository location, member bindings, selected versions and bodies stay unchanged. No extra alias table is needed; old prepared configuration fingerprints may require a fresh preview.",
  ),
)
