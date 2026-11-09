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
  const hooks: { feedback?: (status: string) => void; record?: (kind: string) => void } = {}
  const run: typeof f.run = (effect) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const controlled: Notion["Service"] = {
          ...api,
          request: (requestPath, body, options) =>
            Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
              const method = options?.method ?? (body === undefined ? "GET" : "POST")
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
                hooks.feedback?.(String(property(JSON.parse(value)).status))
                return Effect.succeed(structuredClone(row))
              }
              return api.request(requestPath, body, options).pipe(
                Effect.tap(() => {
                  if (requestPath === "v1/pages" && method === "POST")
                    hooks.record?.(
                      String(
                        property(property(property(property(body).properties).kind).select).name,
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
    await expect(f.run(processSharedFileRequest(f.input))).rejects.toMatchObject({
      code: "SOURCE_WRITE_MISMATCH",
    })
    expect(f.bodies.get(id(11))).toBe("Late human version\n")
    expect((await f.state()).state?.ownership.kind).toBe("custom")
    expect(f.records.size).toBe(count)
    expect(f.bodyWrites()).toHaveLength(0)
  })

  test("canceling after the original plan dispatch records a no-send outcome and reconciliation releases only its local barrier", async () => {
    const f = await fixture()
    f.hooks.record = (kind) => {
      if (kind === "operation") f.intent("none")
    }
    const result = await f.run(processSharedFileRequest(f.input))
    expect(result.status).toBe("blocked")
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
    f.intent("restore-follow")
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
})
