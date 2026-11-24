import { ByteSize, Crypto, Effect, FileSystem, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { libraryId } from "../../core/src/catalog.ts"
import { defineCommand, exclusiveFlags, withConstraints } from "../../core/src/command-schema.ts"
import { lstatNoFollow } from "../../core/src/local-locks.ts"
import { fail, SkillsError } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { withCurrentInvocationBudget } from "../../core/src/shared-current-invocation.ts"
import { validateCurrentSourceId } from "../../core/src/shared-current-source.ts"
import { validateCurrentSourceInput } from "../../core/src/shared-current-source-input.ts"
import { queryCurrentSourceManagement } from "../../core/src/shared-current-source-management.ts"
import { applyCurrentSource } from "../../core/src/shared-current-source-write.ts"
import { CurrentSourceFileRequestSchema } from "../../core/src/shared-current-source-file-input.ts"
import { changeCurrentSourceFileAuthority } from "../../core/src/shared-current-source-file.ts"
import {
  changeCurrentSourceEnabled,
  removeCurrentSource,
} from "../../core/src/shared-current-source-lifecycle.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { selectCurrentWriteMode } from "./current-write-options.ts"
import {
  checkCurrentSourcesCommand,
  syncCurrentSourcesCommand,
} from "./commands-current-source-sync.ts"

const MAX_DECLARATION_BYTES = 512 * 1024
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_SOURCE_INPUT_INVALID", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : invalid("Use a complete current Source JSON declaration."),
  })

/** Validate a bounded local declaration before Notion lookup or provider discovery. */
function loadCurrentSourceJson<A>(input: string, decode: (input: unknown) => A) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const before = yield* lstatNoFollow(input)
      if (
        before === undefined ||
        !before.isFile() ||
        before.size <= 0 ||
        before.size > MAX_DECLARATION_BYTES
      )
        return yield* Effect.fail(
          invalid("The current Source input must be one bounded regular JSON file.", {
            max_bytes: MAX_DECLARATION_BYTES,
          }),
        )
      const handle = yield* fs.open(input, { flag: "r", noFollow: true })
      const stat = yield* handle.stat
      const size = Number(ByteSize.toBigInt(stat.size))
      if (
        stat.type !== "File" ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > MAX_DECLARATION_BYTES ||
        stat.dev !== BigInt.asUintN(64, before.dev) ||
        Option.getOrUndefined(stat.ino) !== BigInt.asUintN(64, before.ino) ||
        ByteSize.toBigInt(stat.size) !== before.size
      )
        return yield* Effect.fail(
          invalid("The current Source input must be one bounded regular JSON file.", {
            max_bytes: MAX_DECLARATION_BYTES,
          }),
        )
      const bytes = new Uint8Array(size)
      let offset = 0
      while (offset < size) {
        const count = yield* handle.read(bytes.subarray(offset))
        if (!count) break
        offset += count
      }
      const extra = yield* handle.readAlloc(1)
      const after = yield* handle.stat
      const current = yield* lstatNoFollow(input)
      if (
        offset !== size ||
        Option.isSome(extra) ||
        after.size !== stat.size ||
        current === undefined ||
        !current.isFile() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.size !== before.size ||
        current.mtimeNs !== before.mtimeNs ||
        current.ctimeNs !== before.ctimeNs
      )
        return yield* Effect.fail(
          invalid("The Source declaration changed while it was being read."),
        )
      return yield* checked(() =>
        decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
      )
    }),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : invalid("The Source declaration could not be read as one regular JSON file."),
    ),
  )
}

export function loadCurrentSourceDeclaration(input: string) {
  return loadCurrentSourceJson(input, validateCurrentSourceInput)
}

const budgetFlag = (name: string, description: string) =>
  Flag.Int(name).pipe(
    Flag.atMost(1),
    Flag.map((values) => Option.fromUndefinedOr(values[0])),
    Flag.withDescription(description),
  )
