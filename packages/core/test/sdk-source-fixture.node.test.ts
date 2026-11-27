import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { expect, test, vi } from "vitest"
import { Effect } from "effect"
import { Notion } from "../src/notion.ts"
import { sharedRecordFromPage } from "../src/shared-content.ts"
import { readCurrentSkillMetadata } from "../src/shared-current-index.ts"
import { querySharedSkillRelation } from "../src/shared-router-members.ts"
import { parseMaterializationRegistration } from "../src/shared-source-materialization-registration.ts"

// The verification fixture is deliberately standalone JavaScript, shared by the
// installed SDK smoke and the actual Pi driver without importing product state.
const helperUrl = new URL("../../../scripts/sdk-source-fixture.mjs", import.meta.url)
const {
  startSdkSourceFixture,
  startSdkGitFixture,
  materializationServiceFacts,
  stageSdkManagerTools,
} = await import(helperUrl.href)
type Source = Awaited<ReturnType<typeof startSdkSourceFixture>>

function sample() {
  const main = { id: "selected", properties: {}, revision: "initial" }
  const refreshed = { ...main, revision: "refreshed" }
  return {
    notion: {
      library: {
        version: 2,
        library_id: "library-root",
        operation_id: "library-independent-fixture",
        skills: { database_id: "skills-db", data_source_id: "skills" },
        files: { database_id: "files-db", data_source_id: "files" },
        records: { database_id: "records-db", data_source_id: "records" },
        sources: { database_id: "sources-db", data_source_id: "sources" },
      },
      main,
      skills: [main],
      refreshed_main: refreshed,
      refreshed_skills: [refreshed],
      root: { object: "page", id: "library-root", parent: { type: "page_id", page_id: "outer" } },
      root_children: ["skills", "files", "records", "sources"].map((role) => ({
        object: "block",
        id: role + "-db",
        type: "child_database",
        child_database: { title: role },
      })),
      databases: ["skills", "files", "records", "sources"].map((role) => ({
        object: "database",
        id: role + "-db",
        parent: { type: "page_id", page_id: "library-root" },
        data_sources: [{ id: role }],
      })),
      data_sources: ["skills", "files", "records", "sources"].map((role) => ({
        object: "data_source",
        id: role,
        parent: { type: "database_id", database_id: role + "-db" },
        properties: {},
      })),
      files: [],
      records: [],
      sources: [],
      bodies: { selected: "完整正文\n".repeat(20) },
    },
    view_dynamics: {
      view: { id: "default-view" },
      tags_property_id: "tags",
      observations: [
        {
          id: "initial",
          query_id: "initial-query",
          tags: [],
          filter: { property: "tags", multi_select: { contains: "Default Context" } },
          member_page_ids: ["selected"],
        },
      ],
    },
  }
}

async function withSource(use: (source: Source) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "sdk-source-fixture-"))
  const source = await startSdkSourceFixture(sample(), join(directory, "requests.jsonl"))
  try {
    await use(source)
  } finally {
    await source.close()
    // Retain the actual ledger before the caller's owned TMPDIR is retired by
    // the existing verification cleanup; a failed assertion keeps its evidence.
    console.info(JSON.stringify({ controlledSourceEvidence: directory }))
  }
}

async function settled(source: Source, count: number) {
  await vi.waitFor(() => {
    expect(source.requests).toHaveLength(count)
    for (const row of source.requests) expect(row.closed_monotonic_ns).not.toBeNull()
  })
}

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")

