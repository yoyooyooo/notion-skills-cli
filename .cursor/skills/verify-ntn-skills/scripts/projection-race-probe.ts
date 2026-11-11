/** Real owned-page experiments. API-simulated edits are not human UI evidence. */
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { Effect, Fiber, Schema } from "effect"
import { live } from "../../../../packages/cli/src/command-runtime.ts"
import { decode, fail, property, SkillsError, text } from "../../../../packages/core/src/model.ts"
import { Notion } from "../../../../packages/core/src/notion.ts"
import { NOTION_API_VERSION } from "../../../../packages/core/src/notion-http.ts"
import { pageId } from "../../../../packages/core/src/ref.ts"
import { loadSharedLibrary } from "../../../../packages/core/src/shared-library.ts"
import {
  notionWriteCapabilities,
  requireSafeBodyReplacement,
} from "../../../../packages/core/src/shared-file-state.ts"

const scenarios = [
  "unprotected_replace",
  "single_match_rejected",
  "partial_batch",
  "full_body_match_with_append",
  "in_flight_editor",
  "client_response_loss",
  "edit_before_readback",
  "replacement_guard",
  "ui_lock_api_write",
] as const
const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const entry = option("--entry"),
  runInput = option("--run")
const selectedCase = option("--case")
if (selectedCase !== undefined && !scenarios.some((name) => name === selectedCase))
  throw Error("--case must name one listed probe scenario.")
const selectedCases = scenarios.filter(
  (name) => selectedCase === undefined || name === selectedCase,
)
const inspectOnly = args.includes("--inspect")
if (args.includes("--help") || (!args.includes("--live") && !inspectOnly)) {
  console.log(
    JSON.stringify(
      {
        mode: "plan",
        remote_writes: false,
        usage:
          "node projection-race-probe.ts --live --entry OWNED_TEST_LIBRARY --run NEW_ABSOLUTE_DIRECTORY",
        inspect: "node projection-race-probe.ts --inspect --run EXISTING_DIRECTORY",
        scenarios,
        scope_option:
          "Optional --case NAME runs only that scenario and reports all others not run.",
        contract:
          "Only freshly created, receipt-owned child pages may be mutated. An existing run is never replayed. Inspect only reads known original pages.",
        no_human_ui_claim: true,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}
if (!runInput || !isAbsolute(runInput) || (inspectOnly && args.includes("--live")))
  throw Error("Choose --live or --inspect and supply an absolute --run directory.")
if (!inspectOnly && (!entry || pageId(entry) !== entry))
  throw Error("Live mode requires one canonical --entry UUID for an owned verification library.")
const run = resolve(runInput)
process.env.NTN_SKILLS_REQUEST_TRACE_LIMIT = "10000"
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const save = (name: string, value: unknown, exclusive = true) =>
  writeFile(`${run}/${name}`, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: exclusive ? "wx" : "w",
  })
const PageReceiptSchema = Schema.Struct({
  id: Schema.String,
  parent_id: Schema.String,
  title: Schema.String,
  scenario: Schema.String,
})
const ReceiptSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("projection_race_probe"),
  entry: Schema.String,
  fixture_id: Schema.String,
  pages: Schema.Array(PageReceiptSchema),
})
const MarkdownSchema = Schema.Struct({
  id: Schema.String,
  markdown: Schema.String,
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(Schema.String),
})
const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) => (error instanceof SkillsError ? error : fail("PROBE_INVALID", String(error))),
  })
function body(value: unknown, expected: string) {
  const result = decode(MarkdownSchema, value)
  if (pageId(result.id) !== expected || result.truncated || result.unknown_block_ids.length > 0)
    throw fail("BODY_INCOMPLETE", "The probe requires a complete exact page response.")
  return { ...result, sha256: hash(result.markdown), bytes: Buffer.byteLength(result.markdown) }
}
function verifyPage(value: unknown, receipt: typeof PageReceiptSchema.Type) {
  const row = property(value)
  const title = Object.values(property(row.properties))
    .map(property)
    .find((field) => field.type === "title")
  if (
    pageId(String(row.id)) !== receipt.id ||
    row.in_trash === true ||
    property(row.parent).page_id !== receipt.parent_id ||
    text(title?.title) !== receipt.title
  )
    throw fail("FIXTURE_SCOPE", "The exact owned page identity or original parent changed.")
}