const flags = {
  library: requiredSingleton("library", "Current Skills database ID, URL or exact registered alias"),
  operation: singleton(
    "operation",
    "Current Source intent identity; required with --resume or --supersede OLD",
  ),
  resume: switchFlag("resume", "Continue the same frozen Source intent with --operation"),
  supersede: singleton(
    "supersede",
    "Replace this exact unfinished Source intent with --operation NEW after reconciliation",
  ),
  dryRun: switchFlag("dry-run", "Inspect the exact current action without writing Notion"),
  maxRequests: budgetFlag(
    "max-requests",
    "Positive maximum HTTP attempts including library and Source reads; default 1000. Git subprocess requests are not counted",
  ),
  maxBytes: budgetFlag(
    "max-bytes",
    "Positive maximum HTTP payload bytes; default 536870912. Git object acquisition has separate metrics and file bounds",
  ),
  timeout: budgetFlag(
    "timeout",
    "Positive invocation deadline in ms, including any provider acquisition; default 600000",
  ),
}
const sourceIdArgument = Argument.String("source-id").pipe(
  Argument.withDescription("Exact stable current Source ID"),
)
const sourcePathArgument = Argument.String("source-path").pipe(
  Argument.withDescription("Exact original Source path, including its member root"),
)
const fileFlags = {
  skillId: requiredSingleton("skill-id", "Exact stable target Skill ID"),
  fileId: requiredSingleton("file-id", "Exact stable current File ID, including the main"),
}
const modeConstraints = [exclusiveFlags(["resume", "supersede", "dryRun"])]
type SourceOptions = {
  readonly library: string
  readonly operation: Option.Option<string>
  readonly resume: boolean
  readonly supersede: Option.Option<string>
  readonly dryRun: boolean
  readonly maxRequests: Option.Option<number>
  readonly maxBytes: Option.Option<number>
  readonly timeout: Option.Option<number>
}
type SourceRequest =
  | { readonly kind: "apply"; readonly input: string }
  | { readonly kind: "refresh" | "enable" | "disable" | "remove"; readonly sourceId: string }
  | { readonly kind: "file"; readonly sourceId: string; readonly selection: unknown }

