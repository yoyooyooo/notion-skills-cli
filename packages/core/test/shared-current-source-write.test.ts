import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { exportSkill } from "../src/export.ts"
import { trashPath } from "../src/local-locks.ts"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { makeRequestBudget, RequestBudget } from "../src/request-budget.ts"
import { DEFAULT_CURRENT_INVOCATION_BUDGET } from "../src/shared-current-invocation.ts"
import { currentOwnedResourceCreateRequest } from "../src/shared-current-records.ts"
import {
  prepareCurrentSharedResource,
  readCurrentSharedResourceBytes,
} from "../src/shared-current-resource.ts"
import { queryCurrentSkillIndex, type CurrentSkillIndex } from "../src/shared-current-index.ts"
import {
  prepareCurrentSourceFromDiscovery,
  type CurrentSourceDeclaration,
  type PreparedCurrentSourceInput,
} from "../src/shared-current-source-input.ts"
import {
  currentSourceWriteProperties,
  queryCurrentSourceManagement,
} from "../src/shared-current-source-management.ts"
import { prepareCurrentSharedSourceContent } from "../src/shared-current-source.ts"
import { writePreparedCurrentSource } from "../src/shared-current-source-write.ts"
import { prepareCurrentSkillWrite, writeCurrentSkill } from "../src/shared-current-write.ts"
import { prepareCurrentWriteFile } from "../src/shared-current-write-input.ts"
import { listSkill, readSkill, resolveReference, resolveSkillRef } from "../src/snapshot.ts"
import { parseRef } from "../src/ref.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"
import {
  currentWriteFixture,
  seedSourceFileRows,
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
  originalBody = "# Human main\n\nKeep this authoring surface."

function observation(
  commit = firstCommit,
  names: readonly string[] = ["alpha", "beta"],
): SourceSnapshot {
  const version = commit === firstCommit ? "one" : "two"
  return {
    revision: commit,
    provenance: {
      provider: "git",
      git_url:
        declaration.definition.adapter.type === "git" ? declaration.definition.adapter.url : "",
      resolved_ref: commit,
      tree_hash: (commit === firstCommit ? "b" : "d").repeat(40),
    },
    members: names.map((name) => {
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
 * and the normal reader execute their production paths. */
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

test("a complete Source successor replaces an uncertain child Skill creation while keeping existing identities and human native edits", async () => {
  const f = currentWriteFixture(parent),
    native = await seedNative(f)
  const observed = observation(),
    nextObserved = observation(secondCommit)
  const http = provider([observed, nextObserved])
  const original = await f.run(prepareCurrentSourceFromDiscovery(declaration, observed))
  const successor = await f.run(prepareCurrentSourceFromDiscovery(declaration, nextObserved))
  f.failNext({ kind: "skill-create", outcome: "accepted" })
  await expect(
    f.run(
      http.use(
        writePreparedCurrentSource(library, {
          prepared: original,
          operation_id: "partial-source-old",
        }),
      ),
    ),
  ).rejects.toMatchObject({
    code: "WRITE_OUTCOME_UNKNOWN",
    details: { operation_id: "partial-source-old" },
  })
  const firstAlpha = f
    .table("skills")
    .find((row) => fieldText(row, library.skills.property_ids["Skill ID"]!) === "skill-alpha")!
  const parentRecord = operationRecords(f).find(
    (row) =>
      fieldText(row, library.records.property_ids["Entity ID"]!) === "current-source:team-skills",
  )!
  const childRecord = operationRecords(f).find(
    (row) =>
      fieldText(row, library.records.property_ids["Entity ID"]!) === "current-skill:skill-alpha",
  )!
  expect(firstAlpha).toBeDefined()
  expect(childRecord).toBeDefined()
  expect(f.table("files")).toHaveLength(1)
  expect(f.blocks.get(String(firstAlpha.id))).toEqual([])
  const humanBody = "# Human edit while the Source is interrupted\n\nThis stays current.\n"
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Notion).request(
        `v1/pages/${native.page_id}/markdown`,
        {
          type: "replace_content",
          replace_content: { new_str: humanBody, allow_deleting_content: true },
        },
        { method: "PATCH" },
      )
    }),
  )
  f.clearCalls()
  const result = await f.run(
    http.use(
      writePreparedCurrentSource(library, {
        prepared: successor,
        operation_id: "partial-source-new",
        mode: { kind: "supersede", operation_id: "partial-source-old" },
      }),
    ),
  )
  expect(result).toMatchObject({
    action: "declaration",
    status: "applied",
    state: "ready",
    operation_id: "partial-source-new",
    resolved_commit: secondCommit,
    affected_skill_ids: ["skill-alpha", "skill-beta"],
  })
  const alpha = f
    .table("skills")
    .find((row) => fieldText(row, library.skills.property_ids["Skill ID"]!) === "skill-alpha")!
  expect(alpha.id).toBe(firstAlpha.id)
  expect(f.pages.get(String(parentRecord.id))?.in_trash).toBe(true)
  expect(f.pages.get(String(childRecord.id))?.in_trash).toBe(true)
  expect(
    f.calls.some(
      (call) =>
        call.path === "v1/pages" &&
        ["current-source:team-skills", "current-skill:skill-alpha"].includes(
          fieldText(call.body, library.records.property_ids["Entity ID"]!),
        ),
    ),
  ).toBe(false)
  expect(
    await f.run(
      http.use(readSkill(native.page_id, { database: library.skills.database_id, refresh: true })),
    ),
  ).toMatchObject({ content: nativeHeader + humanBody })
  await assertReady(f)
})

test.each(["before-child", "after-child"] as const)(
  "another Source successor is admitted only after the %s handoff has actually selected its child",
  async (stage) => {
    const f = currentWriteFixture(parent)
    await seedNative(f)
    const thirdCommit = "f".repeat(40)
    const snapshots = [observation(), observation(secondCommit), observation(thirdCommit)]
    const http = provider(snapshots)
    const plans: PreparedCurrentSourceInput[] = []
    for (const snapshot of snapshots)
      plans.push(await f.run(prepareCurrentSourceFromDiscovery(declaration, snapshot)))
    f.failNext({ kind: "skill-create", outcome: "accepted" })
    await expect(
      f.run(
        http.use(
          writePreparedCurrentSource(library, {
            prepared: plans[0]!,
            operation_id: "handoff-p1",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    if (stage === "before-child") f.failNext({ kind: "source-properties", outcome: "accepted" })
    const alphaPage = String(skillPage(f, "skill-alpha")!.id)
    await expect(
      f.run(
        http.use(
          Effect.gen(function* () {
            const api = yield* Notion
            let interrupted = false
            return yield* writePreparedCurrentSource(library, {
              prepared: plans[1]!,
              operation_id: "handoff-p2",
              mode: { kind: "supersede", operation_id: "handoff-p1" },
            }).pipe(
              Effect.provideService(Notion, {
                ...api,
                request: (path, body, options) =>
                  api.request(path, body, options).pipe(
                    Effect.flatMap((response) => {
                      if (
                        stage === "after-child" &&
                        !interrupted &&
                        path === `v1/pages/${alphaPage}` &&
                        options?.method === "PATCH" &&
                        library.skills.property_ids.Content! in property(property(body).properties)
                      ) {
                        interrupted = true
                        return Effect.fail(
                          fail(
                            "WRITE_OUTCOME_UNKNOWN",
                            "The accepted child Content response was lost.",
                          ),
                        )
                      }
                      return Effect.succeed(response)
                    }),
                  ),
              }),
            )
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
      details: { operation_id: "handoff-p2" },
    })
    f.clearCalls()
    const attempt = writePreparedCurrentSource(library, {
      prepared: plans[2]!,
      operation_id: "handoff-p3",
      mode: { kind: "supersede", operation_id: "handoff-p2" },
    })
    if (stage === "before-child") {
      await expect(f.run(http.use(attempt))).rejects.toMatchObject({
        code: "CURRENT_SOURCE_HANDOFF_PENDING",
        details: { operation_id: "handoff-p2", next: "reconcile_current" },
      })
      expect(f.mutations()).toEqual([])
      expect(
        (await f.run(queryCurrentSourceManagement(library, "team-skills")))?.state,
      ).toMatchObject({ operation_id: "handoff-p2" })
      // Repeating the same exact successor selects P2 again and pins its original
      // commit; it does not rediscover a branch or start another handoff.
      await f.run(
        http.use(
          writePreparedCurrentSource(library, {
            prepared: plans[1]!,
            operation_id: "handoff-p2",
            mode: { kind: "supersede", operation_id: "handoff-p1" },
          }),
        ),
      )
    } else {
      const child = operationRecords(f).find(
        (row) =>
          fieldText(row, library.records.property_ids["Entity ID"]!) ===
          "current-skill:skill-alpha",
      )!
      const savedChild = structuredClone(child)
      const local = [...f.json.entries()].find(
        ([key, value]) =>
          key.startsWith("operations/current-write-pending/") &&
          property(property(property(value).intent).owner).id === "skill-alpha",
      )!
      const envelope = JSON.parse(fieldText(child, library.records.property_ids.Payload!))
      property(property(property(envelope).payload).intent).source = {
        ...property(property(property(property(envelope).payload).intent).source),
        authorization_sha256: "0".repeat(64),
      }
      const encoded = canonicalSharedJson(envelope),
        fields = property(child.properties)
      for (const [name, value] of [
        ["Payload", encoded],
        ["Hash", createHash("sha256").update(encoded).digest("hex")],
      ] as const) {
        const key = library.records.property_ids[name]!
        fields[key] = { ...property(fields[key]), rich_text: sourceRich(value) }
      }
      // A caller with no local child cache still verifies the current grant
      // before changing the parent. Four matching labels are insufficient.
      f.json.delete(local[0])
      await expect(f.run(http.use(attempt))).rejects.toMatchObject({
        code: "CURRENT_SOURCE_HANDOFF_PENDING",
      })
      expect(f.mutations()).toEqual([])
      f.pages.set(String(child.id), savedChild)
      f.json.set(local[0], local[1])
      expect(await f.run(http.use(attempt))).toMatchObject({
        operation_id: "handoff-p3",
        state: "ready",
        resolved_commit: thirdCommit,
      })
    }
    await assertReady(f)
  },
)

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
    source_files: 6,
    affected_skill_ids: ["skill-alpha", "skill-beta"],
  })
  await assertReady(f)
  expect(f.table("sources")).toHaveLength(1)
  expect(f.table("skills")).toHaveLength(2)
  expect(
    property(property(f.pages.get(native.page_id)!.properties)[library.skills.property_ids.Origin!])
      .relation,
  ).toEqual([{ id: result.source_page_id }])
  expect(f.table("files").map((row) => fieldText(row, library.files.property_ids.Path!))).toEqual([
    "local.json",
  ])
  expect(result.targets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ skill_id: "skill-alpha", source_files: 4, notion_pages: 1 }),
      expect.objectContaining({ skill_id: "skill-beta", source_files: 2, notion_pages: 2 }),
    ]),
  )
  await seedSourceFileRows(f, prepared)
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
  expect(f.blocks.get(runFile.page_id)).toEqual([])
  expect(f.blocks.get(binary.page_id)).toEqual([])
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/children")),
  ).toEqual([])
  expect(f.calls.filter((call) => call.path.startsWith("v1/file_uploads"))).toEqual([])
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

test("an absent parent ready response resumes only its complete original child scope", async () => {
  const f = currentWriteFixture(parent)
  const observed = observation(),
    http = provider([observed])
  const selected = {
    ...declaration,
    contributions: declaration.contributions.map((entry) => ({ ...entry, mount_path: "" })),
  }
  const prepared = await f.run(prepareCurrentSourceFromDiscovery(selected, observed))
  const options = { prepared, operation_id: "absent-parent-ready" }
  f.failNext({ kind: "source-ready", outcome: "absent" })
  await expect(f.run(http.use(writePreparedCurrentSource(library, options)))).rejects.toMatchObject(
    { code: "WRITE_OUTCOME_UNKNOWN" },
  )
  const source = (await f.run(queryCurrentSourceManagement(library, "team-skills")))!
  const skills = f.table("skills").map((row) => String(row.id))
  const files = f.table("files").map((row) => String(row.id))
  for (const page of skills)
    expect((await f.run(queryCurrentSkillIndex(library, page))).state).toEqual({ state: "ready" })
  f.clearCalls()
  await expect(
    f.run(
      http.use(
        writePreparedCurrentSource(library, {
          ...options,
          operation_id: "another-parent",
          mode: "resume",
        }),
      ),
    ),
  ).rejects.toBeDefined()
  expect(f.mutations()).toEqual([])
  const operation = property(
    property(f.pages.get(source.page_id)!.properties)[library.sources.property_ids.Operation!],
  )
  const ownOperation = structuredClone(operation.rich_text)
  operation.rich_text = sourceRich("another-parent")
  f.clearCalls()
  await expect(
    f.run(http.use(writePreparedCurrentSource(library, { ...options, mode: "resume" }))),
  ).rejects.toBeDefined()
  expect(f.mutations()).toEqual([])
  operation.rich_text = ownOperation
  const file = f.pages.get(skills[0]!)!
  const content = property(property(file.properties)[library.skills.property_ids.Content!])
  const ownContent = structuredClone(content.rich_text)
  content.rich_text = sourceRich(
    JSON.stringify({ ...JSON.parse(text(ownContent)), source_id: "foreign-source" }),
  )
  f.clearCalls()
  await expect(
    f.run(http.use(writePreparedCurrentSource(library, { ...options, mode: "resume" }))),
  ).rejects.toBeDefined()
  expect(f.mutations()).toEqual([])
  content.rich_text = ownContent
  const parentRecord = operationRecords(f).find(
    (row) =>
      fieldText(row, library.records.property_ids["Entity ID"]!) === "current-source:team-skills",
  )!
  const payload = property(property(parentRecord.properties)[library.records.property_ids.Payload!])
  const payloadHash = property(
    property(parentRecord.properties)[library.records.property_ids.Hash!],
  )
  const completePayload = structuredClone(payload.rich_text)
  const completeHash = structuredClone(payloadHash.rich_text)
  const incomplete = JSON.parse(text(completePayload))
  incomplete.payload.source_progress.next_index = 0
  const incompletePayload = canonicalSharedJson(incomplete)
  payload.rich_text = sourceRich(incompletePayload)
  payloadHash.rich_text = sourceRich(createHash("sha256").update(incompletePayload).digest("hex"))
  f.clearCalls()
  await expect(
    f.run(http.use(writePreparedCurrentSource(library, { ...options, mode: "resume" }))),
  ).rejects.toMatchObject({ code: "CURRENT_OPERATION_PENDING" })
  expect(f.mutations()).toEqual([])
  payload.rich_text = completePayload
  payloadHash.rich_text = completeHash
  f.clearCalls()
  expect(
    await f.run(http.use(writePreparedCurrentSource(library, { ...options, mode: "resume" }))),
  ).toMatchObject({ state: "ready" })
  expect(f.calls.some((call) => call.path === "v1/pages" && call.method === "POST")).toBe(false)
  expect(
    f
      .mutations()
      .some((call) => [...skills, ...files].some((page) => call.path === "v1/pages/" + page)),
  ).toBe(false)
  await assertReady(f)
})

test("Source writes reach ready without projection bodies and preserve current native authorship", async () => {
  const f = currentWriteFixture(parent),
    native = await seedNative(f),
    observed = observation(),
    http = provider([observed]),
    prepared = await f.run(prepareCurrentSourceFromDiscovery(declaration, observed))
  f.clearCalls()
  // If apply tries to append a generated projection, this accepted-but-unknown
  // fault would interrupt it. Source authority has no such write dependency.
  f.failNext({ kind: "append", outcome: "accepted" })
  expect(
    await f.run(
      http.use(
        writePreparedCurrentSource(library, {
          prepared,
          operation_id: "source-without-projection",
        }),
      ),
    ),
  ).toMatchObject({ status: "applied", state: "ready" })
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/children")),
  ).toEqual([])
  const sourceFiles = []
  for (const row of f.table("skills")) {
    const current = await f.run(queryCurrentSkillIndex(library, String(row.id)))
    sourceFiles.push(...allFiles(current).filter((file) => file.content.kind === "source"))
  }
  expect(sourceFiles.length).toBeGreaterThan(0)
  for (const file of sourceFiles) expect(f.blocks.get(file.page_id)).toEqual([])
  const alpha = f
    .table("skills")
    .find((row) => fieldText(row, library.skills.property_ids["Skill ID"]!) === "skill-alpha")!
  f.clearCalls()
  expect(
    await f.run(
      http.use(
        readSkill(String(alpha.id), {
          database: library.skills.database_id,
          refresh: true,
        }),
      ),
    ),
  ).toMatchObject({
    content: new TextDecoder().decode(observed.members[0]!.portable.files[0]!.bytes),
  })
  expect(
    await f.run(
      http.use(
        readSkill(native.page_id, {
          database: library.skills.database_id,
          refresh: true,
        }),
      ),
    ),
  ).toMatchObject({ content: nativeHeader + originalBody })
  expect(f.mutations()).toEqual([])
  await assertReady(f)
})

test("fixed nested File resolution uses the Source path and target mount without reading target bytes", async () => {
  const f = currentWriteFixture(parent)
  await seedNative(f)
  const observed = observation(),
    http = provider([observed])
  const mapped: CurrentSourceDeclaration = {
    ...declaration,
    contributions: declaration.contributions.map((contribution) =>
      contribution.skill_id === "skill-alpha"
        ? { ...contribution, mapping: { "notes.md": "references/nested/note.md" } }
        : contribution,
    ),
  }
  const prepared = await f.run(prepareCurrentSourceFromDiscovery(mapped, observed))
  await f.run(
    http.use(
      writePreparedCurrentSource(library, {
        prepared,
        operation_id: "source-relative-resolution",
      }),
    ),
  )
  const alpha = f
    .table("skills")
    .find((row) => fieldText(row, library.skills.property_ids["Skill ID"]!) === "skill-alpha")!
  const selected = await f.run(
    http.use(
      readSkill(String(alpha.id), {
        database: library.skills.database_id,
        refresh: true,
      }),
    ),
  )
  const manifest = await f.run(listSkill(selected.snapshot_id, { offline: true }))
  const from = manifest.files.find((file) => file.path === "references/nested/note.md")!.ref
  const beforeDownloads = http.requests.length
  f.clearCalls()
  const resolved = await f.run(http.use(resolveReference("../beta/guide.md", { from })))
  expect(parseRef(resolved.ref)).toMatchObject({
    skillId: "skill-beta",
    scope: { kind: "library", libraryId: library.library_id },
    path: "vendor/guide.md",
  })
  expect(resolved).toMatchObject({
    version: 1,
    from,
    effects: { version: 1, remote_writes: "none", author_content: "unchanged" },
  })
  expect(http.requests).toHaveLength(beforeDownloads)
  expect(f.mutations()).toEqual([])
  const withoutFileId = from.replace(/&file_id=[^&]+/u, "")
  expect(await f.run(http.use(resolveSkillRef(withoutFileId, "../beta/guide.md")))).toBe(
    resolved.ref,
  )
  const read = await f.run(
    http.use(
      readSkill("../beta/guide.md", {
        from,
        database: library.skills.database_id,
      }),
    ),
  )
  expect(read).toMatchObject({
    path: "vendor/guide.md",
    content: "# Source guide one\n\nEvery line is readable.\n",
  })
  expect(f.mutations()).toEqual([])
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
    expect(beta.files.filter((file) => file.content.kind === "source")).toHaveLength(0)
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
    if (!switched && path.split("?")[0] === `v1/pages/${recordPage}`) {
      // A concurrent author changes the actual current Source while cleanup is
      // inspecting the obsolete candidate. The observed metadata response is unchanged.
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

test("a Source refresh does not read or rewrite an existing generated projection", async () => {
  const f = currentWriteFixture(parent),
    native = await seedNative(f),
    first = observation(),
    second = observation(secondCommit),
    http = provider([first, second]),
    prepared = await f.run(prepareCurrentSourceFromDiscovery(declaration, first))
  await f.run(
    http.use(writePreparedCurrentSource(library, { prepared, operation_id: "seed-projection" })),
  )
  await seedSourceFileRows(f, prepared)
  const beta = await f.run(queryCurrentSkillIndex(library, native.page_id)),
    file = beta.files.find((item) => item.path === "vendor/guide.md")!,
    block = {
      object: "block",
      id: id(5000),
      type: "paragraph",
      parent: { type: "page_id", page_id: file.page_id },
      paragraph: { rich_text: sourceRich("An old reading projection.") },
      has_children: false,
      archived: false,
      in_trash: false,
    }
  f.blocks.set(file.page_id, [structuredClone(block)])
  let projectionReads = 0
  f.rewrite((path, response) => {
    if (path.split("?")[0] === `v1/blocks/${file.page_id}/children`) projectionReads++
    return response
  })
  const updated = await f.run(prepareCurrentSourceFromDiscovery(declaration, second))
  f.clearCalls()
  expect(
    await f.run(
      http.use(
        writePreparedCurrentSource(library, {
          prepared: updated,
          operation_id: "refresh-without-projection",
        }),
      ),
    ),
  ).toMatchObject({ status: "applied", state: "ready" })
  expect(projectionReads).toBe(0)
  expect(f.blocks.get(file.page_id)).toEqual([block])
  expect(
    f.calls.filter(
      (call) =>
        call.method !== "GET" &&
        (call.path === `v1/pages/${file.page_id}/markdown` ||
          call.path === `v1/blocks/${file.page_id}/children`),
    ),
  ).toEqual([])
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
  ).toMatchObject({ content: "# Source guide two\n\nEvery line is readable.\n" })
  expect(projectionReads).toBe(0)
  await assertReady(f)
})

test("Source child resource cleanup preserves an original newly selected by a preserved File during its candidate metadata read", async () => {
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
    if (!switched && path.split("?")[0] === `v1/pages/${recordPage}`) {
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

const directDeclaration: CurrentSourceDeclaration = {
  ...declaration,
  contributions: declaration.contributions.map((entry) => ({ ...entry, mount_path: "" })),
}
const skillPage = (f: ReturnType<typeof currentWriteFixture>, skillId: string) =>
  f
    .table("skills")
    .find((row) => fieldText(row, library.skills.property_ids["Skill ID"]!) === skillId)

// The coordinator uses its real current writer, Source state, finite intents and
// reader; only upstream acquisition and Notion transport are fixtures.
test("one declaration discovers additions, retires upstream removals and converges an empty selection", async () => {
  const f = currentWriteFixture(parent),
    first = observation(firstCommit, ["alpha"]),
    second = observation(secondCommit, ["alpha", "gamma"]),
    reduced = observation(secondCommit, ["alpha"]),
    empty = observation(secondCommit, []),
    http = provider([first, second]),
    input = { ...directDeclaration, contributions: [] },
    initial = await f.run(prepareCurrentSourceFromDiscovery(input, first))
  await f.run(
    http.use(
      writePreparedCurrentSource(library, { prepared: initial, operation_id: "auto-initial" }),
    ),
  )
  const alphaId = initial.targets[0]!.skill_id,
    firstAlpha = skillPage(f, alphaId)!,
    alpha = await f.run(queryCurrentSkillIndex(library, String(firstAlpha.id))),
    expanded = await f.run(prepareCurrentSourceFromDiscovery(initial.declaration, second))
  expect(expanded.targets).toHaveLength(2)
  const gammaId = expanded.targets.find((target) =>
    target.members.includes("skills/gamma"),
  )!.skill_id
  expect(
    await f.run(
      http.use(
        writePreparedCurrentSource(library, { prepared: expanded, operation_id: "auto-addition" }),
      ),
    ),
  ).toMatchObject({
    status: "applied",
    state: "ready",
    affected_skill_ids: [alphaId, gammaId].sort(),
  })
  expect(skillPage(f, alphaId)?.id).toBe(firstAlpha.id)
  const updatedAlpha = await f.run(queryCurrentSkillIndex(library, String(firstAlpha.id)))
  expect(allFiles(updatedAlpha).map((file) => [file.file_id, file.page_id])).toEqual(
    allFiles(alpha).map((file) => [file.file_id, file.page_id]),
  )
  const gammaPage = String(skillPage(f, gammaId)!.id),
    gamma = await f.run(queryCurrentSkillIndex(library, gammaPage)),
    next = await f.run(prepareCurrentSourceFromDiscovery(expanded.declaration, reduced))
  const removed = await f.run(
    http.use(writePreparedCurrentSource(library, { prepared: next, operation_id: "auto-removal" })),
  )
  expect(removed).toMatchObject({
    status: "applied",
    state: "ready",
    targets: expect.arrayContaining([
      expect.objectContaining({
        skill_id: gammaId,
        page_id: gammaPage,
        status: "removed",
        state: "removed",
        source_files: 0,
        notion_pages: 0,
      }),
    ]),
  })
  expect(f.pages.get(gammaPage)?.in_trash).toBe(true)
  for (const file of gamma.files) expect(f.pages.get(file.page_id)?.in_trash).toBe(true)
  expect(f.table("skills")).toHaveLength(1)
  const emptied = await f.run(prepareCurrentSourceFromDiscovery(next.declaration, empty))
  expect(emptied.targets).toEqual([])
  expect(
    await f.run(
      http.use(
        writePreparedCurrentSource(library, { prepared: emptied, operation_id: "auto-empty" }),
      ),
    ),
  ).toMatchObject({ status: "applied", state: "ready" })
  expect(f.table("skills")).toEqual([])
  expect(f.table("files")).toEqual([])
  expect(
    (await f.run(queryCurrentSourceManagement(library, "team-skills")))?.declaration.contributions,
  ).toEqual([])
  f.clearCalls()
  expect(
    await f.run(
      http.use(
        writePreparedCurrentSource(library, {
          prepared: emptied,
          operation_id: "auto-empty-repeat",
        }),
      ),
    ),
  ).toMatchObject({ status: "unchanged", state: "ready" })
  expect(f.mutations()).toEqual([])
  await assertReady(f)
})

test.each(["accepted", "absent"] as const)(
  "a %s unknown member retirement resumes the exact archived File without losing its owner",
  async (outcome) => {
    const f = currentWriteFixture(parent),
      first = observation(),
      second = observation(secondCommit, ["alpha"]),
      http = provider([first, second]),
      initial = await f.run(prepareCurrentSourceFromDiscovery(directDeclaration, first))
    await f.run(
      http.use(
        writePreparedCurrentSource(library, { prepared: initial, operation_id: "retirement-seed" }),
      ),
    )
    await seedSourceFileRows(f, initial)
    const betaPage = String(skillPage(f, "skill-beta")!.id),
      beta = await f.run(queryCurrentSkillIndex(library, betaPage)),
      prepared = await f.run(prepareCurrentSourceFromDiscovery(initial.declaration, second)),
      operation = `retire-member-${outcome}`
    f.clearCalls()
    f.failNext({ kind: "retire-file", outcome })
    await expect(
      f.run(http.use(writePreparedCurrentSource(library, { prepared, operation_id: operation }))),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN", details: { operation_id: operation } })
    const attempted = f.calls.find(
      (call) =>
        call.method === "PATCH" &&
        property(call.body).in_trash === true &&
        beta.files.some((file) => call.path === `v1/pages/${file.page_id}`),
    )!
    expect(attempted).toBeDefined()
    expect(pendingKeys(f).length).toBeGreaterThan(0)
    expect(
      await f.run(
        http.use(
          writePreparedCurrentSource(library, {
            prepared,
            operation_id: operation,
            mode: "resume",
          }),
        ),
      ),
    ).toMatchObject({
      state: "ready",
      targets: expect.arrayContaining([
        expect.objectContaining({ skill_id: "skill-beta", state: "removed", status: "removed" }),
      ]),
    })
    expect(f.calls.filter((call) => sameRequest(call, attempted))).toHaveLength(
      outcome === "accepted" ? 1 : 2,
    )
    expect(f.pages.get(betaPage)?.in_trash).toBe(true)
    for (const file of beta.files) expect(f.pages.get(file.page_id)?.in_trash).toBe(true)
    expect(skillPage(f, "skill-alpha")).toBeDefined()
    await assertReady(f)
  },
)

test("an explicit Source mapping replaces same-path native authority while retaining logical and physical File identities", async () => {
  const f = currentWriteFixture(parent),
    native = await seedNative(f),
    observed = observation(firstCommit, ["beta"]),
    http = provider([observed]),
    prepared = await f.run(prepareCurrentSourceFromDiscovery(directDeclaration, observed)),
    before = await f.run(queryCurrentSkillIndex(library, native.page_id))
  f.clearCalls()
  const inspected = await f.run(
    http.use(
      writePreparedCurrentSource(library, {
        prepared,
        operation_id: "native-to-source",
        dry_run: true,
      }),
    ),
  )
  expect(inspected).toMatchObject({
    status: "inspected",
    remote_writes: 0,
    targets: expect.arrayContaining([
      expect.objectContaining({
        skill_id: "skill-beta",
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "SKILL.md",
            file_id: "human-main",
            page_id: native.page_id,
            authority: "source",
            action: "authority_replace",
          }),
        ]),
      }),
    ]),
  })
  expect(f.mutations()).toEqual([])
  expect(
    await f.run(
      http.use(writePreparedCurrentSource(library, { prepared, operation_id: "native-to-source" })),
    ),
  ).toMatchObject({ status: "applied", state: "ready" })
  const after = await f.run(queryCurrentSkillIndex(library, native.page_id))
  expect(after.main).toMatchObject({
    file_id: before.main.file_id,
    page_id: before.main.page_id,
    content: { kind: "source", source_path: "skills/beta/SKILL.md" },
  })
  expect(after.files.find((file) => file.path === "local.json")).toMatchObject({
    file_id: "human-resource",
    content: { kind: "resource" },
  })
  expect(
    f.calls.filter(
      (call) => call.method === "PATCH" && call.path === `v1/pages/${native.page_id}/markdown`,
    ),
  ).toEqual([])
  expect(
    await f.run(
      http.use(readSkill(native.page_id, { database: library.skills.database_id, refresh: true })),
    ),
  ).toMatchObject({
    content: new TextDecoder().decode(observed.members[0]!.portable.files[0]!.bytes),
  })
  await assertReady(f)
})

test.each(["skill", "source-and-skills"] as const)(
  "reapplying the same Source rebuilds deleted %s and retires remaining orphan File rows",
  async (removed) => {
    const f = currentWriteFixture(parent),
      observed = observation(),
      http = provider([observed]),
      prepared = await f.run(prepareCurrentSourceFromDiscovery(directDeclaration, observed)),
      first = await f.run(
        http.use(writePreparedCurrentSource(library, { prepared, operation_id: "rebuild-seed" })),
      )
    await seedSourceFileRows(f, prepared)
    const alphaPage = String(skillPage(f, "skill-alpha")!.id),
      alpha = await f.run(queryCurrentSkillIndex(library, alphaPage)),
      oldFiles = new Set(
        f
          .table("files")
          .filter(
            (row) =>
              removed === "source-and-skills" ||
              alpha.files.some((file) => file.page_id === row.id),
          )
          .map((row) => String(row.id)),
      )
    f.pages.get(alphaPage)!.in_trash = true
    expect(oldFiles.size).toBeGreaterThan(0)
    if (removed === "source-and-skills") {
      for (const row of f.table("skills")) row.in_trash = true
      f.pages.get(first.source_page_id!)!.in_trash = true
    }
    f.clearCalls()
    expect(
      await f.run(
        http.use(
          writePreparedCurrentSource(library, { prepared, operation_id: `rebuild-${removed}` }),
        ),
      ),
    ).toMatchObject({ status: "applied", state: "ready" })
    expect(f.table("sources")).toHaveLength(1)
    expect(f.table("skills")).toHaveLength(2)
    const rebuiltPage = String(skillPage(f, "skill-alpha")!.id)
    expect(rebuiltPage).not.toBe(alphaPage)
    const rebuilt = await f.run(queryCurrentSkillIndex(library, rebuiltPage))
    expect(
      allFiles(rebuilt)
        .map((file) => file.file_id)
        .sort(),
    ).toEqual([alpha.main].map((file) => file.file_id).sort())
    for (const page of oldFiles) expect(f.pages.get(page)?.in_trash).toBe(true)
    expect(f.table("files").some((row) => oldFiles.has(String(row.id)))).toBe(false)
    expect(
      await f.run(
        http.use(readSkill(rebuiltPage, { database: library.skills.database_id, refresh: true })),
      ),
    ).toMatchObject({
      content: new TextDecoder().decode(observed.members[0]!.portable.files[0]!.bytes),
    })
    await assertReady(f)
  },
)

test("a deleted Source is recreated while vanished upstream members still retire by current ownership", async () => {
  const f = currentWriteFixture(parent),
    first = observation(),
    second = observation(secondCommit, ["alpha"]),
    http = provider([first, second]),
    initial = await f.run(prepareCurrentSourceFromDiscovery(directDeclaration, first)),
    seeded = await f.run(
      http.use(
        writePreparedCurrentSource(library, {
          prepared: initial,
          operation_id: "missing-source-seed",
        }),
      ),
    ),
    alphaPage = String(skillPage(f, "skill-alpha")!.id),
    betaPage = String(skillPage(f, "skill-beta")!.id),
    beta = await f.run(queryCurrentSkillIndex(library, betaPage))
  f.pages.get(seeded.source_page_id!)!.in_trash = true
  const prepared = await f.run(prepareCurrentSourceFromDiscovery(initial.declaration, second))
  expect(prepared.declaration.contributions.map((entry) => entry.skill_id)).toEqual(["skill-alpha"])
  const result = await f.run(
    http.use(
      writePreparedCurrentSource(library, {
        prepared,
        operation_id: "missing-source-current-sync",
      }),
    ),
  )
  expect(result).toMatchObject({
    status: "applied",
    state: "ready",
    affected_skill_ids: ["skill-alpha", "skill-beta"],
  })
  expect(result.source_page_id).not.toBe(seeded.source_page_id)
  expect(skillPage(f, "skill-alpha")?.id).toBe(alphaPage)
  expect(f.table("skills")).toHaveLength(1)
  expect(f.pages.get(betaPage)?.in_trash).toBe(true)
  for (const file of beta.files) expect(f.pages.get(file.page_id)?.in_trash).toBe(true)
  expect(f.table("sources")).toHaveLength(1)
  await assertReady(f)
})

test("generated supporting reading content cannot block upstream File retirement", async () => {
  const f = currentWriteFixture(parent),
    first = observation(),
    next = observation(secondCommit)
  const second: SourceSnapshot = {
    ...next,
    members: next.members.map((member) => ({
      ...member,
      portable: {
        ...member.portable,
        files: member.portable.files.filter((file) => file.path !== "notes.md"),
      },
      git_manifest: {
        ...member.git_manifest!,
        files: member.git_manifest!.files.filter((file) => file.path !== "notes.md"),
      },
    })),
  }
  const http = provider([first, second])
  const initial = await f.run(prepareCurrentSourceFromDiscovery(directDeclaration, first))
  await f.run(
    http.use(
      writePreparedCurrentSource(library, {
        prepared: initial,
        operation_id: "reading-retirement-seed",
      }),
    ),
  )
  await seedSourceFileRows(f, initial)
  const alpha = await f.run(
    queryCurrentSkillIndex(library, String(skillPage(f, "skill-alpha")!.id)),
  )
  const note = alpha.files.find((file) => file.path === "notes.md")!
  f.blocks.set(note.page_id, [
    {
      object: "block",
      id: id(9920),
      parent: { type: "page_id", page_id: note.page_id },
      type: "child_page",
      has_children: false,
      child_page: { title: "Generated reading child" },
    },
  ])
  const prepared = await f.run(prepareCurrentSourceFromDiscovery(initial.declaration, second))
  f.clearCalls()
  expect(
    await f.run(
      http.use(
        writePreparedCurrentSource(library, {
          prepared,
          operation_id: "reading-retirement-update",
        }),
      ),
    ),
  ).toMatchObject({ state: "ready" })
  expect(f.pages.get(note.page_id)?.in_trash).toBe(true)
  expect(
    f.calls.filter((call) => call.path.startsWith("v1/blocks/" + note.page_id + "/children")),
  ).toEqual([])
  await assertReady(f)
})

test("Source resume verifies its completed prefix once and reaches the unfinished child within a bounded request allowance", async () => {
  const f = currentWriteFixture(parent)
  const native = await seedNative(f)
  const names = ["alpha", "beta", "delta", "epsilon", "eta", "gamma", "theta", "zeta"]
  const observed = observation(firstCommit, names),
    http = provider([observed])
  const selected = {
    ...declaration,
    contributions: names.map((name) => ({
      member_key: `skills/${name}`,
      skill_id: `skill-${name}`,
      mount_path: name === "beta" ? "vendor" : "",
      mapping: {},
      exclude: [],
    })),
  }
  const prepared = await f.run(prepareCurrentSourceFromDiscovery(selected, observed))
  const initial = await f.run(
    prepareCurrentSourceFromDiscovery(selected, observation(firstCommit, names.slice(0, -1))),
  )
  await f.run(
    http.use(
      writePreparedCurrentSource(library, {
        prepared: initial,
        operation_id: "bounded-prefix-seed",
      }),
    ),
  )
  await seedSourceFileRows(f, initial)
  const operation_id = "bounded-prefix-resume"
  let stopped = false
  await expect(
    f.run(
      http.use(
        Effect.gen(function* () {
          const api = yield* Notion
          return yield* writePreparedCurrentSource(library, { prepared, operation_id }).pipe(
            Effect.provideService(Notion, {
              ...api,
              request: (path, body, options) =>
                Effect.suspend(() => {
                  if (stopped)
                    return Effect.fail(
                      fail("REQUEST_BUDGET_EXHAUSTED", "Stopped after the completed prefix."),
                    )
                  return api.request(path, body, options).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        const payload = text(
                          property(
                            property(property(body).properties)[
                              library.records.property_ids.Payload!
                            ],
                          ).rich_text,
                        )
                        if (payload !== "" && options?.method === "PATCH") {
                          const value = property(JSON.parse(payload).payload)
                          if (
                            property(value.source_progress).next_index === names.length - 1 &&
                            property(value.source_progress).child_started === false
                          )
                            stopped = true
                        }
                      }),
                    ),
                  )
                }),
            }),
          )
        }),
      ),
    ),
  ).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXHAUSTED" })
  expect(stopped).toBe(true)
  expect(skillPage(f, "skill-zeta")).toBeUndefined()
  const alpha = await f.run(
    queryCurrentSkillIndex(library, String(skillPage(f, "skill-alpha")!.id)),
  )
  const beta = await f.run(queryCurrentSkillIndex(library, native.page_id))
  const resume = () =>
    f.run(http.use(writePreparedCurrentSource(library, { prepared, operation_id, mode: "resume" })))
  const rejectWithoutWrites = async () => {
    f.clearCalls()
    await expect(resume()).rejects.toBeDefined()
    expect(f.mutations()).toEqual([])
    expect(skillPage(f, "skill-zeta")).toBeUndefined()
  }
  // A duplicate physical owner, foreign File authority, incomplete directory and
  // exact Origin drift must all fail before starting the unfinished child.
  const owner = f.pages.get(alpha.page_id)!
  f.pages.set(id(9950), { ...structuredClone(owner), id: id(9950) })
  await rejectWithoutWrites()
  f.pages.delete(id(9950))
  const file = f.pages.get(alpha.files[0]!.page_id)!
  const content = property(property(file.properties)[library.files.property_ids.Content!])
  const ownContent = structuredClone(content.rich_text)
  content.rich_text = sourceRich(
    JSON.stringify({ ...JSON.parse(text(ownContent)), source_id: "foreign-source" }),
  )
  await rejectWithoutWrites()
  content.rich_text = ownContent
  const extra = structuredClone(file)
  extra.id = id(9951)
  property(property(extra.properties)[library.files.property_ids["File ID"]!]).rich_text =
    sourceRich("unexpected-source-file")
  property(property(extra.properties)[library.files.property_ids.Path!]).rich_text =
    sourceRich("unexpected.md")
  f.pages.set(id(9951), extra)
  await rejectWithoutWrites()
  f.pages.delete(id(9951))
  const origin = property(property(owner.properties)[library.skills.property_ids.Origin!])
  const ownOrigin = structuredClone(origin.relation)
  origin.relation = [...(ownOrigin as unknown[]), { id: id(9952) }]
  await rejectWithoutWrites()
  origin.relation = ownOrigin
  const mainContent = property(property(owner.properties)[library.skills.property_ids.Content!])
  const ownMainContent = structuredClone(mainContent.rich_text)
  mainContent.rich_text = sourceRich(JSON.stringify(beta.main.content))
  await rejectWithoutWrites()
  mainContent.rich_text = ownMainContent
  // The original preflight still guards preserved native/resource bindings.
  const preserved = f.pages.get(beta.files.find((file) => file.path === "local.json")!.page_id)!
  const preservedPath = property(property(preserved.properties)[library.files.property_ids.Path!])
  const ownPath = structuredClone(preservedPath.rich_text)
  let enumerations = 0
  f.rewrite((path, response) => {
    if (
      path.startsWith(`v1/data_sources/${library.files.data_source_id}/query`) &&
      ++enumerations === 2
    )
      preservedPath.rich_text = sourceRich("moved-by-another-writer.json")
    return response
  })
  await rejectWithoutWrites()
  f.rewrite()
  preservedPath.rich_text = ownPath
  f.clearCalls()
  let requests = 0
  const resumed = await f.run(
    http.use(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* writePreparedCurrentSource(library, {
          prepared,
          operation_id,
          mode: "resume",
        }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              Effect.suspend(() =>
                ++requests > 200
                  ? Effect.fail(
                      fail(
                        "REQUEST_BUDGET_EXHAUSTED",
                        "The bounded resume allowance was exhausted.",
                      ),
                    )
                  : api.request(path, body, options),
              ),
          }),
        )
      }),
    ),
  )
  expect(requests).toBeLessThanOrEqual(200)
  expect(resumed).toMatchObject({
    state: "ready",
    operation_id,
    targets: expect.arrayContaining([
      expect.objectContaining({
        skill_id: "skill-alpha",
        page_id: alpha.page_id,
        status: "unchanged",
        source_files: 4,
        notion_pages: 4,
      }),
      expect.objectContaining({
        skill_id: "skill-beta",
        page_id: native.page_id,
        status: "unchanged",
        source_files: 2,
        notion_pages: 4,
      }),
      expect.objectContaining({ skill_id: "skill-zeta", state: "ready" }),
    ]),
  })
  expect(f.mutations().some((call) => call.path === `v1/pages/${native.page_id}/markdown`)).toBe(
    false,
  )
  await assertReady(f)
})