test("fixed manager fixtures bind private tools to the exact selected executable bytes", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sdk-manager-tools-")))
  const execute = promisify(execFile)
  const probe = await execute("/bin/sh", ["-c", "command -v git"], {
    env: { PATH: process.env.PATH },
  })
  const tools = await stageSdkManagerTools(join(directory, "tools"), {
    node: process.execPath,
    git: probe.stdout.trim(),
  })
  for (const role of ["node", "git"] as const) {
    const tool = tools[role]
    expect(tool.path).not.toBe(tool.source)
    expect(tool.sha256).toBe(tool.source_sha256)
    expect(sha256(await readFile(tool.path))).toBe(sha256(await readFile(tool.source)))
    expect((await lstat(tool.path)).uid).toBe(process.getuid?.())
    expect((await lstat(tool.path)).mode & 0o777).toBe(0o500)
    expect((await execute(tool.path, ["--version"])).stdout).toBe(
      (await execute(tool.source, ["--version"])).stdout,
    )
  }
  expect((await execute(tools.git.path, ["--exec-path"])).stdout).toBe(
    (await execute(tools.git.source, ["--exec-path"])).stdout,
  )
  await expect(
    stageSdkManagerTools(tools.root, { node: process.execPath, git: probe.stdout.trim() }),
  ).rejects.toMatchObject({ code: "EEXIST" })
  console.info(JSON.stringify({ controlledManagerToolsEvidence: directory }))
})

test("materialization facts preserve two missing-owner initial states and an untouched legacy sibling", () => {
  const base = sample()
  const skills = [
    "Name",
    "Description",
    "Skill ID",
    "Main File ID",
    "Content",
    "Current State",
    "Origin",
    "Requires",
    "Members",
    "Enabled",
    "Default Context",
  ]
  const sources = [
    "Name",
    "Source ID",
    "Description",
    "Provider",
    "Location",
    "Ref",
    "Selection",
    "Options",
    "Contributions",
    "Content",
    "Last Revision",
    "Operation",
    "Policy",
    "Status",
    "Enabled",
    "Skills",
    "Records",
  ]
  const identities = (names: string[]) =>
    Object.fromEntries(names.map((name) => [name, name.toLowerCase().replaceAll(" ", "-")]))
  const members = ["root", "required", "sibling"].map((name) => {
    const content = `# ${name} complete original\n`
    return {
      member_key: "skills/" + name,
      name,
      description: "Complete " + name,
      legacy_skill_id: "old-" + name,
      legacy_page_id: "old-page-" + name,
      legacy_main_file_id: "old-main-" + name,
      files: [
        {
          path: "SKILL.md",
          source_path: "skills/" + name + "/SKILL.md",
          git_oid: "c".repeat(40),
          sha256: sha256(Buffer.from(content)),
          bytes: Buffer.byteLength(content),
          mode: "100644",
          encoding: "utf8",
          content,
        },
      ],
    }
  })
  const fixture = {
    ...base,
    notion: {
      ...base.notion,
      library: {
        ...base.notion.library,
        skills: { ...base.notion.library.skills, property_ids: identities(skills) },
        sources: { ...base.notion.library.sources, property_ids: identities(sources) },
      },
    },
    source_materialization: {
      version: 1,
      source_id: "source-test",
      source_page_id: "registered-source",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      members,
    },
  }
  const original = structuredClone(fixture)
  const legacy = materializationServiceFacts(
    fixture,
    "http://127.0.0.1:43210/upstream.git",
    "legacy-members",
  )
  const root = legacy.sample.notion.skills.find((row: { id: string }) => row.id === "old-page-root")
  expect(root.properties.Content).toBeUndefined()
  expect(root.properties["Current State"]).toBeUndefined()
  expect(root.properties.Requires.relation).toEqual([{ id: "old-page-required" }])
  expect(root.properties.Members.relation).toEqual([{ id: "old-page-sibling" }])
  expect(legacy.expected.untouched_sibling.properties.Enabled.checkbox).toBe(true)
  expect(legacy.expected.untouched_sibling.properties.Content).toBeUndefined()
  expect(legacy.expected.untouched_sibling.properties["Current State"]).toBeUndefined()
  expect(legacy.contributions).toHaveLength(3)
  const onlySource = materializationServiceFacts(
    fixture,
    "http://127.0.0.1:43210/upstream.git",
    "source-only",
  )
  expect(onlySource.sample.notion.skills).toEqual(base.notion.skills)
  expect(onlySource.contributions).toEqual([])
  expect(onlySource.plan.base.source.files).toHaveLength(3)
  const legacySource = materializationServiceFacts(
    fixture,
    "http://127.0.0.1:43210/upstream.git",
    "legacy-source",
  )
  expect(legacySource.sample.notion.sources[0].properties.Status.select.name).toBe("applied")
  expect(
    legacySource.sample.notion.sources[0].properties["Last Revision"].rich_text[0].text.content,
  ).toBe(fixture.source_materialization.commit)
  expect(legacySource.sample.notion.sources[0].properties.Content.rich_text).toEqual([])
  expect(legacySource.sample.notion.sources[0].properties.Contributions.rich_text).toEqual([])
  expect(
    legacySource.sample.notion.skills.find((row: { id: string }) => row.id === "old-page-root")
      .properties["Source Member"].rich_text[0].text.content,
  ).toBe("skills/root")
  const growth = materializationServiceFacts(
    fixture,
    "http://127.0.0.1:43210/upstream.git",
    "manifest-growth",
  )
  expect(growth.contributions).toHaveLength(1)
  expect(growth.plan.base.source.files).toHaveLength(1)
  const descriptor = JSON.parse(
    growth.sample.notion.skills.find((row: { id: string }) => row.id === "old-page-root").properties
      .Content.rich_text[0].text.content,
  )
  expect(descriptor).toMatchObject({
    revision: growth.revision,
    source_id: "source-test",
    source_path: "skills/root/SKILL.md",
    bytes: Buffer.byteLength(members[0]!.files[0]!.content),
    mode: "100644",
  })
  const nativeInput = structuredClone(fixture)
  const nativeProperties: Record<string, unknown> = {
    Content: {
      id: "content",
      type: "rich_text",
      rich_text: [
        {
          plain_text: JSON.stringify({
            kind: "native",
            mode: "100644",
            frontmatter: "---\nname: native-root\n---\n\n",
          }),
        },
      ],
    },
    "Skill ID": { id: "skill-id", type: "rich_text", rich_text: [{ plain_text: "native-root" }] },
  }
  nativeInput.notion.main.properties = nativeProperties
  nativeInput.notion.skills[0] = nativeInput.notion.main
  const native = materializationServiceFacts(
    nativeInput,
    "http://127.0.0.1:43210/upstream.git",
    "native-root",
  )
  expect(native.native_root).toMatchObject({
    page_id: "selected",
    skill_id: "native-root",
    alias: "lazy-native-root",
  })
  expect(native.native_root.content).toBe(
    "---\nname: native-root\n---\n\n" + base.notion.bodies.selected,
  )
  expect(native.sample.notion.main.properties.Requires.relation).toEqual([{ id: "old-page-root" }])
  expect(native.sample.notion.main.properties.Members.relation).toEqual([
    { id: "old-page-sibling" },
  ])
  expect(native.contributions).toHaveLength(3)
  expect(fixture).toEqual(original)
})

