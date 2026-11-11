import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand, exclusiveFlags, withConstraints } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import {
  processSharedFileRequest,
  readSharedFileRequest,
  submitSharedFileRequest,
} from "../../core/src/shared-file-request.ts"
import { initializeSharedFileRequests } from "../../core/src/shared-file-request-schema.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"

const entry = requiredSingleton("entry", "Exact shared library entry ID, URL or registered alias")
export const libraryFileRequestSchemaCommand = defineCommand(
  "request-schema",
  {
    entry,
    dryRun: switchFlag(
      "dry-run",
      "Inspect Skills/main and Files/reference request fields without creating or registering them",
    ),
  },
  ({ entry, dryRun }) =>
    Effect.gen(function* () {
      const library = yield* loadSharedLibrary(yield* databaseId(entry))
      return yield* emit(yield* initializeSharedFileRequests(library, dryRun))
    }),
).pipe(
  Command.withDescription(
    "Register independent ordinary fields on Skills and Files: user-owned Management Request, readable Management Result and the separate original Management Receipt. --dry-run emits the schema plan. Button properties/actions are configured in Notion UI or templates.",
  ),
)

export const libraryFileRequestCommand = defineCommand(
  "request",
  {
    target: Argument.String("target"),
    path: Argument.String("path"),
    entry,
    submit: switchFlag(
      "submit",
      "Explicitly submit restore intent and freeze the complete current body, frontier and Source identity",
    ),
    process: switchFlag(
      "process",
      "Process the current declared request once and publish independently verified feedback",
    ),
    dryRun: switchFlag(
      "dry-run",
      "Freeze the current request, complete body and fixed-source restore preview without remote writes",
    ),
    reconcile: switchFlag(
      "reconcile",
      "Inspect the original restore from feedback and publish its verified result; never repeat the body write",
    ),
    operation: singleton(
      "operation",
      "Exact original restore-follow ID for --reconcile when a legacy processing receipt omitted it",
    ),
    allowLocalArchive: switchFlag(
      "allow-local-archive",
      "Authorize retaining the exact local source file in the existing restore journal",
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const target = pageId(options.target)
      const operationId = Option.getOrUndefined(options.operation)
      if (
        !target ||
        [options.submit, options.process, options.reconcile].filter(Boolean).length > 1 ||
        (operationId !== undefined &&
          (!options.reconcile ||
            !/^body-write-follow-[a-f0-9]{64}\.[a-f0-9]{64}$/u.test(operationId)))
      )
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Select one exact Skill page and at most one of --submit, --process or --reconcile. An exact restore-follow --operation is accepted only with --reconcile.",
          ),
        )
      const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
      const input = { library, skillPageId: target, path: options.path }
      if (options.submit)
        return yield* emit(yield* submitSharedFileRequest({ ...input, dryRun: options.dryRun }))
      return yield* emit(
        yield* options.process || options.dryRun || options.reconcile
          ? processSharedFileRequest({
              ...input,
              dryRun: options.dryRun,
              reconcile: options.reconcile,
              allowLocalArchive: options.allowLocalArchive,
              ...(operationId === undefined ? {} : { operationId }),
            })
          : readSharedFileRequest(input),
      )
    }),
).pipe(
  withConstraints([exclusiveFlags(["submit", "process", "reconcile"])]),
  Command.withDescription(
    "Read, submit or process a restore-follow request for exactly one Main File ID or supporting File ID. Default is read-only. --submit explicitly sets Management Request and freezes the complete body, frontier and Source identity in Management Receipt; --submit --dry-run previews without writes. The Notion dropdown is intent only and cannot authorize a different current body. --process consumes only the submitted receipt, allowing a verified selection advance within the same Source definition/member. Later edits, cancellation or rebinding require a fresh submission. A different body uses one complete old-string match and exact full readback, not page revision CAS. Machine feedback never clears intent or treats Status as permission. The actual retained restore ID is verified in feedback before body dispatch. Pending or unknown originals cannot be replayed. --reconcile verifies exact original facts and may publish feedback metadata, never another body write. For an older processing receipt missing its ID, --reconcile --operation ORIGINAL additionally matches the submitted file, preimage, frontier and Source; --dry-run previews this binding. A verified not-applied original permits a new explicit --submit; unknown completion does not.",
  ),
)
