import { describe, expect, test } from "bun:test"
import { readImportZip } from "../src/import.ts"
import { portableZip } from "../src/portable.ts"
import { composeSharedFiles } from "../src/shared-composition.ts"
import { property } from "../src/model.ts"
import {
  prepareSharedSnapshotHistory,
  retainSharedSnapshotHistory,
  restoreSharedSnapshotHistory,
} from "../src/shared-snapshot-history.ts"
import {
  digest,
  encode,
  library,
  rich,
  sharedSnapshotFixture,
  skillPage,
} from "./shared-snapshot-fixture.ts"

describe("resource executable intent", () => {
  test("portable ZIP round trips known modes without adding mode to older unknown files", () => {
    const files = [
      { path: "SKILL.md", bytes: encode("# Resource modes\n") },
      {
        path: "scripts/check.sh",
        bytes: encode("#!/bin/sh\r\nexit 17\r\n"),
        mode: "100755" as const,
      },
      { path: "assets/raw.bin", bytes: new Uint8Array([255, 0, 1]), mode: "100644" as const },
    ]
    const restored = readImportZip(
      portableZip({
        kind: "skill",
        name: "resource-modes",
        description: "Exact resources",
        main: "SKILL.md",
        files,
      }),
    )
    for (const file of files)
      expect(restored.find((value) => value.path === file.path)).toEqual(file)
  })

  test("custom replacement owns its mode and a source mode survives unchanged composition", () => {
    const result = composeSharedFiles({
      base: [
        { path: "SKILL.md", bytes: encode("# Modes") },
        { path: "a.sh", bytes: encode("source"), mode: "100755" },
        { path: "b.sh", bytes: encode("source"), mode: "100755" },
      ],
      mounts: [],
      entrypoint: "SKILL.md",
      overrides: [
        { kind: "custom", file_id: "a", path: "a.sh", bytes: encode("custom"), mode: "100644" },
      ],
    })
    expect(result.files.find((file) => file.path === "a.sh")?.mode).toBe("100644")
    expect(result.files.find((file) => file.path === "b.sh")?.mode).toBe("100755")
    expect(result.files.find((file) => file.path === "SKILL.md")?.mode).toBeUndefined()
  })

  test("retained history restores mode and bytes without guessing older entries", async () => {
    const f = sharedSnapshotFixture()
    const original = await f.open()
    const files = original.files.map((file, index) => ({
      ...file,
      ...(index === 0 ? { mode: "100755" as const } : {}),
    }))
    const version_id = digest(JSON.stringify(files))
    const snapshot = {
      ...original,
      files,
      version_id,
      snapshot_id: `s_${digest(JSON.stringify([original.scope, original.record.id, version_id]))}`,
    }
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
    f.objects.clear()
    const restored = await f.run(
      restoreSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: plan.pin_id }),
    )
    for (const file of files) {
      const actual = restored.files.find((value) => value.path === file.path)!
      expect(digest(actual.bytes)).toBe(file.sha256)
      expect(actual.mode).toBe(file.mode)
    }
  })

  test("custom native main keeps its C1 frontmatter and mode while following files use complete Selected C2 values", async () => {
    for (const frontmatter of ["---\nlicense: C1-only\nx-source: original\n---\n", ""]) {
      const f = sharedSnapshotFixture()
      const bindings = [
        { file_id: "file-main", page: skillPage, path: "SKILL.md" },
        ...f.files.map((file, index) => ({
          file_id: `file-${index + 1}`,
          page: file.id,
          path: `references/${index + 1}.md`,
        })),
      ]
      for (const binding of bindings)
        f.seedFact(
          {
            event_id: `project-${binding.file_id}`,
            file_id: binding.file_id,
            parents: [],
            kind: "projected",
            source_revision: "C1",
            projection: { normalization_version: 1, sha256: digest(f.bodies.get(binding.page)!) },
            mode: "100644",
            ...(binding.path === "SKILL.md" ? { frontmatter } : {}),
          },
          "file_event",
          binding.file_id,
          `project-${binding.file_id}`,
        )
      property(f.main.properties).source = rich("source", "source-C1")
      await f.open({
        fixedSource: {
          source_id: "source-C1",
          revision: "C1",
          files: bindings.map((binding) => ({
            path: binding.path,
            bytes: encode(
              `${binding.path === "SKILL.md" ? frontmatter : ""}${f.bodies.get(binding.page)!}`,
            ),
            mode: "100644" as const,
          })),
        },
      })
      f.bodies.set(skillPage, "# My N1 body\n")
      f.main.last_edited_time = new Date(
        Date.parse(String(f.main.last_edited_time)) + 1,
      ).toISOString()
      property(f.main.properties).source = rich("source", "source-C2")
      const selected = await f.open({
        fixedSource: {
          source_id: "source-C2",
          revision: "C2",
          files: bindings.map((binding) => ({
            path: binding.path,
            bytes: encode(
              binding.path === "SKILL.md"
                ? "---\nlicense: C2-only\nx-new: new\n---\n# New C2 main\n"
                : `C2 ${binding.path}\n`,
            ),
            mode: "100755" as const,
          })),
        },
      })
      const main = selected.files.find((file) => file.path === "SKILL.md")!
      const body = new TextDecoder().decode(f.objects.get(`objects/${main.sha256}`))
      expect(main.mode).toBe("100644")
      expect(body).toContain("# My N1 body")
      expect(body).not.toContain("C2-only")
      expect(body).not.toContain("x-new")
      expect(body.includes("C1-only")).toBe(frontmatter !== "")
      const following = selected.files.find((file) => file.path === "references/1.md")!
      expect(following.mode).toBe("100755")
      expect(following.sha256).toBe(digest("C2 references/1.md\n"))
    }
  })
})
