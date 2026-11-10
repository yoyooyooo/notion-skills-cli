import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, symlink, chmod, cp } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import {
  prepareInventoryImport,
  executeInventoryImport,
  validateInventoryImport,
  readReviewedInventoryFiles,
} from "../src/shared-inventory-import.ts"
import {
  scanLocalSkillInventory,
  reconcileSkillInventories,
  readLocalSkillInventory,
} from "../src/shared-inventory.ts"
import { saveInventoryArtifact } from "../src/shared-inventory-store.ts"
import { runSharedAudit } from "../src/shared-audit.ts"
import {
  prepareSharedBaselineInventory,
  readSharedBaselineInventory,
} from "../src/shared-inventory-remote.ts"
import type { SharedBaselineInventory } from "../src/shared-inventory-remote.ts"
import { INVENTORY_RULES } from "../src/shared-inventory-model.ts"
import {
  decodeInventoryBatchInput,
  executeInventoryBatch,
  interruptedInventoryBatch,
  prepareInventoryBatch,
  type InventoryBatchInputSchema,
  type InventoryBatchProgress,
} from "../src/shared-inventory-batch.ts"
import { Store, sha256 } from "../src/store.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { loadSharedCreatePlan } from "../src/shared-create.ts"
import { authScope } from "../src/catalog.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { withSharedAuthoringRequest } from "../src/shared-authoring-context.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"
import type { discoverSourceDefinition } from "../src/shared-source-adapters.ts"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { sourceDefinitionPropertiesFor } from "../src/shared-source-definitions.ts"
import { sharedCreateFixture } from "./shared-create-fixture.ts"
import {
  fixture as sourceFixture,
  library as sourceLibrary,
  input as sourceDefinition,
  ids as sourceIds,
} from "./shared-source-projection-fixture.ts"
import { id, rich } from "./shared-snapshot-fixture.ts"

async function inventoryReview(
  f: { run: ReturnType<typeof sharedCreateFixture>["run"]; library: SharedLibrary },
  root: string,
  provenance: string[] = [],
) {
  const local = await f.run(
    scanLocalSkillInventory({ roots: [root], provenance_files: provenance }),
  )
  expect(local.coverage).toBe("full")
  const remote: SharedBaselineInventory = {
    version: 1,
    rules_version: INVENTORY_RULES,
    plan_id: "baseline-" + "a".repeat(64),
    audit_run_id: "audit-controlled",
    library_id: f.library.library_id,
    entry_id: f.library.skills.database_id,
    permission_scope: "c".repeat(64),
    visible_registered_census: {
      version: 1,
      boundary: "visible_registered_tables",
      coverage: "full",
      required_tables:
        f.library.sources === undefined
          ? ["skills", "files", "records"]
          : ["skills", "files", "records", "sources"],
      initial_complete: true,
      final_complete: true,
      relations_complete: true,
      metadata_complete: true,
      stable: true,
      initial_semantic_sha256: "b".repeat(64),
      final_semantic_sha256: "b".repeat(64),
      endpoint_scope: "d".repeat(64),
      permission_scope: "c".repeat(64),
      reasons: [],
    },
    observation_interval: { from: 1, to: 1 },
    coverage: "full",
    native_census_sha256: "b".repeat(64),
    resources: [],
    findings: [],
    counts: {
      skills: 0,
      files: 0,
      record_headers: 0,
      source_definitions: 0,
      automatic_candidates: 0,
      require_decision: 0,
    },
    action: "review_only",
    remote_writes: 0,
    global_gc_safe: false,
  }
  const remoteId = await f.run(saveInventoryArtifact("remote", remote))
  const review = await f.run(
    reconcileSkillInventories({
      remote_inventory_id: remoteId,
      local_inventory_id: local.inventory_id,
    }),
  )
  const entity = local.entities[0]!
  return {
    local,
    review,
    entity,
    input: {
      library: f.library,
      reconciliationId: review.inventory_id,
      entityId: entity.entity_id,
      approvedManifest: entity.manifest_sha256,
    },
  }
}

async function fixture(
  options: {
    resources?: boolean
    portableLibrary?: string
    main?: "PROMPT.md"
    readback?: (wire: string) => string
  } = {},
) {
  const f = sharedCreateFixture(
    options.readback === undefined ? {} : { readback: options.readback },
  )
  const root = await mkdtemp(join(tmpdir(), "ntn-reviewed-import-"))
  await mkdir(join(root, "references"))
  await writeFile(
    join(root, options.main ?? "SKILL.md"),
    "---\nname: reviewed-import\ndescription: Reviewed complete native input\nlicense: MIT\n---\n\n# Import\n\nRead [guide](references/guide.md).\n" +
      (options.resources
        ? "\n[Script](scripts/run.js) ![Image](assets/icon.png) [Config](data/options.json)\n"
        : ""),
  )
  await writeFile(join(root, "references", "guide.md"), "# Guide\n\nPreserve this complete file.\n")
  if (options.resources) {
    await Promise.all(["assets", "data", "scripts"].map((path) => mkdir(join(root, path))))
    await writeFile(
      join(root, "assets", "icon.png"),
      Uint8Array.from({ length: 65_537 }, (_, index) => index % 251),
    )
    await writeFile(join(root, "data", "options.json"), '{"complete":true}\r\n')
    await writeFile(
      join(root, "scripts", "run.js"),
      "#!/usr/bin/env node\r\nthrow new Error('never execute during import')\r\n",
    )
    await chmod(join(root, "scripts", "run.js"), 0o755)
    await chmod(join(root, "SKILL.md"), 0o755)
  }
  if (options.portableLibrary !== undefined)
    await writeFile(
      join(root, ".ntn-skills.json"),
      JSON.stringify({
        format: "ntn-skills",
        version: 2,
        kind: "skill",
        name: "reviewed-import",
        description: "Reviewed complete native input",
        main: "SKILL.md",
        relations: {
          version: 1,
          ownership: "notion",
          library_id:
            options.portableLibrary === "same" ? f.library.library_id : options.portableLibrary,
          members: [],
        },
      }),
    )
  const reviewed = await inventoryReview(f, root)
  const input = { ...reviewed.input, decision: { kind: "native" as const } }
  f.clear()
  return {
    ...f,
    root,
    ...reviewed,
    input,
    prepare: () => f.run(prepareInventoryImport(input).pipe(Effect.provide(NodeServices.layer))),
  }
}

