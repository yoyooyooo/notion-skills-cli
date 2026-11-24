import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileRef } from "../src/ref.ts"
import { property } from "../src/model.ts"
import {
  planCurrentMembers,
  parseCurrentMemberBindings,
  type CurrentMemberInput,
} from "../src/shared-current-member-discovery.ts"
import { prepareCurrentSkillWrite, writeCurrentSkill } from "../src/shared-current-write.ts"
import { currentWriteFixture, id, library } from "./shared-current-write-fixture.ts"

const encode = (value: string) => new TextEncoder().encode(value)
const member = (id: string) => `skill://${id}?library=${library.library_id}`
const ref = (id: string, path = "SKILL.md") => fileRef(member(id), path)
const input = (markdown: string, extra: Partial<CurrentMemberInput> = {}): CurrentMemberInput => ({
  skill_id: "owner",
  kind: "skill",
  name: "Owner",
  description: "Owner",
  files: [{ path: "SKILL.md", bytes: encode(markdown) }],
  ...extra,
})
const fixture = async () =>
  currentWriteFixture(await mkdtemp(join(tmpdir(), "ntn-members-discovery-")))
async function target(f: Awaited<ReturnType<typeof fixture>>, id: string, enabled = true) {
  const plan = await f.run(
    prepareCurrentSkillWrite({
      skill_id: id,
      kind: "skill",
      name: "Same display name",
      description: "Target",
      enabled,
      files: [
        { path: "SKILL.md", bytes: encode("# Target") },
        { path: "docs/guide.md", bytes: encode("# Guide") },
      ],
    }),
  )
  return f.run(writeCurrentSkill(library, { plan, operation_id: "create-" + id, mode: "apply" }))
}

test("Members discovery uses concrete current identities and scans supporting Markdown without code or name guessing", async () => {
  const f = await fixture()
  await target(f, "target")
  await target(f, "mentioned")
  const supplied = input(
    [
      "# Owner",
      "Use mentioned and target.",
      "`[code](" + ref("mentioned") + ")`",
      "```markdown",
      "[example](" + ref("mentioned") + ")",
      "```",
      "    [indented code](" + ref("mentioned") + ")",
      "<!-- [comment](" + ref("mentioned") + ") -->",
      "![image](" + ref("mentioned") + ")",
      "`../<name>/SKILL.md`",
      "Read [support](docs/work.md).",
      "[Root directory](.)",
    ].join("\n"),
  )
  const files = [
    ...supplied.files,
    {
      path: "docs/work.md",
      bytes: encode(
        "[Parent](../)\nUse [target][identity].\n\n[identity]: " + ref("target", "docs/guide.md"),
      ),
    },
  ]
  f.clearCalls()
  const result = await f.run(
    planCurrentMembers(library, { ...supplied, files }, { existing: false }),
  )
  expect(result.relations?.members).toEqual([member("target")])
  expect(result.confirmed).toMatchObject([
    { from: "docs/work.md", member: member("target"), rewritten: false },
  ])
  expect(result.unresolved).toEqual([])
  expect(result.importable).toBe(true)
  expect(result.portable.files).toEqual(files)
  expect(f.mutations()).toEqual([])
})

test("an explicit unique binding rewrites only verified hyperlinks in a portable copy", async () => {
  const f = await fixture()
  await target(f, "target")
  const body = "# Owner\nRead [target](../b/SKILL.md).\n`../b/SKILL.md`\n"
  const supplied = input(body)
  const bindings = parseCurrentMemberBindings({
    version: 1,
    root: "skills/a",
    targets: [{ path: "skills/b/SKILL.md", ref: ref("target") }],
  })
  const result = await f.run(planCurrentMembers(library, supplied, { existing: false, bindings }))
  expect(result.importable).toBe(true)
  expect(result.relations?.members).toEqual([member("target")])
  expect(result.confirmed).toMatchObject([
    { href: "../b/SKILL.md", ref: ref("target"), rewritten: true },
  ])
  expect(new TextDecoder().decode(result.portable.files[0]!.bytes)).toBe(
    body.replace("../b/SKILL.md)", "skill://target/SKILL.md)"),
  )
  expect(new TextDecoder().decode(supplied.files[0]!.bytes)).toBe(body)
})

