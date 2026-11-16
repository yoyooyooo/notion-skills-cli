import { expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { HttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fail, property, text } from "../src/model.ts"
import { Store } from "../src/store.ts"
import { Notion } from "../src/notion.ts"
import { executeSharedCreate, reconcileSharedCreate } from "../src/shared-create.ts"
import { prepareSharedSourceProjection } from "../src/shared-source-projection.ts"
import { readSourceDefinition } from "../src/shared-source-definitions.ts"
import {
  reviewSharedRetainedImportRecovery,
  applySharedRetainedImportRecovery,
} from "../src/shared-create-retained-recovery.ts"
import {
  reviewSharedSourceFileRepair,
  applySharedSourceFileRepair,
  reconcileSharedSourceFileRepair,
  assertSourceFileRepairsComplete,
  sourceFileRepairProofVerifier,
} from "../src/shared-source-file-repair.ts"
import { nativeRepairTableRow } from "../src/shared-native-table-code-repair.ts"
import { fixture, library } from "./shared-source-projection-fixture.ts"
import { digest, encode, id, rich } from "./shared-snapshot-fixture.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"

const source =
  "# Questions\n\n| # | Question |\n| --- | --- |\n| 1 | **Audience** - Who? |\n| 2 | **Length** - How long? |\n"
const annotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
}
const span = (content: string) => ({
  type: "text",
  text: { content, link: null },
  annotations: { ...annotations },
  plain_text: content,
  href: null,
})