async function currentInventoryReview(f: ReturnType<typeof sharedCreateFixture>, root: string) {
  const auditState = await mkdtemp(join(tmpdir(), "ntn-repeat-audit-"))
  const audit = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion,
        store = yield* Store
      return yield* runSharedAudit({
        entry: f.library.skills.database_id,
        selector: { kind: "library" },
        depth: "metadata",
      }).pipe(
        Effect.provideService(Store, { ...store, root: auditState }),
        Effect.provideService(Notion, {
          ...api,
          apiOrigin: "https://api.notion.test",
          request: (path, body, options) =>
            api
              .request(
                path,
                path.startsWith(`v1/data_sources/${f.library.records.data_source_id}/query`) &&
                  body !== null &&
                  typeof body === "object" &&
                  !("filter" in body)
                  ? { ...body, filter: { and: [] } }
                  : body,
                options,
              )
              .pipe(
                Effect.map((value) =>
                  path === "v1/users/me" ? { object: "user", id: id(9000) } : value,
                ),
              ),
        }),
      )
    }),
  )
  const remote = await f.run(prepareSharedBaselineInventory(audit.run_id))
  expect(remote.visible_registered_census?.coverage).toBe("full")
  const local = await f.run(scanLocalSkillInventory({ roots: [root] }))
  const review = await f.run(
    reconcileSkillInventories({
      remote_inventory_id: remote.inventory_id,
      local_inventory_id: local.inventory_id,
    }),
  )
  const entity = local.entities[0]!
  return {
    local,
    entity,
    input: {
      library: f.library,
      reconciliationId: review.inventory_id,
      entityId: entity.entity_id,
      approvedManifest: entity.manifest_sha256,
      decision: { kind: "native" as const },
    },
  }
}

test("a fresh review in another directory skips a completed native import by original input digest without reading current bodies", async () => {
  const f = await fixture()
  f.skills.clear()
  f.files.clear()
  f.base.records.clear()
  const original = await f.prepare()
  const result = await f.run(executeInventoryImport(f.library, original))
  if (!("skill_page_id" in result) || typeof result.skill_page_id !== "string")
    throw new Error("Expected original creation")
  const copy = await mkdtemp(join(tmpdir(), "ntn-relocated-input-"))
  await cp(f.root, copy, { recursive: true })
  f.base.bodies.set(result.skill_page_id, "# Later Notion edit\n\nKeep the author's current work.")
  f.base.json.clear()
  f.base.objects.clear()
  const fresh = await currentInventoryReview(f, copy)
  expect(fresh.entity.manifest_sha256).not.toBe(original.approved_manifest)
  expect(fresh.entity.input_content_sha256).toBe(original.input_content_sha256)
  f.clear()
  const plan = await f.run(
    prepareInventoryImport(fresh.input).pipe(Effect.provide(NodeServices.layer)),
  )
  expect(plan.action.kind).toBe("reuse_import")
  const reused = await f.run(executeInventoryImport(f.library, plan))
  expect(reused).toMatchObject({
    status: "already_imported",
    reused: true,
    verified: true,
    current_content: "unobserved",
    remote_writes: 0,
    skill_page_id: result.skill_page_id,
  })
  expect(f.currentBodies()).toHaveLength(0)
  expect(f.writes()).toHaveLength(0)
  expect(f.base.bodies.get(result.skill_page_id)).toContain("Keep the author's current work.")
  const dry = await f.run(executeInventoryImport(f.library, plan, { dryRun: true }))
  expect(dry).toMatchObject({ status: "planned", verified: false, reused: false, remote_writes: 0 })
  if (original.action.kind !== "create") throw new Error("Expected original creation")
  f.removeCompletion(original.action.creation.operation_id)
  await expect(f.run(executeInventoryImport(f.library, plan))).rejects.toMatchObject({
    code: "INVENTORY_PREVIOUS_IMPORT_INCOMPLETE",
  })
  expect(f.writes()).toHaveLength(0)
})

test("same-name input changes and incomplete original imports cannot be counted as a reusable success", async () => {
  const f = await fixture()
  f.skills.clear()
  f.files.clear()
  f.base.records.clear()
  const original = await f.prepare()
  if (original.action.kind !== "create") throw new Error("Expected original create")
  await f.run(executeInventoryImport(f.library, original))
  await writeFile(join(f.root, "references/guide.md"), "# Updated input\n")
  const changed = await currentInventoryReview(f, f.root)
  f.clear()
  await expect(
    f.run(prepareInventoryImport(changed.input).pipe(Effect.provide(NodeServices.layer))),
  ).rejects.toMatchObject({ code: "INVENTORY_EXISTING_REVIEW_REQUIRED" })
  expect(f.writes()).toHaveLength(0)
  await writeFile(join(f.root, "references/guide.md"), "# Guide\n\nPreserve this complete file.\n")
  f.removeCompletion(original.action.creation.operation_id)
  const incomplete = await currentInventoryReview(f, f.root)
  f.clear()
  await expect(
    f.run(prepareInventoryImport(incomplete.input).pipe(Effect.provide(NodeServices.layer))),
  ).rejects.toMatchObject({ code: "INVENTORY_PREVIOUS_IMPORT_INCOMPLETE" })
  expect(f.writes()).toHaveLength(0)
})

async function batchFixture(readback?: (wire: string) => string) {
  const f = sharedCreateFixture(readback === undefined ? {} : { readback })
  const root = await mkdtemp(join(tmpdir(), "ntn-import-batch-"))
  for (const name of ["first", "second"]) {
    await mkdir(join(root, name))
    await writeFile(
      join(root, name, "SKILL.md"),
      `---\nname: batch-${name}\ndescription: Complete batch fixture\n---\n\n# ${name}\n\nContent for ${name}.\n`,
    )
  }
  const reviewed = await inventoryReview(f, root)
  const input = {
    version: 1,
    reconciliation_id: reviewed.review.inventory_id,
    items: [...reviewed.local.entities]
      .sort((a, b) => a.real_root.localeCompare(b.real_root))
      .map((entity) => ({
        entity_id: entity.entity_id,
        approved_manifest: entity.manifest_sha256,
        decision: { kind: "native" },
      })),
  } satisfies typeof InventoryBatchInputSchema.Type
  f.clear()
  return {
    ...f,
    root,
    input,
    prepare: (request: unknown = input) =>
      f.run(prepareInventoryBatch(f.library, request).pipe(Effect.provide(NodeServices.layer))),
  }
}

test("native inventory imports accept Notion formatting and cold consumers use the recorded readback without adoption writes", async () => {
  const f = await batchFixture((wire) =>
    wire.replace(/<h1>(.*?)<\/h1>/u, "### $1").replace(/(Content for \w+\.)/u, "<p>$1</p>\n"),
  )
  const batch = await f.prepare()
  const frozen = canonicalSharedJson(batch)
  const applied = await f.run(executeInventoryBatch(f.library, batch))
  expect(applied.counts).toMatchObject({ total: 2, confirmed: 2, failed: 0 })
  for (const row of applied.items) {
    const result = property(row.result)
    expect(result.markdown_acceptance).toMatchObject({
      policy: "notion_import_readback_v1",
      roundtrip_required: false,
      representation_changed: ["SKILL.md"],
    })
    const page = String(result.skill_page_id)
    const observed = f.base.bodies.get(page)!
    f.base.objects.clear()
    for (const key of [...f.base.json.keys()])
      if (
        key.startsWith("operations/shared-native-readbacks/") ||
        key.startsWith("snapshots/") ||
        key.startsWith("cache/")
      )
        f.base.json.delete(key)
    f.clear()
    const snapshot = await f.run(
      withSharedAuthoringRequest(
        page,
        Effect.gen(function* () {
          return yield* openSharedConsumer({
            library: f.library,
            target: page,
            scope: yield* authScope,
            startedAt: Date.now(),
            forceFull: true,
            readOnly: true,
          })
        }),
      ),
    )
    const main = snapshot.files.find((file) => file.path === "SKILL.md")!
    const body = new TextDecoder().decode(f.base.objects.get(`objects/${main.sha256}`))
    expect(body).toContain(observed)
    expect(body).toContain("<p>Content for")
    expect(f.writes()).toHaveLength(0)
  }
  f.clear()
  const repeated = await f.run(executeInventoryBatch(f.library, batch))
  expect(repeated.counts).toMatchObject({ confirmed: 2, reused: 2 })
  expect(f.writes()).toHaveLength(0)
  expect(canonicalSharedJson(batch)).toBe(frozen)
})

