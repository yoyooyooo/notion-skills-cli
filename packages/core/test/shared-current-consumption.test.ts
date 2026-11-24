import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  resolveCurrentSkillConsumption,
  resolveCurrentSourceConsumption,
} from "../src/shared-current-consumption.ts"
import type { CurrentFileContent } from "../src/shared-current-file.ts"
import type { CurrentFileBinding, CurrentSkillIndex } from "../src/shared-current-index.ts"
import type { CurrentSourceContribution } from "../src/shared-current-source-input.ts"
import { validateCurrentSharedSourceContent } from "../src/shared-current-source.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import {
  currentBytes as bytes,
  currentDigest as digest,
  currentId as id,
  currentLibrary as library,
  currentSnapshotFixture,
} from "./shared-current-fixture.ts"

const skillId = "selected-skill"
const native = { kind: "native", mode: "100644", frontmatter: "" } satisfies CurrentFileContent
const sourceContent = {
  kind: "source",
  source_id: "stale-projection",
  revision: "c".repeat(64),
  source_path: "obsolete/SKILL.md",
  sha256: "d".repeat(64),
  bytes: 12,
  mode: "100644",
} satisfies CurrentFileContent
const fieldId = (name: string) => {
  const value = library.sources.property_ids[name]
  if (value === undefined) throw new Error("Missing fixture Source property: " + name)
  return value
}
const rich = (name: string, value: string) => ({
  id: fieldId(name),
  type: "rich_text",
  has_more: false,
  rich_text: sourceRich(value),
})
const selection = (name: string, value: string) => ({
  id: fieldId(name),
  type: "select",
  select: { name: value },
})
const list = (results: readonly unknown[], cursor: string | null = null) => ({
  object: "list",
  results,
  has_more: cursor !== null,
  next_cursor: cursor,
})
const contribution = (
  member_key = ".",
  overrides: Partial<CurrentSourceContribution> = {},
): CurrentSourceContribution => ({
  member_key,
  skill_id: skillId,
  mount_path: "",
  mapping: {},
  exclude: [],
  ...overrides,
})
const file = (path: string, body = path, mode: "100644" | "100755" = "100644") => ({
  path,
  bytes: bytes(body),
  mode,
})
const binding = (
  path: string,
  content: CurrentFileContent,
  physical = id(100),
): CurrentFileBinding => ({
  file_id: "file-" + physical,
  page_id: physical,
  skill_page_id: id(1),
  path,
  last_edited_time: "2026-11-21T00:00:00.000Z",
  content,
})
const index = (
  main: CurrentFileContent = sourceContent,
  files: readonly CurrentFileBinding[] = [],
): CurrentSkillIndex => ({
  skill_id: skillId,
  page_id: id(1),
  kind: "skill",
  name: "Selected",
  description: "",
  enabled: true,
  default_context: false,
  state: { state: "ready" },
  main: binding("SKILL.md", main, id(1)),
  files,
})

function source(
  sourceId: string,
  files: readonly ReturnType<typeof file>[],
  contributions: readonly CurrentSourceContribution[] = [contribution()],
  physical = id(22),
) {
  const content = validateCurrentSharedSourceContent({
    version: 1,
    plan: {
      version: 1,
      kind: "composition",
      base: {
        kind: "git",
        source: {
          url: "https://github.com/example/skills",
          commit: "a".repeat(40),
          tree: "b".repeat(40),
          root: "",
          files: files.map((file) => ({
            path: file.path,
            source_path: file.path,
            sha256: digest(file.bytes),
            git_oid: createHash("sha1")
              .update("blob " + file.bytes.length + "\0")
              .update(file.bytes)
              .digest("hex"),
            bytes: file.bytes.length,
            mode: file.mode,
          })),
        },
      },
      mounts: [],
    },
  })
  if (!("plan" in content)) throw new Error("Expected inline fixture manifest")
  const properties: Record<string, unknown> = {
    [fieldId("Name")]: {
      id: fieldId("Name"),
      type: "title",
      title: sourceRich("Current Source"),
    },
    [fieldId("Description")]: rich("Description", "Current complete provider tree"),
    [fieldId("Source ID")]: rich("Source ID", sourceId),
    [fieldId("Provider")]: selection("Provider", "git"),
    [fieldId("Location")]: rich("Location", "https://github.com/example/skills"),
    [fieldId("Ref")]: rich("Ref", "main"),
    [fieldId("Policy")]: selection("Policy", "manual"),
    [fieldId("Selection")]: rich(
      "Selection",
      JSON.stringify({ roots: ["."], include: [], exclude: [], mapping: {} }),
    ),
    [fieldId("Options")]: rich("Options", "{}"),
    [fieldId("Enabled")]: { id: fieldId("Enabled"), type: "checkbox", checkbox: true },
    [fieldId("Status")]: selection("Status", "ready"),
    [fieldId("Operation")]: rich("Operation", ""),
    [fieldId("Contributions")]: rich("Contributions", JSON.stringify(contributions)),
    [fieldId("Content")]: rich("Content", JSON.stringify(content)),
    [fieldId("Last Revision")]: rich("Last Revision", digest(canonicalSharedJson(content.plan))),
  }
  return {
    object: "page",
    id: physical,
    parent: {
      type: "data_source_id",
      data_source_id: library.sources.data_source_id,
      database_id: library.sources.database_id,
    },
    properties,
  }
}

