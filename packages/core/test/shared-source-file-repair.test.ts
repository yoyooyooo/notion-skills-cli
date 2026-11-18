import { expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { HttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fail, property, text } from "../src/model.ts"
import { authScope } from "../src/catalog.ts"
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
} from "../src/shared-source-file-repair.ts"
import { nativeRepairTableRow } from "../src/shared-native-table-code-repair.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { withSharedAuthoringTarget } from "../src/shared-authoring-context.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { inspectAuditSkill } from "../src/shared-audit-inspect.ts"
import { emptyAuditInventory } from "../src/shared-audit-model.ts"
import { fixture, library, ids } from "./shared-source-projection-fixture.ts"
import { encode, id, rich } from "./shared-snapshot-fixture.ts"

const rowId = id(851),
  tableId = id(850)
const annotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
}
const span = (content: string, code = false) => ({
  type: "text",
  text: { content, link: null },
  annotations: { ...annotations, code },
  plain_text: content,
  href: null,
})

async function knownFailedFile(failReadbackAfterPatch = false) {
  const f = fixture(
    [
      {
        path: "CHEATSHEET.md",
        bytes: encode(
          "# Guide\n\n| Kind | Value |\n| --- | --- |\n| Bullet | Use `•` and `a + b`. |\n",
        ),
        mode: "100644",
      },
    ],
    {
      markdownImport: true,
      recovery: true,
      readback: (wire) => wire.replace("`•`", "<code>  • </code>"),
    },
  )
  const root = mkdtempSync(join(tmpdir(), "source-file-repair-"))
  let lost: boolean | undefined
  let failBodyOnce = false
  const row = {
    object: "block",
    id: rowId,
    type: "table_row",
    has_children: false,
    archived: false,
    in_trash: false,
    parent: { type: "block_id", block_id: tableId },
    table_row: {
      cells: [
        [span("Bullet")],
        [span("Use "), span("  • ", true), span(" and "), span("a + b", true), span(".")],
      ],
    },
  }
  let tableParent: string | undefined
  const filePage = () =>
    [...f.files.values()].find(
      (value) => text(property(property(value.properties).path).rich_text) === "CHEATSHEET.md",
    )?.id
  const table = () => ({
    object: "block",
    id: tableId,
    type: "table",
    has_children: true,
    archived: false,
    in_trash: false,
    parent: { type: "page_id", page_id: tableParent ?? filePage() },
    table: { table_width: 2, has_column_header: true, has_row_header: false },
  })
  const listed = (results: unknown[]) => ({
    object: "list",
    results,
    has_more: false,
    next_cursor: null,
  })
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
                const method = options?.method ?? (body === undefined ? "GET" : "POST"),
                  route = path.split("?")[0]
                const target = filePage()
                if (
                  failBodyOnce &&
                  target !== undefined &&
                  method === "GET" &&
                  route === `v1/pages/${target}/markdown`
                ) {
                  failBodyOnce = false
                  return Effect.fail(
                    fail("NOTION_REQUEST_FAILED", "Controlled post-ACK readback interruption"),
                  )
                }
                if (
                  target !== undefined &&
                  route === `v1/blocks/${target}/children` &&
                  method === "GET"
                )
                  return Effect.succeed(listed([table()]))
                if (route === `v1/blocks/${tableId}/children` && method === "GET")
                  return Effect.succeed(listed([structuredClone(row)]))
                if (route === `v1/blocks/${tableId}` && method === "GET")
                  return Effect.succeed(table())
                if (route === `v1/blocks/${rowId}` && method === "GET")
                  return Effect.succeed(structuredClone(row))
                if (route === `v1/blocks/${rowId}` && method === "PATCH") {
                  f.calls.push({ path, method, body })
                  const cells = property(property(body).table_row).cells
                  if (!Array.isArray(cells) || target === undefined)
                    return Effect.fail(fail("TEST_FILE_REPAIR", "Expected exact row update"))
                  const raw = {
                    ...row,
                    table_row: {
                      cells: cells.map((cell) => {
                        if (!Array.isArray(cell)) throw new Error("Expected cells")
                        return cell.map((item) => {
                          const value = property(item),
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
                  const verified = nativeRepairTableRow(raw)
                  const mutation = lost
                  lost = undefined
                  if (mutation !== false) {
                    row.table_row.cells = verified.cells.map((cell) =>
                      cell.map((item) => span(item.text.content, item.annotations.code)),
                    )
                    f.base.bodies.set(
                      String(target),
                      f.base.bodies
                        .get(String(target))!
                        .replace("<code>  • </code>", "<code>•</code>"),
                    )
                  }
                  if (failReadbackAfterPatch) failBodyOnce = true
                  if (mutation !== undefined)
                    return Effect.fail(
                      fail("WRITE_OUTCOME_UNKNOWN", "Controlled missing original row response"),
                    )
                  return Effect.succeed(raw)
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
        skillId: "original-file-repair",
        enabled: false,
        markdownImport: true,
        storage: "retained",
      })
    }),
  )
  const error = await run(executeSharedCreate(library, { plan, mode: "create" }).pipe(Effect.flip))
  expect(error.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  const page = String(property(error.details).skill_page_id),
    target = String(filePage())
  expect(target).not.toBe("undefined")
  const failures = await run(
    querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      recordId: "outcome-" + plan.operation_id,
    }),
  )
  expect(failures).toHaveLength(1)
  const failed = canonicalSharedJson(failures[0]),
    before = f.base.bodies.get(target)!,
    main = f.base.bodies.get(page)!
  f.clear()
  return {
    ...f,
    run,
    plan,
    page,
    target,
    row,
    failed,
    before,
    main,
    input: { entry: library.skills.database_id, plan, target: page, path: "CHEATSHEET.md" },
    lose: (visible: boolean) => {
      lost = visible
    },
    moveTable: () => {
      tableParent = id(999)
    },
  }
}

test("one reviewed table-code patch retains the full original file and unblocks only its original recovery", async () => {
  const f = await knownFailedFile(),
    original = canonicalSharedJson(f.plan)
  const repair = await f.run(reviewSharedSourceFileRepair(f.input))
  expect(repair.review.file_page_id).toBe(f.target)
  expect(repair.before_markdown).toBe(f.before)
  expect(f.writes()).toHaveLength(0)
  const input = { ...f.input, repair, reviewId: repair.review.review_id }
  expect((await f.run(applySharedSourceFileRepair({ ...input, dryRun: true }))).remote_writes).toBe(
    0,
  )
  expect(f.writes()).toHaveLength(0)
  expect((await f.run(applySharedSourceFileRepair(input))).verified).toBe(true)
  expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
  expect(f.calls.find((call) => call.method === "PATCH")!.path).toBe("v1/blocks/" + rowId)
  expect(f.nativeCreates()).toHaveLength(0)
  expect(f.base.bodies.get(f.page)).toBe(f.main)
  expect(f.base.bodies.get(f.target)).toBe(f.before.replace("<code>  • </code>", "<code>•</code>"))
  expect(canonicalSharedJson(f.plan)).toBe(original)
  expect(
    canonicalSharedJson(
      (
        await f.run(
          querySharedRecords(library, {
            skillPageId: f.page,
            kind: "operation",
            recordId: "outcome-" + f.plan.operation_id,
          }),
        )
      )[0],
    ),
  ).toBe(f.failed)
  f.clear()
  expect((await f.run(applySharedSourceFileRepair(input))).remote_writes).toBe(0)
  expect((await f.run(reconcileSharedSourceFileRepair(input))).verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
  const recovery = await f.run(reviewSharedRetainedImportRecovery(f.input))
  expect(recovery.file_repair_proofs).toHaveLength(1)
  expect(
    (
      await f.run(
        applySharedRetainedImportRecovery({
          ...f.input,
          review: recovery,
          reviewId: recovery.review_id,
        }),
      )
    ).verified,
  ).toBe(true)
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  expect((await f.run(reconcileSharedCreate(library, f.plan))).verified).toBe(true)
  const cold = await f.run(
    withSharedAuthoringTarget(
      f.page,
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: f.page,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
        })
      }),
    ),
  )
  expect(cold.files).toHaveLength(6)
  const audit = await f.run(
    inspectAuditSkill(library, {
      page_id: f.page,
      depth: "content",
      observed_from: Date.now(),
      inventory: {
        ...emptyAuditInventory(),
        skills: [...f.skills.values()],
        files: [...f.files.values()],
        records: [...f.base.records.values()],
        sources: [f.source],
        complete: ["skills", "files", "records", "sources"],
      },
    }),
  )
  expect(
    audit.findings.filter((finding) => finding.code === "OPERATION_OUTCOME_UNOBSERVED"),
  ).toEqual([])
  expect(f.writes()).toHaveLength(0)
  for (const [key, row] of f.base.records)
    if (
      text(property(property(row.properties).record).rich_text) ===
      "source-file-repair-review-" + f.plan.operation_id + "-" + repair.review.file_id
    )
      f.base.records.delete(key)
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  await expect(f.run(reconcileSharedSourceFileRepair(input))).rejects.toBeDefined()
  await expect(f.run(reconcileSharedCreate(library, f.plan))).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
})

