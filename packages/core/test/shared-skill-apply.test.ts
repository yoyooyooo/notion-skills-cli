import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { fail, property, SkillsError, text, type Snapshot } from "../src/model.ts"
import { Notion, withNotionRequestAttribution } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { fileRef, parseTarget } from "../src/ref.ts"
import { openSkill } from "../src/snapshot.ts"
import { applySkill, replaceSkill } from "../src/mutation.ts"
import { trashPath } from "../src/local-locks.ts"
import { applySharedSkillChanges } from "../src/shared-skill-apply-authoring.ts"
import {
  executeSharedSkillApply,
  loadPendingSharedSkillApplies,
  reconcileSharedSkillApply,
  resumeSharedSkillApply,
} from "../src/shared-skill-apply.ts"
import { executeSharedBodyWrite } from "../src/shared-body-write.ts"
import { appendSharedRecord } from "../src/shared-records.ts"
import {
  validateSharedSkillApplyPlan,
  type SharedSkillApplyPlan,
} from "../src/shared-skill-apply-model.ts"
import { sharedSnapshotFixture, library, skillPage, encode, id } from "./shared-snapshot-fixture.ts"
import { recordedFixtureTransport } from "./notion-http-fixture.ts"

type Fixture = ReturnType<typeof sharedSnapshotFixture>
type Environment =
  | Notion
  | Store
  | Crypto.Crypto
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
const selected = { database: library.skills.database_id }
const input = [
  {
    path: "SKILL.md",
    bytes: encode(
      "---\nname: Managed Name\ndescription: Updated description\n---\n\n# Applied main\n\n[One](references/1.md)\n",
    ),
  },
  { path: "references/1.md", bytes: encode("# Applied support\n") },
]
const metadata = { name: "Updated name", description: "Updated description", defaultContext: true }

function failure<A>(
  result:
    | { readonly _tag: "Success"; readonly success: A }
    | { readonly _tag: "Failure"; readonly failure: unknown },
): SkillsError {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected a typed SkillsError")
  return result.failure
}

function withWriter<A, E>(
  f: Fixture,
  action: Effect.Effect<A, E, Environment>,
  options: {
    readonly afterBody?: (page: string, count: number) => void
    readonly unknownBodyAt?: number
    readonly unknownParentPlan?: boolean
    readonly unknownParentOutcome?: boolean
  } = {},
) {
  return Effect.gen(function* () {
    const original = yield* Notion
    let bodyCount = 0
    const api: Notion["Service"] = {
      ...original,
      request: (path, body, requestOptions) => {
        if (path === "v1/pages") {
          const recordId = text(property(property(property(body).properties).record).rich_text)
          if (options.unknownParentPlan && recordId.startsWith("skill-apply-"))
            return Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "The original apply plan was not observed."),
            )
          if (options.unknownParentOutcome && recordId.startsWith("outcome-skill-apply-"))
            return Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "The original apply completion was not observed."),
            )
          return original.request(path, body, requestOptions)
        }
        if (requestOptions?.method !== "PATCH") return original.request(path, body, requestOptions)
        return Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
          f.calls.push({ path, method: "PATCH", body })
          const match = /^v1\/pages\/([^/]+)\/markdown$/u.exec(path)
          if (match !== null) {
            const page = match[1]!,
              raw = f.bodies.get(page),
              updates = property(property(body).update_content).content_updates
            if (raw === undefined || !Array.isArray(updates) || updates.length !== 1)
              return Effect.fail(fail("TEST_BODY_REQUEST", "Expected one complete old-body match."))
            const changed = property(updates[0])
            if (
              typeof changed.old_str !== "string" ||
              changed.old_str === "" ||
              typeof changed.new_str !== "string" ||
              !raw.includes(changed.old_str)
            )
              return Effect.fail(
                fail("NOTION_REQUEST_FAILED", "Definitive original stale body rejection", {
                  phase: "definitive_rejection",
                  http_status: 400,
                  notion_code: "validation_error",
                }),
              )
            const markdown = raw.replace(changed.old_str, changed.new_str)
            f.bodies.set(page, markdown)
            const row = page === skillPage ? f.main : f.files.find((file) => file.id === page)
            if (row !== undefined) row.last_edited_time = new Date().toISOString()
            bodyCount++
            options.afterBody?.(page, bodyCount)
            return options.unknownBodyAt === bodyCount
              ? Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "The original child response was lost."))
              : Effect.succeed({ id: page, markdown, truncated: false, unknown_block_ids: [] })
          }
          const page = /^v1\/pages\/([^/]+)$/u.exec(path)?.[1]
          const row = page === skillPage ? f.main : f.files.find((file) => file.id === page)
          if (row === undefined)
            return Effect.fail(
              fail("TEST_UNEXPECTED_PATCH", "An unrelated native page was patched."),
            )
          const properties = property(row.properties)
          for (const [propertyId, value] of Object.entries(property(property(body).properties))) {
            const key = Object.entries(properties).find(
              ([key, raw]) => key === propertyId || property(raw).id === propertyId,
            )?.[0]
            if (key === undefined)
              return Effect.fail(
                fail("TEST_PROPERTY", "An unregistered native property was patched."),
              )
            properties[key] = { ...property(properties[key]), ...property(value) }
          }
          row.last_edited_time = new Date().toISOString()
          return Effect.succeed(structuredClone(row))
        })
      },
    }
    return yield* action.pipe(Effect.provideService(Notion, api))
  })
}

