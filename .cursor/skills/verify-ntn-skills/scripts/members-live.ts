import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Schema } from "effect"
import { property } from "../../../../packages/core/src/model.ts"
import { MANIFEST } from "../../../../packages/core/src/portable.ts"
import { fileRef, pageId } from "../../../../packages/core/src/ref.ts"
import {
  SharedLibrarySchema,
  type SharedLibrary,
} from "../../../../packages/core/src/shared-library-model.ts"
import { requireTestCommand } from "./empty-library.ts"

type Drive = (argv: string[]) => Promise<{ output: unknown; exit: number; record: string }>
type Probe = (id: string) => Promise<unknown>
type Relations = { readonly members: readonly string[]; readonly requires: readonly string[] }
type FileEvidence = {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly mode: "100644" | "100755"
}
type Owner = {
  readonly skillId: string
  readonly pageId: string
  readonly selector: string
  readonly ref: string
  readonly input: string
  readonly result: Record<string, unknown>
}
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const executeFile = promisify(execFile)
const ordered = (values: readonly string[]) => [...values].sort()
const objects = (value: unknown): Record<string, unknown>[] => {
  assert.ok(Array.isArray(value), "Expected a complete array")
  return value.map(property)
}
const identity = (library: SharedLibrary, skillId: string) =>
  `shared_skill:${encodeURIComponent(library.library_id)}:${encodeURIComponent(skillId)}`
const noRelations: Relations = { members: [], requires: [] }

/** Observe the actual page, not the import acknowledgement or a prepared fixture. */
export function observeSkillRelations(
  raw: unknown,
  library: SharedLibrary,
  expected: { readonly pageId: string; readonly skillId: string },
) {
  const row = property(raw)
  assert.equal(row.object, "page")
  assert.equal(pageId(String(row.id)), pageId(expected.pageId))
  assert.ok(pageId(expected.pageId), "The imported page identity must be a UUID")
  assert.equal(
    pageId(String(property(row.parent).data_source_id)),
    pageId(library.skills.data_source_id),
    "A relation observation must belong to the exact test Skills data source",
  )
  assert.notEqual(row.in_trash, true)
  assert.notEqual(row.archived, true)
  const fields = Object.values(property(row.properties)).map(property)
  const field = (name: string, type: string) => {
    const id = library.skills.property_ids[name]
    assert.equal(typeof id, "string", `The library must register ${name}`)
    const matches = fields.filter((value) => value.id === id)
    assert.equal(matches.length, 1, `The page must contain exactly one registered ${name}`)
    const value = matches[0]!
    assert.equal(value.type, type)
    assert.notEqual(
      value.has_more,
      true,
      `${name} is truncated; no complete-set assertion is possible`,
    )
    return value
  }
  const skillId = objects(field("Skill ID", "rich_text").rich_text)
    .map((part) => part.plain_text ?? property(part.text).content)
    .join("")
  assert.equal(skillId, expected.skillId)
  assert.equal(property(field("Kind", "select").select).name, "skill")
  assert.equal(property(field("Current State", "select").select).name, "ready")
  const enabled = field("Enabled", "checkbox").checkbox
  assert.equal(typeof enabled, "boolean")
  const relation = (name: "Members" | "Requires") => {
    const ids = objects(field(name, "relation").relation).map((item) => {
      const id = pageId(String(item.id))
      assert.ok(id, `${name} contains a non-page identity`)
      return id
    })
    assert.equal(new Set(ids).size, ids.length, `${name} contains repeated identities`)
    return ordered(ids)
  }
  return {
    page_id: expected.pageId,
    skill_id: skillId,
    enabled,
    members: relation("Members"),
    requires: relation("Requires"),
  }
}

export function requireZeroNotionWrites(output: unknown) {
  const writes = property(property(property(output).request_metrics).requests).notion_write
  assert.equal(typeof writes, "number", "Missing actual Notion write metrics is not zero writes")
  assert.equal(writes, 0, "This read/dry-run/no-op performed a Notion write")
}

export function currentFileEvidence(output: unknown) {
  const read = (value: unknown) => {
    const file = property(value)
    assert.ok(typeof file.path === "string" && file.path.length > 0, "Missing current file path")
    assert.ok(typeof file.file_id === "string" && file.file_id.length > 0, "Missing stable File ID")
    const id = typeof file.page_id === "string" ? pageId(file.page_id) : undefined
    assert.ok(id, "Missing current file page UUID")
    return { path: file.path, file_id: file.file_id, page_id: id }
  }
  const result = property(output),
    main = read(result.main),
    files = objects(result.files).map(read)
  assert.equal(
    new Set(files.map((file) => file.path)).size,
    files.length,
    "Current file paths must be unique",
  )
  const listedMain = files.find((file) => file.path === main.path)
  if (listedMain) assert.deepEqual(listedMain, main)
  return { main, files }
}

/** Logical executable mode is the portable contract; permission masks may be private. */
export async function treeEvidence(root: string): Promise<readonly FileEvidence[]> {
  assert.ok(isAbsolute(root), "Use an absolute physical fixture path")
  assert.equal(await realpath(root), resolve(root), "Fixture parents must not be symlink aliases")
  const result: FileEvidence[] = []
  const walk = async (folder: string) => {
    const names = await readdir(folder)
    for (const name of names.sort()) {
      const path = join(folder, name),
        info = await lstat(path)
      assert.equal(info.isSymbolicLink(), false, "Fixtures cannot contain symbolic links")
      if (info.isDirectory()) await walk(path)
      else {
        assert.ok(info.isFile(), "Fixtures contain only regular files")
        const bytes = await readFile(path)
        result.push({
          path: relative(root, path).split("\\").join("/"),
          bytes: bytes.length,
          sha256: digest(bytes),
          mode: (info.mode & 0o111) === 0 ? "100644" : "100755",
        })
      }
    }
  }
  assert.ok((await lstat(root)).isDirectory())
  await walk(root)
  return result.sort((a, b) => a.path.localeCompare(b.path, "en"))
}
const authored = (files: readonly FileEvidence[]) => files.filter((file) => file.path !== MANIFEST)
const manifestDigest = (files: readonly FileEvidence[]) =>
  digest(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((file) => `${file.path}\0${file.sha256}\n`)
      .join(""),
  )