test("a preserved native reference uses the complete Source tree even without a supporting page", async () => {
  const f = currentWriteFixture(parent),
    native = await seedNative(f)
  const first = observation(),
    second = observation(secondCommit),
    http = provider([first, second])
  const initial = await f.run(prepareCurrentSourceFromDiscovery(declaration, first))
  await f.run(
    http.use(
      writePreparedCurrentSource(library, {
        prepared: initial,
        operation_id: "sparse-native-seed",
      }),
    ),
  )
  expect(f.table("files").map((row) => fieldText(row, library.files.property_ids.Path!))).toEqual([
    "local.json",
  ])
  const authored = "# Human main\n\nRead [the complete guide](vendor/guide.md).\n"
  await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        `v1/pages/${native.page_id}/markdown`,
        {
          type: "replace_content",
          replace_content: { new_str: authored },
        },
        { method: "PATCH" },
      ),
    ),
  )
  const refreshed = await f.run(prepareCurrentSourceFromDiscovery(declaration, second))
  f.clearCalls()
  expect(
    await f.run(
      http.use(
        writePreparedCurrentSource(library, {
          prepared: refreshed,
          operation_id: "sparse-native-refresh",
        }),
      ),
    ),
  ).toMatchObject({ status: "applied", state: "ready" })
  expect(f.table("files").map((row) => fieldText(row, library.files.property_ids.Path!))).toEqual([
    "local.json",
  ])
  expect(f.mutations().some((call) => call.path === `v1/pages/${native.page_id}/markdown`)).toBe(
    false,
  )
  const removed: SourceSnapshot = {
    ...second,
    members: second.members.map((member) => ({
      ...member,
      portable: {
        ...member.portable,
        files: member.portable.files.filter((file) => file.path !== "guide.md"),
      },
      git_manifest: {
        ...member.git_manifest!,
        files: member.git_manifest!.files.filter((file) => file.path !== "guide.md"),
      },
    })),
  }
  const missing = await f.run(prepareCurrentSourceFromDiscovery(declaration, removed))
  f.clearCalls()
  await expect(
    f.run(
      http.use(
        writePreparedCurrentSource(library, {
          prepared: missing,
          operation_id: "sparse-native-missing",
        }),
      ),
    ),
  ).rejects.toMatchObject({ code: "SHARED_REFERENCE_BROKEN" })
  expect(f.mutations()).toEqual([])
  await assertReady(f)
})

