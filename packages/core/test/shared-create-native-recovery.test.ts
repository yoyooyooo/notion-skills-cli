import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { authScope } from "../src/catalog.ts"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { withSharedAuthoringRequest } from "../src/shared-authoring-context.ts"
import { makeSharedCreatePlan } from "../src/shared-create-model.ts"
import { executeSharedCreate, loadPendingSharedCreates } from "../src/shared-create.ts"
import { sharedCreateOutcomeId } from "../src/shared-create-outcome.ts"
import { knownRecoveryPlan } from "../src/shared-create-recovery-known-model.ts"
import { prefixRecoveryPlan } from "../src/shared-create-recovery-prefix-model.ts"
import { validateSharedCreateNativeRecoveryReview } from "../src/shared-create-recovery-native-plan.ts"
import { sharedCreateRecoveryOutcomeId } from "../src/shared-create-recovery-completion.ts"
import { FileEventSchema } from "../src/shared-file-state.ts"
import {
  executeInventoryImport,
  validateInventoryImport,
  type InventoryImportPlan,
} from "../src/shared-inventory-import.ts"
import {
  reviewInventoryNativeRecovery,
  applyInventoryNativeRecovery,
  reconcileInventoryNativeRecovery,
} from "../src/shared-inventory-recovery.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
} from "../src/shared-records.ts"
import { Store } from "../src/store.ts"
import { sharedCreateFixture } from "./shared-create-fixture.ts"
import { id, rich } from "./shared-snapshot-fixture.ts"

const encode = (value: string) => new TextEncoder().encode(value)
const readObjectBytes = (hash: string) =>
  Effect.gen(function* () {
    return yield* (yield* Store).readBytes("objects/" + hash)
  })
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalSharedJson(value)).digest("hex")
const rawDigest = (value: string) => createHash("sha256").update(value).digest("hex")
const header =
  "---\nname: native-main-proof\ndescription: Complete native import\nlicense: MIT\ndisable-model-invocation: true\n---\n"
// Independent literals use the observed heading/list and heading/fence boundaries.
const authored = "## Roles\n- Main\n- Review\n\n## Inspect\n```bash\nprintf ready\n```\n"
const observed = "## Roles\n\n- Main\n- Review\n\n## Inspect\n\n```bash\nprintf ready\n```"

