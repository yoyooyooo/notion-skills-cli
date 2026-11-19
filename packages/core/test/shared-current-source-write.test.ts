import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { unzipSync } from "fflate"
import { exportSkill } from "../src/export.ts"
import { trashPath } from "../src/local-locks.ts"
import { property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { currentOwnedResourceCreateRequest } from "../src/shared-current-records.ts"
import {
  prepareCurrentSharedResource,
  readCurrentSharedResourceBytes,
} from "../src/shared-current-resource.ts"
import { queryCurrentSkillIndex, type CurrentSkillIndex } from "../src/shared-current-index.ts"
import {
  prepareCurrentSourceFromDiscovery,
  type CurrentSourceDeclaration,
} from "../src/shared-current-source-input.ts"
import { queryCurrentSourceManagement } from "../src/shared-current-source-management.ts"
import { prepareCurrentSharedSourceContent } from "../src/shared-current-source.ts"
import { writePreparedCurrentSource } from "../src/shared-current-source-write.ts"
import { prepareCurrentSkillWrite, writeCurrentSkill } from "../src/shared-current-write.ts"
import { readSkill } from "../src/snapshot.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"
import {
  currentWriteFixture,
  id,
  library,
  testBytes,
  type CurrentWriteCall,
} from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-source-write-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
const firstCommit = "a".repeat(40),
  secondCommit = "c".repeat(40)
const gitOid = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
const declaration: CurrentSourceDeclaration = {
  version: 1,
  definition: {
    version: 1,
    source_id: "team-skills",
    name: "Team skills",
    description: "Exact current Git files",
    enabled: true,
    policy: "manual",
    adapter: { type: "git", url: "https://github.com/example/skills", ref: "main" },
    selection: { roots: ["skills"], include: [], exclude: [], mapping: {} },
    options: {},
  },
  contributions: [
    {
      member_key: "skills/alpha",
      skill_id: "skill-alpha",
      mount_path: "",
      mapping: {},
      exclude: [],
    },
    {
      member_key: "skills/beta",
      skill_id: "skill-beta",
      mount_path: "vendor",
      mapping: {},
      exclude: [],
    },
  ],
}
const font = new Uint8Array([119, 79, 70, 70, 0, 255, 1]),
  localBytes = testBytes('{"owned":"Notion"}\n'),
  nativeHeader = "---\nname: Human\ndescription: Editable current main\n---\n",
  originalBody = "# Human main\n\nKeep this authoring surface.\n"

function observation(commit = firstCommit): SourceSnapshot {
  const version = commit === firstCommit ? "one" : "two"
  return {
    revision: commit,
    provenance: {
      provider: "git",
      git_url:
        declaration.definition.adapter.type === "git" ? declaration.definition.adapter.url : "",
      resolved_ref: commit,
    },
    members: ["alpha", "beta"].map((name) => {
      const root = `skills/${name}`,
        files = [
          {
            path: "SKILL.md",
            bytes: testBytes(
              `---\nname: ${name}\ndescription: Current ${name} files\n---\n# ${name}\n\nComplete source document.\n`,
            ),
            mode: "100644" as const,
          },
          ...(name === "alpha"
            ? [
                {
                  path: "run.sh",
                  bytes: testBytes(`#!/bin/sh\necho ${version}\n`),
                  mode: "100755" as const,
                },
                {
                  path: "notes.md",
                  bytes: testBytes("# Removable source note\n"),
                  mode: "100644" as const,
                },
                { path: "font.woff", bytes: font, mode: "100644" as const },
              ]
            : [
                {
                  path: "guide.md",
                  bytes: testBytes(`# Source guide ${version}\n\nEvery line is readable.\n`),
                  mode: "100644" as const,
                },
              ]),
        ]
      return {
        member_key: root,
        source_path: root,
        portable: {
          kind: "skill" as const,
          name,
          description: `Current ${name} files`,
          main: "SKILL.md",
          files,
        },
        upstream_hash: "d".repeat(64),
        content_hash: "e".repeat(64),
        git_manifest: {
          commit,
          tree: (commit === firstCommit ? "b" : "d").repeat(40),
          root,
          files: files.map((file) => ({
            path: file.path,
            source_path: `${root}/${file.path}`,
            git_oid: gitOid(file.bytes),
            bytes: file.bytes.byteLength,
            mode: file.mode,
          })),
        },
      }
    }),
  }
}

/** Only provider transport is controlled; the coordinator, owner kernel, uploads,
 * normal reader and projection writer all execute their production paths. */
function provider(observations: readonly SourceSnapshot[]) {
  const bodies = new Map<string, Uint8Array>(),
    requests: string[] = []
  for (const snapshot of observations)
    for (const member of snapshot.members)
      for (const file of member.portable.files)
        bodies.set(
          `https://raw.githubusercontent.com/example/skills/${snapshot.revision}/${member.member_key}/${file.path}`,
          file.bytes,
        )
  const use = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const original = yield* HttpClient.HttpClient
      const client = HttpClient.make((request) => {
        const bytes = bodies.get(request.url)
        if (bytes === undefined) return original.execute(request)
        requests.push(request.url)
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(new Uint8Array(bytes), {
              headers: { "content-length": String(bytes.byteLength) },
            }),
          ),
        )
      })
      return yield* effect.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      )
    })
  return { use, requests }
}
const pendingKeys = (f: ReturnType<typeof currentWriteFixture>) =>
  [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/"))
const operationRecords = (f: ReturnType<typeof currentWriteFixture>) =>
  f
    .table("records")
    .filter((row) => property(property(property(row.properties).kind).select).name === "operation")
const fieldText = (row: unknown, field: string) =>
  text(property(property(property(row).properties)[field]).rich_text)
const sameRequest = (call: CurrentWriteCall, expected: CurrentWriteCall) =>
  call.path === expected.path &&
  call.method === expected.method &&
  JSON.stringify(call.body) === JSON.stringify(expected.body)
const allFiles = (index: CurrentSkillIndex) => [index.main, ...index.files]
async function seedNative(f: ReturnType<typeof currentWriteFixture>) {
  const plan = await f.run(
    prepareCurrentSkillWrite({
      skill_id: "skill-beta",
      name: "Human",
      description: "Editable current main",
      kind: "skill",
      files: [
        {
          path: "SKILL.md",
          file_id: "human-main",
          bytes: testBytes(nativeHeader + originalBody),
          authority: { kind: "native" },
        },
        { path: "local.json", file_id: "human-resource", bytes: localBytes },
      ],
    }),
  )
  return f.run(writeCurrentSkill(library, { plan, operation_id: "seed-native" }))
}
async function assertReady(f: ReturnType<typeof currentWriteFixture>) {
  const source = await f.run(queryCurrentSourceManagement(library, "team-skills"))
  expect(source?.state).toEqual({ state: "ready" })
  expect(fieldText(f.pages.get(source!.page_id), library.sources.property_ids.Operation!)).toBe("")
  for (const row of f.table("skills")) {
    expect((await f.run(queryCurrentSkillIndex(library, String(row.id)))).state).toEqual({
      state: "ready",
    })
    expect(fieldText(row, library.skills.property_ids.Operation!)).toBe("")
  }
  expect(pendingKeys(f)).toEqual([])
  expect(operationRecords(f)).toEqual([])
}

test("one Source writes two current Skills, preserves native authorship and resource bytes, and refreshes/excludes/renames without new identities", async () => {
  const f = currentWriteFixture(parent),
    native = await seedNative(f),
    observed = observation(),
    refreshed = observation(secondCommit),
    http = provider([observed, refreshed]),
    prepared = await f.run(prepareCurrentSourceFromDiscovery(declaration, observed))
  f.clearCalls()
  if (prepared.plan.base?.kind !== "git") throw new Error("Expected the fixed Git Source")
  const base = prepared.plan.base.source
  for (const forged of [
    {
      operation: "forged-git-oid",
      source: {
        ...base,
        files: base.files.map((file, index) =>
          index === 0 ? { ...file, git_oid: "f".repeat(40) } : file,
        ),
      },
      message: "Prepared Source bytes or contribution bindings changed.",
    },
    {
      operation: "forged-root",
      source: {
        ...base,
        root: "elsewhere",
        files: base.files.map((file) => ({ ...file, source_path: `elsewhere/${file.path}` })),
      },
      message: "The prepared Source differs from its declaration or commit.",
    },
  ]) {
    const plan = { ...prepared.plan, base: { kind: "git" as const, source: forged.source } },
      content = await f.run(prepareCurrentSharedSourceContent(plan))
    await expect(
      f.run(
        writePreparedCurrentSource(library, {
          prepared: {
            ...prepared,
            plan,
            prepared_source: content,
            targets: prepared.targets.map((target) => ({
              ...target,
              files: target.files.map((file) => ({
                ...file,
                authority: { ...file.authority, revision: content.revision },
              })),
            })),
          },
          operation_id: forged.operation,
          dry_run: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_SOURCE_WRITE_CONFLICT", message: forged.message })
    expect(f.calls).toEqual([])
    expect(pendingKeys(f)).toEqual([])
  }
  const result = await f.run(
    http.use(writePreparedCurrentSource(library, { prepared, operation_id: "source-create" })),
  )
  expect(result).toMatchObject({
    status: "applied",
    state: "ready",
    library: {
      library_id: library.library_id,
      database_id: library.skills.database_id,
      data_source_id: library.skills.data_source_id,
    },
    source_id: "team-skills",
    operation_id: "source-create",
    affected_skill_ids: ["skill-alpha", "skill-beta"],
  })
  await assertReady(f)
  expect(f.table("sources")).toHaveLength(1)
  expect(f.table("skills")).toHaveLength(2)
  const alphaPage = String(
      f
        .table("skills")
        .find((row) => fieldText(row, library.skills.property_ids["Skill ID"]!) === "skill-alpha")!
        .id,
    ),
    alpha = await f.run(queryCurrentSkillIndex(library, alphaPage)),
    beta = await f.run(queryCurrentSkillIndex(library, native.page_id))
  expect(beta.main).toMatchObject({ file_id: "human-main", content: { kind: "native" } })
  expect(beta).toMatchObject({ name: "Human", description: "Editable current main" })
  expect(beta.files.find((file) => file.path === "local.json")).toMatchObject({
    file_id: "human-resource",
    content: { kind: "resource" },
  })
  expect(
    beta.files
      .filter((file) => file.content.kind === "source")
      .map((file) => file.path)
      .sort(),
  ).toEqual(["vendor/SKILL.md", "vendor/guide.md"])
  expect(
    f.calls.filter(
      (call) => call.method === "PATCH" && call.path === `v1/pages/${native.page_id}/markdown`,
    ),
  ).toEqual([])
  const alphaMain = observed.members[0]!.portable.files[0]!.bytes
  expect(
    await f.run(
      http.use(readSkill(alphaPage, { database: library.skills.database_id, refresh: true })),
    ),
  ).toMatchObject({ content: new TextDecoder().decode(alphaMain) })
  expect(
    await f.run(
      http.use(
        readSkill(native.page_id, {
          database: library.skills.database_id,
          path: "vendor/guide.md",
          refresh: true,
        }),
      ),
    ),
  ).toMatchObject({ content: "# Source guide one\n\nEvery line is readable.\n" })
  const runFile = alpha.files.find((file) => file.path === "run.sh")!,
    binary = alpha.files.find((file) => file.path === "font.woff")!
  expect(binary.content).toMatchObject({
    kind: "source",
    source_id: "team-skills",
    source_path: "skills/alpha/font.woff",
  })
  expect(
    (f.blocks.get(runFile.page_id) ?? [])
      .map((block) => text(property(block.code).rich_text))
      .join(""),
  ).toContain("#!/bin/sh\necho one\n")
  const attachment = (f.blocks.get(binary.page_id) ?? []).find((block) => block.type === "file")!,
    originalUrl = String(property(property(attachment.file).file).url)
  expect(property(attachment.file).name).toBe("font.woff.zip")
  const downloaded = await f.run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.get(originalUrl)
      return new Uint8Array(yield* response.arrayBuffer)
    }),
  )
  expect(unzipSync(downloaded)["font.woff"]).toEqual(font)
  const output = join(f.root, "exported-alpha")
  await f.run(
    http.use(
      exportSkill(alphaPage, { database: library.skills.database_id, output, format: "directory" }),
    ),
  )
  for (const file of observed.members[0]!.portable.files) {
    expect(new Uint8Array(readFileSync(join(output, file.path)))).toEqual(
      new Uint8Array(file.bytes),
    )
    expect((statSync(join(output, file.path)).mode & 0o111) !== 0).toBe(file.mode === "100755")
  }
  expect(http.requests.length).toBeGreaterThan(0)
  f.clearCalls()
  expect(
    await f.run(
      http.use(writePreparedCurrentSource(library, { prepared, operation_id: "source-noop" })),
    ),
  ).toMatchObject({ status: "unchanged", input_sha256: result.input_sha256 })
  expect(f.mutations()).toEqual([])
  const humanBody = "# Human edited after import\n\nThis remains the authoring content.\n"
  await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        `v1/pages/${native.page_id}/markdown`,
        { type: "replace_content", replace_content: { new_str: humanBody } },
        { method: "PATCH" },
      ),
    ),
  )
  f.clearCalls()
  const updated = await f.run(prepareCurrentSourceFromDiscovery(declaration, refreshed))
  await f.run(
    http.use(
      writePreparedCurrentSource(library, { prepared: updated, operation_id: "source-refresh" }),
    ),
  )
  expect(
    f.calls.filter(
      (call) => call.method === "PATCH" && call.path === `v1/pages/${native.page_id}/markdown`,
    ),
  ).toEqual([])
  expect(
    await f.run(
      http.use(readSkill(native.page_id, { database: library.skills.database_id, refresh: true })),
    ),
  ).toMatchObject({ content: nativeHeader + humanBody })
  expect(
    await f.run(
      http.use(
        readSkill(native.page_id, { database: library.skills.database_id, path: "local.json" }),
      ),
    ),
  ).toMatchObject({ content: new TextDecoder().decode(localBytes) })
  const renamedDeclaration = {
      ...declaration,
      contributions: declaration.contributions.map((entry) =>
        entry.skill_id === "skill-alpha"
          ? { ...entry, mapping: { "run.sh": "scripts/start.sh" }, exclude: ["notes.md"] }
          : entry,
      ),
    },
    renamed = await f.run(prepareCurrentSourceFromDiscovery(renamedDeclaration, refreshed))
  await f.run(
    http.use(
      writePreparedCurrentSource(library, { prepared: renamed, operation_id: "source-mapping" }),
    ),
  )
  const final = await f.run(queryCurrentSkillIndex(library, alphaPage))
  expect(final.files.find((file) => file.path === "scripts/start.sh")).toMatchObject({
    file_id: runFile.file_id,
    page_id: runFile.page_id,
    content: {
      kind: "source",
      source_path: "skills/alpha/run.sh",
      revision: updated.prepared_source.revision,
    },
  })
  expect(allFiles(final).some((file) => file.path === "notes.md")).toBe(false)
  const source = await f.run(queryCurrentSourceManagement(library, "team-skills"))
  expect(source?.declaration.contributions[0]).toMatchObject({
    mapping: { "run.sh": "scripts/start.sh" },
    exclude: ["notes.md"],
  })
  expect(source?.declaration.definition.selection.exclude).toEqual([])
  await assertReady(f)
})

