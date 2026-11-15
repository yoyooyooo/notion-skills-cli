import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { authScope } from "../src/catalog.ts"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  executeSharedCreate,
  loadSharedCreatePlan,
  reconcileSharedCreate,
} from "../src/shared-create.ts"
import { prepareSharedSourceProjection } from "../src/shared-source-projection.ts"
import { readSourceDefinition } from "../src/shared-source-definitions.ts"
import { querySharedRecords, canonicalSharedJson } from "../src/shared-records.ts"
import { sharedCreateOutcomeId } from "../src/shared-create-outcome.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { withSharedAuthoringTarget } from "../src/shared-authoring-context.ts"
import { fixture, library, ids } from "./shared-source-projection-fixture.ts"
import { id, rich } from "./shared-snapshot-fixture.ts"
import { prepareSourceOnboarding } from "../src/shared-source-onboarding.ts"
import {
  selectOriginalSourceRecoveryPlan,
  sourceRecoveryError,
} from "../src/shared-source-recovery.ts"
import { Store } from "../src/store.ts"
import { inspectAuditSkill } from "../src/shared-audit-inspect.ts"
import { emptyAuditInventory } from "../src/shared-audit-model.ts"
import { sharedCreateManifestEntity } from "../src/shared-create-model.ts"
import {
  reviewSharedRetainedImportRecovery,
  applySharedRetainedImportRecovery,
  reconcileSharedRetainedImportRecovery,
  retainedImportRecoveryOriginal,
  retainedImportRecoveryReviewsEntity,
} from "../src/shared-create-retained-recovery.ts"

async function failedOriginal() {
  const f = fixture(
    [
      {
        path: "references/second.md",
        bytes: new TextEncoder().encode("## Second\n\nKeep the original complete text.\n"),
        mode: "100644",
      },
      {
        path: "references/third.md",
        bytes: new TextEncoder().encode("## Third\n\nA complete undispatched suffix.\n"),
        mode: "100644",
      },
    ],
    { markdownImport: true, recovery: true },
  )
  const plan = await f.run(
    Effect.gen(function* () {
      return yield* prepareSharedSourceProjection({
        library,
        definition: yield* readSourceDefinition(library, f.source.id),
        acquired: f.snapshot,
        member: "skills/demo",
        skillId: "retained-recovery-original",
        enabled: false,
        markdownImport: true,
        storage: "retained",
      })
    }),
  )
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* Effect.flip(executeSharedCreate(library, { plan, mode: "create" })).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            api.request(path, body, options).pipe(
              Effect.flatMap((response) => {
                const page = path.replace(/^v1\/pages\//u, "").replace(/\/markdown\?.*$/u, "")
                return path.includes("/markdown?") && f.files.has(page)
                  ? Effect.fail(
                      fail(
                        "SHARED_CREATE_BODY_MISMATCH",
                        "Previous validator rejected a native representation.",
                        { component: "text" },
                      ),
                    )
                  : Effect.succeed(response)
              }),
            ),
        }),
      )
    }),
  )
  expect(result.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  const page = String(property(result.details).skill_page_id)
  const outcomes = await f.run(
    querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      recordId: sharedCreateOutcomeId(plan.operation_id),
    }),
  )
  expect(outcomes).toHaveLength(1)
  expect(property(outcomes[0]!.payload).status).toBe("needs_review")
  const bodies = new Map(f.base.bodies)
  const oldFailure = canonicalSharedJson(outcomes[0])
  f.clear()
  return {
    ...f,
    plan,
    page,
    originalInput: canonicalSharedJson(plan),
    oldFailure,
    bodies,
    input: { entry: library.skills.database_id, target: page, plan },
  }
}