test("an edit after the first accepted import readback cannot become a new baseline on resume", async () => {
  const f = await fixture()
  const plan = await f.prepare()
  let page: string | undefined
  f.onCreate((row, kind) => {
    if (kind === "skill") page = String(row.id)
    else if (page !== undefined)
      f.base.bodies.set(page, f.base.bodies.get(page)! + "\nLater manual edit.")
  })
  await expect(f.run(executeInventoryImport(f.library, plan))).rejects.toThrow()
  const created = f.nativeCreates().length
  await expect(f.run(executeInventoryImport(f.library, plan))).rejects.toThrow()
  expect(f.nativeCreates()).toHaveLength(created)
  expect(f.base.bodies.get(page!)).toContain("Later manual edit.")
})

test("a failed supporting import retains its allocated page and reconstructible original inputs independently of importer state", async () => {
  const f = await fixture({
    readback: (wire) =>
      wire
        .replace(/^<h1>(.*?)<\/h1>/u, "# $1")
        .replace("Preserve this complete file.", "The instructions were lost."),
  })
  const plan = await f.prepare()
  if (plan.action.kind !== "create") throw new Error("Expected native creation")
  const creation = plan.action.creation
  const pages = new Map<string, string>()
  f.onCreate((row, kind) => pages.set(kind, String(row.id)))
  await expect(f.run(executeInventoryImport(f.library, plan))).rejects.toMatchObject({
    code: "SHARED_CREATE_BODY_MISMATCH",
  })
  const page = pages.get("skill")!,
    reference = pages.get("file")!
  const outcomes = await f.run(
    querySharedRecords(f.library, {
      skillPageId: page,
      kind: "operation",
      recordId: `outcome-${creation.operation_id}`,
    }),
  )
  expect(outcomes).toHaveLength(1)
  const outcome = property(outcomes[0]!.payload)
  expect(outcome.status).toBe("needs_review")
  expect(outcome.bindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "references/guide.md", page_id: reference }),
    ]),
  )
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  expect(
    await f.run(
      loadSharedCreatePlan(f.library, {
        skillPageId: page,
        operationId: creation.operation_id,
      }),
    ),
  ).toEqual(creation)
  expect(f.writes()).toHaveLength(0)
})

test("batch imports two complete Skills using original child journals; repeated apply and reconcile add no writes", async () => {
  const f = await batchFixture()
  const batch = await f.prepare()
  expect(batch.items.map((item) => item.status)).toEqual(["prepared", "prepared"])
  expect(f.writes()).toHaveLength(0)
  const dry = await f.run(executeInventoryBatch(f.library, batch, { dryRun: true }))
  expect(dry.counts).toMatchObject({ total: 2, validated: 2, confirmed: 0 })
  expect(f.writes()).toHaveLength(0)
  const applied = await f.run(executeInventoryBatch(f.library, batch))
  expect(applied).toMatchObject({ all_confirmed: true, execution_complete: true, halted: false })
  expect(applied.counts).toMatchObject({ total: 2, confirmed: 2, reused: 0 })
  expect(f.nativeCreates()).toHaveLength(2)
  f.clear()
  const repeated = await f.run(executeInventoryBatch(f.library, batch))
  expect(repeated.counts).toMatchObject({ confirmed: 2, reused: 2 })
  expect(f.writes()).toHaveLength(0)
  await writeFile(join(f.root, "first", "SKILL.md"), "Local tree changed after import.\n")
  const reconciled = await f.run(executeInventoryBatch(f.library, batch, { reconcile: true }))
  expect(reconciled.all_confirmed).toBe(true)
  expect(f.writes()).toHaveLength(0)
})

test("batch preparation keeps a failed manifest in the denominator while preparing the other entity", async () => {
  const f = await batchFixture()
  const batch = await f.prepare({
    ...f.input,
    items: f.input.items.map((item, index) =>
      index === 0 ? { ...item, approved_manifest: "f".repeat(64) } : item,
    ),
  })
  expect(batch.items.map((item) => item.status)).toEqual(["preparation_failed", "prepared"])
  expect(f.writes()).toHaveLength(0)
  const result = await f.run(executeInventoryBatch(f.library, batch))
  expect(result.counts).toMatchObject({
    total: 2,
    preparation_failed: 1,
    confirmed: 1,
    not_started: 0,
  })
  expect(result.all_confirmed).toBe(false)
  expect(result.items.map((item) => item.entity_id)).toEqual(
    f.input.items.map((item) => item.entity_id),
  )
  expect(f.nativeCreates()).toHaveLength(1)
})

test("batch rejects duplicate inputs and rehashed unprepared batches before any remote request", async () => {
  const f = await batchFixture()
  const duplicate = await f.run(
    decodeInventoryBatchInput({
      ...f.input,
      items: [f.input.items[0], f.input.items[0]],
    }).pipe(Effect.flip),
  )
  expect(duplicate.code).toBe("INVENTORY_BATCH_INVALID")
  expect(f.calls).toHaveLength(0)
  const batch = await f.prepare()
  const { batch_id: _id, ...contents } = batch
  const changed = { ...contents, items: [...contents.items].reverse() }
  const forged = {
    ...changed,
    batch_id: `import-batch-${await f.run(sha256(canonicalSharedJson(changed)))}`,
  }
  f.clear()
  const rejected = await f.run(executeInventoryBatch(f.library, forged).pipe(Effect.flip))
  expect(rejected.code).toBe("INVENTORY_BATCH_NOT_PREPARED")
  expect(f.calls).toHaveLength(0)
})

