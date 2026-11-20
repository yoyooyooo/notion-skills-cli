/** AH-513 only. Resume a bounded, read-only capture of explicitly selected current
 * pages. This is not a product command; remove it after the cutover (AH-517). */
import { createHash, randomUUID } from "node:crypto"
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  Cause,
  Config,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { localRuntime } from "../packages/cli/src/runtime.ts"
import { fail, SkillsError } from "../packages/core/src/model.ts"
import { Notion, NotionTransport } from "../packages/core/src/notion.ts"
import { NotionCredentialProvider } from "../packages/core/src/notion-credential.ts"
import { NotionRequestSchedulerLive } from "../packages/core/src/notion-request-scheduler.ts"
import {
  makeRequestBudget,
  RequestBudget,
  type RequestBudgetLimits,
} from "../packages/core/src/request-budget.ts"
import { observeSharedBody } from "../packages/core/src/shared-page-body.ts"
import {
  NativeBodyCompletionSchema,
  validateNativeBodyCompletion,
} from "../packages/core/src/shared-native-body-completion.ts"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"
import { sha256 } from "../packages/core/src/store.ts"

const PageId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
)
const SelectionItem = Schema.Struct({
  page_id: PageId,
  owner_page_id: PageId,
  file_id: Schema.NullOr(Schema.String),
  path: Schema.String,
  reason: Schema.String,
})
const CapturedItem = Schema.Struct({
  page_id: PageId,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  observed_at: Schema.Number,
  alias_completion: Schema.Boolean,
})
const FailedItem = Schema.Struct({
  page_id: PageId,
  message: Schema.String,
  code: Schema.optional(Schema.String),
  details: Schema.optional(Schema.Unknown),
})
const Checkpoint = Schema.Struct({
  kind: Schema.Literal("current-physical-page-bodies-only"),
  expected: Schema.Number,
  complete: Schema.Boolean,
  captured: Schema.Array(CapturedItem),
  failed: Schema.Array(FailedItem),
  readers: Schema.Array(Schema.Unknown),
  prior_failed: Schema.optional(Schema.Array(Schema.Unknown)),
})
type Selection = typeof SelectionItem.Type
type Captured = typeof CapturedItem.Type
type Failed = typeof FailedItem.Type
type CheckpointValue = typeof Checkpoint.Type
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const inputError = (message: string, details?: unknown) =>
  fail("CAPTURE_INPUT_INVALID", message, details)

export function validateSelection(raw: unknown): readonly Selection[] {
  const selection = Schema.decodeUnknownSync(Schema.Array(SelectionItem))(raw, {
    onExcessProperty: "error",
  })
  if (!selection.length) throw inputError("Select at least one physical current page.")
  const ids = new Set<string>()
  for (const item of selection) {
    if (ids.has(item.page_id))
      throw inputError("The selection repeats a physical page.", { page_id: item.page_id })
    if (!item.path || !item.reason)
      throw inputError("Every selected page needs its path and reason.")
    ids.add(item.page_id)
  }
  return selection
}

export function verifyCapturedBody(raw: unknown, bytes: Uint8Array): Captured {
  const captured = Schema.decodeUnknownSync(CapturedItem)(raw, { onExcessProperty: "error" })
  if (
    !Number.isSafeInteger(captured.bytes) ||
    !Number.isFinite(captured.observed_at) ||
    captured.observed_at < 0 ||
    captured.bytes !== bytes.byteLength ||
    captured.sha256 !== digest(bytes)
  )
    throw fail(
      "CAPTURE_CHECKPOINT_MISMATCH",
      "A captured body differs from its recorded hash, size or observation.",
      { page_id: captured.page_id },
    )
  new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  return captured
}

function readRegular(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile()) throw inputError("Capture inputs must be regular files.", { path })
    const bytes = readFileSync(fd),
      after = fstatSync(fd)
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length !== before.size
    )
      throw fail("CAPTURE_INPUT_CHANGED", "A capture input changed during verification.", { path })
    return bytes
  } finally {
    closeSync(fd)
  }
}
function readJson(path: string): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readRegular(path)))
}
function atomicWrite(path: string, bytes: string | Uint8Array): void {
  const temporary = `${path}.pending-${randomUUID()}`
  writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" })
  renameSync(temporary, path)
}
function atomicJson(path: string, value: unknown): void {
  atomicWrite(path, JSON.stringify(value, null, 2) + "\n")
}
function captureBodyPath(output: string, page: string): string {
  return join(output, page + ".md")
}

