import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { Notion } from "../src/notion.ts"
import { property } from "../src/model.ts"
import { gitOnlyProjection, openGitOnlySharedConsumer } from "../src/shared-git-only-consumer.ts"
import type { PlannedSharedSource } from "../src/shared-selected-source.ts"
import { fixture, library } from "./shared-source-projection-fixture.ts"
import { id, rich } from "./shared-snapshot-fixture.ts"

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")

function setup() {
  const f = fixture()
  const target = id(56002)
  const row = f.seedSkill(target, "git-only-member", "initial-source", "skill", true)
  const props = property(row.properties)
  const member = f.snapshot.members[0]!
  const pin = `source-${"1".repeat(64)}`
  props.main_file_id = rich("main_file_id", "file-git-only-main")
  props.source = rich("source", pin)
  props.projection = rich("projection", gitOnlyProjection)
  props.references = rich("references", "")
  props.source_member = rich("source_member", member.member_key)
  props.origin = {
    id: "origin",
    type: "relation",
    relation: [{ id: f.source.id }],
    has_more: false,
  }
  props.members = { id: "members", type: "relation", relation: [], has_more: false }
  const files = member.portable.files
  const source: PlannedSharedSource = {
    source_id: pin,
    revision: f.snapshot.revision,
    git_member_root: member.member_key,
    manifest: member.git_manifest!.files.map((entry) => ({
      path: entry.path,
      bytes: entry.bytes,
      mode: entry.mode,
      identity: {
        kind: "git" as const,
        git_oid: entry.git_oid,
        sha256: sha(files.find((file) => file.path === entry.path)!.bytes),
      },
    })),
    local_paths: [],
    materialize: (paths) =>
      Effect.succeed({
        files: paths.map((path) => ({
          path,
          bytes: files.find((item) => item.path === path)!.bytes,
          mode: files.find((item) => item.path === path)!.mode,
        })),
        local_paths: [],
      }),
  }
  let markdown = ""
  const run: typeof f.run = (task) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* task.pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              path === `v1/pages/${target}/markdown?markdown_version=v2`
                ? Effect.succeed({ id: target, markdown, truncated: false, unknown_block_ids: [] })
                : api.request(path, body, options),
          }),
        )
      }),
    )
  const read = () =>
    openGitOnlySharedConsumer({
      library,
      target,
      rawPage: row,
      scope: "test-scope",
      startedAt: Date.now(),
      fixedSource: source,
    })
  return {
    f,
    source,
    row,
    target,
    files,
    read,
    run,
    changeMarkdown: (next: string) => {
      markdown = next
    },
  }
}

test("Git-only current snapshot retains the full pinned directory but downloads and caches only the exact original main", async () => {
  const f = setup()
  const result = await f.run(f.read())
  expect(result.record.locator.type).toBe("shared_skill")
  expect(result.files).toHaveLength(f.files.length)
  expect(result.shared_acquisition?.version).toBe(2)
  expect(result.file_bindings).toBeUndefined()
  expect(result.files.find((file) => file.path === "SKILL.md")?.sha256).toBe(
    sha(f.files.find((file) => file.path === "SKILL.md")!.bytes),
  )
  expect(result.materialization?.materialized_paths).toEqual(["SKILL.md"])
  const repeated = await f.run(f.read())
  expect(repeated.snapshot_id).toBe(result.snapshot_id)
  expect(f.f.writes()).toHaveLength(0)
  expect(f.f.files.size).toBeGreaterThan(0) // unrelated fixture content is untouched
})

test("Git-only source cannot hide custom Notion content, native File bindings or unverified bytes", async () => {
  const f = setup()
  f.changeMarkdown("# Human edit\n")
  await expect(f.run(f.read())).rejects.toMatchObject({ code: "GIT_ONLY_CUSTOM_TAKEOVER" })
  f.changeMarkdown("")
  const inconsistent = {
    ...f.source,
    manifest: f.source.manifest.map((file) =>
      file.path === "SKILL.md"
        ? { ...file, identity: { ...file.identity, sha256: "a".repeat(64) } }
        : file,
    ),
  }
  await expect(
    f.run(
      openGitOnlySharedConsumer({
        library,
        target: f.target,
        rawPage: f.row,
        scope: "test-scope",
        startedAt: Date.now(),
        fixedSource: inconsistent,
      }),
    ),
  ).rejects.toMatchObject({ code: "GIT_ONLY_SOURCE_INCOMPLETE" })
})

test("Git-only refuses a changed member, missing origin or authored Members without reinterpreting upstream Git bytes", async () => {
  const f = setup()
  const fields = property(f.row.properties)
  fields.source_member = rich("source_member", "skills/wrong")
  await expect(f.run(f.read())).rejects.toMatchObject({ code: "GIT_ONLY_SCOPE" })
  fields.source_member = rich("source_member", "skills/demo")
  fields.origin = { id: "origin", type: "relation", relation: [], has_more: false }
  await expect(f.run(f.read())).rejects.toMatchObject({ code: "GIT_ONLY_SCOPE" })
  fields.origin = {
    id: "origin",
    type: "relation",
    relation: [{ id: f.f.source.id }],
    has_more: false,
  }
  fields.members = {
    id: "members",
    type: "relation",
    relation: [{ id: id(123) }],
    has_more: false,
  }
  await expect(f.run(f.read())).rejects.toMatchObject({ code: "GIT_ONLY_RELATION_REVIEW" })
  expect(f.f.writes()).toHaveLength(0)
})