function runCurrentSource(options: SourceOptions, request: SourceRequest) {
  return Effect.gen(function* () {
    const selected = yield* checked(() => {
      if (
        /^notion_page:/iu.test(options.library) ||
        (/^[a-z][a-z\d+.-]*:\/\//iu.test(options.library) && !/^https?:\/\//iu.test(options.library))
      )
        throw fail(
          "INVALID_ARGUMENT",
          "Source management requires a current database ID, Notion URL or exact registered alias.",
        )
      const operation = Option.getOrUndefined(options.operation)
      const mode = selectCurrentWriteMode({
        operation,
        resume: options.resume,
        supersede: Option.getOrUndefined(options.supersede),
        dryRun: options.dryRun,
      })
      if (request.kind !== "apply") validateCurrentSourceId(request.sourceId)
      const limits = {
        requests: Option.getOrUndefined(options.maxRequests),
        bytes: Option.getOrUndefined(options.maxBytes),
        duration_ms: Option.getOrUndefined(options.timeout),
      }
      for (const [name, value] of Object.entries(limits))
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
          throw fail(
            "INVALID_ARGUMENT",
            "Invocation budgets must be positive safe integers; --timeout uses ms.",
            { budget: name },
          )
      return { operation, mode, limits }
    })
    const validatedRequest =
      request.kind === "apply"
        ? {
            kind: "apply" as const,
            declaration: yield* loadCurrentSourceDeclaration(request.input),
          }
        : request.kind === "file"
          ? {
              ...request,
              selection: yield* checked(() =>
                Schema.decodeUnknownSync(CurrentSourceFileRequestSchema)(request.selection, {
                  onExcessProperty: "error",
                }),
              ),
            }
          : request
    const invocation = yield* withCurrentInvocationBudget(
      Effect.gen(function* () {
        const library = yield* loadSharedLibrary(yield* libraryId(options.library))
        const operation =
          selected.operation ??
          (yield* (yield* Crypto.Crypto)
            .randomUUIDv4()
            .pipe(
              Effect.mapError(() =>
                fail("CRYPTO_ERROR", "Cannot identify the current Source intent."),
              ),
            ))
        const intent = { operation_id: operation, mode: selected.mode, dry_run: options.dryRun }
        const result = yield* Effect.gen(function* () {
          switch (validatedRequest.kind) {
            case "apply":
              return yield* applyCurrentSource(library, {
                ...intent,
                declaration: validatedRequest.declaration,
              })
            case "refresh": {
              const current = yield* queryCurrentSourceManagement(
                library,
                validatedRequest.sourceId,
              )
              if (current === undefined)
                return yield* Effect.fail(
                  fail("CURRENT_SOURCE_MISSING", "No current Source has this stable identity.", {
                    source_id: validatedRequest.sourceId,
                    next: "Use source apply with a complete declaration to create this Source.",
                  }),
                )
              return yield* applyCurrentSource(library, {
                ...intent,
                declaration: current.declaration,
              })
            }
            case "enable":
            case "disable":
              return yield* changeCurrentSourceEnabled(library, {
                ...intent,
                source_id: validatedRequest.sourceId,
                enabled: validatedRequest.kind === "enable",
              })
            case "remove":
              return yield* removeCurrentSource(library, {
                ...intent,
                source_id: validatedRequest.sourceId,
              })
            case "file":
              return yield* changeCurrentSourceFileAuthority(library, {
                ...intent,
                source_id: validatedRequest.sourceId,
                ...validatedRequest.selection,
              })
          }
        })
        return { ...result, request_metrics: (yield* Notion).requestMetrics?.() }
      }),
      selected.limits,
    )
    yield* emit({ ...invocation.result, budget: invocation.budget })
  })
}

const description =
  "Synchronize the complete selected Git member set through one current Source intent. Existing contribution assignments preserve stable Skill IDs; newly discovered members receive deterministic identities. Removed pure Source members and their Files are retired, including a completely empty selected set. Provider failures and incomplete discovery never authorize deletion. Regular Git files keep exact upstream bytes, paths and modes; unsupported transformations and symbolic links fail before writes. GitHub and credential-free HTTP(S) Git origins use local machine authentication. Contributions declare exact member-relative mappings/exclusions; Selection.include/exclude selects member roots. Explicit desired paths replace matching native/resource authority, reported by dry-run; excluded and unrelated content remains preserved, and another Source cannot be overwritten. Complete manifests and Contributions define all consumption files. Refresh creates main pages and updates existing support pages; projection creates selected reading Files, so scripts and tests need no Notion row. Reports separate source_files from notion_pages. Generated reading projections do not block current consumption. Dry-run reads Notion and acquires exact provider files. Resume uses the same operation and frozen commit. --supersede OLD --operation NEW replaces an unfinished intent only after exact predecessor reconciliation. HTTP budgets cover library lookup, Source reads and Notion writes; Git subprocess acquisition shares the deadline and reports separate known object bytes, with unknown wire bytes. There is no distributed lock or atomic multi-Skill transaction."

export const applyCurrentSourceCommand = defineCommand(
  "apply",
  {
    input: Argument.String("input").pipe(
      Argument.withDescription("Complete current Source JSON declaration file"),
    ),
    ...flags,
  },
  (options) =>
    runCurrentSource(options, {
      kind: "apply",
      input: options.input,
    }),
).pipe(
  withConstraints(modeConstraints),
  Command.withDescription(
    "Create, rebuild or synchronize a Source using {version:1,definition,contributions}. Keep this declaration outside Notion to recreate a deleted Source; contributions may be empty and are stable identity overrides for discovered members. " +
      description,
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl library source apply ./source.json --library LIBRARY_ID --dry-run",
      description: "Inspect the complete declaration and its current targets",
    },
    {
      command:
        "ntn-skills ctl library source apply ./source.json --library LIBRARY_ID --operation SOURCE_INTENT",
      description: "Synchronize every member selected by this Source declaration",
    },
    {
      command:
        "ntn-skills ctl library source apply ./source.json --library LIBRARY_ID --operation SOURCE_INTENT --resume",
      description: "Continue the same declaration and frozen provider commit",
    },
  ]),
)

export const refreshCurrentSourceCommand = defineCommand(
  "refresh",
  { sourceId: sourceIdArgument, ...flags },
  (options) => runCurrentSource(options, { kind: "refresh", sourceId: options.sourceId }),
).pipe(
  withConstraints(modeConstraints),
  Command.withDescription(
    "Read the current Source declaration from Notion and reconcile additions, changes and removals at its selected provider revision. If the Source itself was deleted, use source apply with the saved declaration. Do not reconstruct history or match a display name. If an unfinished configuration change differs from the visible declaration, resume source apply with the original input file. " +
      description,
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl library source refresh SOURCE_ID --library LIBRARY_ID --dry-run",
      description: "Inspect current contribution changes without writing",
    },
    {
      command:
        "ntn-skills ctl library source refresh SOURCE_ID --library LIBRARY_ID --operation SOURCE_INTENT",
      description: "Refresh using the current Notion declaration",
    },
    {
      command:
        "ntn-skills ctl library source refresh SOURCE_ID --library LIBRARY_ID --operation SOURCE_INTENT --resume",
      description: "Continue this unchanged declaration's frozen intent",
    },
  ]),
)