async function fresh(f: Fixture): Promise<Snapshot> {
  await f.target(parseTarget(skillPage), selected)
  return f.run(openSkill(skillPage, { ...selected, refresh: true, sharedReadOnly: true }))
}
async function prepared(f: Fixture, snapshot: Snapshot): Promise<SharedSkillApplyPlan> {
  const result = await f.run(
    applySharedSkillChanges(snapshot, { files: input, ...metadata, dryRun: true }),
  )
  if (result.status !== "planned" || result.kind !== "skill_apply")
    throw new Error("Expected a complete apply plan")
  return result.plan
}
function payloads(f: Fixture) {
  return [...f.records.values()].map((row) =>
    property(
      property(JSON.parse(text(property(property(row.properties).payload).rich_text))).payload,
    ),
  )
}

describe("frozen sequential shared apply", () => {
  test("actual parent and child HTTP attempts keep their own author phase and original operation", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f),
      plan = await prepared(f, snapshot),
      fixture = await f.run(withWriter(f, Notion))
    await recordedFixtureTransport(fixture, async (api, requests) => {
      const result = await f.run(
        withNotionRequestAttribution(executeSharedSkillApply(library, { plan, mode: "create" }), {
          phase: "author_preflight",
          skill_page_id: skillPage,
          operation_id: null,
        }).pipe(Effect.provideService(Notion, api)),
      )
      expect(result.status).toBe("applied")
      const metrics = api.requestMetrics!()
      expect(metrics.trace_dropped).toBe(0)
      const writes = metrics.trace.filter(
        (entry) => entry.event === "attempt" && entry.kind === "notion_write",
      )
      expect(writes.length).toBeGreaterThan(0)
      for (const attempt of writes) {
        if (attempt.event !== "attempt") throw new Error("Expected actual HTTP attempt")
        const request = requests.find((entry) => entry.request_id === attempt.request_id)
        if (request === undefined) throw new Error("Missing exact request/response identity")
        const record = text(property(property(property(request.body).properties).record).rich_text)
        const expected =
          request.method === "PATCH"
            ? request.path.endsWith("/markdown")
              ? plan.bodies.find((child) => request.path === `v1/pages/${child.page_id}/markdown`)!
                  .operation_id
              : plan.metadata!.operation_id
            : record === plan.operation_id || record === `outcome-${plan.operation_id}`
              ? plan.operation_id
              : (plan.bodies.find(
                  (child) =>
                    record === child.operation_id ||
                    record === `outcome-${child.operation_id}` ||
                    record === child.event.event_id ||
                    record === `body-${child.before.fingerprint.sha256}` ||
                    record === `body-${child.candidate.content.sha256}`,
                )?.operation_id ??
                (record === plan.metadata!.operation_id ||
                record === `outcome-${plan.metadata!.operation_id}`
                  ? plan.metadata!.operation_id
                  : undefined))
        if (expected === undefined)
          throw new Error("A write does not belong to any frozen parent or child fact")
        expect(attempt.attribution).toEqual({
          phase: "author_apply",
          skill_page_id: skillPage,
          operation_id: expected,
        })
      }
      expect(
        writes.filter((entry) => entry.attribution?.operation_id === plan.operation_id),
      ).toHaveLength(2)
      for (const child of [...plan.bodies, plan.metadata!])
        expect(writes.some((entry) => entry.attribution?.operation_id === child.operation_id)).toBe(
          true,
        )
      expect(
        metrics.trace.some(
          (entry) => entry.event === "attempt" && entry.attribution?.phase === "author_verify",
        ),
      ).toBe(true)
    })
  })

  test("one original batch changes main, supporting body and nominated metadata; old pin bytes remain", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f),
      old = structuredClone(f.json.get(`snapshots/${snapshot.snapshot_id}.json`)),
      plan = await prepared(f, snapshot)
    expect(plan.bodies).toHaveLength(2)
    expect(plan.metadata?.changes).toHaveLength(3)
    f.clearCalls()
    const result = await f.run(
      withWriter(f, executeSharedSkillApply(library, { plan, mode: "create" })),
    )
    expect(result.status).toBe("applied")
    expect(result.protection.atomic).toBe(false)
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(3)
    expect(f.bodies.get(skillPage)).toBe(
      `# Applied main\n\n[One](https://app.notion.com/p/${id(11).replaceAll("-", "")})`,
    )
    expect(f.bodies.get(f.files[0]!.id)).toBe("# Applied support")
    expect(text(property(property(f.main.properties).title).title)).toBe(metadata.name)
    expect(f.json.get(`snapshots/${snapshot.snapshot_id}.json`)).toEqual(old)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
    const apply = payloads(f).find((value) => value.kind === "skill_apply")
    expect(apply?.operation_id).toBe(plan.operation_id)
    expect(payloads(f).find((value) => value.kind === "skill_apply_outcome")?.status).toBe(
      "applied",
    )
  })

  test("dry-run preflights every file and property without a pending receipt or Notion write", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f)
    f.clearCalls()
    const plan = await prepared(f, snapshot)
    expect(plan.bodies[0]?.input_projection?.removed_terminal_lfs).toBe(1)
    expect(f.writeCount()).toBe(0)
    expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
  })

  test("a later child stale preflight records an exact partial outcome and retains the new user body", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f),
      plan = await prepared(f, snapshot)
    f.clearCalls()
    const result = failure(
      await f.run(
        withWriter(f, executeSharedSkillApply(library, { plan, mode: "create" }), {
          afterBody: (_page, count) => {
            if (count === 1) f.bodies.set(f.files[0]!.id, "Later user support edit\n")
          },
        }).pipe(Effect.result),
      ),
    )
    expect(result.code).toBe("SHARED_APPLY_PARTIAL")
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
    expect(f.bodies.get(f.files[0]!.id)).toBe("Later user support edit\n")
    const outcome = payloads(f).find((value) => value.kind === "skill_apply_outcome")
    expect(outcome?.status).toBe("partial")
    const children = property(outcome).children
    if (!Array.isArray(children)) throw new Error("Expected exact original child outcomes")
    expect(
      children.map((child) => ({
        operation_id: property(child).operation_id,
        status: property(child).status,
      })),
    ).toEqual([
      { operation_id: plan.bodies[0]!.operation_id, status: "applied" },
      { operation_id: plan.bodies[1]!.operation_id, status: "not_sent" },
      { operation_id: plan.metadata!.operation_id, status: "not_sent" },
    ])
    f.clearCalls()
    expect((await f.run(reconcileSharedSkillApply(library, plan))).status).toBe("partial")
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
  })

  test("unknown child stops the batch and original recovery cannot infer unsent remaining work", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f),
      plan = await prepared(f, snapshot)
    const result = failure(
      await f.run(
        withWriter(f, executeSharedSkillApply(library, { plan, mode: "create" }), {
          unknownBodyAt: 2,
        }).pipe(Effect.result),
      ),
    )
    expect(result.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(property(result.details).apply_operation_id).toBe(plan.operation_id)
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(2)
    expect(
      payloads(f).some(
        (value) => value.kind === "metadata_write" || value.kind === "skill_apply_outcome",
      ),
    ).toBe(false)
    f.clearCalls()
    const again = failure(
      await f.run(executeSharedSkillApply(library, { plan, mode: "create" }).pipe(Effect.result)),
    )
    expect(property(again.details).apply_operation_id).toBe(plan.operation_id)
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(true)
  })

  test("a lost final parent POST is recoverable from every original child's exact shared outcome", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f),
      plan = await prepared(f, snapshot)
    expect(
      failure(
        await f.run(
          withWriter(f, executeSharedSkillApply(library, { plan, mode: "create" }), {
            unknownParentOutcome: true,
          }).pipe(Effect.result),
        ),
      ).code,
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(payloads(f).some((value) => value.kind === "skill_apply_outcome")).toBe(false)
    f.clearCalls()
    const result = await f.run(reconcileSharedSkillApply(library, plan))
    expect(result.status).toBe("applied")
    expect(result.verification).toBe("exact_child_outcomes")
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
    expect(await f.run(loadPendingSharedSkillApplies(library, { skillPageId: skillPage }))).toEqual(
      [],
    )
  })

  test("an invisible original parent fences a standard fresh read before any current body can be adopted", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f),
      plan = await prepared(f, snapshot)
    expect(
      failure(
        await f.run(
          withWriter(f, executeSharedSkillApply(library, { plan, mode: "create" }), {
            unknownParentPlan: true,
          }).pipe(Effect.result),
        ),
      ).code,
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(payloads(f).some((value) => value.kind === "skill_apply")).toBe(false)
    f.bodies.set(skillPage, "A later body cannot resolve an invisible original plan")
    f.clearCalls()
    const result = failure(
      await f.run(openSkill(skillPage, { ...selected, refresh: true }).pipe(Effect.result)),
    )
    expect(property(result.details).apply_operation_id).toBe(plan.operation_id)
    expect(f.readBodyCount()).toBe(0)
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(true)
  })

  test("a standard fresh read resolves an exact completed parent before reloading its new snapshot", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f),
      plan = await prepared(f, snapshot)
    expect(
      failure(
        await f.run(
          withWriter(f, executeSharedSkillApply(library, { plan, mode: "create" }), {
            unknownParentOutcome: true,
          }).pipe(Effect.result),
        ),
      ).code,
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    f.clearCalls()
    const first = failure(
      await f.run(openSkill(skillPage, { ...selected, refresh: true }).pipe(Effect.result)),
    )
    expect(first.code).toBe("SHARED_APPLY_RECONCILED")
    expect(property(first.details).apply_operation_id).toBe(plan.operation_id)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
    const current = await f.run(openSkill(skillPage, { ...selected, refresh: true }))
    expect(current.snapshot_id).not.toBe(snapshot.snapshot_id)
    expect(current.record.name).toBe(metadata.name)
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
  })

  test("completed normal apply scans small outcomes without old full parent or child bodies", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f),
      plan = await prepared(f, snapshot)
    await f.run(withWriter(f, executeSharedSkillApply(library, { plan, mode: "create" })))
    f.clearCalls()
    expect(await f.run(loadPendingSharedSkillApplies(library, { skillPageId: skillPage }))).toEqual(
      [],
    )
    expect(f.calls).toHaveLength(2)
    expect(f.calls.every((call) => !call.path.includes("/markdown"))).toBe(true)
    expect(JSON.stringify(f.calls[1]?.body)).toContain("skill-apply-outcomes-v1")
  })

  test("an existing malformed child outcome cannot be relabelled not_sent by its parent", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f),
      plan = await prepared(f, snapshot),
      child = plan.bodies[0]!
    await f.run(withWriter(f, executeSharedBodyWrite(library, { plan: child, mode: "create" })))
    for (const [key, row] of f.records)
      if (
        text(property(property(row.properties).record).rich_text) ===
        `outcome-${child.operation_id}`
      )
        f.records.delete(key)
    await f.run(
      appendSharedRecord(library, {
        mode: "create",
        recordId: `outcome-${child.operation_id}`,
        operationId: child.operation_id,
        skillPageId: skillPage,
        kind: "operation",
        entityId: "body-write-outcomes-v1",
        payload: {
          version: 1,
          kind: "body_write_outcome",
          operation_id: child.operation_id,
          status: "invalid",
        },
      }),
    )
    f.clearCalls()
    const result = failure(
      await f.run(
        withWriter(f, executeSharedSkillApply(library, { plan, mode: "create" })).pipe(
          Effect.result,
        ),
      ),
    )
    expect(result.code).not.toBe("SHARED_APPLY_PARTIAL")
    expect(payloads(f).some((value) => value.kind === "skill_apply_outcome")).toBe(false)
    expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(true)
  })

  test("a retained parent completion cannot hide a missing child plan and outcome", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f),
      plan = await prepared(f, snapshot)
    await f.run(withWriter(f, executeSharedSkillApply(library, { plan, mode: "create" })))
    const child = plan.bodies[0]!.operation_id
    for (const [key, row] of f.records)
      if (
        [child, `outcome-${child}`].includes(
          text(property(property(row.properties).record).rich_text),
        )
      )
        f.records.delete(key)
    f.clearCalls()
    expect(
      failure(
        await f.run(
          loadPendingSharedSkillApplies(library, { skillPageId: skillPage }).pipe(Effect.result),
        ),
      ).code,
    ).toBe("SHARED_APPLY_UNRESOLVED")
    expect(
      f.calls.some(
        (call) =>
          call.method === "PATCH" || call.path === "v1/pages" || call.path.includes("/markdown"),
      ),
    ).toBe(false)
  })

  test("child substitution, foreign identity and incomplete batch input fail before dispatch", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f),
      plan = await prepared(f, snapshot)
    f.clearCalls()
    for (const value of [
      { ...plan, bodies: [...plan.bodies].reverse() },
      { ...plan, skill_id: "foreign" },
      { ...plan, bodies: [plan.bodies[0]] },
      { ...plan, snapshot_version_id: "other" },
    ])
      expect((await f.run(validateSharedSkillApplyPlan(value).pipe(Effect.result)))._tag).toBe(
        "Failure",
      )
    expect(f.writeCount()).toBe(0)
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(0)
  })

  test("the combined 64 KiB envelope limit fails before poisoning any dispatch receipt", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f)
    f.clearCalls()
    const result = failure(
      await f.run(
        applySharedSkillChanges(snapshot, {
          files: [
            { path: "SKILL.md", bytes: encode("A".repeat(36_000)) },
            { path: "references/1.md", bytes: encode("B".repeat(36_000)) },
          ],
        }).pipe(Effect.result),
      ),
    )
    expect(result.code).toBe("SHARED_RECORD_TOO_LARGE")
    expect(f.writeCount()).toBe(0)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
  })

  test("a parent retains moderate edits without repeating child projection text and can reconcile them", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f)
    const preview = await f.run(
      applySharedSkillChanges(snapshot, {
        files: [
          { path: "SKILL.md", bytes: encode("A".repeat(20_000)) },
          { path: "references/1.md", bytes: encode("B".repeat(20_000)) },
        ],
        dryRun: true,
      }),
    )
    if (preview.kind !== "skill_apply" || preview.status !== "planned")
      throw new Error("Expected frozen parent")
    expect(Buffer.byteLength(JSON.stringify(preview.plan))).toBeGreaterThan(65536)
    expect(
      (
        await f.run(
          withWriter(f, executeSharedSkillApply(library, { plan: preview.plan, mode: "create" })),
        )
      ).status,
    ).toBe("applied")
    f.clearCalls()
    expect((await f.run(reconcileSharedSkillApply(library, preview.plan))).verified).toBe(true)
    expect(f.writeCount()).toBe(0)
  })

  test("equal bytes plus an explicit removal are not guessed as a move", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f)
    const original = snapshot.files.find((file) => file.path === "references/1.md")
    if (original === undefined) throw new Error("Missing reference")
    const stored = await f.run(
      Effect.gen(function* () {
        return yield* (yield* Store).readBytes(`objects/${original.sha256}`)
      }),
    )
    f.clearCalls()
    const result = failure(
      await f.run(
        applySharedSkillChanges(snapshot, {
          files: [{ path: "references/copy.md", bytes: stored }],
          remove: ["references/1.md"],
        }).pipe(Effect.result),
      ),
    )
    expect(result.code).toBe("SHARED_APPLY_IMPLICIT_MOVE")
    expect(f.writeCount()).toBe(0)
    expect(f.files).toHaveLength(2)
  })

  test("a fenced example is not a link rewrite span", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f)
    const main = snapshot.files.find((file) => file.path === snapshot.entrypoint)
    if (main === undefined) throw new Error("Missing main")
    const text = new TextDecoder().decode(
      await f.run(
        Effect.gen(function* () {
          return yield* (yield* Store).readBytes(`objects/${main.sha256}`)
        }),
      ),
    )
    const fenced = `${text}\n\n\`\`\`\n[Example](references/1.md)\n\`\`\`\n`
    const start = fenced.indexOf("references/1.md")
    f.clearCalls()
    const result = failure(
      await f.run(
        applySharedSkillChanges(snapshot, {
          files: [{ path: snapshot.entrypoint, bytes: encode(fenced) }],
          changes: {
            version: 1,
            rewrites: [
              {
                path: snapshot.entrypoint,
                start,
                end: start + "references/1.md".length,
                from: "references/1.md",
                to: "references/2.md",
              },
            ],
          },
        }).pipe(Effect.result),
      ),
    )
    expect(result.code).toBe("SHARED_APPLY_REWRITE_SPAN")
    expect(f.writeCount()).toBe(0)
  })

  test.each(["100644", "100755", undefined] as const)(
    "complete apply revives the same native file with retained mode %s",
    async (mode) => {
      const f = sharedSnapshotFixture(),
        snapshot = await fresh(f)
      const path = "references/restore-mode.md"
      await f.run(
        withWriter(
          f,
          applySharedSkillChanges(snapshot, {
            files: [
              { path, bytes: encode("# Retained body\n"), ...(mode === undefined ? {} : { mode }) },
              { path: "references/unchanged.md", bytes: encode("# Unchanged body\n") },
            ],
          }),
        ),
      )
      const added = await fresh(f)
      const original = added.files.find((file) => file.path === path)
      expect(original?.mode).toBe(mode)
      const sourceRows = structuredClone(f.files)
      await f.run(
        withWriter(
          f,
          applySharedSkillChanges(added, {
            files: [],
            changes: { version: 1, removes: [path] },
          }),
        ),
      )
      const deleted = await fresh(f)
      expect(deleted.files.some((file) => file.path === path)).toBe(false)
      f.clearCalls()
      const preview = await f.run(
        applySharedSkillChanges(deleted, {
          files: [],
          changes: { version: 1, revives: [{ path }] },
          dryRun: true,
        }),
      )
      if (
        preview.status !== "planned" ||
        preview.kind !== "skill_apply" ||
        preview.plan.version !== 2
      )
        throw new Error("Expected a complete revival parent")
      expect(f.writeCount()).toBe(0)
      expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
      expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
      const revived = await f.run(
        withWriter(
          f,
          executeSharedSkillApply(library, {
            plan: preview.plan,
            mode: "create",
          }),
        ),
      )
      expect(revived.status).toBe("applied")
      expect(preview.plan.final_files.find((file) => file.path === path)?.mode).toBe(mode)
      const current = await fresh(f)
      expect(current.files.find((file) => file.path === path)).toEqual(original)
      expect(f.files.map((file) => file.id)).toEqual(sourceRows.map((file) => file.id))
      expect(deleted.files.some((file) => file.path === path)).toBe(false)
    },
  )

  test.each([true, false])(
    "complete tree reconstruction rejects unavailable retained bytes before writes, dryRun=%s",
    async (dryRun) => {
      const f = sharedSnapshotFixture(),
        snapshot = await fresh(f)
      const preview = await f.run(
        applySharedSkillChanges(snapshot, {
          files: [
            { path: "references/complete-tree.md", bytes: encode("# Added\n"), mode: "100644" },
            { path: "references/second-added.md", bytes: encode("# Second added\n") },
          ],
          dryRun: true,
        }),
      )
      if (
        preview.status !== "planned" ||
        preview.kind !== "skill_apply" ||
        preview.plan.version !== 2
      )
        throw new Error("Expected a complete layout parent")
      const retained = snapshot.files.find((file) => file.path === "references/2.md")
      if (retained === undefined) throw new Error("Missing untouched file")
      f.objects.delete(`objects/${retained.sha256}`)
      f.clearCalls()
      const result = await f.run(
        executeSharedSkillApply(library, {
          plan: preview.plan,
          mode: "create",
          dryRun,
        }).pipe(Effect.result),
      )
      expect(f.writeCount()).toBe(0)
      expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
      expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
      expect(failure(result).code).toBe("SNAPSHOT_MISSING")
    },
  )

  test.each([true, false])(
    "links to not-yet-allocated native pages fail before any write, dryRun=%s",
    async (dryRun) => {
      const f = sharedSnapshotFixture(),
        snapshot = await fresh(f)
      f.clearCalls()
      const result = await f.run(
        applySharedSkillChanges(snapshot, {
          files: [
            { path: "SKILL.md", bytes: encode("# Main\n\n[New](references/new-a.md)\n") },
            { path: "references/new-a.md", bytes: encode("# A\n\n[B](new-b.md)\n") },
            { path: "references/new-b.md", bytes: encode("# B\n\n[A](new-a.md)\n") },
          ],
          dryRun,
        }).pipe(Effect.result),
      )
      expect(failure(result).code).toBe("SHARED_NATIVE_REFERENCE_UNBOUND")
      expect(property(failure(result).details).writes_sent).toBe(false)
      expect(f.writeCount()).toBe(0)
      expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
    },
  )

  test("main plus two unlinked new files is one parent apply and keeps omitted files", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f)
    const beforeIds = f.files.map((file) => file.id)
    f.clearCalls()
    const result = await f.run(
      withWriter(
        f,
        applySharedSkillChanges(snapshot, {
          files: [
            input[0]!,
            {
              path: "references/new-a.md",
              mode: "100644" as const,
              bytes: encode("# A\n\nStage the content before linking a new page.\n"),
            },
            {
              path: "references/new-b.md",
              mode: "100755" as const,
              bytes: encode("# B\n\nStage the content before linking a new page.\n"),
            },
          ],
          ...metadata,
        }),
      ),
    )
    expect(result.status).toBe("applied")
    expect(result.kind).toBe("skill_apply")
    if (result.kind !== "skill_apply" || result.status !== "applied")
      throw new Error("Expected one applied parent")
    expect(result.plan.version).toBe(2)
    if (result.plan.version !== 2) throw new Error("Expected a version 2 parent")
    expect(result.plan.stages.map((stage) => stage.name)).toEqual([
      "allocate",
      "author",
      "metadata",
    ])
    expect(f.files).toHaveLength(beforeIds.length + 2)
    expect(f.files.slice(0, beforeIds.length).map((file) => file.id)).toEqual(beforeIds)
    const current = await fresh(f)
    expect(current.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "references/1.md",
      "references/2.md",
      "references/new-a.md",
      "references/new-b.md",
    ])
    expect(current.files.find((file) => file.path === "references/2.md")?.sha256).toBe(
      snapshot.files.find((file) => file.path === "references/2.md")?.sha256,
    )
    const rows = payloads(f).filter((value) => value.kind === "skill_apply")
    expect(rows).toHaveLength(1)
    f.clearCalls()
    f.json.clear()
    const stored = rows[0]
    const recovered = await f.run(
      reconcileSharedSkillApply(library, stored as SharedSkillApplyPlan),
    )
    expect(recovered.status).toBe("applied")
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
    const rowsBeforeRepeat = payloads(f).length
    const repeatedFiles = await f.run(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* Effect.forEach(
          current.files.filter((file) =>
            ["SKILL.md", "references/new-a.md", "references/new-b.md"].includes(file.path),
          ),
          (file) =>
            store
              .readBytes(`objects/${file.sha256}`)
              .pipe(Effect.map((bytes) => ({ path: file.path, bytes }))),
        )
      }),
    )
    const repeated = await f.run(
      applySharedSkillChanges(current, { files: repeatedFiles, ...metadata }),
    )
    expect(repeated.status).toBe("unchanged")
    expect(payloads(f)).toHaveLength(rowsBeforeRepeat)
    expect(current.record.name).toBe(metadata.name)
    expect(current.record.description).toBe(metadata.description)
    expect(current.files.find((file) => file.path === "references/new-a.md")?.mode).toBe("100644")
    expect(current.files.find((file) => file.path === "references/new-b.md")?.mode).toBe("100755")
  })

  test("resume continues only the proved-unsent suffix of the same parent", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f)
    const planned = await f.run(
      applySharedSkillChanges(snapshot, {
        files: [
          { path: "references/new-a.md", bytes: encode("# A\n") },
          { path: "references/new-b.md", bytes: encode("# B\n") },
        ],
        dryRun: true,
      }),
    )
    if (
      planned.status !== "planned" ||
      planned.kind !== "skill_apply" ||
      planned.plan.version !== 2
    )
      throw new Error("Expected a frozen parent")
    expect(planned.plan.layout).toHaveLength(2)
    const parent = planned.plan,
      second = parent.layout[1]!
    let interrupted = false
    const stopped = await f.run(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* executeSharedSkillApply(library, { plan: parent, mode: "create" }).pipe(
          Effect.provideService(Store, {
            ...store,
            writeJson: (key, value) => {
              if (
                !interrupted &&
                key.startsWith("operations/shared-observation-pending/") &&
                property(property(value).plan).operation_id === second.operation_id
              ) {
                interrupted = true
                return Effect.fail(
                  fail(
                    "TEST_STOP_BEFORE_INTENT",
                    "Process stopped before the second child's durable intent",
                  ),
                )
              }
              return store.writeJson(key, value)
            },
          }),
        )
      }).pipe(Effect.result),
    )
    expect(stopped).toMatchObject({ _tag: "Failure", failure: { code: "TEST_STOP_BEFORE_INTENT" } })
    expect(
      f.files.filter(
        (file) =>
          text(property(property(file.properties).file_id).rich_text) === parent.layout[0]!.file_id,
      ),
    ).toHaveLength(1)
    expect(
      f.files.filter(
        (file) => text(property(property(file.properties).file_id).rich_text) === second.file_id,
      ),
    ).toHaveLength(0)
    const blocked = await f.run(
      openSkill(skillPage, { ...selected, refresh: true, sharedReadOnly: true }).pipe(
        Effect.result,
      ),
    )
    expect(blocked._tag).toBe("Failure")
    f.clearCalls()
    const resumed = await f.run(resumeSharedSkillApply(library, parent))
    expect(resumed.status).toBe("applied")
    expect(resumed.operation_id).toBe(parent.operation_id)
    expect(
      f.files.filter(
        (file) => text(property(property(file.properties).file_id).rich_text) === second.file_id,
      ),
    ).toHaveLength(1)
    expect(
      f.calls.filter(
        (call) =>
          call.path === "v1/pages" &&
          property(property(call.body).parent).data_source_id === library.files.data_source_id,
      ),
    ).toHaveLength(1)
    f.clearCalls()
    expect((await f.run(reconcileSharedSkillApply(library, parent))).verified).toBe(true)
    expect(f.calls.some((call) => call.path === "v1/pages" || call.method === "PATCH")).toBe(false)
  })

  test("a lost first allocation response cannot be replayed or skipped by parent resume", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await fresh(f)
    const planned = await f.run(
      applySharedSkillChanges(snapshot, {
        files: [
          { path: "references/new-a.md", bytes: encode("# A\n") },
          { path: "references/new-b.md", bytes: encode("# B\n") },
        ],
        dryRun: true,
      }),
    )
    if (planned.status !== "planned" || planned.kind !== "skill_apply")
      throw new Error("Expected parent")
    let lost = false
    const result = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* executeSharedSkillApply(library, { plan: planned.plan, mode: "create" }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              if (
                !lost &&
                path === "v1/pages" &&
                property(property(body).parent).data_source_id === library.files.data_source_id
              ) {
                lost = true
                return api
                  .request(path, body, options)
                  .pipe(
                    Effect.flatMap(() =>
                      Effect.fail(
                        fail("WRITE_OUTCOME_UNKNOWN", "Original allocation response lost"),
                      ),
                    ),
                  )
              }
              return api.request(path, body, options)
            },
          }),
        )
      }).pipe(Effect.result),
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_OUTCOME_UNKNOWN" } })
    const count = f.files.length
    f.clearCalls()
    const resumed = await f.run(resumeSharedSkillApply(library, planned.plan).pipe(Effect.result))
    expect(resumed).toMatchObject({ _tag: "Failure", failure: { code: "SHARED_APPLY_UNRESOLVED" } })
    expect(f.files).toHaveLength(count)
    expect(f.calls.some((call) => call.path === "v1/pages" || call.method === "PATCH")).toBe(false)
  })
})