test("unbound, ambiguous, missing, disabled, foreign and nonexact references never create Members", async () => {
  const f = await fixture()
  await target(f, "target")
  await target(f, "disabled", false)
  const canonical = [
    ref("missing"),
    ref("disabled"),
    ref("target", "absent.md"),
    ref("target") + "&file_id=wrong-file",
    fileRef("skill://target?library=563e49fa-4378-5493-a5ff-8c96321f9ffd", "SKILL.md"),
    "skill://Same%20display%20name/SKILL.md",
    "skill://%/SKILL.md",
    ref("target") + "&snapshot=s_" + "a".repeat(64),
  ]
  const result = await f.run(
    planCurrentMembers(library, input(canonical.map((value) => `[target](${value})`).join("\n")), {
      existing: false,
    }),
  )
  expect(result.confirmed).toEqual([])
  expect(result.relations).toBeUndefined()
  expect(result.unresolved).toHaveLength(canonical.length)
  for (const targets of [
    [],
    [
      { path: "skills/b/SKILL.md", ref: ref("target") },
      { path: "skills/b/SKILL.md", ref: ref("disabled") },
    ],
  ]) {
    const planned = await f.run(
      planCurrentMembers(library, input("[target](../b/SKILL.md)"), {
        existing: false,
        bindings: parseCurrentMemberBindings({ version: 1, root: "skills/a", targets }),
      }),
    )
    expect(planned.confirmed).toEqual([])
    expect(planned.relations).toBeUndefined()
    expect(planned.importable).toBe(false)
    expect(planned.unresolved[0]?.blocks_import).toBe(true)
  }
})

test("existing Members and explicit empty Members win while Requires is never inferred or replaced", async () => {
  const f = await fixture()
  await target(f, "target")
  const requires = [member("target")]
  const relations = {
    version: 1 as const,
    ownership: "notion" as const,
    library_id: library.library_id,
    requires,
  }
  const supplied = input(`[target](${ref("target")})`, { relations })
  const first = await f.run(planCurrentMembers(library, supplied, { existing: false }))
  expect(first.relations).toEqual({ ...relations, members: [member("target")] })
  const existing = await f.run(planCurrentMembers(library, supplied, { existing: true }))
  expect(existing.member_policy).toBe("preserve_existing")
  expect(existing.relations).toEqual(relations)
  const explicit = await f.run(
    planCurrentMembers(
      library,
      { ...supplied, relations: { ...relations, members: [] } },
      { existing: false },
    ),
  )
  expect(explicit.member_policy).toBe("explicit")
  expect(explicit.relations).toEqual({ ...relations, members: [] })
})

test("an unverified binding is not rewritten and cannot be reported importable", async () => {
  const f = await fixture()
  await target(f, "target")
  const original = input("[unverified](../b/missing.md)\n[local](missing-local.md)")
  const result = await f.run(
    planCurrentMembers(library, original, {
      existing: false,
      bindings: parseCurrentMemberBindings({
        version: 1,
        root: "skills/a",
        targets: [{ path: "skills/b/missing.md", ref: ref("target", "missing.md") }],
      }),
    }),
  )
  expect(result.importable).toBe(false)
  expect(result.confirmed).toEqual([])
  expect(result.portable.files).toEqual(original.files)
  expect(result.unresolved.map((value) => value.reason)).toEqual([
    "missing_local_file",
    "target_file_unconfirmed",
  ])
})

test("binding declarations reject templates and traversal instead of guessing a tree", () => {
  for (const root of ["../a", "./a", "/a", "skills/<name>", "skills/*"])
    expect(() => parseCurrentMemberBindings({ version: 1, root, targets: [] })).toThrow()
  expect(() =>
    parseCurrentMemberBindings({ version: 1, root: "skills/a", targets: [], guess: true }),
  ).toThrow()
})

test("encoded path separators cannot create a cross-root identity mapping", async () => {
  const f = await fixture()
  await target(f, "target")
  f.clearCalls()
  const supplied = input("[target](../b%2FSKILL.md)")
  const result = await f.run(
    planCurrentMembers(library, supplied, {
      existing: false,
      bindings: parseCurrentMemberBindings({
        version: 1,
        root: "skills/a",
        targets: [{ path: "skills/b/SKILL.md", ref: ref("target") }],
      }),
    }),
  )
  expect(result.confirmed).toEqual([])
  expect(result.importable).toBe(false)
  expect(result.portable.files).toEqual(supplied.files)
  expect(result.unresolved).toMatchObject([{ reason: "invalid_path", blocks_import: true }])
  expect(f.calls).toEqual([])
})