export const enableCurrentSourceCommand = defineCommand(
  "enable",
  { sourceId: sourceIdArgument, ...flags },
  (options) => runCurrentSource(options, { kind: "enable", sourceId: options.sourceId }),
).pipe(
  withConstraints(modeConstraints),
  Command.withDescription(
    "Enable ordinary consumption of the selected current Source. Preserve its selected content, contribution configuration and target files; do not discover a newer provider revision.",
  ),
)
export const disableCurrentSourceCommand = defineCommand(
  "disable",
  { sourceId: sourceIdArgument, ...flags },
  (options) => runCurrentSource(options, { kind: "disable", sourceId: options.sourceId }),
).pipe(
  withConstraints(modeConstraints),
  Command.withDescription(
    "Disable ordinary consumption of this Source without replacing its content, contributions or target files. This changes eligibility, not an automatic refresh schedule. Re-enable explicitly after reviewing the current Source.",
  ),
)
export const removeCurrentSourceCommand = defineCommand(
  "remove",
  { sourceId: sourceIdArgument, ...flags },
  (options) => runCurrentSource(options, { kind: "remove", sourceId: options.sourceId }),
).pipe(
  withConstraints(modeConstraints),
  Command.withDescription(
    "Retire one exact Source and its unreferenced owned resources only after a complete library metadata scan proves no current Content or Origin references remain. Existing main or supporting Source files block removal: take them over explicitly first. No Skill, other Source or local file is implicitly removed. Incomplete paging, permission failures and request limits cannot prove absence. Resume the same operation after an unknown retirement result.",
  ),
)
export const takeoverCurrentSourceCommand = defineCommand(
  "takeover",
  {
    sourceId: sourceIdArgument,
    sourcePath: sourcePathArgument,
    ...fileFlags,
    ...flags,
    as: singleton(
      "as",
      "Authority after takeover: resource (default) preserves exact originals; native explicitly selects an editable Notion body",
    ),
  },
  (options) =>
    runCurrentSource(options, {
      kind: "file",
      sourceId: options.sourceId,
      selection: {
        source_path: options.sourcePath,
        skill_id: options.skillId,
        file_id: options.fileId,
        action: { kind: "takeover", to: Option.getOrElse(options.as, () => "resource") },
      },
    }),
).pipe(
  withConstraints([
    ...modeConstraints,
    { kind: "allowed_values", flag: "as", values: ["native", "resource"] },
  ]),
  Command.withDescription(
    "Take over one exact Source file while preserving its File ID, physical page, target path and mode. Use the current Source original and add its exact member-relative contribution exclusion in the same finite intent. Resource is the default and preserves the original bytes; --as native verifies the complete editable body using the shared native Markdown contract and never silently falls back. Known formatting normalization, LF/CRLF and terminal blank lines are accepted; changed structure, text, code or links leave the intent pending. For Markdown paths, a precisely verified automatic link on original plain text can be corrected within the same intent before final readback. The selected original bytes remain exact. Other files and other Source contributions remain unchanged.",
  ),
)
export const restoreFollowCurrentSourceCommand = defineCommand(
  "restore-follow",
  { sourceId: sourceIdArgument, sourcePath: sourcePathArgument, ...fileFlags, ...flags },
  (options) =>
    runCurrentSource(options, {
      kind: "file",
      sourceId: options.sourceId,
      selection: {
        source_path: options.sourcePath,
        skill_id: options.skillId,
        file_id: options.fileId,
        action: { kind: "restore_follow" },
      },
    }),
).pipe(
  withConstraints(modeConstraints),
  Command.withDescription(
    "Replace one exact current native/resource file with the enabled Source's selected original and resume following it. Preserve the File ID, page and target path, remove its exact contribution exclusion and align the mapping. This explicitly overwrites current customization; it does not restore history or require a retained former Origin.",
  ),
)

export const currentSourceCommand = defineCommand("source").pipe(
  Command.withDescription(
    "Manage current Source declarations, eligibility and exact file authority through finite intents; remove only unreferenced Sources.",
  ),
  Command.withSubcommands([
    applyCurrentSourceCommand,
    refreshCurrentSourceCommand,
    checkCurrentSourcesCommand,
    syncCurrentSourcesCommand,
    enableCurrentSourceCommand,
    disableCurrentSourceCommand,
    removeCurrentSourceCommand,
    takeoverCurrentSourceCommand,
    restoreFollowCurrentSourceCommand,
  ]),
)
