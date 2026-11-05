import { describe, expect, test } from "bun:test"
import { resolveFileState, type FileEvent } from "../src/shared-file-state.ts"
import {
  assertSharedFileReferences,
  sharedMarkdownReferences,
} from "../src/shared-file-references.ts"
import { composeSharedFiles, type CompositionOverride } from "../src/shared-composition.ts"
import {
  composeSharedFilePlacements,
  planSharedFilePlacements,
  sharedFileSourcePath,
} from "../src/shared-file-placement.ts"

const encode = (value: string) => new TextEncoder().encode(value)
const hash = "a".repeat(64)
const content = { object_id: `body-${hash}`, sha256: hash, bytes: 5 }
const native: FileEvent = {
  kind: "adopted",
  file_id: "file-a",
  event_id: "initial",
  parents: [],
  content,
}
const projected: FileEvent = {
  kind: "projected",
  file_id: "file-a",
  event_id: "initial",
  parents: [],
  projection: { normalization_version: 1, sha256: hash },
  source_revision: "fixed-source",
}
const move = (parents = ["initial"], source: string | null = null): FileEvent => ({
  kind: "moved",
  file_id: "file-a",
  event_id: "move-a",
  parents,
  retained: content,
  from_path: "references/a.md",
  to_path: "notes/a.md",
  source_path: source,
  suppressed_paths: ["references/a.md"],
})