test("the real materialization generator produces Source and relation facts accepted by production parsers", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sdk-materialization-parser-")))
  const output = join(directory, "fixture")
  const generated = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../../../scripts/sdk-fixture.ts", import.meta.url)),
      "--outdir",
      output,
      "--catalog",
      "--materialization",
    ],
    { env: process.env, timeout: 30_000 },
  )
  await writeFile(join(directory, "generator.stdout.log"), generated.stdout)
  await writeFile(join(directory, "generator.stderr.log"), generated.stderr)
  const sample = JSON.parse(await readFile(join(output, "fixture.json"), "utf8"))
  // Stay inside the 2000-codepoint Description limit while exceeding a single
  // 2000-UTF-16-unit rich-text fragment.
  const description = "完整说明 😀".repeat(300)
  sample.source_materialization.members[0].description = description
  for (const initial of [
    "source-only",
    "legacy-members",
    "legacy-source",
    "manifest-growth",
    "native-root",
  ]) {
    const facts = materializationServiceFacts(
      sample,
      "http://127.0.0.1:43210/upstream.git",
      initial,
    )
    const source = facts.sample.notion.sources.find(
      (row: { id: string }) => row.id === facts.source_page_id,
    )
    const registration = parseMaterializationRegistration(facts.sample.notion.library, source)
    expect(registration.definition.source_id).toBe(facts.source_id)
    expect(registration.state.state).toBe(initial === "legacy-source" ? "uninitialized" : "ready")
    if (initial !== "source-only") {
      const library = facts.sample.notion.library
      const metadataOnly = {
        request: () => Effect.die("Complete fixture metadata must not acquire member bodies."),
        version: Effect.succeed("2025-09-03"),
        credentialIdentity: Effect.succeed("fixture-relation-preflight"),
      }
      for (const member of facts.members) {
        const owner = facts.sample.notion.skills.find(
          (value: { id: string }) => value.id === member.legacy_page_id,
        )
        if (!owner) {
          expect(initial).toBe("manifest-growth")
          expect(member.member_key).toBe(facts.members[1].member_key)
          continue
        }
        const current = readCurrentSkillMetadata(library, owner.id, owner).pipe(
          Effect.provideService(Notion, metadataOnly),
        )
        if (initial === "manifest-growth" && member.member_key === facts.root.member_key) {
          expect(await Effect.runPromise(current)).toMatchObject({
            state: { state: "ready" },
            main: {
              file_id: member.legacy_main_file_id,
              content: { kind: "source", source_id: facts.source_id, revision: facts.revision },
            },
          })
        } else {
          expect(await Effect.runPromise(Effect.flip(current))).toMatchObject({
            code: "CURRENT_SCHEMA_REQUIRED",
          })
        }
      }
      const row = facts.sample.notion.skills.find(
        (value: { id: string }) =>
          value.id === (facts.native_root?.page_id ?? facts.root.legacy_page_id),
      )
      const record = sharedRecordFromPage(
        row,
        {
          alias: library.library_id,
          title: "",
          role: "content",
          database_id: library.skills.database_id,
          data_source_ids: [library.skills.data_source_id],
          shared_library: library,
        },
        library.skills.data_source_id,
      )
      const relation = (pages: readonly unknown[], field: "Members" | "Requires" = "Members") =>
        querySharedSkillRelation(library, {
          record,
          rawPage: row,
          field,
          inventory: {
            data_source_id: library.skills.data_source_id,
            complete: true,
            pages,
          },
        }).pipe(Effect.provideService(Notion, metadataOnly))
      const members = await Effect.runPromise(relation(facts.sample.notion.skills))
      expect(members.map((member) => member.metadata.page_id)).toEqual([
        facts.members[2].legacy_page_id,
      ])
      const required = await Effect.runPromise(relation(facts.sample.notion.skills, "Requires"))
      expect(required.map((member) => member.metadata.page_id)).toEqual(
        initial === "manifest-growth"
          ? []
          : [facts.members[initial === "native-root" ? 0 : 1].legacy_page_id],
      )
      expect(facts.expected.untouched_sibling.properties.Content).toBeUndefined()
      expect(facts.expected.untouched_sibling.properties["Current State"]).toBeUndefined()
      if (initial === "native-root") {
        expect(
          await Effect.runPromise(
            readCurrentSkillMetadata(library, row.id, row).pipe(
              Effect.provideService(Notion, metadataOnly),
            ),
          ),
        ).toMatchObject({ state: { state: "ready" }, main: { content: { kind: "native" } } })
      }
      const disabled = structuredClone(facts.sample.notion.skills)
      const sibling = disabled.find(
        (value: { id: string }) => value.id === facts.members[2].legacy_page_id,
      )
      sibling.properties.Enabled.checkbox = false
      expect(await Effect.runPromise(Effect.flip(relation(disabled)))).toMatchObject({
        code: "SHARED_ROUTER_MEMBER_UNAVAILABLE",
        details: {
          field: "Members",
          page_id: facts.members[2].legacy_page_id,
          reason: "disabled",
        },
      })
    }
    for (const row of [...facts.sample.notion.sources, ...facts.sample.notion.skills]) {
      for (const value of Object.values(row.properties) as Array<{
        rich_text?: Array<{ text?: { content?: string }; plain_text?: string }>
        title?: Array<{ text?: { content?: string }; plain_text?: string }>
      }>) {
        for (const fragment of value.rich_text ?? value.title ?? []) {
          const text = fragment.plain_text ?? fragment.text?.content ?? ""
          expect(text.length).toBeLessThanOrEqual(2000)
          expect(text).not.toMatch(/[\ud800-\udbff]$/u)
        }
      }
    }
    if (initial === "source-only") {
      const parts = source.properties.Content.rich_text
      expect(parts.length).toBeGreaterThan(1)
      expect(
        JSON.parse(parts.map((part: { text: { content: string } }) => part.text.content).join("")),
      ).toEqual({ version: 1, plan: facts.plan })
    }
    if (initial === "legacy-members") {
      const root = facts.sample.notion.skills.find(
        (row: { id: string }) => row.id === facts.members[0].legacy_page_id,
      )
      expect(
        root.properties.Description.rich_text
          .map((part: { text: { content: string } }) => part.text.content)
          .join(""),
      ).toBe(description)
    }
  }
  console.info(JSON.stringify({ controlledMaterializationParserEvidence: directory }))
})

