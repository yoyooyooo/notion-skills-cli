import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"
import { composeCurrentSources, parseComposeArguments } from "./cutover-compose-sources.ts"

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ah513-source-composition-"))
  const definitions = [
    { id: "origin-firecrawl", commit: "1", authority: "source", root: "skills/current" },
    { id: "origin-firecrawl", commit: "2", authority: "native", root: "skills/authored" },
    { id: "origin-lark", commit: "3", authority: "source", root: "skills/lark-old" },
    { id: "origin-lark", commit: "4", authority: "source", root: "skills/lark-new" },
    { id: "origin-pstack", commit: "5", authority: "source", root: "skills/statechart" },
    { id: "origin-pstack", commit: "6", authority: "source", root: "skills/bro" },
  ]
  const rows = definitions.map((definition, index) => {
    const bytes = new TextEncoder().encode(`current original ${index}\n`)
    const sha256 = digest(bytes)
    const git_oid = createHash("sha1")
      .update(`blob ${bytes.byteLength}\0`)
      .update(bytes)
      .digest("hex")
    const sourcePage = uuid(
      100 + ["origin-firecrawl", "origin-lark", "origin-pstack"].indexOf(definition.id),
    )
    const owner = uuid(index + 1)
    const record = uuid(index + 20)
    const local = join(directory, sha256)
    writeFileSync(local, bytes)
    const source_path = `${definition.root}/SKILL.md`
    const commit = definition.commit.repeat(40)
    const file = {
      authority: definition.authority,
      path: "SKILL.md",
      sha256,
      bytes: bytes.byteLength,
      mode: "100644",
      local_bytes_path: local,
      source: {
        source_page_id: sourcePage,
        source_id: definition.id,
        source_path,
        commit,
        git_oid,
        repository_url: "https://github.com/example/skills.git",
        root: definition.root,
        selected_record_page_id: record,
        legacy_source_carrier_id: `source-${digest(`carrier-${index}`)}`,
      },
    }
    return {
      owner: { owner_page_id: owner, files: [file] },
      manifest: {
        skill_page_id: owner,
        record_page_id: record,
        source_id: file.source.legacy_source_carrier_id,
        source: {
          url: "https://github.com/example/skills",
          commit,
          root: definition.root,
          tree: definition.commit.repeat(40),
          files: [
            {
              path: "SKILL.md",
              source_path,
              git_oid,
              sha256,
              bytes: bytes.byteLength,
              mode: "100644",
            },
          ],
        },
      },
      preflight: {
        commit,
        source_owned_file_count: definition.authority === "source" ? 1 : 0,
        owners: [
          {
            owner_page_id: owner,
            selected_record_page_id: record,
            selected_source_carrier_id: file.source.legacy_source_carrier_id,
            root: definition.root,
            source_owned_files:
              definition.authority === "source"
                ? [{ path: "SKILL.md", source_path, blob_sha: git_oid, sha256 }]
                : [],
          },
        ],
      },
    }
  })
  return {
    tree: { owners: rows.map((row) => row.owner) },
    manifests: { library_id: "library-test", git: rows.map((row) => row.manifest) },
    preflight: {
      multi_commit_sources: ["origin-firecrawl", "origin-lark", "origin-pstack"].map(
        (source_id) => {
          const members = rows.filter((row) => row.owner.files[0]!.source.source_id === source_id)
          return {
            source_id,
            source_page_id: members[0]!.owner.files[0]!.source.source_page_id,
            repository_url: "https://github.com/example/skills.git",
            selected_commit_groups: members.map((row) => row.preflight),
          }
        },
      ),
    },
  }
}

test("three audited Source groups retain active commits and exclude native-only history", async () => {
  const input = fixture()
  const output = await composeCurrentSources(input.tree, input.manifests, input.preflight)
  expect(output.source_count).toBe(3)
  expect(output.binding_count).toBe(5)
  expect(output.plans.map((plan) => plan.commits.map((commit) => commit.commit[0]))).toEqual([
    ["1"],
    ["3", "4"],
    ["5", "6"],
  ])
  expect(output.preflight_checks[0]!.excluded_native_origin_commits).toEqual(["2".repeat(40)])
  for (const plan of output.plans) {
    expect(plan.revision).toBe(digest(canonicalSharedJson(plan.plan)))
    expect(
      plan.bindings.every(
        (binding) =>
          binding.content.kind === "source" && binding.content.revision === plan.revision,
      ),
    ).toBe(true)
  }
  const reversed = await composeCurrentSources(
    { owners: [...input.tree.owners].reverse() },
    { ...input.manifests, git: [...input.manifests.git].reverse() },
    input.preflight,
  )
  expect(reversed.plans).toEqual(output.plans)
})

test("conflicting source paths from distinct fixed commits cannot overwrite one another", async () => {
  const input = fixture()
  const file = input.tree.owners[3]!.files[0]!
  file.source.root = "skills/lark-old"
  file.source.source_path = "skills/lark-old/SKILL.md"
  input.manifests.git[3]!.source.root = file.source.root
  input.manifests.git[3]!.source.files[0]!.source_path = file.source.source_path
  const expected = input.preflight.multi_commit_sources[1]!.selected_commit_groups[1]!.owners[0]!
  expected.root = file.source.root
  expected.source_owned_files[0]!.source_path = file.source.source_path
  await expect(
    composeCurrentSources(input.tree, input.manifests, input.preflight),
  ).rejects.toMatchObject({ code: "COMPOSITION_SOURCE_COLLISION" })
})

test("local original tampering is rejected before any plan is returned", async () => {
  const input = fixture()
  writeFileSync(input.tree.owners[0]!.files[0]!.local_bytes_path, "changed original\n")
  await expect(
    composeCurrentSources(input.tree, input.manifests, input.preflight),
  ).rejects.toMatchObject({ code: "ORIGINAL_BYTES_CONFLICT" })
})

test("the audited current source set cannot silently drop a binding", async () => {
  const input = fixture()
  input.tree.owners[2]!.files[0]!.authority = "native"
  await expect(
    composeCurrentSources(input.tree, input.manifests, input.preflight),
  ).rejects.toMatchObject({ code: "PREFLIGHT_BINDING_CONFLICT" })
})

test("explicit output cannot overwrite an input or accept duplicate flags", () => {
  expect(() =>
    parseComposeArguments([
      "--tree",
      "/tree",
      "--manifests",
      "/manifests",
      "--preflight",
      "/preflight",
      "--output",
      "/tree",
    ]),
  ).toThrow("Output must not replace an input")
  expect(() => parseComposeArguments(["--tree", "/tree", "--tree", "/other"])).toThrow(
    "exactly once",
  )
})
