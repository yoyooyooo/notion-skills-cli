import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import {
  prepareCurrentSourceFromDiscovery,
  validateCurrentSourceContributions,
  validateCurrentSourceInput,
  type CurrentSourceDeclaration,
} from "../src/shared-current-source-input.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"

const encode = (value: string) => new TextEncoder().encode(value)
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const oid = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
const commit = "a".repeat(40),
  tree = "b".repeat(40)
const input: CurrentSourceDeclaration = {
  version: 1,
  definition: {
    version: 1,
    source_id: "team-skills",
    name: "Team skills",
    description: "Current fixed Git files",
    enabled: true,
    policy: "manual",
    adapter: { type: "git", url: "https://github.com/example/skills.git", ref: "main" },
    selection: { roots: ["skills"], include: [], exclude: [], mapping: {} },
    options: {},
  },
  contributions: ["alpha", "beta"].map((name) => ({
    member_key: `skills/${name}`,
    skill_id: `skill-${name}`,
    mount_path: "",
    mapping: {},
    exclude: [],
  })),
}

function member(
  name: string,
  supporting: readonly { path: string; bytes: Uint8Array; mode?: "100644" | "100755" }[] = [],
) {
  const root = `skills/${name}`
  const files = [
    {
      path: "SKILL.md",
      bytes: encode(`---\nname: ${name}\ndescription: Current ${name} files\n---\n\n# ${name}\n`),
    },
    ...supporting,
  ]
  return {
    member_key: root,
    source_path: root,
    portable: {
      kind: "skill" as const,
      name,
      description: `Current ${name} files`,
      main: "SKILL.md",
      // Real regular Git discovery keeps executable mode in git_manifest.
      files: files.map(({ path, bytes }) => ({ path, bytes })),
    },
    upstream_hash: "c".repeat(64),
    content_hash: "d".repeat(64),
    git_manifest: {
      commit,
      tree,
      root,
      files: files.map((file) => ({
        path: file.path,
        source_path: `${root}/${file.path}`,
        git_oid: oid(file.bytes),
        bytes: file.bytes.byteLength,
        mode: file.mode ?? "100644",
      })),
    },
  }
}

function snapshot(): SourceSnapshot {
  return {
    revision: commit,
    provenance: {
      provider: "git",
      git_url: input.definition.adapter.type === "git" ? input.definition.adapter.url : "",
      resolved_ref: commit,
    },
    members: [
      member("alpha", [
        { path: "run.sh", bytes: encode("#!/bin/sh\nexit 0\n"), mode: "100755" },
        { path: "notes.md", bytes: encode("# Source notes\n") },
      ]),
      member("beta", [{ path: "image.png", bytes: new Uint8Array([137, 80, 78, 71, 0, 255]) }]),
    ],
  }
}