async function originalFailure(mode: "100644" | "100755" = "100755") {
  const f = sharedCreateFixture({ recovery: true, readback: () => observed })
  const input = header + authored
  const plan = await f.run(
    makeSharedCreatePlan(
      f.library,
      {
        portable: {
          kind: "skill",
          main: "SKILL.md",
          name: "native-main-proof",
          description: "Complete native import",
          files: [{ path: "SKILL.md", bytes: encode(input), mode }],
        },
        enabled: false,
        completeResources: true,
      },
      11,
    ),
  )
  const localFile = {
    path: "SKILL.md",
    real_path: "/controlled/private/native/SKILL.md",
    bytes: encode(input).length,
    mode,
    sha256: rawDigest(input),
    git_oid: null,
    status: "verified" as const,
    sensitive: false,
    metadata_identity: "controlled-original-fd",
  }
  const manifest = digest([
    {
      path: localFile.path,
      real_path: localFile.real_path,
      sha256: localFile.sha256,
      bytes: localFile.bytes,
      mode: localFile.mode,
      status: localFile.status,
    },
  ])
  const fields = {
    version: 1 as const,
    kind: "inventory_import" as const,
    library: f.library,
    reconciliation_id: "inventory-" + "a".repeat(64),
    local_inventory_id: "inventory-" + "b".repeat(64),
    remote_inventory_id: "inventory-" + "c".repeat(64),
    local_entity: {
      entity_id: "local-entity-" + "d".repeat(64),
      real_root: "/controlled/private/native",
      aliases: ["/controlled/private/native"],
      name: "native-main-proof",
      main: "SKILL.md",
      manifest_sha256: manifest,
      files: [localFile],
      identities: [],
      git: { repository_root: null, head: null, dirty: null, changed_paths: [] },
      classification: "local_custom" as const,
      findings: [],
    },
    approved_manifest: manifest,
    action: {
      kind: "create" as const,
      input_class: "native" as const,
      creation: plan,
      baseline_revision: null,
      selected_revision: null,
      custom_paths: ["SKILL.md"],
    },
    permissions:
      "only_this_complete_reviewed_entity; no_local_changes; no_existing_content_replacement" as const,
  }
  const outer: InventoryImportPlan = { ...fields, plan_id: "inventory-import-" + digest(fields) }
  await f.run(validateInventoryImport(outer))
  // Controlled historical v11 inventory intent. Current preparation uses v12;
  // the actual create dispatcher below produces the original request and ACK.
  await f.run(
    Effect.gen(function* () {
      const store = yield* Store
      yield* store.writeJson("plans/shared-inventory-imports/" + outer.plan_id + ".json", outer)
      yield* store.writeJson(
        "operations/shared-inventory-imports/" + outer.plan_id + ".json",
        outer,
      )
    }),
  )
  const failed = await f.run(Effect.flip(executeSharedCreate(f.library, { plan, mode: "create" })))
  expect(failed.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  const target = property(failed.details).skill_page_id
  if (typeof target !== "string") throw new Error("Missing original native main ACK")
  expect(f.nativeCreates()).toHaveLength(1)
  expect(f.writes()).toHaveLength(1)
  expect(
    await f.run(querySharedRecords(f.library, { skillPageId: target, kind: "operation" })),
  ).toEqual([])
  const selected = { entry: f.library.skills.database_id, plan: outer, target }
  f.clear()
  return { f, plan, outer, target, selected }
}
type Fixture = Awaited<ReturnType<typeof originalFailure>>
async function ready() {
  const setup = await originalFailure()
  const review = await setup.f.run(reviewInventoryNativeRecovery(setup.selected))
  return {
    ...setup,
    review,
    apply: { entry: setup.selected.entry, plan: setup.outer, review, reviewId: review.review_id },
  }
}
function originalKeys(f: Fixture) {
  return [...f.f.base.json.keys()].filter(
    (key) =>
      key.startsWith("operations/shared-sources/") &&
      /\/source-op-[a-f0-9]{64}\.json$/u.test(key) &&
      String(property(f.f.base.json.get(key)).identity).startsWith(f.plan.operation_id + ":"),
  )
}

test("the real native boundary is a v11 mismatch with one ACK, while prior fixed-Git variants still refuse it", async () => {
  const x = await originalFailure()
  expect(x.plan.files[0]!.projection.markdown).not.toBe(observed)
  expect((await x.f.run(Effect.flip(knownRecoveryPlan(x.plan)))).code).toBe(
    "SHARED_CREATE_RECOVERY_REQUIRED",
  )
  expect((await x.f.run(Effect.flip(prefixRecoveryPlan(x.plan)))).code).toBe(
    "SHARED_CREATE_RECOVERY_REQUIRED",
  )
  expect(originalKeys(x)).toHaveLength(1)
  expect(x.f.writes()).toHaveLength(0)
})

test("native review/dry-run freezes eight Records and recovery preserves its one disabled page and full metadata", async () => {
  const x = await ready(),
    { f } = x
  const original = canonicalSharedJson(x.plan),
    page = canonicalSharedJson(f.skills.get(x.target))
  expect(x.review).toMatchObject({
    version: 5,
    projection_version: 12,
    original_outcome_sha256: null,
  })
  expect(x.review.files[0]!.content).toMatchObject({
    mode: "100755",
    frontmatter: header,
    bytes: encode(observed).length,
    sha256: rawDigest(observed),
  })
  expect(canonicalSharedJson(x.review)).not.toContain("/controlled/private/")
  const dry = await f.run(applyInventoryNativeRecovery({ ...x.apply, dryRun: true }))
  expect(dry).toMatchObject({
    status: "planned",
    write_plan: {
      maximum_record_creates: 8,
      native_page_creates: 0,
      existing_body_patches: 0,
      metadata_patches: 0,
      notion_write_upper_bound: 8,
    },
  })
  expect(f.writes()).toHaveLength(0)
  const applied = await f.run(applyInventoryNativeRecovery(x.apply))
  expect(applied).toMatchObject({
    status: "recovered",
    verified: true,
    original_outcome_recorded: false,
    existing_pages_preserved: 1,
    created_pages: 0,
  })
  expect(f.writes()).toHaveLength(8)
  expect(f.nativeCreates()).toHaveLength(0)
  expect(f.enablePatches()).toHaveLength(0)
  expect(canonicalSharedJson(x.plan)).toBe(original)
  expect(canonicalSharedJson(f.skills.get(x.target))).toBe(page)
  expect(f.base.bodies.get(x.target)).toBe(observed)
  expect(
    await f.run(
      querySharedRecords(f.library, {
        skillPageId: x.target,
        kind: "operation",
        recordId: sharedCreateOutcomeId(x.plan.operation_id),
      }),
    ),
  ).toEqual([])
  f.clear()
  expect(await f.run(applyInventoryNativeRecovery(x.apply))).toMatchObject({
    status: "recovered",
    reused: true,
  })
  expect(f.writes()).toHaveLength(0)
})

async function interruptedFirstRecoveryRecord() {
  const x = await ready(),
    { f } = x
  let firstRecord: string | undefined
  let interrupt = true
  const failure = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* Effect.flip(
        applyInventoryNativeRecovery(x.apply).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              if (firstRecord && path === "v1/pages/" + firstRecord && interrupt) {
                interrupt = false
                return Effect.fail(fail("NETWORK_ERROR", "Interrupted exact ACK readback"))
              }
              return api.request(path, body, options).pipe(
                Effect.tap((raw) =>
                  Effect.sync(() => {
                    if (path === "v1/pages" && options?.method === "POST" && !firstRecord)
                      firstRecord = String(property(raw).id)
                  }),
                ),
              )
            },
          }),
        ),
      )
    }),
  )
  expect(failure.code).toBe("NETWORK_ERROR")
  expect(f.writes()).toHaveLength(1)
  return { ...x, firstRecord: firstRecord! }
}