test("a known batch body mismatch preserves its failed original and allows the independent next entity", async () => {
  const f = await batchFixture((wire) => {
    const body = wire.replace(/^<h1>([^\n]*)<\/h1>(?=\n|$)/u, "# $1")
    return body.includes("Content for first.") ? body + "\nAltered.\n" : body
  })
  const batch = await f.prepare()
  const result = await f.run(executeInventoryBatch(f.library, batch))
  expect(result.counts).toMatchObject({ total: 2, failed: 1, confirmed: 1, not_started: 0 })
  expect(result.items[0]?.error?.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  expect(result.halted).toBe(false)
  expect(f.nativeCreates()).toHaveLength(2)
  f.clear()
  const again = await f.run(executeInventoryBatch(f.library, batch))
  expect(again.counts).toMatchObject({ failed: 1, confirmed: 1, reused: 1 })
  expect(f.nativeCreates()).toHaveLength(0)
})

test("unknown batch writes halt remaining dispatches and repeated original work cannot create duplicates", async () => {
  const f = await batchFixture()
  const batch = await f.prepare()
  f.unknown("skill", false)
  const result = await f.run(executeInventoryBatch(f.library, batch))
  expect(result).toMatchObject({ halted: true, execution_complete: false, all_confirmed: false })
  expect(result.counts).toMatchObject({ total: 2, confirmed: 0, failed: 1, not_started: 1 })
  expect(property(result.items[0]).read_recovery).toBeUndefined()
  f.clear()
  const again = await f.run(executeInventoryBatch(f.library, batch))
  expect(again.counts).toMatchObject({ failed: 1, not_started: 1 })
  expect(f.writes()).toHaveLength(0)
  const checked = await f.run(executeInventoryBatch(f.library, batch, { reconcile: true }))
  expect(checked.all_confirmed).toBe(false)
  expect(f.writes()).toHaveLength(0)
})

test("an exhausted transient read resumes the original batch child once and retains its first failure", async () => {
  const f = await batchFixture()
  const batch = await f.prepare()
  const frozen = canonicalSharedJson(batch)
  let failures = 0
  const progress: InventoryBatchProgress[] = []
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* executeInventoryBatch(f.library, batch, {
        onProgress: (value) => progress.push(structuredClone(value)),
      }).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            Effect.suspend(() => {
              if (
                failures === 0 &&
                f.nativeCreates().length === 1 &&
                path.startsWith(`v1/data_sources/${f.library.records.data_source_id}/query`)
              ) {
                failures++
                return Effect.fail(
                  fail("NOTION_UNAVAILABLE", "Exhausted original metadata read", {
                    reason: "network",
                  }),
                )
              }
              return api.request(path, body, options)
            }),
        }),
      )
    }),
  )
  expect(result).toMatchObject({
    all_confirmed: true,
    halted: false,
    counts: { total: 2, confirmed: 2, failed: 0, automatically_recovered: 1 },
    items: [
      { status: "confirmed", read_recovery: { first_error: { code: "NOTION_UNAVAILABLE" } } },
      { status: "confirmed" },
    ],
  })
  expect(f.nativeCreates()).toHaveLength(2)
  expect(failures).toBe(1)
  expect(canonicalSharedJson(batch)).toBe(frozen)
  const pending = progress.find(
    (value) =>
      value.active_entity_id === batch.items[0]!.request.entity_id &&
      property(value.report.items[0]).read_recovery !== undefined,
  )
  if (pending === undefined)
    throw new Error("Recovery must expose its first failure before continuing")
  expect(
    interruptedInventoryBatch(pending, fail("REQUEST_BUDGET_EXHAUSTED", "Stopped during recovery")),
  ).toMatchObject({
    counts: { confirmed: 0, interrupted: 1, not_started: 1 },
    items: [
      { status: "interrupted", read_recovery: { first_error: { code: "NOTION_UNAVAILABLE" } } },
      { status: "not_started" },
    ],
  })
})

test.each(["NOTION_UNAVAILABLE", "ACCESS_DENIED", "REQUEST_BUDGET_EXHAUSTED"])(
  "batch continuation remains bounded and preserves the original error for %s",
  async (code) => {
    const f = await batchFixture()
    const batch = await f.prepare()
    let failures = 0
    const result = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* executeInventoryBatch(f.library, batch).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              Effect.suspend(() => {
                if (
                  f.nativeCreates().length === 1 &&
                  path.startsWith(`v1/data_sources/${f.library.records.data_source_id}/query`)
                ) {
                  failures++
                  return Effect.fail(
                    fail(code, `Original read failure ${failures}`, { reason: "network" }),
                  )
                }
                return api.request(path, body, options)
              }),
          }),
        )
      }),
    )
    expect(result.halted).toBe(true)
    expect(result.counts).toMatchObject({
      total: 2,
      confirmed: 0,
      not_started: 1,
      automatically_recovered: 0,
    })
    expect(f.nativeCreates()).toHaveLength(1)
    expect(failures).toBe(code === "NOTION_UNAVAILABLE" ? 2 : 1)
    const first = result.items[0]!
    if (code === "NOTION_UNAVAILABLE") {
      expect(property(first).read_recovery).toMatchObject({
        first_error: { code, message: "Original read failure 1" },
      })
      expect(first.error).toMatchObject({ code, message: "Original read failure 2" })
    } else expect(property(first).read_recovery).toBeUndefined()
  },
)

test("formal import freezes the exact complete inventory and original create operation; prepare and dry-run write no Notion content", async () => {
  const f = await fixture()
  const original = await readFile(join(f.root, "SKILL.md"))
  const plan = await f.prepare()
  expect(plan.action.kind).toBe("create")
  if (plan.action.kind !== "create") throw new Error("Expected creation")
  expect(plan.action.creation.enabled).toBe(false)
  expect(plan.action.creation.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "references/guide.md",
  ])
  expect(plan.local_entity.manifest_sha256).toBe(f.entity.manifest_sha256)
  expect(f.writes()).toHaveLength(0)
  const dry = await f.run(executeInventoryImport(f.library, plan, { dryRun: true }))
  expect(dry.verified).toBe(false)
  expect(f.writes()).toHaveLength(0)
  expect(await readFile(join(f.root, "SKILL.md"))).toEqual(original)
  expect((await f.prepare()).plan_id).toBe(plan.plan_id)
})

