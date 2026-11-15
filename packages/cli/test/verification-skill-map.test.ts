import { expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const featureRoot = ".cursor/skills/verify-ntn-skills/features"
const domainSchema = Schema.Struct({
  id: Schema.String,
  skill: Schema.String,
  features: Schema.Array(Schema.String),
  regressions: Schema.Array(Schema.String),
  installed_recipe: Schema.String,
  excludes: Schema.Array(Schema.String),
})
const mapSchema = Schema.Struct({ version: Schema.Literal(1), domains: Schema.Array(domainSchema) })
const load = () =>
  Schema.decodeUnknownSync(mapSchema)(
    JSON.parse(readFileSync(resolve(root, "verification/skill-domains.json"), "utf8")),
    { onExcessProperty: "error" },
  )
const text = (path: string) => readFileSync(resolve(root, path), "utf8")
function existing(path: string): void {
  if (
    relative(root, resolve(root, path)).startsWith("..") ||
    !statSync(resolve(root, path)).isFile()
  )
    throw new Error(`VERIFICATION_PATH_INVALID: ${path}`)
}
function check(input: unknown): void {
  const map = Schema.decodeUnknownSync(mapSchema)(input, { onExcessProperty: "error" })
  const seen = new Set<string>()
  const domains = new Set<string>()
  for (const domain of map.domains) {
    if (domains.has(domain.id)) throw new Error("DUPLICATE_DOMAIN")
    domains.add(domain.id)
    existing(domain.skill)
    const instructions = text(domain.skill)
    if (!instructions.includes(`name: ${domain.id}\n`)) throw new Error("SKILL_NAME_MISMATCH")
    if (!instructions.includes("不负责") || domain.excludes.length < 2)
      throw new Error("DOMAIN_BOUNDARY_MISSING")
    for (const heading of ["Launch", "Doctor", "Drive", "Evidence", "Cleanup"])
      if (!instructions.includes(`## ${heading}`)) throw new Error("EXECUTION_SECTION_MISSING")
    if (/\/Users\/[^/\s]+|\/home\/(?:yoyo|jackie)/u.test(instructions))
      throw new Error("PERSONAL_PATH_IN_SKILL")
    if (domain.regressions.length === 0) throw new Error("DOMAIN_HAS_NO_EXECUTABLE_REGRESSION")
    existing(domain.installed_recipe)
    if (!instructions.includes(domain.installed_recipe.split("/").at(-1)!))
      throw new Error("INSTALLED_RECIPE_DISCONNECTED")
    for (const file of domain.regressions) {
      existing(file)
      if (!/\.test\.(?:ts|mjs)$/u.test(file) || !instructions.includes(file))
        throw new Error("REGRESSION_DISCONNECTED")
    }
    for (const feature of domain.features) {
      if (seen.has(feature)) throw new Error("FEATURE_HAS_TWO_OWNERS")
      seen.add(feature)
      existing(`${featureRoot}/${feature}`)
    }
    // Local links must work without the author's checkout path or conversation.
    for (const match of instructions.matchAll(/\]\(([^\s)]+)\)/gu)) {
      const target = match[1]!
      if (/^(?:https?:|#)/u.test(target)) continue
      existing(relative(root, resolve(root, dirname(domain.skill), target.split("#")[0]!)))
    }
  }
  const actual = readdirSync(resolve(root, featureRoot))
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
  if (JSON.stringify([...seen].sort()) !== JSON.stringify(actual))
    throw new Error("FEATURE_COVERAGE_INCOMPLETE")
  const router = text(".cursor/skills/verify-ntn-skills/SKILL.md")
  for (const domain of map.domains)
    if (!router.includes(`../${domain.id}/SKILL.md`) && domain.id !== "verify-ntn-skills")
      throw new Error("DOMAIN_NOT_DISCOVERABLE")
}

test("verification domains have one owner, executable regressions and real local entrypoints", () => {
  expect(() => check(load())).not.toThrow()
})

test("lost ownership, missing regression and duplicated responsibilities fail routing validation", () => {
  const original = load()
  const first = original.domains[0]!
  expect(() => check({ ...original, domains: [...original.domains, first] })).toThrow(
    "DUPLICATE_DOMAIN",
  )
  expect(() => check({ ...original, domains: original.domains.slice(1) })).toThrow(
    "FEATURE_COVERAGE_INCOMPLETE",
  )
  expect(() =>
    check({ ...original, domains: [{ ...first, regressions: [] }, ...original.domains.slice(1)] }),
  ).toThrow("DOMAIN_HAS_NO_EXECUTABLE_REGRESSION")
  expect(() =>
    check({
      ...original,
      domains: [
        { ...first, regressions: ["packages/core/test/absent-verification-case.test.ts"] },
        ...original.domains.slice(1),
      ],
    }),
  ).toThrow()
  expect(() =>
    check({
      ...original,
      domains: [
        { ...first, features: [...first.features, first.features[0]!] },
        ...original.domains.slice(1),
      ],
    }),
  ).toThrow("FEATURE_HAS_TWO_OWNERS")
})
