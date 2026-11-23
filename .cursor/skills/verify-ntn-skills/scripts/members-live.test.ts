import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { currentId, currentLibrary } from "../../../../packages/core/test/shared-current-fixture.ts"
import {
  membersVerifier,
  currentFileEvidence,
  observeSkillRelations,
  requireZeroNotionWrites,
  sanitizeEvidence,
  treeEvidence,
  verifyMembersCorpus,
} from "./members-live.ts"

const ownerId = currentId(501),
  memberId = currentId(502),
  skillId = "lever-controlled-owner"
const metric = (writes = 0) => ({ request_metrics: { requests: { notion_write: writes } } })
const temporaryRoot = async (prefix: string) => mkdtemp(join(await realpath(tmpdir()), prefix))
const executeFile = promisify(execFile)
function observedPage(members: readonly string[] = [], requires: readonly string[] = []) {
  const fields = currentLibrary.skills.property_ids
  return {
    object: "page",
    id: ownerId,
    parent: { type: "data_source_id", data_source_id: currentLibrary.skills.data_source_id },
    properties: {
      Identity: { id: fields["Skill ID"], type: "rich_text", rich_text: [{ plain_text: skillId }] },
      Kind: { id: fields.Kind, type: "select", select: { name: "skill" } },
      State: { id: fields["Current State"], type: "select", select: { name: "ready" } },
      Enabled: { id: fields.Enabled, type: "checkbox", checkbox: true },
      Members: {
        id: fields.Members,
        type: "relation",
        relation: members.map((id) => ({ id })),
        has_more: false,
      },
      Requires: {
        id: fields.Requires,
        type: "relation",
        relation: requires.map((id) => ({ id })),
        has_more: false,
      },
      Supporting: { id: "not-a-selected-relation", type: "relation", relation: [], has_more: true },
    },
  }
}

test("relation readback ignores unrelated truncated file relations but requires complete selected sets", () => {
  const page = observedPage([memberId])
  expect(observeSkillRelations(page, currentLibrary, { pageId: ownerId, skillId })).toEqual({
    page_id: ownerId,
    skill_id: skillId,
    enabled: true,
    members: [memberId],
    requires: [],
  })
  expect(() =>
    observeSkillRelations(
      {
        ...page,
        properties: { ...page.properties, Members: { ...page.properties.Members, has_more: true } },
      },
      currentLibrary,
      { pageId: ownerId, skillId },
    ),
  ).toThrow("Members is truncated")
  expect(() =>
    observeSkillRelations({ ...page, parent: { data_source_id: currentId(999) } }, currentLibrary, {
      pageId: ownerId,
      skillId,
    }),
  ).toThrow("exact test Skills")
  expect(() =>
    observeSkillRelations(page, currentLibrary, { pageId: ownerId, skillId: "another" }),
  ).toThrow()
})

test("a successful import acknowledgement cannot conceal missing actual automatic Members", async () => {
  const calls: string[][] = [],
    observations: unknown[] = []
  let probes = 0
  const verify = membersVerifier({
    library: currentLibrary,
    drive: async (argv) => {
      calls.push(argv)
      const dryRun = argv.includes("--dry-run")
      return {
        exit: 0,
        record: `controlled-${calls.length}`,
        output: {
          ok: true,
          ...metric(),
          page_id: dryRun ? null : ownerId,
          skill_id: skillId,
          state: "ready",
          members_discovery: { confirmed: [{ member: "claimed-member" }] },
        },
      }
    },
    probe: async () => {
      probes++
      return observedPage()
    },
    record: async (_label, value) => {
      observations.push(value)
    },
  })
  await expect(
    (async () => {
      const owner = await verify.importSkill("automatic", "/controlled/input", skillId, {
        members: [memberId],
        requires: [],
      })
      await verify.execute("forbidden-posthoc-repair", [
        "ctl",
        "library",
        "skill",
        "update",
        owner.pageId,
        "--entry",
        currentLibrary.skills.database_id,
        "--members",
        memberId,
      ])
    })(),
  ).rejects.toThrow()
  expect(calls).toHaveLength(2)
  expect(calls.every((call) => call.slice(0, 3).join(" ") === "ctl library import")).toBe(true)
  expect(probes).toBe(1)
  expect(observations.at(-1)).toMatchObject({
    source: "independent_page_get",
    expected: { members: [memberId] },
    actual: { members: [] },
  })
})

