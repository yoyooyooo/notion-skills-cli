import { expect, test } from "bun:test"
import { posix } from "node:path"
import { builtins } from "../src/builtins.ts"

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test("bundled instructions describe the current library and include every relative reference", () => {
  expect(builtins.map((skill) => skill.id)).toEqual([
    "notion/ntn-skills",
    "notion/ntn-skills-maintain",
    "notion/ntn-skills-sync",
  ])
  // Do not forbid the current shared apply's guarded operation resume route.
  // Retired source workflows and migration narration are not daily instructions.
  const historicalRouting =
    /\blegacy\b|\bmigrat(?:e|ed|ing|ion)\b|compatibility default|ctl sync (?:local|upstream)|ctl library migration|已迁移|未迁移|过渡期/iu
  for (const skill of builtins) {
    expect(skill.portable.description).not.toMatch(historicalRouting)
    for (const file of skill.portable.files) {
      const body = text(file.bytes)
      expect(body, `${skill.id}/${file.path}`).not.toMatch(historicalRouting)
      const prose = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")
      for (const [, link] of prose.matchAll(/\]\(([^)]+)\)/g)) {
        if (/^[a-z][a-z\d+.-]*:|^#/i.test(link!)) continue
        const target = posix.normalize(posix.join(posix.dirname(file.path), link!.split("#")[0]!))
        expect(
          skill.portable.files.some((candidate) => candidate.path === target),
          `${skill.id}/${file.path}: ${link}`,
        ).toBe(true)
      }
    }
  }
})

test("current onboarding and maintenance preserve complete inputs and original recovery boundaries", () => {
  const maintain = builtins.find((skill) => skill.id === "notion/ntn-skills-maintain")!
  expect(maintain.portable.files.some((file) => file.path === "references/setup.md")).toBe(true)
  const author = maintain.portable.files.map((file) => text(file.bytes)).join("\n")
  for (const term of [
    "adopt",
    "--authoring",
    "file add",
    "file move",
    "file delete",
    "restore-follow",
    "read_again",
    "not_applied",
    "partial",
    "--allow-local-archive",
    "ctl operation resume",
    "unknown",
    "original",
    "bytes",
    "modes",
  ])
    expect(author).toContain(term)
  expect(author).toContain("not atomic")
  expect(author).toContain("proved-unsent")
  const sync = builtins.find((skill) => skill.id === "notion/ntn-skills-sync")!
  const supply = sync.portable.files.map((file) => text(file.bytes)).join("\n")
  for (const term of [
    "ctl library sources",
    "ctl library source select",
    "ctl library profile",
    "--expect",
    "--base",
    "reconcile",
    "custom",
    "do not grant access",
  ])
    expect(supply).toContain(term)
})