export function loadCheckpoint(selection: readonly Selection[], output: string): CheckpointValue {
  const selected = new Set(selection.map((item) => item.page_id))
  const savedSelection = join(output, "selection.json")
  if (
    existsSync(savedSelection) &&
    canonicalSharedJson(validateSelection(readJson(savedSelection))) !==
      canonicalSharedJson(selection)
  )
    throw fail("CAPTURE_SELECTION_CONFLICT", "The output belongs to a different exact selection.")
  const path = join(output, "index.json")
  if (!existsSync(path))
    return {
      kind: "current-physical-page-bodies-only",
      expected: selection.length,
      complete: false,
      captured: [],
      failed: [],
      readers: [],
    }
  const checkpoint = Schema.decodeUnknownSync(Checkpoint)(readJson(path), {
    onExcessProperty: "error",
  })
  if (checkpoint.expected !== selection.length)
    throw fail(
      "CAPTURE_SELECTION_CONFLICT",
      "The checkpoint has a different selection denominator.",
    )
  const capturedIds = new Set<string>(),
    failedIds = new Set<string>()
  for (const captured of checkpoint.captured) {
    if (!selected.has(captured.page_id) || capturedIds.has(captured.page_id))
      throw inputError("The checkpoint repeats or includes an unselected captured page.")
    const bytes = readRegular(captureBodyPath(output, captured.page_id))
    verifyCapturedBody(captured, bytes)
    if (captured.alias_completion) {
      const completion = Schema.decodeUnknownSync(NativeBodyCompletionSchema)(
        readJson(join(output, captured.page_id + ".completion.json")),
        { onExcessProperty: "error" },
      )
      validateNativeBodyCompletion(bytes.toString("utf8"), completion, {
        page_id: captured.page_id,
        body_sha256: captured.sha256,
      })
    }
    capturedIds.add(captured.page_id)
  }
  for (const failed of checkpoint.failed) {
    if (
      !selected.has(failed.page_id) ||
      failedIds.has(failed.page_id) ||
      capturedIds.has(failed.page_id)
    )
      throw inputError("The checkpoint has an invalid failed-page identity.")
    failedIds.add(failed.page_id)
  }
  if (
    checkpoint.complete &&
    (checkpoint.captured.length !== selection.length || checkpoint.failed.length !== 0)
  )
    throw inputError("The checkpoint claims completeness without full coverage.")
  return checkpoint
}

type Arguments = { selection: string; output: string; limits: RequestBudgetLimits }
export function parseArguments(args: readonly string[]): Arguments {
  const options = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1]
    if (
      !key ||
      !["--selection", "--output", "--max-requests", "--max-bytes", "--timeout"].includes(key) ||
      value === undefined ||
      options.has(key)
    )
      throw inputError("Supply each documented option exactly once.")
    options.set(key, value)
  }
  const absolute = (key: string) => {
    const value = options.get(key)
    if (!value || !isAbsolute(value)) throw inputError(`${key} requires an explicit absolute path.`)
    return resolve(value)
  }
  const positive = (key: string) => {
    const raw = options.get(key),
      value = Number(raw)
    if (!raw || !/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(value))
      throw inputError(`${key} requires an explicit positive integer.`)
    return value
  }
  return {
    selection: absolute("--selection"),
    output: absolute("--output"),
    limits: {
      requests: positive("--max-requests"),
      bytes: positive("--max-bytes"),
      duration_ms: positive("--timeout"),
    },
  }
}

// Use the project's real credential identity, scheduler and Notion transport,
// without initializing a Store or reading any old configuration/database.
const credentials = Layer.effect(
  NotionCredentialProvider,
  Effect.gen(function* () {
    const token = yield* Config.Redacted("NOTION_API_TOKEN").pipe(
      Effect.mapError(() =>
        fail("AUTH_REQUIRED", "Inject the project's NOTION_API_TOKEN before capture."),
      ),
    )
    const value = Redacted.value(token)
    if (!value || /\s/u.test(value))
      return yield* Effect.fail(
        fail("CONFIG_ERROR", "The injected project token is empty or contains whitespace."),
      )
    const identity = yield* sha256(value)
    return { resolve: Effect.succeed({ token, identity }) }
  }),
)
const transport = NotionTransport.pipe(
  Layer.provide(credentials),
  Layer.provide(NotionRequestSchedulerLive),
)
const runtime = transport.pipe(
  Layer.provideMerge(Layer.mergeAll(localRuntime, FetchHttpClient.layer)),
)