async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
}
async function writeTree(
  root: string,
  files: readonly {
    readonly path: string
    readonly content: string | Uint8Array
    readonly executable?: boolean
  }[],
) {
  await mkdir(root, { mode: 0o700 })
  for (const file of files) {
    assert.ok(file.path && !isAbsolute(file.path) && !file.path.split("/").includes(".."))
    const path = join(root, file.path)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, file.content, { flag: "wx", mode: file.executable ? 0o700 : 0o600 })
    if (file.executable) await chmod(path, 0o700)
  }
  return root
}
async function copyTree(source: string, destination: string, omit: readonly string[] = []) {
  const files = await treeEvidence(source)
  await writeTree(
    destination,
    await Promise.all(
      files
        .filter((file) => !omit.includes(file.path))
        .map(async (file) => ({
          path: file.path,
          content: await readFile(join(source, file.path)),
          executable: file.mode === "100755",
        })),
    ),
  )
  return destination
}
const mainText = (body: string, name = "Members live verification") =>
  `---\nname: ${name}\ndescription: Dedicated import verification fixture.\n---\n\n${body}\n`

/** Shared by the live lever and its controlled regression: probe precedes all manual edits. */
export function membersVerifier(input: {
  readonly library: SharedLibrary
  readonly drive: Drive
  readonly probe?: Probe
  readonly record?: (label: string, value: unknown) => Promise<void>
}) {
  const library = input.library
  const record = input.record ?? (async () => {})
  const accept = async (label: string, result: Awaited<ReturnType<Drive>>) => {
    await record(label, result)
    assert.equal(
      result.exit,
      0,
      `Command failed; preserve its original operation and result: ${result.record}`,
    )
    assert.equal(
      property(result.output).ok,
      true,
      `Command has no success result: ${result.record}`,
    )
    return property(result.output)
  }
  const execute = async (label: string, argv: string[]) => {
    requireTestCommand(argv, library)
    return accept(label, await input.drive(argv))
  }
  const observe = async (
    label: string,
    owner: Pick<Owner, "pageId" | "skillId">,
    expected: Relations,
  ) => {
    let raw: unknown
    if (input.probe) raw = await input.probe(owner.pageId)
    else {
      assert.ok(pageId(owner.pageId))
      const output = await accept(
        `${label}-page-get`,
        await input.drive(["ctl", "api", `v1/pages/${owner.pageId}`]),
      )
      requireZeroNotionWrites(output)
      raw = output.response
    }
    const actual = observeSkillRelations(raw, library, owner)
    // Persist before comparing: a failed automatic write must remain visible.
    await record(`${label}-independent-relations`, {
      expected,
      actual,
      source: "independent_page_get",
    })
    assert.deepEqual(actual.members, ordered(expected.members))
    assert.deepEqual(actual.requires, ordered(expected.requires))
    return actual
  }
  const importSkill = async (
    label: string,
    path: string,
    skillId: string,
    expected: Relations,
    fresh = true,
  ): Promise<Owner> => {
    const args = [
      "ctl",
      "library",
      "import",
      path,
      "--entry",
      library.skills.database_id,
      "--skill-id",
      skillId,
    ]
    const review = await execute(`${label}-dry-run`, [...args, "--dry-run"])
    requireZeroNotionWrites(review)
    if (fresh)
      assert.equal(
        review.page_id,
        null,
        "This first-creation case already exists; use a new run prefix",
      )
    const result = await execute(`${label}-import`, args)
    const id = pageId(String(result.page_id))
    assert.ok(id, "Import did not return an allocated page")
    assert.equal(result.state, "ready")
    assert.equal(result.skill_id, skillId)
    const selector = identity(library, skillId)
    const owner = {
      skillId,
      pageId: id,
      selector,
      ref: fileRef(selector, "SKILL.md"),
      input: path,
      result,
    }
    const actual = await observe(`${label}-first-readback`, owner, expected)
    assert.equal(actual.enabled, true, "An imported test Skill must be enabled")
    return owner
  }
  const noop = async (label: string, owner: Owner, expected: Relations) => {
    const result = await execute(label, [
      "ctl",
      "library",
      "import",
      owner.input,
      "--entry",
      library.skills.database_id,
      "--skill-id",
      owner.skillId,
    ])
    assert.equal(result.status, "unchanged")
    assert.equal(result.page_id, owner.pageId)
    requireZeroNotionWrites(result)
    await observe(`${label}-readback`, owner, expected)
    return result
  }
  return { execute, observe, importSkill, noop }
}