function fixture(responses: readonly unknown[]) {
  const base = currentSnapshotFixture({ fileCount: 0 })
  const calls: { path: string; body: unknown; method: string }[] = []
  let next = 0
  const notion: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.sync(() => {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        calls.push({ path, body, method })
        if (
          method !== "POST" ||
          !path.startsWith("v1/data_sources/" + library.sources.data_source_id + "/query")
        )
          throw new Error("Consumption helper must only query current Source metadata")
        const response = responses[next++]
        if (response === undefined) throw new Error("Unexpected extra Source query")
        return structuredClone(response)
      }),
  }
  const resolve = (selected: CurrentSkillIndex = index()) =>
    base.run(
      resolveCurrentSkillConsumption(library, selected, { sourceOptions: {} }).pipe(
        Effect.provideService(Notion, notion),
      ),
    )
  const resolveSources = (excludeSourceIds: readonly string[] = []) =>
    base.run(
      resolveCurrentSourceConsumption(library, skillId, {
        sourceOptions: {},
        excludeSourceIds,
      }).pipe(Effect.provideService(Notion, notion)),
    )
  return { ...base, calls, resolve, resolveSources }
}

test("complete source trees ignore absent, stale and extra projection rows and keep only exact Skill contributions", async () => {
  const files = [
    file("alpha/SKILL.md", "# Main"),
    file("alpha/references/readme.md"),
    file("alpha/scripts/test.js", "run()", "100755"),
    file("alpha/tests/fixture.bin", "\0bytes"),
    file("beta/SKILL.md", "# Another Skill"),
  ]
  const row = source("provider", files, [
    contribution("alpha"),
    contribution("beta", { skill_id: "another-skill" }),
  ])
  const absent = fixture([list([row]), list([row])])
  const first = await absent.resolve()
  expect(first.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "references/readme.md",
    "scripts/test.js",
    "tests/fixture.bin",
  ])
  expect(first.files[2]?.content).toMatchObject({
    kind: "source",
    source_id: "provider",
    source_path: "alpha/scripts/test.js",
    sha256: digest("run()"),
    bytes: 5,
    mode: "100755",
  })
  expect(first.files.every((file) => !("page_id" in file) && !("file_id" in file))).toBe(true)
  const stale = fixture([list([row]), list([row])])
  const second = await stale.resolve(
    index(sourceContent, [
      binding("references/readme.md", sourceContent),
      binding("invented/extra.md", sourceContent, id(101)),
    ]),
  )
  expect(second.files).toEqual(first.files)
  expect(second.source_fingerprint).toBe(first.source_fingerprint)
  expect(absent.calls).toHaveLength(2)
  expect(absent.objects.size).toBe(0)
  expect([...absent.json.keys()]).toEqual(["config.json"])
})

test("a native main still discovers Source contributions and retains native and resource authority", async () => {
  const resource = {
    kind: "resource",
    object_id: "resource-" + "e".repeat(64),
    sha256: "f".repeat(64),
    bytes: 28,
    mode: "100644",
  } satisfies CurrentFileContent
  const row = source(
    "provider",
    [file("SKILL.md"), file("run.sh", "#!/bin/sh\n", "100755"), file("original.bin")],
    [contribution(".", { exclude: ["SKILL.md", "original.bin"] })],
  )
  const selected = index(native, [
    binding("notes.md", { ...native, frontmatter: "---\nname: local\n---\n" }),
    binding("original.bin", resource, id(101)),
  ])
  const f = fixture([list([row]), list([row])])
  const result = await f.resolve(selected)
  expect(result.files).toEqual([
    { path: "SKILL.md", content: native },
    { path: "notes.md", content: selected.files[0]?.content },
    { path: "original.bin", content: resource },
    {
      path: "run.sh",
      content: expect.objectContaining({ kind: "source", mode: "100755", source_path: "run.sh" }),
    },
  ])
  expect([...result.sources.keys()]).toEqual(["provider"])
  expect(selected.files[0]?.page_id).toBe(id(100))
  expect(property(property(f.calls[0]?.body).filter)).toEqual({
    property: fieldId("Contributions"),
    rich_text: { contains: skillId },
  })
})

