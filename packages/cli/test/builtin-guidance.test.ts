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
  const setup = text(
    maintain.portable.files.find((file) => file.path === "references/setup.md")!.bytes,
  )
  const firstRoute = setup.slice(0, setup.indexOf("## Inputs"))
  for (const term of [
    "ctl library inspect ENTRY",
    "/context-broker connect SOURCE ENTRY",
    "configuration-change authorization",
    "apply RETURNED_PIN",
    "--dry-run",
    "omitted files remain unchanged",
  ])
    expect(firstRoute).toContain(term)
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

test("the maintenance root is a bounded complete ordinary edit route, with exceptional protocols deferred", () => {
  const maintain = builtins.find((skill) => skill.id === "notion/ntn-skills-maintain")!
  const root = maintain.portable.files.find((file) => file.path === "SKILL.md")!
  const body = text(root.bytes)
  expect(root.bytes.byteLength).toBeLessThanOrEqual(5300)
  const ordinary = body.slice(0, body.indexOf("## Finish"))
  for (const term of [
    "read PAGE --database ENTRY --authoring --read-only",
    "apply RETURNED_PIN --database ENTRY --input INPUT --dry-run --compact",
    "apply RETURNED_PIN --database ENTRY --input INPUT --compact",
    "The CLI reads and validates the complete input directory itself",
    "Do not search the catalog for the page UUID",
    "already authorized",
    "Omitted files/properties stay unchanged",
  ])
    expect(ordinary).toContain(term)
  expect(ordinary).not.toContain("prepare-import")
  const commands = /```bash\n([\s\S]*?)```/u.exec(ordinary)![1]!.trim().split("\n")
  expect(commands).toHaveLength(2)
  expect(commands[0]).toContain("read PAGE")
  expect(commands[1]).toContain("apply RETURNED_PIN")
  expect(commands[1]).not.toContain("--dry-run")
  expect(ordinary).toContain("A preview is not authorization")
  expect(ordinary).toContain("a separate dry-run need not repeat that validation")
  expect(body).toContain("A successful apply still needs your final answer")
  for (const guard of [
    "not atomic",
    "unknown",
    "not_applied",
    "partial",
    "original operation",
    "restore-follow",
    "entire document only",
    "no Git fallback",
  ])
    expect(body).toContain(guard)
  const detailed = text(
    maintain.portable.files.find((file) => file.path === "references/operations.md")!.bytes,
  )
  for (const heading of [
    "Reviewed inventory and repair",
    "Audit and import a complete local Skill",
    "Repair an existing identity",
    "Original-operation recovery",
  ])
    expect(detailed).toContain(heading)
})