describe("public shared apply and replace routing", () => {
  async function replacement(f: Fixture, snapshot: Snapshot) {
    const files = await f.run(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* Effect.forEach(snapshot.files, (file) =>
          store
            .readBytes(`objects/${file.sha256}`)
            .pipe(Effect.map((bytes) => ({ path: file.path, bytes }))),
        )
      }),
    )
    return {
      kind: snapshot.record.kind,
      name: snapshot.record.name,
      description: snapshot.record.description,
      main: snapshot.entrypoint,
      files,
    }
  }

  test("public shared replace removes one omitted resource with equal retained files and metadata", async () => {
    const f = sharedSnapshotFixture(),
      baseline = await fresh(f)
    const complete = await replacement(f, baseline)
    const input = {
      ...complete,
      files: complete.files.filter((file) => file.path !== "references/2.md"),
    }
    const options = { target: baseline, defaultContext: baseline.record.default_context }
    f.clearCalls()
    const preview = await f.run(withWriter(f, replaceSkill(input, { ...options, dryRun: true })))
    expect(preview.operation).toBe("replace")
    expect(property(preview).changes).toEqual({ files: [], removed: ["references/2.md"] })
    expect(f.writeCount()).toBe(0)
    const result = await f.run(withWriter(f, replaceSkill(input, options)))
    expect(result.operation).toBe("replace")
    expect(property(result).status).toBe("applied")
    expect(property(result).changes).toEqual({ files: [], removed: ["references/2.md"] })
    expect(f.calls.some((call) => call.method === "PATCH" && call.path.endsWith("/markdown"))).toBe(
      false,
    )
    const current = await fresh(f)
    expect(current.files.map((file) => file.path)).toEqual(
      baseline.files.filter((file) => file.path !== "references/2.md").map((file) => file.path),
    )
    expect(current.record.name).toBe(baseline.record.name)
    expect(current.record.description).toBe(baseline.record.description)
    expect(current.record.default_context).toBe(baseline.record.default_context)
  })

  for (const variant of ["body", "metadata", "multiple", "duplicate"] as const) {
    test(`public shared replace rejects ${variant} combined with omission before writes`, async () => {
      const f = sharedSnapshotFixture(),
        baseline = await fresh(f)
      const complete = await replacement(f, baseline)
      let files = complete.files.filter((file) => file.path !== "references/2.md")
      if (variant === "body")
        files = files.map((file) =>
          file.path === baseline.entrypoint
            ? {
                ...file,
                bytes: encode(new TextDecoder().decode(file.bytes) + "\nA real body edit.\n"),
              }
            : file,
        )
      if (variant === "multiple") files = files.filter((file) => file.path === baseline.entrypoint)
      if (variant === "duplicate") files = [...files, files[0]!]
      f.clearCalls()
      const error = failure(
        await f.run(
          withWriter(
            f,
            replaceSkill(
              { ...complete, files },
              {
                target: baseline,
                ...(variant === "metadata" ? { description: "A real metadata edit" } : {}),
              },
            ),
          ).pipe(Effect.result),
        ),
      )
      expect(error.code).toBe(
        variant === "duplicate" ? "INVALID_ARCHIVE" : "SHARED_APPLY_LAYOUT_BATCH_UNSUPPORTED",
      )
      expect(f.writeCount()).toBe(0)
      expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
    })
  }

  test.each(["100644", "100755", undefined] as const)(
    "public pinned apply preserves isolated added file mode %s",
    async (mode) => {
      const f = sharedSnapshotFixture(),
        baseline = await fresh(f)
      const directory = mkdtempSync(join(tmpdir(), "shared-public-add-mode-"))
      const path = "single-added.md",
        markdown = "# Single supporting file\n\nOriginal added body.\n"
      const inputPath = join(directory, path)
      writeFileSync(inputPath, markdown)
      if (mode !== undefined) chmodSync(inputPath, mode === "100755" ? 0o755 : 0o644)
      // A bare Markdown input has no imported mode; directories retain stat metadata.
      const options = { input: mode === undefined ? inputPath : directory }
      const ref = fileRef(baseline.record.id, baseline.entrypoint, baseline.snapshot_id)
      const beforeIds = f.files.map((file) => file.id)
      try {
        f.clearCalls()
        const preview = await f.run(applySkill(ref, { ...options, dryRun: true }))
        expect(property(preview).status).toBe("planned")
        expect(f.writeCount()).toBe(0)
        expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
        expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
        const result = await f.run(withWriter(f, applySkill(ref, options)))
        expect(result.operation).toBe("apply")
        expect(property(result).status).toBe("applied")
        expect(property(result).verified).toBe(true)
        expect(property(result).changes).toEqual({ files: [path], removed: [] })
        const current = await fresh(f)
        const added = current.files.find((file) => file.path === path)
        if (added === undefined) throw new Error("Missing isolated added file")
        expect(added.mode).toBe(mode)
        expect(new TextDecoder().decode(f.objects.get(`objects/${added.sha256}`)).trimEnd()).toBe(
          markdown.trimEnd(),
        )
        expect(current.files.filter((file) => file.path !== path)).toEqual([...baseline.files])
        expect(f.files).toHaveLength(beforeIds.length + 1)
        expect(f.files.slice(0, beforeIds.length).map((file) => file.id)).toEqual(beforeIds)
        const plans = payloads(f).filter(
          (value) => value.kind === "file_management" && value.action === "add",
        )
        expect(plans).toHaveLength(1)
        expect(plans[0]?.creation_mode).toBe(mode)
        expect(property(property(plans[0]?.content).retained).mode).toBe(mode)
        expect(payloads(f).some((value) => value.kind === "skill_apply")).toBe(false)
      } finally {
        if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
      }
    },
  )

  test("one public pinned apply maintains main, resource and metadata despite an unrelated broken source", async () => {
    const f = sharedSnapshotFixture(),
      baseline = await fresh(f)
    f.json.set("config.json", {
      sources: [
        {
          alias: "unrelated-broken",
          database_id: id(5000),
          data_source_ids: [id(5001)],
          title: "Guizang",
          role: "content",
        },
      ],
    })
    const directory = mkdtempSync(join(tmpdir(), "shared-public-apply-"))
    mkdirSync(join(directory, "references"))
    for (const file of input) writeFileSync(join(directory, file.path), file.bytes)
    try {
      f.clearCalls()
      const result = await f.run(
        withWriter(
          f,
          applySkill(fileRef(baseline.record.id, baseline.entrypoint, baseline.snapshot_id), {
            input: directory,
            ...metadata,
          }),
        ),
      )
      expect(result.operation).toBe("apply")
      expect(property(result).status).toBe("applied")
      expect(property(property(result).record).name).toBe(metadata.name)
      expect(property(result).snapshot_id).not.toBe(baseline.snapshot_id)
      expect(property(result).changes).toEqual({
        files: ["SKILL.md", "references/1.md"],
        removed: [],
      })
      expect(
        f.calls.some(
          (call) =>
            call.path.includes(id(5000)) ||
            call.path.includes(id(5001)) ||
            call.path.includes("/ai/skills/") ||
            call.path.includes("/search"),
        ),
      ).toBe(false)
      expect([...f.json.keys()].some((key) => key.startsWith("publications/"))).toBe(false)
    } finally {
      if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
    }
  })

  test("public shared replace uses the same native original plans without legacy publication", async () => {
    const f = sharedSnapshotFixture(),
      baseline = await fresh(f)
    const files = [...input, { path: "references/2.md", bytes: encode("Reference two\n") }]
    const result = await f.run(
      withWriter(
        f,
        replaceSkill(
          {
            kind: "skill",
            name: metadata.name,
            description: metadata.description,
            main: "SKILL.md",
            files,
          },
          { target: baseline, defaultContext: true },
        ),
      ),
    )
    expect(result.operation).toBe("replace")
    expect(property(result).status).toBe("applied")
    expect(property(property(result).record).name).toBe(metadata.name)
    expect(
      f.calls.some(
        (call) => call.path.includes("/ai/skills/") || call.path.includes("/file_uploads"),
      ),
    ).toBe(false)
    expect([...f.json.keys()].some((key) => key.startsWith("publications/"))).toBe(false)
  })
})