test.each([false, true])(
  "unknown physical row result visible=%s cannot be bypassed through ordinary retained recovery",
  async (visible) => {
    const f = await knownFailedFile(),
      repair = await f.run(reviewSharedSourceFileRepair(f.input)),
      input = { ...f.input, repair, reviewId: repair.review.review_id }
    f.lose(visible)
    await expect(f.run(applySharedSourceFileRepair(input))).rejects.toBeDefined()
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
    f.clear()
    await expect(f.run(applySharedSourceFileRepair(input))).rejects.toBeDefined()
    await expect(f.run(reviewSharedRetainedImportRecovery(f.input))).rejects.toMatchObject({
      code: "SOURCE_FILE_REPAIR_PENDING",
    })
    await expect(
      f.run(executeSharedCreate(library, { plan: f.plan, mode: "create" })),
    ).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
  },
)

test("an acknowledged row can finish missing proof without dispatching a second PATCH", async () => {
  const f = await knownFailedFile(true),
    repair = await f.run(reviewSharedSourceFileRepair(f.input))
  const input = { ...f.input, repair, reviewId: repair.review.review_id }
  await expect(f.run(applySharedSourceFileRepair(input))).rejects.toMatchObject({
    code: "NOTION_REQUEST_FAILED",
  })
  expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
  f.clear()
  const pending = await f.run(reconcileSharedSourceFileRepair(input))
  expect(pending).toMatchObject({
    status: "completion_pending",
    verified: false,
    table_row_patches: 0,
    remote_writes: 0,
    acknowledged_row_reused: true,
  })
  const dry = await f.run(applySharedSourceFileRepair({ ...input, dryRun: true }))
  expect(dry).toMatchObject({
    status: "reviewed",
    table_row_patches: 0,
    remote_writes: 0,
    acknowledged_row_reused: true,
  })
  expect(f.writes()).toHaveLength(0)
  const completed = await f.run(applySharedSourceFileRepair(input))
  expect(completed).toMatchObject({ verified: true, acknowledged_row_reused: true })
  expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(0)
  expect(f.nativeCreates()).toHaveLength(0)
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  expect((await f.run(reconcileSharedSourceFileRepair(input))).verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
})

test.each(["row", "body", "parent", "source", "ack", "review"] as const)(
  "%s drift prevents any repair write",
  async (guard) => {
    const f = await knownFailedFile(),
      repair = await f.run(reviewSharedSourceFileRepair(f.input))
    if (guard === "row") f.row.table_row.cells[0]![0] = span("Human row change")
    else if (guard === "body") f.base.bodies.set(f.target, f.before + "\nHuman edit.\n")
    else if (guard === "parent") f.moveTable()
    else if (guard === "source") f.source.properties[ids.Ref!] = rich(ids.Ref!, "new-ref")
    else if (guard === "ack")
      for (const [key, value] of f.base.json)
        if (key.includes("/source-ack-") && property(property(value).response).id === f.target)
          f.base.json.delete(key)
    f.clear()
    await expect(
      f.run(
        applySharedSourceFileRepair({
          ...f.input,
          repair,
          reviewId: guard === "review" ? "wrong" : repair.review.review_id,
        }),
      ),
    ).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
  },
)
