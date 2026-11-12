import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { HttpClient, HttpClientResponse } from "effect/http"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import {
  processSharedFileRequest,
  readSharedFileRequest,
  submitSharedFileRequest,
} from "../src/shared-file-request.ts"
import {
  fileRequestProperty,
  fileRequestResultProperty,
  fileRequestReceiptProperty,
} from "../src/shared-file-request-schema.ts"
import { reconcileSelectedSharedFileRestore } from "../src/shared-file-restore.ts"
import { readSharedFileIntentContext } from "../src/shared-file-intent.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { registerSourceBinding } from "../src/shared-source-binding.ts"
import {
  sharedSnapshotFixture,
  library as baseLibrary,
  id,
  skillPage,
  rich,
  encode,
} from "./shared-snapshot-fixture.ts"

const requestIds = {
  [fileRequestProperty]: "management_request",
  [fileRequestResultProperty]: "management_result",
  [fileRequestReceiptProperty]: "management_receipt",
}
const library = {
  ...baseLibrary,
  skills: {
    ...baseLibrary.skills,
    property_ids: { ...baseLibrary.skills.property_ids, ...requestIds },
  },
  files: {
    ...baseLibrary.files,
    property_ids: { ...baseLibrary.files.property_ids, ...requestIds },
  },
}
async function fixture(options: { sameBody?: boolean; main?: boolean; submitted?: boolean } = {}) {
  const files = [
    {
      path: "SKILL.md",
      bytes: encode("---\nname: fixed\ndescription: fixed description\n---\n\n# Fixed main\n"),
    },
    { path: "references/1.md", bytes: encode("Fixed guide\n") },
    { path: "references/2.md", bytes: encode("Other fixed guide\n") },
  ]
  let onDownload: (() => void) | undefined
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const hook = onDownload
      onDownload = undefined
      hook?.()
      const match = files.find((file) => url.pathname.endsWith("/" + file.path))
      return HttpClientResponse.fromWeb(
        request,
        match === undefined
          ? new Response(null, { status: 404 })
          : new Response(match.bytes.slice(), {
              headers: { "content-length": String(match.bytes.length) },
            }),
      )
    }),
  )
  const f = sharedSnapshotFixture({ httpClient: client })
  const targetPage = options.main ? skillPage : id(11),
    path = options.main ? "SKILL.md" : "references/1.md"
  if (options.sameBody !== false)
    f.bodies.set(targetPage, options.main ? "# Fixed main" : "Fixed guide")
  for (const row of [f.main, ...f.files]) {
    const fields = property(row.properties)
    fields.management_request = {
      id: "management_request",
      type: "select",
      select: { name: "none" },
    }
    fields.management_result = rich("management_result", "")
    fields.management_receipt = rich("management_receipt", "")
  }
  const target = targetPage === skillPage ? f.main : f.files[0]!
  const intent = (value: "none" | "restore-follow") => {
    property(target.properties).management_request = {
      id: "management_request",
      type: "select",
      select: { name: value },
    }
  }
  const hooks: {
    feedback?: (status: string) => SkillsError | void
    record?: (kind: string, payload: Record<string, unknown>) => void
    beforeRequest?: (path: string, method: string, body: unknown) => SkillsError | void
  } = {}
  const run: typeof f.run = (effect) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const controlled: Notion["Service"] = {
          ...api,
          request: (requestPath, body, options) =>
            Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
              const method = options?.method ?? (body === undefined ? "GET" : "POST")
              const interrupted = hooks.beforeRequest?.(requestPath, method, body)
              if (interrupted !== undefined) return Effect.fail(interrupted)
              if (requestPath === `v1/databases/${library.skills.database_id}`)
                return api.request(requestPath, body, options).pipe(
                  Effect.map((value) => ({
                    ...property(value),
                    description: [
                      { plain_text: "ntn-skills-library:v1 " + JSON.stringify(library) },
                    ],
                  })),
                )
              const markdown = /^v1\/pages\/([^/]+)\/markdown$/u.exec(requestPath)
              if (markdown !== null && method === "PATCH") {
                f.calls.push({ path: requestPath, method, body })
                const page = markdown[1]!,
                  current = f.bodies.get(page),
                  updates = property(property(body).update_content).content_updates
                const change =
                  Array.isArray(updates) && updates.length === 1 ? property(updates[0]) : {}
                if (
                  current === undefined ||
                  typeof change.old_str !== "string" ||
                  !change.old_str ||
                  typeof change.new_str !== "string" ||
                  current.split(change.old_str).length !== 2
                )
                  return Effect.fail(
                    fail("TEST_REQUEST_MATCH", "Expected one complete body match."),
                  )
                const changed = current.replace(change.old_str, change.new_str)
                f.bodies.set(page, changed)
                return Effect.succeed({
                  id: page,
                  markdown: changed,
                  truncated: false,
                  unknown_block_ids: [],
                })
              }
              const row = [f.main, ...f.files].find((page) => requestPath === `v1/pages/${page.id}`)
              if (row !== undefined && method === "PATCH") {
                f.calls.push({ path: requestPath, method, body })
                const fields = property(property(body).properties)
                if (
                  Object.keys(fields).some(
                    (key) =>
                      !["management_result", "management_receipt", "management_request"].includes(
                        key,
                      ),
                  ) ||
                  fields.management_result === undefined ||
                  fields.management_receipt === undefined
                )
                  return Effect.fail(
                    fail(
                      "TEST_REQUEST_WRITER",
                      "Only request intent, result and receipt properties may be patched.",
                    ),
                  )
                const value = text(property(fields.management_receipt).rich_text)
                const summary = text(property(fields.management_result).rich_text)
                expect(summary.startsWith("{")).toBe(false)
                property(row.properties).management_result = rich("management_result", summary)
                property(row.properties).management_receipt = rich("management_receipt", value)
                if (fields.management_request !== undefined) {
                  expect(property(fields.management_request).select).toEqual({
                    name: "restore-follow",
                  })
                  intent("restore-follow")
                }
                const interrupted = hooks.feedback?.(String(property(JSON.parse(value)).status))
                if (interrupted !== undefined) return Effect.fail(interrupted)
                return Effect.succeed(structuredClone(row))
              }
              return api.request(requestPath, body, options).pipe(
                Effect.tap(() => {
                  if (requestPath === "v1/pages" && method === "POST")
                    hooks.record?.(
                      String(
                        property(property(property(property(body).properties).kind).select).name,
                      ),
                      property(
                        property(
                          JSON.parse(
                            text(property(property(property(body).properties).payload).rich_text),
                          ),
                        ).payload,
                      ),
                    )
                  return Effect.void
                }),
              )
            }),
        }
        return yield* effect.pipe(Effect.provideService(Notion, controlled))
      }),
    )
  await f.open()
  const fixed = {
    url: "https://github.com/example/file-request",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    root: "",
    files: files.map((file) => ({
      path: file.path,
      source_path: file.path,
      bytes: file.bytes.length,
      git_oid: createHash("sha1")
        .update(`blob ${file.bytes.length}\0`)
        .update(file.bytes)
        .digest("hex"),
    })),
  }
  const registered = await run(
    registerSourceBinding(library, { skillPageId: skillPage, mode: "create", fixedSource: fixed }),
  )
  property(f.main.properties).source = rich("source", registered.binding.source_id)
  const input = { library, skillPageId: skillPage, path }
  if (options.submitted === false) intent("restore-follow")
  else await run(submitSharedFileRequest(input))
  f.clearCalls()
  const state = () => run(readSharedFileIntentContext(input))
  return {
    ...f,
    run,
    input,
    target,
    targetPage,
    intent,
    hooks,
    state,
    onDownload: (hook: () => void) => {
      onDownload = hook
    },
    mutations: () => f.calls.filter((call) => call.method === "PATCH" || call.path === "v1/pages"),
    bodyWrites: () =>
      f.calls.filter((call) => call.method === "PATCH" && call.path.includes("/markdown")),
  }
}

