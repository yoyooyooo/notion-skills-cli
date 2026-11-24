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
  const roots = new Set(["list", "read", "use", "files", "export", "schema", "ctl", "auth"])
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
  const library = new Set([
    "init",
    "inspect",
    "files",
    "operation",
    "skill",
    "import",
    "import-batch",
    "members-plan",
    "source",
    "projection",
    "profile",
  ])
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
            if (words[1] === "library") {
              expect(library.has(words[2]!), label).toBe(true)
              if (words[2] === "source")
                expect(
                  [
                    "apply",
                    "check",
                    "sync",
                    "refresh",
                    "enable",
                    "disable",
                    "remove",
                    "takeover",
                    "restore-follow",
                  ],
                  label,
                ).toContain(words[3]!)
              if (words[2] === "skill")
                expect(["create", "update", "register", "remove"], label).toContain(words[3]!)
            }
          }
          expect(words, label).not.toContain("--authoring")
          expect(words, label).not.toContain("--read-only")
        }
      }
    }
  }
  expect(examples).toBeGreaterThan(10)
})

test("maintenance routes daily native management through public commands and keeps advanced recovery in references", () => {
  const root = fileText("notion/ntn-skills-maintain", "SKILL.md")
  const setup = fileText("notion/ntn-skills-maintain", "references/setup.md")
  const operations = fileText("notion/ntn-skills-maintain", "references/operations.md")
  expect(new TextEncoder().encode(root).byteLength).toBeLessThanOrEqual(5300)
  expect(root).toContain("ctl library files PAGE_ID --library ENTRY")
  expect(root).toContain("read PAGE_ID --library ENTRY --refresh --json")
  expect(root).toContain("CURRENT_SCHEMA_REQUIRED")
  expect(root).toContain("CURRENT_OPERATION_PENDING")
  expect(root).toContain("ctl library import INPUT --library ENTRY --skill-id SKILL_ID --dry-run")
  for (const action of ["create INPUT", "update TARGET", "register PAGE_ID", "remove TARGET"])
    expect(root).toContain(`ctl library skill ${action} --library ENTRY`)
  expect(root).toContain("preserves everything else")
  expect(root).toContain("no projection is")
  expect(root).toContain("do not construct those Notion fields")
  expect(root).toContain("clears")
  expect(root).toContain("incoming Members/Requires")
  expect(operations).toContain("--operation OPERATION_ID --resume")
  expect(operations).toContain("--supersede OLD_OPERATION_ID --operation NEW_OPERATION_ID")
  expect(operations).toContain("native.normalized_paths")
  expect(operations).toContain("Profile v2 contains View/freshness rules, not Skill membership")
  expect(root).toContain("zero semantic Notion writes")
  expect(root).toContain("complete CLI verification")
  expect(root).toContain("only for requested review or")
  expect(root).toContain("not a completed")
  expect(root).toContain('skill_dir=$(cd "$skill_dir" && pwd -P)')
  expect(root).toContain("notion_list({query: SKILL_ID, source: SOURCE_ID, refresh: true})")
  expect(root).toContain("then use\nordinary `read`")
  expect(root).toContain("not adopted\nversions")
  expect(root.replace(/\s+/g, " ")).toContain(
    "Repeating an unchanged empty query or running CLI list does not refresh the host directory.",
  )
  expect(root).toContain("Summarized readbacks retain page/ref, snapshot")
  expect(root).toContain("For a basic how-to, explain create/register below from this main")
  expect(root).toContain("load an API Skill only for direct API work")
  expect(root).toContain("reported connection/schema problem")
  expect(operations).toContain("local input recipe")
  expect(setup).toContain("ctl library init --parent AUTHORIZED_PARENT_PAGE")
  expect(setup).toContain("ctl library skill create INPUT --library ENTRY --skill-id SKILL_ID")
  expect(setup).toContain("converts an older library schema")
  expect(setup).toContain("/context-broker connect SOURCE ENTRY")
  expect(operations).toContain("metadata-only")
  expect(operations).toContain("Target inspection does not prove whole-library coverage")
  expect(operations).toMatch(/unknown CREATE/iu)
})

test("consumption and Profile guidance preserve zero-write reads and complete current replacement", () => {
  const consumer = fileText("notion/ntn-skills", "SKILL.md")
  const profile = fileText("notion/ntn-skills-sync", "SKILL.md")
  const details = fileText("notion/ntn-skills-sync", "references/synchronization.md")
  expect(consumer).toContain("zero semantic Notion writes")
  expect(consumer).toContain("generated Source/resource")
  expect(consumer).toContain("selecting current content again")
  expect(consumer).toContain("not a current CLI option")
  expect(consumer).toContain("Create, edit, register or delete a Notion-native Skill")
  expect(consumer).toContain("ctl library skill")
  expect(profile).toContain("ctl library profile set")
  expect(profile).toContain("--expect new")
  expect(profile).toContain("complete desired rule")
  expect(profile).toContain("--reconcile")
  expect(profile).toContain("without another POST or PATCH")
  expect(profile).toContain("do not grant access")
  expect(details).toContain("A Skill can combine multiple")
  expect(details).toContain("Complete Source manifests and Contributions")
  expect(details).toContain("Only Notion-owned supporting")
  expect(details).toContain("Contributions.exclude or removes scripts/tests")
  for (const route of ["enable", "disable", "remove", "takeover", "restore-follow"])
    expect(profile).toContain(`ctl library source ${route}`)
  expect(details).toContain("Source `options.storage` are rejected")
  expect(details).toContain("Any effective Source contribution, current Source Content or Origin")
  expect(details).toContain("without publishing ready or recreating the Source")
  expect(details).toContain("A metadata toggle cannot clear an unfinished multi-target refresh")
})