test("an unchanged 58-target 515-file Source completes a new apply within the default request budget with zero writes", async () => {
  const f = currentWriteFixture(parent)
  const names = Array.from({ length: 58 }, (_, index) => `member-${String(index).padStart(3, "0")}`)
  const base = observation(firstCommit, names)
  const observed: SourceSnapshot = {
    ...base,
    members: base.members.map((member, index) => {
      const files = [
        ...member.portable.files,
        ...Array.from({ length: index < 7 ? 6 : 7 }, (_, n) => ({
          path: `support-${n}.txt`,
          bytes: testBytes(`Exact support ${index}/${n}\n`),
          mode: "100644" as const,
        })),
      ]
      return {
        ...member,
        portable: { ...member.portable, files },
        git_manifest: {
          ...member.git_manifest!,
          files: files.map((file) => ({
            path: file.path,
            source_path: `${member.member_key}/${file.path}`,
            git_oid: gitOid(file.bytes),
            bytes: file.bytes.byteLength,
            mode: file.mode,
          })),
        },
      }
    }),
  }
  const selected = {
    ...declaration,
    contributions: names.map((name) => ({
      member_key: `skills/${name}`,
      skill_id: `skill-${name}`,
      mount_path: "",
      mapping: {},
      exclude: [],
    })),
  }
  const http = provider([observed])
  const prepared = await f.run(prepareCurrentSourceFromDiscovery(selected, observed))
  expect(prepared.targets).toHaveLength(58)
  expect(prepared.targets.reduce((sum, target) => sum + target.files.length, 0)).toBe(515)
  // This case measures an unchanged apply over an existing complete inventory.
  // Seed its persisted facts directly; projecting 58 owners during setup tests a
  // different write path and can consume the timeout before the budgeted scan.
  await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      const source = property(
        yield* api.request(
          "v1/pages",
          {
            parent: { type: "data_source_id", data_source_id: library.sources.data_source_id },
            properties: {
              ...currentSourceWriteProperties(library, {
                declaration: prepared.declaration,
                content: prepared.prepared_source.content,
                revision: prepared.prepared_source.revision,
              }),
              [library.sources.property_ids.Status!]: { select: { name: "ready" } },
              [library.sources.property_ids.Operation!]: { rich_text: [] },
            },
          },
          { method: "POST" },
        ),
      )
      const sourcePageId = String(source.id)
      const resource =
        "resource" in prepared.prepared_source ? prepared.prepared_source.resource : undefined
      if (resource !== undefined) {
        const uploadId = id(9000)
        if (resource.status === "needs_attachment") {
          f.uploads.set(uploadId, { status: "uploaded" })
          f.uploadedBytes.set(uploadId, resource.bytes)
        }
        const request = yield* currentOwnedResourceCreateRequest(library, {
          owner: { kind: "source", page_id: sourcePageId },
          objectId: resource.content.object_id,
          payload: resource.manifest,
          ...(resource.status === "needs_attachment"
            ? { upload: { id: uploadId, name: "source-plan.json" } }
            : {}),
        })
        yield* api.request(request.path, request.body, request.options)
      }
      const fields = library.skills.property_ids
      const rich = (value: string) => ({ rich_text: sourceRich(value) })
      for (const target of prepared.targets) {
        const main = yield* prepareCurrentWriteFile(
          target.files.find((file) => file.path === "SKILL.md")!,
        )
        yield* api.request(
          "v1/pages",
          {
            parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
            properties: {
              [fields.Name!]: { title: sourceRich(target.defaults.name) },
              [fields.Description!]: rich(target.defaults.description),
              [fields.Kind!]: { select: { name: target.kind } },
              [fields.Enabled!]: { checkbox: true },
              [fields["Default Context"]!]: { checkbox: false },
              [fields["Skill ID"]!]: rich(target.skill_id),
              [fields["Main File ID"]!]: rich(`main-${target.skill_id}`),
              [fields.Content!]: rich(canonicalSharedJson(main.content)),
              [fields["Current State"]!]: { select: { name: "ready" } },
              [fields.Operation!]: { rich_text: [] },
              [fields.Origin!]: { relation: [{ id: sourcePageId }] },
            },
          },
          { method: "POST" },
        )
      }
    }),
  )
  const pages = f.table("skills").map((row) => String(row.id))
  f.clearCalls()
  const { result, usage } = await f.run(
    http.use(
      Effect.gen(function* () {
        const api = yield* Notion
        const budget = yield* makeRequestBudget(
          "daily-scale-default",
          DEFAULT_CURRENT_INVOCATION_BUDGET,
        )
        const result = yield* writePreparedCurrentSource(library, {
          prepared,
          operation_id: "daily-scale-new-apply",
        }).pipe(
          Effect.provideService(RequestBudget, budget),
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              Effect.gen(function* () {
                yield* budget.admit(
                  body === undefined ? 0 : testBytes(JSON.stringify(body)).byteLength,
                )
                const value = yield* api.request(path, body, options)
                budget.responseBytes(testBytes(JSON.stringify(value)).byteLength)
                return value
              }),
          }),
        )
        return { result, usage: yield* budget.snapshot }
      }),
    ),
  )
  expect(result).toMatchObject({
    status: "unchanged",
    state: "ready",
    operation_id: "daily-scale-new-apply",
    source_files: 515,
  })
  expect(result.targets).toHaveLength(58)
  expect(usage.attempts).toBeLessThan(DEFAULT_CURRENT_INVOCATION_BUDGET.requests)
  expect(usage.exhausted).toBeNull()
  expect(f.mutations()).toEqual([])
  expect(f.table("skills").map((row) => String(row.id))).toEqual(pages)
  expect(f.table("files")).toHaveLength(0)
  expect(result.targets.every((target) => target.notion_pages === 1)).toBe(true)
  await assertReady(f)
}, 60_000)