test("first-creation proof orders dry-run, selected import and independent read before returning", async () => {
  const order: string[] = []
  const verify = membersVerifier({
    library: currentLibrary,
    drive: async (argv) => {
      const dryRun = argv.includes("--dry-run")
      order.push(dryRun ? "dry-run" : "import")
      return {
        exit: 0,
        record: "controlled",
        output: {
          ok: true,
          ...metric(),
          page_id: dryRun ? null : ownerId,
          skill_id: skillId,
          state: "ready",
        },
      }
    },
    probe: async (id) => {
      expect(id).toBe(ownerId)
      order.push("page-get")
      return observedPage([memberId])
    },
  })
  const owner = await verify.importSkill("first", "/controlled/input", skillId, {
    members: [memberId],
    requires: [],
  })
  expect(owner.pageId).toBe(ownerId)
  expect(order).toEqual(["dry-run", "import", "page-get"])
})

test("failed or unmeasured dry-run stops before apply and preserves its receipt", async () => {
  for (const response of [
    { exit: 2, output: { ok: false } },
    { exit: 0, output: { ok: true, page_id: null } },
    { exit: 0, output: { ok: true, page_id: null, ...metric(1) } },
    { exit: 0, output: { ok: true, page_id: ownerId, ...metric() } },
  ]) {
    let calls = 0
    const verify = membersVerifier({
      library: currentLibrary,
      drive: async () => {
        calls++
        return { ...response, record: "retained-original-operation" }
      },
      probe: async () => {
        throw new Error("Unexpected page read")
      },
    })
    await expect(
      verify.importSkill("refuse", "/controlled/input", skillId, { members: [], requires: [] }),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  }
  expect(() => requireZeroNotionWrites({})).toThrow("Missing actual")
  expect(() => requireZeroNotionWrites(metric())).not.toThrow()
})

test("a public action cannot escape the retained test library", async () => {
  let calls = 0
  const verify = membersVerifier({
    library: currentLibrary,
    drive: async () => {
      calls++
      throw new Error("Unexpected driver call")
    },
  })
  await expect(
    verify.execute("foreign", ["read", ownerId, "--database", currentId(999)]),
  ).rejects.toThrow("exact library")
  expect(calls).toBe(0)
})

test("file preservation needs real stable IDs and unique paths before comparing inventories", () => {
  const main = { path: "SKILL.md", file_id: "main-stable", page_id: ownerId }
  const child = { path: "references/guide.md", file_id: "child-stable", page_id: memberId }
  expect(currentFileEvidence({ main, files: [main, child] })).toEqual({
    main,
    files: [main, child],
  })
  for (const invalid of [
    { ...child, file_id: undefined },
    { ...child, file_id: "" },
    { ...child, page_id: "unknown" },
  ]) {
    expect(() => currentFileEvidence({ main, files: [main, invalid] })).toThrow()
  }
  expect(() => currentFileEvidence({ main, files: [main, child, child] })).toThrow("unique")
})

test("tree evidence checks binary bytes, BOM/CRLF and executable mode without rewriting them", async () => {
  const root = await temporaryRoot("members-lever-tree-")
  const main = Buffer.from("\uFEFF---\r\nname: example\r\n---\r\n[Link](../target/SKILL.md)\r\n")
  const binary = Buffer.from([0, 255, 128, 13, 10])
  await writeFile(join(root, "SKILL.md"), main)
  await writeFile(join(root, "opaque.bin"), binary)
  await writeFile(join(root, "run.sh"), "#!/bin/sh\n")
  await chmod(join(root, "run.sh"), 0o700)
  const files = await treeEvidence(root)
  expect(files.find((file) => file.path === "SKILL.md")).toMatchObject({
    bytes: main.length,
    sha256: createHash("sha256").update(main).digest("hex"),
  })
  expect(files.find((file) => file.path === "opaque.bin")).toMatchObject({ bytes: binary.length })
  expect(files.find((file) => file.path === "run.sh")?.mode).toBe("100755")
  expect(await readFile(join(root, "SKILL.md"))).toEqual(main)
  await symlink(join(root, "SKILL.md"), join(root, "alias.md"))
  await expect(treeEvidence(root)).rejects.toThrow("symbolic links")
})

test("corpus bytes and self-reported hashes must match the actual fixed commit and path", async () => {
  const root = await temporaryRoot("members-lever-corpus-")
  const names = [
    "poteto-mode",
    "unslop",
    "principle-minimize-reader-load",
    "principle-guard-the-context-window",
    "architect",
    "arena",
  ]
  const skills = await Promise.all(
    names.map(async (name) => {
      const folder = join(root, "pstack", "skills", name),
        bytes = Buffer.from(
          `---\nname: ${name}\ndescription: Controlled corpus verifier test only.\n---\n`,
        )
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, "SKILL.md"), bytes)
      const hash = createHash("sha256").update(bytes).digest("hex")
      return {
        name,
        commit: "a".repeat(40),
        repository_path: `pstack/skills/${name}`,
        input_path: folder,
        file_count: 1,
        total_bytes: bytes.length,
        main_sha256: hash,
        manifest_sha256: createHash("sha256").update(`SKILL.md\0${hash}\n`).digest("hex"),
        files: [
          {
            path: "SKILL.md",
            bytes: bytes.length,
            sha256: hash,
            git_blob: createHash("sha1")
              .update(`blob ${bytes.length}\0`)
              .update(bytes)
              .digest("hex"),
            mode: "100644",
          },
        ],
      }
    }),
  )
  // Only this disposable test repository gets objects/index writes. The real
  // corpus verifier uses ls-tree exclusively and never writes its source clone.
  const git = async (...args: string[]) =>
    (
      await executeFile(
        "git",
        ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
        { encoding: "utf8" },
      )
    ).stdout.trim()
  await git("init", "--quiet", "--template=")
  await git("add", "--", "pstack")
  const tree = await git("write-tree")
  const commit = await git(
    "-c",
    "user.name=Members controlled fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit-tree",
    tree,
    "-m",
    "Controlled corpus objects",
  )
  for (const item of skills) item.commit = commit
  const path = join(root, "corpus.json")
  const save = () =>
    writeFile(
      path,
      JSON.stringify({
        version: 1,
        repository_url: "https://github.com/cursor/plugins",
        source_checkout: root,
        skills,
      }),
    )
  await save()
  expect((await verifyMembersCorpus(path)).skills).toHaveLength(6)

  // Self-consistent edited bytes plus edited hashes used to pass despite an
  // unchanged claimed commit. They must now fail against its actual tree blob.
  const architect = skills.find((item) => item.name === "architect")!
  const replacement = Buffer.from("Self-consistent replacement outside the fixed tree.\n")
  await writeFile(join(architect.input_path, "SKILL.md"), replacement)
  const hash = createHash("sha256").update(replacement).digest("hex")
  architect.total_bytes = replacement.length
  architect.main_sha256 = hash
  architect.manifest_sha256 = createHash("sha256").update(`SKILL.md\0${hash}\n`).digest("hex")
  architect.files = [
    {
      path: "SKILL.md",
      bytes: replacement.length,
      sha256: hash,
      git_blob: createHash("sha1")
        .update(`blob ${replacement.length}\0`)
        .update(replacement)
        .digest("hex"),
      mode: "100644",
    },
  ]
  await save()
  await expect(verifyMembersCorpus(path)).rejects.toThrow("exact fixed commit/path")
  await writeFile(join(architect.input_path, "SKILL.md"), "tampered again")
  await expect(verifyMembersCorpus(path)).rejects.toThrow()
})