test.each(["source-properties", "source-ready", "source-retirement"] as const)(
  "accepted unknown %s resumes the parent operation and clears ready/retiring state without replay",
  async (kind) => {
    const f = currentWriteFixture(parent)
    await seedNative(f)
    const first = observation(),
      second = observation(secondCommit),
      http = provider([first, second]),
      prepared = await f.run(prepareCurrentSourceFromDiscovery(declaration, first))
    await f.run(
      http.use(writePreparedCurrentSource(library, { prepared, operation_id: "seed-source" })),
    )
    const updated = await f.run(prepareCurrentSourceFromDiscovery(declaration, second)),
      operation = `lost-${kind}`
    f.clearCalls()
    f.failNext({ kind, outcome: "accepted" })
    await expect(
      f.run(
        http.use(
          writePreparedCurrentSource(library, { prepared: updated, operation_id: operation }),
        ),
      ),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN", details: { operation_id: operation } })
    const original = f.calls.findLast(
      (call) =>
        call.method === "PATCH" &&
        (kind === "source-properties"
          ? "content" in property(property(call.body).properties)
          : kind === "source-ready"
            ? property(property(property(property(call.body).properties).status).select).name ===
              "ready"
            : property(call.body).in_trash === true &&
              fieldText(
                f.pages.get(call.path.split("/").at(-1)!),
                library.records.property_ids["Entity ID"]!,
              ) === "current-source:team-skills"),
    )!
    expect(original).toBeDefined()
    expect(pendingKeys(f).length).toBeGreaterThan(0)
    if (kind === "source-retirement") {
      expect(operationRecords(f)).toEqual([])
      expect(pendingKeys(f)).toHaveLength(1)
      expect(property(property(f.json.get(pendingKeys(f)[0]!)).lifecycle).phase).toBe("retiring")
    }
    const resumedFrom = f.calls.length
    const resumed = await f.run(
      http.use(
        writePreparedCurrentSource(library, {
          prepared: updated,
          operation_id: operation,
          mode: "resume",
        }),
      ),
    )
    expect(resumed.operation_id).toBe(operation)
    expect(f.calls.filter((call) => sameRequest(call, original))).toHaveLength(1)
    if (kind === "source-retirement") {
      expect(
        f.calls
          .slice(resumedFrom)
          .some((call) => call.method === "GET" && call.path === original.path),
      ).toBe(true)
      expect(
        f.calls
          .slice(resumedFrom)
          .filter((call) => call.method !== "GET" && !call.path.includes("/query")),
      ).toEqual([])
    }
    await assertReady(f)
  },
)

test("a child projection unknown resumes through its Source intent while a preserved native body changes", async () => {
  const f = currentWriteFixture(parent),
    native = await seedNative(f),
    observed = observation(),
    http = provider([observed]),
    prepared = await f.run(prepareCurrentSourceFromDiscovery(declaration, observed)),
    operation = "source-child-lost"
  f.clearCalls()
  f.failNext({ kind: "append", outcome: "accepted" })
  await expect(
    f.run(http.use(writePreparedCurrentSource(library, { prepared, operation_id: operation }))),
  ).rejects.toMatchObject({
    code: "WRITE_OUTCOME_UNKNOWN",
    details: {
      operation_id: operation,
      source_id: "team-skills",
      required_input: "Resupply the original Source declaration with --operation and --resume.",
    },
  })
  const original = f.calls.findLast(
    (call) => call.method === "PATCH" && call.path.endsWith("/children"),
  )!
  expect(pendingKeys(f)).toHaveLength(2)
  const current = await f.run(queryCurrentSourceManagement(library, "team-skills"))
  expect(current?.state.state).not.toBe("ready")
  const beforeSecond = await f.run(queryCurrentSkillIndex(library, native.page_id))
  expect(beforeSecond.state).toEqual({ state: "ready" })
  expect(beforeSecond.files.filter((file) => file.content.kind === "source")).toEqual([])
  const humanBody = "# Written while Source is pending\n\nKeep this newest body.\n"
  await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        `v1/pages/${native.page_id}/markdown`,
        { type: "replace_content", replace_content: { new_str: humanBody } },
        { method: "PATCH" },
      ),
    ),
  )
  const start = f.calls.length
  expect(
    await f.run(
      http.use(
        writePreparedCurrentSource(library, { prepared, operation_id: operation, mode: "resume" }),
      ),
    ),
  ).toMatchObject({ operation_id: operation })
  expect(
    f.calls
      .slice(start)
      .filter(
        (call) => call.method === "PATCH" && call.path === `v1/pages/${native.page_id}/markdown`,
      ),
  ).toEqual([])
  expect(f.calls.filter((call) => sameRequest(call, original))).toHaveLength(1)
  const completedSecond = await f.run(queryCurrentSkillIndex(library, native.page_id))
  expect(
    completedSecond.files
      .filter((file) => file.content.kind === "source")
      .map((file) => file.path)
      .sort(),
  ).toEqual(["vendor/SKILL.md", "vendor/guide.md"])
  expect(
    await f.run(
      http.use(readSkill(native.page_id, { database: library.skills.database_id, refresh: true })),
    ),
  ).toMatchObject({ content: nativeHeader + humanBody })
  await assertReady(f)
})