test("Source contribution contains queries return complete candidates with normal pagination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk-source-contributions-"))
  const base = sample()
  const rows = ["demo", "demo-other", "unrelated"].map((skill, index) => ({
    id: "source-" + index,
    properties: {
      Contributions: {
        id: "contributions",
        type: "rich_text",
        rich_text: [
          {
            type: "text",
            text: {
              content: JSON.stringify([
                { member_key: ".", skill_id: skill, mount_path: "", mapping: {}, exclude: [] },
              ]),
            },
          },
        ],
      },
    },
  }))
  const source = await startSdkSourceFixture(
    { ...base, notion: { ...base.notion, sources: rows } },
    join(directory, "requests.jsonl"),
  )
  try {
    const query = async (cursor?: string) =>
      (
        await fetch(source.origin + "/v1/data_sources/sources/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            page_size: 1,
            filter: { property: "contributions", rich_text: { contains: "demo" } },
            ...(cursor === undefined ? {} : { start_cursor: cursor }),
          }),
        })
      ).json()
    const first = await query()
    expect(first.results.map((row: { id: string }) => row.id)).toEqual(["source-0"])
    expect(first.has_more).toBe(true)
    const second = await query(first.next_cursor)
    expect(second.results.map((row: { id: string }) => row.id)).toEqual(["source-1"])
    expect(second.has_more).toBe(false)
    expect(second.next_cursor).toBeNull()
    await settled(source, 2)
    expect(source.unexpected).toEqual([])
  } finally {
    await source.close()
  }
})