if (inspectOnly) {
  const receipt = decode(ReceiptSchema, JSON.parse(await readFile(`${run}/receipt.json`, "utf8")))
  const observations = await Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* Notion
      const pages = []
      for (const page of receipt.pages) {
        const metadata = yield* api.request(`v1/pages/${page.id}`)
        yield* checked(() => verifyPage(metadata, page))
        const observed = yield* api.request(`v1/pages/${page.id}/markdown?markdown_version=v2`)
        pages.push({ receipt: page, metadata, body: yield* checked(() => body(observed, page.id)) })
      }
      return {
        mode: "inspect",
        remote_writes: 0,
        fixture_id: receipt.fixture_id,
        pages,
        request_metrics: api.requestMetrics?.(),
      }
    }).pipe(Effect.provide(live)),
  )
  await save(`inspection-${randomUUID()}.json`, observations)
  console.log(
    JSON.stringify({
      ok: true,
      mode: "inspect",
      pages: observations.pages.length,
      remote_writes: 0,
      evidence: run,
    }),
  )
  process.exit(0)
}

await mkdir(run, { recursive: true, mode: 0o700 })
if ((await readdir(run)).length !== 0)
  throw Error("Live mode requires an empty new run. Use --inspect; do not replay original writes.")
const selectedEntry = entry
if (selectedEntry === undefined) throw Error("Missing exact entry.")
const fixtureId = randomUUID()
const pages: Array<typeof PageReceiptSchema.Type> = []
let pendingCreation: { parent_id: string; title: string; scenario: string } | null = null
let ordinal = 0
const outcomes: Array<Record<string, unknown>> = []
const persist = () =>
  save(
    "receipt.json",
    {
      version: 1,
      kind: "projection_race_probe",
      entry: selectedEntry,
      fixture_id: fixtureId,
      pages,
      pending_creation: pendingCreation,
    },
    false,
  )
await save("started.json", {
  fixture_id: fixtureId,
  entry: selectedEntry,
  started_at: new Date().toISOString(),
  api_version: NOTION_API_VERSION,
  markdown_version: "v2",
  node_version: process.version,
  source_hashes: {
    probe: hash(await readFile(new URL(import.meta.url), "utf8")),
    shared_file_state: hash(
      await readFile(
        new URL("../../../../packages/core/src/shared-file-state.ts", import.meta.url),
        "utf8",
      ),
    ),
  },
  scenarios: selectedCases,
  not_run: scenarios.filter((name) => !selectedCases.includes(name)),
  no_human_ui_claim: true,
})
await persist()

