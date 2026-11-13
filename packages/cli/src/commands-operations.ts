import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"

import {
  configuration,
  publicConfiguration,
  Store,
  listOperations,
  showOperation,
  reconcileOperation,
  resumeOperation,
} from "@notion-skills-cli/core"

import { defineCommand } from "../../core/src/command-schema.ts"

import {
  requiredSingleton,
  switchFlag,
  emit,
  progressFlag,
  publicationOptions,
  singleton,
} from "./command-options.ts"
import { fail } from "../../core/src/model.ts"
import {
  isSharedMaintenanceOperation,
  showSharedMaintenanceOperation,
  reconcileSharedMaintenanceOperation,
  listSharedMaintenanceOperations,
  resumeSharedMaintenanceOperation,
} from "../../core/src/shared-maintenance-operations.ts"
import {
  recognizeRepairOperation,
  showRepair,
  reconcileRepair,
} from "../../core/src/shared-native-repair.ts"
import {
  isSharedCreationOperation,
  showSharedCreationOperation,
  reconcileSharedCreationOperation,
} from "../../core/src/shared-maintenance-create.ts"
export const operationId = Argument.String("operation-id")
const sharedSelection = {
  target: singleton(
    "target",
    "Exact original shared Skill page; never a name guessed from a partial catalog",
  ),
  entry: singleton("entry", "Exact shared library entry for original operation observation"),
}
function inspectOperation(
  id: string,
  target: Option.Option<string>,
  entry: Option.Option<string>,
  reconcile: boolean,
) {
  const selected = {
    operationId: id,
    target: Option.getOrUndefined(target),
    entry: Option.getOrUndefined(entry),
  }
  if (recognizeRepairOperation(id)) {
    const options = { database: selected.entry, page: selected.target }
    return reconcile ? reconcileRepair(id, options) : showRepair(id, options)
  }
  if (isSharedCreationOperation(id))
    return reconcile
      ? reconcileSharedCreationOperation(selected)
      : showSharedCreationOperation(selected)
  if (isSharedMaintenanceOperation(id))
    return reconcile
      ? reconcileSharedMaintenanceOperation(selected)
      : showSharedMaintenanceOperation(selected)
  if (selected.target !== undefined || selected.entry !== undefined)
    return Effect.fail(
      fail(
        "INVALID_ARGUMENT",
        "--target and --entry belong only to shared maintenance operations.",
      ),
    )
  return reconcile ? reconcileOperation(id) : showOperation(id)
}
export const operationCommand = defineCommand("operation").pipe(
  Command.withDescription(
    "Inspect recorded operations with list and show. Each result distinguishes state, verified outcome and the next action. Reconcile observes the original outcome; resume continues the original operation under its retained guards. Do not start a replacement operation merely because a result is unknown.",
  ),
  Command.withSubcommands([
    defineCommand("list", {}, () =>
      Effect.gen(function* () {
        const original = yield* listOperations
        const shared = yield* listSharedMaintenanceOperations
        const operations = [...original.operations, ...shared.operations]
        yield* emit({
          operations,
          count: operations.length,
          source: "local",
          coverage: {
            exhaustive: false,
            legacy_local: original.coverage,
            shared_pending: shared.coverage,
            shared_remote_history: "not_scanned",
          },
        })
      }),
    ).pipe(
      Command.withDescription(
        "List recorded legacy and shared pending operations in the selected credential's local scope. Shared remote history is not scanned, and this is not a complete remote operation inventory. An unverified result is not necessarily resumable; inspect the exact operation before acting.",
      ),
    ),
    defineCommand("show", { id: operationId, ...sharedSelection }, ({ id, target, entry }) =>
      inspectOperation(id, target, entry, false).pipe(Effect.flatMap(emit)),
    ).pipe(
      Command.withDescription(
        "Inspect one exact original operation, its result and next.argv. This does not begin another content write.",
      ),
    ),
    defineCommand("reconcile", { id: operationId, ...sharedSelection }, ({ id, target, entry }) =>
      inspectOperation(id, target, entry, true).pipe(Effect.flatMap(emit)),
    ).pipe(
      Command.withDescription(
        "Observe the original operation and resolve its recorded outcome where possible. Inspect verified and next.argv before continuing; an unknown remote result is not permission to replay a write.",
      ),
    ),
    defineCommand(
      "resume",
      {
        id: operationId,
        ...sharedSelection,
        progress: progressFlag,
        newArtifact: switchFlag(
          "new-artifact",
          "Explicitly create a new upload artifact when retained upload recovery requires it",
        ),
        retryMetadata: switchFlag(
          "retry-metadata",
          "Explicitly resend only the original idempotent editable-file ownership/commit properties after full unchanged-source verification; retain the old unknown request",
        ),
      },
      ({ id, target, entry, progress, newArtifact, retryMetadata }) =>
        Effect.gen(function* () {
          if (isSharedMaintenanceOperation(id)) {
            if (newArtifact || retryMetadata)
              return yield* Effect.fail(
                fail(
                  "INVALID_ARGUMENT",
                  "Shared maintenance does not use publication retry options.",
                ),
              )
            yield* emit(
              yield* resumeSharedMaintenanceOperation({
                operationId: id,
                target: Option.getOrUndefined(target),
                entry: Option.getOrUndefined(entry),
              }),
            )
            return
          }
          if (recognizeRepairOperation(id) || isSharedCreationOperation(id))
            return yield* Effect.fail(
              fail(
                "OPERATION_RESUME_UNSUPPORTED",
                "This family requires its original guarded recovery command; inspect the original operation before any write.",
                {
                  next: {
                    argv: [
                      "ntn-skills",
                      "ctl",
                      "operation",
                      "show",
                      id,
                      ...Option.match(target, {
                        onNone: () => [],
                        onSome: (value) => ["--target", value],
                      }),
                      ...Option.match(entry, {
                        onNone: () => [],
                        onSome: (value) => ["--entry", value],
                      }),
                    ],
                    read_only: true,
                  },
                },
              ),
            )
          if (Option.isSome(target) || Option.isSome(entry))
            return yield* Effect.fail(
              fail("INVALID_ARGUMENT", "--target and --entry select shared maintenance only."),
            )
          yield* emit(
            yield* resumeOperation(id, {
              ...(yield* publicationOptions(progress)),
              newArtifact,
              retryMetadata,
            }),
          )
        }),
    ).pipe(
      Command.withDescription(
        "Continue the exact original operation under its saved intent and current guards. Preserve its operation ID across retries; conflicts and unresolved outcomes remain explicit.",
      ),
    ),
  ]),
)
export const statusCommand = defineCommand("status", {}, () =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* emit({
      source: "local",
      config: publicConfiguration(yield* configuration),
      roots: { state: store.root, config: store.configRoot, cache: store.cacheRoot },
      operations: yield* listOperations,
      verified: false,
      coverage: { scope: "local_configuration_and_operations", remote_probed: false },
    })
  }),
)
export const backupCommand = defineCommand(
  "backup",
  { output: requiredSingleton("output", "Fresh backup directory") },
  ({ output }) =>
    Effect.gen(function* () {
      yield* emit({ backup: yield* (yield* Store).backup(output), verified: true })
    }),
)
