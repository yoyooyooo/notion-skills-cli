import { ByteSize, Crypto, Effect, FileSystem, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand, exclusiveFlags, withConstraints } from "../../core/src/command-schema.ts"
import { lstatNoFollow } from "../../core/src/local-locks.ts"
import { fail, SkillsError } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { withCurrentInvocationBudget } from "../../core/src/shared-current-invocation.ts"
import { validateCurrentSourceId } from "../../core/src/shared-current-source.ts"
import { validateCurrentSourceInput } from "../../core/src/shared-current-source-input.ts"
import { queryCurrentSourceManagement } from "../../core/src/shared-current-source-management.ts"
import { applyCurrentSource } from "../../core/src/shared-current-source-write.ts"
import { currentWriteIdentity } from "../../core/src/shared-current-write-input.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"

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
export function loadCurrentSourceDeclaration(input: string) {
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
          invalid("A Source declaration must be one regular JSON file of at most 512 KiB."),
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
          invalid("A Source declaration must be one regular JSON file of at most 512 KiB."),
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
        validateCurrentSourceInput(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        ),
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

const budgetFlag = (name: string, description: string) =>
  Flag.Int(name).pipe(
    Flag.atMost(1),
    Flag.map((values) => Option.fromUndefinedOr(values[0])),
    Flag.withDescription(description),
  )
const flags = {
  entry: requiredSingleton("entry", "Current Skills database ID, URL or exact registered alias"),
  operation: singleton(
    "operation",
    "Stable current Source intent identity; required with --resume",
  ),
  resume: switchFlag("resume", "Continue the same frozen Source intent with --operation"),
  dryRun: switchFlag(
    "dry-run",
    "Inspect current targets and exact provider files without writing Notion",
  ),
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
    "Positive invocation deadline in ms, including Git acquisition; default 600000",
  ),
}
type SourceOptions = {
  readonly entry: string
  readonly operation: Option.Option<string>
  readonly resume: boolean
  readonly dryRun: boolean
  readonly maxRequests: Option.Option<number>
  readonly maxBytes: Option.Option<number>
  readonly timeout: Option.Option<number>
}
type SourceRequest =
  | { readonly kind: "apply"; readonly input: string }
  | { readonly kind: "refresh"; readonly sourceId: string }