describe("shared file placement events", () => {
  test("moving inherits customization and later body events retain the exact path history", () => {
    const moved = move()
    const adopted: FileEvent = {
      kind: "adopted",
      event_id: "new-body",
      file_id: "file-a",
      parents: ["move-a"],
      content: { ...content, sha256: "b".repeat(64), object_id: `body-${"b".repeat(64)}` },
    }
    const state = resolveFileState("file-a", [native, moved, adopted])
    expect(state.ownership).toEqual({ kind: "custom", content: adopted.content })
    expect(state.placement).toEqual({
      path: "notes/a.md",
      source_path: null,
      suppressed_paths: ["references/a.md"],
    })
  })

  test("following moves keep the original source path and deleting never revives old paths", () => {
    const moved = move(["initial"], "references/a.md")
    const state = resolveFileState("file-a", [projected, moved])
    expect(state.ownership).toEqual({
      kind: "following",
      source_revision: "fixed-source",
      projection: { normalization_version: 1, sha256: hash },
    })
    expect(state.placement).toEqual({
      path: "notes/a.md",
      source_path: "references/a.md",
      suppressed_paths: ["references/a.md"],
    })
    const deleted: FileEvent = {
      kind: "deleted",
      file_id: "file-a",
      event_id: "delete",
      parents: ["move-a"],
      retained: content,
    }
    const tombstone = resolveFileState("file-a", [projected, moved, deleted])
    expect(tombstone.ownership.kind).toBe("tombstone")
    expect(tombstone.placement).toEqual(state.placement)
    const base = [
      { path: "SKILL.md", bytes: encode("# Main\n") },
      { path: "references/a.md", bytes: encode("Source changed\n") },
      { path: "unrelated.md", bytes: encode("Keep\n") },
    ]
    const composed = composeSharedFilePlacements({
      source: base,
      overrides: [],
      bindings: [{ file_id: "file-a", path: "notes/a.md", state }],
      entrypoint: "SKILL.md",
    })
    expect(composed.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "notes/a.md",
      "unrelated.md",
    ])
    expect(
      new TextDecoder().decode(composed.files.find((file) => file.path === "notes/a.md")?.bytes),
    ).toBe("Source changed\n")
    expect(composed.provenance.get("notes/a.md")).toEqual({
      kind: "base",
      source_path: "references/a.md",
    })
    expect(sharedFileSourcePath("notes/a.md", state)).toBe("references/a.md")
    const removed = composeSharedFilePlacements({
      source: base,
      overrides: [{ kind: "tombstone", file_id: "file-a", path: "notes/a.md" }],
      bindings: [{ file_id: "file-a", path: "notes/a.md", state: tombstone }],
      entrypoint: "SKILL.md",
    })
    expect(removed.files.map((file) => file.path)).toEqual(["SKILL.md", "unrelated.md"])
  })

  test("repeated moves preserve source identity and explicitly suppress every prior noncurrent path", () => {
    const second: FileEvent = {
      kind: "moved",
      file_id: "file-a",
      event_id: "move-b",
      parents: ["move-a"],
      retained: content,
      from_path: "notes/a.md",
      to_path: "guides/a.md",
      source_path: "references/a.md",
      suppressed_paths: ["notes/a.md", "references/a.md"],
    }
    expect(
      resolveFileState("file-a", [projected, move(["initial"], "references/a.md"), second])
        .placement,
    ).toEqual({
      path: "guides/a.md",
      source_path: "references/a.md",
      suppressed_paths: ["notes/a.md", "references/a.md"],
    })
    expect(() =>
      resolveFileState("file-a", [
        projected,
        move(["initial"], "references/a.md"),
        { ...second, source_path: "notes/a.md" },
      ]),
    ).toThrow()
    expect(() =>
      resolveFileState("file-a", [
        projected,
        move(["initial"], "references/a.md"),
        { ...second, suppressed_paths: ["notes/a.md"] },
      ]),
    ).toThrow()
  })

  test("same-content concurrent moves are conflicting identities, not a timestamp or order winner", () => {
    const a = move()
    if (a.kind !== "moved") throw new Error("Unexpected event")
    const b: FileEvent = { ...a, event_id: "move-b", to_path: "elsewhere/a.md" }
    expect(() => resolveFileState("file-a", [native, a, b])).toThrow()
    expect(() => resolveFileState("file-a", [native, b, a])).toThrow()
    const after: FileEvent = {
      kind: "adopted",
      event_id: "merge-body",
      file_id: "file-a",
      parents: ["move-a", "move-b"],
      content,
    }
    expect(() => resolveFileState("file-a", [native, a, b, after])).toThrow()
  })

  test("a move cannot release a tombstone or retain bytes different from its accepted body", () => {
    const deleted: FileEvent = {
      kind: "deleted",
      file_id: "file-a",
      event_id: "delete",
      parents: ["initial"],
      retained: content,
    }
    expect(() => resolveFileState("file-a", [native, deleted, move(["delete"])])).toThrow()
    const moved = move()
    if (moved.kind !== "moved") throw new Error("Unexpected event")
    expect(() =>
      resolveFileState("file-a", [
        native,
        { ...moved, retained: { ...content, sha256: "b".repeat(64) } },
      ]),
    ).toThrow()
    expect(() => resolveFileState("file-a", [projected, move()])).toThrow()
  })

  test("a moved custom file stays custom while old source paths remain suppressed", () => {
    const state = resolveFileState("file-a", [
      projected,
      { ...native, event_id: "custom", parents: ["initial"] },
      move(["custom"], "references/a.md"),
    ])
    const base = [
      { path: "SKILL.md", bytes: encode("# Main\n") },
      { path: "references/a.md", bytes: encode("New upstream\n") },
    ]
    const tree = composeSharedFilePlacements({
      source: base,
      overrides: [
        { kind: "custom", file_id: "file-a", path: "notes/a.md", bytes: encode("Kept custom\n") },
      ],
      bindings: [{ file_id: "file-a", path: "notes/a.md", state }],
      entrypoint: "SKILL.md",
    })
    expect(tree.files.map((file) => file.path)).toEqual(["SKILL.md", "notes/a.md"])
    expect(
      new TextDecoder().decode(tree.files.find((file) => file.path === "notes/a.md")?.bytes),
    ).toBe("Kept custom\n")
    expect(tree.provenance.get("notes/a.md")).toEqual({
      kind: "custom",
      file_id: "file-a",
      replaces: { kind: "base", source_path: "references/a.md" },
    })
  })

  test("a newly introduced source destination collision is not concealed by relocation", () => {
    const state = resolveFileState("file-a", [projected, move(["initial"], "references/a.md")])
    expect(() =>
      composeSharedFilePlacements({
        source: [
          { path: "SKILL.md", bytes: encode("Main") },
          { path: "references/a.md", bytes: encode("Original") },
          { path: "notes/a.md", bytes: encode("Unexpected new upstream file") },
        ],
        overrides: [],
        bindings: [{ file_id: "file-a", path: "notes/a.md", state }],
        entrypoint: "SKILL.md",
      }),
    ).toThrow()
  })
})