test("evidence excludes credentials and signed attachment queries while retaining identities", () => {
  const cleaned = sanitizeEvidence({
    authorization: "Bearer sensitive",
    token: "sensitive",
    url: "https://example.invalid/asset.png?X-Amz-Credential=value&X-Amz-Signature=secret",
    nested: ["secret_abcdefghijklmnop", "ntn_abcdefghijklmnop", "Bearer abc123"],
    ref: "skill://shared_skill%3Alibrary-current%3Aowner/SKILL.md?file_id=main-id",
  })
  expect(cleaned).toEqual({
    authorization: "[redacted]",
    token: "[redacted]",
    url: "https://example.invalid/asset.png?[redacted-query]",
    nested: ["[redacted-token]", "[redacted-token]", "Bearer [redacted]"],
    ref: "skill://shared_skill%3Alibrary-current%3Aowner/SKILL.md?file_id=main-id",
  })
  expect(
    sanitizeEvidence(
      {
        stderr: "failed credential opaque-sensitive-value",
        non_json_stdout: "opaque-sensitive-value",
        signal: "SIGTERM",
      },
      ["opaque-sensitive-value"],
    ),
  ).toEqual({
    stderr: "failed credential [redacted-secret]",
    non_json_stdout: "[redacted-secret]",
    signal: "SIGTERM",
  })
})
