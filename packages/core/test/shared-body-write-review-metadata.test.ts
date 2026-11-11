import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  bodyWriteOutcomeId,
  retainedMarkdownPayload,
  type SharedBodyWritePlan,
} from "../src/shared-body-write-model.ts"
import {
  executeSharedBodyWrite,
  prepareSharedBodyWrite,
  reconcileSharedBodyWrite,
} from "../src/shared-body-write.ts"
import {
  reconcileSharedBodyWriteReview,
  reviewSharedBodyWrite,
} from "../src/shared-body-write-review.ts"
import {
  bodyWriteReviewOperationId,
  bodyWriteReviewReceiptId,
  validateSharedBodyWriteReviewPlan,
  type SharedBodyWriteReviewPlan,
} from "../src/shared-body-write-review-model.ts"
import { resolveFileState, type NativeFileMetadata } from "../src/shared-file-state.ts"
import {
  retainPendingFileOperation,
  sharedPendingObservationPrefix,
} from "../src/shared-pending-file-operations.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  candidate,
  client,
  creates,
  eventRows,
  failure,
  fileId,
  hash,
  id,
  library,
  original,
  patches,
  payloadFor,
  reads,
  remote,
  rowRecordId,
  seed,
  skillPage,
} from "./shared-body-write-review-fixture.ts"

const scope = hash("body-review-native-metadata")
const observed = "# Changed\nObserved content with retained metadata.\n"
const frontmatter =
  "---\nname: Write fixture\ndescription: Whole-file write fixture\nlicense: Complete terms in LICENSE.txt\nmetadata:\n  owner: example\n  reviewed: true\n---\n"

const review = (
  plan: SharedBodyWritePlan,
  options: { readonly mode?: "create" | "reconcile"; readonly dryRun?: boolean } = {},
) =>
  reviewSharedBodyWrite({
    library,
    skillPageId: skillPage,
    originalOperationId: plan.operation_id,
    acceptedObservedSha256: hash(observed),
    scope,
    mode: options.mode ?? "create",
    dryRun: options.dryRun ?? false,
  })

async function needsReview(target: "main" | "support", metadata: NativeFileMetadata) {
  const shared = remote(original, target === "main" ? metadata : {})
  const selectedFile = target === "main" ? fileId : "file-support"
  if (target === "support") {
    shared.support = {
      page_id: id(12),
      file_id: selectedFile,
      path: "references/executable.md",
      markdown: original,
    }
    const event = {
      event_id: "support-initial",
      file_id: selectedFile,
      parents: [],
      kind: "adopted" as const,
      content: {
        object_id: `body-${hash(original)}`,
        sha256: hash(original),
        bytes: new TextEncoder().encode(original).byteLength,
        ...metadata,
      },
    }
    seed(shared, "file_event", event.event_id, event.event_id, selectedFile, event)
  }
  const api = client(shared, { readback: () => observed })
  const plan = await api.run(
    prepareSharedBodyWrite({
      library,
      skillPageId: skillPage,
      fileId: selectedFile,
      candidateMarkdown: candidate,
      action: "write",
    }),
  )
  const result = await api.run(
    executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result),
  )
  expect(failure(result).code).toBe("SHARED_BODY_WRITE_REVIEW_REQUIRED")
  expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toMatchObject({
    status: "needs_review",
    reason_code: "SHARED_BODY_WRITE_MISMATCH",
  })
  expect(patches(api)).toHaveLength(1)
  return { shared, plan }
}

/** Retained v1 wire format, independent of the current review constructor/default. */
function legacyV1Plan(plan: SharedBodyWriteReviewPlan) {
  const content = {
    object_id: plan.content.object_id,
    sha256: plan.content.sha256,
    bytes: plan.content.bytes,
  }
  const description = {
    version: 1,
    kind: "body_write_review",
    original_operation_id: plan.original_operation_id,
    observation_sha256: plan.observation_sha256,
    accepted_observed_sha256: plan.accepted_observed_sha256,
    file_id: plan.file_id,
    parents: plan.event.parents,
    content,
  }
  return validateSharedBodyWriteReviewPlan({
    ...plan,
    version: 1,
    content,
    event: {
      ...plan.event,
      content,
      event_id: `review-adopt-${hash(canonicalSharedJson(description))}`,
    },
  })
}