describe("shared file placement without unused source bytes", () => {
  for (const kind of ["custom", "tombstone"] as const)
    test(`${kind} leaves a large source object unneeded while preserving the complete effective tree`, () => {
      const state = resolveFileState(
        "file-a",
        kind === "custom"
          ? [native]
          : [
              native,
              {
                kind: "deleted",
                file_id: "file-a",
                event_id: "delete-a",
                parents: ["initial"],
                retained: content,
              },
            ],
      )
      const fullSource = [
        { path: "SKILL.md", bytes: encode("# Main\n") },
        { path: "references/a.md", bytes: new Uint8Array(2 * 1024 * 1024).fill(65) },
        { path: "keep.bin", bytes: new Uint8Array([0, 255, 13, 10]) },
      ]
      const manifest = fullSource.map(({ path }) => ({ path }))
      const override: CompositionOverride =
        kind === "custom"
          ? { kind, file_id: "file-a", path: "references/a.md", bytes: encode("Whole custom\n") }
          : { kind, file_id: "file-a", path: "references/a.md" }
      const input = {
        overrides: [override],
        bindings: [{ file_id: "file-a", path: "references/a.md", state }],
        entrypoint: "SKILL.md",
      }
      const planned = planSharedFilePlacements({ ...input, source: manifest })
      expect(planned.source_paths).toEqual(["SKILL.md", "keep.bin"])
      const partial = composeSharedFilePlacements({
        ...input,
        manifest,
        source: fullSource.filter((file) => file.path !== "references/a.md"),
      })
      const full = composeSharedFilePlacements({ ...input, source: fullSource })
      expect(partial.files).toEqual(full.files)
      expect([...partial.provenance]).toEqual([...full.provenance])
      expect(partial.files.map((file) => file.path)).toEqual([...planned.paths])
      if (kind === "custom")
        expect(partial.provenance.get("references/a.md")).toEqual({
          kind: "custom",
          file_id: "file-a",
          replaces: { kind: "base", source_path: "references/a.md" },
        })
      else expect(partial.files.some((file) => file.path === "references/a.md")).toBe(false)
    })

  test("repeated following moves acquire the original source path and omit suppressed source bytes", () => {
    const second: FileEvent = {
      kind: "moved",
      file_id: "file-a",
      event_id: "move-b",
      parents: ["move-a"],
      retained: content,
      from_path: "notes/a.md",
      to_path: "guides/a.md",
      source_path: "references/a.md",
      suppressed_paths: ["notes/a.md", "references/a.md"],
    }
    const state = resolveFileState("file-a", [
      projected,
      move(["initial"], "references/a.md"),
      second,
    ])
    const manifest = [{ path: "SKILL.md" }, { path: "references/a.md" }, { path: "notes/a.md" }]
    const source = [
      { path: "SKILL.md", bytes: encode("# Main\n") },
      { path: "references/a.md", bytes: new Uint8Array([239, 187, 191, 65, 13, 10]) },
    ]
    const input = {
      overrides: [],
      bindings: [{ file_id: "file-a", path: "guides/a.md", state }],
      entrypoint: "SKILL.md",
    }
    const planned = planSharedFilePlacements({ ...input, source: manifest })
    expect(planned.source_paths).toEqual(["SKILL.md", "references/a.md"])
    expect(planned.paths).toEqual(["SKILL.md", "guides/a.md"])
    const composed = composeSharedFilePlacements({ ...input, manifest, source })
    expect(composed.files.find((file) => file.path === "guides/a.md")?.bytes).toEqual(
      source[1]?.bytes,
    )
    expect(composed.provenance.get("guides/a.md")).toEqual({
      kind: "base",
      source_path: "references/a.md",
    })
  })

  test("a moved custom file retains original provenance without obtaining that source body", () => {
    const state = resolveFileState("file-a", [
      projected,
      { ...native, event_id: "custom", parents: ["initial"] },
      move(["custom"], "references/a.md"),
    ])
    const input = {
      manifest: [{ path: "SKILL.md" }, { path: "references/a.md" }],
      source: [{ path: "SKILL.md", bytes: encode("Main") }],
      overrides: [
        { kind: "custom" as const, file_id: "file-a", path: "notes/a.md", bytes: encode("User") },
      ],
      bindings: [{ file_id: "file-a", path: "notes/a.md", state }],
      entrypoint: "SKILL.md",
    }
    expect(planSharedFilePlacements({ ...input, source: input.manifest }).source_paths).toEqual([
      "SKILL.md",
    ])
    const composed = composeSharedFilePlacements(input)
    expect(composed.provenance.get("notes/a.md")).toEqual({
      kind: "custom",
      file_id: "file-a",
      replaces: { kind: "base", source_path: "references/a.md" },
    })
    expect(composed.files.find((file) => file.path === "notes/a.md")?.bytes).toEqual(encode("User"))
  })

  test("omitting required moved bytes fails instead of creating an empty effective file", () => {
    const state = resolveFileState("file-a", [projected, move(["initial"], "references/a.md")])
    expect(() =>
      composeSharedFilePlacements({
        manifest: [{ path: "SKILL.md" }, { path: "references/a.md" }],
        source: [{ path: "SKILL.md", bytes: encode("Main") }],
        overrides: [],
        bindings: [{ file_id: "file-a", path: "notes/a.md", state }],
        entrypoint: "SKILL.md",
      }),
    ).toThrow("Required fixed source bytes are unavailable")
  })

  test("partial assembly cannot conceal a source directory collision behind a custom body", () => {
    const state = resolveFileState("file-a", [native])
    expect(() =>
      composeSharedFilePlacements({
        manifest: [
          { path: "SKILL.md" },
          { path: "references/a.md" },
          { path: "references/a.md/hidden.md" },
        ],
        source: [{ path: "SKILL.md", bytes: encode("Main") }],
        overrides: [
          { kind: "custom", file_id: "file-a", path: "references/a.md", bytes: encode("User") },
        ],
        bindings: [{ file_id: "file-a", path: "references/a.md", state }],
        entrypoint: "SKILL.md",
      }),
    ).toThrow("A file occupies a required directory path")
  })

  test("provided source bytes must be unique members of the complete manifest", () => {
    const main = { path: "SKILL.md", bytes: encode("Main") }
    const input = {
      manifest: [{ path: "SKILL.md" }],
      overrides: [],
      bindings: [],
      entrypoint: "SKILL.md",
    }
    expect(() => composeSharedFilePlacements({ ...input, source: [main, main] })).toThrow(
      "Fixed source byte paths must be unique",
    )
    expect(() =>
      composeSharedFilePlacements({
        ...input,
        source: [main, { path: "extra.bin", bytes: new Uint8Array([42]) }],
      }),
    ).toThrow("Supplied source bytes are absent from the complete manifest")
  })

  test("custom main placement excludes separate caller-owned frontmatter dependencies", () => {
    const overrides: CompositionOverride[] = [
      { kind: "custom", file_id: "main", path: "SKILL.md", bytes: encode("Custom main") },
    ]
    const manifest = [{ path: "SKILL.md" }]
    const input = { overrides, bindings: [], entrypoint: "SKILL.md" }
    const plan = planSharedFilePlacements({ ...input, source: manifest })
    expect(plan.source_paths).toEqual([])
    expect(composeSharedFilePlacements({ ...input, manifest, source: [] }).files).toEqual([
      { path: "SKILL.md", bytes: encode("Custom main") },
    ])
  })
})