const Corpus = Schema.Struct({
  version: Schema.Literal(1),
  repository_url: Schema.String,
  source_checkout: Schema.String,
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      commit: Schema.String,
      repository_path: Schema.String,
      input_path: Schema.String,
      file_count: Schema.Number,
      total_bytes: Schema.Number,
      main_sha256: Schema.String,
      manifest_sha256: Schema.String,
      files: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          bytes: Schema.Number,
          sha256: Schema.String,
          git_blob: Schema.String,
          mode: Schema.Literals(["100644", "100755"]),
        }),
      ),
    }),
  ),
})
type CorpusSkill = (typeof Corpus.Type.skills)[number]
const corpusNames = [
  "poteto-mode",
  "unslop",
  "principle-minimize-reader-load",
  "principle-guard-the-context-window",
  "architect",
  "arena",
] as const
export async function verifyMembersCorpus(path: string) {
  const bytes = await readFile(path)
  const corpus = Schema.decodeUnknownSync(Corpus)(JSON.parse(bytes.toString("utf8")))
  assert.equal(corpus.repository_url, "https://github.com/cursor/plugins")
  assert.ok(isAbsolute(corpus.source_checkout), "Corpus requires its physical source checkout")
  assert.deepEqual(ordered(corpus.skills.map((item) => item.name)), ordered(corpusNames))
  for (const item of corpus.skills) {
    assert.match(item.commit, /^[a-f0-9]{40}$/u)
    assert.equal(item.repository_path, `pstack/skills/${item.name}`)
    const files = await treeEvidence(item.input_path)
    assert.equal(files.length, item.file_count)
    assert.equal(
      files.reduce((sum, file) => sum + file.bytes, 0),
      item.total_bytes,
    )
    assert.equal(files.find((file) => file.path === "SKILL.md")?.sha256, item.main_sha256)
    assert.equal(manifestDigest(files), item.manifest_sha256)
    assert.deepEqual(
      files,
      item.files
        .map(({ git_blob: _blob, ...file }) => file)
        .sort((a, b) => a.path.localeCompare(b.path, "en")),
    )
    // The source checkout is read-only. ls-tree needs tree objects, not missing
    // partial-clone blobs. A missing tree/commit fails without fetching or fallback.
    const tree = await executeFile(
      "git",
      [
        "-C",
        corpus.source_checkout,
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        item.commit,
        "--",
        `${item.repository_path}/`,
      ],
      {
        env: {
          ...process.env,
          GIT_NO_LAZY_FETCH: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    )
    const prefix = `${item.repository_path}/`
    const committed = tree.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/u.exec(entry)
        assert.ok(match, "Fixed tree contains an unsupported entry")
        const path = match[3]
        assert.ok(
          path && path.startsWith(prefix),
          "Fixed tree contains an unsupported or foreign entry",
        )
        return { path: path.slice(prefix.length), mode: match[1], git_blob: match[2] }
      })
      .sort((a, b) => a.path.localeCompare(b.path, "en"))
    assert.deepEqual(
      committed,
      item.files
        .map(({ path, mode, git_blob }) => ({ path, mode, git_blob }))
        .sort((a, b) => a.path.localeCompare(b.path, "en")),
      "Corpus inventory differs from its exact fixed commit/path",
    )
    for (const file of item.files) {
      const raw = await readFile(join(item.input_path, file.path))
      const blob = createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex")
      assert.equal(blob, file.git_blob, "Corpus bytes must match the recorded Git blob")
    }
  }
  return { ...corpus, corpus_sha256: digest(bytes) }
}