test("a same-version Source apply repairs Origin and resources without recreating a removed projection File", async () => {
  const f = currentWriteFixture(parent),
    observed = observation(),
    http = provider([observed])
  const prepared = await f.run(prepareCurrentSourceFromDiscovery(directDeclaration, observed))
  const seed = await f.run(
    http.use(
      writePreparedCurrentSource(library, { prepared, operation_id: "same-version-repair-seed" }),
    ),
  )
  await seedSourceFileRows(f, prepared)
  const page = String(skillPage(f, "skill-alpha")!.id)
  const before = await f.run(queryCurrentSkillIndex(library, page))
  const missing = before.files[0]!
  f.pages.get(missing.page_id)!.in_trash = true
  property(property(f.pages.get(page)!.properties)[library.skills.property_ids.Origin!]).relation =
    []
  const resource = await f.run(
    prepareCurrentSharedResource(testBytes("Unreferenced original\n"), "100644"),
  )
  const request = await f.run(
    currentOwnedResourceCreateRequest(library, {
      owner: { kind: "skill", page_id: page },
      objectId: resource.content.object_id,
      payload: resource.manifest,
    }),
  )
  const orphan = await f.run(
    Effect.flatMap(Notion, (api) => api.request(request.path, request.body, request.options)),
  )
  f.clearCalls()
  expect(
    await f.run(
      http.use(
        writePreparedCurrentSource(library, { prepared, operation_id: "same-version-repair" }),
      ),
    ),
  ).toMatchObject({ status: "applied", state: "ready" })
  const after = await f.run(queryCurrentSkillIndex(library, page))
  expect(
    allFiles(after)
      .map((file) => file.file_id)
      .sort(),
  ).toEqual(
    allFiles(before)
      .filter((file) => file.file_id !== missing.file_id)
      .map((file) => file.file_id)
      .sort(),
  )
  expect(after.files.some((file) => file.file_id === missing.file_id)).toBe(false)
  expect(
    f.calls.filter(
      (call) =>
        call.path === "v1/pages" &&
        property(property(call.body).parent).data_source_id === library.files.data_source_id,
    ),
  ).toEqual([])
  expect(
    property(property(f.pages.get(page)!.properties)[library.skills.property_ids.Origin!]).relation,
  ).toEqual([{ id: seed.source_page_id }])
  expect(f.pages.get(String(property(orphan).id))?.in_trash).toBe(true)
  await assertReady(f)
})

