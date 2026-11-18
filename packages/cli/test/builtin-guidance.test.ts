import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { posix } from "node:path"
import { builtins } from "../src/builtins.ts"

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const findBuiltin = (id: string) => {
  const value = builtins.find((skill) => skill.id === id)
  if (!value) throw new Error(`Missing builtin: ${id}`)
  return value
}
const fileText = (id: string, path: string) => {
  const file = findBuiltin(id).portable.files.find((candidate) => candidate.path === path)
  if (!file) throw new Error(`Missing builtin file: ${id}/${path}`)
  return text(file.bytes)
}

test("bundled current instructions include every relative reference without checkout-only links", () => {
  expect(builtins.map((skill) => skill.id)).toEqual([
    "notion/ntn-skills",
    "notion/ntn-skills-maintain",
    "notion/ntn-skills-sync",
  ])
  for (const skill of builtins) {
    for (const file of skill.portable.files) {
      const body = text(file.bytes)
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

test("executable builtin examples stay within the public current command surface", () => {
  const roots = new Set(["list", "read", "use", "files", "export", "schema", "ctl"])
  const controls = new Set([
    "library",
    "config",
    "cache",
    "builtin",
    "doctor",
    "api",
    "views",
    "prepare",
    "resolve",
  ])
  const library = new Set(["init", "inspect", "files", "profile"])
  let examples = 0
  for (const skill of builtins) {
    for (const file of skill.portable.files) {
      const body = text(file.bytes)
      for (const [, block] of body.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)) {
        for (const line of block!.split("\n")) {
          const match = /^ntn-skills\s+(.+)$/u.exec(line.trim())
          if (!match) continue
          examples += 1
          const words = match[1]!.split(/\s+/u)
          const label = `${skill.id}/${file.path}: ${line}`
          expect(roots.has(words[0]!), label).toBe(true)
          if (words[0] === "ctl") {
            expect(controls.has(words[1]!), label).toBe(true)
            if (words[1] === "library") expect(library.has(words[2]!), label).toBe(true)
          }
          expect(words, label).not.toContain("--authoring")
          expect(words, label).not.toContain("--read-only")
        }
      }
    }
  }
  expect(examples).toBeGreaterThan(10)
})

test("maintenance prepares complete current input without claiming an available content writer", () => {
  const root = fileText("notion/ntn-skills-maintain", "SKILL.md")
  const setup = fileText("notion/ntn-skills-maintain", "references/setup.md")
  const operations = fileText("notion/ntn-skills-maintain", "references/operations.md")
  expect(new TextEncoder().encode(root).byteLength).toBeLessThanOrEqual(5300)
  expect(root).toContain("ctl library files PAGE_ID --entry ENTRY")
  expect(root).toContain("read PAGE_ID --database ENTRY --refresh --json")
  expect(root).toContain("CURRENT_SCHEMA_REQUIRED")
  expect(root).toContain("CURRENT_OPERATION_PENDING")
  expect(root).toContain("current writer is unavailable")
  expect(root).toContain("not a completed")
  expect(setup).toContain("ctl library init --parent AUTHORIZED_PARENT_PAGE")
  expect(setup).toContain("current public writer is not available")
  expect(setup).toContain("/context-broker connect SOURCE ENTRY")
  expect(operations).toContain("metadata-only")
  expect(operations).toContain("Target inspection does not prove whole-library coverage")
  expect(operations).toContain("unknown CREATE")
})

test("consumption and Profile guidance preserve zero-write reads and complete current replacement", () => {
  const consumer = fileText("notion/ntn-skills", "SKILL.md")
  const profile = fileText("notion/ntn-skills-sync", "SKILL.md")
  const details = fileText("notion/ntn-skills-sync", "references/synchronization.md")
  expect(consumer).toContain("zero semantic Notion writes")
  expect(consumer).toContain("generated Source/resource")
  expect(consumer).toContain("selecting current content again")
  expect(consumer).toContain("not a current CLI option")
  expect(profile).toContain("ctl library profile set")
  expect(profile).toContain("--expect new")
  expect(profile).toContain("complete desired rule")
  expect(profile).toContain("--reconcile")
  expect(profile).toContain("without another POST or PATCH")
  expect(profile).toContain("do not grant access")
  expect(details).toContain("A Skill can combine multiple")
  expect(details).toMatch(/every supporting file/iu)
})

test("the published documentation allowlist contains only current guides", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { files: string[] }
  expect(manifest.files.filter((path) => path.startsWith("docs/"))).toEqual([
    "docs/README.md",
    "docs/current-contract.md",
    "docs/maintenance-verification-review.md",
  ])
})