export async function runMembersLive(input: {
  readonly root: string
  readonly library: SharedLibrary
  readonly corpus: string
  readonly prefix: string
  readonly drive: Drive
  readonly probe?: Probe
  readonly execution?: Record<string, unknown>
}) {
  assert.ok(isAbsolute(input.root))
  assert.match(input.prefix, /^[a-z0-9][a-z0-9-]{0,70}$/u)
  const library = Schema.decodeUnknownSync(SharedLibrarySchema)(input.library)
  for (const table of [library.skills, library.files, library.records, library.sources]) {
    assert.ok(pageId(table.database_id) && pageId(table.data_source_id))
  }
  // Admission precedes any remote command and verifies all real inputs, not selected files only.
  const corpus = await verifyMembersCorpus(input.corpus)
  for (const skill of corpus.skills) {
    const commit = ["poteto-mode", "unslop"].includes(skill.name)
      ? "aaeb0ea3a0584995aa8f55ce44c6c5259414b896"
      : "c742dd61706fbacc1b95f1a20b7b988cf096ce6c"
    assert.equal(
      skill.commit,
      commit,
      "This journey requires its explicitly selected upstream revisions",
    )
  }
  await mkdir(dirname(input.root), { recursive: true, mode: 0o700 })
  await mkdir(input.root, { mode: 0o700 })
  const fixtures = join(input.root, "fixtures"),
    outputs = join(input.root, "outputs")
  await mkdir(fixtures, { mode: 0o700 })
  await mkdir(outputs, { mode: 0o700 })
  let sequence = 0
  const report = {
    version: 1,
    status: "running",
    prefix: input.prefix,
    library,
    execution: input.execution ?? { layer: "injected_driver", model_delivery: "not_observed" },
    corpus: {
      path: input.corpus,
      sha256: corpus.corpus_sha256,
      repository_url: corpus.repository_url,
      skills: corpus.skills.map(({ files: _files, ...skill }) => skill),
    },
    cases: [] as Array<{
      name: string
      source: string
      status: string
      evidence?: unknown
      error?: string
    }>,
    current_case: "admission",
  }
  const saveReport = () => writeJson(join(input.root, "report.json"), sanitizeEvidence(report))
  const record = async (label: string, value: unknown) => {
    await writeJson(
      join(input.root, "observations", `${String(++sequence).padStart(4, "0")}-${label}.json`),
      sanitizeEvidence(value),
    )
  }
  const verify = membersVerifier({ library, drive: input.drive, probe: input.probe, record })
  const stage = async <A>(name: string, source: string, run: () => Promise<A>) => {
    report.current_case = name
    await saveReport()
    try {
      const evidence = await run()
      report.cases.push({ name, source, status: "passed", evidence })
      await saveReport()
      return evidence
    } catch (error) {
      report.cases.push({
        name,
        source,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown verification failure",
      })
      throw error
    }
  }
  const skillId = (suffix: string) => `${input.prefix}-${suffix}`
  const portable = async (path: string, relations: Relations, name: string) => {
    await writeJson(join(path, MANIFEST), {
      format: "ntn-skills",
      version: 2,
      kind: "skill",
      name,
      description: "Dedicated explicit relationship verification.",
      main: "SKILL.md",
      relations: {
        version: 1,
        ownership: "notion",
        library_id: library.library_id,
        members: relations.members,
        requires: relations.requires,
      },
    })
    return path
  }
  const exported = async (label: string, owner: Owner) => {
    const destination = join(outputs, label)
    const output = await verify.execute(`${label}-export`, [
      "export",
      owner.pageId,
      "--database",
      library.skills.database_id,
      "--refresh",
      "--output",
      destination,
    ])
    requireZeroNotionWrites(output)
    const actual = authored(await treeEvidence(destination)),
      expected = authored(await treeEvidence(owner.input))
    assert.deepEqual(
      actual,
      expected,
      "Export must preserve every authored path, byte and executable mode",
    )
    return {
      output: destination,
      file_count: actual.length,
      manifest_sha256: manifestDigest(actual),
    }
  }
  const plan = async (label: string, path: string, id: string, bindings?: unknown) => {
    const output = join(outputs, `${label}-portable`)
    const args = [
      "ctl",
      "library",
      "members-plan",
      path,
      "--entry",
      library.skills.database_id,
      "--skill-id",
      id,
      "--output",
      output,
    ]
    if (bindings !== undefined) {
      const bindingPath = join(fixtures, `${label}-bindings.json`)
      await writeJson(bindingPath, bindings)
      args.push("--bindings", bindingPath)
    }
    const result = await verify.execute(`${label}-plan`, args)
    requireZeroNotionWrites(result)
    if (result.importable === false) {
      assert.equal(result.output, null)
      await assert.rejects(lstat(output), { code: "ENOENT" })
    } else assert.equal(result.importable, true)
    return { result, output }
  }
  const confirm = (result: Record<string, unknown>, member: string, from: string, href: string) => {
    assert.ok(
      objects(result.confirmed).some(
        (entry) =>
          entry.member === member &&
          entry.from === from &&
          entry.href === href &&
          entry.rewritten === true,
      ),
      "The plan must retain exact source-file and href evidence",
    )
  }
  const assertRewrite = async (
    original: string,
    copy: string,
    changes: Readonly<Record<string, readonly [string, string][]>>,
  ) => {
    const before = authored(await treeEvidence(original)),
      after = authored(await treeEvidence(copy))
    assert.deepEqual(
      after.map((file) => [file.path, file.mode]),
      before.map((file) => [file.path, file.mode]),
    )
    for (const file of before) {
      let expected = await readFile(join(original, file.path))
      const replacements = changes[file.path]
      if (replacements) {
        let text = expected.toString("utf8")
        for (const [from, to] of replacements) {
          assert.equal(
            text.split(from).length,
            2,
            "The fixture must specify one exact destination occurrence",
          )
          text = text.replace(from, to)
        }
        expected = Buffer.from(text, "utf8")
      }
      assert.deepEqual(
        await readFile(join(copy, file.path)),
        expected,
        `Only confirmed link destinations may change: ${file.path}`,
      )
    }
  }
  const updateRelations = async (
    label: string,
    owner: Owner,
    members: readonly string[],
    requires?: readonly string[],
  ) => {
    const args = [
      "ctl",
      "library",
      "skill",
      "update",
      owner.pageId,
      "--entry",
      library.skills.database_id,
    ]
    for (const member of members.length ? members : [""]) args.push("--members", member)
    if (requires !== undefined)
      for (const dependency of requires.length ? requires : [""])
        args.push("--requires", dependency)
    return verify.execute(label, args)
  }
  const lookup = (name: (typeof corpusNames)[number]): CorpusSkill => {
    const selected = corpus.skills.find((skill) => skill.name === name)
    assert.ok(selected)
    return selected
  }

  try {
    const targets = await stage("synthetic-targets", "synthetic", async () => {
      const owners: Owner[] = []
      for (const suffix of ["target-a", "target-b", "target-disabled"]) {
        const path = await writeTree(join(fixtures, suffix), [
          { path: "SKILL.md", content: mainText("Leaf instructions.", "Same display name") },
          { path: "references/guide.md", content: "Supporting leaf guide.\n" },
        ])
        owners.push(await verify.importSkill(suffix, path, skillId(suffix), noRelations))
      }
      const disabled = owners[2]!
      await verify.execute("disable-target", [
        "ctl",
        "library",
        "skill",
        "update",
        disabled.pageId,
        "--entry",
        library.skills.database_id,
        "--enabled",
        "false",
      ])
      assert.equal(
        (await verify.observe("disabled-readback", disabled, noRelations)).enabled,
        false,
      )
      return owners
    })
    const [a, b, disabled] = targets as [Owner, Owner, Owner]
    const canonical = await stage(
      "canonical-first-creation-and-rejections",
      "synthetic",
      async () => {
        const foreign = fileRef(`shared_skill:foreign-${input.prefix}:absent`, "SKILL.md")
        const missing = fileRef(identity(library, skillId("missing")), "SKILL.md")
        const missingFile = fileRef(a.selector, "references/not-present.md")
        const wrongFile = fileRef(a.selector, "SKILL.md", undefined, "not-the-main-file-id")
        const nameOnly = "skill://Same-display-name/SKILL.md"
        const body = `[Exact target](${a.ref})\n\nSame display name is plain prose.\n\n[Foreign](${foreign})\n[Missing](${missing})\n[Missing file](${missingFile})\n[Wrong file identity](${wrongFile})\n[Disabled](${disabled.ref})\n[Name only](${nameOnly})\n\n\`[inline](${b.ref})\`\n\n\`\`\`md\n[fenced](${b.ref})\n\`\`\`\n\n<!-- [comment](${b.ref}) -->\n\n![image](${b.ref})\n\n\`../<name>/SKILL.md\``
        const path = await writeTree(join(fixtures, "canonical-owner"), [
          { path: "SKILL.md", content: mainText(body) },
          {
            path: "references/deep.md",
            content: `[Exact support](${fileRef(a.selector, "references/guide.md")})\n`,
          },
        ])
        const owner = await verify.importSkill("canonical", path, skillId("canonical"), {
          members: [a.pageId],
          requires: [],
        })
        const discovery = property(owner.result.members_discovery)
        assert.equal(discovery.member_policy, "first_creation")
        assert.deepEqual(
          ordered([...new Set(objects(discovery.confirmed).map((entry) => String(entry.member)))]),
          [a.selector],
        )
        const rejected = objects(discovery.unresolved)
        for (const href of [foreign, missing, missingFile, wrongFile, disabled.ref, nameOnly])
          assert.ok(
            rejected.some((entry) => entry.href === href),
            `Missing refusal evidence for ${href}`,
          )
        assert.ok(objects(discovery.confirmed).some((entry) => entry.from === "references/deep.md"))
        await exported("canonical-original", owner)
        await verify.noop("canonical-repeat", owner, { members: [a.pageId], requires: [] })
        return owner
      },
    )
    await stage("preserve-authored-members-and-manual-deletion", "synthetic", async () => {
      await updateRelations("manual-select-b", canonical, [b.pageId], [a.pageId])
      await verify.observe("manual-selection", canonical, {
        members: [b.pageId],
        requires: [a.pageId],
      })
      await verify.noop("preserve-manual-selection", canonical, {
        members: [b.pageId],
        requires: [a.pageId],
      })
      await updateRelations("manual-clear-members", canonical, [])
      await verify.observe("manual-deletion", canonical, { members: [], requires: [a.pageId] })
      await verify.noop("preserve-manual-deletion", canonical, {
        members: [],
        requires: [a.pageId],
      })
      return { page_id: canonical.pageId, members: [], requires: [a.pageId] }
    })
    await stage("explicit-empty-members-and-manual-requires", "synthetic_explicit", async () => {
      const path = await writeTree(join(fixtures, "explicit-empty"), [
        { path: "SKILL.md", content: mainText(`[Optional body link](${b.ref})`) },
      ])
      await portable(path, { members: [], requires: [a.selector] }, "Explicit empty Members")
      const owner = await verify.importSkill("explicit-empty", path, skillId("explicit-empty"), {
        members: [],
        requires: [a.pageId],
      })
      assert.equal(property(owner.result.members_discovery).member_policy, "explicit")
      await verify.noop("explicit-empty-repeat", owner, { members: [], requires: [a.pageId] })
      return owner
    })
    await stage(
      "nested-bindings-bom-crlf-full-tree-update",
      "synthetic_derived_portable",
      async () => {
        const main =
          "\uFEFF" +
          mainText("[A](../target-a/SKILL.md)\n\n[Local](references/nested.md)").replaceAll(
            "\n",
            "\r\n",
          )
        const nested = "[B](../../target-b/SKILL.md)\r\n[Home](../SKILL.md)\r\n"
        const path = await writeTree(join(fixtures, "relative-owner"), [
          { path: "SKILL.md", content: main },
          { path: "references/nested.md", content: nested },
          {
            path: "references/remove.md",
            content: "This file will be omitted by a complete replacement.\n",
          },
          { path: "assets/opaque.bin", content: new Uint8Array([0, 255, 128, 1, 13, 10, 0, 64]) },
          {
            path: "scripts/example.sh",
            content: "#!/bin/sh\nprintf 'fixture only\\n'\n",
            executable: true,
          },
        ])
        const before = await treeEvidence(path),
          id = skillId("relative")
        const unbound = await plan("relative-unbound", path, id)
        assert.equal(unbound.result.importable, false)
        assert.ok(objects(unbound.result.unresolved).some((entry) => entry.blocks_import === true))
        const bound = await plan("relative-bound", path, id, {
          version: 1,
          root: "skills/relative-owner",
          targets: [
            { path: "skills/target-a/SKILL.md", ref: a.ref },
            { path: "skills/target-b/SKILL.md", ref: b.ref },
          ],
        })
        assert.equal(bound.result.importable, true)
        confirm(bound.result, a.selector, "SKILL.md", "../target-a/SKILL.md")
        confirm(bound.result, b.selector, "references/nested.md", "../../target-b/SKILL.md")
        assert.equal(property(bound.result.relations).requires, undefined)
        await assertRewrite(path, bound.output, {
          "SKILL.md": [["../target-a/SKILL.md", a.ref]],
          "references/nested.md": [["../../target-b/SKILL.md", b.ref]],
        })
        assert.deepEqual(await treeEvidence(path), before, "Planning changed the original input")
        const expected = { members: [a.pageId, b.pageId], requires: [] }
        const owner = await verify.importSkill("relative-bound", bound.output, id, expected)
        const originalExport = await exported("relative-original", owner)
        const beforeFiles = await verify.execute("relative-files-before", [
          "ctl",
          "library",
          "files",
          owner.pageId,
          "--entry",
          library.skills.database_id,
        ])
        const updatedPath = await copyTree(bound.output, join(fixtures, "relative-updated"), [
          MANIFEST,
          "references/remove.md",
        ])
        await writeFile(
          join(updatedPath, "references/nested.md"),
          (await readFile(join(updatedPath, "references/nested.md"), "utf8")) +
            "Updated supporting instructions.\r\n",
          { mode: 0o600 },
        )
        const changed = await verify.importSkill(
          "relative-update",
          updatedPath,
          id,
          expected,
          false,
        )
        assert.equal(changed.pageId, owner.pageId)
        const afterFiles = await verify.execute("relative-files-after", [
          "ctl",
          "library",
          "files",
          owner.pageId,
          "--entry",
          library.skills.database_id,
        ])
        const previousEvidence = currentFileEvidence(beforeFiles),
          currentEvidence = currentFileEvidence(afterFiles)
        assert.deepEqual(
          currentEvidence.main,
          previousEvidence.main,
          "The main File ID must survive complete replacement",
        )
        const previous = previousEvidence.files,
          current = currentEvidence.files
        assert.ok(previous.some((file) => file.path === "references/remove.md"))
        assert.ok(!current.some((file) => file.path === "references/remove.md"))
        for (const file of current) {
          const prior = previous.find((item) => item.path === file.path)
          assert.ok(prior)
          assert.equal(
            file.file_id,
            prior.file_id,
            "Retained logical File IDs must survive complete replacement",
          )
          assert.equal(
            file.page_id,
            prior.page_id,
            "Retained file rows must survive complete replacement",
          )
        }
        const changedExport = await exported("relative-updated", changed)
        await verify.noop("relative-update-repeat", changed, expected)
        assert.deepEqual(await treeEvidence(path), before)
        return {
          page_id: owner.pageId,
          original: originalExport,
          updated: changedExport,
          original_unchanged: true,
          bom_crlf_preserved: true,
        }
      },
    )
    await stage("unconfirmed-bindings-do-not-write-output", "synthetic", async () => {
      const path = await writeTree(join(fixtures, "refused-bound"), [
        {
          path: "SKILL.md",
          content: mainText(
            "[Unknown](../unknown/SKILL.md)\n[Disabled](../disabled/SKILL.md)\n[Wrong file](../wrong/SKILL.md)",
          ),
        },
      ])
      const before = await treeEvidence(path)
      const refused = await plan("refused-bound", path, skillId("refused"), {
        version: 1,
        root: "skills/refused",
        targets: [
          { path: "skills/disabled/SKILL.md", ref: disabled.ref },
          { path: "skills/wrong/SKILL.md", ref: fileRef(a.selector, "missing.md") },
        ],
      })
      assert.equal(refused.result.importable, false)
      assert.deepEqual(refused.result.confirmed, [])
      assert.ok(objects(refused.result.unresolved).length >= 3)
      assert.deepEqual(await treeEvidence(path), before)
      const shared = await writeTree(join(fixtures, "shared-definition"), [
        {
          path: "SKILL.md",
          content: mainText("Read [target][x].\n![image][x]\n[x]: ../target-a/SKILL.md"),
        },
      ])
      const sharedPlan = await plan("shared-definition", shared, skillId("shared-definition"), {
        version: 1,
        root: "skills/shared",
        targets: [{ path: "skills/target-a/SKILL.md", ref: a.ref }],
      })
      assert.equal(sharedPlan.result.importable, false)
      assert.deepEqual(sharedPlan.result.confirmed, [])
      return { refused: refused.result, shared_definition: sharedPlan.result }
    })
    const leaves = await stage("real-leaf-targets", "fixed_upstream", async () => {
      const result: Record<string, Owner> = {}
      for (const name of ["principle-guard-the-context-window", "arena", "unslop"] as const) {
        const source = lookup(name)
        result[name] = await verify.importSkill(
          `real-${name}`,
          source.input_path,
          skillId(`real-${name}`),
          noRelations,
        )
        await exported(`real-${name}`, result[name]!)
      }
      return result
    })
    const poteto = await stage("real-poteto-original-auto-zero", "fixed_upstream", async () => {
      const source = lookup("poteto-mode")
      assert.equal(source.commit, "aaeb0ea3a0584995aa8f55ce44c6c5259414b896")
      assert.equal(source.file_count, 41)
      const owner = await verify.importSkill(
        "real-poteto-original",
        source.input_path,
        skillId("real-poteto-original"),
        noRelations,
      )
      assert.deepEqual(property(owner.result.members_discovery).confirmed, [])
      assert.equal(owner.result.files, 41)
      await exported("real-poteto-original", owner)
      await verify.noop("real-poteto-original-repeat", owner, noRelations)
      return owner
    })
    for (const [name, leaf, from, href] of [
      [
        "principle-minimize-reader-load",
        "principle-guard-the-context-window",
        "SKILL.md",
        "../principle-guard-the-context-window/SKILL.md",
      ],
      ["architect", "arena", "references/rationale-template.md", "../../arena/SKILL.md"],
    ] as const) {
      await stage(`real-${name}-bound-relative`, "fixed_upstream_derived_portable", async () => {
        const source = lookup(name),
          targetSource = lookup(leaf),
          target = leaves[leaf]!
        assert.equal(source.commit, "c742dd61706fbacc1b95f1a20b7b988cf096ce6c")
        const before = await treeEvidence(source.input_path),
          id = skillId(`real-${name}`)
        const unbound = await plan(`real-${name}-unbound`, source.input_path, id)
        assert.equal(unbound.result.importable, false)
        const bound = await plan(`real-${name}-bound`, source.input_path, id, {
          version: 1,
          root: source.repository_path,
          targets: [{ path: `${targetSource.repository_path}/SKILL.md`, ref: target.ref }],
        })
        assert.equal(bound.result.importable, true)
        assert.deepEqual(property(bound.result.relations).members, [target.selector])
        assert.equal(property(bound.result.relations).requires, undefined)
        confirm(bound.result, target.selector, from, href)
        await assertRewrite(source.input_path, bound.output, { [from]: [[href, target.ref]] })
        assert.deepEqual(await treeEvidence(source.input_path), before)
        const expected = { members: [target.pageId], requires: [] }
        const owner = await verify.importSkill(`real-${name}`, bound.output, id, expected)
        await exported(`real-${name}`, owner)
        await verify.noop(`real-${name}-repeat`, owner, expected)
        return {
          page_id: owner.pageId,
          commit: source.commit,
          confirmed: bound.result.confirmed,
          original_unchanged: true,
        }
      })
    }
    const explicitPoteto = await stage(
      "real-poteto-explicit-selected-relations",
      "fixed_upstream_explicit_portable",
      async () => {
        const source = lookup("poteto-mode"),
          guard = leaves["principle-guard-the-context-window"]!,
          arena = leaves.arena!,
          unslop = leaves.unslop!
        const path = await copyTree(source.input_path, join(fixtures, "real-poteto-explicit"))
        await portable(
          path,
          { members: [guard.selector, arena.selector], requires: [unslop.selector] },
          "Poteto explicit selected relations",
        )
        assert.deepEqual(authored(await treeEvidence(path)), await treeEvidence(source.input_path))
        const expected = { members: [guard.pageId, arena.pageId], requires: [unslop.pageId] }
        const owner = await verify.importSkill(
          "real-poteto-explicit",
          path,
          skillId("real-poteto-explicit"),
          expected,
        )
        assert.equal(property(owner.result.members_discovery).member_policy, "explicit")
        await exported("real-poteto-explicit", owner)
        await verify.noop("real-poteto-explicit-repeat", owner, expected)
        await verify.observe("original-poteto-still-auto-zero", poteto, noRelations)
        return owner
      },
    )
    await stage("real-poteto-read-inspect-use", "live_cli_consumption", async () => {
      const read = await verify.execute("poteto-read", [
        "read",
        explicitPoteto.ref,
        "--database",
        library.skills.database_id,
        "--refresh",
        "--metrics",
      ])
      requireZeroNotionWrites(read)
      assert.equal(property(read.record).id, explicitPoteto.selector)
      assert.equal(read.path, "SKILL.md")
      assert.equal(read.has_more, false)
      assert.equal(typeof read.content, "string")
      assert.equal(digest(String(read.content)), lookup("poteto-mode").main_sha256)
      const candidates = ordered([
        leaves["principle-guard-the-context-window"]!.selector,
        leaves.arena!.selector,
      ])
      assert.deepEqual(ordered(objects(read.members).map((entry) => String(entry.id))), candidates)
      assert.deepEqual(
        objects(read.required).map((entry) => entry.id),
        [leaves.unslop!.selector],
      )
      const inspect = await verify.execute("poteto-inspect", [
        "ctl",
        "prepare",
        explicitPoteto.ref,
        "--database",
        library.skills.database_id,
        "--purpose",
        "inspect",
        "--refresh",
        "--metrics",
      ])
      requireZeroNotionWrites(inspect)
      assert.equal(inspect.status, "ready")
      const inspectNodes = objects(inspect.nodes)
      assert.deepEqual(
        inspectNodes.filter((node) => node.state === "prepared").map((node) => node.id),
        [explicitPoteto.selector],
      )
      const root = inspectNodes.find((node) => node.id === explicitPoteto.selector)
      assert.ok(root)
      assert.deepEqual(
        ordered(objects(root.candidates).map((entry) => String(entry.id))),
        candidates,
      )
      assert.deepEqual(
        objects(root.required).map((entry) => entry.id),
        [leaves.unslop!.selector],
      )
      const used = await verify.execute("poteto-use", [
        "use",
        explicitPoteto.ref,
        "--database",
        library.skills.database_id,
        "--refresh",
        "--json",
        "--metrics",
      ])
      requireZeroNotionWrites(used)
      assert.equal(used.status, "ready")
      const preparation = property(used.preparation),
        nodes = objects(preparation.nodes)
      const prepared = ordered(
        nodes.filter((node) => node.state === "prepared").map((node) => String(node.id)),
      )
      assert.deepEqual(prepared, ordered([explicitPoteto.selector, leaves.unslop!.selector]))
      const closure = preparation.required_closure
      assert.ok(Array.isArray(closure) && closure.every((id) => typeof id === "string"))
      assert.deepEqual(ordered(closure), prepared)
      for (const candidate of candidates)
        assert.equal(nodes.find((node) => node.id === candidate)?.state, "known")
      assert.deepEqual(ordered(objects(used.entries).map((entry) => String(entry.id))), prepared)
      assert.equal(property(used.effects).remote_writes, "none")
      assert.equal(property(used.delivery).status, "not_observed")
      return {
        inspected_prepared: [explicitPoteto.selector],
        optional_members: candidates,
        used_prepared: prepared,
        notion_writes: 0,
        model_delivery: "not_observed",
        activation: used.activation,
      }
    })
    await verifyMembersCorpus(input.corpus)
    report.status = "passed"
    report.current_case = "complete"
    await saveReport()
    return report
  } catch (error) {
    report.status = "failed"
    await saveReport()
    throw new Error(
      `Members verification stopped at ${report.current_case}; retain the original operation and evidence at ${join(input.root, "report.json")}`,
      { cause: error },
    )
  }
}