test("explicit retained import review resumes the original acknowledged prefix and cold readers verify a separate completion", async () => {
  const f = await failedOriginal()
  await expect(
    f.run(executeSharedCreate(library, { plan: f.plan, mode: "create" })),
  ).rejects.toMatchObject({ code: "SHARED_CREATE_REVIEW_REQUIRED" })
  const review = await f.run(reviewSharedRetainedImportRecovery(f.input))
  expect(review.original_operation_id).toBe(f.plan.operation_id)
  expect(review.bindings).toHaveLength(2)
  expect(f.writes()).toHaveLength(0)
  const input = { ...f.input, review, reviewId: review.review_id }
  const dry = await f.run(applySharedRetainedImportRecovery({ ...input, dryRun: true }))
  expect(dry.remote_writes).toBe(0)
  expect(f.writes()).toHaveLength(0)
  const done = await f.run(applySharedRetainedImportRecovery(input))
  expect(done.verified).toBe(true)
  expect(done.skill_page_id).toBe(f.page)
  expect(done.operation_id).toBe(f.plan.operation_id)
  const ids: Readonly<Record<string, string>> = library.skills.property_ids
  expect(
    f
      .writes()
      .some(
        (call) =>
          call.method === "PATCH" &&
          property(property(property(call.body).properties)[ids.Enabled!]).checkbox === true,
      ),
  ).toBe(false)
  expect(
    f
      .nativeCreates()
      .filter(
        (call) =>
          property(property(call.body).parent).data_source_id === library.skills.data_source_id,
      ),
  ).toHaveLength(0)
  expect(f.nativeCreates()).toHaveLength(f.plan.files.length - 2)
  for (const [page, body] of f.bodies) expect(f.base.bodies.get(page)).toBe(body)
  expect(canonicalSharedJson(f.plan)).toBe(f.originalInput)
  const old = await f.run(
    querySharedRecords(library, {
      skillPageId: f.page,
      kind: "operation",
      recordId: sharedCreateOutcomeId(f.plan.operation_id),
    }),
  )
  expect(canonicalSharedJson(old[0])).toBe(f.oldFailure)
  f.clear()
  expect((await f.run(applySharedRetainedImportRecovery(input))).verified).toBe(true)
  expect((await f.run(reconcileSharedRetainedImportRecovery(f.input))).verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  expect((await f.run(reconcileSharedCreate(library, f.plan))).verified).toBe(true)
  expect(
    await f.run(
      loadSharedCreatePlan(library, { skillPageId: f.page, operationId: f.plan.operation_id }),
    ),
  ).toEqual(f.plan)
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
          readOnly: true,
        })
      }),
    ),
  )
  expect(cold.files.map((file) => file.path)).toEqual(
    f.snapshot.members[0]!.portable.files.map((file) => file.path),
  )
  for (const original of f.snapshot.members[0]!.portable.files.filter(
    (file) => file.path !== "SKILL.md",
  )) {
    const file = cold.files.find((file) => file.path === original.path)!
    expect(f.base.objects.get(`objects/${file.sha256}`)).toEqual(original.bytes)
  }
  expect(f.writes()).toHaveLength(0)
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
})

test("retained recovery headers require an exact original manifest and never imply completion", () => {
  const id = "skill-create-" + "b".repeat(64)
  const original = {
    page_id: "original-record",
    record_id: id,
    entity_id: sharedCreateManifestEntity,
    hash: "c".repeat(64),
  }
  const header = {
    page_id: "review-record",
    record_id: "retained-readback-review-" + id,
    entity_id: retainedImportRecoveryReviewsEntity,
    hash: "d".repeat(64),
  }
  expect(retainedImportRecoveryOriginal(header, [original, header])).toBe(id)
  expect(retainedImportRecoveryOriginal(header, [header])).toBeUndefined()
  expect(
    retainedImportRecoveryOriginal({ ...header, entity_id: "unowned-review" }, [original]),
  ).toBeUndefined()
  expect(
    retainedImportRecoveryOriginal({ ...header, record_id: header.record_id + "-forged" }, [
      original,
    ]),
  ).toBeUndefined()
})

test.each(["ack", "journal", "body", "source", "definition", "owner", "review"] as const)(
  "reviewed retained recovery refuses changed or missing %s with zero remote writes",
  async (guard) => {
    const f = await failedOriginal()
    const review = await f.run(reviewSharedRetainedImportRecovery(f.input))
    if (guard === "ack") {
      const key = [...f.base.json.keys()].find(
        (key) =>
          key.includes("/source-ack-") &&
          property(property(f.base.json.get(key)).response).id === f.page,
      )!
      expect(key).toBeDefined()
      f.base.json.delete(key)
    } else if (guard === "journal") {
      const key = [...f.base.json.keys()].find(
        (key) =>
          key.startsWith("operations/shared-native-create/") &&
          key.endsWith(`/${f.plan.operation_id}.json`),
      )!
      expect(key).toBeDefined()
      f.base.json.delete(key)
    } else if (guard === "definition") {
      f.source.properties[ids.Ref!] = rich(ids.Ref!, "changed-after-review")
    } else if (guard === "owner") {
      const file = [...f.files.values()].find((row) =>
        review.bindings.some((binding) => binding.page_id === row.id),
      )!
      property(file.properties).skill = {
        id: "skill",
        type: "relation",
        relation: [{ id: id(98765) }],
        has_more: false,
      }
    } else if (guard === "body")
      f.base.bodies.set(f.page, "# Changed original author instructions\n")
    else if (guard === "source") {
      const props = property(f.skills.get(f.page)!.properties)
      props.source_member = {
        id: "source_member",
        type: "rich_text",
        rich_text: [{ plain_text: "different-member", text: { content: "different-member" } }],
      }
    }
    f.clear()
    await expect(
      f.run(
        applySharedRetainedImportRecovery({
          ...f.input,
          review,
          reviewId: guard === "review" ? "wrong-review" : review.review_id,
        }),
      ),
    ).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
  },
)

