import { expect, test } from "bun:test"
import { posix } from "node:path"
import { builtins } from "../src/builtins.ts"

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test("bundled Agent instructions expose one current library workflow", () => {
  expect(builtins.map((skill) => skill.id)).toEqual([
    "notion/ntn-skills",
    "notion/ntn-skills-maintain",
    "notion/ntn-skills-sync",
  ])
  const operationalHistory =
    /\blegacy\b|\bmigrat(?:e|ed|ing|ion)\b|compatibility default|ctl sync (?:local|upstream)|ctl library migration|ctl operation resume|已迁移|未迁移|过渡期/iu
  for (const skill of builtins) {
    expect(skill.portable.description).not.toMatch(operationalHistory)
    for (const file of skill.portable.files) {
      const body = text(file.bytes)
      expect(body, `${skill.id}/${file.path}`).not.toMatch(operationalHistory)
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

test("current authoring and source guidance retain scope, identity and recovery boundaries", () => {
  const maintain = builtins.find((skill) => skill.id === "notion/ntn-skills-maintain")!
  const author = maintain.portable.files.map((file) => text(file.bytes)).join("\n")
  for (const term of [
    "adopt",
    "--authoring",
    "file add",
    "file move",
    "file delete",
    "restore-follow",
    "adoption_operation_id",
    "read_again",
    "not_applied",
    "partial",
    "--allow-local-archive",
  ])
    expect(author).toContain(term)
  expect(author).toContain("not atomic")
  expect(author).toContain("unknown")
  const sources = builtins.find((skill) => skill.id === "notion/ntn-skills-sync")!
  const supply = sources.portable.files.map((file) => text(file.bytes)).join("\n")
  for (const term of [
    "ctl library sources",
    "ctl library source select",
    "ctl library profile",
    "--expect",
    "--base",
    "reconcile",
    "custom",
    "--allow-local-archive",
  ])
    expect(supply).toContain(term)
  expect(supply).toContain("do not grant access")
})
