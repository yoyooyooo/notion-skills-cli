import { Effect, FileSystem, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { fail } from "./model.ts"
import { strictJson, SubscriptionAdoptionEvidenceSchema } from "./upstream-model.ts"
import { planSubscriptionAdoption, applySubscriptionAdoption } from "./upstream-subscription.ts"
import { defineCommand } from "./command-schema.ts"
import { rebuildUpstream, restoreDeletedUpstream } from "./upstream-rebuild.ts"
import { planContentAdoption, applyContentAdoption } from "./upstream-content-adoption.ts"
import { publishUpstreamMarkdownFiles } from "./upstream-markdown-files.ts"
import { ContentAdoptionInputSchema } from "./publication-content-adoption-authority.ts"
import {
  planSourceRichTextRepair,
  applySourceRichTextRepair,
  reconcileSourceRichTextRepair,
  showSourceRichTextRepair,
} from "./upstream-source-rich-text-repair.ts"
import { SourceRichTextRepairInputSchema } from "./upstream-source-rich-text-repair-model.ts"
import {
  planSourceRootCompletion,
  applySourceRootCompletion,
  reconcileSourceRootCompletion,
  showSourceRootCompletion,
} from "./upstream-source-root-completion.ts"
import { SourceRootCompletionInputSchema } from "./upstream-source-root-completion-model.ts"
import {
  planSourceRootFidelity,
  applySourceRootFidelity,
  reconcileSourceRootFidelity,
  showSourceRootFidelity,
} from "./upstream-source-root-fidelity.ts"
import { SourceRootFidelityInputSchema } from "./upstream-source-root-fidelity-model.ts"
import {
  planMapCheckpointAdoption,
  applyMapCheckpointAdoption,
} from "./upstream-map-checkpoint-adoption.ts"
import { MapCheckpointAdoptionInputSchema } from "./upstream-map-checkpoint-adoption-model.ts"
import {
  SubscriptionPreparationEvidenceSchema,
  planSubscriptionPreparation,
  applySubscriptionPreparation,
} from "./upstream-preflight-recovery.ts"

/** Historical one-off commands, built only into the independent migration artifact. */
export function upstreamOperatorCommand<E, R>(emit: (value: unknown) => Effect.Effect<void, E, R>) {
  const target = Argument.String("subscription-id").pipe(
    Argument.withDescription(
      "Exact subscription page UUID; display names are never mutation identity",
    ),
  )
  const member = Argument.String("member-key").pipe(
    Argument.withDescription("Exact stable source member path from status/check"),
  )
  const one = (name: string) =>
    Flag.String(name).pipe(
      Flag.between(1, 1),
      Flag.map((values) => values[0]!),
    )
  return defineCommand("upstream").pipe(
    Command.withDescription(
      "One-off migration and recovery of retained upstream publications. These commands preserve their existing identities, reviewed plans and guards. Daily subscription maintenance uses ntn-skills sync upstream.",
    ),
    Command.withSubcommands([
      defineCommand(
        "publish-files",
        {
          plan: Argument.String("plan-id"),
          member,
          operation: one("operation"),
          supersede: Flag.String("supersede").pipe(
            Flag.optional,
            Flag.withDescription(
              "Original unknown file publication to retain untouched while creating a distinct page with a new --operation",
            ),
          ),
        },
        ({ plan, member, operation, supersede }) =>
          publishUpstreamMarkdownFiles(
            plan,
            member,
            operation,
            Option.getOrUndefined(supersede),
          ).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Publish one frozen member as editable Markdown files with a distinct journalled page",
        ),
      ),
      defineCommand("content-adopt-plan", { input: one("input") }, ({ input: file }) =>
        Effect.gen(function* () {
          const bytes = yield* (yield* FileSystem.FileSystem)
            .readFileString(file)
            .pipe(
              Effect.mapError(() =>
                fail("UPSTREAM_INPUT_UNREADABLE", "Content adoption input JSON could not be read."),
              ),
            )
          const parsed = yield* Effect.try({
            try: () => strictJson(ContentAdoptionInputSchema, bytes),
            catch: () =>
              fail(
                "INVALID_ARGUMENT",
                "Provide the exact original plan, member, existing page and old writing operation.",
              ),
          })
          return yield* planContentAdoption(parsed).pipe(Effect.flatMap(emit))
        }),
      ).pipe(
        Command.withShortDescription(
          "Plan adoption of the original upstream member on its existing page",
        ),
      ),
      defineCommand(
        "content-adopt-apply",
        { plan: Argument.String("adoption-plan-id"), hash: one("plan-hash") },
        ({ plan, hash }) => applyContentAdoption(plan, hash).pipe(Effect.flatMap(emit)),
      ).pipe(Command.withShortDescription("Apply the reviewed same-page content adoption plan")),
      defineCommand("source-rich-text-repair-plan", { input: one("input") }, ({ input: file }) =>
        Effect.gen(function* () {
          const bytes = yield* (yield* FileSystem.FileSystem)
            .readFileString(file)
            .pipe(
              Effect.mapError(() =>
                fail(
                  "UPSTREAM_INPUT_UNREADABLE",
                  "Source rich-text repair input JSON could not be read.",
                ),
              ),
            )
          const parsed = yield* Effect.try({
            try: () => strictJson(SourceRichTextRepairInputSchema, bytes),
            catch: () =>
              fail(
                "INVALID_ARGUMENT",
                "Provide the exact original plan, member, existing page, old writing operation, kind and block ID.",
              ),
          })
          return yield* planSourceRichTextRepair(parsed).pipe(Effect.flatMap(emit))
        }),
      ).pipe(
        Command.withShortDescription(
          "Freeze one source-bound leaf repair without changing Notion or original history",
        ),
      ),
      defineCommand(
        "source-rich-text-repair-apply",
        { plan: Argument.String("repair-plan-id"), hash: one("plan-hash") },
        ({ plan, hash }) => applySourceRichTextRepair(plan, hash).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Apply the exact retained single-block effect with a durable request journal",
        ),
      ),
      defineCommand(
        "source-rich-text-repair-reconcile",
        { plan: Argument.String("repair-plan-id"), hash: one("plan-hash") },
        ({ plan, hash }) => reconcileSourceRichTextRepair(plan, hash).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Read the complete original graph to resolve an unknown repair without replaying it",
        ),
      ),
      defineCommand(
        "source-rich-text-repair-show",
        { plan: Argument.String("repair-plan-id") },
        ({ plan }) => showSourceRichTextRepair(plan).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Inspect the full immutable repair plan, original observations and attempts",
        ),
      ),
      defineCommand("source-root-fidelity-plan", { input: one("input") }, ({ input: file }) =>
        Effect.gen(function* () {
          const bytes = yield* (yield* FileSystem.FileSystem)
            .readFileString(file)
            .pipe(
              Effect.mapError(() =>
                fail(
                  "SOURCE_ROOT_FIDELITY_REFUSED",
                  "The exact acknowledged completion selector file is unavailable.",
                ),
              ),
            )
          const parsed = yield* Effect.try({
            try: () => strictJson(SourceRootFidelityInputSchema, bytes),
            catch: () =>
              fail(
                "SOURCE_ROOT_FIDELITY_REFUSED",
                "Provide only the exact acknowledged completion plan ID and hash.",
              ),
          })
          return yield* planSourceRootFidelity(parsed).pipe(Effect.flatMap(emit))
        }),
      ).pipe(
        Command.withShortDescription(
          "Plan nine source-bound block effects under an exact acknowledged root completion",
        ),
      ),
      defineCommand(
        "source-root-fidelity-apply",
        { plan: Argument.String("fidelity-plan-id"), hash: one("plan-hash") },
        ({ plan, hash }) => applySourceRootFidelity(plan, hash).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Apply the exact typed block journal while retaining the original root ACK",
        ),
      ),
      defineCommand(
        "source-root-fidelity-reconcile",
        { plan: Argument.String("fidelity-plan-id"), hash: one("plan-hash") },
        ({ plan, hash }) => reconcileSourceRootFidelity(plan, hash).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Observe only the current exact effect BEFORE or adjacent AFTER; never resend",
        ),
      ),
      defineCommand(
        "source-root-fidelity-show",
        { plan: Argument.String("fidelity-plan-id") },
        ({ plan }) => showSourceRootFidelity(plan).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Show the immutable child plan, nine effects and retained per-request evidence",
        ),
      ),
      defineCommand("source-root-completion-plan", { input: one("input") }, ({ input: file }) =>
        Effect.gen(function* () {
          const bytes = yield* (yield* FileSystem.FileSystem)
            .readFileString(file)
            .pipe(
              Effect.mapError(() =>
                fail(
                  "SOURCE_ROOT_COMPLETION_REFUSED",
                  "The exact original completion selector file is unavailable.",
                ),
              ),
            )
          const parsed = yield* Effect.try({
            try: () => strictJson(SourceRootCompletionInputSchema, bytes),
            catch: () =>
              fail(
                "SOURCE_ROOT_COMPLETION_REFUSED",
                "Provide only the exact original plan, member, page and old writing operation.",
              ),
          })
          return yield* planSourceRootCompletion(parsed).pipe(Effect.flatMap(emit))
        }),
      ).pipe(
        Command.withShortDescription(
          "Review completion of an empty root while preserving every existing reference page",
        ),
      ),
      defineCommand(
        "source-root-completion-apply",
        { plan: Argument.String("completion-plan-id"), hash: one("plan-hash") },
        ({ plan, hash }) => applySourceRootCompletion(plan, hash).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Send the one reviewed root Markdown request with a durable outcome journal",
        ),
      ),
      defineCommand(
        "source-root-completion-reconcile",
        { plan: Argument.String("completion-plan-id"), hash: one("plan-hash") },
        ({ plan, hash }) => reconcileSourceRootCompletion(plan, hash).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Prove exact empty BEFORE or complete stable AFTER without replaying a request",
        ),
      ),
      defineCommand(
        "source-root-completion-show",
        { plan: Argument.String("completion-plan-id") },
        ({ plan }) => showSourceRootCompletion(plan).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Inspect the immutable root-completion plan and every retained request outcome",
        ),
      ),
      defineCommand("map-checkpoint-adopt-plan", { input: one("input") }, ({ input: file }) =>
        Effect.gen(function* () {
          const bytes = yield* (yield* FileSystem.FileSystem)
            .readFileString(file)
            .pipe(
              Effect.mapError(() =>
                fail(
                  "UPSTREAM_INPUT_UNREADABLE",
                  "Map checkpoint adoption input JSON could not be read.",
                ),
              ),
            )
          const parsed = yield* Effect.try({
            try: () => strictJson(MapCheckpointAdoptionInputSchema, bytes),
            catch: () =>
              fail(
                "INVALID_ARGUMENT",
                "Provide the original plan and four exact successful CLI capture paths.",
              ),
          })
          return yield* planMapCheckpointAdoption(parsed).pipe(Effect.flatMap(emit))
        }),
      ).pipe(
        Command.withShortDescription(
          "Review adoption of a complete observed map for the original frozen plan",
        ),
      ),
      defineCommand(
        "map-checkpoint-adopt-apply",
        { plan: Argument.String("adoption-plan-id"), hash: one("plan-hash") },
        ({ plan, hash }) => applyMapCheckpointAdoption(plan, hash).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Atomically adopt the reviewed exact baseline without changing Notion or original history",
        ),
      ),
      defineCommand("adopt-plan", { evidence: one("evidence") }, ({ evidence }) =>
        Effect.gen(function* () {
          const bytes = yield* (yield* FileSystem.FileSystem)
            .readFileString(evidence)
            .pipe(
              Effect.mapError(() =>
                fail("UPSTREAM_INPUT_UNREADABLE", "Adoption evidence JSON could not be read."),
              ),
            )
          const parsed = yield* Effect.try({
            try: () => strictJson(SubscriptionAdoptionEvidenceSchema, bytes),
            catch: () =>
              fail("INVALID_ARGUMENT", "Provide strict exact subscription creation evidence JSON."),
          })
          return yield* planSubscriptionAdoption(parsed).pipe(Effect.flatMap(emit))
        }),
      ).pipe(
        Command.withShortDescription(
          "Plan local adoption of an exact evidenced existing subscription; read-only remotely",
        ),
      ),
      defineCommand(
        "adopt-apply",
        { operation: Argument.String("operation-id"), hash: one("plan-hash") },
        ({ operation, hash }) =>
          applySubscriptionAdoption(operation, hash).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Bind the reviewed exact adoption locally without rewriting the remote page",
        ),
      ),
      defineCommand("prepare-plan", { evidence: one("evidence") }, ({ evidence }) =>
        Effect.gen(function* () {
          const bytes = yield* (yield* FileSystem.FileSystem)
            .readFileString(evidence)
            .pipe(
              Effect.mapError(() =>
                fail("UPSTREAM_INPUT_UNREADABLE", "Preparation evidence JSON could not be read."),
              ),
            )
          const parsed = yield* Effect.try({
            try: () => strictJson(SubscriptionPreparationEvidenceSchema, bytes),
            catch: () =>
              fail("INVALID_ARGUMENT", "Provide exact original preflight failure evidence JSON."),
          })
          return yield* planSubscriptionPreparation(parsed).pipe(Effect.flatMap(emit))
        }),
      ).pipe(
        Command.withShortDescription(
          "Prove original GET-only failure and plan local preparation recovery",
        ),
      ),
      defineCommand(
        "prepare-apply",
        { operation: Argument.String("operation-id"), hash: one("plan-hash") },
        ({ operation, hash }) =>
          applySubscriptionPreparation(operation, hash).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Restore only proven preflight preparation under the original operation ID",
        ),
      ),
      defineCommand(
        "rebuild",
        { target, member, operation: one("operation") },
        ({ target, member, operation }) =>
          rebuildUpstream(target, member, operation).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Rebuild exactly one selected upstream Skill as native Notion content",
        ),
        Command.withDescription(
          "Fetch the selected Skill from its upstream source, move its old owned page to Notion Trash, publish rendered main/reference pages, then replace only that member mapping. Reuse the same operation ID after interruption; old publication history is retained.",
        ),
      ),
      defineCommand(
        "restore-deleted",
        { target, member, operation: one("operation") },
        ({ target, member, operation }) =>
          restoreDeletedUpstream(target, member, operation).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Recreate one upstream member only after proving its page is in Trash",
        ),
        Command.withDescription(
          "Require the original owned page to be readable and already in Notion Trash. Publish a distinct current-source page and switch only that member mapping. A live, missing or inaccessible page fails before publication; reuse the same operation ID after interruption.",
        ),
      ),
    ]),
  )
}