test("member mapping, mounts and authority exclusions compose multiple exact Sources", async () => {
  const alpha = source(
    "alpha",
    [file("member/MAIN.md"), file("member/docs/a.md"), file("member/private.md")],
    [
      contribution("member", {
        mapping: { "MAIN.md": "SKILL.md", "docs/a.md": "guide.md" },
        exclude: ["private.md"],
      }),
    ],
  )
  const beta = source(
    "beta",
    [file("lib/core.py", "print(1)", "100755"), file("lib/unused.bin"), file("other/secret.md")],
    [
      contribution("lib", {
        mount_path: "assets",
        mapping: { "core.py": "scripts/core.py" },
        exclude: ["unused.bin"],
      }),
      contribution("other", { skill_id: "other-skill" }),
    ],
    id(23),
  )
  const f = fixture([list([beta, alpha]), list([alpha, beta])])
  const result = await f.resolve()
  expect(result.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "assets/scripts/core.py",
    "guide.md",
  ])
  expect(result.files[1]?.content).toMatchObject({
    source_id: "beta",
    source_path: "lib/core.py",
    mode: "100755",
  })
  expect([...result.sources.keys()]).toEqual(["alpha", "beta"])
})

test("pure Notion content ignores unrelated contains candidates without decoding their broken Source content", async () => {
  const unrelated = source(
    "unrelated",
    [file("SKILL.md")],
    [contribution(".", { skill_id: skillId + "-other" })],
  )
  unrelated.properties[fieldId("Content")] = rich("Content", "{broken-json")
  delete unrelated.properties[fieldId("Provider")]
  const f = fixture([list([unrelated])])
  const result = await f.resolve(index(native, [binding("notes.md", native)]))
  expect(result.files).toEqual([
    { path: "SKILL.md", content: native },
    { path: "notes.md", content: native },
  ])
  expect(result.sources.size).toBe(0)
  expect(f.calls).toHaveLength(1)
})

test("candidate pagination reaches a later exact contribution before resolving its manifest", async () => {
  const unrelated = source(
    "unrelated",
    [file("SKILL.md")],
    [contribution(".", { skill_id: skillId + "-other" })],
  )
  const selected = source("provider", [file("SKILL.md"), file("support.txt")], undefined, id(23))
  const f = fixture([list([unrelated], "next"), list([selected]), list([selected])])
  const result = await f.resolve()
  expect(result.files.map((file) => file.path)).toEqual(["SKILL.md", "support.txt"])
  expect(property(f.calls[1]?.body).start_cursor).toBe("next")
  expect(f.calls.every((call) => call.method === "POST" && call.path.includes("/query"))).toBe(true)
})

test("incomplete, looping and duplicate Source inventories fail before any byte acquisition", async () => {
  const row = source("provider", [file("SKILL.md")])
  const cases = [
    {
      responses: [{ ...list([]), request_status: { type: "partial" } }],
      code: "CURRENT_SOURCE_INCOMPLETE",
    },
    {
      responses: [list([], "again"), list([], "again")],
      code: "CURRENT_SOURCE_INCOMPLETE",
    },
    {
      responses: [list([row, { ...row, id: id(23) }])],
      code: "CURRENT_SOURCE_DUPLICATE",
    },
    {
      responses: [list([{ ...row, archived: true }])],
      code: "CURRENT_SOURCE_INVALID",
    },
  ]
  for (const item of cases) {
    const f = fixture(item.responses)
    await expect(f.resolve()).rejects.toMatchObject({ code: item.code })
    expect(f.objects.size).toBe(0)
  }
})

test("Source collisions with native files or another Source require explicit authority exclusions", async () => {
  const first = source("first", [file("SKILL.md")])
  const second = source("second", [file("SKILL.md")], undefined, id(23))
  await expect(
    fixture([list([first]), list([first])]).resolve(index(native)),
  ).rejects.toMatchObject({
    code: "COMPOSITION_SOURCE_COLLISION",
  })
  await expect(
    fixture([list([first, second]), list([first, second])]).resolve(),
  ).rejects.toMatchObject({ code: "COMPOSITION_SOURCE_COLLISION" })
  const directory = source(
    "directory",
    [file("SKILL.md"), file("a"), file("b")],
    [contribution(".", { mapping: { a: "docs", b: "docs/nested.md" } })],
  )
  await expect(fixture([list([directory]), list([directory])]).resolve()).rejects.toMatchObject({
    code: "COMPOSITION_PATH_COLLISION",
  })
})

