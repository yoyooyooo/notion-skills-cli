import { describe, expect, test } from "bun:test"
import {
  FileObservationError,
  planFileValidation,
  refreshMetadataObservation,
  type FileMetadataInput,
  type LocalFileObservation,
} from "../src/shared-file-observation.ts"

const start = Date.parse("2026-10-31T00:00:00.000Z")
const hash = "a".repeat(64)
const availableObjectHashes = new Set([hash])
const metadataTtlMs = 100
const fullBodyMaxAgeMs = 1000

function file(index = 0): FileMetadataInput {
  return {
    file_id: `file-${index}`,
    page_id: `page-${index}`,
    path: index === 0 ? "SKILL.md" : `references/${index}.md`,
    last_edited_time: new Date(start).toISOString(),
    management_revision: "revision-1",
  }
}

function observation(current: FileMetadataInput = file()): LocalFileObservation {
  return {
    ...current,
    body_sha256: hash,
    body_verified_at: start,
    metadata_validated_at: start,
  }
}

const defaults = { metadataTtlMs, fullBodyMaxAgeMs, availableObjectHashes }

describe("file validation planning", () => {
  test("same timestamp still reaches the full-body deadline despite repeated metadata renewals", () => {
    const current = file()
    let observed = observation(current)
    // A user may edit body bytes while the metadata timestamp stays identical.
    for (const offset of [100, 200, 400, 800, 999]) {
      observed = refreshMetadataObservation({
        file: current,
        observation: observed,
        now: start + offset,
      })
      expect(observed.body_verified_at).toBe(start)
    }
    const plan = planFileValidation({
      ...defaults,
      files: [current],
      observations: [observed],
      now: start + 1000,
    })
    expect(plan.files[0]).toMatchObject({ action: "body_read", reason: "full_body_due" })
    expect(observed.metadata_validated_at).toBe(start + 999)
  })

  test("accessing a TTL hit does not renew either validation clock", () => {
    const current = file()
    const observed = observation(current)
    const original = { ...observed }
    for (const offset of [1, 20, 99]) {
      const plan = planFileValidation({
        ...defaults,
        files: [current],
        observations: [observed],
        now: start + offset,
      })
      expect(plan.files[0]?.action).toBe("use_cached")
    }
    expect(observed).toEqual(original)
    const expired = planFileValidation({
      ...defaults,
      files: [current],
      observations: [observed],
      now: start + 100,
    })
    expect(expired.files[0]?.action).toBe("metadata_check")
  })

  for (const count of [1, 10, 100, 101, 300]) {
    test(`N=${count} plans metadata work together and reads only changed members`, () => {
      const files = Array.from({ length: count }, (_, index) => file(index))
      const observations = files.map(observation)
      const unchanged = planFileValidation({ ...defaults, files, observations, now: start + 100 })
      expect(unchanged.files.filter((entry) => entry.action === "metadata_check")).toHaveLength(
        count,
      )
      expect(unchanged.files.filter((entry) => entry.action === "body_read")).toHaveLength(0)
      // Each returned metadata_check is batch input; the pure planner has no request capability.
      for (const changedCount of new Set([1, Math.min(3, count)])) {
        const changed = files.map((entry, index) =>
          index < changedCount
            ? { ...entry, last_edited_time: new Date(start + 10).toISOString() }
            : entry,
        )
        const plan = planFileValidation({
          ...defaults,
          files: changed,
          observations,
          now: start + 99,
        })
        expect(plan.files.filter((entry) => entry.action === "body_read")).toHaveLength(
          changedCount,
        )
        expect(plan.files.filter((entry) => entry.action === "use_cached")).toHaveLength(
          count - changedCount,
        )
      }
    })
  }

  test("identity, binding, path and management changes cannot be metadata-only renewals", () => {
    const base = file()
    const observed = observation(base)
    for (const change of [
      { file_id: "other-file" },
      { page_id: "other-page" },
      { path: "references/moved.md" },
      { management_revision: "revision-2" },
      { last_edited_time: new Date(start + 1).toISOString() },
    ]) {
      const current = { ...base, ...change }
      const plan = planFileValidation({
        ...defaults,
        files: [current],
        observations: [observed],
        now: start + 2,
      })
      expect(plan.files[0]?.action).toBe("body_read")
      expect(() =>
        refreshMetadataObservation({ file: current, observation: observed, now: start + 2 }),
      ).toThrow(FileObservationError)
    }
  })

  test("missing cached bytes require exact-hash recovery, with expired metadata still exposed", () => {
    const current = file()
    const observed = observation(current)
    const fresh = planFileValidation({
      ...defaults,
      availableObjectHashes: new Set(),
      files: [current],
      observations: [observed],
      now: start + 1,
    })
    expect(fresh.files[0]).toMatchObject({
      action: "recover_fixed",
      body_sha256: hash,
      metadata_check_required: false,
    })
    const expired = planFileValidation({
      ...defaults,
      availableObjectHashes: new Set(),
      files: [current],
      observations: [observed],
      now: start + 100,
    })
    expect(expired.files[0]).toMatchObject({
      action: "recover_fixed",
      body_sha256: hash,
      metadata_check_required: true,
    })
    // A current-body refresh is distinct from recovering this hash for a historical pin.
    const overdue = planFileValidation({
      ...defaults,
      availableObjectHashes: new Set(),
      files: [current],
      observations: [observed],
      now: start + 1000,
    })
    expect(overdue.files[0]).toMatchObject({ action: "body_read", reason: "full_body_due" })
    expect(observed.body_verified_at).toBe(start)
  })

  test("missing query rows are candidates, never tombstones or permission conclusions", () => {
    const observed = observation()
    const partial = planFileValidation({
      ...defaults,
      files: [],
      observations: [observed],
      now: start + 1,
    })
    expect(partial.removed_candidates).toHaveLength(0)
    expect(partial.unobserved_candidates).toEqual([
      {
        file_id: observed.file_id,
        page_id: observed.page_id,
        path: observed.path,
        deletion_authorized: false,
      },
    ])
    const complete = planFileValidation({
      ...defaults,
      files: [],
      observations: [observed],
      now: start + 1,
      membershipComplete: true,
    })
    expect(complete.removed_candidates).toHaveLength(1)
    expect(complete.removed_candidates[0]?.deletion_authorized).toBe(false)
    expect(complete.unobserved_candidates).toHaveLength(0)
  })

  test("rejects future/invalid observation clocks and ambiguous identity", () => {
    const current = file()
    for (const change of [
      { body_verified_at: start + 2 },
      { metadata_validated_at: start + 2 },
      { body_verified_at: Number.NaN },
      { metadata_validated_at: -1 },
      { last_edited_time: "invalid-time" },
      { last_edited_time: new Date(start + 2).toISOString() },
    ]) {
      const observed = { ...observation(current), ...change }
      expect(() =>
        planFileValidation({
          ...defaults,
          files: [current],
          observations: [observed],
          now: start + 1,
        }),
      ).toThrow(FileObservationError)
    }
    expect(() =>
      planFileValidation({
        ...defaults,
        files: [current, current],
        observations: [],
        now: start + 1,
      }),
    ).toThrow(FileObservationError)
    expect(() =>
      planFileValidation({
        ...defaults,
        files: [current],
        observations: [observation(current), observation(current)],
        now: start + 1,
      }),
    ).toThrow(FileObservationError)
  })

  test("force-full bypasses cache without pretending the body has already been validated", () => {
    const current = file()
    const observed = observation(current)
    const plan = planFileValidation({
      ...defaults,
      files: [current],
      observations: [observed],
      now: start + 1,
      forceFull: true,
    })
    expect(plan.files[0]).toMatchObject({ action: "body_read", reason: "forced" })
    expect(observed).toEqual(observation(current))
  })
})
