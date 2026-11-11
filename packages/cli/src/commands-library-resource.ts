import { Clock, Effect, FileSystem, Option, Path } from "effect"
import { Argument, Command } from "effect/cli"
import { authScope, databaseId } from "../../core/src/catalog.ts"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
import { withSharedAuthoringRequest } from "../../core/src/shared-authoring-context.ts"
import { openSharedConsumer } from "../../core/src/shared-consumer.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { readFixedLocalFile } from "../../core/src/shared-fixed-resources.ts"
import {
  executeSharedResourceAuthoring,
  loadSharedResourceAuthoringPlan,
  prepareSharedResourceAuthoring,
  reconcileSharedResourceAuthoring,
  resourceAuthoringProtection,
} from "../../core/src/shared-resource-authoring.ts"
import { SHARED_RESOURCE_MAX_BYTES } from "../../core/src/shared-resource-content.ts"
import { prepareSharedResourceLifecycle } from "../../core/src/shared-resource-lifecycle.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"

const target = Argument.String("target").pipe(
  Argument.withDescription("Exact shared Skill page ID or Notion page URL"),
)
const path = Argument.String("path").pipe(
  Argument.withDescription("Exact supporting non-document resource path"),
)
const entry = requiredSingleton("entry", "Exact shared library entry ID, URL or registered alias")
function selectedPage(input: string) {
  const selected = pageId(input)
  return selected === undefined
    ? Effect.fail(fail("INVALID_ARGUMENT", "Select an exact shared Skill page ID or Notion URL."))
    : Effect.succeed(selected)
}
/** One explicit regular file. No directory expansion, text conversion or execution. */
function inputResource(input: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const location = path.resolve(input)
    const info = yield* fs.stat(location)
    if (
      info.type !== "File" ||
      (yield* fs.readLink(location).pipe(Effect.result))._tag === "Success"
    )
      return yield* Effect.fail(
        fail(
          "INVALID_INPUT",
          "--input must identify one regular file, without a symbolic-link input.",
        ),
      )
    const size = Number(info.size)
    if (!Number.isSafeInteger(size) || size < 0 || size > SHARED_RESOURCE_MAX_BYTES)
      return yield* Effect.fail(
        fail("SHARED_RESOURCE_TOO_LARGE", "One explicit resource may contain at most 8 MiB."),
      )
    const mode = info.mode & 0o111 ? ("100755" as const) : ("100644" as const)
    const root = yield* fs.realPath(path.dirname(location))
    const bytes = yield* readFixedLocalFile(
      { path: path.basename(location), bytes: size, mode },
      root,
    )
    return { bytes, mode }
  }).pipe(
    Effect.mapError((error) =>
      "code" in error
        ? error
        : fail("INVALID_INPUT", "Could not read the explicit resource input."),
    ),
  )
}
function author(action: "add" | "replace") {
  return defineCommand(
    action,
    {
      target,
      path,
      entry,
      input: requiredSingleton(
        "input",
        "One explicit PNG, binary, JSON or script file; bytes are retained without execution",
      ),
      dryRun: switchFlag(
        "dry-run",
        "Freeze the exact resource plan after a complete read-only observation; send no remote writes",
      ),
    },
    (options) =>
      withSharedAuthoringRequest(
        options.target,
        Effect.gen(function* () {
          const local = yield* inputResource(options.input)
          const selected = yield* selectedPage(options.target)
          const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
          const scope = yield* authScope
          const snapshot = yield* openSharedConsumer({
            library,
            target: selected,
            scope,
            startedAt: yield* Clock.currentTimeMillis,
            forceFull: true,
            readOnly: true,
          })
          const plan = yield* prepareSharedResourceAuthoring({
            library,
            snapshot,
            action,
            path: options.path,
            ...local,
          })
          if (options.dryRun)
            return yield* emit({
              status: "planned",
              dry_run: true,
              remote_writes: 0,
              action,
              operation_id: plan.operation_id,
              file_id: plan.file_id,
              path: plan.path,
              content: plan.content,
              prior_pin: plan.prior_pin,
              protection: resourceAuthoringProtection,
              plan,
            })
          return yield* emit({
            ...(yield* executeSharedResourceAuthoring(library, { plan, mode: "create" })),
            action,
            path: plan.path,
            protection: resourceAuthoringProtection,
          })
        }),
      ),
  ).pipe(
    Command.withDescription(
      action === "add"
        ? "Add one absent supporting raw resource with a stable Files page, exact retained bytes and known executable mode. Keeps the previous complete snapshot. Markdown remains editable through the file commands. Unknown original requests are never replayed."
        : "Replace one managed resource, or explicitly customize an existing fixed-source resource path. Retains the complete previous snapshot and exact prior bytes, preserves a bound File ID, and appends a version entry without overwriting management notes. An editable native body is not implicitly converted.",
    ),
  )
}
const lifecycleOptions = {
  target,
  path,
  entry,
  dryRun: switchFlag(
    "dry-run",
    "Check the complete current tree and freeze one exact operation without remote writes",
  ),
}
function lifecycle(
  action: "delete" | "move" | "restore" | "undelete",
  options: {
    readonly target: string
    readonly path: string
    readonly entry: string
    readonly dryRun: boolean
    readonly destinationPath?: string
    readonly sourcePath?: string
  },
) {
  return withSharedAuthoringRequest(
    options.target,
    Effect.gen(function* () {
      const selected = yield* selectedPage(options.target)
      const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
      const snapshot = yield* openSharedConsumer({
        library,
        target: selected,
        scope: yield* authScope,
        startedAt: yield* Clock.currentTimeMillis,
        forceFull: true,
        readOnly: true,
      })
      const prepared = yield* prepareSharedResourceLifecycle({
        library,
        snapshot,
        action,
        path: options.path,
        ...(options.destinationPath === undefined
          ? {}
          : { destinationPath: options.destinationPath }),
        ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
      })
      if (prepared.status === "unchanged")
        return yield* emit({
          ...prepared,
          action,
          dry_run: options.dryRun,
          protection: resourceAuthoringProtection,
        })
      const plan = prepared.plan
      if (options.dryRun)
        return yield* emit({
          status: "planned",
          dry_run: true,
          remote_writes: 0,
          action,
          operation_id: plan.operation_id,
          file_id: plan.file_id,
          path: plan.destination_path ?? plan.path,
          content: plan.content,
          prior_pin: plan.prior_pin,
          protection: resourceAuthoringProtection,
          plan,
        })
      return yield* emit({
        ...(yield* executeSharedResourceAuthoring(library, { plan, mode: "create" })),
        action,
        path: plan.destination_path ?? plan.path,
        protection: resourceAuthoringProtection,
      })
    }),
  )
}
const remove = defineCommand("delete", lifecycleOptions, (options) =>
  lifecycle("delete", options),
).pipe(
  Command.withDescription(
    "Tombstone one exact raw resource while retaining its stable page, previous bytes and complete old snapshot. Current references must remain valid. Later source updates do not revive it.",
  ),
)
const move = defineCommand(
  "move",
  {
    ...lifecycleOptions,
    destinationPath: Argument.String("destination").pipe(
      Argument.withDescription("One absent non-document destination path"),
    ),
  },
  (options) => lifecycle("move", options),
).pipe(
  Command.withDescription(
    "Move one exact resource without changing its File ID, bytes or executable mode. Keep the original source path for subsequent updates. Reject occupied destinations and broken current references.",
  ),
)
const restore = defineCommand(
  "restore",
  {
    ...lifecycleOptions,
    sourcePath: singleton(
      "source-path",
      "Exact path in the currently selected fixed source; defaults to the recorded source path or current path",
    ),
  },
  (options) =>
    lifecycle("restore", { ...options, sourcePath: Option.getOrUndefined(options.sourcePath) }),
).pipe(
  Command.withDescription(
    "Restore a custom or deleted resource to the current fixed source's exact bytes. Retain the previous custom bytes and old snapshot. No similar-file search or management-page body replacement.",
  ),
)
const undelete = defineCommand("undelete", lifecycleOptions, (options) =>
  lifecycle("undelete", options),
).pipe(
  Command.withDescription(
    "Explicitly restore a deleted resource's retained bytes as custom ownership, including resources with no upstream source. Keep its File ID, logical path and executable mode.",
  ),
)
const reconcile = defineCommand(
  "reconcile",
  {
    target,
    operation: Argument.String("operation-id"),
    entry,
  },
  (options) =>
    withSharedAuthoringRequest(
      options.target,
      Effect.gen(function* () {
        const selected = yield* selectedPage(options.target)
        const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
        const plan = yield* loadSharedResourceAuthoringPlan(library, {
          skillPageId: selected,
          operationId: options.operation,
        })
        return yield* emit({
          ...(yield* reconcileSharedResourceAuthoring(library, plan)),
          action: plan.action,
          path: plan.destination_path ?? plan.path,
          protection: resourceAuthoringProtection,
        })
      }),
    ),
).pipe(
  Command.withDescription(
    "Read only the original resource intent and immutable completion facts. Never upload, create, append or infer success from matching current content. Missing facts retain the exact pending operation.",
  ),
)

export const libraryResourceCommand = defineCommand("resource").pipe(
  Command.withDescription(
    "Manage exact non-document resource bytes in shared Notion Files and retained Records.",
  ),
  Command.withSubcommands([
    author("add"),
    author("replace"),
    remove,
    move,
    restore,
    undelete,
    reconcile,
  ]),
)