test("an acknowledged first recovery Record resumes only its never-dispatched suffix", async () => {
  const x = await interruptedFirstRecoveryRecord(),
    { f, firstRecord } = x
  const originalPage = canonicalSharedJson(f.base.records.get(firstRecord!))
  f.clear()
  const dry = await f.run(applyInventoryNativeRecovery({ ...x.apply, dryRun: true }))
  expect(dry).toMatchObject({
    status: "planned",
    acknowledged_records: 1,
    write_plan: { maximum_record_creates: 7, notion_write_upper_bound: 7 },
  })
  expect(f.writes()).toHaveLength(0)
  const recovered = await f.run(applyInventoryNativeRecovery(x.apply))
  expect(recovered).toMatchObject({ status: "recovered", verified: true })
  expect(f.writes()).toHaveLength(7)
  expect(f.nativeCreates()).toHaveLength(0)
  expect(f.enablePatches()).toHaveLength(0)
  expect(canonicalSharedJson(f.base.records.get(firstRecord!))).toBe(originalPage)
  f.credential("independent-native-prefix-reader")
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  expect(await f.run(reconcileInventoryNativeRecovery(x.selected))).toMatchObject({
    status: "recovered",
    verified: true,
  })
  expect(f.writes()).toHaveLength(0)
})

