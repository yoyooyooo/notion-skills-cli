import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { Notion } from "../src/notion.ts"
import { property } from "../src/model.ts"
import { gitOnlyProjection, openGitOnlySharedConsumer } from "../src/shared-git-only-consumer.ts"
import { gitOnlyProjectionForSource } from "../src/shared-git-only-marker.ts"
import type { PlannedSharedSource } from "../src/shared-selected-source.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { fixture, library } from "./shared-source-projection-fixture.ts"
import { id, rich } from "./shared-snapshot-fixture.ts"

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")

function setup() {
  const f = fixture()
  const target = id(56002)
  const member = f.snapshot.members[0]!
  const originalIdentity = createHash("sha256")
    .update(
      canonicalSharedJson([
        "source-onboarding-v1",
        library.library_id,
        f.source.id,
        member.member_key,
      ]),
    )
    .digest("hex")
  const row = f.seedSkill(target, `skill-${originalIdentity}`, "initial-source", "skill", true)
  const props = property(row.properties)
  const pin = `source-${"1".repeat(64)}`
  props.main_file_id = rich("main_file_id", "file-git-only-main")
  props.source = rich("source", pin)
  props.projection = rich("projection", gitOnlyProjectionForSource(f.source.id))
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
  const materialized: string[][] = []
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
      Effect.sync(() => {
        materialized.push([...paths])
        return {
          files: paths.map((path) => ({
            path,
            bytes: files.find((item) => item.path === path)!.bytes,
            mode: member.git_manifest!.files.find((item) => item.path === path)!.mode,
          })),
          local_paths: [],
        }
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
    Effect.gen(function* () {
      return yield* openGitOnlySharedConsumer({
        library,
        target,
        rawPage: row,
        scope: yield* authScope,
        startedAt: Date.now(),
        fixedSource: source,
      })
    })
  return {
    f,
    source,
    row,
    target,
    files,
    materialized,
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
  expect(result.shared_acquisition?.version).toBe(4)
  expect(result.file_bindings).toHaveLength(1)
  expect(result.files.find((file) => file.path === "SKILL.md")?.sha256).toBe(
    sha(f.files.find((file) => file.path === "SKILL.md")!.bytes),
  )
  expect(result.materialization?.materialized_paths).toEqual(["SKILL.md"])
  const repeated = await f.run(f.read())
  expect(repeated.snapshot_id).toBe(result.snapshot_id)
  expect(f.f.writes()).toHaveLength(0)
  expect(f.f.files.size).toBeGreaterThan(0) // unrelated fixture content is untouched
})

test("sparse Git adopts just the edited Notion main and still refuses unverified source bytes", async () => {
  const f = setup()
  f.changeMarkdown("# Human edit\n")
  const adopted = await f.run(f.read())
  expect(adopted.shared_acquisition?.version).toBe(4)
  expect(adopted.shared_acquisition?.files.some((route) => route.path === "SKILL.md")).toBe(false)
  expect(adopted.files.find((file) => file.path === "references/a.md")?.sha256).toBe(
    sha(f.files.find((file) => file.path === "references/a.md")!.bytes),
  )
  expect(f.materialized.flat()).not.toContain("SKILL.md")
  const g = setup()
  const inconsistent = {
    ...g.source,
    manifest: g.source.manifest.map((file) =>
      file.path === "SKILL.md"
        ? { ...file, identity: { ...file.identity, sha256: "a".repeat(64) } }
        : file,
    ),
  }
  await expect(
    g.run(
      Effect.gen(function* () {
        return yield* openGitOnlySharedConsumer({
          library,
          target: g.target,
          rawPage: g.row,
          scope: yield* authScope,
          startedAt: Date.now(),
          fixedSource: inconsistent,
        })
      }),
    ),
  ).rejects.toMatchObject({ code: "SHARED_SOURCE_CONFLICT" })
})

test("sparse Git refuses changed identity and unavailable authored Members without reinterpreting upstream Git bytes", async () => {
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
  fields.origin = {
    id: "origin",
    type: "relation",
    relation: [{ id: id(4333) }],
    has_more: false,
  }
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
  await expect(f.run(f.read())).rejects.toMatchObject({ code: "SHARED_ROUTER_MEMBER_UNAVAILABLE" })
  expect(f.f.writes()).toHaveLength(0)
})

test("a completed pre-marker Git-only page remains consumable only with its deterministic original Source identity", async () => {
  const f = setup()
  const fields = property(f.row.properties)
  fields.projection = rich("projection", gitOnlyProjection)
  const original = await f.run(f.read())
  expect(original.shared_acquisition?.version).toBe(4)
  expect(original.files.some((item) => item.path === "SKILL.md")).toBe(true)
  fields.origin = {
    id: "origin",
    type: "relation",
    relation: [{ id: id(8333) }],
    has_more: false,
  }
  await expect(f.run(f.read())).rejects.toMatchObject({ code: "GIT_ONLY_SCOPE" })
  expect(f.f.writes()).toHaveLength(0)
})
