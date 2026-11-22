import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import type { Snapshot } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef, parseRef } from "../src/ref.ts"
import { sharedSkillId } from "../src/shared-content.ts"
import { prepareCurrentSharedSourceContent } from "../src/shared-current-source.ts"
import { currentSourceWriteProperties } from "../src/shared-current-source-management.ts"
import { resolveCurrentSourceReference } from "../src/shared-source-references.ts"
import { currentWriteFixture, id, library, testBytes } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-source-references-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
const commit = "a".repeat(40)
const files = ["skills/alpha/SKILL.md", "skills/beta/SKILL.md", "docs/guide.md"].map((path) => {
  const bytes = testBytes(`# ${path}\n`)
  return {
    path,
    source_path: path,
    bytes: bytes.length,
    mode: "100644" as const,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    git_oid: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
  }
})

async function setup(enabled = true) {
  const f = currentWriteFixture(parent)
  const selected = await f.run(
    prepareCurrentSharedSourceContent({
      version: 1,
      kind: "composition",
      mounts: [],
      base: {
        kind: "git",
        source: {
          url: "https://github.com/example/skills",
          commit,
          tree: "b".repeat(40),
          root: "",
          files,
        },
      },
    }),
  )
  const properties = currentSourceWriteProperties(library, {
    declaration: {
      version: 1,
      definition: {
        version: 1,
        source_id: "managed",
        name: "Managed",
        description: "Exact source",
        enabled,
        policy: "manual",
        adapter: { type: "git", url: "https://github.com/example/skills", ref: "main" },
        selection: { roots: ["skills"], include: [], exclude: [], mapping: {} },
        options: {},
      },
      contributions: [
        { member_key: "skills/alpha", skill_id: "alpha", mount_path: "", mapping: {}, exclude: [] },
        { member_key: "skills/beta", skill_id: "beta", mount_path: "", mapping: {}, exclude: [] },
      ],
    },
    content: selected.content,
    revision: selected.revision,
  })
  await f.run(
    Effect.gen(function* () {
      return yield* (yield* Notion).request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library.sources.data_source_id },
          properties: {
            ...properties,
            [library.sources.property_ids.Status!]: { select: { name: "ready" } },
            [library.sources.property_ids.Operation!]: { rich_text: [] },
          },
        },
        { method: "POST" },
      )
    }),
  )
  const skill = sharedSkillId(library.library_id, "alpha")
  const snapshot: Snapshot = {
    snapshot_id: "s_" + "c".repeat(64),
    scope: "d".repeat(64),
    version_id: "e".repeat(64),
    created_at: Date.now(),
    entrypoint: "SKILL.md",
    record: {
      id: skill,
      kind: "skill",
      name: "alpha",
      alias: "alpha",
      description: "Current alpha",
      enabled: true,
      default_context: false,
      entrypoint: "SKILL.md",
      ref: fileRef(skill, "SKILL.md"),
      locator: {
        type: "shared_skill",
        library_id: library.library_id,
        skill_id: "alpha",
        page_id: id(800),
        database_id: library.skills.database_id,
        data_source_id: library.skills.data_source_id,
      },
    },
    files: [
      { path: "SKILL.md", sha256: files[0]!.sha256, bytes: files[0]!.bytes, mode: files[0]!.mode },
    ],
    file_bindings: [{ path: "SKILL.md", file_id: "main-alpha", page_id: id(800) }],
    shared_acquisition: {
      version: 5,
      library,
      files: [
        {
          kind: "source",
          path: "SKILL.md",
          source_id: "managed",
          revision: selected.revision,
          source_path: files[0]!.path,
        },
      ],
    },
  }
  f.clearCalls()
  return { f, snapshot }
}