test.each([
  "missing-ack",
  "changed-ack",
  "extra-dispatch",
  "foreign-dispatch",
  "changed-record",
] as const)("an interrupted native recovery with %s cannot create a suffix", async (kind) => {
  const x = await interruptedFirstRecoveryRecord(),
    { f } = x
  const key = [...f.base.json.keys()].find(
    (key) =>
      /\/source-op-[a-f0-9]{64}\.json$/u.test(key) &&
      String(property(f.base.json.get(key)).identity).startsWith(x.review.review_id + ":"),
  )!
  const ack = key.replace("/source-op-", "/source-ack-")
  if (kind === "missing-ack") f.base.json.delete(ack)
  if (kind === "changed-ack")
    f.base.json.set(ack, { ...property(f.base.json.get(ack)), response_hash: "f".repeat(64) })
  if (kind === "extra-dispatch")
    f.base.json.set(
      key.replace(/source-op-[a-f0-9]{64}/u, "source-op-" + "e".repeat(64)),
      f.base.json.get(key),
    )
  if (kind === "foreign-dispatch")
    f.base.json.set(
      key.replace(/\/[a-f0-9]{64}\//u, "/" + "e".repeat(64) + "/"),
      f.base.json.get(key),
    )
  if (kind === "changed-record")
    property(f.base.records.get(x.firstRecord)!.properties).hash = rich("hash", "f".repeat(64))
  f.clear()
  const result = await f.run(Effect.flip(applyInventoryNativeRecovery(x.apply)))
  expect(result.code).toMatch(/SHARED_CREATE|SHARED_RECORD|SOURCE_OPERATION/u)
  expect(f.writes()).toHaveLength(0)
})

test("independent empty Store reconstructs the original native ACK, body/header/mode and original reconcile-import", async () => {
  const x = await ready(),
    { f } = x
  await f.run(applyInventoryNativeRecovery(x.apply))
  f.credential("independent-native-reader")
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  const events = (
    await f.run(querySharedRecords(f.library, { skillPageId: x.target, kind: "file_event" }))
  ).map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload))
  expect(
    await f.run(loadPendingSharedCreates(f.library, { skillPageId: x.target, events })),
  ).toEqual([])
  expect(f.currentBodies()).toHaveLength(0)
  expect(await f.run(reconcileInventoryNativeRecovery(x.selected))).toMatchObject({
    verified: true,
    current_snapshot_verified: false,
  })
  expect(
    await f.run(executeInventoryImport(f.library, x.outer, { reconcile: true })),
  ).toMatchObject({
    verified: true,
    verification: "original_native_recovery_outcome",
    original_outcome_recorded: false,
  })
  const consume = Effect.gen(function* () {
    return yield* openSharedConsumer({
      library: f.library,
      target: x.target,
      scope: yield* authScope,
      startedAt: Date.now(),
      forceFull: true,
      readOnly: true,
    })
  })
  expect((await f.run(Effect.flip(consume))).code).toBe("CONTENT_DISABLED")
  const consumed = await f.run(withSharedAuthoringRequest(x.target, consume))
  expect(consumed.files).toHaveLength(1)
  expect(consumed.files[0]!.mode).toBe("100755")
  const bytes = await f.run(readObjectBytes(consumed.files[0]!.sha256))
  const expected =
    '---\n"description": "Complete native import"\n"disable-model-invocation": true\n"license": "MIT"\n"name": "native-main-proof"\n---\n\n' +
    observed +
    "\n"
  expect(new TextDecoder().decode(bytes)).toBe(expected)
  expect(consumed.files[0]!.sha256).toBe(rawDigest(expected))
  expect(f.writes()).toHaveLength(0)
})