async function failedLiteralFile(progressive = false) {
  const f = fixture(
    [
      ...(progressive
        ? [
            {
              path: "before.md",
              bytes: encode("# Earlier checkpoint\n\nIntact prefix.\n"),
              mode: "100644" as const,
            },
          ]
        : []),
      { path: "questions.md", bytes: encode(source), mode: "100644" },
    ],
    {
      markdownImport: true,
      recovery: true,
      readback: (wire) =>
        wire
          .replace("**Audience** -", "<b>Audience</b>  •")
          .replace("**Length** -", "<b>Length</b>  •"),
    },
  )
  const root = mkdtempSync(join(tmpdir(), "source-literal-repair-"))
  const tableId = id(880)
  const rows = [
    ["#", "Question"],
    ["1", "Audience  • Who?"],
    ["2", "Length  • How long?"],
  ].map((cells, at) => ({
    object: "block",
    id: id(881 + at),
    type: "table_row",
    has_children: false,
    archived: false,
    in_trash: false,
    parent: { type: "block_id", block_id: tableId },
    table_row: { cells: cells.map((content) => [span(content)]) },
  }))
  const target = () =>
    String(
      [...f.files.values()].find(
        (row) => text(property(property(row.properties).path).rich_text) === "questions.md",
      )?.id,
    )
  const table = () => ({
    object: "block",
    id: tableId,
    type: "table",
    has_children: true,
    archived: false,
    in_trash: false,
    parent: { type: "page_id", page_id: target() },
    table: { table_width: 2, has_column_header: true, has_row_header: false },
  })
  const listed = (results: unknown[]) => ({
    object: "list",
    results,
    has_more: false,
    next_cursor: null,
  })
  let lose: { row: number; visible: boolean } | undefined
  let interruptAfter: number | undefined
  let bodyFailure = false
  let earlyFailure = progressive
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | Store
      | Notion
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | HttpClient.HttpClient
      | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion,
          store = yield* Store
        return yield* effect.pipe(
          Effect.provideService(Store, { ...store, root }),
          Effect.provide(NodeServices.layer),
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              Effect.suspend(() => {
                const method = options?.method ?? (body === undefined ? "GET" : "POST")
                const route = path.split("?")[0]
                if (earlyFailure && method === "GET" && route?.endsWith("/markdown")) {
                  const page = route.slice("v1/pages/".length, -"/markdown".length)
                  if (f.base.bodies.get(page)?.includes("Earlier checkpoint"))
                    return Effect.fail(
                      fail(
                        "SHARED_CREATE_BODY_MISMATCH",
                        "Earlier validator stopped before the later literal file",
                      ),
                    )
                }
                if (bodyFailure && route === `v1/pages/${target()}/markdown` && method === "GET") {
                  bodyFailure = false
                  return Effect.fail(
                    fail(
                      "NOTION_REQUEST_FAILED",
                      "Controlled interruption after one actual row ACK",
                    ),
                  )
                }
                if (method === "GET" && route === `v1/blocks/${target()}/children`)
                  return Effect.succeed(listed([table()]))
                if (method === "GET" && route === `v1/blocks/${tableId}/children`)
                  return Effect.succeed(listed(structuredClone(rows)))
                if (method === "GET" && route === `v1/blocks/${tableId}`)
                  return Effect.succeed(table())
                const at = rows.findIndex((row) => route === `v1/blocks/${row.id}`)
                if (at >= 0 && method === "GET") return Effect.succeed(structuredClone(rows[at]))
                if (at >= 0 && method === "PATCH") {
                  f.calls.push({ path, method, body })
                  const raw = { ...rows[at]!, table_row: property(body).table_row }
                  const cells = property(raw.table_row).cells
                  if (!Array.isArray(cells))
                    return Effect.fail(fail("TEST_LITERAL_REPAIR", "Missing row cells"))
                  const response = {
                    ...raw,
                    table_row: {
                      cells: cells.map((cell: unknown) => {
                        if (!Array.isArray(cell)) throw new Error("Expected cells")
                        return cell.map((part: unknown) => {
                          const value = property(part),
                            t = property(value.text)
                          return {
                            ...value,
                            plain_text: t.content,
                            href: t.link === null ? null : property(t.link).url,
                          }
                        })
                      }),
                    },
                  }
                  const checked = nativeRepairTableRow(response)
                  const lost = lose?.row === at ? lose : undefined
                  if (lost === undefined || lost.visible) {
                    rows[at]!.table_row.cells = checked.cells.map((cell) =>
                      cell.map((part) => span(part.text.content)),
                    )
                    const old = at === 1 ? "<b>Audience</b>  •" : "<b>Length</b>  •"
                    f.base.bodies.set(
                      target(),
                      f.base.bodies.get(target())!.replace(old, old.replace("•", "-")),
                    )
                  }
                  if (interruptAfter === at) {
                    bodyFailure = true
                    interruptAfter = undefined
                  }
                  if (lost) {
                    lose = undefined
                    return Effect.fail(
                      fail("WRITE_OUTCOME_UNKNOWN", "Controlled missing row response"),
                    )
                  }
                  return Effect.succeed(response)
                }
                return api.request(path, body, options)
              }),
          }),
        )
      }),
    )
  const plan = await run(
    Effect.gen(function* () {
      return yield* prepareSharedSourceProjection({
        library,
        definition: yield* readSourceDefinition(library, f.source.id),
        acquired: f.snapshot,
        member: "skills/demo",
        skillId: "literal-file-repair",
        enabled: false,
        markdownImport: true,
        storage: "retained",
      })
    }),
  )
  const error = await run(executeSharedCreate(library, { plan, mode: "create" }).pipe(Effect.flip))
  expect(error.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  const page = String(property(error.details).skill_page_id)
  const input = { entry: library.skills.database_id, plan, target: page, path: "questions.md" }
  let earlierReview
  if (progressive) {
    earlyFailure = false
    earlierReview = await run(reviewSharedRetainedImportRecovery(input))
    const later = await run(
      applySharedRetainedImportRecovery({
        ...input,
        review: earlierReview,
        reviewId: earlierReview.review_id,
      }).pipe(Effect.flip),
    )
    expect(later.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  }
  const repair = await run(reviewSharedSourceFileRepair(input))
  if (repair.version !== 2) throw new Error("The literal fixture must select the v2 repair")
  f.clear()
  return {
    ...f,
    run,
    plan,
    page,
    target: target(),
    rows,
    input,
    repair,
    earlierReview,
    apply: { ...input, repair, reviewId: repair.review.review_id },
    interrupt: (at: number) => {
      interruptAfter = at
    },
    lose: (at: number, visible: boolean) => {
      lose = { row: at, visible }
    },
  }
}

test("a later repaired ACK suffix continues the unchanged earlier recovery authority and binds all repair proofs cold", async () => {
  const f = await failedLiteralFile(true)
  const earlier = f.earlierReview
  if (!earlier) throw new Error("Expected an earlier authorized recovery")
  const original = canonicalSharedJson(earlier)
  expect((await f.run(applySharedSourceFileRepair(f.apply))).verified).toBe(true)
  f.clear()
  const continued = await f.run(reviewSharedRetainedImportRecovery(f.input))
  expect(canonicalSharedJson(continued)).toBe(original)
  expect(f.writes()).toHaveLength(0)
  expect(
    (
      await f.run(
        applySharedRetainedImportRecovery({
          ...f.input,
          review: continued,
          reviewId: continued.review_id,
        }),
      )
    ).verified,
  ).toBe(true)
  const completions = await f.run(
    querySharedRecords(library, {
      skillPageId: f.page,
      kind: "operation",
      recordId: "retained-readback-outcome-" + f.plan.operation_id,
    }),
  )
  expect(property(completions[0]!.payload).version).toBe(3)
  expect(property(completions[0]!.payload).file_repairs).toHaveLength(1)
  const oldReviews = await f.run(
    querySharedRecords(library, {
      skillPageId: f.page,
      kind: "operation",
      recordId: "retained-readback-review-" + f.plan.operation_id,
    }),
  )
  expect(canonicalSharedJson(oldReviews[0]!.payload)).toBe(original)
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  expect((await f.run(reconcileSharedCreate(library, f.plan))).verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
  for (const [id, row] of f.base.records)
    if (
      text(property(property(row.properties).record).rich_text) ===
      "source-file-repair-outcome-" + f.plan.operation_id + "-" + f.repair.review.file_id
    )
      f.base.records.delete(id)
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  await expect(f.run(reconcileSharedCreate(library, f.plan))).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
}, 60000)

test.each(["ack", "body", "path"] as const)(
  "later repaired prefix refuses changed %s before a new recovery write",
  async (guard) => {
    const f = await failedLiteralFile(true)
    expect((await f.run(applySharedSourceFileRepair(f.apply))).verified).toBe(true)
    if (guard === "body") f.base.bodies.set(f.target, "# Human edit\n")
    if (guard === "path") {
      const row = f.files.get(f.target)
      if (!row) throw new Error("Expected repaired file")
      property(row.properties).path = rich("path", "other.md")
    }
    if (guard === "ack") {
      const entry = [...f.base.json].find(([, raw]) => {
        const v = property(raw)
        return (
          v.path === "v1/pages" &&
          v.method === "POST" &&
          typeof v.identity === "string" &&
          v.identity.startsWith(f.plan.operation_id + ":") &&
          text(property(property(property(v.body).properties).path).rich_text) === "questions.md"
        )
      })
      if (!entry) throw new Error("Expected original file dispatch")
      expect(f.base.json.delete(entry[0].replace("/source-op-", "/source-ack-"))).toBe(true)
    }
    f.clear()
    await expect(f.run(reviewSharedRetainedImportRecovery(f.input))).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
  },
  60000,
)

test("extended repaired completion cannot downgrade after its repair indexes disappear", async () => {
  const f = await failedLiteralFile(true)
  await f.run(applySharedSourceFileRepair(f.apply))
  const review = await f.run(reviewSharedRetainedImportRecovery(f.input))
  await f.run(applySharedRetainedImportRecovery({ ...f.input, review, reviewId: review.review_id }))
  const row = [...f.base.records.values()].find(
    (row) =>
      text(property(property(row.properties).record).rich_text) ===
      "retained-readback-outcome-" + f.plan.operation_id,
  )
  if (!row) throw new Error("Expected full completion")
  const fields = property(row.properties)
  const envelope = property(JSON.parse(text(property(fields.payload).rich_text)))
  expect(envelope.operation_id).toMatch(/^retained-readback-repaired-[a-f0-9]{64}$/u)
  const payload = property(envelope.payload)
  payload.version = 1
  delete payload.file_repairs
  delete payload.file_resubmissions
  const canonical = canonicalSharedJson(envelope)
  fields.payload = rich("payload", canonical)
  fields.hash = rich("hash", digest(canonical))
  for (const [id, record] of f.base.records)
    if (
      text(property(property(record.properties).record).rich_text).startsWith("source-file-repair-")
    )
      f.base.records.delete(id)
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  await expect(f.run(reconcileSharedCreate(library, f.plan))).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
}, 60000)

test("one invocation reuses verified immutable repair bytes but refreshes the complete marker index", async () => {
  const f = await failedLiteralFile()
  await f.run(applySharedSourceFileRepair(f.apply))
  const verify = sourceFileRepairProofVerifier(library, f.plan, f.page)
  f.clear()
  const first = await f.run(verify())
  const firstRequests = f.calls.length
  f.clear()
  expect(await f.run(verify())).toEqual(first)
  const warmRequests = f.calls.length
  expect(warmRequests).toBeGreaterThan(0)
  expect(warmRequests).toBeLessThan(firstRequests)
  expect(f.writes()).toHaveLength(0)
  // Removing a required complete marker cannot be hidden by the memo.
  let removed = 0
  for (const [id, row] of f.base.records)
    if (
      text(property(property(row.properties).record).rich_text) ===
      "source-file-repair-outcome-" + f.plan.operation_id + "-" + f.repair.review.file_id
    ) {
      f.base.records.delete(id)
      removed++
    }
  expect(removed).toBe(1)
  f.clear()
  await expect(f.run(verify())).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
  console.log(
    JSON.stringify({
      repair_proof_requests: { first: firstRequests, subsequent: warmRequests },
      fresh_complete_markers_retained: true,
    }),
  )
}, 60000)

test("a changed repair outcome forces full verification and a new invocation never inherits cached proof", async () => {
  const f = await failedLiteralFile()
  await f.run(applySharedSourceFileRepair(f.apply))
  const verify = sourceFileRepairProofVerifier(library, f.plan, f.page)
  await f.run(verify())
  const row = [...f.base.records.values()].find(
    (record) =>
      text(property(property(record.properties).record).rich_text) ===
      "source-file-repair-outcome-" + f.plan.operation_id + "-" + f.repair.review.file_id,
  )
  if (!row) throw new Error("Expected complete repair outcome")
  const fields = property(row.properties)
  const envelope = property(JSON.parse(text(property(fields.payload).rich_text)))
  const payload = property(envelope.payload)
  payload.review_id = "source-file-repair-" + "f".repeat(64)
  const canonical = canonicalSharedJson(envelope)
  fields.payload = rich("payload", canonical)
  fields.hash = rich("hash", digest(canonical))
  f.clear()
  await expect(f.run(verify())).rejects.toBeDefined()
  await expect(
    f.run(sourceFileRepairProofVerifier(library, f.plan, f.page)()),
  ).rejects.toBeDefined()
  await expect(
    f.run(assertSourceFileRepairsComplete(library, f.plan, f.page)),
  ).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
}, 60000)

test("multi-row literal repair resumes only its real ACK prefix and proves original recovery cold", async () => {
  const f = await failedLiteralFile()
  expect(f.repair.review.before_rows).toHaveLength(2)
  expect(await f.run(applySharedSourceFileRepair({ ...f.apply, dryRun: true }))).toMatchObject({
    table_row_patches: 2,
    remote_writes: 0,
  })
  expect(f.writes()).toHaveLength(0)
  f.interrupt(1)
  await expect(f.run(applySharedSourceFileRepair(f.apply))).rejects.toMatchObject({
    code: "NOTION_REQUEST_FAILED",
  })
  expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
  f.clear()
  expect(await f.run(reconcileSharedSourceFileRepair(f.apply))).toMatchObject({
    status: "repair_pending",
    table_row_patches: 1,
    acknowledged_rows: 1,
    remote_writes: 0,
  })
  expect(await f.run(applySharedSourceFileRepair({ ...f.apply, dryRun: true }))).toMatchObject({
    table_row_patches: 1,
    acknowledged_row_reused: true,
  })
  await expect(f.run(reviewSharedRetainedImportRecovery(f.input))).rejects.toMatchObject({
    code: "SOURCE_FILE_REPAIR_PENDING",
  })
  expect(f.writes()).toHaveLength(0)
  expect(await f.run(applySharedSourceFileRepair(f.apply))).toMatchObject({
    verified: true,
    acknowledged_rows_reused: 1,
  })
  expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
  expect(f.calls.find((call) => call.method === "PATCH")?.path).toBe(`v1/blocks/${f.rows[2]!.id}`)
  f.clear()
  expect((await f.run(applySharedSourceFileRepair(f.apply))).remote_writes).toBe(0)
  expect(f.writes()).toHaveLength(0)
  const review = await f.run(reviewSharedRetainedImportRecovery(f.input))
  expect(review.file_repair_proofs).toHaveLength(1)
  expect(
    (
      await f.run(
        applySharedRetainedImportRecovery({ ...f.input, review, reviewId: review.review_id }),
      )
    ).verified,
  ).toBe(true)
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  expect((await f.run(reconcileSharedSourceFileRepair(f.apply))).verified).toBe(true)
  expect((await f.run(reconcileSharedCreate(library, f.plan))).verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
  for (const [key, row] of f.base.records)
    if (
      text(property(property(row.properties).record).rich_text) ===
      "source-file-repair-outcome-" + f.plan.operation_id + "-" + f.repair.review.file_id
    )
      f.base.records.delete(key)
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  await expect(f.run(reconcileSharedCreate(library, f.plan))).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
}, 60000)

test.each([false, true])(
  "a lost second-row ACK visible=%s cannot authorize another PATCH or parent recovery",
  async (visible) => {
    const f = await failedLiteralFile()
    f.lose(2, visible)
    await expect(f.run(applySharedSourceFileRepair(f.apply))).rejects.toBeDefined()
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(2)
    f.clear()
    await expect(
      f.run(applySharedSourceFileRepair({ ...f.apply, dryRun: true })),
    ).rejects.toBeDefined()
    await expect(f.run(applySharedSourceFileRepair(f.apply))).rejects.toBeDefined()
    await expect(f.run(reconcileSharedSourceFileRepair(f.apply))).rejects.toBeDefined()
    await expect(f.run(reviewSharedRetainedImportRecovery(f.input))).rejects.toMatchObject({
      code: "SOURCE_FILE_REPAIR_PENDING",
    })
    expect(f.writes()).toHaveLength(0)
  },
  60000,
)

test("a human change after the first ACK blocks the remaining row before any write", async () => {
  const f = await failedLiteralFile()
  f.interrupt(1)
  await expect(f.run(applySharedSourceFileRepair(f.apply))).rejects.toBeDefined()
  f.rows[2]!.table_row.cells[1]![0] = span("Human edit")
  f.clear()
  await expect(f.run(applySharedSourceFileRepair(f.apply))).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
}, 60000)

test("reordered physical rows cannot borrow the original Markdown positions", async () => {
  const f = await failedLiteralFile()
  const first = f.rows[1]!
  f.rows[1] = f.rows[2]!
  f.rows[2] = first
  f.clear()
  await expect(f.run(applySharedSourceFileRepair(f.apply))).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
}, 60000)

test("a literal review cannot be downgraded into the historical one-row codec", async () => {
  const f = await failedLiteralFile()
  const { before_rows, ...fields } = f.repair.review
  const forged = {
    version: 1,
    kind: "source_file_code_repair_plan",
    before_markdown: f.repair.before_markdown,
    review: {
      ...fields,
      version: 1,
      kind: "source_file_code_repair_review",
      decision: "restore_one_physical_table_code_marker",
      before_row: before_rows[0],
    },
  }
  f.clear()
  await expect(
    f.run(applySharedSourceFileRepair({ ...f.apply, repair: forged })),
  ).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
}, 60000)
