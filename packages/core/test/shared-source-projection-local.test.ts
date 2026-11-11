import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { decode, property } from "../src/model.ts"
import type { PortableSkill } from "../src/portable.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import {
  executeSharedCreate,
  loadSharedCreatePlan,
  reconcileSharedCreate,
} from "../src/shared-create.ts"
import { validateSharedCreatePlan } from "../src/shared-create-model.ts"
import { verifySharedCreatedSnapshot } from "../src/shared-create-verification.ts"
import { FileEventSchema, resolveFileState } from "../src/shared-file-state.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { loadSharedResourceContent } from "../src/shared-resource-content.ts"
import { readSourceDefinition } from "../src/shared-source-definitions.ts"
import { prepareSharedSourceProjection } from "../src/shared-source-projection.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"
import { fixture, library, fixedProjection } from "./shared-source-projection-fixture.ts"
import { encode } from "./shared-snapshot-fixture.ts"

function revision(
  original: SourceSnapshot,
  files: PortableSkill["files"],
  commit = "c".repeat(40),
): SourceSnapshot {
  const member = original.members[0]!
  return {
    ...original,
    revision: commit,
    members: [
      {
        ...member,
        portable: { ...member.portable, files },
        git_manifest: {
          commit,
          tree: "d".repeat(40),
          root: "skills/demo",
          files: files.map((file) => ({
            path: file.path,
            source_path: `skills/demo/${file.path}`,
            bytes: file.bytes.length,
            mode: file.mode!,
            git_oid: createHash("sha1")
              .update(Buffer.from(`blob ${file.bytes.length}\0`))
              .update(file.bytes)
              .digest("hex"),
          })),
        },
      },
    ],
  }
}

const prepare = (
  f: ReturnType<typeof fixture>,
  acquired: SourceSnapshot,
  files: PortableSkill["files"],
  baseline = f.snapshot,
  markdownImport = false,
) =>
  f.run(
    Effect.gen(function* () {
      return yield* prepareSharedSourceProjection({
        library,
        definition: yield* readSourceDefinition(library, f.source.id),
        acquired,
        member: "skills/demo",
        skillId: "local-source-skill",
        enabled: true,
        ...(markdownImport ? { markdownImport: true as const } : {}),
        local: { baseline, files },
      })
    }),
  )