test.each(["prepared", "executed", "copied-rehashed"] as const)(
  "missing or changed outer %s authority refuses before any write",
  async (kind) => {
    const x = await originalFailure()
    let outer = x.outer
    if (kind === "prepared")
      x.f.base.json.delete("plans/shared-inventory-imports/" + outer.plan_id + ".json")
    if (kind === "executed")
      x.f.base.json.delete("operations/shared-inventory-imports/" + outer.plan_id + ".json")
    if (kind === "copied-rehashed") {
      const { plan_id: _, ...fields } = outer
      const changed = { ...fields, reconciliation_id: "inventory-" + "e".repeat(64) }
      outer = { ...changed, plan_id: "inventory-import-" + digest(changed) }
    }
    const result = await x.f.run(
      Effect.flip(reviewInventoryNativeRecovery({ ...x.selected, plan: outer })),
    )
    expect(result.code).toBe("INVENTORY_IMPORT_NOT_PREPARED")
    expect(x.f.writes()).toHaveLength(0)
  },
)

test.each([
  "missing-ack",
  "extra-dispatch",
  "foreign-journal",
  "foreign-dispatch",
  "changed-request",
  "changed-ack",
] as const)("original %s evidence cannot authorize native recovery", async (kind) => {
  const x = await originalFailure(),
    key = originalKeys(x)[0]!
  const ackKey = key.replace("/source-op-", "/source-ack-")
  if (kind === "missing-ack") x.f.base.json.delete(ackKey)
  if (kind === "extra-dispatch")
    x.f.base.json.set(key.replace(/source-op-[a-f0-9]{64}/u, "source-op-" + "f".repeat(64)), {
      ...property(x.f.base.json.get(key)),
      identity: x.plan.operation_id + ":extra",
    })
  if (kind === "foreign-journal") {
    const original = [...x.f.base.json.keys()].find(
      (candidate) =>
        candidate.startsWith("operations/shared-native-create/") &&
        candidate.endsWith(x.plan.operation_id + ".json"),
    )!
    x.f.base.json.set(
      original.replace(/\/[a-f0-9]{64}\//u, "/" + "e".repeat(64) + "/"),
      x.f.base.json.get(original),
    )
  }
  if (kind === "foreign-dispatch")
    x.f.base.json.set(
      key.replace(/\/[a-f0-9]{64}\//u, "/" + "e".repeat(64) + "/"),
      x.f.base.json.get(key),
    )
  if (kind === "changed-request")
    x.f.base.json.set(key, { ...property(x.f.base.json.get(key)), body: {} })
  if (kind === "changed-ack")
    x.f.base.json.set(ackKey, {
      ...property(x.f.base.json.get(ackKey)),
      response_hash: "f".repeat(64),
    })
  const result = await x.f.run(Effect.flip(reviewInventoryNativeRecovery(x.selected)))
  expect(result.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
  expect(x.f.writes()).toHaveLength(0)
})

test.each([
  "body",
  "name",
  "source",
  "projection",
  "members",
  "extra-file",
  "extra-object",
] as const)("fresh %s drift after review refuses without any suffix write", async (kind) => {
  const x = await ready(),
    { f } = x
  const fields = property(f.skills.get(x.target)!.properties)
  if (kind === "body") f.base.bodies.set(x.target, observed + "\nLater human edit")
  if (kind === "name") fields.title = { type: "title", title: [{ plain_text: "Changed" }] }
  if (kind === "source") fields.source = rich("source", "foreign-source")
  if (kind === "projection")
    fields.projection = rich(
      "projection",
      '{"normalization_version":1,"sha256":"' + "a".repeat(64) + '"}',
    )
  if (kind === "members")
    fields.members = {
      id: "members",
      type: "relation",
      relation: [{ id: id(99) }],
      has_more: false,
    }
  if (kind === "extra-file") {
    const row = structuredClone(f.base.files[0]!)
    property(row.properties).skill = {
      id: "skill",
      type: "relation",
      relation: [{ id: x.target }],
      has_more: false,
    }
    f.files.set(row.id, row)
  }
  if (kind === "extra-object")
    await f.run(
      appendSharedRecord(f.library, {
        mode: "create",
        recordId: "extra-native-object",
        operationId: "extra-native-object",
        skillPageId: x.target,
        kind: "object",
        entityId: "extra-native-object",
        payload: { unexpected: true },
      }),
    )
  f.clear()
  const result = await f.run(Effect.flip(applyInventoryNativeRecovery(x.apply)))
  expect(result.code).toMatch(/SHARED_CREATE|SHARED_NATIVE|INVALID/u)
  expect(f.writes()).toHaveLength(0)
})

test.each(["truncated", "unknown_block_ids", "warnings", "has_more", "next_cursor"] as const)(
  "incomplete native response %s cannot authorize a recovery",
  async (field) => {
    const x = await originalFailure()
    const error = await x.f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* Effect.flip(
          reviewInventoryNativeRecovery(x.selected).pipe(
            Effect.provideService(Notion, {
              ...api,
              request: (path, body, options) =>
                api.request(path, body, options).pipe(
                  Effect.map((raw) =>
                    path.includes("/markdown")
                      ? {
                          ...property(raw),
                          [field]:
                            field === "unknown_block_ids" || field === "warnings"
                              ? ["incomplete"]
                              : field === "next_cursor"
                                ? "cursor"
                                : true,
                        }
                      : raw,
                  ),
                ),
            }),
          ),
        )
      }),
    )
    expect(error.code).toBe("BODY_INCOMPLETE")
    expect(x.f.writes()).toHaveLength(0)
  },
)