const program = Effect.gen(function* () {
  const api = yield* Notion
  const library = yield* loadSharedLibrary(selectedEntry)
  const parent = yield* api.request(`v1/pages/${library.parent_page_id}`)
  const parentRow = property(parent)
  if (pageId(String(parentRow.id)) !== library.parent_page_id || parentRow.in_trash === true)
    return yield* Effect.fail(
      fail("FIXTURE_SCOPE", "The selected verification parent is unavailable."),
    )
  yield* Effect.promise(() =>
    save("scope.json", {
      library,
      parent,
      api_version: NOTION_API_VERSION,
      title_is_not_ownership_proof: true,
      scope: "Read library only; create a fresh owned child container and its test pages.",
    }),
  )
  const owned = new Set<string>()
  const unresolved = new Set<string>()
  let container: string | undefined
  const send = (
    label: string,
    path: string,
    input?: unknown,
    options?: Parameters<Notion["Service"]["request"]>[2],
  ) =>
    Effect.gen(function* () {
      const method = options?.method ?? (input === undefined ? "GET" : "POST")
      const match = /^v1\/pages\/([^/]+)(?:\/markdown)?$/u.exec(path)
      const target = match?.[1]
      if (method === "POST") {
        const createParent = property(property(input).parent).page_id
        if (path !== "v1/pages" || createParent !== (container ?? library.parent_page_id))
          return yield* Effect.fail(
            fail("FIXTURE_SCOPE", "Only fresh child page creation is allowed."),
          )
      } else if (
        method !== "GET" &&
        (method !== "PATCH" || target === undefined || !owned.has(target) || unresolved.has(target))
      ) {
        return yield* Effect.fail(
          fail("FIXTURE_SCOPE", "No arbitrary or unresolved page write is allowed."),
        )
      }
      const number = ++ordinal
      const prefix = `${String(number).padStart(4, "0")}-${label.replace(/[^a-z0-9_-]/giu, "_")}`
      const started = Date.now()
      yield* Effect.promise(() =>
        save(`${prefix}-request.json`, {
          sequence: number,
          label,
          method,
          path,
          body: input ?? null,
          started_at: new Date(started).toISOString(),
          api_version: NOTION_API_VERSION,
        }),
      )
      const result = yield* api.request(path, input, options).pipe(Effect.result)
      const observation =
        result._tag === "Success"
          ? { kind: "success", response: result.success }
          : {
              kind: "failure",
              error: {
                code: result.failure.code,
                message: result.failure.message,
                details: result.failure.details,
              },
            }
      yield* Effect.promise(() =>
        save(`${prefix}-response.json`, {
          sequence: number,
          finished_at: new Date().toISOString(),
          elapsed_ms: Date.now() - started,
          ...observation,
        }),
      )
      if (result._tag === "Failure") {
        if (target !== undefined && result.failure.code === "WRITE_OUTCOME_UNKNOWN")
          unresolved.add(target)
        return yield* Effect.fail(result.failure)
      }
      return result.success
    })
  const create = (scenario: string, markdown: string) =>
    Effect.gen(function* () {
      const parentId = container ?? library.parent_page_id
      const title = `AH-687 ${fixtureId} ${scenario}`
      pendingCreation = { parent_id: parentId, title, scenario }
      yield* Effect.promise(persist)
      const response = yield* send(`${scenario}-create`, "v1/pages", {
        parent: { type: "page_id", page_id: parentId },
        properties: { title: { title: [{ type: "text", text: { content: title } }] } },
        markdown,
        markdown_version: "v2",
      })
      const id = pageId(String(property(response).id))
      if (id === undefined)
        return yield* Effect.fail(
          fail("WRITE_OUTCOME_UNKNOWN", "Creation did not return an exact page identity."),
        )
      const receipt = { id, parent_id: parentId, title, scenario }
      yield* checked(() => verifyPage(response, receipt))
      pages.push(receipt)
      owned.add(id)
      pendingCreation = null
      yield* Effect.promise(persist)
      const readback = yield* send(`${scenario}-identity`, `v1/pages/${id}`)
      yield* checked(() => verifyPage(readback, receipt))
      return id
    })
  const read = (id: string, label: string) =>
    send(label, `v1/pages/${id}/markdown?markdown_version=v2`).pipe(
      Effect.flatMap((raw) => checked(() => body(raw, id))),
    )
  const replace = (id: string, label: string, markdown: string) =>
    send(
      label,
      `v1/pages/${id}/markdown`,
      { markdown_version: "v2", type: "replace_content", replace_content: { new_str: markdown } },
      { method: "PATCH" },
    )
  const update = (
    id: string,
    label: string,
    changes: ReadonlyArray<{ old_str: string; new_str: string }>,
  ) =>
    send(
      label,
      `v1/pages/${id}/markdown`,
      {
        markdown_version: "v2",
        type: "update_content",
        update_content: { content_updates: changes },
      },
      { method: "PATCH" },
    )
  const brief = (
    result:
      | { readonly _tag: "Success"; readonly success: unknown }
      | { readonly _tag: "Failure"; readonly failure: SkillsError },
  ) =>
    result._tag === "Success"
      ? { kind: "success", response: result.success }
      : { kind: "failure", code: result.failure.code, details: result.failure.details }
  const caseRun = (
    name: (typeof scenarios)[number],
    action: Effect.Effect<Record<string, unknown>, SkillsError>,
  ) =>
    Effect.gen(function* () {
      if (!selectedCases.includes(name)) return
      console.log(JSON.stringify({ event: "case_started", case: name }))
      const firstRequest = ordinal + 1
      const result = yield* action.pipe(Effect.result)
      const row = {
        case: name,
        first_request: firstRequest,
        last_request: ordinal,
        ...(result._tag === "Success"
          ? { status: "observed", ...result.success }
          : { status: "incomplete", error: brief(result) }),
      }
      outcomes.push(row)
      yield* Effect.promise(() => save(`case-${name}.json`, row))
      yield* Effect.promise(() => save("request-metrics.json", api.requestMetrics?.(), false))
      console.log(JSON.stringify({ event: "case_finished", case: name, status: row.status }))
    })
  container = yield* create(
    "container",
    "# Owned Notion protection experiments\n\nSynthetic content only. Keep these pages with their original evidence receipts.\n",
  )
  // Punctuation-free markers survive the provider's Markdown escaping unchanged.
  const marker = fixtureId.replaceAll("-", "")
  const a = `NR687A${marker}`,
    b = `NR687B${marker}`,
    h = `NR687EDITOR${marker}`,
    c = `NR687C${marker}`,
    d = `NR687D${marker}`
  yield* caseRun(
    "unprotected_replace",
    Effect.gen(function* () {
      const page = yield* create("unprotected_replace", `${a}\n`)
      const before = yield* read(page, "replace-updater-read")
      yield* replace(page, "replace-editor", `${before.markdown}\n${h}\n`)
      const edited = yield* read(page, "replace-editor-readback")
      yield* replace(page, "replace-stale-updater", `${b}\n`)
      const after = yield* read(page, "replace-final-readback")
      return {
        page,
        before,
        edited,
        after,
        editor_was_observed: edited.markdown.includes(h),
        editor_content_lost: edited.markdown.includes(h) && !after.markdown.includes(h),
        expectation_met:
          edited.markdown.includes(h) && after.markdown.includes(b) && !after.markdown.includes(h),
        counterexample: "read A; editor appends H; unconditional replacement B discards H",
      }
    }),
  )
  yield* caseRun(
    "single_match_rejected",
    Effect.gen(function* () {
      const page = yield* create("single_match_rejected", `${a}\n`)
      yield* replace(page, "single-editor", `${h}\n`)
      const before = yield* read(page, "single-before-update")
      const attempt = yield* update(page, "single-stale-update", [{ old_str: a, new_str: b }]).pipe(
        Effect.result,
      )
      const after = yield* read(page, "single-final-readback")
      return {
        page,
        attempt: brief(attempt),
        before,
        after,
        rejected: attempt._tag === "Failure",
        editor_preserved: after.markdown === before.markdown,
        expectation_met: attempt._tag === "Failure" && after.markdown === before.markdown,
      }
    }),
  )
  yield* caseRun(
    "partial_batch",
    Effect.gen(function* () {
      const page = yield* create("partial_batch", `${a}\n\n${c}\n`)
      yield* update(page, "batch-editor", [{ old_str: a, new_str: h }])
      const before = yield* read(page, "batch-before-update")
      const attempt = yield* update(page, "batch-stale-update", [
        { old_str: a, new_str: b },
        { old_str: c, new_str: d },
      ]).pipe(Effect.result)
      const after = yield* read(page, "batch-final-readback")
      return {
        page,
        before,
        attempt: brief(attempt),
        after,
        partial_success:
          after.markdown.includes(h) && after.markdown.includes(d) && !after.markdown.includes(b),
        warnings: attempt._tag === "Success" ? (property(attempt.success).warnings ?? null) : null,
        expectation_met:
          attempt._tag === "Success" &&
          after.markdown.includes(h) &&
          after.markdown.includes(d) &&
          !after.markdown.includes(b),
      }
    }),
  )
  yield* caseRun(
    "full_body_match_with_append",
    Effect.gen(function* () {
      const page = yield* create("full_body_match_with_append", `${a}\n`)
      const before = yield* read(page, "append-updater-read")
      yield* replace(page, "append-editor", `${before.markdown}\n${h}\n`)
      const edited = yield* read(page, "append-editor-readback")
      const attempt = yield* update(page, "append-full-body-update", [
        { old_str: before.markdown, new_str: `${b}\n` },
      ]).pipe(Effect.result)
      const after = yield* read(page, "append-final-readback")
      return {
        page,
        before,
        edited,
        attempt: brief(attempt),
        after,
        editor_preserved: after.markdown.includes(h),
        whole_page_differs_from_candidate: after.markdown.trim() !== b,
        observed_substring_replacement: after.markdown.includes(b) && after.markdown.includes(h),
        expectation_met:
          attempt._tag === "Success" && after.markdown.includes(b) && after.markdown.includes(h),
      }
    }),
  )
  yield* caseRun(
    "in_flight_editor",
    Effect.gen(function* () {
      const page = yield* create("in_flight_editor", `${a}\n`)
      // A larger valid response gives the next rate-limited request a real overlap
      // window without bypassing the product scheduler or delaying HTTP in a fake server.
      const candidate = Array.from(
        { length: 24 },
        (_, index) => `${b} paragraph ${index} ${"probe ".repeat(250)}`,
      ).join("\n\n")
      const updater = yield* Effect.forkChild(
        replace(page, "inflight-updater", candidate).pipe(Effect.result),
        { startImmediately: true },
      )
      for (let step = 0; step < 200 && (api.requestMetrics?.().in_flight ?? 0) === 0; step++)
        yield* Effect.sleep("10 millis")
      const inFlightAtEditorInvocation = api.requestMetrics?.().in_flight ?? 0
      const editor = yield* replace(page, "inflight-editor", `${h}\n`).pipe(Effect.result)
      const updated = yield* Fiber.join(updater)
      const after = yield* read(page, "inflight-final-readback")
      const attempts = (api.requestMetrics?.().trace ?? []).filter(
        (event) =>
          event.event === "attempt" &&
          event.method === "PATCH" &&
          event.kind === "notion_write" &&
          event.target !== null &&
          "page_id" in event.target &&
          event.target.page_id === page,
      )
      const first = attempts[0],
        second = attempts[1]
      const overlaps =
        first?.event === "attempt" &&
        second?.event === "attempt" &&
        first.started_ms < second.started_ms + second.duration_ms &&
        second.started_ms < first.started_ms + first.duration_ms
      return {
        page,
        updater: brief(updated),
        editor: brief(editor),
        after,
        in_flight_at_editor_invocation: inFlightAtEditorInvocation,
        actual_http_attempts: attempts,
        actual_http_attempt_overlap: overlaps,
        expectation_met: overlaps,
        candidate_bytes: Buffer.byteLength(candidate),
        claims_server_commit_order: false,
        overlap_evidence:
          "Use actual attempt started_ms/duration_ms in request-metrics.json; client invocation alone is not a server ordering proof.",
      }
    }),
  )
  yield* caseRun(
    "client_response_loss",
    Effect.gen(function* () {
      const page = yield* create("client_response_loss", `${a}\n`)
      const operation = `probe-lost-response-${fixtureId}`
      const injected = {
        code: "WRITE_OUTCOME_UNKNOWN",
        operation_id: operation,
        fault: "client discards the already received success; not a genuine service disconnect",
      }
      let received = false
      const clientResult = yield* replace(page, "lost-response-updater-received", `${b}\n`).pipe(
        Effect.flatMap(() => {
          received = true
          return Effect.fail(
            fail("WRITE_OUTCOME_UNKNOWN", "Probe discarded the received success.", injected),
          )
        }),
        Effect.result,
      )
      if (!received && clientResult._tag === "Failure")
        return yield* Effect.fail(clientResult.failure)
      yield* Effect.promise(() => save("lost-response-injection.json", injected))
      yield* replace(page, "lost-response-editor", `${h}\n`)
      const writesBeforeRecovery = api.requestMetrics?.().requests.notion_write
      const recovered = yield* read(page, "lost-response-read-only-recovery")
      return {
        page,
        injected,
        client_result: brief(clientResult),
        recovered,
        original_write_invocations: 1,
        recovery_write_delta:
          (api.requestMetrics?.().requests.notion_write ?? 0) - (writesBeforeRecovery ?? 0),
        editor_preserved: recovered.markdown.includes(h),
        expectation_met:
          clientResult._tag === "Failure" &&
          recovered.markdown.includes(h) &&
          api.requestMetrics?.().requests.notion_write === writesBeforeRecovery,
        recovery_kind:
          "diagnostic readback only; does not prove the product operation-journal recovery path",
      }
    }),
  )
  yield* caseRun(
    "edit_before_readback",
    Effect.gen(function* () {
      const page = yield* create("edit_before_readback", `${a}\n`)
      const response = yield* replace(page, "before-readback-updater", `${b}\n`)
      yield* replace(page, "before-readback-editor", `${h}\n`)
      const after = yield* read(page, "before-readback-final")
      return {
        page,
        updater_response: response,
        after,
        candidate_still_current: after.markdown.trim() === b,
        editor_preserved: after.markdown.includes(h),
        automatic_repair_attempts: 0,
        expectation_met: after.markdown.includes(h) && after.markdown.trim() !== b,
      }
    }),
  )
  yield* caseRun(
    "replacement_guard",
    Effect.gen(function* () {
      const page = yield* create("replacement_guard", `${a}\n`)
      const authorized = yield* read(page, "guard-before-authorization")
      yield* replace(page, "guard-editor-after-authorization", `${h}\n`)
      const before = api.requestMetrics?.().requests.notion_write ?? 0
      const guarded = yield* checked(() =>
        requireSafeBodyReplacement({
          existing_editable_page: true,
          operation_id: `probe-guard-${fixtureId}`,
          retained_candidate_id: `probe-candidate-${fixtureId}`,
        }),
      ).pipe(Effect.result)
      if (guarded._tag === "Success")
        yield* replace(page, "guard-unexpectedly-authorized", `${b}\n`)
      const afterGuard = api.requestMetrics?.().requests.notion_write ?? 0
      const after = yield* read(page, "guard-final-readback")
      return {
        page,
        authorized,
        guard: brief(guarded),
        after,
        guarded_write_attempts: afterGuard - before,
        editor_preserved: after.markdown.includes(h),
        capabilities: notionWriteCapabilities,
        production_helper_only: true,
        production_writer_path_exercised: false,
        expectation_met:
          guarded._tag === "Failure" &&
          guarded.failure.code === "BODY_REPLACEMENT_UNSAFE" &&
          afterGuard === before &&
          after.markdown.includes(h),
      }
    }),
  )
  yield* caseRun(
    "ui_lock_api_write",
    Effect.gen(function* () {
      const page = yield* create("ui_lock_api_write", `${a}\n`)
      yield* send("lock-enable", `v1/pages/${page}`, { is_locked: true }, { method: "PATCH" })
      const locked = yield* send("lock-readback", `v1/pages/${page}`)
      const attempt = yield* replace(page, "locked-api-editor", `${h}\n`).pipe(Effect.result)
      const after = yield* read(page, "lock-final-body")
      return {
        page,
        locked: property(locked).is_locked,
        attempt: brief(attempt),
        after,
        api_write_accepted_while_ui_locked:
          attempt._tag === "Success" && after.markdown.includes(h),
        ui_edit_isolation_not_proven: true,
        expectation_met:
          property(locked).is_locked === true &&
          attempt._tag === "Success" &&
          after.markdown.includes(h),
      }
    }),
  )
  yield* Effect.promise(() => save("request-metrics.json", api.requestMetrics?.(), false))
  return {
    kind: "real_notion_projection_race_probe",
    fixture_id: fixtureId,
    entry: selectedEntry,
    container_page_id: container,
    api_version: NOTION_API_VERSION,
    markdown_version: "v2",
    complete:
      outcomes.length === selectedCases.length &&
      outcomes.every((row) => row.status === "observed"),
    expected_observations_match:
      outcomes.length === selectedCases.length &&
      outcomes.every((row) => row.expectation_met === true),
    requested_cases: selectedCases,
    not_run: scenarios.filter((name) => !selectedCases.includes(name)),
    no_human_ui_claim: true,
    no_atomicity_proof: true,
    no_second_machine_claim: true,
    automatic_editable_overwrite_supported: false,
    cases: outcomes,
    unresolved_page_ids: [...unresolved],
    request_metrics: api.requestMetrics?.(),
    actual_attempts:
      "request-metrics.json contains HTTP statuses and request IDs; numbered files retain project-engine invocations and decoded responses without credentials.",
  }
})
try {
  const result = await Effect.runPromise(program.pipe(Effect.provide(live)))
  await save("summary.json", result)
  console.log(
    JSON.stringify({
      ok: true,
      complete: result.complete,
      expected_observations_match: result.expected_observations_match,
      cases: result.cases.length,
      evidence: run,
      no_human_ui_claim: true,
      automatic_editable_overwrite_supported: false,
    }),
  )
  if (!result.complete || !result.expected_observations_match) process.exitCode = 1
} catch (error) {
  await save("failure.json", {
    error: String(error),
    pending_creation: pendingCreation,
    known_pages: pages,
    completed_cases: outcomes,
  })
  process.exitCode = 1
  console.error(
    JSON.stringify({
      ok: false,
      evidence: run,
      error: String(error),
      next: "Inspect this original run. Do not retry its mutations.",
    }),
  )
}