test.each([false, true])(
  "an unknown recovered suffix visible=%s cannot be resent or inferred from current pages",
  async (visible) => {
    const f = await failedOriginal()
    const review = await f.run(reviewSharedRetainedImportRecovery(f.input))
    const request = { ...f.input, review, reviewId: review.review_id }
    f.unknown("file", visible)
    await expect(f.run(applySharedRetainedImportRecovery(request))).rejects.toBeDefined()
    const old = await f.run(
      querySharedRecords(library, {
        skillPageId: f.page,
        kind: "operation",
        recordId: sharedCreateOutcomeId(f.plan.operation_id),
      }),
    )
    expect(canonicalSharedJson(old[0])).toBe(f.oldFailure)
    f.clear()
    await expect(f.run(applySharedRetainedImportRecovery(request))).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
    expect(f.nativeCreates()).toHaveLength(0)
  },
)

test("a definitively rejected native suffix remains unreplayed and its public diagnostic omits complete input", async () => {
  const f = await failedOriginal()
  const review = await f.run(reviewSharedRetainedImportRecovery(f.input))
  const request = { ...f.input, review, reviewId: review.review_id }
  let refusedRequests = 0
  const rejected = Effect.gen(function* () {
    const api = yield* Notion
    return yield* applySharedRetainedImportRecovery(request).pipe(
      Effect.provideService(Notion, {
        ...api,
        request: (path, body, options) => {
          if (
            path === "v1/pages" &&
            options?.method === "POST" &&
            property(property(body).parent).data_source_id === library.files.data_source_id
          ) {
            refusedRequests++
            return Effect.fail(
              fail("NOTION_REQUEST_FAILED", "Controlled native validation rejection", {
                phase: "definitive_rejection",
                http_status: 400,
                notion_code: "validation_error",
              }),
            )
          }
          return api.request(path, body, options)
        },
      }),
      Effect.mapError((error) => sourceRecoveryError(error, f.plan)),
      Effect.flip,
    )
  })
  const error = await f.run(rejected)
  expect(error.code).toBe("SOURCE_WRITE_NOT_APPLIED")
  expect(refusedRequests).toBe(1)
  const details = property(error.details)
  expect(details.path).toBe("references/second.md")
  expect(details.native_create_operation_id).toBe(f.plan.operation_id)
  expect(details).toMatchObject({
    http_status: 400,
    notion_code: "validation_error",
    phase: "definitive_rejection",
    native_retry_allowed: false,
  })
  expect(property(property(details.recovery).original_plan)).toMatchObject({
    operation_id: f.plan.operation_id,
    skill_id: f.plan.skill_id,
    retained_in_saved_input: true,
    full_input_omitted: true,
  })
  expect(Object.hasOwn(property(details.recovery), "plan")).toBe(false)
  expect(JSON.stringify(error).length).toBeLessThan(4000)
  const wrapped = sourceRecoveryError(
    fail(error.code, error.message, {
      original_details: { ...details, recovery: { mode: "reconcile", plan: f.plan } },
      budget: { exhausted: null },
    }),
    f.plan,
  )
  expect(
    Object.hasOwn(property(property(property(wrapped.details).original_details).recovery), "plan"),
  ).toBe(false)
  expect(JSON.stringify(wrapped).length).toBeLessThan(4000)
  f.clear()
  // Removing the temporary 400 responder does not authorize a second attempt.
  await expect(f.run(applySharedRetainedImportRecovery(request))).rejects.toBeDefined()
  expect(f.writes()).toHaveLength(0)
  expect(f.nativeCreates()).toHaveLength(0)
  for (const [page, body] of f.bodies) expect(f.base.bodies.get(page)).toBe(body)
  const original = await f.run(
    querySharedRecords(library, {
      skillPageId: f.page,
      kind: "operation",
      recordId: sharedCreateOutcomeId(f.plan.operation_id),
    }),
  )
  expect(canonicalSharedJson(original[0])).toBe(f.oldFailure)
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
    audit.findings.some(
      (finding) =>
        finding.code === "ORIGINAL_OPERATION_UNRESOLVED" ||
        finding.code === "OPERATION_EVIDENCE_UNAVAILABLE",
    ),
  ).toBe(true)
  expect(f.writes()).toHaveLength(0)
})

