import { afterAll, beforeAll, expect, test } from "vitest"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverSource, type SourceSnapshot } from "../src/upstream-source.ts"
import {
  buildSourceMemberManifest,
  projectSourceMemberMarkdown,
  resolveSourceMemberLink,
  sourceExternalResourceTargets,
  type SourceLinkContext,
  type SourceMemberManifest,
} from "../src/upstream-member-links.ts"

const services = Layer.merge(NodeServices.layer, NodeHttpClient.layerFetch)
const sourceId = "33333333-3333-4333-8333-333333333333"
const alphaKey = "skills/alpha"
const betaKey = "skills/beta"
const alphaPage = "11111111-1111-4111-8111-111111111111"
const betaPage = "22222222-2222-4222-8222-222222222222"
const decoder = new TextDecoder()
const encoder = new TextEncoder()
const binary = new Uint8Array([0, 255, 128, 1, 13, 10, 0])
const protectedExamples = [
  "`cat ../../packages/runtime.ts`",
  "`[example](../beta/SKILL.md)`",
  "```sh",
  "cat ../../packages/runtime.ts",
  "[example](../beta/SKILL.md)",
  "```",
  "~~~md",
  "[example](../beta/assets/missing.bin)",
  "~~~",
].join("\n")
const alphaMarkdown = `---\nname: alpha\ndescription: Exercise exact upstream member links\n---\n\n${[
  "[own guide](references/nested/guide.md#section)",
  "![own image](assets/raw.bin)",
  "[beta](../beta/SKILL.md)",
  "[nested beta](../beta/references/deep/target.md)",
  "![beta image](../beta/assets/%E5%9B%BE%20%E5%83%8F.bin)",
  "[beta reference][beta-note]",
  "[beta-note]: ../beta/references/deep/target.md",
  "[external](https://example.test/manual#section)",
  "[runtime](../../packages/runtime.ts#L1)",
  protectedExamples,
].join("\n\n")}\n`
const nestedMarkdown = [
  "# Nested guide",
  "[own main](../../SKILL.md)",
  "![own image](../../assets/raw.bin)",
  "[beta nested](../../../beta/references/deep/target.md)",
  "![beta image](../../../beta/assets/%E5%9B%BE%20%E5%83%8F.bin)",
].join("\n\n")
const betaMarkdown =
  "---\nname: beta\ndescription: Exercise exact upstream member links\n---\n\n[alpha](../alpha/SKILL.md)\n"
const targetMarkdown = "# Target\n\n[alpha](../../../alpha/SKILL.md)\n"
const originals: Record<string, Uint8Array> = {
  [`${alphaKey}/SKILL.md`]: encoder.encode(alphaMarkdown),
  [`${alphaKey}/references/nested/guide.md`]: encoder.encode(nestedMarkdown),
  [`${alphaKey}/assets/raw.bin`]: binary,
  [`${betaKey}/SKILL.md`]: encoder.encode(betaMarkdown),
  [`${betaKey}/references/deep/target.md`]: encoder.encode(targetMarkdown),
  [`${betaKey}/assets/图 像.bin`]: new Uint8Array([37, 0, 254, 10, 255]),
  "packages/runtime.ts": encoder.encode("export const runtime = 'source prerequisite'\n"),
}

let directory: string
let snapshot: SourceSnapshot
let manifest: SourceMemberManifest
let context: SourceLinkContext

