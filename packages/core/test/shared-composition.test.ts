import { describe, expect, test } from "bun:test"
import { SkillsError } from "../src/model.ts"
import { composeSharedFiles, type ComposeSharedFilesInput } from "../src/shared-composition.ts"

const bytes = (value: string) => new TextEncoder().encode(value)
const file = (path: string, value = path) => ({ path, bytes: bytes(value) })
const compose = (input: Partial<ComposeSharedFilesInput> = {}) =>
  composeSharedFiles({
    base: [file("SKILL.md", "Canonical main supplied by the caller")],
    mounts: [],
    overrides: [],
    entrypoint: "SKILL.md",
    ...input,
  })

describe("shared effective file composition", () => {
  test("combines Git files, resolved HTTP and local mounts, and a Notion whole-file override", () => {
    const script = bytes('#!/bin/sh\r\nprintf "original"\r\n')
    const custom = bytes('#!/bin/sh\r\nprintf "custom"\r\n')
    const httpAsset = new Uint8Array([0, 255, 10, 13, 128])
    const localAsset = new Uint8Array([239, 187, 191, 65, 13, 10])
    const result = compose({
      base: [file("SKILL.md"), { path: "scripts/run.sh", bytes: script }],
      mounts: [
        { mount_path: "assets/http", files: [{ path: "sample.bin", bytes: httpAsset }] },
        { mount_path: "local/scoped", files: [{ path: "notes.txt", bytes: localAsset }] },
      ],
      overrides: [
        { kind: "custom", file_id: "notion-script", path: "scripts/run.sh", bytes: custom },
      ],
    })
    expect(result.files.map((value) => value.path)).toEqual([
      "SKILL.md",
      "assets/http/sample.bin",
      "local/scoped/notes.txt",
      "scripts/run.sh",
    ])
    expect(result.files.find((value) => value.path === "scripts/run.sh")?.bytes).toBe(custom)
    expect(result.files.find((value) => value.path === "assets/http/sample.bin")?.bytes).toBe(
      httpAsset,
    )
    expect(result.files.find((value) => value.path === "local/scoped/notes.txt")?.bytes).toBe(
      localAsset,
    )
    expect(script).toEqual(bytes('#!/bin/sh\r\nprintf "original"\r\n'))
    expect(result.provenance.get("scripts/run.sh")).toEqual({
      kind: "custom",
      file_id: "notion-script",
      replaces: { kind: "base", source_path: "scripts/run.sh" },
    })
    expect(result.provenance.get("assets/http/sample.bin")).toEqual({
      kind: "mount",
      mount_path: "assets/http",
      source_path: "sample.bin",
    })
  })

  test("keeps a custom file after its upstream source disappears", () => {
    const custom = bytes("kept user content")
    const result = compose({
      overrides: [
        { kind: "custom", file_id: "custom-only", path: "removed-upstream.txt", bytes: custom },
      ],
    })
    expect(result.files.find((value) => value.path === "removed-upstream.txt")?.bytes).toBe(custom)
    expect(result.provenance.get("removed-upstream.txt")).toEqual({
      kind: "custom",
      file_id: "custom-only",
    })
  })

  test("a tombstone remains effective when upstream advances or reintroduces the file", () => {
    const overrides = [
      { kind: "tombstone", file_id: "deleted-file", path: "old.txt" },
    ] satisfies ComposeSharedFilesInput["overrides"]
    for (const base of [
      [file("SKILL.md"), file("old.txt", "v1")],
      [file("SKILL.md")],
      [file("SKILL.md"), file("old.txt", "v3 returned")],
    ]) {
      const result = compose({ base, overrides })
      expect(result.files.some((value) => value.path === "old.txt")).toBe(false)
      expect(result.provenance.has("old.txt")).toBe(false)
    }
  })

  test("custom bytes remain authoritative across source changes while untouched files advance", () => {
    const custom = bytes("user whole-file revision")
    const overrides = [
      { kind: "custom", file_id: "edited-file", path: "owned.txt", bytes: custom },
    ] satisfies ComposeSharedFilesInput["overrides"]
    const first = compose({
      base: [file("SKILL.md"), file("owned.txt", "source 1"), file("following.txt", "source 1")],
      overrides,
    })
    const next = compose({
      base: [file("SKILL.md"), file("owned.txt", "source 2"), file("following.txt", "source 2")],
      overrides,
    })
    expect(first.files.find((value) => value.path === "owned.txt")?.bytes).toBe(custom)
    expect(next.files.find((value) => value.path === "owned.txt")?.bytes).toBe(custom)
    expect(next.files.find((value) => value.path === "following.txt")?.bytes).toEqual(
      bytes("source 2"),
    )
  })

  test("sorts files and provenance deterministically without changing input arrays", () => {
    const a = [file("z.txt"), file("SKILL.md"), file("a.txt")]
    const b = [...a].reverse()
    const first = compose({ base: a })
    const next = compose({ base: b })
    expect(first.files).toEqual(next.files)
    expect([...first.provenance]).toEqual([...next.provenance])
    expect(a.map((value) => value.path)).toEqual(["z.txt", "SKILL.md", "a.txt"])
  })

  test("supports a root mount and overlapping directory prefixes with disjoint outputs", () => {
    const result = compose({
      mounts: [
        { mount_path: "", files: [file("root.txt")] },
        { mount_path: "assets", files: [file("one.txt")] },
        { mount_path: "assets/nested", files: [file("two.txt")] },
      ],
    })
    expect(result.files.map((value) => value.path)).toEqual([
      "SKILL.md",
      "assets/nested/two.txt",
      "assets/one.txt",
      "root.txt",
    ])
  })

  test("allows an explicit custom override of a mounted file", () => {
    const result = compose({
      mounts: [{ mount_path: "references", files: [file("manual.md")] }],
      overrides: [
        {
          kind: "custom",
          file_id: "manual",
          path: "references/manual.md",
          bytes: bytes("user version"),
        },
      ],
    })
    expect(result.provenance.get("references/manual.md")).toEqual({
      kind: "custom",
      file_id: "manual",
      replaces: { kind: "mount", mount_path: "references", source_path: "manual.md" },
    })
  })

  test("rejects a Base/Mount collision even if a custom override would cover it", () => {
    expect(() =>
      compose({
        base: [file("SKILL.md"), file("assets/same.txt")],
        mounts: [{ mount_path: "assets", files: [file("same.txt")] }],
        overrides: [
          { kind: "custom", file_id: "same", path: "assets/same.txt", bytes: bytes("custom") },
        ],
      }),
    ).toThrow(SkillsError)
  })

  test("rejects duplicate source paths and intersecting mount outputs", () => {
    expect(() => compose({ base: [file("SKILL.md"), file("same.txt"), file("same.txt")] })).toThrow(
      SkillsError,
    )
    expect(() =>
      compose({
        mounts: [
          { mount_path: "assets", files: [file("nested/same.txt")] },
          { mount_path: "assets/nested", files: [file("same.txt")] },
        ],
      }),
    ).toThrow(SkillsError)
  })

  test("rejects file/directory collisions between sources and in the final tree", () => {
    expect(() =>
      compose({
        base: [file("SKILL.md"), file("assets"), file("assets-extra")],
        mounts: [{ mount_path: "assets", files: [file("child.txt")] }],
      }),
    ).toThrow(SkillsError)
    expect(() =>
      compose({
        base: [file("SKILL.md"), file("docs/child.txt")],
        overrides: [{ kind: "custom", file_id: "docs", path: "docs", bytes: bytes("file") }],
      }),
    ).toThrow(SkillsError)
  })

  test("permits a file/directory change only when the old conflicting file is explicitly tombstoned", () => {
    const result = compose({
      base: [file("SKILL.md"), file("docs")],
      overrides: [
        { kind: "tombstone", file_id: "old-docs", path: "docs" },
        { kind: "custom", file_id: "new-docs", path: "docs/child.md", bytes: bytes("new child") },
      ],
    })
    expect(result.files.map((value) => value.path)).toEqual(["SKILL.md", "docs/child.md"])
  })

  test.each([
    { a: "Readme.md", b: "README.md" },
    { a: "caf\u00e9.md", b: "cafe\u0301.md" },
    { a: "Stra\u00dfe.txt", b: "STRASSE.txt" },
  ])("rejects portable path aliases $a / $b", ({ a, b }) => {
    expect(() => compose({ base: [file("SKILL.md"), file(a), file(b)] })).toThrow(SkillsError)
    expect(() =>
      compose({
        base: [file("SKILL.md"), file(a)],
        overrides: [{ kind: "custom", file_id: "alias", path: b, bytes: bytes("override") }],
      }),
    ).toThrow(SkillsError)
  })

  test("rejects file/directory aliases after case folding", () => {
    expect(() =>
      compose({
        base: [file("SKILL.md"), file("Assets")],
        mounts: [{ mount_path: "assets", files: [file("child.txt")] }],
      }),
    ).toThrow(SkillsError)
    expect(() =>
      compose({
        base: [file("SKILL.md"), file("Assets/one.txt")],
        mounts: [{ mount_path: "assets", files: [file("two.txt")] }],
      }),
    ).toThrow(SkillsError)
  })

  test("rejects duplicate override IDs, duplicate target paths, and custom/tombstone ambiguity", () => {
    expect(() =>
      compose({
        overrides: [
          { kind: "custom", file_id: "one-id", path: "a.txt", bytes: bytes("a") },
          { kind: "custom", file_id: "one-id", path: "b.txt", bytes: bytes("b") },
        ],
      }),
    ).toThrow(SkillsError)
    expect(() =>
      compose({
        overrides: [
          { kind: "custom", file_id: "first", path: "a.txt", bytes: bytes("a") },
          { kind: "custom", file_id: "second", path: "a.txt", bytes: bytes("b") },
        ],
      }),
    ).toThrow(SkillsError)
    expect(() =>
      compose({
        overrides: [
          { kind: "custom", file_id: "first", path: "a.txt", bytes: bytes("a") },
          { kind: "tombstone", file_id: "second", path: "a.txt" },
        ],
      }),
    ).toThrow(SkillsError)
  })

  test.each([
    "../outside",
    "/absolute",
    "./local.txt",
    "a/../local.txt",
    "a//b",
    "a\\b",
    "a\u0000b",
    "a\nb",
  ])("rejects unsafe or noncanonical path %j at every input", (path) => {
    expect(() => compose({ base: [file("SKILL.md"), file(path)] })).toThrow(SkillsError)
    expect(() => compose({ mounts: [{ mount_path: path, files: [file("child")] }] })).toThrow(
      SkillsError,
    )
    expect(() => compose({ mounts: [{ mount_path: "safe", files: [file(path)] }] })).toThrow(
      SkillsError,
    )
    expect(() => compose({ overrides: [{ kind: "tombstone", file_id: "unsafe", path }] })).toThrow(
      SkillsError,
    )
    expect(() => compose({ entrypoint: path })).toThrow(SkillsError)
  })

  test.each([
    ".git/config",
    "nested/.GIT/config",
    ".ntn-skills.json",
    "nested/.NTN-SKILLS.JSON",
    "a/.git/b",
  ])("rejects reserved path %s", (path) => {
    expect(() => compose({ base: [file("SKILL.md"), file(path)] })).toThrow(SkillsError)
    expect(() =>
      compose({ overrides: [{ kind: "tombstone", file_id: "reserved", path }] }),
    ).toThrow(SkillsError)
  })

  test("requires the declared main entrypoint in the effective output", () => {
    expect(() => compose({ entrypoint: "PROMPT.md" })).toThrow(SkillsError)
    expect(() =>
      compose({ overrides: [{ kind: "tombstone", file_id: "main", path: "SKILL.md" }] }),
    ).toThrow(SkillsError)
    expect(compose({ base: [file("PROMPT.md")], entrypoint: "PROMPT.md" }).files[0]?.path).toBe(
      "PROMPT.md",
    )
  })
})