test.each(["allocation", "review"] as const)(
  "cold completion refuses a missing full original %s fact",
  async (missing) => {
    const f = await failedOriginal()
    const review = await f.run(reviewSharedRetainedImportRecovery(f.input))
    expect(
      (
        await f.run(
          applySharedRetainedImportRecovery({ ...f.input, review, reviewId: review.review_id }),
        )
      ).verified,
    ).toBe(true)
    const recordId =
      missing === "allocation"
        ? review.allocations[0]!.record_id
        : `retained-readback-review-${f.plan.operation_id}`
    let removed = false
    for (const [key, row] of f.base.records) {
      if (text(property(property(row.properties).record).rich_text) === recordId) {
        f.base.records.delete(key)
        removed = true
      }
    }
    expect(removed).toBe(true)
    f.base.objects.clear()
    f.base.json.clear()
    f.clear()
    await expect(f.run(reconcileSharedCreate(library, f.plan))).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
  },
)

test("a lost completion-record response settles from exact retained facts without replaying native writes", async () => {
  const f = await failedOriginal()
  const review = await f.run(reviewSharedRetainedImportRecovery(f.input))
  const input = { ...f.input, review, reviewId: review.review_id }
  let dropped = false
  const loss = Effect.gen(function* () {
    const api = yield* Notion
    return yield* applySharedRetainedImportRecovery(input).pipe(
      Effect.provideService(Notion, {
        ...api,
        request: (path, body, options) =>
          api.request(path, body, options).pipe(
            Effect.flatMap((result) => {
              if (
                !dropped &&
                path === "v1/pages" &&
                options?.method === "POST" &&
                text(property(property(property(body).properties).payload).rich_text).includes(
                  '"kind":"retained_create_readback_completion"',
                )
              ) {
                dropped = true
                return Effect.fail(
                  fail("NOTION_REQUEST_FAILED", "Controlled completion response loss"),
                )
              }
              return Effect.succeed(result)
            }),
          ),
      }),
    )
  })
  await expect(f.run(loss)).rejects.toBeDefined()
  expect(dropped).toBe(true)
  f.clear()
  const done = await f.run(applySharedRetainedImportRecovery(input))
  expect(done.verified).toBe(true)
  expect(f.writes()).toHaveLength(0)
  expect(
    await f.run(
      Effect.flatMap(Store, (store) => store.listKeys("operations/shared-native-recovery/")),
    ),
  ).toEqual([])
  expect(
    await f.run(
      Effect.flatMap(Store, (store) => store.listKeys("operations/shared-native-create/")),
    ),
  ).toEqual([])
})

test("public recovery selects only an unchanged exact creation from its saved onboarding parent", async () => {
  const f = fixture([], { markdownImport: true, recovery: true })
  f.skills.clear()
  const parent = await f.run(
    prepareSourceOnboarding(
      library,
      { kind: "source", source: f.source.id },
      { storage: "retained" },
      () => Effect.succeed(f.snapshot),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
  const action = parent.actions[0]
  if (action?.kind !== "create") throw new Error("Expected one reviewed original creation")
  expect(await f.run(selectOriginalSourceRecoveryPlan(parent, action.plan.operation_id))).toEqual(
    action.plan,
  )
  expect(
    await f.run(selectOriginalSourceRecoveryPlan(action.plan, action.plan.operation_id)),
  ).toEqual(action.plan)
  await expect(f.run(selectOriginalSourceRecoveryPlan(parent))).rejects.toMatchObject({
    code: "SOURCE_RECOVERY_OPERATION_REQUIRED",
  })
  await expect(
    f.run(selectOriginalSourceRecoveryPlan(parent, "skill-create-" + "f".repeat(64))),
  ).rejects.toMatchObject({ code: "SOURCE_RECOVERY_SCOPE" })
  await expect(
    f.run(
      selectOriginalSourceRecoveryPlan(
        { ...parent, plan_id: "source-onboarding-" + "0".repeat(64) },
        action.plan.operation_id,
      ),
    ),
  ).rejects.toMatchObject({ code: "SOURCE_ONBOARDING_INVALID" })
  await expect(
    f.run(selectOriginalSourceRecoveryPlan(action.plan, "different-original")),
  ).rejects.toMatchObject({ code: "SOURCE_RECOVERY_SCOPE" })
  expect(f.writes()).toHaveLength(0)
})