function git(args: readonly string[]) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Member Link Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Member Link Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  }).trim()
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const invalid = (operation: () => unknown, code: string) =>
  expect(operation).toThrowError(expect.objectContaining({ code }))

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ntn-member-links-"))
  git(["init", "-b", "main"])
  for (const [path, bytes] of Object.entries(originals)) {
    await mkdir(join(directory, path, ".."), { recursive: true })
    await writeFile(join(directory, path), bytes)
  }
  git(["add", "."])
  git(["commit", "--no-gpg-sign", "-m", "two skills and repository prerequisite"])
  snapshot = await Effect.runPromise(
    discoverSource({
      source: { type: "git", url: directory, ref: "main" },
      roots: ["skills"],
      include: [],
      exclude: [],
      mapping: {},
    }).pipe(Effect.provide(services)),
  )
  manifest = await Effect.runPromise(
    buildSourceMemberManifest(sourceId, snapshot).pipe(Effect.provide(services)),
  )
  context = {
    manifest,
    source_id: sourceId,
    revision: snapshot.revision,
    member_key: alphaKey,
    repository_url: "https://github.com/example/upstream.git",
    published: [
      { member_key: alphaKey, page_id: alphaPage },
      { member_key: betaKey, page_id: betaPage },
    ],
  }
}, 30_000)

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("real Git discovery builds the complete two-Skill resource manifest with exact byte hashes", () => {
  expect(snapshot.revision).toBe(git(["rev-parse", "HEAD"]))
  expect(snapshot.external_resources).toEqual([
    {
      source_path: "packages/runtime.ts",
      git_oid: git(["rev-parse", `${snapshot.revision}:packages/runtime.ts`]),
      sha256: digest(originals["packages/runtime.ts"]!),
    },
  ])
  expect(manifest).toEqual({
    version: 1,
    source_id: sourceId,
    revision: snapshot.revision,
    external_resources: [
      {
        source_path: "packages/runtime.ts",
        git_oid: git(["rev-parse", `${snapshot.revision}:packages/runtime.ts`]),
        sha256: digest(originals["packages/runtime.ts"]!),
      },
    ],
    members: [alphaKey, betaKey].map((key) => ({
      member_key: key,
      source_path: key,
      main: "SKILL.md",
      resources: Object.entries(originals)
        .filter(([path]) => path.startsWith(key + "/"))
        .map(([path, bytes]) => ({ path: path.slice(key.length + 1), sha256: digest(bytes) }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    })),
  })
  for (const member of snapshot.members)
    for (const file of member.portable.files)
      expect(file.bytes).toEqual(originals[`${member.source_path}/${file.path}`])
})

test("projection preserves own relative links and emits exact page resource refs across members", () => {
  expect(projectSourceMemberMarkdown(context, "SKILL.md", alphaMarkdown)).toBe(
    alphaMarkdown
      .replace("[beta](../beta/SKILL.md)", `[beta](skill://${betaPage}/SKILL.md)`)
      .replace(
        "[nested beta](../beta/references/deep/target.md)",
        `[nested beta](skill://${betaPage}/references/deep/target.md)`,
      )
      .replace(
        "![beta image](../beta/assets/%E5%9B%BE%20%E5%83%8F.bin)",
        `![beta image](skill://${betaPage}/assets/%E5%9B%BE%20%E5%83%8F.bin)`,
      )
      .replace(
        "[beta-note]: ../beta/references/deep/target.md",
        `[beta-note]: skill://${betaPage}/references/deep/target.md`,
      )
      .replace(
        "[runtime](../../packages/runtime.ts#L1)",
        `[runtime](https://github.com/example/upstream/blob/${snapshot.revision}/packages/runtime.ts#L1)`,
      ),
  )
  expect(resolveSourceMemberLink(context, "SKILL.md", "./assets/raw.bin")).toBe("./assets/raw.bin")
  expect(resolveSourceMemberLink(context, "SKILL.md", "references/nested/guide.md#section")).toBe(
    "references/nested/guide.md#section",
  )
  expect(
    projectSourceMemberMarkdown({ ...context, member_key: betaKey }, "SKILL.md", betaMarkdown),
  ).toBe(betaMarkdown.replace("../alpha/SKILL.md", `skill://${alphaPage}/SKILL.md`))
})

test("custom source entrypoints map to canonical SKILL.md only across the member boundary", async () => {
  const customSnapshot = {
    ...snapshot,
    members: snapshot.members.map((member) =>
      member.member_key === betaKey
        ? { ...member, portable: { ...member.portable, main: "references/deep/target.md" } }
        : member,
    ),
  }
  const customManifest = await Effect.runPromise(
    buildSourceMemberManifest(sourceId, customSnapshot).pipe(Effect.provide(services)),
  )
  expect(customManifest.members.find((member) => member.member_key === betaKey)?.main).toBe(
    "references/deep/target.md",
  )
  const customContext = { ...context, manifest: customManifest }
  expect(
    resolveSourceMemberLink(customContext, "SKILL.md", "../beta/references/deep/target.md"),
  ).toBe(`skill://${betaPage}/SKILL.md`)
  expect(
    resolveSourceMemberLink(
      { ...customContext, member_key: betaKey },
      "SKILL.md",
      "references/deep/target.md",
    ),
  ).toBe("references/deep/target.md")
})

test("nested source resources resolve sibling targets from their containing file", () => {
  expect(projectSourceMemberMarkdown(context, "references/nested/guide.md", nestedMarkdown)).toBe(
    nestedMarkdown
      .replace(
        "../../../beta/references/deep/target.md",
        `skill://${betaPage}/references/deep/target.md`,
      )
      .replace(
        "../../../beta/assets/%E5%9B%BE%20%E5%83%8F.bin",
        `skill://${betaPage}/assets/%E5%9B%BE%20%E5%83%8F.bin`,
      ),
  )
  expect(
    projectSourceMemberMarkdown(
      { ...context, member_key: betaKey },
      "references/deep/target.md",
      targetMarkdown,
    ),
  ).toBe(targetMarkdown.replace("../../../alpha/SKILL.md", `skill://${alphaPage}/SKILL.md`))
})

test("projection leaves command examples and original source bytes and hashes unchanged", async () => {
  for (const member of snapshot.members) {
    const memberContext = { ...context, member_key: member.member_key }
    for (const file of member.portable.files) {
      if (file.path.endsWith(".md"))
        projectSourceMemberMarkdown(memberContext, file.path, decoder.decode(file.bytes))
      const original = originals[`${member.source_path}/${file.path}`]!
      expect(file.bytes).toEqual(original)
      expect(digest(file.bytes)).toBe(
        manifest.members
          .find((item) => item.member_key === member.member_key)!
          .resources.find((item) => item.path === file.path)!.sha256,
      )
    }
  }
  expect(projectSourceMemberMarkdown(context, "SKILL.md", protectedExamples)).toBe(
    protectedExamples,
  )
  for (const [path, original] of Object.entries(originals))
    expect(new Uint8Array(await readFile(join(directory, path)))).toEqual(original)
  expect(
    await Effect.runPromise(
      buildSourceMemberManifest(sourceId, snapshot).pipe(Effect.provide(services)),
    ),
  ).toEqual(manifest)
})

test("same-name members in a different source or revision cannot supply publication identity", async () => {
  // The other source contains the same names, paths and bytes, including beta.
  const otherManifest = await Effect.runPromise(
    buildSourceMemberManifest("44444444-4444-4444-8444-444444444444", snapshot).pipe(
      Effect.provide(services),
    ),
  )
  invalid(
    () =>
      resolveSourceMemberLink(
        { ...context, manifest: otherManifest },
        "SKILL.md",
        "../beta/SKILL.md",
      ),
    "SOURCE_REVISION_UNAVAILABLE",
  )
  invalid(
    () =>
      resolveSourceMemberLink(
        { ...context, source_id: "44444444-4444-4444-8444-444444444444" },
        "SKILL.md",
        "../beta/SKILL.md",
      ),
    "SOURCE_REVISION_UNAVAILABLE",
  )
  invalid(
    () =>
      resolveSourceMemberLink(
        { ...context, revision: "f".repeat(40) },
        "SKILL.md",
        "../beta/SKILL.md",
      ),
    "SOURCE_REVISION_UNAVAILABLE",
  )
})

test("full manifest retains an unpublished target and retries successfully when its exact page appears", () => {
  const pending = {
    ...context,
    published: context.published.filter((item) => item.member_key !== betaKey),
  }
  expect(pending.manifest.members.find((item) => item.member_key === betaKey)?.resources).toEqual(
    manifest.members[1]!.resources,
  )
  const unavailable: {
    from_path: string
    href: string
    reason: "outside_source_root" | "target_unavailable"
  }[] = []
  expect(
    projectSourceMemberMarkdown(pending, "SKILL.md", alphaMarkdown, (entry) =>
      unavailable.push(entry),
    ),
  ).toBe(
    alphaMarkdown.replace(
      "../../packages/runtime.ts#L1)",
      `https://github.com/example/upstream/blob/${snapshot.revision}/packages/runtime.ts#L1)`,
    ),
  )
  expect(unavailable.length).toBeGreaterThan(0)
  expect(unavailable.every((entry) => entry.reason === "target_unavailable")).toBe(true)
  const ready = {
    ...pending,
    published: [...pending.published, { member_key: betaKey, page_id: betaPage }],
  }
  expect(resolveSourceMemberLink(ready, "SKILL.md", "../beta/references/deep/target.md")).toBe(
    `skill://${betaPage}/references/deep/target.md`,
  )
  expect(projectSourceMemberMarkdown(ready, "SKILL.md", alphaMarkdown)).toBe(
    projectSourceMemberMarkdown(context, "SKILL.md", alphaMarkdown),
  )
  // Removing the target's active publication must not fall back to its name.
  invalid(
    () => resolveSourceMemberLink(pending, "SKILL.md", "../beta/SKILL.md"),
    "SOURCE_MEMBER_UNAVAILABLE",
  )
  const removedManifest = {
    ...manifest,
    members: manifest.members.filter((item) => item.member_key !== betaKey),
  }
  invalid(
    () =>
      resolveSourceMemberLink(
        {
          ...context,
          manifest: removedManifest,
          repository_url: "https://github.com/example/upstream.git",
        },
        "SKILL.md",
        "../beta/SKILL.md",
      ),
    "SOURCE_MEMBER_UNAVAILABLE",
  )
  invalid(
    () =>
      resolveSourceMemberLink(
        { ...context, manifest: removedManifest, member_key: betaKey },
        "SKILL.md",
        "../alpha/SKILL.md",
      ),
    "SOURCE_MEMBER_UNAVAILABLE",
  )
})

test("own destinations remain authored while cross-member and containing-file resources require inventory", () => {
  expect(resolveSourceMemberLink(context, "SKILL.md", "assets/missing.bin")).toBe(
    "assets/missing.bin",
  )
  invalid(
    () => resolveSourceMemberLink(context, "SKILL.md", "../beta/assets/missing.bin"),
    "SOURCE_RESOURCE_UNAVAILABLE",
  )
  invalid(
    () => resolveSourceMemberLink(context, "references/missing.md", "../beta/SKILL.md"),
    "SOURCE_RESOURCE_UNAVAILABLE",
  )
  const duplicate = {
    ...context,
    published: [...context.published, { member_key: betaKey, page_id: alphaPage }],
  }
  invalid(
    () => resolveSourceMemberLink(duplicate, "SKILL.md", "../beta/SKILL.md"),
    "SOURCE_MEMBER_UNAVAILABLE",
  )
})

test("repository escape and encoded unsafe paths reject before becoming resource or external refs", () => {
  const external = { ...context, repository_url: "https://github.com/example/upstream.git" }
  for (const destination of [
    "../../../outside.md",
    "%2e%2e/%2e%2e/%2e%2e/outside.md",
    "%2fetc/passwd",
    "%2f%2fexample.test/outside.md",
    "%43%3a/absolute.md",
    "..%5c..%5coutside.md",
    "assets/%00bad.bin",
    "assets/%0abad.bin",
    "assets/%zz.bin",
  ])
    invalid(() => resolveSourceMemberLink(external, "SKILL.md", destination), "INVALID_PATH")
})

test("repository prerequisites use GitHub blob hrefs pinned to the discovered commit", () => {
  const external = { ...context, repository_url: "https://github.com/example/upstream.git" }
  const href = `https://github.com/example/upstream/blob/${snapshot.revision}/packages/runtime.ts#L1`
  expect(resolveSourceMemberLink(external, "SKILL.md", "../../packages/runtime.ts#L1")).toBe(href)
  expect(
    projectSourceMemberMarkdown(
      external,
      "references/nested/guide.md",
      "[runtime](../../../../packages/runtime.ts#L1)",
    ),
  ).toBe(`[runtime](${href})`)
  invalid(
    () =>
      resolveSourceMemberLink(
        { ...context, repository_url: undefined },
        "SKILL.md",
        "../../packages/runtime.ts",
      ),
    "SOURCE_PREREQUISITE_UNAVAILABLE",
  )
  invalid(
    () => resolveSourceMemberLink(external, "SKILL.md", "../../packages/missing.ts"),
    "SOURCE_PREREQUISITE_UNAVAILABLE",
  )
  invalid(
    () =>
      resolveSourceMemberLink(
        { ...external, manifest: { ...manifest, external_resources: [] } },
        "SKILL.md",
        "../../packages/runtime.ts",
      ),
    "SOURCE_PREREQUISITE_UNAVAILABLE",
  )
})

test("outside-root authored href is retained as an unavailable prerequisite without weakening file resolution", () => {
  const href = "../../Factory/wechat-article-to-markdown/HANDOFF.md"
  const bytes = encoder.encode(`[Root-only handoff](${href})`)
  const member: SourceSnapshot["members"][number] = {
    member_key: ".",
    source_path: ".",
    upstream_hash: "a".repeat(64),
    content_hash: "b".repeat(64),
    portable: {
      kind: "skill",
      name: "Root skill",
      description: "Fixture",
      main: "SKILL.md",
      files: [
        { path: "SKILL.md", bytes: encoder.encode("# Root") },
        { path: "CHANGELOG.md", bytes },
      ],
    },
  }
  const unavailable: { reason: "outside_source_root"; from_path: string; href: string }[] = []
  expect(sourceExternalResourceTargets([member], [], (entry) => unavailable.push(entry))).toEqual(
    [],
  )
  expect(unavailable).toEqual([{ reason: "outside_source_root", from_path: "CHANGELOG.md", href }])
  expect(decoder.decode(bytes)).toBe(`[Root-only handoff](${href})`)
  const ownManifest: SourceMemberManifest = {
    version: 1,
    source_id: sourceId,
    revision: snapshot.revision,
    members: [
      {
        member_key: ".",
        source_path: ".",
        main: "SKILL.md",
        resources: member.portable.files.map((file) => ({
          path: file.path,
          sha256: digest(file.bytes),
        })),
      },
    ],
  }
  const projectedUnavailable: {
    from_path: string
    href: string
    reason: "outside_source_root" | "target_unavailable"
  }[] = []
  expect(
    projectSourceMemberMarkdown(
      { ...context, manifest: ownManifest, member_key: "." },
      "CHANGELOG.md",
      decoder.decode(bytes),
      (entry) => projectedUnavailable.push(entry),
    ),
  ).toBe(decoder.decode(bytes))
  expect(projectedUnavailable).toEqual(unavailable)
  invalid(
    () => resolveSourceMemberLink(context, "SKILL.md", "../../../host-file.md"),
    "INVALID_PATH",
  )
})