test("a hidden unknown first review POST leaves a journal that permits only read-only reconciliation", async () => {
  const x = await ready(),
    { f } = x
  let attemptedWrites = 0
  const failed = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* Effect.flip(
        applyInventoryNativeRecovery(x.apply).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              if (path !== "v1/pages" || options?.method !== "POST")
                return api.request(path, body, options)
              return Effect.sync(() => {
                attemptedWrites += 1
                expect(payloadOf(body).kind).toBe("skill_create_recovery_review")
              }).pipe(
                Effect.flatMap(() =>
                  Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Lost first review Record response")),
                ),
              )
            },
          }),
        ),
      )
    }),
  )
  expect(failed.code).toBe("WRITE_OUTCOME_UNKNOWN")
  expect(attemptedWrites).toBe(1)
  expect(
    [...f.base.json.keys()].filter((key) => key.startsWith("operations/shared-native-recovery/")),
  ).toHaveLength(1)
  expect(
    await f.run(querySharedRecords(f.library, { skillPageId: x.target, kind: "operation" })),
  ).toEqual([])
  f.clear()
  const later = await f.run(Effect.flip(applyInventoryNativeRecovery(x.apply)))
  expect(later.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
  expect(later.message).toContain("No exact native recovery manifest is visible")
  expect(f.writes()).toHaveLength(0)
  expect(f.currentBodies()).toHaveLength(0)
})