test("a reference definition shared with an image or skipped indented usage is not rewritten", async () => {
  const f = await fixture()
  await target(f, "target")
  const bindings = parseCurrentMemberBindings({
    version: 1,
    root: "skills/a",
    targets: [{ path: "skills/b/SKILL.md", ref: ref("target") }],
  })
  for (const other of ["![image][x]", "    [indented][x]"]) {
    const original = input(`Read [target][x].\n${other}\n\n[x]: ../b/SKILL.md`)
    const result = await f.run(planCurrentMembers(library, original, { existing: false, bindings }))
    expect(result.importable).toBe(false)
    expect(result.confirmed).toEqual([])
    expect(result.portable.files).toEqual(original.files)
    expect(
      result.unresolved.some((item) => item.reason === "shared_destination_has_unselected_uses"),
    ).toBe(true)
  }
})

test("portable canonicalization preserves UTF-8 BOM, CRLF and every unselected byte", async () => {
  const f = await fixture()
  await target(f, "target")
  const body =
    "\uFEFF---\r\nname: Owner\r\ndescription: Exact bytes\r\n---\r\n[use](../b/SKILL.md)\r\n"
  const original = input(body)
  const result = await f.run(
    planCurrentMembers(library, original, {
      existing: false,
      bindings: parseCurrentMemberBindings({
        version: 1,
        root: "skills/a",
        targets: [{ path: "skills/b/SKILL.md", ref: ref("target") }],
      }),
    }),
  )
  expect(result.importable).toBe(true)
  expect(result.portable.files[0]!.bytes).toEqual(
    encode(body.replace("../b/SKILL.md", "skill://target/SKILL.md")),
  )
  expect(original.files[0]!.bytes).toEqual(encode(body))
})

test("distinct candidate admission is bounded and extra exact refs stay unresolved without blocking import", async () => {
  const f = await fixture()
  const supplied = input(
    Array.from({ length: 103 }, (_, index) => `[target](${ref("absent-" + index)})`).join("\n"),
  )
  f.clearCalls()
  const result = await f.run(planCurrentMembers(library, supplied, { existing: false }))
  expect(result.importable).toBe(true)
  expect(result.confirmed).toEqual([])
  expect(result.relations).toBeUndefined()
  expect(result.unresolved.filter((item) => item.reason === "candidate_limit")).toHaveLength(3)
  expect(f.calls.filter((call) => call.path.endsWith("/query"))).toHaveLength(100)
})

test("101 valid current links produce a writable first-creation selection of at most 100 Members", async () => {
  const f = await fixture()
  for (let index = 0; index < 101; index++) await target(f, "target-" + index)
  const supplied = input(
    Array.from({ length: 101 }, (_, index) => `[target](${ref("target-" + index)})`).join("\n"),
  )
  const result = await f.run(planCurrentMembers(library, supplied, { existing: false }))
  expect(result.importable).toBe(true)
  expect(result.confirmed).toHaveLength(100)
  expect(result.relations?.members).toHaveLength(100)
  expect(result.unresolved).toMatchObject([{ reason: "candidate_limit", blocks_import: false }])
  const plan = await f.run(prepareCurrentSkillWrite({ ...supplied, relations: result.relations }))
  const written = await f.run(
    writeCurrentSkill(library, {
      plan,
      operation_id: "bounded-import",
      mode: "apply",
      create_only: true,
    }),
  )
  expect(written.state).toBe("ready")
}, 60_000)

test("duplicate exact Skill identities remain unresolved rather than selecting one page", async () => {
  const f = await fixture()
  await target(f, "target")
  f.rewrite((path, row) =>
    path === `v1/data_sources/${library.skills.data_source_id}/query` &&
    Array.isArray(row.results) &&
    row.results.length === 1
      ? { ...row, results: [row.results[0], { ...property(row.results[0]), id: id(999) }] }
      : row,
  )
  const result = await f.run(
    planCurrentMembers(library, input(`[target](${ref("target")})`), { existing: false }),
  )
  expect(result.confirmed).toEqual([])
  expect(result.relations).toBeUndefined()
  expect(result.unresolved).toMatchObject([
    { reason: "shared_skill_id_conflict", blocks_import: false },
  ])
  expect(result.importable).toBe(true)
})