test("corrected Skill selection creates a new review without rewriting frozen Prompt reports or prepared plans", async () => {
  const f = await fixture({ main: "PROMPT.md" })
  const priorPlan = await f.prepare()
  if (priorPlan.action.kind !== "create") throw new Error("Expected creation")
  expect(priorPlan.action.creation.original_main_path).toBe("PROMPT.md")
  const planKey = `plans/shared-inventory-imports/${priorPlan.plan_id}.json`
  expect(f.base.json.has(planKey)).toBe(true)
  const savedPlan = canonicalSharedJson(f.base.json.get(planKey))
  const savedReport = canonicalSharedJson(
    await f.run(readLocalSkillInventory(f.local.inventory_id)),
  )
  const skill = await readFile(join(f.root, "PROMPT.md"))
  const prompt = "# Demo prompts\r\n\r\nAn example without Skill metadata.\r\n"
  await writeFile(join(f.root, "SKILL.md"), skill)
  await writeFile(join(f.root, "PROMPT.md"), prompt)

  const observed = await inventoryReview(f, f.root)
  expect(observed.entity.main).toBe("SKILL.md")
  const { inventory_id: _currentId, ...currentReport } = observed.local
  const legacyEntities = currentReport.entities.map((entity) => ({ ...entity, main: "PROMPT.md" }))
  // A retained pre-fix observation selected PROMPT.md for this same complete tree.
  const legacy = {
    ...currentReport,
    entities: legacyEntities,
    manifest_id: `local-manifest-${await f.run(
      sha256(
        canonicalSharedJson({
          rules_version: currentReport.rules_version,
          scope: currentReport.scope,
          entities: legacyEntities,
          aliases: currentReport.aliases,
          unassigned_files: currentReport.unassigned_files,
          provenance: currentReport.provenance,
        }),
      ),
    )}`,
  }
  const legacyId = await f.run(saveInventoryArtifact("local", legacy))
  const legacyReview = await f.run(
    reconcileSkillInventories({
      remote_inventory_id: observed.review.remote_inventory_id,
      local_inventory_id: legacyId,
    }),
  )
  const savedLegacy = canonicalSharedJson(await f.run(readLocalSkillInventory(legacyId)))
  expect(observed.entity).toEqual({ ...legacy.entities[0]!, main: "SKILL.md" })
  expect(observed.entity.manifest_sha256).toBe(legacy.entities[0]!.manifest_sha256)
  expect(observed.local.manifest_id).not.toBe(legacy.manifest_id)
  expect(observed.review.review_id).not.toBe(legacyReview.review_id)
  expect(observed.review.inventory_id).not.toBe(legacyReview.inventory_id)

  const rejected = await f.run(
    prepareInventoryImport({
      ...observed.input,
      reconciliationId: legacyReview.inventory_id,
      decision: { kind: "native" },
    }).pipe(Effect.provide(NodeServices.layer), Effect.result),
  )
  expect(rejected._tag).toBe("Failure")
  if (rejected._tag !== "Failure") throw new Error("Expected original Prompt metadata rejection")
  expect(rejected.failure.code).toBe("INVALID_SKILL")

  const plan = await f.run(
    prepareInventoryImport({
      ...observed.input,
      decision: { kind: "native" },
    }).pipe(Effect.provide(NodeServices.layer)),
  )
  if (plan.action.kind !== "create") throw new Error("Expected creation")
  expect(plan.action.creation.original_main_path).toBe("SKILL.md")
  expect(plan.action.creation.files.map((file) => file.path)).toEqual([
    "PROMPT.md",
    "SKILL.md",
    "references/guide.md",
  ])
  expect(plan.action.creation.files.find((file) => file.path === "PROMPT.md")?.input.text).toBe(
    prompt,
  )
  expect(canonicalSharedJson(await f.run(readLocalSkillInventory(legacyId)))).toBe(savedLegacy)
  expect(canonicalSharedJson(await f.run(readLocalSkillInventory(f.local.inventory_id)))).toBe(
    savedReport,
  )
  expect(canonicalSharedJson(f.base.json.get(planKey))).toBe(savedPlan)
  expect(await readFile(join(f.root, "SKILL.md"))).toEqual(skill)
  expect(await readFile(join(f.root, "PROMPT.md"), "utf8")).toBe(prompt)
  expect(f.writes()).toHaveLength(0)
  expect(f.nativeCreates()).toHaveLength(0)
})

test("changed source content, added files and symlink substitutions invalidate a prepared import before dispatch", async () => {
  for (const change of ["body", "added", "link"] as const) {
    const f = await fixture(),
      plan = await f.prepare()
    if (change === "body") await writeFile(join(f.root, "SKILL.md"), "Changed after review")
    if (change === "added") await writeFile(join(f.root, "unreviewed.json"), "{}")
    if (change === "link") await symlink("references/guide.md", join(f.root, "new-link.md"))
    f.clear()
    await expect(f.run(executeInventoryImport(f.library, plan))).rejects.toThrow()
    expect(f.writes()).toHaveLength(0)
    expect(f.nativeCreates()).toHaveLength(0)
  }
})

test("approval digest, same-name conflict and copied/rehashed plans cannot acquire creation authority", async () => {
  const f = await fixture()
  await expect(
    f.run(
      prepareInventoryImport({ ...f.input, approvedManifest: "0".repeat(64) }).pipe(
        Effect.provide(NodeServices.layer),
      ),
    ),
  ).rejects.toThrow("explicitly approve")
  expect(f.calls).toHaveLength(0)
  const plan = await f.prepare()
  const { plan_id: _id, ...contents } = {
    ...plan,
    reconciliation_id: "inventory-" + "e".repeat(64),
  }
  const changed = {
    ...contents,
    plan_id: `inventory-import-${await f.run(sha256(canonicalSharedJson(contents)))}`,
  }
  await f.run(validateInventoryImport(changed))
  f.clear()
  await expect(f.run(executeInventoryImport(f.library, changed))).rejects.toThrow(
    "exact locally prepared plan",
  )
  expect(f.writes()).toHaveLength(0)
  f.seedSkill(id(999), "foreign-same-name", "reviewed-import")
  await expect(f.prepare()).rejects.toThrow()
  expect(f.writes()).toHaveLength(0)
})

test("actual file descriptor reads cannot reuse cached bytes after a file changes", async () => {
  const f = await fixture()
  await f.run(readReviewedInventoryFiles(f.entity))
  const file = f.entity.files.find((file) => file.path === "references/guide.md")!
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Store).writeBytes(
        `objects/${file.sha256}`,
        new TextEncoder().encode("# Guide\n\nPreserve this complete file.\n"),
      )
    }),
  )
  await writeFile(file.real_path, "# Guide\n\nModified this complete file.\n")
  await expect(f.run(readReviewedInventoryFiles(f.entity))).rejects.toThrow()
  expect(f.writes()).toHaveLength(0)
})

test("a complete repeated import uses its original create result and never creates another Skill or File", async () => {
  const f = await fixture(),
    plan = await f.prepare()
  const first = await f.run(executeInventoryImport(f.library, plan))
  expect(first.verified).toBe(true)
  expect(f.nativeCreates()).toHaveLength(2)
  f.clear()
  const repeated = await f.run(executeInventoryImport(f.library, plan))
  expect(repeated.verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
  await writeFile(join(f.root, "SKILL.md"), "Later local changes are separate work.")
  const original = await f.run(executeInventoryImport(f.library, plan, { reconcile: true }))
  expect(original.verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
})

test("lost creation acknowledgement preserves the original operation and cannot be replayed through inventory import", async () => {
  const f = await fixture(),
    plan = await f.prepare()
  f.unknown("skill", true)
  await expect(f.run(executeInventoryImport(f.library, plan))).rejects.toThrow()
  const count = f.nativeCreates().length
  await expect(f.run(executeInventoryImport(f.library, plan))).rejects.toThrow()
  expect(f.nativeCreates()).toHaveLength(count)
  f.clear()
  await expect(
    f.run(executeInventoryImport(f.library, plan, { reconcile: true })),
  ).rejects.toThrow()
  expect(f.writes()).toHaveLength(0)
})

test("complete native inventory import preserves independently frozen resource bytes and modes after cold remote consumption", async () => {
  const f = await fixture({ resources: true, portableLibrary: "same" })
  const expected = new Map(
    await Promise.all(
      f.entity.files
        .filter((file) => file.path !== ".ntn-skills.json")
        .map(async (file) => {
          const bytes = new Uint8Array(await readFile(join(f.root, file.path)))
          return [
            file.path,
            { bytes, hash: createHash("sha256").update(bytes).digest("hex"), mode: file.mode },
          ] as const
        }),
    ),
  )
  const plan = await f.prepare()
  if (plan.action.kind !== "create") throw new Error("Expected creation")
  expect(plan.action.creation.complete_resources).toBe(1)
  expect(plan.action.custom_paths).not.toContain(".ntn-skills.json")
  expect(plan.action.creation.resources?.map((file) => file.path)).toEqual([
    "assets/icon.png",
    "data/options.json",
    "scripts/run.js",
  ])
  const created = await f.run(executeInventoryImport(f.library, plan))
  if (!("skill_page_id" in created) || typeof created.skill_page_id !== "string")
    throw new Error("Expected created page")
  expect(created.verified).toBe(true)
  expect(f.nativeCreates()).toHaveLength(expected.size)
  expect(f.enablePatches()).toHaveLength(0)
  f.base.objects.clear()
  for (const key of [...f.base.json.keys()])
    if (key.startsWith("snapshots/") || key.startsWith("cache/")) f.base.json.delete(key)
  f.clear()
  const snapshot = await f.run(
    withSharedAuthoringRequest(
      created.skill_page_id,
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library: f.library,
          target: created.skill_page_id,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly: true,
        })
      }),
    ),
  )
  expect(snapshot.files.map((file) => file.path)).toEqual([...expected.keys()].sort())
  for (const actual of snapshot.files) {
    const original = expected.get(actual.path)!
    expect(actual.mode).toBe(original.mode)
    const bytes = f.base.objects.get(`objects/${actual.sha256}`)
    expect(bytes).toBeDefined()
    if (!actual.path.endsWith(".md")) {
      expect(actual.sha256).toBe(original.hash)
      expect(bytes).toEqual(original.bytes)
    }
  }
  const main = snapshot.files.find((file) => file.path === "SKILL.md")!
  expect(new TextDecoder().decode(f.base.objects.get(`objects/${main.sha256}`))).toContain(
    '"license": "MIT"',
  )
  expect(f.writes()).toHaveLength(0)
  expect(await readFile(join(f.root, "scripts", "run.js"))).toEqual(
    Buffer.from(expected.get("scripts/run.js")!.bytes),
  )
})