/** Original v1 receipt format is deliberately not rebuilt by the current helper. */
function seedLegacyCompletion(shared: ReturnType<typeof remote>, plan: SharedBodyWriteReviewPlan) {
  seed(shared, "operation", plan.operation_id, plan.operation_id, plan.file_id, plan)
  seed(
    shared,
    "object",
    plan.content.object_id,
    `retain-${plan.content.sha256}`,
    plan.content.object_id,
    retainedMarkdownPayload(observed),
  )
  seed(shared, "file_event", plan.event.event_id, plan.operation_id, plan.file_id, plan.event)
  seed(
    shared,
    "operation",
    bodyWriteReviewReceiptId(plan.operation_id),
    plan.operation_id,
    plan.file_id,
    {
      version: 1,
      kind: "body_write_review_receipt",
      operation_id: plan.operation_id,
      original_operation_id: plan.original_operation_id,
      original_status: "needs_review",
      status: "reviewed",
      decision: "accepted_observed",
      file_id: plan.file_id,
      accepted_observed_sha256: plan.accepted_observed_sha256,
      content_sha256: plan.content.sha256,
      observation_id: plan.observation_id,
      observation_sha256: plan.observation_sha256,
      event_id: plan.event.event_id,
      plan_sha256: hash(
        canonicalSharedJson({ version: 1, operation_id: plan.operation_id, payload: plan }),
      ),
    },
  )
}