test.each([true, false])(
  "a lost native completion visible=%s never replays its recovery suffix",
  async (visible) => {
    const x = await ready(),
      { f } = x
    f.unknown("recovery_outcome", visible)
    const failed = await f.run(Effect.flip(applyInventoryNativeRecovery(x.apply)))
    expect(failed.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(f.writes()).toHaveLength(8)
    f.clear()
    const later = await f.run(Effect.result(applyInventoryNativeRecovery(x.apply)))
    if (visible)
      expect(later).toMatchObject({
        _tag: "Success",
        success: { status: "recovered", reused: true },
      })
    else
      expect(later).toMatchObject({
        _tag: "Failure",
        failure: { code: "SHARED_CREATE_RECOVERY_REQUIRED" },
      })
    expect(f.writes()).toHaveLength(0)
  },
)

function retainedRow(x: Fixture, kind: string) {
  const found = [...x.f.base.records.values()].find((row) => {
    const encoded = text(property(property(row.properties).payload).rich_text)
    return encoded && property(property(JSON.parse(encoded)).payload).kind === kind
  })
  if (!found) throw new Error("Missing retained " + kind)
  return found
}
function payloadOf(row: unknown) {
  return property(
    property(JSON.parse(text(property(property(property(row).properties).payload).rich_text)))
      .payload,
  )
}
function rewriteRow(
  row: unknown,
  operation: string,
  payload: unknown,
  recordId?: string,
  entityId?: string,
) {
  const fields = property(property(row).properties),
    envelope = { version: 1, operation_id: operation, payload },
    hash = digest(envelope)
  fields.payload = rich("payload", canonicalSharedJson(envelope))
  fields.hash = rich("hash", hash)
  if (recordId !== undefined) fields.record = rich("record", recordId)
  if (entityId !== undefined) fields.entity = rich("entity", entityId)
  return hash
}
function rebindReview(x: Fixture, edit: (review: Record<string, unknown>) => void) {
  const row = retainedRow(x, "skill_create_recovery_review"),
    old = payloadOf(row)
  edit(old)
  const { review_id: _, ...fields } = old,
    reviewId = "create-recovery-" + digest(fields)
  const updated = { ...fields, review_id: reviewId }
  const reviewHash = rewriteRow(row, reviewId, updated)
  const completion = retainedRow(x, "skill_create_recovery_outcome"),
    outcome = payloadOf(completion)
  outcome.recovery_id = reviewId
  outcome.review_record_hash = reviewHash
  outcome.bootstrap_sha256 = digest(property(updated).bootstrap)
  const reviewFiles = property(updated).files,
    outcomeBindings = outcome.bindings
  if (Array.isArray(reviewFiles) && Array.isArray(outcomeBindings))
    property(outcomeBindings[0]).event_id = property(property(reviewFiles[0]).event).event_id
  rewriteRow(completion, reviewId, outcome)
}

test("cold native completion commits the same verified ACK observation and rejects later drift", async () => {
  const x = await ready(),
    { f } = x
  await f.run(applyInventoryNativeRecovery(x.apply))
  const record = retainedRow(x, "native_create_acknowledgement"),
    proof = payloadOf(record),
    operation = "retain-native-ack-" + digest(proof),
    recordId = text(property(property(record.properties).record).rich_text)
  f.credential("cold-single-observation-reader")
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  let proofQueries = 0
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* reconcileInventoryNativeRecovery(x.selected).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            api.request(path, body, options).pipe(
              Effect.map((raw) => {
                if (
                  !path.startsWith(`v1/data_sources/${f.library.records.data_source_id}/query`) ||
                  !canonicalSharedJson(body).includes(recordId)
                )
                  return raw
                proofQueries += 1
                const observed = structuredClone(raw)
                property(proof.acknowledgement).response_hash = "f".repeat(64)
                rewriteRow(record, operation, proof)
                return observed
              }),
            ),
        }),
      )
    }),
  )
  expect(result).toMatchObject({ status: "recovered", verified: true })
  expect(proofQueries).toBe(1)
  expect((await f.run(Effect.flip(reconcileInventoryNativeRecovery(x.selected)))).code).toBe(
    "SHARED_CREATE_RECOVERY_REQUIRED",
  )
  expect(f.writes()).toHaveLength(0)
  expect(f.currentBodies()).toHaveLength(0)
})