test("portable relation authority is exact-library input and never an ignored container field", async () => {
  const f = await fixture({ portableLibrary: "another-library" })
  await expect(f.prepare()).rejects.toThrow("original shared library")
  expect(f.writes()).toHaveLength(0)
  expect(f.nativeCreates()).toHaveLength(0)
})

test("a complete selected entity can be reviewed without hiding unrelated partial inventory, but never without a stable metadata census", async () => {
  const f = await fixture()
  const remote = await f.run(readSharedBaselineInventory(f.review.remote_inventory_id))
  const partial = {
    ...remote,
    coverage: "partial" as const,
    findings: [{ code: "UNRELATED_CONTENT_UNOBSERVED", retained_in_denominator: true }],
  }
  const prepareWith = async (baseline: SharedBaselineInventory) => {
    const remoteId = await f.run(saveInventoryArtifact("remote", baseline))
    const review = await f.run(
      reconcileSkillInventories({
        remote_inventory_id: remoteId,
        local_inventory_id: f.local.inventory_id,
      }),
    )
    expect(review.coverage).toBe("partial")
    const plan = await f.run(
      prepareInventoryImport({ ...f.input, reconciliationId: review.inventory_id }).pipe(
        Effect.provide(NodeServices.layer),
      ),
    )
    return { plan, remoteId }
  }
  const reviewed = await prepareWith(partial)
  expect(reviewed.plan.remote_inventory_id).toBe(reviewed.remoteId)
  expect((await f.run(readSharedBaselineInventory(reviewed.remoteId))).findings).toEqual(
    partial.findings,
  )
  expect(f.writes()).toHaveLength(0)
  const { visible_registered_census: _census, ...unproved } = partial
  await expect(prepareWith(unproved)).rejects.toThrow("complete, stable census")
  await expect(
    prepareWith({
      ...partial,
      visible_registered_census: {
        ...partial.visible_registered_census!,
        coverage: "partial",
        final_complete: false,
        stable: false,
        final_semantic_sha256: null,
        reasons: ["final_census_incomplete"],
      },
    }),
  ).rejects.toThrow("complete, stable census")
  expect(f.writes()).toHaveLength(0)
})

test("an unrelated outward link stays in the original inventory while the selected complete local tree is revalidated alone", async () => {
  const f = await fixture()
  const outside = await mkdtemp(join(tmpdir(), "ntn-unapproved-neighbour-"))
  const logical = join(outside, "outside-scope")
  await symlink(tmpdir(), logical)
  const local = await f.run(scanLocalSkillInventory({ roots: [f.root, logical] }))
  expect(local.coverage).toBe("partial")
  expect(local.aliases.some((entry) => entry.boundary === "outside_scope")).toBe(true)
  const entity = local.entities.find((entry) => entry.entity_id === f.entity.entity_id)!
  const review = await f.run(
    reconcileSkillInventories({
      remote_inventory_id: f.review.remote_inventory_id,
      local_inventory_id: local.inventory_id,
    }),
  )
  const plan = await f.run(
    prepareInventoryImport({
      ...f.input,
      reconciliationId: review.inventory_id,
      entityId: entity.entity_id,
      approvedManifest: entity.manifest_sha256,
    }).pipe(Effect.provide(NodeServices.layer)),
  )
  expect(plan.local_inventory_id).toBe(local.inventory_id)
  expect(plan.local_entity.entity_id).toBe(f.entity.entity_id)
  expect(f.writes()).toHaveLength(0)
})

