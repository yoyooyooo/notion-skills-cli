import { expect, test } from "bun:test"
import { commandSchema, selectCommand } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import {
  sourceFileResubmissionNext,
  sourceFileResubmissionFailure,
  sourceFileResubmissionOriginalNext,
  sourceFileResubmissionResultNext,
} from "../src/commands-library-source-file-resubmission.ts"
import { sourceRecoveryCommand } from "../src/commands-library-source-recovery.ts"

const route = {
  plan: "/owned/original; $(not-a-command) 计划.json",
  entry: "original-library",
  operationId: "skill-create-" + "a".repeat(64),
  review: "/owned/new review.json",
  reviewId: "source-file-resubmission-" + "b".repeat(64),
}

test("new file submission keeps exact argv and separate preview, authorization and observation", () => {
  const preview = sourceFileResubmissionNext({ ...route, action: "preview" })
  expect(preview.read_only).toBe(true)
  expect(preview.argv).toEqual([
    "ntn-skills",
    "ctl",
    "library",
    "sources",
    "recovery",
    "resubmit-file",
    "apply",
    route.plan,
    "--operation",
    route.operationId,
    "--entry",
    route.entry,
    "--review",
    route.review,
    "--review-id",
    route.reviewId,
    "--dry-run",
  ])
  const apply = sourceFileResubmissionNext({ ...route, action: "apply" })
  expect(apply.read_only).toBe(false)
  expect(apply.argv).toEqual(preview.argv.slice(0, -1))
  const reconcile = sourceFileResubmissionNext({ ...route, action: "reconcile" })
  expect(reconcile.read_only).toBe(true)
  expect(reconcile.argv[6]).toBe("reconcile")
  expect(reconcile.argv).not.toContain("--dry-run")
  expect(
    sourceFileResubmissionNext({ ...route, operationId: undefined, action: "preview" }).argv,
  ).not.toContain("--operation")
  const original = sourceFileResubmissionOriginalNext({ ...route, target: "original-main-page" })
  expect(original.read_only).toBe(true)
  expect(original.argv).toEqual([
    "ntn-skills",
    "ctl",
    "library",
    "sources",
    "recovery",
    "reconcile",
    route.plan,
    "--operation",
    route.operationId,
    "--entry",
    route.entry,
    "--target",
    "original-main-page",
  ])
  expect(original.argv).not.toContain("--output")
})

test("an actual independent ACK routes through proof-completion preview without a new native POST", () => {
  const identity = {
    review_id: route.reviewId,
    operation_id: route.reviewId,
    original_operation_id: route.operationId,
    skill_page_id: "original-main-page",
    file_id: "original-file",
    path: "README.en.md",
    remote_writes: 0,
    original_failure_preserved: true,
    original_creation_completed: false,
  } as const
  const pending = sourceFileResubmissionResultNext({
    ...route,
    preview: false,
    result: {
      ...identity,
      status: "completion_pending",
      file_page_id: "new-file-page",
      verified: false,
    },
  })
  expect(pending.read_only).toBe(true)
  expect(pending.argv).toEqual(sourceFileResubmissionNext({ ...route, action: "preview" }).argv)
  expect(pending.reason).toContain("no native POST is repeated")
  const completion = sourceFileResubmissionResultNext({
    ...route,
    preview: true,
    result: {
      ...identity,
      status: "reviewed",
      verified: false,
      native_pages_created: 0,
      native_pages_to_create: 0,
      acknowledged_page_reused: true,
    },
  })
  expect(completion.read_only).toBe(false)
  expect(completion.argv).toEqual(sourceFileResubmissionNext({ ...route, action: "apply" }).argv)
  expect(completion.reason).toContain("not dispatched again")
  const completed = sourceFileResubmissionResultNext({
    ...route,
    preview: false,
    result: { ...identity, status: "completed", file_page_id: "new-file-page", verified: true },
  })
  expect(completed.read_only).toBe(true)
  expect(completed.argv).toEqual(sourceFileResubmissionNext({ ...route, action: "reconcile" }).argv)
})

test("refusals keep only bounded identities and exact read-only reconciliation", () => {
  for (const code of [
    "WRITE_OUTCOME_UNKNOWN",
    "SOURCE_WRITE_NOT_APPLIED",
    "SHARED_CREATE_BODY_MISMATCH",
  ]) {
    const error = sourceFileResubmissionFailure(
      fail(code, "Preserve the original operation.", {
        file_id: "file-original",
        path: "README.en.md",
        operation_id: "source-op-original",
        original_dispatch: { body: { markdown: "private-wire" } },
        original_plan: { files: ["private-source"] },
        original_rejection: { message: "provider-private-message" },
        review_id: "wrong-untrusted-review",
        nested: { secret: "not-a-context-field" },
      }),
      route,
    )
    expect(error.details).toEqual({
      operation_id: "source-op-original",
      original_operation_id: route.operationId,
      file_id: "file-original",
      path: "README.en.md",
      review_id: route.reviewId,
      next: sourceFileResubmissionNext({ ...route, action: "reconcile" }),
    })
    expect(JSON.stringify(error.details)).not.toMatch(/private-|not-a-context-field/u)
  }
  const oversized = sourceFileResubmissionFailure(
    fail("INVALID_ARGUMENT", "Invalid review", { path: "x".repeat(1000) }),
    route,
  )
  expect(oversized.details).not.toHaveProperty("path")
  const wrapped = sourceFileResubmissionFailure(
    fail("WRITE_OUTCOME_UNKNOWN", "private-wire".repeat(1000), {
      original_details: {
        file_id: "file-original",
        path: "README.en.md",
        original_dispatch: { body: "private-wire" },
      },
    }),
    route,
  )
  expect(wrapped.details).toMatchObject({ file_id: "file-original", path: "README.en.md" })
  expect(JSON.stringify(wrapped)).not.toContain("private-wire")
})

test("recovery command tree exposes the independent review and exact execution selectors", () => {
  for (const action of ["review", "apply", "reconcile"]) {
    const command = selectCommand(sourceRecoveryCommand, ["resubmit-file", action])
    if (!command) throw new Error("The resubmission command is not mounted")
    expect(commandSchema(command)).toMatchObject({
      name: action,
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: "plan", required: true }),
        expect.objectContaining({ name: "entry", required: true, max_occurrences: 1 }),
        expect.objectContaining({ name: "operation", required: false, max_occurrences: 1 }),
        ...(action === "review" ? ["target", "path", "output"] : ["review", "review-id"]).map(
          (name) => expect.objectContaining({ name, required: true, max_occurrences: 1 }),
        ),
      ]),
    })
    expect(command.description).toContain(
      action === "review"
        ? "native_image_blocks_v1"
        : action === "apply"
          ? "separate real ACK"
          : "never dispatches",
    )
  }
})
