import { describe, expect, test } from "bun:test"
import { normalizeSharedFreshness, resolveSharedFreshness } from "../src/shared-freshness-policy.ts"

describe("shared per-Skill freshness", () => {
  const policy = {
    default: { read_max_age_ms: 60_000, source_check_max_age_ms: 86_400_000 },
    skills: [
      { skill_id: "stable-alpha", read_max_age_ms: 3_600_000 },
      { skill_id: "stable-beta", read_max_age_ms: 0 },
    ],
  }
  test("resolves explicit then stable Skill then Profile then product independently of source checking", () => {
    const resolve = (skillId?: string, explicitMaxAge?: number) =>
      resolveSharedFreshness({ policy, skillId, explicitMaxAge, productReadMaxAge: 300_000 })
    expect(resolve("stable-alpha")).toMatchObject({
      read_max_age_ms: 3_600_000,
      read_policy_source: "skill",
      source_check_max_age_ms: 86_400_000,
      source_policy_source: "profile",
    })
    expect(resolve("stable-beta").read_max_age_ms).toBe(0)
    expect(resolve("unconfigured")).toMatchObject({
      read_max_age_ms: 60_000,
      read_policy_source: "profile",
    })
    expect(resolve("stable-alpha", 7)).toMatchObject({
      read_max_age_ms: 7,
      read_policy_source: "explicit",
    })
    expect(resolveSharedFreshness({ productReadMaxAge: 300_000 })).toMatchObject({
      read_max_age_ms: 300_000,
      read_policy_source: "product",
      source_check_max_age_ms: null,
    })
  })
  test("long metadata TTL never changes immutable retention or independent full-body deadline", () => {
    const effective = resolveSharedFreshness({
      policy: { skills: [{ skill_id: "alpha", read_max_age_ms: 7 * 86_400_000 }] },
      skillId: "alpha",
      productReadMaxAge: 300_000,
    })
    expect(effective.notion_visibility_delay_ms).toBe(7 * 86_400_000)
    expect(effective.full_body_max_age_ms).toBe(86_400_000)
    expect(effective.immutable_bytes).toBe("retained")
  })
  test("clearing one override restores inheritance and canonical ordering ignores display names", () => {
    const sorted = normalizeSharedFreshness({ ...policy, skills: [...policy.skills].reverse() })
    expect(sorted).toEqual(policy)
    const cleared = {
      ...policy,
      skills: policy.skills.filter((row) => row.skill_id !== "stable-alpha"),
    }
    expect(
      resolveSharedFreshness({
        policy: cleared,
        skillId: "stable-alpha",
        productReadMaxAge: 300_000,
      }).read_max_age_ms,
    ).toBe(60_000)
  })
  test.each([
    { skills: [{ skill_id: "a", read_max_age_ms: -1 }] },
    { skills: [{ skill_id: "a", read_max_age_ms: Infinity }] },
    { skills: [{ skill_id: "a", read_max_age_ms: 1.5 }] },
    { skills: [{ skill_id: "a", read_max_age_ms: Number.MAX_SAFE_INTEGER + 1 }] },
    { skills: [{ skill_id: "" }] },
    { skills: [{ skill_id: "a" }, { skill_id: "a" }] },
    { skills: [], unexpected: true },
  ])("rejects ambiguous or invalid shared input before any dispatch: %j", (input) => {
    expect(() => normalizeSharedFreshness(input)).toThrow()
  })
})