test("projection completion ends routine writes without blocking requested repeat work or recovery", () => {
  const maintain = fileText("notion/ntn-skills-maintain", "SKILL.md")
  const operations = fileText("notion/ntn-skills-maintain", "references/operations.md")
  const sync = fileText("notion/ntn-skills-sync", "SKILL.md")
  const synchronization = fileText("notion/ntn-skills-sync", "references/synchronization.md")
  for (const guide of [maintain, operations, sync, synchronization]) {
    const prose = guide.replace(/\s+/g, " ")
    expect(prose).toContain("scope:skill/status:complete")
    expect(prose).toContain("complete projection")
    expect(prose).toMatch(/restoration\.status.{0,12}restored or unchanged/)
    expect(prose).toContain("read-only")
    expect(prose).toContain("new user request or an explicit idempotence test")
    expect(prose).not.toContain(
      "Repeat on the live complete page to establish zero semantic writes",
    )
  }
  for (const guide of [operations, synchronization]) {
    const restore = guide.split("## Restore a trashed Skill\n")[1]!.split("\n## ")[0]!
    const prose = restore.replace(/\s+/g, " ")
    expect(prose).toContain("terminal success receipt")
    expect(prose).toContain("read-only `read`, `ctl library files` or `export`")
    expect(prose).toContain("Do not rerun a completed write to verify it")
    expect(prose).toContain(
      "Repeat the same command after its own restore or later projection interruption",
    )
  }
  expect(operations).toContain("Unknown CREATE/append still needs an observable")
  expect(operations).toContain("Preserve original state and credential scope")
  expect(synchronization).toContain("Uncertain actions remain pending")
})

test("product guidance defaults to the execution package and preserves explicit remote selections", () => {
  const prose = (id: string, path: string) => fileText(id, path).replace(/\s+/g, " ")
  const consumer = prose("notion/ntn-skills", "SKILL.md")
  const maintain = prose("notion/ntn-skills-maintain", "SKILL.md")
  const sync = prose("notion/ntn-skills-sync", "SKILL.md")
  const commands = prose("notion/ntn-skills", "references/commands.md")
  const integration = prose("notion/ntn-skills", "references/integration.md")
  for (const guidance of [consumer, commands, integration]) {
    expect(guidance).toContain("ctl builtin read notion/ntn-skills-maintain")
    expect(guidance).toContain("ctl builtin read notion/ntn-skills-sync")
    expect(guidance).toContain("including with a connected library")
    expect(guidance).toContain("Ordinary business")
    expect(guidance).toContain("pending content")
    expect(guidance).toContain("denied access")
  }
  expect(consumer).toContain("the task's executable")
  expect(consumer).toContain("no Notion copy or remote workflow search")
  expect(consumer).toContain("If the user explicitly selects a Notion/team workflow")
  expect(consumer).toContain("use 'EXACT_WORKFLOW_REF'")
  expect(consumer).toContain("Inspect the edited target; do not activate it")
  expect(consumer).toContain("never a reason to substitute a package workflow")
  expect(consumer).toContain("cannot replace the package default")
  expect(consumer).toContain("Keep an already selected task's identity and content")
  expect(consumer).toContain("An npm update does not refresh a Notion Source")
  expect(maintain).toContain("ntn-skills read RELATIVE_PATH --from CONTAINING_FILE_REF")
  expect(maintain).toContain("For package-selected instructions")
  expect(sync).toContain("RELATIVE_PATH --from CONTAINING_FILE_REF")
  for (const guidance of [maintain, sync, integration]) {
    expect(guidance).toContain("notion_use")
    expect(guidance).toContain("Requires")
    expect(guidance).toMatch(/never substitute/i)
  }
  expect(integration).toContain("from its paired SDK")
  expect(integration).toContain("Without an enabled source, it does not inject")
  expect(integration).toContain("startup directory")
  expect(integration).toContain("query the connected library explicitly")
  expect(integration).toContain("An independent CLI `list --refresh` does not refresh")
  expect(integration).toContain("Do not combine refresh with an old pagination cursor")
})

test("the published documentation allowlist contains only current guides", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { files: string[] }
  expect(manifest.files.filter((path) => path.startsWith("docs/"))).toEqual([
    "docs/README.md",
    "docs/current-contract.md",
    "docs/usage.md",
    "docs/notion-mcp.md",
    "docs/source-sync.md",
    "docs/shared-authoring.md",
    "docs/protocol.md",
    "docs/skill-reference-redesign.md",
    "docs/maintenance-verification-review.md",
  ])
})
