import { Effect } from "effect"
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
} from "./command-options.ts"
export const operationId = Argument.String("operation-id")
export const operationCommand = defineCommand("operation").pipe(
  Command.withDescription(
    "Inspect recorded operations with list and show. Each result distinguishes state, verified outcome and the next action. Reconcile observes the original outcome; resume continues the original operation under its retained guards. Do not start a replacement operation merely because a result is unknown.",
  ),
  Command.withSubcommands([
    defineCommand("list", {}, () => listOperations.pipe(Effect.flatMap(emit))).pipe(
      Command.withDescription(
        "List recorded operations in the current local scope, including their state, verified outcome and next action. An unverified result is not necessarily resumable; inspect the exact operation before acting.",
      ),
    ),
    defineCommand("show", { id: operationId }, ({ id }) =>
      showOperation(id).pipe(Effect.flatMap(emit)),
    ).pipe(
      Command.withDescription(
        "Inspect one exact original operation, its result and next.argv. This does not begin another content write.",
      ),
    ),
    defineCommand("reconcile", { id: operationId }, ({ id }) =>
      reconcileOperation(id).pipe(Effect.flatMap(emit)),
    ).pipe(
      Command.withDescription(
        "Observe the original operation and resolve its recorded outcome where possible. Inspect verified and next.argv before continuing; an unknown remote result is not permission to replay a write.",
      ),
    ),
    defineCommand(
      "resume",
      {
        id: operationId,
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
      ({ id, progress, newArtifact, retryMetadata }) =>
        Effect.gen(function* () {
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