test("a declared empty default-view inventory is complete and bound to the selected database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk-source-empty-views-"))
  const base = sample()
  const source = await startSdkSourceFixture(
    { ...base, view_dynamics: undefined, empty_view_inventory: true },
    join(directory, "requests.jsonl"),
  )
  try {
    const response = await fetch(source.origin + "/v1/views?database_id=skills-db")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      object: "list",
      results: [],
      has_more: false,
      next_cursor: null,
    })
    expect(source.unexpected).toEqual([])
    const foreign = await fetch(source.origin + "/v1/views?database_id=foreign-db")
    expect(foreign.status).toBe(400)
    await foreign.arrayBuffer()
    expect(source.unexpected).toHaveLength(1)
  } finally {
    await source.close()
  }
})

test("Source pages remain readable without granting writes or a reading projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk-source-readonly-"))
  const base = sample()
  const row = { id: "registered-source", properties: {} }
  const source = await startSdkSourceFixture(
    { ...base, notion: { ...base.notion, sources: [row] } },
    join(directory, "requests.jsonl"),
  )
  try {
    expect(await (await fetch(source.origin + "/v1/pages/registered-source")).json()).toEqual(row)
    const denied = await fetch(source.origin + "/v1/pages/registered-source", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ properties: { status: { select: { name: "ready" } } } }),
    })
    expect(denied.status).toBe(400)
    await denied.arrayBuffer()
    expect(source.notion.sources).toEqual([row])
    await settled(source, 2)
    expect(
      source.requests.some((request: { semantic_write?: boolean }) => request.semantic_write),
    ).toBe(false)
  } finally {
    await source.close()
  }
})

