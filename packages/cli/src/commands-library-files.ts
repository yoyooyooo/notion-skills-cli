import { Clock, Effect, FileSystem, Path } from "effect"
import { Argument, Command } from "effect/cli"
import { authScope, databaseId } from "../../core/src/catalog.ts"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail, property, SkillsError, type Snapshot } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import { openSharedConsumer } from "../../core/src/shared-consumer.ts"
import {
  executeSharedFileManagement,
  fileManagementProtection,
  loadSharedFileManagementPlan,
  prepareSharedFileManagement,
  reconcileSharedFileManagement,
  type SharedFileManagementPlan,
} from "../../core/src/shared-file-management.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton, switchFlag } from "./command-options.ts"
import { libraryFileRestoreCommand } from "./commands-library-file-restore.ts"
import { libraryFileReviewCommand } from "./commands-library-file-review.ts"
import { libraryFileAcceptCurrentCommand } from "./commands-library-file-accept-current.ts"

const entry = requiredSingleton("entry", "Exact shared library entry ID, URL or registered alias")
const target = Argument.String("target").pipe(
  Argument.withDescription("Exact shared Skill page ID or Notion page URL"),
)
const path = Argument.String("path").pipe(
  Argument.withDescription("Exact supporting-file logical path; the main entrypoint is protected"),
)
const dryRun = switchFlag(
  "dry-run",
  "Read a complete fresh tree and emit the frozen plan without remote writes",
)
function skillPage(value: string) {
  return Effect.try({
    try: () => {
      const selected = pageId(value)
      if (!selected)
        throw fail("INVALID_ARGUMENT", "Select an exact shared Skill page ID or Notion page URL.")
      return selected
    },
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("INVALID_ARGUMENT", "Invalid shared Skill page identity."),
  })
}
function fresh(entryInput: string, targetInput: string) {
  return Effect.gen(function* () {
    const selected = yield* skillPage(targetInput)
    const library = yield* loadSharedLibrary(yield* databaseId(entryInput))
    const scope = yield* authScope
    const snapshot = yield* openSharedConsumer({
      library,
      target: selected,
      scope,
      startedAt: yield* Clock.currentTimeMillis,
      forceFull: true,
      readOnly: true,
    })
    return { library, snapshot }
  })
}
function supportingFile(snapshot: Snapshot, selectedPath: string) {
  return Effect.try({
    try: () => {
      if (selectedPath === snapshot.entrypoint)
        throw fail("SHARED_MAIN_FILE_PROTECTED", "The main Skill body cannot be moved or deleted.")
      const observed = property(property(snapshot).shared_authoring).files
      if (!Array.isArray(observed))
        throw fail(
          "SHARED_FILE_MANAGEMENT_STALE",
          "The complete fresh snapshot has no authoring evidence.",
        )
      const matching = observed.map(property).filter((file) => file.path === selectedPath)
      if (matching.length !== 1 || typeof matching[0]?.file_id !== "string")
        throw fail(
          "SHARED_FILE_NOT_BOUND",
          "The exact supporting path has no unique active File ID.",
          { path: selectedPath },
        )
      return matching[0].file_id
    },
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_FILE_NOT_BOUND", "Could not resolve the exact supporting file."),
  })
}
function dispatch(
  library: Parameters<typeof executeSharedFileManagement>[0],
  plan: SharedFileManagementPlan,
  preview: boolean,
) {
  return Effect.gen(function* () {
    if (preview)
      return {
        status: "planned" as const,
        dry_run: true as const,
        operation_id: plan.operation_id,
        action: plan.action,
        file_id: plan.file_id,
        path: plan.path,
        destination_path: plan.destination_path,
        reference_check: plan.reference_check,
        protection: fileManagementProtection,
        plan,
      }
    return {
      ...(yield* executeSharedFileManagement(library, { plan, mode: "create" })),
      action: plan.action,
      file_id: plan.file_id,
      path: plan.destination_path ?? plan.path,
      reference_check: plan.reference_check,
      protection: fileManagementProtection,
    }
  })
}
function inputMarkdown(input: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      location = (yield* Path.Path).resolve(input)
    const info = yield* fs
      .stat(location)
      .pipe(
        Effect.mapError(() =>
          fail("INVALID_INPUT", "Could not inspect the new file input.", { input: location }),
        ),
      )
    if (info.type !== "File")
      return yield* Effect.fail(
        fail("INVALID_INPUT", "--input must identify one regular UTF-8 text file.", {
          input: location,
        }),
      )
    const bytes = yield* fs
      .readFile(location)
      .pipe(
        Effect.mapError(() =>
          fail("INVALID_INPUT", "Could not read the new file input.", { input: location }),
        ),
      )
    return yield* Effect.try({
      try: () => {
        const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        if (markdown.includes("\0")) throw new Error("NUL")
        return markdown
      },
      catch: () =>
        fail(
          "INVALID_INPUT",
          "A new native file requires complete UTF-8 Markdown without NUL; no bytes were replaced.",
          { input: location },
        ),
    })
  })
}

