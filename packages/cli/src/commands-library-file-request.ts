import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand, exclusiveFlags, withConstraints } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import {
  processSharedFileRequest,
  readSharedFileRequest,
} from "../../core/src/shared-file-request.ts"
import { initializeSharedFileRequests } from "../../core/src/shared-file-request-schema.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton, switchFlag } from "./command-options.ts"

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
    allowLocalArchive: switchFlag(
      "allow-local-archive",
      "Authorize retaining the exact local source file in the existing restore journal",
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const target = pageId(options.target)
      if (!target || (options.process && options.reconcile))
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Select one exact Skill page and use either --process or --reconcile.",
          ),
        )
      const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
      const input = { library, skillPageId: target, path: options.path }
      return yield* emit(
        yield* options.process || options.dryRun || options.reconcile
          ? processSharedFileRequest({
              ...input,
              dryRun: options.dryRun,
              reconcile: options.reconcile,
              allowLocalArchive: options.allowLocalArchive,
            })
          : readSharedFileRequest(input),
      )
    }),
).pipe(
  withConstraints([exclusiveFlags(["process", "reconcile"])]),
  Command.withDescription(
    "Read or process a native restore-follow request for exactly one Main File ID or supporting File ID. Default is read-only; --dry-run includes the complete observed body and fixed-source preview. --process exits after one attempt. Unsupported editable-body replacement stays blocked; same-body ownership transitions revalidate cancellation, full body, frontier and Source configuration. Machine feedback never clears the user request and never treats Status as permission. Original unknown writes remain barriers and --reconcile only inspects their exact facts.",
  ),
)
