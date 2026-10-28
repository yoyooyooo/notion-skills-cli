import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import {
  planPublicationBodyCompletion,
  applyPublicationBodyCompletion,
  reconcilePublicationBodyCompletion,
} from "../../core/src/publication-body-completion.ts"
import {
  inspectPublicationEdit,
  acceptPublicationEdit,
} from "../../core/src/upstream-publication.ts"
import {
  supersedePlanOperation,
  supersedeApplyOperation,
} from "../../core/src/publication-supersede.ts"
import { defineCommand } from "../../core/src/command-schema.ts"
import { requiredSingleton, emit } from "./command-options.ts"

const operationId = Argument.String("operation-id")
export const operatorOperationCommand = defineCommand("operation").pipe(
  Command.withDescription(
    "One-off inspection and recovery of retained historical publications. Normal content changes continue through ntn-skills operation show/reconcile/resume with the original operation ID.",
  ),
  Command.withSubcommands([
    defineCommand("body-completion-plan", { id: operationId }, ({ id }) =>
      planPublicationBodyCompletion(id).pipe(Effect.flatMap(emit)),
    ).pipe(
      Command.withShortDescription(
        "Plan a bounded completion of an original acknowledged reference body",
      ),
    ),
    defineCommand(
      "body-completion-apply",
      {
        planId: Argument.String("plan-id"),
        guardHash: requiredSingleton(
          "guard-hash",
          "Exact SHA-256 of the reviewed body-completion plan",
        ),
      },
      ({ planId, guardHash }) =>
        applyPublicationBodyCompletion(planId, guardHash).pipe(Effect.flatMap(emit)),
    ).pipe(
      Command.withShortDescription(
        "Apply the exact retained body effects through the original publication journal",
      ),
    ),
    defineCommand(
      "body-completion-reconcile",
      { planId: Argument.String("plan-id") },
      ({ planId }) => reconcilePublicationBodyCompletion(planId).pipe(Effect.flatMap(emit)),
    ).pipe(
      Command.withShortDescription(
        "Observe a retained completion without replaying unknown allocations",
      ),
    ),
    defineCommand(
      "supersede-plan",
      {
        id: operationId,
        intentIndex: requiredSingleton(
          "intent-index",
          "Zero-based original unresolved create intent index",
        ),
        operatorIntent: requiredSingleton(
          "operator-intent",
          "Explicit new creation intent accepting possible delayed original objects",
        ),
      },
      ({ id, intentIndex, operatorIntent }) =>
        supersedePlanOperation(id, { intentIndex: Number(intentIndex), operatorIntent }).pipe(
          Effect.flatMap(emit),
        ),
    ).pipe(
      Command.withShortDescription(
        "Plan one new creation after complete visible-absence discovery",
      ),
    ),
    defineCommand(
      "supersede-apply",
      {
        planId: Argument.String("plan-id"),
        guardHash: requiredSingleton("guard-hash", "Exact SHA-256 of the reviewed supersede plan"),
      },
      ({ planId, guardHash }) =>
        supersedeApplyOperation(planId, { guardHash }).pipe(Effect.flatMap(emit)),
    ).pipe(
      Command.withShortDescription(
        "Apply a reviewed supersede plan once through the publication engine",
      ),
    ),
    defineCommand("inspect-edit", { page: Argument.String("page-id") }, ({ page }) =>
      inspectPublicationEdit(page).pipe(Effect.flatMap(emit)),
    ).pipe(Command.withShortDescription("Inspect a direct Notion edit without accepting it")),
    defineCommand(
      "accept-edit",
      {
        page: Argument.String("page-id"),
        expectedVersion: requiredSingleton(
          "expected-version",
          "Exact version returned by inspect-edit",
        ),
      },
      ({ page, expectedVersion }) =>
        acceptPublicationEdit(page, expectedVersion).pipe(Effect.flatMap(emit)),
    ).pipe(
      Command.withShortDescription(
        "Accept exactly the inspected Notion revision after full verification",
      ),
    ),
  ]),
)
