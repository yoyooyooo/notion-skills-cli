import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import {
  prepareSharedGitMainTakeover,
  executeSharedGitMainTakeover,
} from "../src/shared-git-main-takeover.ts"
import {
  reviewSharedBodyWrite,
  reconcileSharedBodyWriteReview,
  completedSharedBodyWriteReview,
} from "../src/shared-body-write-review.ts"
import {
  bodyWriteReviewCompletion,
  bodyWriteReviewCompletionId,
  bodyWriteReviewOperationId,
  bodyWriteReviewReceipt,
  validateSharedBodyWriteReviewPlan,
} from "../src/shared-body-write-review-model.ts"
import { bodyWriteOutcomeId } from "../src/shared-body-write-model.ts"
import { prepareSharedMetadataWrite } from "../src/shared-metadata-write.ts"
import {
  retainPendingFileOperation,
  sharedPendingObservationPrefix,
} from "../src/shared-pending-file-operations.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { querySharedOperationIndex } from "../src/shared-operation-index.ts"
import { inspectAuditSkill } from "../src/shared-audit-inspect.ts"
import { prepareSharedBodyWrite, executeSharedBodyWrite } from "../src/shared-body-write.ts"
import {
  client as nativeClient,
  remote as nativeRemote,
  library as nativeLibrary,
  skillPage as nativeSkillPage,
  fileId as nativeFileId,
  original as nativeOriginal,
  candidate as nativeCandidate,
  creates as nativeCreates,
  patches as nativePatches,
  seed as nativeSeed,
  payloadFor as nativePayloadFor,
} from "./shared-body-write-review-fixture.ts"
import { parseYaml } from "../src/yaml.ts"
import { gitMainFixture, library, sha } from "./shared-git-main-takeover-fixture.ts"
import { id, rich } from "./shared-snapshot-fixture.ts"

type Fixture = Awaited<ReturnType<typeof gitMainFixture>>
type Call = { path: string; method: string; body: unknown }
const recordFields: Readonly<Record<string, string>> = library.records.property_ids
const authoredBody =
  '# Initial\n\n1. **Keep the complete text**:\n   - Keep the nested instruction.\n\n[Guide](https://example.test/guide#section)\n\n```js\nconst keep = "exact";\n```\n'
const observedBody =
  '# Initial\n\n1. <b>Keep the complete text</b>:\n\t- Keep the nested instruction.\n\n[Guide](https://example.test/guide#section)\n\n```js\nconst keep = "exact";\n```'
const recordId = (row: unknown) =>
  text(property(property(property(row).properties)[recordFields["Record ID"]!]).rich_text)
const recordKind = (row: unknown) =>
  property(property(property(property(row).properties)[recordFields.Kind!]).select).name
const envelope = (row: unknown) =>
  property(
    JSON.parse(text(property(property(property(row).properties)[recordFields.Payload!]).rich_text)),
  )
const records = (f: Fixture) => [...f.f.base.records.values()]
const findRecord = (f: Fixture, key: string) => {
  const row = records(f).find((value) => recordId(value) === key)
  if (!row) throw new Error(`Missing controlled record: ${key}`)
  return row
}
const writes = (calls: readonly Call[]) =>
  calls.filter(
    (call) =>
      call.method === "PATCH" ||
      (call.method === "POST" &&
        new URL(call.path, "https://api.notion.com").pathname === "/v1/pages"),
  )
const pending = (f: Fixture) =>
  [...f.f.base.json.entries()].filter(([key]) =>
    key.startsWith("operations/shared-observation-pending/"),
  )

