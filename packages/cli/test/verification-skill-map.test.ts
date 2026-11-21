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
const entrypointSchema = Schema.Struct({
  repository: Schema.Literals(["cli", "broker"]),
  command: Schema.String,
  required_inputs: Schema.Array(Schema.String),
})
const contractSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  owner: Schema.String,
  issue: Schema.String,
  state_owners: Schema.Array(Schema.String),
  events: Schema.Array(Schema.String),
  observation: Schema.String,
  ordinary: Schema.String,
  explicit: Schema.String,
  failure: Schema.String,
  recovery: Schema.String,
  linearization: Schema.String,
  not_proven: Schema.Array(Schema.String),
  entrypoints: Schema.Array(entrypointSchema),
})
const scenarioSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  contracts: Schema.Array(Schema.String),
  owner: Schema.String,
  issue: Schema.String,
  precondition: Schema.String,
  events: Schema.Array(Schema.String),
  oracle: Schema.Array(Schema.String),
  minimum_layer: Schema.Literals([
    "static",
    "model",
    "unit",
    "store",
    "sdk",
    "host",
    "installed",
    "live",
    "natural",
  ]),
  live_required: Schema.Boolean,
  entrypoints: Schema.Array(entrypointSchema),
})
const mapSchema = Schema.Struct({
  version: Schema.Literal(2),
  main_issue: Schema.Literal("AH-1188"),
  domains: Schema.Array(domainSchema),
  external_domains: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      repository: Schema.Literal("broker"),
      skill: Schema.String,
    }),
  ),
  contracts: Schema.Array(contractSchema),
  scenarios: Schema.Array(scenarioSchema),
})
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
  const localSkills = readdirSync(resolve(root, ".cursor/skills"))
    .filter((name) => name.startsWith("verify-"))
    .sort()
  if (JSON.stringify([...domains].sort()) !== JSON.stringify(localSkills))
    throw new Error("SKILL_OWNER_MISSING")
  for (const domain of map.external_domains) {
    if (domains.has(domain.id)) throw new Error("DUPLICATE_DOMAIN")
    domains.add(domain.id)
    if (domain.skill !== `.agents/skills/${domain.id}/SKILL.md`)
      throw new Error("EXTERNAL_SKILL_PATH_INVALID")
  }
  const contractIds = new Set<string>()
  const inspectEntrypoints = (entries: ReadonlyArray<typeof entrypointSchema.Type>) => {
    if (entries.length === 0) throw new Error("EXECUTABLE_ROUTE_MISSING")
    for (const entry of entries) {
      if (!entry.command.trim()) throw new Error("EXECUTABLE_ROUTE_MISSING")
      if (entry.required_inputs.some((input) => !input.trim()))
        throw new Error("REQUIRED_INPUT_INVALID")
      if (entry.command.includes("/absolute/") && !entry.required_inputs.length)
        throw new Error("CONFIGURED_ROUTE_INPUTS_MISSING")
      if (/\s--help$/u.test(entry.command)) throw new Error("HELP_IS_NOT_SCENARIO_EXECUTION")
      if (/^node scripts\/verify-pi-daily-candidate\.mjs(?:\s|$)/u.test(entry.command))
        throw new Error("IMPORT_MODULE_IS_NOT_EXECUTABLE_ROUTE")
      if (entry.repository !== "cli") continue
      for (const match of entry.command.matchAll(
        /\b((?:packages|scripts|verification)\/[\w./-]+\.(?:ts|mjs|py))\b/gu,
      ))
        existing(match[1]!)
    }
  }
  for (const contract of map.contracts) {
    if (contractIds.has(contract.id)) throw new Error("DUPLICATE_CONTRACT")
    contractIds.add(contract.id)
    if (!domains.has(contract.owner)) throw new Error("CONTRACT_OWNER_MISSING")
    if (!/^AH-\d+$/u.test(contract.issue)) throw new Error("CONTRACT_ISSUE_MISSING")
    for (const field of [
      "title",
      "observation",
      "ordinary",
      "explicit",
      "failure",
      "recovery",
      "linearization",
    ] as const)
      if (!contract[field].trim()) throw new Error("CONTRACT_BOUNDARY_MISSING")
    for (const field of ["state_owners", "events", "not_proven"] as const)
      if (!contract[field].length || contract[field].some((item) => !item.trim()))
        throw new Error("CONTRACT_BOUNDARY_MISSING")
    inspectEntrypoints(contract.entrypoints)
  }
  const requiredContracts = [
    ...Array.from({ length: 11 }, (_, index) => `C${String(index + 1).padStart(2, "0")}`),
    "C07a",
    "C07b",
    "C07c",
  ].sort()
  if (JSON.stringify([...contractIds].sort()) !== JSON.stringify(requiredContracts))
    throw new Error("CONTRACT_COVERAGE_INCOMPLETE")
  const scenarioIds = new Set<string>()
  const covered = new Set<string>()
  for (const scenario of map.scenarios) {
    if (scenarioIds.has(scenario.id)) throw new Error("DUPLICATE_SCENARIO")
    scenarioIds.add(scenario.id)
    if (!domains.has(scenario.owner)) throw new Error("SCENARIO_OWNER_MISSING")
    if (!scenario.precondition.trim() || !scenario.events.length || !scenario.oracle.length)
      throw new Error("SCENARIO_ORACLE_MISSING")
    if (!scenario.contracts.length) throw new Error("SCENARIO_CONTRACT_MISSING")
    for (const id of scenario.contracts) {
      if (!contractIds.has(id)) throw new Error("SCENARIO_CONTRACT_MISSING")
      covered.add(id)
      if (id.startsWith("C07")) covered.add("C07")
    }
    inspectEntrypoints(scenario.entrypoints)
  }
  const requiredScenarios = Array.from(
    { length: 23 },
    (_, index) => `T${String(index + 1).padStart(2, "0")}`,
  )
  if (JSON.stringify([...scenarioIds].sort()) !== JSON.stringify(requiredScenarios))
    throw new Error("TIMELINE_COVERAGE_INCOMPLETE")
  if ([...contractIds].some((id) => !covered.has(id))) throw new Error("CONTRACT_WITHOUT_SCENARIO")
}