async function upstreamInventory(
  options: { custom?: boolean; wrongRepository?: boolean; matchesCurrent?: boolean } = {},
) {
  const f = sourceFixture()
  const c1 = f.snapshot
  const c2: SourceSnapshot = {
    ...c1,
    revision: "b".repeat(40),
    members: c1.members.map((member) => {
      const files = member.portable.files.map((file) =>
        file.path === "scripts/run.js"
          ? {
              ...file,
              bytes: new TextEncoder().encode("// Selected C2 script: read only\n"),
              mode: "100644" as const,
            }
          : file,
      )
      return {
        ...member,
        portable: { ...member.portable, files },
        git_manifest: {
          ...member.git_manifest!,
          commit: "b".repeat(40),
          tree: "c".repeat(40),
          files: files.map((file) => ({
            path: file.path,
            source_path: `skills/demo/${file.path}`,
            bytes: file.bytes.length,
            mode: file.mode ?? "100644",
            git_oid: createHash("sha1")
              .update(Buffer.from(`blob ${file.bytes.length}\0`))
              .update(file.bytes)
              .digest("hex"),
          })),
        },
      }
    }),
  }
  f.registerSnapshot(c2)
  f.source.properties[sourceIds.Ref!] = rich(sourceIds.Ref!, c2.revision)
  const directory = await mkdtemp(join(tmpdir(), "ntn-upstream-import-"))
  const root = join(directory, "skill")
  await mkdir(root)
  for (const file of (options.matchesCurrent ? c2 : c1).members[0]!.portable.files) {
    if (options.custom && file.path === "assets/icon.png") continue
    const path = join(root, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.bytes)
    await chmod(path, file.mode === "100755" ? 0o755 : 0o644)
  }
  if (options.custom) {
    await writeFile(
      join(root, "SKILL.md"),
      "---\nname: locally-customized\ndescription: Complete local N1\nlicense: Apache-2.0\n---\n\n# Local N1\n\n[Original](references/a.md) [Own](references/local.md) [Script](scripts/run.js) [Binary](assets/custom.bin)\n",
    )
    await chmod(join(root, "SKILL.md"), 0o755)
    await writeFile(join(root, "references/local.md"), "# Locally added reference\n")
    await writeFile(join(root, "data/options.json"), '{"owner":"local N1"}\r\n')
    await mkdir(join(root, "assets"), { recursive: true })
    await writeFile(join(root, "assets/custom.bin"), new Uint8Array([0, 255, 3, 128]))
  }
  const provenance = join(directory, "identities.json")
  await writeFile(
    provenance,
    JSON.stringify({
      version: 1,
      kind: "ntn_skill_inventory_identity",
      entries: [
        {
          path: root,
          identity: {
            repository: options.wrongRepository
              ? "https://github.com/example/another-source"
              : sourceDefinition.adapter.type === "git"
                ? sourceDefinition.adapter.url
                : "",
            commit: c1.revision,
            member: "skills/demo",
            source_path: "skills/demo",
          },
        },
      ],
    }),
  )
  const reviewed = await inventoryReview({ run: f.run, library: sourceLibrary }, root, [provenance])
  const acquisitions: string[] = []
  const acquire: typeof discoverSourceDefinition = (definition) => {
    const revision = definition.adapter.type === "git" ? definition.adapter.ref : undefined
    acquisitions.push(revision ?? "unfixed")
    return revision === c1.revision
      ? Effect.succeed(structuredClone(c1))
      : revision === c2.revision
        ? Effect.succeed(structuredClone(c2))
        : Effect.fail(
            fail(
              "UNEXPECTED_PROVIDER",
              "No floating or unregistered source is available in this fixture.",
            ),
          )
  }
  const input = {
    ...reviewed.input,
    decision: { kind: "source" as const, source: f.source.id, member: "skills/demo" },
  }
  f.clear()
  return {
    ...f,
    ...reviewed,
    input,
    root,
    c1,
    c2,
    acquisitions,
    prepareImport: () =>
      f.run(prepareInventoryImport(input, acquire).pipe(Effect.provide(NodeServices.layer))),
  }
}

test("an unchanged original upstream tree selects the checked C2 through the public import kernel without uploading its resources", async () => {
  const f = await upstreamInventory(),
    plan = await f.prepareImport()
  if (plan.action.kind !== "create") throw new Error("Expected source admission")
  expect(plan.action.input_class).toBe("pure_upstream")
  expect(plan.action.baseline_revision).toBe(f.c1.revision)
  expect(plan.action.selected_revision).toBe(f.c2.revision)
  expect(plan.action.custom_paths).toEqual([])
  expect(plan.action.creation.source_projection?.version).toBe(1)
  if (plan.action.creation.source_projection?.version !== 1)
    throw new Error("Expected fixed Git projection")
  expect(plan.action.creation.source_projection.binding.kind).toBe("git")
  expect(plan.action.creation.resources ?? []).toEqual([])
  expect(f.acquisitions).toEqual([f.c2.revision, f.c1.revision])
  expect(f.writes()).toHaveLength(0)
  const created = await f.run(executeInventoryImport(sourceLibrary, plan))
  if (!("skill_page_id" in created) || typeof created.skill_page_id !== "string")
    throw new Error("Expected created page")
  expect(created.verified).toBe(true)
  f.base.objects.clear()
  f.base.json.clear()
  const snapshot = await f.run(
    withSharedAuthoringRequest(
      created.skill_page_id,
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library: sourceLibrary,
          target: created.skill_page_id,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly: true,
        })
      }),
    ),
  )
  expect(snapshot.files.map((file) => file.path)).toEqual(
    f.c2.members[0]!.portable.files.map((file) => file.path).sort(),
  )
  const script = snapshot.files.find((file) => file.path === "scripts/run.js")!
  expect(script.mode).toBe("100644")
  expect(f.base.objects.get(`objects/${script.sha256}`)).toEqual(
    f.c2.members[0]!.portable.files.find((file) => file.path === script.path)!.bytes,
  )
  expect(new TextDecoder().decode(await readFile(join(f.root, "scripts/run.js")))).toContain(
    "original",
  )
  f.clear()
  expect(
    (await f.run(executeInventoryImport(sourceLibrary, plan, { reconcile: true }))).verified,
  ).toBe(true)
  expect(f.writes()).toHaveLength(0)
  expect(f.acquisitions).toHaveLength(2)
})

test("a local change that equals checked C2 keeps its original C1 ancestry and custom ownership", async () => {
  const f = await upstreamInventory({ matchesCurrent: true }),
    plan = await f.prepareImport()
  if (plan.action.kind !== "create") throw new Error("Expected source admission")
  expect(f.acquisitions).toEqual([f.c2.revision, f.c1.revision])
  expect(plan.action.input_class).toBe("modified_upstream")
  expect(plan.action.baseline_revision).toBe(f.c1.revision)
  expect(plan.action.selected_revision).toBe(f.c2.revision)
  expect(plan.action.custom_paths).toEqual(["scripts/run.js"])
  const original = plan.action.creation.source_projection
  expect(original?.version).toBe(1)
  if (original?.version !== 1) throw new Error("Expected fixed Git projection")
  expect(original.local?.baseline.commit).toBe(f.c1.revision)
  const script = plan.action.creation.resources?.find((file) => file.path === "scripts/run.js")
  expect(script?.event.kind).toBe("adopted")
  expect(f.writes()).toHaveLength(0)
})

test("complete modified-upstream import retains C1 ancestry and local N1 while unchanged resources follow checked C2", async () => {
  const f = await upstreamInventory({ custom: true }),
    plan = await f.prepareImport()
  if (plan.action.kind !== "create") throw new Error("Expected source admission")
  expect(plan.action.input_class).toBe("modified_upstream")
  expect(plan.action.baseline_revision).toBe(f.c1.revision)
  expect(plan.action.selected_revision).toBe(f.c2.revision)
  expect(plan.action.custom_paths).toEqual([
    "SKILL.md",
    "assets/custom.bin",
    "assets/icon.png",
    "data/options.json",
    "references/local.md",
  ])
  const originalConfig = new Uint8Array(await readFile(join(f.root, "data/options.json")))
  const originalBinary = new Uint8Array(await readFile(join(f.root, "assets/custom.bin")))
  const created = await f.run(executeInventoryImport(sourceLibrary, plan))
  if (!("skill_page_id" in created) || typeof created.skill_page_id !== "string")
    throw new Error("Expected created page")
  expect(created.verified).toBe(true)
  f.base.objects.clear()
  f.base.json.clear()
  const snapshot = await f.run(
    withSharedAuthoringRequest(
      created.skill_page_id,
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library: sourceLibrary,
          target: created.skill_page_id,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly: true,
        })
      }),
    ),
  )
  expect(snapshot.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "assets/custom.bin",
    "data/options.json",
    "references/a.md",
    "references/local.md",
    "scripts/run.js",
  ])
  for (const [path, expected] of [
    ["data/options.json", originalConfig],
    ["assets/custom.bin", originalBinary],
  ] as const) {
    const file = snapshot.files.find((entry) => entry.path === path)!
    expect(file.sha256).toBe(createHash("sha256").update(expected).digest("hex"))
    expect(f.base.objects.get(`objects/${file.sha256}`)).toEqual(expected)
  }
  const main = snapshot.files.find((file) => file.path === "SKILL.md")!
  expect(main.mode).toBe("100755")
  expect(new TextDecoder().decode(f.base.objects.get(`objects/${main.sha256}`))).toContain(
    "Apache-2.0",
  )
  expect(snapshot.files.find((file) => file.path === "scripts/run.js")?.mode).toBe("100644")
  f.clear()
  expect(
    (await f.run(executeInventoryImport(sourceLibrary, plan, { reconcile: true }))).verified,
  ).toBe(true)
  expect(f.writes()).toHaveLength(0)
  expect(f.acquisitions).toEqual([f.c2.revision, f.c1.revision])
})