test.each(["source", "skill"] as const)(
  "a new unchanged apply cannot bypass an unknown %s intent whose owner is already ready",
  async (ownerKind) => {
    const f = currentWriteFixture(parent),
      observed = observation(firstCommit, ["alpha"]),
      http = provider([observed])
    const prepared = await f.run(prepareCurrentSourceFromDiscovery(directDeclaration, observed))
    if (ownerKind === "source") {
      f.failNext({ kind: "source-ready", outcome: "accepted" })
      await expect(
        f.run(
          http.use(
            writePreparedCurrentSource(library, { prepared, operation_id: "unknown-ready-source" }),
          ),
        ),
      ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    } else {
      await f.run(
        http.use(
          writePreparedCurrentSource(library, {
            prepared,
            operation_id: "unknown-child-source-seed",
          }),
        ),
      )
      await seedSourceFileRows(f, prepared)
      const current = await f.run(
        queryCurrentSkillIndex(library, String(skillPage(f, "skill-alpha")!.id)),
      )
      const plan = await f.run(
        prepareCurrentSkillWrite({
          skill_id: current.skill_id,
          kind: current.kind,
          name: current.name,
          description: current.description,
          enabled: !current.enabled,
          files: prepared.targets[0]!.files.map((file) => ({
            ...file,
            file_id: allFiles(current).find((old) => old.path === file.path)!.file_id,
          })),
        }),
      )
      let lost = false
      await expect(
        f.run(
          http.use(
            Effect.gen(function* () {
              const api = yield* Notion
              return yield* writeCurrentSkill(library, {
                plan,
                operation_id: "unknown-ready-child",
              }).pipe(
                Effect.provideService(Notion, {
                  ...api,
                  request: (path, body, options) =>
                    api.request(path, body, options).pipe(
                      Effect.flatMap((value) => {
                        const state = property(
                          property(property(body).properties)[
                            library.skills.property_ids["Current State"]!
                          ],
                        )
                        if (
                          !lost &&
                          path === `v1/pages/${current.page_id}` &&
                          options?.method === "PATCH" &&
                          property(state.select).name === "ready"
                        ) {
                          lost = true
                          return Effect.fail(
                            fail(
                              "WRITE_OUTCOME_UNKNOWN",
                              "The ready response was lost after acceptance.",
                            ),
                          )
                        }
                        return Effect.succeed(value)
                      }),
                    ),
                }),
              )
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
      expect(lost).toBe(true)
    }
    const page = String(skillPage(f, "skill-alpha")!.id)
    expect((await f.run(queryCurrentSkillIndex(library, page))).state).toEqual({ state: "ready" })
    expect((await f.run(queryCurrentSourceManagement(library, "team-skills")))?.state).toEqual({
      state: "ready",
    })
    const entity =
      ownerKind === "source" ? "current-source:team-skills" : "current-skill:skill-alpha"
    const record = operationRecords(f).find(
      (row) => fieldText(row, library.records.property_ids["Entity ID"]!) === entity,
    )!
    expect(record).toBeDefined()
    const local = new Map(pendingKeys(f).map((key) => [key, structuredClone(f.json.get(key))]))
    expect(local.size).toBeGreaterThan(0)
    const restore = () => {
      record.in_trash = false
      for (const [key, value] of local) f.json.set(key, structuredClone(value))
    }
    for (const evidence of ["both", "remote-only", "local-only", "concurrent"] as const) {
      restore()
      if (evidence === "remote-only" || evidence === "concurrent")
        for (const key of local.keys()) f.json.delete(key)
      if (evidence === "local-only" || evidence === "concurrent") record.in_trash = true
      let appeared = false
      if (evidence === "concurrent")
        f.rewrite((path, response) => {
          if (!appeared && path === `v1/pages/${page}`) {
            restore()
            appeared = true
          }
          return response
        })
      f.clearCalls()
      await expect(
        f.run(
          http.use(
            writePreparedCurrentSource(library, {
              prepared,
              operation_id: `unchanged-${ownerKind}-${evidence}`,
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: "CURRENT_OPERATION_PENDING" })
      expect(f.mutations()).toEqual([])
      if (evidence === "concurrent") expect(appeared).toBe(true)
      f.rewrite()
    }
  },
)