describe("complete local customization of a proven immutable C1", () => {
  test("Notion formatting preserves C1 ancestry, custom overrides and deleted documents while following files consume C2", async () => {
    const f = fixture(
      [{ path: "old.md", bytes: encode("# Old document\n\nKeep its history.\n"), mode: "100644" }],
      {
        recovery: true,
        readback: (wire) => wire.replace(/<h1>(.*?)<\/h1>/u, "### $1") + "\n",
      },
    )
    const original = f.snapshot.members[0]!.portable.files
    const selectedFiles = original.map((file) =>
      file.path === "data/options.json" ? { ...file, bytes: encode('{"selected":"C2"}\n') } : file,
    )
    const selected = revision(f.snapshot, selectedFiles)
    f.registerSnapshot(selected)
    const local = original
      .filter((file) => file.path !== "old.md")
      .map((file) =>
        file.path === "SKILL.md"
          ? {
              ...file,
              bytes: encode(
                "---\nname: Authored local\ndescription: Keep local intent\nlicense: Local\n---\n\n# N1 main\n\n[Guide](references/a.md)\n",
              ),
            }
          : file.path === "references/a.md"
            ? { ...file, bytes: encode("# N1 guide\n\nKeep these custom instructions.\n") }
            : file.path === "scripts/run.js"
              ? { ...file, bytes: encode("#!/usr/bin/env node\nconsole.log('local')\n") }
              : file,
      )
    const plan = await prepare(f, selected, local, f.snapshot, true)
    expect(plan.files.every((file) => file.projection.version === 14)).toBe(true)
    const frozen = canonicalSharedJson(plan)
    const created = await f.run(executeSharedCreate(library, { plan, mode: "create" }))
    const records = await f.run(
      querySharedRecords(library, { skillPageId: created.skill_page_id, kind: "file_event" }),
    )
    const events = records.map((row) => decode(FileEventSchema, row.payload))
    for (const file of plan.files) {
      const actual = resolveFileState(
        file.file_id,
        events.filter((event) => event.file_id === file.file_id),
      )
      expect(actual.ownership.kind).toBe(file.path === "old.md" ? "tombstone" : "custom")
      for (const ancestor of file.ancestors ?? []) expect(events).toContainEqual(ancestor)
      expect(file.ancestors?.[0]).toMatchObject({ source_revision: f.snapshot.revision })
      if (file.event.kind === "deleted") {
        expect(actual.heads).toEqual([file.event.event_id])
        expect(actual.ownership).toEqual({ kind: "tombstone", retained: file.event.retained })
      } else expect(actual.heads).not.toEqual([file.event.event_id])
    }
    expect(created.expected_source_projection?.source_revision).toBe(selected.revision)
    for (const before of fixedProjection(plan).local!.baseline_inputs) {
      const body = await f.run(
        loadSharedResourceContent(library, {
          skillPageId: created.skill_page_id,
          content: before.prepared.content,
        }),
      )
      expect(body.bytes).toEqual(
        new Uint8Array(original.find((file) => file.path === before.path)!.bytes),
      )
    }
    f.base.json.clear()
    f.base.objects.clear()
    f.clear()
    const snapshot = await f.run(
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: created.skill_page_id,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly: true,
        })
      }),
    )
    expect(snapshot.files.some((file) => file.path === "old.md")).toBe(false)
    const main = snapshot.files.find((file) => file.path === "SKILL.md")!
    const mainText = new TextDecoder().decode(f.base.objects.get(`objects/${main.sha256}`))
    expect(mainText).toContain("### N1 main")
    expect(mainText).toContain('"license": "Local"')
    const guide = snapshot.files.find((file) => file.path === "references/a.md")!
    expect(new TextDecoder().decode(f.base.objects.get(`objects/${guide.sha256}`))).toContain(
      "### N1 guide",
    )
    for (const path of ["data/options.json", "scripts/run.js", "assets/icon.png"]) {
      const file = snapshot.files.find((file) => file.path === path)!
      const expected = (path === "scripts/run.js" ? local : selectedFiles).find(
        (file) => file.path === path,
      )!
      expect(f.base.objects.get(`objects/${file.sha256}`)).toEqual(expected.bytes)
      expect(file.mode).toBe(expected.mode)
    }
    expect(() => verifySharedCreatedSnapshot(snapshot, created)).not.toThrow()
    const restored = await f.run(
      loadSharedCreatePlan(library, {
        skillPageId: created.skill_page_id,
        operationId: plan.operation_id,
      }),
    )
    expect(canonicalSharedJson(restored)).toBe(frozen)
    expect((await f.run(reconcileSharedCreate(library, restored))).reused).toBe(true)
    expect(f.writes()).toHaveLength(0)
  })

  test("C1 ancestry and N1 bytes remain independent from selected C2 through cold complete consumption", async () => {
    const f = fixture(),
      originals = f.snapshot.members[0]!.portable.files
    const currentFiles: PortableSkill["files"] = [
      ...originals.map((file) =>
        file.path === "references/a.md"
          ? {
              ...file,
              bytes: encode("# C2 guide\n\n[Options](../data/options.json)\n"),
              mode: "100755" as const,
            }
          : file.path === "data/options.json"
            ? { ...file, bytes: encode('{"selected":"C2"}\n') }
            : file,
      ),
      { path: "new-upstream.bin", bytes: new Uint8Array([4, 3, 2, 1]), mode: "100644" },
    ]
    const selected = revision(f.snapshot, currentFiles)
    f.registerSnapshot(selected)
    const local: PortableSkill["files"] = [
      ...originals
        .filter((file) => file.path !== "assets/icon.png")
        .map((file) =>
          file.path === "SKILL.md"
            ? {
                ...file,
                mode: "100755" as const,
                bytes: encode(
                  "---\nname: Local authored name\ndescription: Local authored description\nlicense: Local license\nallowed-tools: [Read]\n---\n\n# N1 main\n\n[Guide](references/a.md) [Script](scripts/run.js) [New](notes.md)\n",
                ),
              }
            : file.path === "scripts/run.js"
              ? {
                  ...file,
                  bytes: encode("#!/usr/bin/env node\nconsole.log('N1')\n"),
                  mode: "100644" as const,
                }
              : file,
        ),
      {
        path: "notes.md",
        bytes: encode("# New authored document\n\n[Local](new.json)\n"),
        mode: "100755",
      },
      { path: "new.json", bytes: encode('{"new":"N1"}\r\n'), mode: "100644" },
    ]
    const plan = await prepare(f, selected, local)
    expect(plan.name).toBe("Local authored name")
    expect(plan.description).toBe("Local authored description")
    expect(fixedProjection(plan).binding.commit).toBe(selected.revision)
    expect(fixedProjection(plan).local?.baseline.commit).toBe(f.snapshot.revision)
    expect(fixedProjection(plan).local?.baseline_inputs.map((file) => file.path)).toEqual([
      "SKILL.md",
      "assets/icon.png",
      "scripts/run.js",
    ])
    expect(plan.files.find((file) => file.path === "references/a.md")?.event.kind).toBe("projected")
    expect(plan.resources?.map((file) => [file.path, file.event.kind])).toEqual([
      ["assets/icon.png", "deleted"],
      ["new.json", "adopted"],
      ["scripts/run.js", "adopted"],
    ])
    const created = await f.run(executeSharedCreate(library, { plan, mode: "create" }))
    const records = await f.run(
      querySharedRecords(library, { skillPageId: created.skill_page_id, kind: "file_event" }),
    )
    const events = records.map((row) => decode(FileEventSchema, row.payload))
    for (const file of [...plan.files, ...(plan.resources ?? [])]) {
      const actual = resolveFileState(
        file.file_id,
        events.filter((event) => event.file_id === file.file_id),
      )
      expect(actual.heads).toEqual([file.event.event_id])
      expect(actual.ownership.kind).toBe(
        file.event.kind === "projected"
          ? "following"
          : file.event.kind === "deleted"
            ? "tombstone"
            : "custom",
      )
    }
    const raw = plan.resources?.find((file) => file.path === "scripts/run.js")!
    expect(raw.ancestors?.[0]?.kind).toBe("resource_followed")
    expect(property(raw.ancestors?.[0]).source_revision).toBe(f.snapshot.revision)
    f.base.objects.clear()
    f.base.json.clear()
    const snapshot = await f.run(
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: created.skill_page_id,
          scope: yield* authScope,
          startedAt: Date.now(),
          readOnly: true,
          forceFull: true,
        })
      }),
    )
    expect(snapshot.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "data/options.json",
      "new-upstream.bin",
      "new.json",
      "notes.md",
      "references/a.md",
      "scripts/run.js",
    ])
    for (const path of ["scripts/run.js", "new.json"]) {
      const expected = local.find((file) => file.path === path)!,
        actual = snapshot.files.find((file) => file.path === path)!
      expect(actual.mode).toBe(expected.mode)
      expect(f.base.objects.get(`objects/${actual.sha256}`)).toEqual(expected.bytes)
    }
    for (const path of ["data/options.json", "new-upstream.bin", "references/a.md"]) {
      const expected = currentFiles.find((file) => file.path === path)!,
        actual = snapshot.files.find((file) => file.path === path)!
      expect(actual.mode).toBe(expected.mode)
      expect(f.base.objects.get(`objects/${actual.sha256}`)).toEqual(expected.bytes)
    }
    const main = snapshot.files.find((file) => file.path === "SKILL.md")!
    const body = new TextDecoder().decode(f.base.objects.get(`objects/${main.sha256}`))
    expect(body).toContain("N1 main")
    expect(body).toContain('"license": "Local license"')
    expect(body).toContain('"name": "Local authored name"')
    expect(main.mode).toBe("100755")
    expect(() => verifySharedCreatedSnapshot(snapshot, created)).not.toThrow()
    for (const before of fixedProjection(plan).local!.baseline_inputs) {
      const loaded = await f.run(
        loadSharedResourceContent(library, {
          skillPageId: created.skill_page_id,
          content: before.prepared.content,
        }),
      )
      expect(loaded.bytes).toEqual(
        new Uint8Array(originals.find((file) => file.path === before.path)!.bytes),
      )
    }
    const restored = await f.run(
      loadSharedCreatePlan(library, {
        skillPageId: created.skill_page_id,
        operationId: plan.operation_id,
      }),
    )
    expect(canonicalSharedJson(restored)).toBe(canonicalSharedJson(plan))
    f.clear()
    expect((await f.run(reconcileSharedCreate(library, restored))).reused).toBe(true)
    expect(f.writes()).toHaveLength(0)
  })

  test("unchanged C1 input stays following selected C2 and empty relation intent creates no custom fact", async () => {
    const f = fixture(),
      files = f.snapshot.members[0]!.portable.files
    const selected = revision(
      f.snapshot,
      files.map((file) =>
        file.path === "references/a.md" ? { ...file, bytes: encode("# New C2 guide\n") } : file,
      ),
    )
    f.registerSnapshot(selected)
    const plan = await f.run(
      Effect.gen(function* () {
        return yield* prepareSharedSourceProjection({
          library,
          definition: yield* readSourceDefinition(library, f.source.id),
          acquired: selected,
          member: "skills/demo",
          local: {
            baseline: f.snapshot,
            files,
            relations: {
              version: 1,
              ownership: "notion",
              library_id: library.library_id,
              members: [],
            },
          },
        })
      }),
    )
    expect(
      plan.files.every(
        (file) =>
          file.event.kind === "projected" && file.event.source_revision === selected.revision,
      ),
    ).toBe(true)
    expect(fixedProjection(plan).local?.baseline_inputs).toEqual([])
    expect(plan.resources).toEqual([])
    expect(plan.files.find((file) => file.path === "references/a.md")?.input.text).toContain(
      "New C2 guide",
    )
    expect(f.writes()).toHaveLength(0)
  })

  test("unchanged C1 paths removed by C2 require an explicit decision; forged original bytes never publish", async () => {
    const f = fixture(),
      files = f.snapshot.members[0]!.portable.files
    const selected = revision(
      f.snapshot,
      files.filter((file) => file.path !== "data/options.json"),
    )
    f.registerSnapshot(selected)
    await expect(prepare(f, selected, files)).rejects.toMatchObject({
      code: "SOURCE_LOCAL_BASELINE_REMOVED",
    })
    expect(f.writes()).toHaveLength(0)
    const g = fixture(),
      local = g.snapshot.members[0]!.portable.files.map((file) =>
        file.path === "scripts/run.js" ? { ...file, bytes: encode("local N1\n") } : file,
      )
    const plan = await prepare(g, g.snapshot, local)
    const original = fixedProjection(plan).local!
    const forged = {
      ...plan,
      source_projection: {
        ...plan.source_projection!,
        local: {
          ...original,
          baseline_inputs: original.baseline_inputs.map((file) => ({
            ...file,
            prepared: { ...file.prepared, content: { ...file.prepared.content, mode: "100644" } },
          })),
        },
      },
    }
    await expect(g.run(validateSharedCreatePlan(forged))).rejects.toThrow()
    expect(g.writes()).toHaveLength(0)
  })
})