test.each([
  "missing-ack-fact",
  "missing-original-body",
  "coherent-request",
  "coherent-ack-owner",
  "coherent-header",
  "coherent-mode",
  "dispatch-commitment",
] as const)(
  "cold native completion refuses %s without current-body reads or writes",
  async (kind) => {
    const x = await ready(),
      { f } = x
    await f.run(applyInventoryNativeRecovery(x.apply))
    if (kind === "missing-ack-fact")
      f.base.records.delete(String(retainedRow(x, "native_create_acknowledgement").id))
    if (kind === "missing-original-body") {
      const record = [...f.base.records.values()].find(
        (row) =>
          text(property(property(row.properties).record).rich_text) ===
          x.plan.files[0]!.content.object_id,
      )!
      f.base.records.delete(String(record.id))
    }
    if (kind === "coherent-request" || kind === "coherent-ack-owner") {
      const record = retainedRow(x, "native_create_acknowledgement"),
        proof = payloadOf(record)
      const request = property(proof.dispatch),
        ack = property(proof.acknowledgement)
      if (kind === "coherent-request") {
        property(request.body).markdown =
          String(property(request.body).markdown) + "\nA different POST"
        request.identity =
          x.plan.operation_id + ":" + digest([request.path, request.method, request.body])
        const { version: _version, operation: _operation, ...fields } = request
        request.operation = "source-op-" + digest(fields)
        ack.operation_id = request.operation
        ack.request_hash = digest(request)
      } else {
        property(property(ack.response).parent).data_source_id = id(999)
        ack.response_hash = digest(ack.response)
      }
      const proofId = "native-ack-" + digest(proof),
        op = "retain-native-ack-" + digest(proof)
      const hash = rewriteRow(record, op, proof, proofId, proofId)
      rebindReview(x, (review) => {
        const bootstrap = property(review.bootstrap),
          refs = bootstrap.allocations
        if (!Array.isArray(refs)) throw new Error("Missing proof directory")
        Object.assign(property(refs[0]), { record_id: proofId, hash })
        bootstrap.original_dispatches_sha256 = digest([{ dispatch: request, acknowledgement: ack }])
      })
    }
    if (kind === "coherent-header" || kind === "coherent-mode") {
      const row = retainedRow(x, "adopted"),
        event = payloadOf(row),
        content = property(event.content)
      if (kind === "coherent-header")
        content.frontmatter = String(content.frontmatter).replace("MIT", "Forged")
      else content.mode = "100644"
      const { event_id: _, ...fields } = event
      event.event_id =
        "recovery-file-" +
        digest({
          version: 5,
          original_operation_id: x.plan.operation_id,
          projection_version: 12,
          event: fields,
        })
      rewriteRow(row, String(event.event_id), event, String(event.event_id))
      rebindReview(x, (review) => {
        if (!Array.isArray(review.files)) throw new Error("Missing native full metadata")
        const file = property(review.files[0])
        file.content = content
        file.event = event
      })
    }
    if (kind === "dispatch-commitment")
      rebindReview(x, (review) => {
        property(review.bootstrap).original_dispatches_sha256 = "f".repeat(64)
      })
    f.credential("cold-forgery-reader")
    f.base.json.clear()
    f.base.objects.clear()
    f.clear()
    const refused = await f.run(Effect.flip(reconcileInventoryNativeRecovery(x.selected)))
    expect(refused.code).toMatch(/SHARED_CREATE|SHARED_RECORD/u)
    expect(f.writes()).toHaveLength(0)
    expect(f.currentBodies()).toHaveLength(0)
  },
)

test("body change during the retained suffix stops before completion, with no body patch or later resume", async () => {
  const x = await ready(),
    { f } = x
  let writes = 0
  const failed = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* Effect.flip(
        applyInventoryNativeRecovery(x.apply).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              api.request(path, body, options).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (path === "v1/pages" && options?.method === "POST" && ++writes === 2)
                      f.base.bodies.set(x.target, observed + "\nA later edit")
                  }),
                ),
              ),
          }),
        ),
      )
    }),
  )
  expect(failed.code).toBe("SHARED_CREATE_RECOVERY_REQUIRED")
  expect(f.writes()).toHaveLength(2)
  expect(f.enablePatches()).toHaveLength(0)
  f.clear()
  expect((await f.run(Effect.flip(applyInventoryNativeRecovery(x.apply)))).code).toBe(
    "SHARED_CREATE_RECOVERY_REQUIRED",
  )
  expect(f.writes()).toHaveLength(0)
  expect(f.base.bodies.get(x.target)).toBe(observed + "\nA later edit")
})