/** Production requests and Store calls, with only controlled transport visibility/failure. */
function controlled(
  f: Fixture,
  options: {
    hideFirstPostEventQuery?: boolean
    loseCompletionResponse?: boolean
    hidden?: Set<string>
    afterFirstBodyRead?: () => void
  } = {},
) {
  const calls: Call[] = [],
    localWrites: string[] = []
  let hideEventQuery = false,
    eventQueryHidden = false,
    lost = false,
    bodyReads = 0
  const run: typeof f.author = (task) =>
    f.author(
      Effect.gen(function* () {
        const api = yield* Notion,
          store = yield* Store
        return yield* task.pipe(
          Effect.provideService(Store, {
            ...store,
            writeJson: (key, value) =>
              Effect.gen(function* () {
                localWrites.push(key)
                yield* store.writeJson(key, value)
              }),
            writeBytes: (key, value) =>
              Effect.gen(function* () {
                localWrites.push(key)
                yield* store.writeBytes(key, value)
              }),
            retireKeys: (keys) =>
              Effect.gen(function* () {
                localWrites.push(...keys.map((key) => `retire:${key}`))
                return yield* store.retireKeys(keys)
              }),
          }),
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, requestOptions) =>
              Effect.suspend(() => {
                const method = requestOptions?.method ?? (body === undefined ? "GET" : "POST")
                calls.push({ path, body, method })
                const pathname = new URL(path, "https://api.notion.com").pathname
                const isRecordPost =
                  pathname === "/v1/pages" &&
                  method === "POST" &&
                  property(property(body).parent).data_source_id === library.records.data_source_id
                const requestedId = isRecordPost ? recordId(body) : ""
                if (method === "GET" && options.hidden?.has(pathname.slice("/v1/pages/".length)))
                  return Effect.fail(fail("NOT_FOUND", "Controlled hidden acknowledgement page"))
                return api.request(path, body, requestOptions).pipe(
                  Effect.flatMap((raw) => {
                    if (path === `v1/pages/${f.target}/markdown?markdown_version=v2`) {
                      bodyReads++
                      if (bodyReads === 1) options.afterFirstBodyRead?.()
                    }
                    if (isRecordPost && requestedId.startsWith("review-adopt-"))
                      hideEventQuery = true
                    if (
                      isRecordPost &&
                      requestedId.startsWith("completed-v1-") &&
                      options.loseCompletionResponse &&
                      !lost
                    ) {
                      lost = true
                      options.hidden?.add(String(property(raw).id))
                      return Effect.fail(
                        fail("WRITE_OUTCOME_UNKNOWN", "Controlled lost completion response"),
                      )
                    }
                    if (pathname === `/v1/data_sources/${library.records.data_source_id}/query`) {
                      const page = property(raw)
                      if (Array.isArray(page.results)) {
                        let results = page.results.filter(
                          (row) => !options.hidden?.has(String(property(row).id)),
                        )
                        if (
                          options.hideFirstPostEventQuery &&
                          hideEventQuery &&
                          !eventQueryHidden &&
                          results.some((row) => recordId(row).startsWith("review-adopt-"))
                        ) {
                          results = results.filter(
                            (row) => !recordId(row).startsWith("review-adopt-"),
                          )
                          eventQueryHidden = true
                        }
                        return Effect.succeed({ ...page, results })
                      }
                    }
                    return Effect.succeed(raw)
                  }),
                )
              }),
          }),
        )
      }),
    )
  return { run, calls, localWrites }
}

