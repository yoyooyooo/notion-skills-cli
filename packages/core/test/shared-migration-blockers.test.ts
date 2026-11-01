import { expect, test } from "bun:test"
import {
  summarizeMigrationBlockers,
  type MigrationBlocker,
} from "../src/shared-migration-blockers.ts"

const blocker = (code: MigrationBlocker["code"], subject: string): MigrationBlocker => ({
  code,
  subject,
  message: `Original ${code} evidence`,
})

test("migration work counts preserve every blocker while distinguishing affected subjects", () => {
  const input = [
    blocker("BODY_UNVERIFIED", "skill-a:file-a"),
    blocker("BODY_UNVERIFIED", "skill-a:file-a"),
    blocker("METADATA_INCOMPLETE", "skill-a"),
  ]
  const before = structuredClone(input)
  const summary = summarizeMigrationBlockers(input)
  expect(summary.total).toBe(3)
  expect(summary.affected_subjects).toBe(2)
  expect(summary.by_code).toEqual([
    { code: "BODY_UNVERIFIED", count: 2, affected_subjects: 1, work: "observe" },
    { code: "METADATA_INCOMPLETE", count: 1, affected_subjects: 1, work: "observe" },
  ])
  expect(summary.by_work).toHaveLength(1)
  expect(summary.by_work[0]?.count).toBe(3)
  expect(summary.by_work[0]?.affected_subjects).toBe(2)
  expect(input).toEqual(before)
})

test("missing evidence is separated from scope, user candidates, original unknown operations and unsupported semantics", () => {
  const input = [
    blocker("BODY_UNVERIFIED", "skill-a:file-a"),
    blocker("SCOPE_NOT_FROZEN", "skill-a"),
    blocker("USER_EDIT_CANDIDATE", "skill-a:file-a"),
    blocker("UNSETTLED_OPERATION", "operations:original-a"),
    blocker("LEGACY_SOURCE_OPTIONS_UNSUPPORTED", "sources:source-a"),
    blocker("DUPLICATE_LEGACY_ID", "skill-a"),
  ]
  const summary = summarizeMigrationBlockers(input)
  expect(summary.by_work.map(({ work }) => work)).toEqual([
    "correct_inventory",
    "interpret",
    "observe",
    "reconcile",
    "review",
    "scope",
  ])
  expect(summary.by_work.reduce((sum, group) => sum + group.count, 0)).toBe(input.length)
  expect(summary.by_work.find(({ work }) => work === "reconcile")?.next_step).toContain(
    "do not replay",
  )
  expect(summary.by_work.find(({ work }) => work === "scope")?.next_step).toContain(
    "do not approve migration",
  )
  expect(summary.by_work.find(({ work }) => work === "review")?.next_step).toContain(
    "without inferring intent",
  )
})

test("equivalent blocker ordering produces the same compact deterministic summary", () => {
  const input = [
    blocker("REFERENCE_UNRESOLVED", "pins:old-pin"),
    blocker("BODY_UNVERIFIED", "skill-b:file-b"),
    blocker("BODY_UNVERIFIED", "skill-a:file-a"),
    blocker("USER_EDIT_CANDIDATE", "skill-a:file-a"),
  ]
  expect(summarizeMigrationBlockers([...input].reverse())).toEqual(
    summarizeMigrationBlockers(input),
  )
})

test("a data-ready plan has an empty work index and no inferred execution authorization", () => {
  expect(summarizeMigrationBlockers([])).toEqual({
    total: 0,
    affected_subjects: 0,
    by_code: [],
    by_work: [],
  })
})