describe("native file restore requests", () => {
  test.each([false, true])(
    "the exact main/supporting request (%s) restores identical bytes without clearing user intent",
    async (main) => {
      const f = await fixture({ main })
      const other = JSON.stringify(f.files[1]),
        body = f.bodies.get(f.targetPage),
        before = f.records.size
      const pending = await f.run(readSharedFileRequest(f.input))
      expect(pending.status).toBe("submitted")
      expect(pending.request.file_id).toBe(main ? "file-main" : "file-1")
      expect(pending.ownership.kind).toBe("custom")
      const preview = await f.run(processSharedFileRequest({ ...f.input, dryRun: true }))
      expect(preview.status).toBe("planned")
      expect(f.mutations()).toHaveLength(0)
      const result = await f.run(processSharedFileRequest(f.input))
      expect(result.status).toBe("verified_applied")
      expect((await f.state()).state?.ownership.kind).toBe("following")
      expect(f.bodies.get(f.targetPage)).toBe(body)
      expect(f.bodyWrites()).toHaveLength(0)
      expect(f.records.size).toBeGreaterThan(before)
      expect(property(property(f.target.properties).management_request).select).toEqual({
        name: "restore-follow",
      })
      expect(JSON.stringify(f.files[1])).toBe(other)
      expect((await f.run(readSharedFileRequest(f.input))).status).toBe("verified_applied")
      const records = f.records.size
      f.clearCalls()
      expect((await f.run(processSharedFileRequest(f.input))).status).toBe("verified_applied")
      expect(f.mutations()).toHaveLength(0)
      expect(f.records.size).toBe(records)
    },
  )

  test("an unsubmitted dropdown cannot authorize different custom bytes; repeated feedback is idempotent", async () => {
    const f = await fixture({ sameBody: false, submitted: false }),
      body = f.bodies.get(id(11)),
      count = f.records.size
    expect((await f.run(processSharedFileRequest({ ...f.input, dryRun: true }))).status).toBe(
      "blocked",
    )
    expect(f.mutations()).toHaveLength(0)
    const result = await f.run(processSharedFileRequest(f.input))
    expect(result.status).toBe("blocked")
    expect((await f.run(readSharedFileRequest(f.input))).status).toBe("blocked")
    expect((await f.state()).state?.ownership.kind).toBe("custom")
    expect(f.bodies.get(id(11))).toBe(body)
    expect(f.records.size).toBe(count)
    expect(f.bodyWrites()).toHaveLength(0)
    f.clearCalls()
    await f.run(processSharedFileRequest(f.input))
    expect(f.mutations()).toHaveLength(0)
  })

  test("explicit submission restores a different body and repeats without another write", async () => {
    const f = await fixture({ sameBody: false, submitted: false })
    f.intent("none")
    expect((await f.run(submitSharedFileRequest({ ...f.input, dryRun: true }))).status).toBe(
      "planned",
    )
    expect(f.mutations()).toHaveLength(0)
    const submitted = await f.run(submitSharedFileRequest(f.input))
    expect(submitted.status).toBe("submitted")
    if (!("feedback" in submitted) || submitted.feedback === undefined)
      throw new Error("Expected the submitted request receipt")
    f.clearCalls()
    const repeated = await f.run(submitSharedFileRequest(f.input))
    expect("unchanged" in repeated && repeated.unchanged).toBe(true)
    expect(f.mutations()).toHaveLength(0)
    const result = await f.run(processSharedFileRequest(f.input))
    expect(result.status).toBe("verified_applied")
    expect((await f.state()).state?.ownership.kind).toBe("following")
    expect(f.bodies.get(f.targetPage)).toBe("Fixed guide")
    expect(f.bodyWrites()).toHaveLength(1)
    expect((await f.run(readSharedFileRequest(f.input))).request_id).toBe(
      submitted.feedback.request_id,
    )
    f.clearCalls()
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("verified_applied")
    expect(f.mutations()).toHaveLength(0)
  })

  test("reconciliation preserves a later unadopted edit without publishing restored feedback", async () => {
    const f = await fixture({ sameBody: false })
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("verified_applied")
    const receipt = text(property(property(f.target.properties).management_receipt).rich_text)
    const count = f.records.size
    f.bodies.set(f.targetPage, "N2 edited after restoration\n")
    f.clearCalls()
    const result = await f.run(processSharedFileRequest({ ...f.input, reconcile: true }))
    expect(result.status).toBe("needs_review")
    expect(f.bodies.get(f.targetPage)).toBe("N2 edited after restoration\n")
    expect(text(property(property(f.target.properties).management_receipt).rich_text)).toBe(receipt)
    expect(f.mutations()).toHaveLength(0)
    expect(f.records.size).toBe(count)
  })

  test("a new edit adopted before processing cannot silently replace the submitted body or frontier", async () => {
    const f = await fixture({ sameBody: false })
    const submitted = await f.run(readSharedFileRequest(f.input))
    f.bodies.set(f.targetPage, "N2 edited after submission\n")
    await f.run(
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: skillPage,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
        })
      }),
    )
    f.clearCalls()
    expect((await f.run(readSharedFileRequest(f.input))).status).toBe("needs_review")
    const result = await f.run(processSharedFileRequest(f.input))
    expect(result.status).toBe("blocked")
    expect("feedback" in result && result.feedback?.code).toBe("SHARED_FILE_REQUEST_CHANGED")
    expect(f.bodies.get(f.targetPage)).toBe("N2 edited after submission\n")
    expect(f.bodyWrites()).toHaveLength(0)
    expect((await f.state()).state?.ownership.kind).toBe("custom")
    expect((await f.run(readSharedFileRequest(f.input))).request_id).toBe(submitted.request_id)
    const renewed = await f.run(submitSharedFileRequest(f.input))
    expect(renewed.status).toBe("submitted")
    if (!("feedback" in renewed) || renewed.feedback === undefined)
      throw new Error("Expected the newly submitted request receipt")
    expect(renewed.feedback.request_id).not.toBe(submitted.request_id)
  })

  test("Status alone cannot submit a request or release customization", async () => {
    const f = await fixture()
    f.intent("none")
    property(f.target.properties).status = {
      id: "status",
      type: "select",
      select: { name: "following" },
    }
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("no_request")
    expect((await f.state()).state?.ownership.kind).toBe("custom")
    expect(f.mutations()).toHaveLength(0)
  })

  test("canceling during fixed-source acquisition stops before processing or ownership writes", async () => {
    const f = await fixture(),
      count = f.records.size
    f.onDownload(() => f.intent("none"))
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("needs_review")
    expect((await f.run(readSharedFileRequest(f.input))).status).toBe("no_request")
    expect(f.records.size).toBe(count)
    expect(f.mutations()).toHaveLength(0)
  })

  test("a late body edit after processing feedback remains custom and is never overwritten", async () => {
    const f = await fixture(),
      count = f.records.size
    f.hooks.feedback = (status) => {
      if (status === "processing") f.bodies.set(id(11), "Late human version\n")
    }
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("unknown")
    expect(f.bodies.get(id(11))).toBe("Late human version\n")
    expect((await f.state()).state?.ownership.kind).toBe("custom")
    expect(f.records.size).toBeGreaterThan(count)
    expect(f.bodyWrites()).toHaveLength(0)
    f.hooks.feedback = undefined
    const reconciled = await f.run(processSharedFileRequest({ ...f.input, reconcile: true }))
    expect(reconciled.status).toBe("blocked")
    expect("feedback" in reconciled && reconciled.feedback?.code).toBe("ORIGINAL_NOT_APPLIED")
    expect((await f.run(submitSharedFileRequest(f.input))).status).toBe("submitted")
    expect(f.bodies.get(id(11))).toBe("Late human version\n")
    expect(f.bodyWrites()).toHaveLength(0)
  })

  test("canceling after the original plan dispatch records a no-send outcome and reconciliation releases only its local barrier", async () => {
    const f = await fixture()
    f.hooks.record = (kind) => {
      if (kind === "operation") f.intent("none")
    }
    const result = await f.run(processSharedFileRequest(f.input))
    expect(result.status).toBe("unknown")
    expect((await f.state()).state?.ownership.kind).toBe("custom")
    expect(f.bodyWrites()).toHaveLength(0)
    const receipt = property(
      JSON.parse(text(property(property(f.target.properties).management_receipt).rich_text)),
    )
    expect(typeof receipt.original_operation_id).toBe("string")
    const original = await f.run(
      reconcileSelectedSharedFileRestore({
        ...f.input,
        operationId: String(receipt.original_operation_id),
      }),
    )
    expect(original.status).toBe("not_applied")
    f.hooks.record = undefined
    expect((await f.run(submitSharedFileRequest(f.input))).status).toBe("submitted")
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("verified_applied")
  })

  test("an unknown accepted ownership event is exposed as unknown and cannot be replayed or inferred from current text", async () => {
    const f = await fixture()
    f.unknownEvent()
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("unknown")
    expect((await f.run(readSharedFileRequest(f.input))).status).toBe("unknown")
    const count = f.records.size
    f.clearCalls()
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("unknown")
    await expect(
      f.run(processSharedFileRequest({ ...f.input, reconcile: true })),
    ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_UNRESOLVED" })
    expect(f.mutations()).toHaveLength(0)
    expect(f.records.size).toBe(count)
  })

  test("the exact dispatch operation is durable and read back before the first body write", async () => {
    const f = await fixture({ sameBody: false })
    let readBack = false
    const receipt = () =>
      property(
        JSON.parse(text(property(property(f.target.properties).management_receipt).rich_text)),
      )
    f.hooks.beforeRequest = (path, method) => {
      if (
        path === `v1/pages/${f.targetPage}` &&
        method === "GET" &&
        typeof receipt().original_operation_id === "string"
      )
        readBack = true
      if (path === `v1/pages/${f.targetPage}/markdown` && method === "PATCH") {
        expect(readBack).toBe(true)
        const plan = [...f.records.values()]
          .map(
            (row) =>
              property(JSON.parse(text(property(property(row.properties).payload).rich_text)))
                .payload,
          )
          .map(property)
          .find((value) => value.kind === "body_write")
        expect(plan?.operation_id).toBe(receipt().original_operation_id)
        expect(receipt().status).toBe("processing")
      }
    }
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("verified_applied")
    expect(f.bodyWrites()).toHaveLength(1)
  })

  test("budget exhaustion after original completion keeps an ID for feedback-only reconciliation", async () => {
    const f = await fixture({ sameBody: false })
    let paused = false
    f.hooks.record = (_kind, payload) => {
      if (payload.kind === "body_write_outcome" && payload.status === "applied") paused = true
    }
    f.hooks.beforeRequest = () =>
      paused
        ? fail("REQUEST_BUDGET_EXHAUSTED", "Stopped after the original applied outcome.")
        : undefined
    await expect(f.run(processSharedFileRequest(f.input))).rejects.toMatchObject({
      code: "REQUEST_BUDGET_EXHAUSTED",
    })
    expect(f.bodyWrites()).toHaveLength(1)
    f.hooks.beforeRequest = undefined
    f.hooks.record = undefined
    const interrupted = await f.run(readSharedFileRequest(f.input))
    expect(interrupted.feedback?.status).toBe("processing")
    expect(typeof interrupted.feedback?.original_operation_id).toBe("string")
    const requestId = interrupted.request_id
    f.clearCalls()
    const recovered = await f.run(processSharedFileRequest({ ...f.input, reconcile: true }))
    expect(recovered.status).toBe("verified_applied")
    expect(f.bodyWrites()).toHaveLength(0)
    expect((await f.run(readSharedFileRequest(f.input))).request_id).toBe(requestId)
    f.clearCalls()
    expect((await f.run(processSharedFileRequest({ ...f.input, reconcile: true }))).status).toBe(
      "verified_applied",
    )
    expect(f.mutations()).toHaveLength(0)
  })

  test("a verified feedback ACK remains historical when the body changes before its readback", async () => {
    const f = await fixture({ sameBody: false })
    f.hooks.feedback = (status) => {
      if (status === "verified_applied") f.bodies.set(f.targetPage, "A later human edit\n")
    }
    const result = await f.run(Effect.result(processSharedFileRequest(f.input)))
    expect(result).toMatchObject({
      _tag: "Success",
      success: {
        status: "needs_review",
        code: "SHARED_FILE_REQUEST_CHANGED",
        feedback: { status: "verified_applied" },
        body_writes: 0,
      },
    })
    expect(f.bodyWrites()).toHaveLength(1)
    expect(f.bodies.get(f.targetPage)).toBe("A later human edit\n")
    const original = await f.run(readSharedFileRequest(f.input))
    expect(original.feedback?.status).toBe("verified_applied")
    expect(typeof original.feedback?.original_operation_id).toBe("string")
    const acks = () => [...f.json].filter(([key]) => key.includes("/source-ack-"))
    const retainedAcks = structuredClone(acks())
    expect(retainedAcks.length).toBeGreaterThan(0)
    f.hooks.feedback = undefined
    f.clearCalls()
    expect((await f.run(processSharedFileRequest({ ...f.input, reconcile: true }))).status).toBe(
      "needs_review",
    )
    expect(f.mutations()).toHaveLength(0)
    expect(f.bodyWrites()).toHaveLength(0)
    expect(f.bodies.get(f.targetPage)).toBe("A later human edit\n")
    expect(acks()).toEqual(retainedAcks)
    expect((await f.run(readSharedFileRequest(f.input))).feedback?.original_operation_id).toBe(
      original.feedback?.original_operation_id,
    )
  })

  test("an explicit original operation repairs only a matching legacy processing receipt", async () => {
    const f = await fixture({ sameBody: false })
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("verified_applied")
    const complete = await f.run(readSharedFileRequest(f.input))
    const operationId = complete.feedback?.original_operation_id
    if (typeof operationId !== "string" || !complete.feedback)
      throw new Error("Missing original operation")
    const legacy = {
      ...complete.feedback,
      status: "processing",
      code: "SUBMITTED_REQUEST_REVALIDATION",
      original_operation_id: null,
      after: undefined,
    }
    property(f.target.properties).management_receipt = rich(
      "management_receipt",
      JSON.stringify(legacy),
    )
    f.clearCalls()
    const preview = await f.run(
      processSharedFileRequest({ ...f.input, reconcile: true, operationId, dryRun: true }),
    )
    expect(preview.status).toBe("planned")
    expect(f.mutations()).toHaveLength(0)
    const result = await f.run(
      processSharedFileRequest({ ...f.input, reconcile: true, operationId }),
    )
    expect(result.status).toBe("verified_applied")
    expect("feedback" in result && result.feedback?.original_operation_id).toBe(operationId)
    expect((await f.run(readSharedFileRequest(f.input))).request_id).toBe(complete.request_id)
    expect(f.bodyWrites()).toHaveLength(0)
  })

  test("an interrupted binding readback preserves its retained plan and cannot dispatch or replace it", async () => {
    const f = await fixture({ sameBody: false })
    let paused = false
    f.hooks.feedback = (status) => {
      const receipt = property(
        JSON.parse(text(property(property(f.target.properties).management_receipt).rich_text)),
      )
      if (status === "processing" && typeof receipt.original_operation_id === "string")
        paused = true
    }
    f.hooks.beforeRequest = () =>
      paused
        ? fail("REQUEST_BUDGET_EXHAUSTED", "Interrupted before verifying the original-ID binding.")
        : undefined
    await expect(f.run(processSharedFileRequest(f.input))).rejects.toMatchObject({
      code: "REQUEST_BUDGET_EXHAUSTED",
    })
    expect(f.bodyWrites()).toHaveLength(0)
    f.hooks.feedback = undefined
    f.hooks.beforeRequest = undefined
    const observed = await f.run(readSharedFileRequest(f.input))
    expect(observed.feedback?.status).toBe("processing")
    expect(typeof observed.feedback?.original_operation_id).toBe("string")
    const count = f.records.size
    f.clearCalls()
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("processing")
    await expect(
      f.run(processSharedFileRequest({ ...f.input, reconcile: true })),
    ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_UNRESOLVED" })
    await expect(f.run(submitSharedFileRequest(f.input))).rejects.toMatchObject({
      code: "SHARED_BODY_WRITE_UNRESOLVED",
    })
    expect(f.records.size).toBe(count)
    expect(f.mutations()).toHaveLength(0)
  })

  test("a verified not-applied original exits processing only through explicit new submission", async () => {
    const f = await fixture({ sameBody: false })
    f.hooks.record = (_kind, payload) => {
      if (payload.kind === "body_write") f.intent("none")
    }
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("unknown")
    expect(f.bodyWrites()).toHaveLength(0)
    f.hooks.record = undefined
    f.intent("restore-follow")
    const original = (await f.run(readSharedFileRequest(f.input))).feedback?.original_operation_id
    const recovered = await f.run(processSharedFileRequest({ ...f.input, reconcile: true }))
    expect(recovered.status).toBe("blocked")
    expect("feedback" in recovered && recovered.feedback?.code).toBe("ORIGINAL_NOT_APPLIED")
    expect("feedback" in recovered && recovered.feedback?.original_operation_id).toBe(original)
    f.clearCalls()
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("blocked")
    expect(f.mutations()).toHaveLength(0)
    expect((await f.run(submitSharedFileRequest(f.input))).status).toBe("submitted")
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("verified_applied")
    expect(f.bodyWrites()).toHaveLength(1)
    expect((await f.run(readSharedFileRequest(f.input))).feedback?.original_operation_id).not.toBe(
      original,
    )
  })

  test("matching feedback fields do not prove an unknown metadata dispatch was acknowledged", async () => {
    const f = await fixture({ sameBody: false })
    f.hooks.feedback = (status) =>
      status === "processing"
        ? fail("WRITE_OUTCOME_UNKNOWN", "The accepted feedback response was lost.")
        : undefined
    await expect(f.run(processSharedFileRequest(f.input))).rejects.toMatchObject({
      code: "SOURCE_WRITE_PENDING",
    })
    expect(f.bodyWrites()).toHaveLength(0)
    f.hooks.feedback = undefined
    const observed = await f.run(readSharedFileRequest(f.input))
    const operationId = observed.feedback?.original_operation_id
    if (!operationId) throw new Error("Missing original restore binding")
    f.clearCalls()
    expect(
      (await f.run(reconcileSelectedSharedFileRestore({ ...f.input, operationId }))).status,
    ).toBe("not_applied")
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("processing")
    await expect(
      f.run(processSharedFileRequest({ ...f.input, reconcile: true })),
    ).rejects.toMatchObject({ code: "SOURCE_WRITE_PENDING" })
    expect(f.mutations()).toHaveLength(0)
  })

  test.each(["identity", "body", "frontier", "source", "revision", "submission"])(
    "a legacy explicit operation rejects a changed %s without feedback or body writes",
    async (changed) => {
      const f = await fixture({ sameBody: false })
      expect((await f.run(processSharedFileRequest(f.input))).status).toBe("verified_applied")
      const observed = await f.run(readSharedFileRequest(f.input))
      const original = observed.feedback?.original_operation_id
      if (!original || !observed.feedback?.submitted) throw new Error("Missing original restore")
      const legacy = property(
        JSON.parse(
          JSON.stringify({
            ...observed.feedback,
            status: "processing",
            original_operation_id: null,
            after: undefined,
          }),
        ),
      )
      const before = property(legacy.before),
        submitted = property(legacy.submitted)
      if (changed === "identity") before.file_id = submitted.file_id = "other-file"
      if (changed === "body") {
        property(before.body).sha256 = property(submitted.body).sha256 = "0".repeat(64)
        before.bytes = submitted.bytes = 1
      }
      if (changed === "frontier") before.heads = submitted.heads = ["another-parent"]
      if (changed === "source")
        property(before.source).selected_version = property(submitted.source).selected_version =
          "source-other"
      if (changed === "revision") property(legacy.source).revision = "b".repeat(40)
      if (changed === "submission") submitted.heads = ["another-submission-parent"]
      legacy.request_id =
        "file-request-" + createHash("sha256").update(canonicalSharedJson(submitted)).digest("hex")
      property(f.target.properties).management_receipt = rich(
        "management_receipt",
        JSON.stringify(legacy),
      )
      f.clearCalls()
      await expect(
        f.run(processSharedFileRequest({ ...f.input, reconcile: true, operationId: original })),
      ).rejects.toMatchObject({ code: "SHARED_FILE_REQUEST_ORIGINAL_SCOPE" })
      expect(f.mutations()).toHaveLength(0)
    },
  )

  test("a legacy ID cannot manufacture a missing original outcome from matching current bytes", async () => {
    const f = await fixture({ sameBody: false })
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("verified_applied")
    const observed = await f.run(readSharedFileRequest(f.input))
    const operationId = observed.feedback?.original_operation_id
    if (!operationId || !observed.feedback) throw new Error("Missing original restore")
    property(f.target.properties).management_receipt = rich(
      "management_receipt",
      JSON.stringify({
        ...observed.feedback,
        status: "processing",
        original_operation_id: null,
        after: undefined,
      }),
    )
    for (const [key, row] of f.records) {
      const payload = property(
        property(JSON.parse(text(property(property(row.properties).payload).rich_text))).payload,
      )
      if (payload.kind === "body_write_outcome") f.records.delete(key)
    }
    const count = f.records.size
    f.clearCalls()
    await expect(
      f.run(processSharedFileRequest({ ...f.input, reconcile: true, operationId })),
    ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_UNRESOLVED" })
    expect(f.records.size).toBe(count)
    expect(f.mutations()).toHaveLength(0)
    f.intent("none")
    expect(
      (await f.run(processSharedFileRequest({ ...f.input, reconcile: true, operationId }))).status,
    ).toBe("no_request")
    expect(f.mutations()).toHaveLength(0)
  })

  test("an explicit ID never replaces an existing receipt or authorizes ordinary processing", async () => {
    const f = await fixture({ sameBody: false })
    const operationId = `body-write-follow-${"a".repeat(64)}.${"b".repeat(64)}`
    f.clearCalls()
    await expect(
      f.run(processSharedFileRequest({ ...f.input, operationId })),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
    expect(f.calls).toHaveLength(0)
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("verified_applied")
    f.clearCalls()
    await expect(
      f.run(processSharedFileRequest({ ...f.input, reconcile: true, operationId })),
    ).rejects.toMatchObject({ code: "SHARED_FILE_REQUEST_ORIGINAL_SCOPE" })
    expect(f.mutations()).toHaveLength(0)
  })

  test("historical verified feedback without a submitted receipt remains readable and unchanged", async () => {
    const f = await fixture({ sameBody: false })
    expect((await f.run(processSharedFileRequest(f.input))).status).toBe("verified_applied")
    const observed = await f.run(readSharedFileRequest(f.input))
    if (!observed.feedback) throw new Error("Missing verified receipt")
    property(f.target.properties).management_receipt = rich(
      "management_receipt",
      JSON.stringify({
        ...observed.feedback,
        submitted: undefined,
      }),
    )
    f.clearCalls()
    expect((await f.run(readSharedFileRequest(f.input))).status).toBe("verified_applied")
    const repeated = await f.run(processSharedFileRequest({ ...f.input, reconcile: true }))
    expect(repeated.status).toBe("verified_applied")
    expect("unchanged" in repeated && repeated.unchanged).toBe(true)
    expect(f.mutations()).toHaveLength(0)
  })
})