/** Keep useful response evidence without credentials or signed attachment URLs. */
export function sanitizeEvidence(
  value: unknown,
  secrets: readonly string[] = [process.env.NOTION_API_TOKEN, process.env.NOTION_TOKEN].filter(
    (value): value is string => Boolean(value),
  ),
): unknown {
  if (typeof value === "string")
    return secrets
      .filter((secret) => secret.length > 0)
      .reduce((text, secret) => text.replaceAll(secret, "[redacted-secret]"), value)
      .replace(/\b(?:secret_|ntn_)[A-Za-z0-9_-]{12,}/gu, "[redacted-token]")
      .replace(/Bearer\s+[^\s"']+/giu, "Bearer [redacted]")
      .replace(/https?:\/\/[^\s"<>]+/gu, (url) => {
        const at = url.indexOf("?")
        return at < 0 ? url : url.slice(0, at) + "?[redacted-query]"
      })
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidence(item, secrets))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:token|authorization|access_token|refresh_token|client_secret|cookie|set-cookie)$/iu.test(
          key,
        )
          ? "[redacted]"
          : sanitizeEvidence(item, secrets),
      ]),
    )
  return value
}

async function installedDriver(cli: string, runtime: string, root: string) {
  assert.ok(isAbsolute(cli) && isAbsolute(runtime), "Select absolute installed CLI and Node paths")
  const selected = await realpath(cli),
    node = await realpath(runtime)
  const bytes = await readFile(selected)
  const stores = Object.fromEntries(
    ["NTN_SKILLS_HOME", "NTN_SKILLS_CONFIG_HOME", "NTN_SKILLS_CACHE_HOME"].map((key) => {
      const value = process.env[key]
      assert.ok(value && isAbsolute(value), `Set the run-owned ${key} before using the live lever`)
      return [key, value]
    }),
  )
  let sequence = 0
  const secrets = [process.env.NOTION_API_TOKEN, process.env.NOTION_TOKEN].filter(
    (value): value is string => Boolean(value),
  )
  const drive: Drive = async (argv) => {
    const record = join(root, "commands", `${String(++sequence).padStart(4, "0")}.json`)
    const result = await new Promise<{
      stdout: Buffer
      stderr: Buffer
      exit: number
      signal: NodeJS.Signals | null
    }>((resolveResult, reject) => {
      const child = spawn(node, [selected, ...argv], {
        env: { ...process.env, NTN_SKILLS_REQUEST_TRACE_LIMIT: "10000" },
        stdio: ["ignore", "pipe", "pipe"],
      })
      const stdout: Buffer[] = [],
        stderr: Buffer[] = []
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
      child.once("error", reject)
      child.once("close", (exit, signal) =>
        resolveResult({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exit: exit ?? 1,
          signal,
        }),
      )
    })
    let output: unknown
    let nonJsonStdout: string | undefined
    try {
      output = JSON.parse(result.stdout.toString("utf8"))
    } catch {
      nonJsonStdout = result.stdout.toString("utf8")
      output = {
        ok: false,
        error: {
          code: "NON_JSON_STDOUT",
          stdout_bytes: result.stdout.length,
          stdout_sha256: digest(result.stdout),
        },
      }
    }
    const receipt = {
      argv,
      exit: result.exit,
      signal: result.signal,
      output: sanitizeEvidence(output, secrets),
      ...(nonJsonStdout === undefined
        ? {}
        : { non_json_stdout: sanitizeEvidence(nonJsonStdout, secrets) }),
      stdout_bytes: result.stdout.length,
      stdout_sha256: digest(result.stdout),
      stderr_bytes: result.stderr.length,
      stderr_sha256: digest(result.stderr),
      stderr: sanitizeEvidence(result.stderr.toString("utf8"), secrets),
    }
    await writeJson(record, receipt)
    return { output, exit: result.exit, record }
  }
  return {
    drive,
    execution: {
      layer: "live_installed_cli",
      cli: selected,
      cli_sha256: digest(bytes),
      runtime: node,
      stores,
      model_delivery: "not_observed",
    },
  }
}