const prepare = (
  declaration: unknown = input,
  discovered: unknown = snapshot(),
  exactCommit?: string,
) =>
  Effect.runPromise(
    prepareCurrentSourceFromDiscovery(declaration, discovered, { exactCommit }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  )

test("one exact Source prepares two stable Skill contributions, preserving executable and binary originals", async () => {
  const result = await prepare()
  expect(result.resolved_commit).toBe(commit)
  expect(result.declaration).toEqual(input)
  expect(result.configuration_sha256).toBe(sha(canonicalSharedJson(input)))
  expect(result.prepared_source.revision).toBe(sha(canonicalSharedJson(result.plan)))
  expect(result.targets.map((target) => target.skill_id)).toEqual(["skill-alpha", "skill-beta"])
  expect(result.targets[0]!.defaults).toEqual({ name: "alpha", description: "Current alpha files" })
  expect(result.targets[0]!.files.find((file) => file.path === "run.sh")).toMatchObject({
    mode: "100755",
    authority: { kind: "source", source_id: "team-skills", source_path: "skills/alpha/run.sh" },
  })
  expect(result.targets[1]!.files.find((file) => file.path === "image.png")!.bytes).toEqual(
    new Uint8Array([137, 80, 78, 71, 0, 255]),
  )
  expect(
    result.targets.every((target) =>
      target.files.every((file) => file.authority.kind === "source"),
    ),
  ).toBe(true)
  const plan = result.plan.base
  expect(plan?.kind).toBe("git")
  if (plan?.kind !== "git") throw new Error("Expected the fixed Git plan")
  expect(plan.source.root).toBe("")
  expect(plan.source.files).toHaveLength(5)
  for (const file of plan.source.files) {
    expect(file.path).toBe(file.source_path)
    expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test("file exclusions and exact target mappings change only contributions, never fixed-source bytes or revision", async () => {
  const before = await prepare()
  const declaration = {
    ...input,
    contributions: input.contributions.map((entry) =>
      entry.skill_id === "skill-alpha"
        ? {
            ...entry,
            mapping: { "run.sh": "scripts/start.sh" },
            exclude: ["obsolete.md", "notes.md"],
          }
        : entry,
    ),
  }
  const after = await prepare(declaration)
  expect(after.prepared_source.revision).toBe(before.prepared_source.revision)
  expect(after.configuration_sha256).not.toBe(before.configuration_sha256)
  expect(after.declaration.contributions[0]!.exclude).toEqual(["notes.md", "obsolete.md"])
  expect(after.targets[0]!.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/start.sh"])
  expect(after.targets[0]!.files[1]!.authority.source_path).toBe("skills/alpha/run.sh")
  expect(after.targets[0]!.files[1]!.bytes).toEqual(
    before.targets[0]!.files.find((file) => file.path === "run.sh")!.bytes,
  )
  expect(after.declaration.definition.selection.exclude).toEqual([])
})

test("same-intent preparation uses an exact frozen commit without changing declared config or bytes", async () => {
  const declaration = structuredClone(input)
  const before = await prepare(declaration)
  const resumed = await prepare(declaration, snapshot(), commit)
  expect(resumed.configuration_sha256).toBe(before.configuration_sha256)
  expect(resumed.prepared_source).toEqual(before.prepared_source)
  expect(declaration).toEqual(input)
  await expect(prepare(declaration, snapshot(), "f".repeat(40))).rejects.toThrow(
    "selected exact Git origin and commit",
  )
  await expect(prepare(declaration, snapshot(), "main")).rejects.toThrow(
    "exact lowercase Git commit",
  )
  await expect(
    prepare(
      { ...input, definition: { ...input.definition, options: { accepted_ref: commit } } },
      snapshot(),
      "f".repeat(40),
    ),
  ).rejects.toThrow("declaration's explicit fixed revision")
})

test("one member can feed different targets with independent byte arrays and stable global source paths", async () => {
  const declaration = {
    ...input,
    contributions: [...input.contributions, { ...input.contributions[0]!, skill_id: "skill-copy" }],
  }
  const result = await prepare(declaration)
  const original = result.targets.find((target) => target.skill_id === "skill-alpha")!.files[0]!
  const copy = result.targets.find((target) => target.skill_id === "skill-copy")!.files[0]!
  expect(original.authority).toEqual(copy.authority)
  const first = copy.bytes[0]
  original.bytes[0] = 0
  expect(copy.bytes[0]).toBe(first)
  expect(() =>
    validateCurrentSourceContributions([
      input.contributions[0],
      { ...input.contributions[0], mount_path: "duplicate" },
    ]),
  ).toThrow("only once")
})

test("different members may share a target only through a collision-free current directory", async () => {
  const contributions = input.contributions.map((entry) => ({ ...entry, skill_id: "combined" }))
  await expect(prepare({ ...input, contributions })).rejects.toThrow()
  const result = await prepare({
    ...input,
    contributions: contributions.map((entry) => ({
      ...entry,
      mount_path: entry.member_key.endsWith("beta") ? "references/beta" : "",
    })),
  })
  expect(result.targets).toHaveLength(1)
  expect(result.targets[0]!.defaults.name).toBe("alpha")
  expect(result.targets[0]!.members).toEqual(["skills/alpha", "skills/beta"])
  expect(result.targets[0]!.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "notes.md",
    "references/beta/SKILL.md",
    "references/beta/image.png",
    "run.sh",
  ])
  await expect(
    prepare({
      ...input,
      contributions: input.contributions.map((entry) => ({
        ...entry,
        mapping: { "notes.md": "skill.md" },
      })),
    }),
  ).rejects.toThrow()
  await expect(
    prepare({
      ...input,
      contributions: input.contributions.map((entry) => ({
        ...entry,
        mapping: { "notes.md": "run.sh/child.md" },
      })),
    }),
  ).rejects.toThrow()
})

test.each(["../outside", "/absolute", "a/../b", ".git/config"])(
  "contribution exclusions refuse unsafe or noncanonical path %s",
  (path) =>
    expect(() =>
      validateCurrentSourceContributions([{ ...input.contributions[0], exclude: [path] }]),
    ).toThrow(),
)

test("exact contribution paths preserve literal brackets and wildcard characters without pattern expansion", async () => {
  const discovered = {
    ...snapshot(),
    members: [
      member("alpha", [
        { path: "guide[1].md", bytes: encode("# Brackets\n") },
        { path: "literal?.md", bytes: encode("# Question mark\n") },
        { path: "*.md", bytes: encode("# Literal star\n") },
        { path: "notes.md", bytes: encode("# Other notes\n") },
      ]),
    ],
  }
  const result = await prepare(
    {
      ...input,
      contributions: [
        {
          ...input.contributions[0],
          mapping: { "literal?.md": "references/guide[2]?.md" },
          exclude: ["guide[1].md", "*.md"],
        },
      ],
    },
    discovered,
  )
  expect(result.targets[0]!.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "notes.md",
    "references/guide[2]?.md",
  ])
  expect(result.targets[0]!.files[2]!.authority.source_path).toBe("skills/alpha/literal?.md")
  expect(result.declaration.definition.selection.exclude).toEqual([])
})

test("contribution property validation stays strict, bounded and independent of provider acquisition", () => {
  expect(validateCurrentSourceContributions([])).toEqual([])
  expect(() =>
    validateCurrentSourceContributions([{ ...input.contributions[0], exclude: ["a", "a"] }]),
  ).toThrow()
  expect(() =>
    validateCurrentSourceContributions([{ ...input.contributions[0], generation: 2 }]),
  ).toThrow()
  expect(() =>
    validateCurrentSourceContributions([{ ...input.contributions[0], skill_id: "" }]),
  ).toThrow()
  expect(() =>
    validateCurrentSourceContributions([
      { ...input.contributions[0], mapping: { "a.md": "../bad" } },
    ]),
  ).toThrow()
  expect(() =>
    validateCurrentSourceContributions([
      {
        ...input.contributions[0],
        exclude: Array.from({ length: 100 }, (_, i) => `${i}-${"中".repeat(1000)}.md`),
      },
    ]),
  ).toThrow("complete Sources property")
})

test("declarations refuse unsupported provider, transformations, implicit retention and automatic execution", () => {
  const definitions = [
    {
      ...input.definition,
      adapter: { type: "git", url: "https://gitlab.com/example/skills", ref: "main" },
    },
    {
      ...input.definition,
      adapter: {
        type: "registry",
        base_url: "https://registry.test",
        owner: "owner",
        slug: "slug",
      },
    },
    { ...input.definition, options: { patch: { version: 1, files: [] } } },
    { ...input.definition, options: { member_patches: {} } },
    { ...input.definition, options: { storage: "retained" } },
    { ...input.definition, options: { accepted_ref: "main" } },
    { ...input.definition, options: { require_all_included: "true" } },
    { ...input.definition, policy: "auto", options: { check_interval_ms: 60000 } },
    { ...input.definition, source_id: `source-${"f".repeat(64)}` },
  ]
  for (const definition of definitions)
    expect(() => validateCurrentSourceInput({ ...input, definition })).toThrow()
  expect(() => validateCurrentSourceInput({ ...input, evidence: true })).toThrow()
})

test("source discovery cannot silently omit or add an unbound member", async () => {
  const missing = snapshot()
  await expect(
    prepare({ ...input, contributions: [input.contributions[0]] }, missing),
  ).rejects.toThrow("explicit stable target")
  await expect(prepare(input, { ...missing, members: [missing.members[0]] })).rejects.toThrow(
    "explicit stable target",
  )
  await expect(
    prepare(input, { ...missing, members: [...missing.members, missing.members[0]] }),
  ).rejects.toThrow("explicit stable target")
})

test("fixed-source preparation checks original Git byte identity and refuses transformed or linked members", async () => {
  for (const kind of [
    "bytes",
    "size",
    "mode",
    "source_path",
    "tree",
    "missing_manifest",
    "patch",
    "symlink",
    "duplicate_file",
  ] as const) {
    const discovered = snapshot()
    const first = discovered.members[0]!
    const manifest = first.git_manifest!
    const entry = manifest.files[0]!
    const { git_manifest: _manifest, ...withoutManifest } = first
    const changed =
      kind === "bytes"
        ? {
            ...first,
            portable: {
              ...first.portable,
              files: first.portable.files.map((file, index) =>
                index === 0 ? { ...file, bytes: new Uint8Array(file.bytes.length) } : file,
              ),
            },
          }
        : kind === "size"
          ? {
              ...first,
              git_manifest: {
                ...manifest,
                files: manifest.files.map((file, index) =>
                  index === 0 ? { ...file, bytes: file.bytes + 1 } : file,
                ),
              },
            }
          : kind === "mode"
            ? {
                ...first,
                portable: {
                  ...first.portable,
                  files: first.portable.files.map((file, index) =>
                    index === 0 ? { ...file, mode: "100755" } : file,
                  ),
                },
              }
            : kind === "source_path"
              ? {
                  ...first,
                  git_manifest: {
                    ...manifest,
                    files: manifest.files.map((file, index) =>
                      index === 0 ? { ...file, source_path: "different/SKILL.md" } : file,
                    ),
                  },
                }
              : kind === "tree"
                ? { ...first, git_manifest: { ...manifest, tree: "f".repeat(40) } }
                : kind === "missing_manifest"
                  ? withoutManifest
                  : kind === "patch"
                    ? { ...first, patch_hash: "a".repeat(64) }
                    : kind === "symlink"
                      ? {
                          ...first,
                          git_materialization: {
                            source_hash: "a",
                            derived_hash: "b",
                            links: [],
                            files: [],
                          },
                        }
                      : {
                          ...first,
                          git_manifest: {
                            ...manifest,
                            files: manifest.files.map((file, index) =>
                              index === 1 ? { ...entry } : file,
                            ),
                          },
                        }
    await expect(
      prepare(input, { ...discovered, members: [changed, ...discovered.members.slice(1)] }),
    ).rejects.toThrow()
  }
  await expect(
    prepare({ ...input, definition: { ...input.definition, enabled: false } }),
  ).rejects.toThrow("Enable")
  await expect(
    prepare(input, {
      ...snapshot(),
      external_resources: [
        { source_path: "outside.md", git_oid: "a".repeat(40), sha256: "b".repeat(64) },
      ],
    }),
  ).rejects.toThrow("every referenced resource")
})

test("large complete manifests use the existing current Source resource representation", async () => {
  const discovered = {
    ...snapshot(),
    members: [
      member(
        "alpha",
        Array.from({ length: 150 }, (_, index) => ({
          path: `references/${index}-${"a".repeat(900)}.txt`,
          bytes: encode(`Exact ${index}\n`),
        })),
      ),
    ],
  }
  const result = await prepare({ ...input, contributions: [input.contributions[0]] }, discovered)
  expect("resource" in result.prepared_source.content).toBe(true)
  expect(result.prepared_source.revision).toBe(sha(canonicalSharedJson(result.plan)))
  expect(result.targets[0]!.files).toHaveLength(151)
})