test("repository-relative sibling links resolve through one current Source contribution map", async () => {
  const { f, snapshot } = await setup()
  const result = await f.run(
    resolveCurrentSourceReference(snapshot, "SKILL.md", "../beta/SKILL.md"),
  )
  expect(parseRef(result)).toMatchObject({
    selector: sharedSkillId(library.library_id, "beta"),
    path: "SKILL.md",
  })
  expect(f.mutations()).toEqual([])
  expect(f.downloads).toEqual([])
})

test("outside-member repository references expose their exact fixed upstream location", async () => {
  const { f, snapshot } = await setup()
  await expect(
    f.run(resolveCurrentSourceReference(snapshot, "SKILL.md", "../../docs/guide.md")),
  ).rejects.toMatchObject({
    code: "CURRENT_SOURCE_EXTERNAL_REFERENCE",
    details: {
      source_id: "managed",
      source_path: "docs/guide.md",
      commit,
      url: `https://github.com/example/skills/blob/${commit}/docs/guide.md`,
    },
  })
  await expect(
    f.run(resolveCurrentSourceReference(snapshot, "SKILL.md", "../../missing.md")),
  ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" })
  expect(f.mutations()).toEqual([])
})

test("a mounted path collision cannot override the original Source-relative target", async () => {
  const { f, snapshot } = await setup()
  const from = "references/nested/main.md",
    collision = "references/beta/SKILL.md"
  const mounted: Snapshot = {
    ...snapshot,
    entrypoint: from,
    files: [
      { ...snapshot.files[0]!, path: from },
      { ...snapshot.files[0]!, path: collision },
    ],
    file_bindings: [
      { ...snapshot.file_bindings![0]!, path: from },
      { path: collision, file_id: "collision", page_id: id(801) },
    ],
    shared_acquisition: {
      ...snapshot.shared_acquisition!,
      files: [{ ...snapshot.shared_acquisition!.files[0]!, path: from }],
    },
  }
  expect(
    parseRef(await f.run(resolveCurrentSourceReference(mounted, from, "../beta/SKILL.md"))),
  ).toEqual({ selector: sharedSkillId(library.library_id, "beta"), path: "SKILL.md" })
  expect(f.mutations()).toEqual([])
  expect(f.downloads).toEqual([])
})

test("duplicate mounts of one Source file require an explicit target instead of selecting the first", async () => {
  const { f, snapshot } = await setup()
  const ambiguous: Snapshot = {
    ...snapshot,
    files: [...snapshot.files, { ...snapshot.files[0]!, path: "copy/SKILL.md" }],
    shared_acquisition: {
      ...snapshot.shared_acquisition!,
      files: [
        ...snapshot.shared_acquisition!.files,
        {
          ...snapshot.shared_acquisition!.files[0]!,
          path: "copy/SKILL.md",
        },
      ],
    },
  }
  await expect(
    f.run(resolveCurrentSourceReference(ambiguous, "SKILL.md", "./SKILL.md", { offline: true })),
  ).rejects.toMatchObject({ code: "CURRENT_SOURCE_REFERENCE_AMBIGUOUS" })
  expect(f.calls).toEqual([])
})

test("fixed local links need no remote query while cross-member offline and disabled reads fail", async () => {
  const { f, snapshot } = await setup()
  const local = await f.run(
    resolveCurrentSourceReference(snapshot, "SKILL.md", "./SKILL.md", { offline: true }),
  )
  expect(parseRef(local)).toMatchObject({ snapshot: snapshot.snapshot_id, file_id: "main-alpha" })
  await expect(
    f.run(
      resolveCurrentSourceReference(snapshot, "SKILL.md", "../beta/SKILL.md", { offline: true }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_SOURCE_REFERENCE_UNAVAILABLE" })
  expect(f.calls).toEqual([])
  const disabled = await setup(false)
  await expect(
    disabled.f.run(
      resolveCurrentSourceReference(disabled.snapshot, "SKILL.md", "../beta/SKILL.md"),
    ),
  ).rejects.toMatchObject({ code: "SOURCE_DISABLED" })
  expect(disabled.f.mutations()).toEqual([])
})