test("a submitted Source PATCH may apply after its client disconnects without producing an ACK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk-source-late-write-"))
  const base = sample()
  const row = {
    id: "registered-source",
    properties: {
      revision: {
        id: "revision",
        type: "rich_text",
        rich_text: [{ text: { content: "before" } }],
      },
    },
  }
  const source = await startSdkSourceFixture(
    { ...base, notion: { ...base.notion, sources: [row] } },
    join(directory, "requests.jsonl"),
    { allowCurrentWrites: true, forbidProjectionWrites: true },
  )
  try {
    const held = source.holdNext({
      method: "PATCH",
      path: "/v1/pages/registered-source",
      afterHeaders: false,
      applyAfterDisconnect: true,
    })
    const controller = new AbortController()
    const pending = fetch(source.origin + "/v1/pages/registered-source", {
      method: "PATCH",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        properties: { revision: { rich_text: [{ text: { content: "after" } }] } },
      }),
    })
      .then((response) => response.json())
      .then(
        () => "completed",
        () => "cancelled",
      )
    await held.reached
    controller.abort()
    expect(await pending).toBe("cancelled")
    await vi.waitFor(() => expect(source.requests[0].closed_monotonic_ns).not.toBeNull())
    expect(source.notion.sources[0]).toEqual(row)
    held.release()
    const closed = await held.closed
    expect(closed).toMatchObject({
      semantic_write: true,
      status: null,
      terminal: "aborted",
      response_bytes_complete: false,
      observed_response_bytes: 0,
    })
    expect(source.notion.sources[0].properties.revision.rich_text[0].text.content).toBe("after")
    expect(source.unexpected).toEqual([])
    const events = (await readFile(source.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(events.some((event) => event.event === "late-application")).toBe(true)
    expect(
      source.requests.some((request: { projection_write?: boolean }) => request.projection_write),
    ).toBe(false)
  } finally {
    await source.close()
  }
})

test("materialization fixtures refuse projection attempts before changing generated bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk-source-no-projection-"))
  const source = await startSdkSourceFixture(sample(), join(directory, "requests.jsonl"), {
    allowCurrentWrites: true,
    forbidProjectionWrites: true,
  })
  try {
    const original = source.notion.bodies.selected
    const response = await fetch(source.origin + "/v1/pages/selected/markdown", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown_version: "v2",
        type: "replace_content",
        replace_content: { new_str: "unexpected projection" },
      }),
    })
    expect(response.status).toBe(400)
    await response.arrayBuffer()
    await settled(source, 1)
    expect(source.notion.bodies.selected).toBe(original)
    expect(source.requests[0]).toMatchObject({ projection_write: true })
    expect(source.requests[0].semantic_write).not.toBe(true)
    expect(source.unexpected[0].error).toContain("Reading projection is forbidden")
  } finally {
    await source.close()
  }
})

test("the Git fixture serves exact real commits to independent clones through HTTP", async () => {
  const run = promisify(execFile)
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sdk-source-real-git-")))
  const repository = join(directory, "upstream.git")
  await mkdir(repository)
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Controlled Git",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Controlled Git",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  }
  await run("git", ["init", "-b", "main", repository], { env })
  const body = "# Exact original\n\nNo shared consumer Store is required.\n"
  await writeFile(join(repository, "SKILL.md"), body)
  await run("git", ["-C", repository, "add", "SKILL.md"], { env })
  await run("git", ["-C", repository, "commit", "--no-gpg-sign", "-m", "controlled source"], {
    env,
  })
  const commit = (await run("git", ["-C", repository, "rev-parse", "HEAD"], { env })).stdout.trim()
  const source = await startSdkGitFixture(repository, join(directory, "git.jsonl"))
  try {
    for (const client of ["first-client", "second-client"]) {
      const target = join(directory, client)
      await run("git", ["clone", "--no-checkout", source.url, target], { env })
      expect((await run("git", ["-C", target, "show", commit + ":SKILL.md"], { env })).stdout).toBe(
        body,
      )
    }
    await vi.waitFor(() =>
      expect(
        source.requests.every((request: { exit_code: number | null }) => request.exit_code === 0),
      ).toBe(true),
    )
    expect(source.unexpected).toEqual([])
    expect(
      source.requests.filter((request: { method: string }) => request.method === "POST").length,
    ).toBeGreaterThanOrEqual(2)
  } finally {
    await source.close()
  }
})