const add = defineCommand(
  "add",
  {
    target,
    path,
    entry,
    input: requiredSingleton("input", "UTF-8 Markdown file to create as one new native File page"),
    dryRun,
  },
  (options) =>
    Effect.gen(function* () {
      const markdown = yield* inputMarkdown(options.input)
      const selected = yield* fresh(options.entry, options.target)
      const plan = yield* prepareSharedFileManagement({
        ...selected,
        action: "add",
        path: options.path,
        markdown,
      })
      yield* emit(yield* dispatch(selected.library, plan, options.dryRun))
    }),
).pipe(
  Command.withDescription(
    "Create one supporting File with a stable File ID and one native body page. Validates the complete fresh tree, portable paths and deterministic local Markdown links/images before dispatch. The original plan is durable before one page create; an uncertain response is never replayed. Existing file identities and tombstones cannot be overwritten. --dry-run emits the exact reviewable plan without remote writes.",
  ),
)

const remove = defineCommand("delete", { target, path, entry, dryRun }, (options) =>
  Effect.gen(function* () {
    const selected = yield* fresh(options.entry, options.target)
    const fileId = yield* supportingFile(selected.snapshot, options.path)
    const plan = yield* prepareSharedFileManagement({ ...selected, action: "delete", fileId })
    yield* emit(yield* dispatch(selected.library, plan, options.dryRun))
  }),
).pipe(
  Command.withDescription(
    "Retain the exact original body and publish an explicit shared tombstone. The native File page and its bytes remain available; no archive or body replacement is sent. Broken local links or images in the proposed complete tree fail before dispatch. Upstream reappearance cannot silently revive the deleted logical path. The main entrypoint is protected.",
  ),
)

const move = defineCommand(
  "move",
  { target, path, destination: Argument.String("destination"), entry, dryRun },
  (options) =>
    Effect.gen(function* () {
      const selected = yield* fresh(options.entry, options.target)
      const fileId = yield* supportingFile(selected.snapshot, options.path)
      const plan = yield* prepareSharedFileManagement({
        ...selected,
        action: "move",
        fileId,
        destinationPath: options.destination,
      })
      yield* emit(yield* dispatch(selected.library, plan, options.dryRun))
    }),
).pipe(
  Command.withDescription(
    "Move one logical supporting-file path while preserving File ID, native page and complete body. Following files retain their original immutable source path; all prior noncurrent paths stay explicitly suppressed. Checks incoming references and the moved file's relative links without rewriting them. Uses one Path-only property PATCH with exact postcondition verification. Notion offers no metadata compare-and-swap; uncertain or conflicting results retain the original plan for read-only reconciliation.",
  ),
)

const reconcile = defineCommand(
  "reconcile",
  { target, operation: Argument.String("operation-id"), entry },
  (options) =>
    Effect.gen(function* () {
      const selected = yield* skillPage(options.target)
      const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
      const plan = yield* loadSharedFileManagementPlan(library, {
        skillPageId: selected,
        operationId: options.operation,
      })
      yield* emit({
        ...(yield* reconcileSharedFileManagement(library, plan)),
        action: plan.action,
        file_id: plan.file_id,
        path: plan.destination_path ?? plan.path,
        protection: fileManagementProtection,
      })
    }),
).pipe(
  Command.withDescription(
    "Read the exact original local/shared lifecycle plan and its verified terminal facts. Never creates a page, PATCHes Path, rewrites a body, or infers completion from matching current content. A verified terminal retires only the derived local replay barrier and requires a fresh current read. Missing original facts remain unresolved.",
  ),
)

export const libraryFilesCommand = defineCommand("file").pipe(
  Command.withDescription(
    "Manage stable shared file lifecycle, restore following and explicitly review original body-write outcomes. Review supports the main body; moving and deleting it remain protected.",
  ),
  Command.withSubcommands([
    add,
    remove,
    move,
    reconcile,
    libraryFileRestoreCommand,
    libraryFileReviewCommand,
    libraryFileAcceptCurrentCommand,
  ]),
)