test("an unobserved Source CREATE remains one finite parent intent and never blindly creates another Source", async () => {
  const f = currentWriteFixture(parent)
  await seedNative(f)
  const observed = observation(),
    prepared = await f.run(prepareCurrentSourceFromDiscovery(declaration, observed)),
    http = provider([observed]),
    operation = "source-create-absent"
  f.clearCalls()
  f.failNext({ kind: "source-create", outcome: "absent" })
  await expect(
    f.run(http.use(writePreparedCurrentSource(library, { prepared, operation_id: operation }))),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN", details: { operation_id: operation } })
  const creates = () =>
    f.calls.filter(
      (call) =>
        call.path === "v1/pages" &&
        property(property(call.body).parent).data_source_id === library.sources.data_source_id,
    )
  expect(creates()).toHaveLength(1)
  expect(f.table("sources")).toEqual([])
  await expect(
    f.run(
      http.use(
        writePreparedCurrentSource(library, { prepared, operation_id: operation, mode: "resume" }),
      ),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
  expect(creates()).toHaveLength(1)
  expect(pendingKeys(f)).toHaveLength(1)
  expect(operationRecords(f)).toHaveLength(1)
})

test.each(["accepted", "absent"] as const)(
  "a %s lost Source child-start checkpoint resumes the existing child intent before product writes",
  async (outcome) => {
    const f = currentWriteFixture(parent),
      native = await seedNative(f),
      observed = observation(),
      http = provider([observed]),
      prepared = await f.run(prepareCurrentSourceFromDiscovery(declaration, observed)),
      operation = `source-start-${outcome}`
    f.clearCalls()
    f.failNext({ kind: "source-progress", outcome })
    await expect(
      f.run(http.use(writePreparedCurrentSource(library, { prepared, operation_id: operation }))),
    ).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
      details: { operation_id: operation, source_id: "team-skills" },
    })
    const records = operationRecords(f),
      parentRecord = records.find(
        (row) =>
          fieldText(row, library.records.property_ids["Entity ID"]!) ===
          "current-source:team-skills",
      )!,
      childRecord = records.find(
        (row) =>
          fieldText(row, library.records.property_ids["Entity ID"]!) ===
          "current-skill:skill-alpha",
      )!
    expect(records).toHaveLength(2)
    expect(childRecord).toBeDefined()
    expect(
      property(JSON.parse(fieldText(parentRecord, library.records.property_ids.Payload!))).payload,
    ).toMatchObject({
      source_progress: { next_index: 0, child_started: outcome === "accepted" },
    })
    expect(f.table("skills").map((row) => row.id)).toEqual([native.page_id])
    expect(f.table("files").map((row) => fieldText(row, library.files.property_ids.Path!))).toEqual(
      ["local.json"],
    )
    expect((await f.run(queryCurrentSourceManagement(library, "team-skills")))?.state).toEqual({
      state: "applying",
      operation_id: operation,
    })
    expect(pendingKeys(f)).toHaveLength(2)
    const original = f.calls.findLast(
      (call) => call.method === "PATCH" && call.path === `v1/pages/${parentRecord.id}`,
    )!
    await f.run(
      http.use(
        writePreparedCurrentSource(library, { prepared, operation_id: operation, mode: "resume" }),
      ),
    )
    expect(f.calls.filter((call) => sameRequest(call, original))).toHaveLength(
      outcome === "accepted" ? 1 : 2,
    )
    const childCreates = f.calls.filter(
      (call) =>
        call.path === "v1/pages" &&
        fieldText(call.body, library.records.property_ids["Entity ID"]!) ===
          "current-skill:skill-alpha",
    )
    expect(childCreates).toHaveLength(1)
    expect(f.pages.get(String(childRecord.id))?.in_trash).toBe(true)
    expect(f.table("skills")).toHaveLength(2)
    const beta = await f.run(queryCurrentSkillIndex(library, native.page_id))
    expect(beta.files.filter((file) => file.content.kind === "source")).toHaveLength(2)
    await assertReady(f)
  },
)

test("Source manifest cleanup rechecks the current pointer after inspecting a candidate and never archives a newly referenced original", async () => {
  const f = currentWriteFixture(parent)
  await seedNative(f)
  const observed = observation(),
    http = provider([observed]),
    prepared = await f.run(prepareCurrentSourceFromDiscovery(declaration, observed)),
    written = await f.run(
      http.use(
        writePreparedCurrentSource(library, { prepared, operation_id: "seed-cleanup-source" }),
      ),
    ),
    alternate = await f.run(
      prepareCurrentSourceFromDiscovery(declaration, observation(secondCommit)),
    ),
    original = testBytes(canonicalSharedJson(alternate.plan)),
    resource = await f.run(prepareCurrentSharedResource(original, "100644")),
    owner = { kind: "source" as const, page_id: written.source_page_id! }
  expect(resource.status).toBe("inline")
  const request = await f.run(
    currentOwnedResourceCreateRequest(library, {
      owner,
      objectId: resource.content.object_id,
      payload: resource.manifest,
    }),
  )
  const saved = await f.run(
      Effect.flatMap(Notion, (api) => api.request(request.path, request.body, request.options)),
    ),
    recordPage = String(property(saved).id),
    sourcePage = f.pages.get(owner.page_id)!,
    selected = { version: 1 as const, resource: resource.content }
  expect(
    await f.run(readCurrentSharedResourceBytes(library, { owner, content: resource.content })),
  ).toEqual(original)
  const beforeStatus = structuredClone(
      property(sourcePage.properties)[library.sources.property_ids.Status!],
    ),
    beforeOperation = structuredClone(
      property(sourcePage.properties)[library.sources.property_ids.Operation!],
    )
  let switched = false
  f.rewrite((path, response) => {
    if (!switched && path.split("?")[0] === `v1/blocks/${recordPage}/children`) {
      // A concurrent author changes the actual current Source while cleanup is
      // inspecting the obsolete candidate. The observed block response is unchanged.
      const properties = property(sourcePage.properties),
        content = library.sources.property_ids.Content!,
        revision = library.sources.property_ids["Last Revision"]!
      properties[content] = {
        ...property(properties[content]),
        rich_text: sourceRich(canonicalSharedJson(selected)),
      }
      properties[revision] = {
        ...property(properties[revision]),
        rich_text: sourceRich(resource.content.sha256),
      }
      switched = true
    }
    return response
  })
  f.clearCalls()
  await expect(
    f.run(
      http.use(
        writePreparedCurrentSource(library, { prepared, operation_id: "cleanup-source-race" }),
      ),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_SOURCE_WRITE_CONFLICT" })
  expect(switched).toBe(true)
  expect(f.pages.get(recordPage)?.in_trash).toBe(false)
  expect(
    f.calls.filter(
      (call) =>
        call.path === `v1/pages/${recordPage}` &&
        call.method === "PATCH" &&
        property(call.body).in_trash === true,
    ),
  ).toEqual([])
  expect(f.mutations()).toEqual([])
  expect(JSON.parse(fieldText(sourcePage, library.sources.property_ids.Content!))).toEqual(selected)
  expect(fieldText(sourcePage, library.sources.property_ids["Last Revision"]!)).toBe(
    alternate.prepared_source.revision,
  )
  expect(property(sourcePage.properties)[library.sources.property_ids.Status!]).toEqual(
    beforeStatus,
  )
  expect(property(sourcePage.properties)[library.sources.property_ids.Operation!]).toEqual(
    beforeOperation,
  )
})

test("Source projection replacement preserves a supporting File taken over as native while its blocks are read", async () => {
  const f = currentWriteFixture(parent),
    native = await seedNative(f),
    first = observation(),
    second = observation(secondCommit),
    http = provider([first, second]),
    prepared = await f.run(prepareCurrentSourceFromDiscovery(declaration, first))
  await f.run(
    http.use(
      writePreparedCurrentSource(library, { prepared, operation_id: "seed-authority-race" }),
    ),
  )
  const beta = await f.run(queryCurrentSkillIndex(library, native.page_id)),
    file = beta.files.find((item) => item.path === "vendor/guide.md")!,
    row = f.pages.get(file.page_id)!,
    field = library.files.property_ids.Content!,
    content = { kind: "native", frontmatter: "", mode: "100644" },
    humanBlock = {
      object: "block",
      id: id(5000),
      type: "paragraph",
      parent: { type: "page_id", page_id: file.page_id },
      paragraph: { rich_text: sourceRich("Human took over this current document.") },
      has_children: false,
      archived: false,
      in_trash: false,
    },
    updated = await f.run(prepareCurrentSourceFromDiscovery(declaration, second))
  let changedAt = -1
  f.rewrite((path, response) => {
    if (changedAt < 0 && path.split("?")[0] === `v1/blocks/${file.page_id}/children`) {
      const properties = property(row.properties)
      properties[field] = {
        ...property(properties[field]),
        rich_text: sourceRich(canonicalSharedJson(content)),
      }
      f.blocks.set(file.page_id, [structuredClone(humanBlock)])
      changedAt = f.calls.length
    }
    return response
  })
  f.clearCalls()
  await expect(
    f.run(
      http.use(
        writePreparedCurrentSource(library, {
          prepared: updated,
          operation_id: "source-authority-race",
        }),
      ),
    ),
  ).rejects.toMatchObject({
    code: "CURRENT_WRITE_CONFLICT",
    message: "The coordinated File authority, source path or selected content changed.",
  })
  expect(changedAt).toBeGreaterThan(0)
  expect(JSON.parse(fieldText(row, field))).toEqual(content)
  expect(row.in_trash).toBe(false)
  expect(f.blocks.get(file.page_id)).toEqual([humanBlock])
  expect(
    f.calls
      .slice(changedAt)
      .filter(
        (call) =>
          call.method !== "GET" &&
          (call.path === `v1/pages/${file.page_id}` ||
            call.path === `v1/pages/${file.page_id}/markdown` ||
            call.path === `v1/blocks/${file.page_id}/children`),
      ),
  ).toEqual([])
})

test("Source child resource cleanup preserves an original newly selected by a preserved File during its block scan", async () => {
  const f = currentWriteFixture(parent),
    native = await seedNative(f),
    observed = observation(),
    http = provider([observed]),
    prepared = await f.run(prepareCurrentSourceFromDiscovery(declaration, observed))
  await f.run(
    http.use(writePreparedCurrentSource(library, { prepared, operation_id: "seed-child-gc-race" })),
  )
  const beta = await f.run(queryCurrentSkillIndex(library, native.page_id)),
    file = beta.files.find((item) => item.path === "local.json")!,
    current = f.pages.get(file.page_id)!,
    field = library.files.property_ids.Content!,
    original = testBytes('{"owned":"new human selection"}\n'),
    resource = await f.run(prepareCurrentSharedResource(original, "100644")),
    owner = { kind: "skill" as const, page_id: native.page_id },
    request = await f.run(
      currentOwnedResourceCreateRequest(library, {
        owner,
        objectId: resource.content.object_id,
        payload: resource.manifest,
      }),
    ),
    saved = await f.run(
      Effect.flatMap(Notion, (api) => api.request(request.path, request.body, request.options)),
    ),
    recordPage = String(property(saved).id)
  expect(
    await f.run(readCurrentSharedResourceBytes(library, { owner, content: resource.content })),
  ).toEqual(original)
  let switched = false
  f.rewrite((path, response) => {
    if (!switched && path.split("?")[0] === `v1/blocks/${recordPage}/children`) {
      const properties = property(current.properties)
      properties[field] = {
        ...property(properties[field]),
        rich_text: sourceRich(canonicalSharedJson(resource.content)),
      }
      switched = true
    }
    return response
  })
  f.clearCalls()
  await expect(
    f.run(
      http.use(
        writePreparedCurrentSource(library, { prepared, operation_id: "source-child-gc-race" }),
      ),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_WRITE_CONFLICT" })
  expect(switched).toBe(true)
  expect(JSON.parse(fieldText(current, field))).toEqual(resource.content)
  expect(f.pages.get(recordPage)?.in_trash).toBe(false)
  expect(
    f.calls.filter(
      (call) =>
        call.path === `v1/pages/${recordPage}` &&
        call.method === "PATCH" &&
        property(call.body).in_trash === true,
    ),
  ).toEqual([])
  expect(f.mutations()).toEqual([])
  expect(
    await f.run(readCurrentSharedResourceBytes(library, { owner, content: resource.content })),
  ).toEqual(original)
})