function capture(options: Arguments, selection: readonly Selection[], original: CheckpointValue) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const readOnly: Notion["Service"] = {
      ...api,
      readOnly: true,
      request: (path, body, input) =>
        (input?.method ?? "GET") !== "GET" || body !== undefined || input?.file !== undefined
          ? Effect.fail(fail("NOTION_READ_ONLY", "Current capture cannot dispatch a mutation."))
          : api.request(path, undefined, { ...input, method: "GET" }),
    }
    const budget = yield* makeRequestBudget(`cutover-current-${randomUUID()}`, options.limits)
    const captured = new Map(original.captured.map((item) => [item.page_id, item]))
    const failures = new Map<string, Failed>()
    const previousFailures = [...(original.prior_failed ?? []), ...original.failed]
    const run: Record<string, unknown> = {
      transport: "project-notion-current-body",
      started_at: Date.now(),
      status: "running",
      remote_writes: 0,
      limits: options.limits,
    }
    const persist = Effect.gen(function* () {
      run.budget = yield* budget.snapshot
      run.request_metrics = api.requestMetrics?.() ?? null
      const checkpoint: CheckpointValue = {
        kind: "current-physical-page-bodies-only",
        expected: selection.length,
        complete: captured.size === selection.length && failures.size === 0,
        captured: selection.flatMap((item) => {
          const value = captured.get(item.page_id)
          return value ? [value] : []
        }),
        failed: [...failures.values()],
        readers: [...original.readers, run],
        ...(previousFailures.length ? { prior_failed: previousFailures } : {}),
      }
      yield* Effect.sync(() => atomicJson(join(options.output, "index.json"), checkpoint))
    })
    const work = Effect.gen(function* () {
      yield* persist
      for (const item of selection) {
        if (captured.has(item.page_id)) continue
        const result = yield* observeSharedBody(item.page_id).pipe(Effect.result)
        if (result._tag === "Success") {
          const body = result.success
          const saved = yield* Effect.try({
            try: () => {
              const bytes = Buffer.from(body.markdown, "utf8"),
                path = captureBodyPath(options.output, item.page_id)
              if (existsSync(path)) {
                if (!readRegular(path).equals(bytes))
                  throw fail(
                    "CAPTURE_UNINDEXED_CONFLICT",
                    "An unindexed body differs from the current observation; preserve it and resolve explicitly.",
                    { page_id: item.page_id },
                  )
              } else atomicWrite(path, bytes)
              if (body.native_body_completion !== undefined)
                atomicJson(
                  join(options.output, item.page_id + ".completion.json"),
                  body.native_body_completion,
                )
              captured.set(item.page_id, {
                page_id: item.page_id,
                sha256: body.fingerprint.sha256,
                bytes: body.bytes,
                observed_at: body.downloaded_at,
                alias_completion: body.native_body_completion !== undefined,
              })
            },
            catch: (error) =>
              error instanceof SkillsError
                ? error
                : fail("CAPTURE_LOCAL_IO", "Could not checkpoint the observed current body.", {
                    page_id: item.page_id,
                  }),
          }).pipe(Effect.result)
          if (saved._tag === "Failure") {
            const error = saved.failure
            failures.set(item.page_id, {
              page_id: item.page_id,
              code: error.code,
              message: error.message,
              ...(error.details === undefined ? {} : { details: error.details }),
            })
            run.status = "stopped"
            yield* persist
            break
          }
        } else {
          const error = result.failure
          failures.set(item.page_id, {
            page_id: item.page_id,
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          })
          if (["REQUEST_BUDGET_EXHAUSTED", "AUTH_REQUIRED", "CONFIG_ERROR"].includes(error.code)) {
            run.status = "stopped"
            yield* persist
            break
          }
        }
        yield* persist
        yield* Effect.sync(() =>
          process.stdout.write(
            JSON.stringify({
              captured: captured.size,
              expected: selection.length,
              failed: failures.size,
              last_page_id: item.page_id,
            }) + "\n",
          ),
        )
      }
      if (run.status === "running")
        run.status = captured.size === selection.length ? "complete" : "partial"
      return {
        complete: captured.size === selection.length,
        captured: captured.size,
        expected: selection.length,
        failed: failures.size,
      }
    })
    return yield* work.pipe(
      Effect.provideService(Notion, readOnly),
      Effect.provideService(RequestBudget, budget),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          run.status = "cancelled"
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          if (run.status === "running") run.status = "failed"
          run.ended_at = Date.now()
          yield* persist
        }),
      ),
    )
  })
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "node scripts/cutover-capture-current.ts --selection ABS --output ABS --max-requests N --max-bytes N --timeout MS\nRequires the project's NOTION_API_TOKEN. Reads only explicitly selected current pages; resumes validated checkpoints.\n",
    )
    return
  }
  const options = parseArguments(process.argv.slice(2))
  const selection = validateSelection(readJson(options.selection))
  const checkpoint = loadCheckpoint(selection, options.output)
  mkdirSync(options.output, { recursive: true, mode: 0o700 })
  if (!existsSync(join(options.output, "selection.json")))
    atomicJson(join(options.output, "selection.json"), selection)
  const abort = new AbortController()
  const onSignal = () => abort.abort()
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  try {
    const exit = await Effect.runPromiseExit(
      capture(options, selection, checkpoint).pipe(
        Effect.provide(runtime),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
        Effect.scoped,
      ),
      { signal: abort.signal },
    )
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) {
        process.exitCode = 130
        return
      }
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      if (error instanceof SkillsError) throw error
      throw fail("CAPTURE_RUNTIME_FAILED", "Current capture stopped before completion.")
    }
    process.stdout.write(JSON.stringify(exit.value) + "\n")
    if (!exit.value.complete) process.exitCode = 1
  } finally {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify(
        error instanceof SkillsError
          ? { code: error.code, message: error.message, details: error.details }
          : {
              code: "CAPTURE_INPUT_INVALID",
              message: error instanceof Error ? error.message : "Invalid capture input.",
            },
      ) + "\n",
    )
    process.exitCode = 1
  })
}