function runCurrentSource(options: SourceOptions, request: SourceRequest) {
  return Effect.gen(function* () {
    const selected = yield* checked(() => {
      if (
        /^notion_page:/iu.test(options.entry) ||
        (/^[a-z][a-z\d+.-]*:\/\//iu.test(options.entry) && !/^https?:\/\//iu.test(options.entry))
      )
        throw fail(
          "INVALID_ARGUMENT",
          "Source management requires a current database ID, Notion URL or exact registered alias.",
        )
      const operation = Option.getOrUndefined(options.operation)
      if (options.resume && (operation === undefined || options.dryRun))
        throw fail(
          "INVALID_ARGUMENT",
          "--resume requires --operation and cannot be combined with --dry-run.",
        )
      if (operation !== undefined) currentWriteIdentity(operation, "Operation ID")
      if (request.kind === "refresh") validateCurrentSourceId(request.sourceId)
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
      return { operation, limits }
    })
    const admitted =
      request.kind === "apply"
        ? {
            kind: "apply" as const,
            declaration: yield* loadCurrentSourceDeclaration(request.input),
          }
        : request
    const invocation = yield* withCurrentInvocationBudget(
      Effect.gen(function* () {
        const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
        const declaration =
          admitted.kind === "refresh"
            ? yield* Effect.gen(function* () {
                const current = yield* queryCurrentSourceManagement(library, admitted.sourceId)
                if (current === undefined)
                  return yield* Effect.fail(
                    fail("CURRENT_SOURCE_MISSING", "No current Source has this stable identity.", {
                      source_id: admitted.sourceId,
                      next: "Use source apply with a complete declaration to create this Source.",
                    }),
                  )
                return current.declaration
              })
            : admitted.declaration
        const operation =
          selected.operation ??
          (yield* (yield* Crypto.Crypto)
            .randomUUIDv4()
            .pipe(
              Effect.mapError(() =>
                fail("CRYPTO_ERROR", "Cannot identify the current Source intent."),
              ),
            ))
        return {
          ...(yield* applyCurrentSource(library, {
            declaration,
            operation_id: operation,
            mode: options.resume ? "resume" : "apply",
            dry_run: options.dryRun,
          })),
          request_metrics: (yield* Notion).requestMetrics?.(),
        }
      }),
      selected.limits,
    )
    yield* emit({ ...invocation.result, budget: invocation.budget })
  })
}

const description =
  "Use one current Source intent for all explicitly assigned targets. Only unchanged regular files from a fixed GitHub Git revision are supported; unsupported providers, transformations and symbolic links fail before writes. Contributions select stable Skill IDs and exact member-relative file mappings/exclusions; Selection.include/exclude selects member roots. Existing Notion-owned files and other Sources are preserved by the current coordinator. Dry-run still reads Notion and acquires provider files. Resume uses the same operation and frozen commit. HTTP budgets cover library lookup, Source reads and Notion writes; Git subprocess acquisition shares the deadline and reports separate known object bytes, with unknown wire bytes. This does not provide a distributed lock or an atomic multi-Skill transaction."

export const applyCurrentSourceCommand = defineCommand(
  "apply",
  {
    input: Argument.String("input").pipe(
      Argument.withDescription("Complete current Source JSON declaration file"),
    ),
    ...flags,
  },
  (options) => runCurrentSource(options, { kind: "apply", input: options.input }),
).pipe(
  withConstraints([exclusiveFlags(["resume", "dryRun"])]),
  Command.withDescription(
    "Create a Source or replace its complete current configuration and contributions using {version:1,definition,contributions}. " +
      description,
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl library source apply ./source.json --entry LIBRARY_ID --dry-run",
      description: "Inspect the complete declaration and its current targets",
    },
    {
      command:
        "ntn-skills ctl library source apply ./source.json --entry LIBRARY_ID --operation SOURCE_INTENT",
      description: "Apply one explicitly selected Source declaration",
    },
    {
      command:
        "ntn-skills ctl library source apply ./source.json --entry LIBRARY_ID --operation SOURCE_INTENT --resume",
      description: "Continue the same declaration and frozen provider commit",
    },
  ]),
)

export const refreshCurrentSourceCommand = defineCommand(
  "refresh",
  {
    sourceId: Argument.String("source-id").pipe(
      Argument.withDescription("Exact stable current Source ID"),
    ),
    ...flags,
  },
  (options) => runCurrentSource(options, { kind: "refresh", sourceId: options.sourceId }),
).pipe(
  withConstraints([exclusiveFlags(["resume", "dryRun"])]),
  Command.withDescription(
    "Read the current Source declaration from Notion and apply its selected provider revision. Do not reconstruct history or match a display name. If an unfinished configuration change differs from the visible declaration, resume source apply with the original input file. " +
      description,
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl library source refresh SOURCE_ID --entry LIBRARY_ID --dry-run",
      description: "Inspect current contribution changes without writing",
    },
    {
      command:
        "ntn-skills ctl library source refresh SOURCE_ID --entry LIBRARY_ID --operation SOURCE_INTENT",
      description: "Refresh using the current Notion declaration",
    },
    {
      command:
        "ntn-skills ctl library source refresh SOURCE_ID --entry LIBRARY_ID --operation SOURCE_INTENT --resume",
      description: "Continue this unchanged declaration's frozen intent",
    },
  ]),
)

export const currentSourceCommand = defineCommand("source").pipe(
  Command.withDescription(
    "Apply or refresh current Source configuration and stable target contributions through the same finite intent.",
  ),
  Command.withSubcommands([applyCurrentSourceCommand, refreshCurrentSourceCommand]),
)
