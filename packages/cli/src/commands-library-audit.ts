import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { decode, fail } from "../../core/src/model.ts"
import { AuditDepthSchema } from "../../core/src/shared-audit-model.ts"
import {
  runSharedAudit,
  resumeSharedAudit,
  reportSharedAudit,
  listSharedAudits,
} from "../../core/src/shared-audit.ts"
import { Store } from "../../core/src/store.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"

const budgets = {
  requests: singleton(
    "max-requests",
    "Maximum actual HTTP attempts in this invocation, including retries; default 500",
  ),
  bytes: singleton(
    "max-bytes",
    "Payload byte admission budget; finish the admitted response and report exact overshoot; default 67108864",
  ),
  duration: singleton(
    "duration-ms",
    "Invocation deadline including requests, queue and retry waits; default 120000 ms",
  ),
}
const output = singleton(
  "output",
  "Optional report JSON file; an existing different file is never overwritten",
)
function integer(input: Option.Option<string>, name: string, allowZero = false) {
  const raw = Option.getOrUndefined(input)
  if (raw === undefined) return undefined
  if (
    !/^\d+$/u.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < (allowZero ? 0 : 1)
  )
    throw fail(
      "INVALID_ARGUMENT",
      `${name} must be ${allowZero ? "a nonnegative" : "a positive"} safe integer.`,
    )
  return Number(raw)
}
function budget(options: {
  requests: Option.Option<string>
  bytes: Option.Option<string>
  duration: Option.Option<string>
}) {
  return Effect.try({
    try: () => {
      const requests = integer(options.requests, "--max-requests")
      const bytes = integer(options.bytes, "--max-bytes")
      const duration_ms = integer(options.duration, "--duration-ms")
      return {
        ...(requests === undefined ? {} : { requests }),
        ...(bytes === undefined ? {} : { bytes }),
        ...(duration_ms === undefined ? {} : { duration_ms }),
      }
    },
    catch: () => fail("INVALID_ARGUMENT", "Audit budgets must be positive safe integers."),
  })
}
function deliver(
  report: Effect.Success<ReturnType<typeof runSharedAudit>>,
  destination: Option.Option<string>,
) {
  return Effect.gen(function* () {
    const path = Option.getOrUndefined(destination)
    if (path !== undefined)
      yield* (yield* Store).output(
        path,
        new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`),
      )
    yield* emit(report)
    process.exitCode =
      report.execution === "paused"
        ? 75
        : report.execution === "execution_failed"
          ? 1
          : report.coverage !== "full" || report.execution !== "completed"
            ? 4
            : report.severity.error > 0
              ? 3
              : 0
  })
}

const run = defineCommand(
  "run",
  {
    entry: requiredSingleton("entry", "Exact registered Skills database entry"),
    target: singleton(
      "target",
      "One exact Skill page ID; mutually exclusive with --all and --census",
    ),
    census: switchFlag(
      "census",
      "Observe complete registered table metadata only for inventory/import preparation; do not inspect individual Skill states or bodies",
    ),
    all: switchFlag(
      "all",
      "Audit all visible registered Skills, including disabled entries; mutually exclusive with --target",
    ),
    depth: singleton(
      "depth",
      "metadata, content or history; default metadata. History verifies retained objects remotely",
    ),
    pin: singleton(
      "pin",
      "Optional exact snapshot- ID for --target with --depth history; no alias/latest substitution",
    ),
    graph: singleton(
      "graph",
      "Optional exact graph- ID with --depth history; verify its fixed closure and retained node bytes",
    ),
    incremental: switchFlag(
      "incremental",
      "Reuse still-valid item results; always perform the cheap forward and reverse census",
    ),
    recheck: singleton(
      "recheck-after-ms",
      "Maximum age for unchanged incremental results; default 86400000; zero forces recheck",
    ),
    retain: singleton(
      "retain-runs",
      "Retain 1–1000 comparable completed local audit runs; default 20; original receipts and user caches are untouched",
    ),
    ...budgets,
    output,
  },
  (options) =>
    Effect.gen(function* () {
      const target = Option.getOrUndefined(options.target)
      if (Number(target !== undefined) + Number(options.all) + Number(options.census) !== 1)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Choose exactly one --target PAGE, --all or --census."),
        )
      const settings = yield* Effect.try({
        try: () => ({
          depth: decode(AuditDepthSchema, Option.getOrUndefined(options.depth) ?? "metadata"),
          recheck_after_ms: integer(options.recheck, "--recheck-after-ms", true),
          retain_runs: integer(options.retain, "--retain-runs"),
        }),
        catch: () =>
          fail(
            "INVALID_ARGUMENT",
            "Use metadata/content/history depth and valid nonnegative recheck/positive retention values.",
          ),
      })
      const report = yield* runSharedAudit({
        entry: options.entry,
        selector: options.census
          ? { kind: "census" }
          : target === undefined
            ? { kind: "library" }
            : { kind: "skill", page_id: target },
        ...settings,
        pin_id: Option.getOrUndefined(options.pin),
        graph_id: Option.getOrUndefined(options.graph),
        incremental: options.incremental,
        budget: yield* budget(options),
      })
      yield* deliver(report, options.output)
    }),
).pipe(
  Command.withDescription(
    "Read-only resource audit with a stable run ID and durable local checkpoint. --target reads that Skill page, its direct Requires and Origin pages, and its File and Record headers through relation filters. It does not scan unrelated library rows, and it does not claim a complete reverse census. --all and --census keep independent unfiltered scans so a cleared owner remains visible. Metadata checks identity, ownership facts and relations without loading all Records Payloads or bodies. Disabled unregistered drafts are metadata states, not missing-identity failures; surviving bindings remain findings and draft content/history stay unverified. Content additionally verifies current native bodies and effective fixed-file bytes and deterministic references. History additionally checks retained snapshot/custom/bundle objects remotely; cached availability and remote verification stay distinct. Depth does not change the census boundary. Complete unfiltered registered-table pagination includes malformed physical rows. The report separates execution, coverage, inspection scope and severity, records a non-atomic observation interval and never declares unknown or unobserved scope healthy. Requests include actual retries; time includes waits; byte budget permits one admitted response overshoot, reported exactly. No adoption, repair, operation replay, garbage collection, merging, scripts, arbitrary websites or remote writes. Exit 0: completed/full/no error findings; 3: completed/full/error findings; 4: incomplete coverage; 75: paused/resumable; 1: execution failure; 2: invalid arguments.",
  ),
)

const resume = defineCommand(
  "resume",
  {
    run: Argument.String("run-id"),
    entry: singleton(
      "entry",
      "Optional exact entry assertion; the checkpoint's library/credential/rules identities cannot be changed",
    ),
    ...budgets,
    output,
  },
  (options) =>
    Effect.gen(function* () {
      const report = yield* resumeSharedAudit(options.run, {
        entry: Option.getOrUndefined(options.entry),
        budget: yield* budget(options),
      })
      yield* deliver(report, options.output)
    }),
).pipe(
  Command.withDescription(
    "Resume the exact local audit in a new process using only its run ID and optional new invocation budgets. Confirmed read observations and stable-ID tasks survive pauses within one large Skill; only changed objects are invalidated by the final census. Another credential/library/API origin or version, unsupported rules or a corrupt checkpoint is rejected before any request. Historical checkpoints without endpoint proof remain available offline but cannot resume. This never starts a replacement run silently. SIGINT preserves the latest confirmed checkpoint; a killed process can resume the last atomic checkpoint.",
  ),
)

const report = defineCommand(
  "report",
  {
    run: Argument.String("run-id"),
    entry: singleton(
      "entry",
      "Optional exact entry assertion, checked locally without contacting Notion",
    ),
    output,
  },
  (options) =>
    Effect.gen(function* () {
      yield* deliver(
        yield* reportSharedAudit(options.run, Option.getOrUndefined(options.entry)),
        options.output,
      )
    }),
).pipe(
  Command.withDescription(
    "Read one exact retained audit report entirely offline. No Notion/provider calls or credential refresh occur. Missing, wrong-scope, corrupt or unsupported-version checkpoints are errors. Reports preserve execution/coverage/severity independently, stable added/persistent/recovered findings and the original observation interval. Known v1 reports retain their original findings, while only current rules can resume. An offline historical report is not a new current health check.",
  ),
)

const list = defineCommand(
  "list",
  {
    entry: singleton("entry", "Optional exact library scope, checked entirely offline"),
    limit: singleton("limit", "Maximum returned run summaries from 1 to 1000; default 20"),
    output,
  },
  (options) =>
    Effect.gen(function* () {
      const limit = yield* Effect.try({
        try: () => integer(options.limit, "--limit"),
        catch: () => fail("INVALID_ARGUMENT", "Use a positive run-list limit from 1 to 1000."),
      })
      const result = yield* listSharedAudits({ entry: Option.getOrUndefined(options.entry), limit })
      const destination = Option.getOrUndefined(options.output)
      if (destination !== undefined)
        yield* (yield* Store).output(
          destination,
          new TextEncoder().encode(`${JSON.stringify(result, null, 2)}\n`),
        )
      yield* emit(result)
    }),
).pipe(
  Command.withDescription(
    "List retained local audit run IDs entirely offline, including interrupted runs without a final stdout receipt. Each summary names its rules version and whether those rules are current. Unreadable checkpoint IDs remain visible separately. This does not contact Notion or refresh old observations.",
  ),
)

export const libraryAuditCommand = defineCommand("audit").pipe(
  Command.withShortDescription(
    "Audit exact resources read-only with budgets, resume and offline reports",
  ),
  Command.withSubcommands([run, resume, report, list]),
)