async function main() {
  const argv = process.argv.slice(2),
    args = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index],
      value = argv[index + 1]
    assert.ok(
      name &&
        ["--cli", "--runtime", "--scope", "--output", "--corpus", "--prefix"].includes(name) &&
        value &&
        !value.startsWith("--"),
      "Use --cli --runtime --scope --output --corpus, with optional --prefix",
    )
    assert.equal(args.has(name), false, "Flags must be supplied once")
    args.set(name, value)
  }
  const required = (name: string) => {
    const value = args.get(name)
    assert.ok(value, `Missing ${name}`)
    return value
  }
  const raw = property(JSON.parse(await readFile(required("--scope"), "utf8")))
  const library = Schema.decodeUnknownSync(SharedLibrarySchema)(raw.library ?? raw)
  if (raw.parent !== undefined) assert.equal(raw.parent, library.parent_page_id)
  if (raw.kind !== undefined) assert.equal(raw.kind, "library_ready")
  const root = required("--output"),
    driver = await installedDriver(required("--cli"), required("--runtime"), root)
  const report = await runMembersLive({
    root,
    library,
    corpus: required("--corpus"),
    prefix:
      args.get("--prefix") ?? `members-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    ...driver,
  })
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      report: join(root, "report.json"),
      cases: report.cases.map(({ name, status }) => ({ name, status })),
    }) + "\n",
  )
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify(
        sanitizeEvidence({
          error: error instanceof Error ? error.message : "Members verification failed",
        }),
      ) + "\n",
    )
    process.exitCode = 1
  })
}