test("verification domains have one owner, executable regressions and real local entrypoints", () => {
  expect(() => check(load())).not.toThrow()
})

test("current contracts and timeline seeds cannot lose their owner, oracle or executable route", () => {
  const original = load()
  expect(() => check({ ...original, contracts: original.contracts.slice(1) })).toThrow(
    "CONTRACT_COVERAGE_INCOMPLETE",
  )
  expect(() =>
    check({ ...original, contracts: [...original.contracts, original.contracts[0]!] }),
  ).toThrow("DUPLICATE_CONTRACT")
  expect(() =>
    check({
      ...original,
      contracts: original.contracts.map((item, index) =>
        index ? item : { ...item, owner: "missing-owner" },
      ),
    }),
  ).toThrow("CONTRACT_OWNER_MISSING")
  expect(() => check({ ...original, scenarios: original.scenarios.slice(1) })).toThrow(
    "TIMELINE_COVERAGE_INCOMPLETE",
  )
  expect(() =>
    check({
      ...original,
      scenarios: original.scenarios.map((item, index) => (index ? item : { ...item, oracle: [] })),
    }),
  ).toThrow("SCENARIO_ORACLE_MISSING")
  expect(() =>
    check({
      ...original,
      scenarios: original.scenarios.map((item, index) =>
        index ? item : { ...item, entrypoints: [] },
      ),
    }),
  ).toThrow("EXECUTABLE_ROUTE_MISSING")
  expect(() =>
    check({
      ...original,
      contracts: original.contracts.map((item) =>
        item.id !== "C10"
          ? item
          : {
              ...item,
              entrypoints: [
                {
                  repository: "broker",
                  command: "node scripts/verify-pi-daily-candidate.mjs --help",
                  required_inputs: [],
                },
              ],
            },
      ),
    }),
  ).toThrow("HELP_IS_NOT_SCENARIO_EXECUTION")
  expect(() =>
    check({
      ...original,
      scenarios: original.scenarios.map((item) =>
        item.id !== "T21"
          ? item
          : {
              ...item,
              entrypoints: item.entrypoints.map((entry) => ({ ...entry, required_inputs: [] })),
            },
      ),
    }),
  ).toThrow("CONFIGURED_ROUTE_INPUTS_MISSING")
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