describe("complete-tree local Markdown references", () => {
  test("native inline code excludes examples while retaining real links and physical lines", () => {
    const body =
      '<b><code>[example](missing.md) and a`b</code></b>\n[real](docs/real.md) and `literal`\n<code><file src="missing.pdf">literal</file></code>'
    expect(
      sharedMarkdownReferences("SKILL.md", body).map((reference) => [
        reference.target,
        reference.line,
      ]),
    ).toEqual([["docs/real.md", 2]])
    expect(
      assertSharedFileReferences([
        { path: "SKILL.md", bytes: encode(body) },
        { path: "docs/real.md", bytes: encode("Real") },
      ]),
    ).toEqual({ checked_files: 2, local_references: 1 })
    expect(() => assertSharedFileReferences([{ path: "SKILL.md", bytes: encode(body) }])).toThrow()
  })

  test("escaped and code-quoted native tag text cannot suppress surrounding actual references", () => {
    for (const body of [
      "\\<code>[visible](visible.md)</code>",
      "`<code>` [visible](visible.md) </code>",
      "<div>[visible](visible.md)</div>",
    ])
      expect(
        sharedMarkdownReferences("SKILL.md", body).map((reference) => reference.target),
      ).toEqual(["visible.md"])
  })

  test("fenced/inline examples and external URLs are excluded; Unicode positions remain correct", () => {
    const body =
      "😀 中文 [ok](references/a.md)\n`[code](missing.md)`\n```md\n[example](missing.md)\n```\n[web](https://example.com/missing.md)\n![asset](assets/a%20b.png)\n"
    expect(
      sharedMarkdownReferences("SKILL.md", body).map((reference) => [
        reference.target,
        reference.kind,
      ]),
    ).toEqual([
      ["references/a.md", "link"],
      ["assets/a b.png", "image"],
    ])
    expect(
      assertSharedFileReferences([
        { path: "SKILL.md", bytes: encode(body) },
        { path: "references/a.md", bytes: encode("# A\n") },
        { path: "assets/a b.png", bytes: new Uint8Array([0, 1, 2]) },
      ]),
    ).toEqual({ checked_files: 2, local_references: 2 })
  })

  test("reference-style links, images, nested parentheses and native asset attributes resolve exactly", () => {
    const body =
      '[Guide][topic]\n![Guide][]\n[Guide]\n[Parentheses](../assets/a(b).png "title")\n<file src="../assets/a&amp;b.pdf">File</file>\n[topic]: <guide.md>\n[Guide]: ../assets/icon.png\n'
    expect(
      sharedMarkdownReferences("docs/index.md", body).map((reference) => reference.target),
    ).toEqual([
      "docs/guide.md",
      "assets/icon.png",
      "assets/icon.png",
      "assets/a(b).png",
      "assets/a&b.pdf",
    ])
  })

  test("linked images check both targets while frontmatter labels are not Markdown body links", () => {
    const body =
      "---\nname: '[not body](missing.md)'\n---\n[![image](assets/icon.png)](docs/guide.md)\n"
    expect(sharedMarkdownReferences("SKILL.md", body).map((reference) => reference.target)).toEqual(
      ["docs/guide.md", "assets/icon.png"],
    )
    expect(() =>
      assertSharedFileReferences([
        { path: "SKILL.md", bytes: encode(body) },
        { path: "docs/guide.md", bytes: encode("Guide") },
      ]),
    ).toThrow()
  })

  test("deletion fails for inbound references and moving also checks the moved file's relative links", () => {
    const main = { path: "SKILL.md", bytes: encode("[A](docs/a.md)\n") }
    const a = { path: "docs/a.md", bytes: encode("![image](../assets/image.png)\n") }
    const image = { path: "assets/image.png", bytes: new Uint8Array([0]) }
    expect(() => assertSharedFileReferences([main, image])).toThrow()
    expect(() =>
      assertSharedFileReferences([main, { ...a, path: "deep/docs/a.md" }, image]),
    ).toThrow()
    expect(() =>
      assertSharedFileReferences([
        { ...main, bytes: encode("[A](deep/docs/a.md)\n") },
        { ...a, path: "deep/docs/a.md" },
        image,
      ]),
    ).toThrow()
  })

  test("path escapes and malformed URL escaping are explicit failures, while anchors stay local", () => {
    for (const href of [
      "../../outside.md",
      "%2e%2e/%2e%2e/outside.md",
      "bad%XY.md",
      "/absolute.md",
    ])
      expect(() => sharedMarkdownReferences("docs/index.md", `[link](${href})`)).toThrow()
    expect(
      sharedMarkdownReferences("docs/index.md", "[section](#section) [current](?mode=read)").map(
        (reference) => reference.target,
      ),
    ).toEqual(["docs/index.md", "docs/index.md"])
  })

  test("the complete proposed tree separately rejects portable collisions and invalid Markdown bytes", () => {
    expect(() =>
      composeSharedFiles({
        base: [
          { path: "SKILL.md", bytes: encode("# Main") },
          { path: "Docs/a.md", bytes: encode("A") },
          { path: "docs/A.md", bytes: encode("B") },
        ],
        mounts: [],
        overrides: [],
        entrypoint: "SKILL.md",
      }),
    ).toThrow()
    expect(() =>
      assertSharedFileReferences([{ path: "SKILL.md", bytes: new Uint8Array([0xff, 0xfe]) }]),
    ).toThrow()
  })
})