async function incompleteReview() {
  const f = await gitMainFixture()
  const snapshot = await f.read()
  const sourceInput = new TextDecoder().decode(f.original.bytes)
  const markdown = sourceInput.slice(0, sourceInput.indexOf("# Initial")) + authoredBody
  const { plan: original } = await f.author(
    prepareSharedGitMainTakeover({ library, snapshot, path: "SKILL.md", markdown, mode: "100755" }),
  )
  f.renderNative(() => observedBody)
  await expect(
    f.author(executeSharedGitMainTakeover({ library, plan: original, mode: "create" })),
  ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_REVIEW_REQUIRED" })
  const args = {
    library,
    skillPageId: f.target,
    originalOperationId: original.operation_id,
    acceptedObservedSha256: sha(observedBody),
    scope: original.git_main_initialization!.snapshot_scope,
  }
  const preview = await f.author(reviewSharedBodyWrite({ ...args, mode: "create", dryRun: true }))
  if (preview.status !== "planned") throw new Error("Expected real version-2 review preview")
  const review = preview.plan
  const first = controlled(f, { hideFirstPostEventQuery: true })
  await expect(
    first.run(reviewSharedBodyWrite({ ...args, mode: "create", dryRun: false })),
  ).rejects.toMatchObject({ code: "BASELINE_MISSING" })
  expect(writes(first.calls).map((call) => recordId(call.body))).toEqual([
    review.operation_id,
    review.content.object_id,
    review.event.event_id,
  ])
  expect(records(f).some((row) => recordId(row) === `reviewed-${review.operation_id}`)).toBe(false)
  expect(pending(f)).toHaveLength(2)
  expect(f.bodyWrites).toHaveLength(1)
  return { f, original, review, args }
}
type Incomplete = Awaited<ReturnType<typeof incompleteReview>>
const complete = (input: Incomplete, dryRun = false) =>
  reviewSharedBodyWrite({ ...input.args, mode: "complete", dryRun })
function changePayload(
  row: Record<string, unknown>,
  change: (value: Record<string, unknown>) => void,
) {
  const value = envelope(row)
  change(property(value.payload))
  const encoded = canonicalSharedJson(value)
  const props = property(row.properties)
  props[recordFields.Payload!] = rich(recordFields.Payload!, encoded)
  props[recordFields.Hash!] = rich(recordFields.Hash!, sha(encoded))
}

function seedOperation(
  input: Incomplete,
  key: string,
  operationId: string,
  payload: unknown,
  page: number,
) {
  const row = structuredClone(findRecord(input.f, input.review.operation_id))
  row.id = id(page)
  const props = property(row.properties)
  const encoded = canonicalSharedJson({ version: 1, operation_id: operationId, payload })
  props[recordFields["Record ID"]!] = rich(recordFields["Record ID"]!, key)
  props[recordFields.Payload!] = rich(recordFields.Payload!, encoded)
  props[recordFields.Hash!] = rich(recordFields.Hash!, sha(encoded))
  input.f.f.base.records.set(String(row.id), row)
  return row
}

async function expectStopped(input: Incomplete, run = controlled(input.f)) {
  const rows = canonicalSharedJson(records(input.f))
  await expect(run.run(complete(input))).rejects.toMatchObject({ _tag: "SkillsError" })
  expect(writes(run.calls)).toEqual([])
  expect(canonicalSharedJson(records(input.f))).toBe(rows)
  expect(input.f.bodyWrites).toHaveLength(1)
  expect(pending(input.f).length).toBeGreaterThan(0)
}

describe("bounded completion of an original Git-main body review", () => {
  test("dry-run leaves all remote facts, local state and original pending untouched", async () => {
    const input = await incompleteReview(),
      api = controlled(input.f)
    const before = canonicalSharedJson([...input.f.f.base.json])
    const result = await api.run(complete(input, true))
    expect(result.status).toBe("planned")
    expect(writes(api.calls)).toEqual([])
    expect(api.localWrites).toEqual([])
    expect(canonicalSharedJson([...input.f.f.base.json])).toBe(before)
    expect(pending(input.f)).toHaveLength(2)
  })

  test("writes one independent completion, preserves original facts and cold full native/Git consumption", async () => {
    const input = await incompleteReview(),
      { f, original, review } = input
    const originals = new Map(records(f).map((row) => [String(row.id), canonicalSharedJson(row)]))
    await expect(f.read()).rejects.toMatchObject({ _tag: "SkillsError" })
    const api = controlled(f),
      result = await api.run(complete(input))
    const completionId = bodyWriteReviewCompletionId(review.operation_id)
    expect(result).toMatchObject({
      status: "reviewed",
      operation_id: review.operation_id,
      completion_operation_id: completionId,
      original_operation_id: original.operation_id,
      original_status: "needs_review",
      requires_fresh_read: true,
    })
    expect(writes(api.calls).map((call) => recordId(call.body))).toEqual([completionId])
    expect(writes(api.calls).filter((call) => call.method === "PATCH")).toEqual([])
    expect(writes(api.calls).filter((call) => recordKind(call.body) === "file_event")).toEqual([])
    expect(property(envelope(findRecord(f, completionId)).payload)).toMatchObject({
      kind: "body_write_review_completion",
      operation_id: completionId,
      review_operation_id: review.operation_id,
      original_review_receipt: "unproven",
    })
    for (const [page, content] of originals)
      expect(canonicalSharedJson(f.f.base.records.get(page))).toBe(content)
    expect(
      property(envelope(findRecord(f, bodyWriteOutcomeId(original.operation_id))).payload).status,
    ).toBe("needs_review")
    expect(pending(f)).toEqual([])
    expect(f.bodyWrites).toHaveLength(1)
    const repeat = controlled(f)
    expect((await repeat.run(complete(input))).status).toBe("reviewed")
    expect(writes(repeat.calls)).toEqual([])

    f.f.base.json.clear()
    f.f.base.objects.clear()
    const cold = await f.read()
    expect(cold.files).toHaveLength(f.member.portable.files.length)
    const main = cold.files.find((file) => file.path === "SKILL.md")!
    expect(main.mode).toBe("100755")
    const mainBytes = await f.run(
      Effect.flatMap(Store, (store) => store.readBytes(`objects/${main.sha256}`)),
    )
    const full = new TextDecoder().decode(mainBytes)
    expect(parseYaml(/^---\n([\s\S]*?)\n---\n/u.exec(full)![1]!)).toEqual({
      name: "initial-source",
      description: "Initial complete member",
      license: "MIT",
      args: ["target"],
      "user-invokable": true,
    })
    expect(full).toContain(observedBody)
    for (const sourceFile of f.member.portable.files.filter((file) => file.path !== "SKILL.md")) {
      const exported = cold.files.find((file) => file.path === sourceFile.path)!
      expect(exported.sha256).toBe(sha(sourceFile.bytes))
      expect(exported.mode).toBe(sourceFile.mode)
    }
    expect(f.bodyWrites).toHaveLength(1)

    f.changeMarkdown(observedBody + "\n\nLater user edit.")
    const history = controlled(f)
    expect((await history.run(reconcileSharedBodyWriteReview(library, review))).operation_id).toBe(
      review.operation_id,
    )
    expect(
      (await history.run(completedSharedBodyWriteReview(library, original)))
        ?.completion_operation_id,
    ).toBe(completionId)
    expect(writes(history.calls)).toEqual([])
    expect(history.calls.some((call) => call.path.includes("/markdown"))).toBe(false)
  })

  for (const missing of ["review plan", "observed object", "review event"] as const)
    test(`cannot fill a missing ${missing} from equal current bytes`, async () => {
      const input = await incompleteReview()
      const key =
        missing === "review plan"
          ? input.review.operation_id
          : missing === "observed object"
            ? input.review.content.object_id
            : input.review.event.event_id
      input.f.f.base.records.delete(String(findRecord(input.f, key).id))
      await expectStopped(input)
    })

  test("a self-consistently rehashed but changed event cannot authorize completion", async () => {
    const input = await incompleteReview()
    changePayload(findRecord(input.f, input.review.event.event_id), (value) => {
      property(value.content).mode = "100644"
    })
    await expectStopped(input)
  })

  test("an original unknown body outcome is not converted to needs_review by current equality", async () => {
    const input = await incompleteReview()
    input.f.f.base.records.delete(
      String(findRecord(input.f, bodyWriteOutcomeId(input.original.operation_id)).id),
    )
    await expectStopped(input)
  })

  for (const drift of [
    "raw newline",
    "link fragment",
    "Source definition",
    "Origin member",
    "native header",
    "file binding",
    "event frontier",
  ] as const)
    test(`rejects current ${drift} drift before a completion write`, async () => {
      const input = await incompleteReview(),
        { f } = input
      const props = property(f.row.properties)
      if (drift === "raw newline") f.changeMarkdown(observedBody.replaceAll("\n", "\r\n"))
      if (drift === "link fragment")
        f.changeMarkdown(observedBody.replace("#section", "#different"))
      if (drift === "Source definition")
        property(f.f.source.properties)[library.sources!.property_ids.Ref!] = rich(
          library.sources!.property_ids.Ref!,
          "b".repeat(40),
        )
      if (drift === "Origin member") props.source_member = rich("source_member", "skills/other")
      if (drift === "native header") props.description = rich("description", "Another description")
      if (drift === "file binding") props.main_file_id = rich("main_file_id", "foreign-main")
      if (drift === "event frontier") {
        const event = structuredClone(findRecord(f, input.review.event.event_id))
        event.id = id(999001)
        property(event.properties)[recordFields["Record ID"]!] = rich(
          recordFields["Record ID"]!,
          "foreign-head",
        )
        changePayload(event, (value) => {
          value.event_id = "foreign-head"
        })
        f.f.base.records.set(String(event.id), event)
      }
      await expectStopped(input)
    })

  test("rechecks exact current bytes after preflight and before dispatch", async () => {
    const input = await incompleteReview()
    const api = controlled(input.f, {
      afterFirstBodyRead: () => input.f.changeMarkdown(observedBody + "\nConcurrent edit"),
    })
    await expectStopped(input, api)
  })

  test("requires the exact original local review, including its credential scope", async () => {
    for (const mode of ["missing", "other-scope", "second-scope-journal"] as const) {
      const input = await incompleteReview(),
        api = controlled(input.f)
      const entry = pending(input.f).find(
        ([, value]) => property(property(value).plan).operation_id === input.review.operation_id,
      )!
      if (mode === "missing") input.f.f.base.json.delete(entry[0])
      if (mode === "second-scope-journal")
        await input.f.author(
          Effect.gen(function* () {
            const otherScope = sha("another-original-scope")
            yield* retainPendingFileOperation(
              {
                prefix: yield* sharedPendingObservationPrefix(
                  otherScope,
                  input.original.library_id,
                  input.original.skill_id,
                ),
                scope: otherScope,
                library_id: input.original.library_id,
                skill_id: input.original.skill_id,
                skill_page_id: input.f.target,
              },
              input.review,
            )
          }),
        )
      const effect =
        mode !== "other-scope"
          ? complete(input)
          : reviewSharedBodyWrite({
              ...input.args,
              scope: sha("another-original-scope"),
              mode: "complete",
              dryRun: false,
            })
      await expect(api.run(effect)).rejects.toMatchObject({ _tag: "SkillsError" })
      expect(writes(api.calls)).toEqual([])
    }
  })

  test("another valid pending family is not retired or bypassed", async () => {
    const input = await incompleteReview(),
      { f } = input
    await f.author(
      Effect.gen(function* () {
        const foreign = yield* prepareSharedMetadataWrite({
          library,
          skillPageId: f.target,
          changes: [{ field: "Enabled", value: false }],
        })
        yield* retainPendingFileOperation(
          {
            prefix: yield* sharedPendingObservationPrefix(
              input.args.scope,
              input.original.library_id,
              input.original.skill_id,
            ),
            scope: input.args.scope,
            library_id: input.original.library_id,
            skill_id: input.original.skill_id,
            skill_page_id: f.target,
          },
          foreign,
        )
      }),
    )
    expect(pending(f)).toHaveLength(3)
    await expectStopped(input)
    expect(pending(f)).toHaveLength(3)
  })

  test("an exact existing legacy receipt needs no independent write; a conflicting receipt cannot be hidden by completion", async () => {
    const legacy = await incompleteReview()
    const legacyReceipt = await legacy.f.run(bodyWriteReviewReceipt(legacy.review))
    seedOperation(
      legacy,
      `reviewed-${legacy.review.operation_id}`,
      legacy.review.operation_id,
      legacyReceipt,
      999010,
    )
    const readOnly = controlled(legacy.f)
    expect((await readOnly.run(complete(legacy))).status).toBe("reviewed")
    expect(writes(readOnly.calls)).toEqual([])
    expect(
      records(legacy.f).some(
        (row) => recordId(row) === bodyWriteReviewCompletionId(legacy.review.operation_id),
      ),
    ).toBe(false)

    const input = await incompleteReview()
    await controlled(input.f).run(complete(input))
    const wrong = {
      ...(await input.f.run(bodyWriteReviewReceipt(input.review))),
      accepted_observed_sha256: "0".repeat(64),
    }
    seedOperation(
      input,
      `reviewed-${input.review.operation_id}`,
      input.review.operation_id,
      wrong,
      999011,
    )
    const audit = controlled(input.f)
    await expect(
      audit.run(reconcileSharedBodyWriteReview(library, input.review)),
    ).rejects.toMatchObject({ code: "SHARED_RECORD_CONFLICT" })
    const headers = await audit.run(querySharedOperationIndex(library, input.f.target))
    await expect(
      audit.run(completedSharedBodyWriteReview(library, input.original, { headers })),
    ).rejects.toMatchObject({ code: "SHARED_RECORD_CONFLICT" })
    expect(writes(audit.calls)).toEqual([])
  })

  for (const defect of ["missing payload", "changed payload"] as const)
    test(`an indexed completion with ${defect} cannot hide behind an exact legacy receipt`, async () => {
      const input = await incompleteReview()
      await controlled(input.f).run(complete(input))
      seedOperation(
        input,
        `reviewed-${input.review.operation_id}`,
        input.review.operation_id,
        await input.f.run(bodyWriteReviewReceipt(input.review)),
        999012,
      )
      const indexed = controlled(input.f)
      const headers = await indexed.run(querySharedOperationIndex(library, input.f.target))
      const completion = findRecord(input.f, bodyWriteReviewCompletionId(input.review.operation_id))
      if (defect === "changed payload")
        changePayload(completion, (value) => {
          value.accepted_observed_sha256 = "0".repeat(64)
        })
      const api = controlled(
        input.f,
        defect === "missing payload" ? { hidden: new Set([String(completion.id)]) } : {},
      )
      const before = canonicalSharedJson(records(input.f))
      await expect(
        api.run(completedSharedBodyWriteReview(library, input.original, { headers })),
      ).rejects.toMatchObject({
        code: defect === "missing payload" ? "SHARED_RECORD_UNRESOLVED" : "SHARED_RECORD_CONFLICT",
      })
      expect(writes(api.calls)).toEqual([])
      expect(canonicalSharedJson(records(input.f))).toBe(before)
    })

  test("ordinary non-Git-main review remains outside the new completion authority", async () => {
    const shared = nativeRemote(nativeOriginal)
    const writer = nativeClient(shared, { readback: () => observedBody })
    const original = await writer.run(
      prepareSharedBodyWrite({
        library: nativeLibrary,
        skillPageId: nativeSkillPage,
        fileId: nativeFileId,
        candidateMarkdown: nativeCandidate,
        action: "write",
      }),
    )
    await expect(
      writer.run(executeSharedBodyWrite(nativeLibrary, { plan: original, mode: "create" })),
    ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_REVIEW_REQUIRED" })
    const args = {
      library: nativeLibrary,
      skillPageId: nativeSkillPage,
      originalOperationId: original.operation_id,
      acceptedObservedSha256: sha(observedBody),
      scope: sha("native-review-completion-boundary"),
    }
    const review = nativeClient(shared, {
      unknownRecord: "operation",
      unknownRecordPrefix: "reviewed-body-review-",
      invisible: true,
    })
    await expect(
      review.run(reviewSharedBodyWrite({ ...args, mode: "create", dryRun: false })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const completion = nativeClient(shared)
    await expect(
      completion.run(reviewSharedBodyWrite({ ...args, mode: "complete", dryRun: false })),
    ).rejects.toMatchObject({ code: "SHARED_BODY_REVIEW_INELIGIBLE" })
    expect(nativeCreates(completion)).toEqual([])
    expect(nativePatches(completion)).toEqual([])

    shared.hidden.clear()
    const reviewId = await completion.run(bodyWriteReviewOperationId(original.operation_id))
    const plan = await completion.run(
      validateSharedBodyWriteReviewPlan(nativePayloadFor(shared, reviewId)),
    )
    const completionId = bodyWriteReviewCompletionId(reviewId)
    nativeSeed(
      shared,
      "operation",
      completionId,
      completionId,
      nativeFileId,
      await completion.run(bodyWriteReviewCompletion(plan)),
    )
    const indexed = nativeClient(shared)
    const headers = await indexed.run(querySharedOperationIndex(nativeLibrary, nativeSkillPage))
    await expect(
      indexed.run(completedSharedBodyWriteReview(nativeLibrary, original, { headers })),
    ).rejects.toMatchObject({ code: "SHARED_BODY_REVIEW_INELIGIBLE" })
    expect(nativeCreates(indexed)).toEqual([])
    expect(nativePatches(indexed)).toEqual([])
  })

  test("content audit verifies a complete original chain but does not classify an orphan completion as resolved", async () => {
    const input = await incompleteReview(),
      { f } = input
    await controlled(f).run(complete(input))
    const inspect = () =>
      inspectAuditSkill(library, {
        page_id: f.target,
        depth: "content",
        observed_from: Date.now(),
        inventory: {
          skills: [f.row],
          files: [],
          records: records(f),
          sources: [f.f.source],
          complete: ["skills", "files", "records", "sources"],
        },
      })
    const validApi = controlled(f)
    const valid = await validApi.run(inspect())
    expect(
      valid.findings.some(
        (finding) => finding.code === "ORIGINAL_BODY_WRITE_INDEPENDENTLY_REVIEWED",
      ),
    ).toBe(true)
    expect(
      valid.findings.some(
        (finding) =>
          finding.code === "OPERATION_OUTCOME_UNOBSERVED" &&
          finding.object_id === bodyWriteReviewCompletionId(input.review.operation_id),
      ),
    ).toBe(false)
    expect(writes(validApi.calls)).toEqual([])
    f.f.base.records.delete(String(findRecord(f, input.review.operation_id).id))
    const orphanApi = controlled(f)
    const orphan = await orphanApi.run(inspect())
    expect(
      orphan.findings.some(
        (finding) =>
          finding.code === "OPERATION_OUTCOME_UNOBSERVED" &&
          finding.object_id === bodyWriteReviewCompletionId(input.review.operation_id),
      ),
    ).toBe(true)
    expect(
      orphan.findings.some(
        (finding) => finding.code === "ORIGINAL_BODY_WRITE_INDEPENDENTLY_REVIEWED",
      ),
    ).toBe(false)
    expect(writes(orphanApi.calls)).toEqual([])
  })

  for (const visible of [false, true])
    test(`lost independent completion response (visible=${visible}) never dispatches it twice`, async () => {
      const input = await incompleteReview(),
        { f } = input
      const hidden = visible ? undefined : new Set<string>()
      const api = controlled(f, {
        loseCompletionResponse: true,
        ...(hidden === undefined ? {} : { hidden }),
      })
      await expect(api.run(complete(input))).rejects.toMatchObject({ _tag: "SkillsError" })
      expect(writes(api.calls).map((call) => recordId(call.body))).toEqual([
        bodyWriteReviewCompletionId(input.review.operation_id),
      ])
      expect(
        [...f.f.base.json.keys()].filter((key) => /\/source-op-[a-f0-9]{64}\.json$/u.test(key)),
      ).toHaveLength(1)
      const retry = controlled(f, hidden === undefined ? {} : { hidden })
      if (visible) expect((await retry.run(complete(input))).status).toBe("reviewed")
      else {
        await expect(retry.run(complete(input))).rejects.toMatchObject({ _tag: "SkillsError" })
        expect(pending(f)).toHaveLength(2)
        hidden!.clear()
        const revealed = controlled(f)
        expect(
          (
            await revealed.run(
              reviewSharedBodyWrite({ ...input.args, mode: "reconcile", dryRun: false }),
            )
          ).status,
        ).toBe("reviewed")
        expect(writes(revealed.calls)).toEqual([])
      }
      expect(writes(retry.calls)).toEqual([])
      expect(
        [...f.f.base.json.keys()].filter((key) => /\/source-ack-[a-f0-9]{64}\.json$/u.test(key)),
      ).toHaveLength(0)
      expect(f.bodyWrites).toHaveLength(1)
    })
})