describe("body review native metadata and retained v1 identity", () => {
  test.each([
    ["main", { mode: "100644", frontmatter }],
    ["support", { mode: "100755", frontmatter: "---\nlicense: MIT\nowner: example\n---\n\n" }],
  ] as const)("new %s review retains the original native metadata", async (target, metadata) => {
    const { shared, plan } = await needsReview(target, metadata)
    expect(plan.candidate.content).toMatchObject(metadata)
    const api = client(shared)
    const preview = await api.run(review(plan, { dryRun: true }))
    if (preview.status !== "planned") throw new Error("Expected a dry review plan")
    expect(preview.plan.content).toMatchObject(metadata)
    expect(preview.plan.event.content).toEqual(preview.plan.content)
    expect(preview.plan.version).toBe(2)
    expect(preview.plan.operation_id).toBe(
      await api.run(bodyWriteReviewOperationId(plan.operation_id)),
    )
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
    const accepted = await api.run(review(plan))
    if (accepted.status !== "reviewed") throw new Error("Expected completed review")
    expect(accepted.event.content).toEqual(preview.plan.content)
    const ownership = resolveFileState(
      plan.file_id,
      eventRows(shared).filter((event) => event.file_id === plan.file_id),
    ).ownership
    expect(ownership).toEqual({ kind: "custom", content: preview.plan.content })
    expect(patches(api)).toHaveLength(0)
    expect(target === "main" ? shared.markdown : shared.support?.markdown).toBe(observed)
    shared.local.clear()
    const cold = client(shared)
    expect((await cold.run(review(plan, { mode: "reconcile" }))).status).toBe("reviewed")
    const originalRecovery = await cold.run(reconcileSharedBodyWrite(library, plan))
    expect(originalRecovery.status).toBe("reviewed")
    expect(creates(cold)).toHaveLength(0)
    expect(patches(cold)).toHaveLength(0)
    expect(reads(cold)).toHaveLength(0)
  })

  test("new review does not invent historically absent native metadata", async () => {
    const { shared, plan } = await needsReview("main", {})
    const preview = await client(shared).run(review(plan, { dryRun: true }))
    if (preview.status !== "planned") throw new Error("Expected a dry review plan")
    expect(preview.plan.content).toEqual({
      object_id: `body-${hash(observed)}`,
      sha256: hash(observed),
      bytes: observed.length,
    })
    expect(preview.plan.version).toBe(2)
  })

  test("cold completed v1 review and original write reconcile without new facts or body reads", async () => {
    const { shared, plan } = await needsReview("main", { mode: "100644", frontmatter })
    const setup = client(shared)
    const preview = await setup.run(review(plan, { dryRun: true }))
    if (preview.status !== "planned") throw new Error("Expected a dry review plan")
    const legacy = await setup.run(legacyV1Plan(preview.plan))
    seedLegacyCompletion(shared, legacy)
    shared.local.clear()
    shared.markdown = "Independent later text.\n"
    const before = canonicalSharedJson([...shared.rows.entries()])
    for (const mode of ["create", "reconcile"] as const) {
      const api = client(shared)
      const recovered = await api.run(review(plan, { mode }))
      expect(recovered.status).toBe("reviewed")
      if (recovered.status !== "reviewed") throw new Error("Expected retained v1 completion")
      expect(recovered.operation_id).toBe(legacy.operation_id)
      expect(recovered.event).toEqual(legacy.event)
      const originalRecovery = await api.run(reconcileSharedBodyWrite(library, plan))
      expect(originalRecovery.status).toBe("reviewed")
      expect(originalRecovery.operation_id).toBe(legacy.operation_id)
      expect(creates(api)).toHaveLength(0)
      expect(patches(api)).toHaveLength(0)
      expect(reads(api)).toHaveLength(0)
      expect(canonicalSharedJson(payloadFor(shared, legacy.operation_id))).toBe(
        canonicalSharedJson(legacy),
      )
      expect(canonicalSharedJson([...shared.rows.entries()])).toBe(before)
    }
  })

  test.each([false, true])(
    "v1 original dispatch barrier stays readonly (shared plan visible: %s)",
    async (visible) => {
      const { shared, plan } = await needsReview("main", { mode: "100644", frontmatter })
      const setup = client(shared)
      const preview = await setup.run(review(plan, { dryRun: true }))
      if (preview.status !== "planned") throw new Error("Expected a dry review plan")
      const legacy = await setup.run(legacyV1Plan(preview.plan))
      await setup.run(
        Effect.gen(function* () {
          yield* retainPendingFileOperation(
            {
              prefix: yield* sharedPendingObservationPrefix(
                scope,
                library.library_id,
                legacy.skill_id,
              ),
              scope,
              library_id: library.library_id,
              skill_id: legacy.skill_id,
              skill_page_id: skillPage,
            },
            legacy,
          )
        }),
      )
      if (visible)
        seed(shared, "operation", legacy.operation_id, legacy.operation_id, legacy.file_id, legacy)
      const before = canonicalSharedJson([...shared.rows.entries()])
      const local = canonicalSharedJson([...shared.local.entries()])
      for (const mode of ["create", "reconcile"] as const) {
        const api = client(shared)
        const result = await api.run(review(plan, { mode }).pipe(Effect.result))
        expect(failure(result).code).toBe("SHARED_RECORD_UNRESOLVED")
        expect(creates(api)).toHaveLength(0)
        expect(patches(api)).toHaveLength(0)
        expect(reads(api)).toHaveLength(0)
        expect(canonicalSharedJson([...shared.rows.entries()])).toBe(before)
        expect(canonicalSharedJson([...shared.local.entries()])).toBe(local)
      }
    },
  )

  test("a v1 receipt without its original plan cannot select or dispatch a replacement", async () => {
    const { shared, plan } = await needsReview("main", { mode: "100644", frontmatter })
    const setup = client(shared)
    const preview = await setup.run(review(plan, { dryRun: true }))
    if (preview.status !== "planned") throw new Error("Expected a dry review plan")
    const legacy = await setup.run(legacyV1Plan(preview.plan))
    seedLegacyCompletion(shared, legacy)
    const originalReview = [...shared.rows.values()].find(
      (row) => rowRecordId(row) === legacy.operation_id,
    )
    if (originalReview === undefined) throw new Error("Expected retained v1 review")
    shared.hidden.add(String(originalReview.id))
    shared.local.clear()
    const before = canonicalSharedJson([...shared.rows.entries()])
    const api = client(shared)
    for (const mode of ["create", "reconcile"] as const)
      expect(failure(await api.run(review(plan, { mode }).pipe(Effect.result))).code).toBe(
        "SHARED_RECORD_UNRESOLVED",
      )
    expect(
      failure(await api.run(reconcileSharedBodyWrite(library, plan).pipe(Effect.result))).code,
    ).toBe("SHARED_RECORD_UNRESOLVED")
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
    expect(reads(api)).toHaveLength(0)
    expect(canonicalSharedJson([...shared.rows.entries()])).toBe(before)
    expect(shared.local.size).toBe(0)
  })

  test("local v1 and shared v2 intents at one original identity are a readonly conflict", async () => {
    const { shared, plan } = await needsReview("main", { mode: "100644", frontmatter })
    const setup = client(shared)
    const preview = await setup.run(review(plan, { dryRun: true }))
    if (preview.status !== "planned") throw new Error("Expected a dry review plan")
    const legacy = await setup.run(legacyV1Plan(preview.plan))
    expect(legacy.operation_id).toBe(preview.plan.operation_id)
    expect(legacy.version).toBe(1)
    expect(preview.plan.version).toBe(2)
    await setup.run(
      Effect.gen(function* () {
        yield* retainPendingFileOperation(
          {
            prefix: yield* sharedPendingObservationPrefix(
              scope,
              library.library_id,
              legacy.skill_id,
            ),
            scope,
            library_id: library.library_id,
            skill_id: legacy.skill_id,
            skill_page_id: skillPage,
          },
          legacy,
        )
      }),
    )
    seed(
      shared,
      "operation",
      preview.plan.operation_id,
      preview.plan.operation_id,
      plan.file_id,
      preview.plan,
    )
    const before = canonicalSharedJson([...shared.rows.entries()])
    const local = canonicalSharedJson([...shared.local.entries()])
    const api = client(shared)
    expect(failure(await api.run(review(plan).pipe(Effect.result))).code).toBe("STATE_CORRUPT")
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
    expect(reads(api)).toHaveLength(0)
    expect(canonicalSharedJson([...shared.rows.entries()])).toBe(before)
    expect(canonicalSharedJson([...shared.local.entries()])).toBe(local)
  })

  test("a v1 dispatch retained under another credential scope cannot become a new v2 review", async () => {
    const { shared, plan } = await needsReview("main", { mode: "100644", frontmatter })
    const setup = client(shared)
    const preview = await setup.run(review(plan, { dryRun: true }))
    if (preview.status !== "planned") throw new Error("Expected a dry review plan")
    const legacy = await setup.run(legacyV1Plan(preview.plan))
    await setup.run(
      Effect.gen(function* () {
        yield* retainPendingFileOperation(
          {
            prefix: yield* sharedPendingObservationPrefix(
              scope,
              library.library_id,
              legacy.skill_id,
            ),
            scope,
            library_id: library.library_id,
            skill_id: legacy.skill_id,
            skill_page_id: skillPage,
          },
          legacy,
        )
      }),
    )
    const originalRequest = seed(
      shared,
      "operation",
      legacy.operation_id,
      legacy.operation_id,
      legacy.file_id,
      legacy,
    )
    shared.hidden.add(String(originalRequest.id))
    const before = canonicalSharedJson([...shared.rows.entries()])
    const local = canonicalSharedJson([...shared.local.entries()])
    const api = client(shared)
    const result = await api.run(
      reviewSharedBodyWrite({
        library,
        skillPageId: skillPage,
        originalOperationId: plan.operation_id,
        acceptedObservedSha256: hash(observed),
        scope: hash("a different credential scope in the same Store"),
        mode: "create",
        dryRun: false,
      }).pipe(Effect.result),
    )
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
    expect(failure(result).code).toBe("SHARED_RECORD_UNRESOLVED")
    expect(canonicalSharedJson([...shared.rows.entries()])).toBe(before)
    expect(canonicalSharedJson([...shared.local.entries()])).toBe(local)
  })

  test.each(["mode", "frontmatter"] as const)(
    "coherently rehashed %s cannot replace the original candidate metadata",
    async (field) => {
      const { shared, plan } = await needsReview("main", { mode: "100644", frontmatter })
      const api = client(shared)
      const preview = await api.run(review(plan, { dryRun: true }))
      if (preview.status !== "planned") throw new Error("Expected a dry review plan")
      const content = {
        ...preview.plan.content,
        ...(field === "mode"
          ? { mode: "100755" as const }
          : { frontmatter: frontmatter.replace("LICENSE.txt", "OTHER.txt") }),
      }
      const description = {
        version: 2,
        kind: "body_write_review",
        original_operation_id: plan.operation_id,
        observation_sha256: preview.plan.observation_sha256,
        accepted_observed_sha256: hash(observed),
        file_id: plan.file_id,
        parents: plan.event.parents,
        content,
      }
      const forged = await api.run(
        validateSharedBodyWriteReviewPlan({
          ...preview.plan,
          content,
          event: {
            ...preview.plan.event,
            content,
            event_id: `review-adopt-${hash(canonicalSharedJson(description))}`,
          },
        }),
      )
      const result = await api.run(
        reconcileSharedBodyWriteReview(library, forged).pipe(Effect.result),
      )
      expect(failure(result).code).toBe("SHARED_BODY_REVIEW_INVALID")
      expect(creates(api)).toHaveLength(0)
      expect(patches(api)).toHaveLength(0)
    },
  )
})