test("schema routes retain independent physical facts when a descriptor claim changes", async () => {
  await withSource(async (source) => {
    source.notion.library.library_id = "copied-descriptor-root"
    source.notion.library.skills.database_id = "replacement-skills-db"
    const root = await (await fetch(source.origin + "/v1/pages/library-root")).json()
    const database = await (await fetch(source.origin + "/v1/databases/skills-db")).json()
    const dataSource = await (await fetch(source.origin + "/v1/data_sources/skills")).json()
    expect(root).toMatchObject({ id: "library-root", parent: { page_id: "outer" } })
    expect(database).toMatchObject({ id: "skills-db", parent: { page_id: "library-root" } })
    expect(dataSource).toMatchObject({ id: "skills", parent: { database_id: "skills-db" } })
    await settled(source, 3)
    expect(source.unexpected).toEqual([])
  })
})

test("complete responses bind actual bytes, phases, View metadata and fixed 401/403 routes", async () => {
  await withSource(async (source) => {
    const origin = source.origin
    const response = await fetch(origin + "/v1/views?database_id=skills-db")
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(JSON.parse(new TextDecoder().decode(bytes)).results).toEqual([
      { object: "view", id: "default-view" },
    ])
    await settled(source, 1)
    expect(source.requests[0]).toMatchObject({
      phase: "setup",
      status: 200,
      request_bytes: 0,
      request_bytes_complete: true,
      terminal: "finished",
      decoded_response_bytes: bytes.length,
      response_sha256: sha256(bytes),
      response_bytes_complete: true,
    })
    source.setPhase("refreshed", { current: "refreshed", denyCurrent: false })
    expect((await (await fetch(origin + "/v1/pages/selected")).json()).revision).toBe("refreshed")
    await settled(source, 2)
    source.setPhase("denied", { denyAuthentication: true, denyCurrent: true })
    for (const [path, status] of [
      ["/v1/users/me", 401],
      ["/v1/pages/selected", 403],
      ["/v1/pages/selected/markdown", 403],
    ] as const) {
      const denied = await fetch(origin + path)
      const payload = await denied.json()
      expect(denied.status).toBe(status)
      expect(payload.code).toBe(status === 401 ? "unauthorized" : "restricted_resource")
    }
    await settled(source, 5)
    source.setPhase("recovered", { denyAuthentication: false, denyCurrent: false })
    expect((await (await fetch(origin + "/v1/pages/selected")).json()).revision).toBe("refreshed")
    expect((await (await fetch(origin + "/v1/pages/selected/markdown")).json()).markdown).toBe(
      sample().notion.bodies.selected,
    )
    await settled(source, 7)
    expect(source.origin).toBe(origin)
    expect(source.unexpected).toEqual([])
    const rows = (await readFile(source.ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(rows.map((row) => row.phase)).toEqual([
      "setup",
      "refreshed",
      "denied",
      "denied",
      "denied",
      "recovered",
      "recovered",
    ])
    expect(rows.every((row) => row.response_bytes_complete)).toBe(true)
  })
})

test("a held Default View request reaches the server before any response and completes only after release", async () => {
  await withSource(async (source) => {
    const hold = source.holdNext({ method: "GET", path: "/v1/views", afterHeaders: false })
    let received = false
    const pending = fetch(source.origin + "/v1/views?database_id=skills-db").then(
      async (response) => {
        received = true
        return response.json()
      },
    )
    const reached = await hold.reached
    expect(received).toBe(false)
    expect(reached).toMatchObject({ terminal: "pending", status: null, observed_response_bytes: 0 })
    expect(() => source.setPhase("too-early")).toThrow("all prior HTTP calls close")
    hold.release()
    expect((await pending).results).toHaveLength(1)
    expect(await hold.closed).toMatchObject({ terminal: "finished", response_bytes_complete: true })
    source.setPhase("next")
  })
})

test("client abort after response headers retains partial bytes but never claims a complete body", async () => {
  await withSource(async (source) => {
    const hold = source.holdNext({
      method: "GET",
      path: "/v1/pages/selected/markdown",
      afterHeaders: true,
    })
    const controller = new AbortController()
    const result = fetch(source.origin + "/v1/pages/selected/markdown", {
      signal: controller.signal,
    })
      .then((response) => response.text())
      .then(
        (body) => ({ body, error: null }),
        (error: unknown) => ({ body: null, error }),
      )
    const reached = await hold.reached
    expect(reached).toMatchObject({
      status: 200,
      observed_response_bytes: 32,
      response_bytes_complete: false,
    })
    controller.abort()
    expect((await result).error).not.toBeNull()
    const closed = await hold.closed
    expect(closed).toMatchObject({
      terminal: "aborted",
      decoded_response_bytes: null,
      response_sha256: null,
      response_bytes_complete: false,
      observed_response_bytes: 32,
    })
    expect(source.unexpected).toEqual([])
    const events = (await readFile(source.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(["start", "headers", "end", "close"]),
    )
  })
})

test("one 429 and one interrupted stream affect actual HTTP attempts only, then normal reads recover", async () => {
  await withSource(async (source) => {
    const limited = source.rejectNext({
      method: "GET",
      path: "/v1/users/me",
      status: 429,
      retryAfterSeconds: 0.1,
    })
    const response = await fetch(source.origin + "/v1/users/me")
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("0.1")
    await response.arrayBuffer()
    expect(await limited.closed).toMatchObject({ status: 429, terminal: "finished" })
    const recovered = await fetch(source.origin + "/v1/users/me")
    expect(recovered.status).toBe(200)
    await recovered.arrayBuffer()
    await settled(source, 2)
    const interrupted = source.interruptNext({ method: "GET", path: "/v1/pages/selected/markdown" })
    const failed = await fetch(source.origin + "/v1/pages/selected/markdown")
      .then((reply) => reply.text())
      .then(
        () => false,
        () => true,
      )
    expect(failed).toBe(true)
    expect(await interrupted.closed).toMatchObject({
      terminal: "aborted",
      decoded_response_bytes: null,
      response_bytes_complete: false,
      observed_response_bytes: 32,
    })
    const final = await fetch(source.origin + "/v1/pages/selected/markdown")
    expect((await final.json()).markdown).toBe(sample().notion.bodies.selected)
    await settled(source, 4)
    expect(source.unexpected).toEqual([])
  })
})

test("aborting an incomplete request cannot create fictional response bytes", async () => {
  await withSource(async (source) => {
    let received = false
    const client = request(
      source.origin + "/v1/data_sources/skills/query",
      {
        method: "POST",
        headers: { "content-length": "128", "content-type": "application/json" },
      },
      () => {
        received = true
      },
    )
    client.on("error", () => {})
    const closed = new Promise<void>((resolve) => client.once("close", resolve))
    client.write('{"page_size":')
    await vi.waitFor(() => expect(source.requests).toHaveLength(1))
    client.destroy()
    await closed
    await settled(source, 1)
    expect(received).toBe(false)
    expect(source.requests[0]).toMatchObject({
      terminal: "aborted",
      request_bytes: null,
      request_bytes_complete: false,
      decoded_response_bytes: null,
      response_bytes_complete: false,
      observed_response_bytes: 0,
    })
    expect(source.requests[0].observed_request_bytes).toBeGreaterThan(0)
    expect(source.unexpected).toEqual([])
  })
})

test("unknown routes and unselected bodies are rejected, and unused controls close without hanging", async () => {
  await withSource(async (source) => {
    expect(() => source.holdNext({ method: "GET", path: "/undeclared" })).toThrow(
      "exact declared route",
    )
    for (const path of ["/undeclared", "/v1/pages/unselected/markdown"]) {
      const response = await fetch(source.origin + path)
      expect(response.status).toBe(400)
      expect((await response.json()).code).toBe("validation_error")
    }
    await settled(source, 2)
    expect(source.unexpected).toHaveLength(2)
    const unused = source.holdNext({ method: "GET", path: "/v1/users/me" })
    source.setPhase("next")
    expect(await unused.reached).toBeNull()
    expect(await unused.closed).toBeNull()
    const closing = source.close()
    expect(source.close()).toBe(closing)
    await closing
  })
})
