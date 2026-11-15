import { expect, test } from "bun:test"
import { sourceOnboardingNext } from "../src/commands-library-source-onboarding.ts"
import { sourceRecoveryReconcileNext } from "../src/commands-library-source-recovery.ts"

const operation = `skill-create-${"a".repeat(64)}`
const base = {
  mode: "reconcile" as const,
  plan: "/owned/original plan.json",
  entry: "exact-library",
}
const missing = (stage: "manifest" | "outcome") => ({
  verified: false,
  operation_id: operation,
  error: {
    code: stage === "manifest" ? "SHARED_RECORD_UNRESOLVED" : "SHARED_CREATE_UNRESOLVED",
    message: "Original record absent",
    details: {
      stage,
      native_create_operation_id: operation,
      recovery: { original_plan: { operation_id: operation, retained_in_parent_plan: true } },
    },
  },
})

test("recovery refusal routes to exact read-only reconciliation without guessing another operation or shell command", () => {
  const target = "00000000-0000-4000-8000-000000000099"
  const path = "/owned/original; $(not-a-command) 计划.json"
  expect(
    sourceRecoveryReconcileNext({ plan: path, entry: base.entry, operationId: operation, target }),
  ).toEqual({
    argv: [
      "ntn-skills",
      "ctl",
      "library",
      "sources",
      "recovery",
      "reconcile",
      path,
      "--operation",
      operation,
      "--entry",
      base.entry,
      "--target",
      target,
    ],
    read_only: true,
    reason:
      "Inspect this exact original recovery. A refused or unknown suffix is not permission to repeat a native write.",
  })
  expect(
    sourceRecoveryReconcileNext({ plan: path, entry: base.entry, target })?.argv,
  ).not.toContain("--operation")
  expect(
    sourceRecoveryReconcileNext({ plan: path, entry: base.entry, target: "not-a-page" }),
  ).toBeUndefined()
})

test.each(["manifest", "outcome"] as const)(
  "missing original %s routes only to the exact read-only preview",
  (stage) => {
    const route = sourceOnboardingNext({
      ...base,
      results: [{ verified: true, operation_id: "completed" }, missing(stage)],
    })
    expect(route.argv).toEqual([
      "ntn-skills",
      "ctl",
      "library",
      "sources",
      "onboard-apply",
      base.plan,
      "--entry",
      base.entry,
      "--dry-run",
    ])
    expect(route.read_only).toBe(true)
    expect(route.reason).toContain("original journal and native acknowledgements")
  },
)

test("persisted rejections, unknown writes and unbound errors cannot propose continuation", () => {
  const item = missing("manifest")
  for (const invalid of [
    { ...item, error: { ...item.error, code: "SHARED_CREATE_REVIEW_REQUIRED" } },
    { ...item, error: { ...item.error, code: "WRITE_OUTCOME_UNKNOWN" } },
    {
      ...item,
      error: { ...item.error, details: { ...item.error.details, stage: "create_skill" } },
    },
    { ...item, error: { ...item.error, details: {} } },
    { ...item, operation_id: "another-original" },
    {
      ...item,
      error: {
        ...item.error,
        details: {
          ...item.error.details,
          recovery: { original_plan: { operation_id: operation, retained_in_parent_plan: false } },
        },
      },
    },
  ]) {
    const route = sourceOnboardingNext({ ...base, results: [item, invalid] })
    expect(route.argv[4]).toBe("onboard-reconcile")
    expect(route.read_only).toBe(true)
  }
  expect(sourceOnboardingNext({ ...base, results: [] }).argv[4]).toBe("onboard-reconcile")
})

test("an applied or previewed original keeps its separate explicit next step", () => {
  const results = [missing("manifest")]
  expect(sourceOnboardingNext({ ...base, mode: "apply", results })).toMatchObject({
    read_only: true,
    argv: [
      "ntn-skills",
      "ctl",
      "library",
      "sources",
      "onboard-reconcile",
      base.plan,
      "--entry",
      base.entry,
    ],
  })
  expect(sourceOnboardingNext({ ...base, mode: "dry-run", results })).toMatchObject({
    read_only: false,
    argv: [
      "ntn-skills",
      "ctl",
      "library",
      "sources",
      "onboard-apply",
      base.plan,
      "--entry",
      base.entry,
    ],
  })
})

test("an exact known retained failure routes only to an independent read-only review", () => {
  const page = "00000000-0000-4000-8000-000000000099"
  const error = {
    code: "SHARED_CREATE_REVIEW_REQUIRED",
    message: "Original immutable failure",
    details: {
      ...missing("outcome").error.details,
      skill_page_id: page,
      original_status: "needs_review",
      original_reason_code: "SHARED_CREATE_BODY_MISMATCH",
      source_projection_version: 2,
    },
  }
  const item = { verified: false, operation_id: operation, error }
  const result = sourceOnboardingNext({ ...base, results: [item] })
  expect(result.read_only).toBe(true)
  expect(result.argv).toEqual([
    "ntn-skills",
    "ctl",
    "library",
    "sources",
    "recovery",
    "review",
    base.plan,
    "--operation",
    operation,
    "--target",
    page,
    "--entry",
    base.entry,
    "--output",
    `${base.plan}.${operation}.review.json`,
  ])
  for (const details of [
    { ...error.details, original_status: "unknown" },
    { ...error.details, source_projection_version: 1 },
    { ...error.details, original_reason_code: "BODY_INCOMPLETE" },
    { ...error.details, skill_page_id: "not-a-page" },
  ])
    expect(
      sourceOnboardingNext({ ...base, results: [{ ...item, error: { ...error, details } }] })
        .argv[4],
    ).toBe("onboard-reconcile")
  expect(sourceOnboardingNext({ ...base, results: [item, item] }).argv[4]).toBe("onboard-reconcile")
})