test("same upstream bytes do not authorize a different repository identity", async () => {
  const f = await upstreamInventory({ wrongRepository: true })
  await expect(f.prepareImport()).rejects.toThrow("registered repository identity")
  expect(f.writes()).toHaveLength(0)
  expect(f.nativeCreates()).toHaveLength(0)
})

test("an exact retained member with unspecified provider modes imports as following with canonical regular-file modes", async () => {
  const f = sourceFixture()
  const adapter = {
    type: "registry" as const,
    base_url: "https://registry.example.test",
    owner: "team",
    slug: "skill",
    version: "1.2.3",
  }
  for (const [key, value] of Object.entries(
    sourceDefinitionPropertiesFor(sourceLibrary, { ...sourceDefinition, adapter }),
  ))
    f.source.properties[key] = { ...property(f.source.properties[key]), ...property(value) }
  const { git_manifest: _git, ...member } = f.snapshot.members[0]!
  const files = member.portable.files.map(({ mode: _mode, ...file }) => file)
  const acquired: SourceSnapshot = {
    ...f.snapshot,
    revision: "registry-release-1.2.3",
    provenance: { provider: "registry" },
    members: [{ ...member, portable: { ...member.portable, files } }],
  }
  const root = await mkdtemp(join(tmpdir(), "ntn-retained-import-"))
  for (const file of files) {
    const path = join(root, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.bytes)
    await chmod(path, 0o644)
  }
  const reviewed = await inventoryReview({ run: f.run, library: sourceLibrary }, root)
  let acquisitions = 0
  const acquire: typeof discoverSourceDefinition = () => {
    acquisitions++
    return Effect.succeed(acquired)
  }
  const plan = await f.run(
    prepareInventoryImport(
      {
        ...reviewed.input,
        decision: { kind: "source", source: f.source.id, member: "skills/demo" },
      },
      acquire,
    ).pipe(Effect.provide(NodeServices.layer)),
  )
  if (plan.action.kind !== "create") throw new Error("Expected retained source admission")
  expect(plan.action.input_class).toBe("pure_upstream")
  expect(plan.action.custom_paths).toEqual([])
  expect(plan.action.creation.source_projection?.version).toBe(2)
  const created = await f.run(executeInventoryImport(sourceLibrary, plan))
  if (!("skill_page_id" in created) || typeof created.skill_page_id !== "string")
    throw new Error("Expected retained created page")
  expect(created.verified).toBe(true)
  f.base.objects.clear()
  f.base.json.clear()
  const snapshot = await f.run(
    withSharedAuthoringRequest(
      created.skill_page_id,
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library: sourceLibrary,
          target: created.skill_page_id,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly: true,
        })
      }),
    ),
  )
  expect(snapshot.files).toHaveLength(files.length)
  for (const file of snapshot.files) {
    expect(file.mode).toBe("100644")
    if (file.path !== "SKILL.md")
      expect(f.base.objects.get(`objects/${file.sha256}`)).toEqual(
        files.find((candidate) => candidate.path === file.path)!.bytes,
      )
  }
  expect(acquisitions).toBe(1)
  expect(f.providerReads()).toBe(0)
})

test("existing verification checks its complete target while retaining unaudited neighbours in the library denominator", async () => {
  const f = await fixture({ resources: true })
  const auditState = await mkdtemp(join(tmpdir(), "ntn-existing-audit-"))
  const atEndpoint = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const api = yield* Notion
      const store = yield* Store
      return yield* effect.pipe(
        Effect.provideService(Notion, {
          ...api,
          apiOrigin: "https://api.notion.test",
          request: (path, body, options) =>
            api
              .request(
                path,
                path.startsWith(`v1/data_sources/${f.library.records.data_source_id}/query`) &&
                  body !== null &&
                  typeof body === "object" &&
                  !("filter" in body)
                  ? { ...body, filter: { and: [] } }
                  : body,
                options,
              )
              .pipe(
                Effect.map((value) =>
                  path === "v1/users/me" ? { object: "user", id: id(9000) } : value,
                ),
              ),
        }),
        Effect.provideService(Store, { ...store, root: auditState }),
      )
    })
  const original = await f.prepare()
  const created = await f.run(executeInventoryImport(f.library, original))
  if (!("skill_page_id" in created) || typeof created.skill_page_id !== "string")
    throw new Error("Expected created page")
  const audit = await f.run(
    atEndpoint(
      runSharedAudit({
        entry: f.library.skills.database_id,
        selector: { kind: "skill", page_id: created.skill_page_id },
        depth: "content",
        incremental: false,
      }),
    ),
  )
  if (audit.coverage !== "full")
    throw new Error(
      JSON.stringify({
        execution: audit.execution,
        remaining: audit.remaining_tasks,
        findings: audit.findings,
      }),
    )
  expect(audit.coverage).toBe("full")
  const baseline = await f.run(prepareSharedBaselineInventory(audit.run_id))
  expect(baseline.coverage).toBe("partial")
  const target = baseline.resources.find((item) => item.page_id === created.skill_page_id)!
  expect(target.files).toHaveLength(5)
  expect(
    target.files.every((file) => file.current_sha256 !== null && file.current_mode !== null),
  ).toBe(true)
  if (target.skill_id === null) throw new Error("Expected exact existing identity")
  // Exercise this coordinator branch with the independently audited original
  // target. The initial whole-library approval is a separate prepare contract.
  const { plan_id: _originalId, ...contents } = {
    ...original,
    action: {
      kind: "verify_existing" as const,
      page_id: target.page_id,
      skill_id: target.skill_id,
      metadata_sha256: target.metadata_sha256,
      ownership_sha256: target.ownership_sha256,
      content_sha256: target.content_sha256,
    },
  }
  const plan = {
    ...contents,
    plan_id: `inventory-import-${await f.run(sha256(canonicalSharedJson(contents)))}`,
  }
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Store).writeJson(`plans/shared-inventory-imports/${plan.plan_id}.json`, plan)
    }),
  )
  f.clear()
  const result = await f.run(atEndpoint(executeInventoryImport(f.library, plan)))
  expect(result.verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
  f.seedSkill(target.page_id, target.skill_id, "Changed after the original reviewed metadata")
  await expect(f.run(atEndpoint(executeInventoryImport(f.library, plan)))).rejects.toThrow(
    "exact remote content, ownership or metadata differs",
  )
  expect(f.writes()).toHaveLength(0)
})