test("consumption fingerprints ignore projection metadata and unrelated contributions but track exact mappings and content", async () => {
  const files = [file("alpha/SKILL.md"), file("alpha/notes.md"), file("beta/other.md")]
  const contributions = [contribution("alpha"), contribution("beta", { skill_id: "other-skill" })]
  const original = source("provider", files, contributions)
  const first = await fixture([list([original]), list([original])]).resolve()
  const changed = source("provider", files, contributions, id(24))
  changed.properties[fieldId("Name")] = {
    id: fieldId("Name"),
    type: "title",
    title: sourceRich("A display name"),
  }
  changed.properties[fieldId("Description")] = rich("Description", "A display description")
  changed.properties["projection-policy"] = { type: "rich_text", rich_text: sourceRich("md only") }
  changed.properties[fieldId("Contributions")] = rich(
    "Contributions",
    JSON.stringify([
      contribution("beta", { skill_id: "other-skill", exclude: ["other.md"] }),
      contribution("alpha"),
    ]),
  )
  const same = await fixture([list([changed]), list([changed])]).resolve()
  expect(same.files).toEqual(first.files)
  expect(same.source_fingerprint).toBe(first.source_fingerprint)
  const mapped = source("provider", files, [
    contribution("alpha", { mapping: { "notes.md": "guide.md" } }),
  ])
  const mappingChanged = await fixture([list([mapped]), list([mapped])]).resolve()
  expect(mappingChanged.source_fingerprint).not.toBe(first.source_fingerprint)
  const excluded = source("provider", files, [contribution("alpha", { exclude: ["notes.md"] })])
  const exclusionChanged = await fixture([list([excluded]), list([excluded])]).resolve()
  expect(exclusionChanged.source_fingerprint).not.toBe(first.source_fingerprint)
  const refreshed = source(
    "provider",
    [file("alpha/SKILL.md", "new bytes")],
    [contribution("alpha")],
  )
  const contentChanged = await fixture([list([refreshed]), list([refreshed])]).resolve()
  expect(contentChanged.source_fingerprint).not.toBe(first.source_fingerprint)
})

test("current Source eligibility and revision validation cannot fall back to projection descriptors", async () => {
  const disabled = source("provider", [file("SKILL.md")])
  disabled.properties[fieldId("Enabled")] = {
    id: fieldId("Enabled"),
    type: "checkbox",
    checkbox: false,
  }
  await expect(fixture([list([disabled]), list([disabled])]).resolve()).rejects.toMatchObject({
    code: "SOURCE_DISABLED",
  })
  const changed = source("provider", [file("SKILL.md")])
  changed.properties[fieldId("Last Revision")] = rich("Last Revision", "f".repeat(64))
  await expect(fixture([list([changed]), list([changed])]).resolve()).rejects.toMatchObject({
    code: "SHARED_SOURCE_CONFLICT",
  })
})

test("management can exclude its applying Source and retain another Source's complete supporting tree", async () => {
  const replacing = source("replacing", [file("SKILL.md"), file("old.txt")])
  replacing.properties[fieldId("Status")] = selection("Status", "applying")
  replacing.properties[fieldId("Operation")] = rich("Operation", "source-replacement")
  const other = source(
    "other",
    [file("lib/helper.py", "print(1)", "100755"), file("lib/tests/data.bin", "\0fixture")],
    [contribution("lib", { mount_path: "support" })],
    id(23),
  )
  const f = fixture([list([replacing, other]), list([other])])
  const result = await f.resolveSources(["replacing"])
  expect(result.files.map((file) => file.path)).toEqual([
    "support/helper.py",
    "support/tests/data.bin",
  ])
  expect(result.files[0]?.content).toMatchObject({
    kind: "source",
    source_id: "other",
    source_path: "lib/helper.py",
    mode: "100755",
  })
  expect([...result.sources.keys()]).toEqual(["other"])
  expect(property(f.calls[1]?.body).filter).toEqual({
    property: fieldId("Source ID"),
    rich_text: { equals: "other" },
  })
  const ordinary = fixture([list([replacing, other]), list([other, replacing])])
  await expect(ordinary.resolve()).rejects.toMatchObject({ code: "CURRENT_SOURCE_NOT_READY" })
  other.properties[fieldId("Status")] = selection("Status", "applying")
  other.properties[fieldId("Operation")] = rich("Operation", "other-operation")
  await expect(
    fixture([list([replacing, other]), list([other])]).resolveSources(["replacing"]),
  ).rejects.toMatchObject({ code: "CURRENT_SOURCE_NOT_READY" })
})
