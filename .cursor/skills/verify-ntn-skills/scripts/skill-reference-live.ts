import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { property } from "../../../../packages/core/src/model.ts"
import { MANIFEST } from "../../../../packages/core/src/portable.ts"
import { fileRef, pageId } from "../../../../packages/core/src/ref.ts"
import { bindSkillRef, formatSkillIdentity, parseSkillRef } from "../../../../packages/core/src/skill-ref.ts"
import { SharedLibrarySchema, type SharedLibrary } from "../../../../packages/core/src/shared-library-model.ts"
import { probeEmptyLibrary, runEmptyLibrary } from "./empty-library.ts"
import { installedDriver, observeSkillRelations, requireZeroNotionWrites, sanitizeEvidence, treeEvidence, verifyMembersCorpus } from "./members-live.ts"

type Drive = Awaited<ReturnType<typeof installedDriver>>["drive"]
type File = { readonly path: string; readonly bytes: Uint8Array; readonly executable?: boolean }
type Entry = { readonly root: string; readonly skill_id: string; readonly files: readonly File[]; readonly native?: readonly string[]; readonly name?: string }
type Owner = { readonly skill_id: string; readonly page_id: string; readonly identity: string; readonly input: string }
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const encoder = new TextEncoder()
const ordered = (values: readonly string[]) => [...values].sort()
const rows = (value: unknown) => {
  assert.ok(Array.isArray(value), "Expected a complete array")
  return value.map(property)
}
const authored = (files: Awaited<ReturnType<typeof treeEvidence>>) => files.filter((file) => file.path !== MANIFEST)
const identity = (library: SharedLibrary, skill_id: string) => formatSkillIdentity({ libraryId: library.library_id, skillId: skill_id })
const textFile = (path: string, text: string): File => ({ path, bytes: encoder.encode(text) })
const main = (name: string, body: string) => "---\nname: " + name + "\ndescription: Dedicated reference verification fixture.\n---\n\n" + body + "\n"

async function json(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(sanitizeEvidence(value), null, 2) + "\n", { mode: 0o600 })
}
async function tree(root: string, files: readonly File[]) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  for (const file of files) {
    assert.ok(file.path && !isAbsolute(file.path) && !file.path.split("/").includes(".."))
    const path = join(root, file.path)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, file.bytes, { flag: "wx", mode: file.executable ? 0o700 : 0o600 })
    if (file.executable) await chmod(path, 0o700)
  }
  return root
}
async function copied(root: string): Promise<readonly File[]> {
  return await Promise.all((await treeEvidence(root)).map(async (file) => ({
    path: file.path, bytes: await readFile(join(root, file.path)), executable: file.mode === "100755",
  })))
}
function portable(library: SharedLibrary, name: string, selected: { readonly members?: readonly string[]; readonly requires?: readonly string[] }) {
  return textFile(MANIFEST, JSON.stringify({
    format: "ntn-skills", version: 2, kind: "skill", name,
    description: "Dedicated reference verification fixture.", main: "SKILL.md",
    relations: { version: 1, ownership: "notion", library_id: library.library_id, ...selected },
  }) + "\n")
}

/** A fresh output directory is a new journey. Unknown writes retain their original
 * operation and state; this lever never repairs a failed page or replays its CREATE. */
export async function runSkillReferenceLive(input: {
  readonly root: string
  readonly prefix: string
  readonly corpus: string
  readonly parent: string
  readonly existing_entry: string
  readonly existing_library: string
  readonly drive: Drive
  readonly execution: Record<string, unknown>
}) {
  assert.ok(isAbsolute(input.root))
  assert.match(input.prefix, /^[a-z0-9][a-z0-9-]{0,60}$/u)
  assert.equal(pageId(input.parent), input.parent)
  assert.equal(pageId(input.existing_entry), input.existing_entry)
  const corpus = await verifyMembersCorpus(input.corpus)
  await mkdir(dirname(input.root), { recursive: true, mode: 0o700 })
  await mkdir(input.root, { mode: 0o700 }) // Refuse to overwrite an earlier journey.
  const fixtures = join(input.root, "fixtures")
  await mkdir(fixtures, { mode: 0o700 })
  const report = {
    version: 1, status: "running", current_case: "admission", prefix: input.prefix,
    execution: input.execution, authorized_parent: input.parent,
    corpus: { path: input.corpus, sha256: corpus.corpus_sha256, repository_url: corpus.repository_url, skills: corpus.skills.map(({ files: _files, ...skill }) => skill) },
    libraries: {} as Record<string, SharedLibrary>,
    cases: [] as Array<{ name: string; status: string; evidence?: unknown; error?: string }>,
    boundary: "Real installed CLI and real Notion. Parent allocation is explicit test setup. Unknown-outcome recovery and crash injection remain controlled-test evidence.",
  }
  const save = () => json(join(input.root, "report.json"), report)
  let observation = 0
  const record = (label: string, value: unknown) => json(join(input.root, "observations", String(++observation).padStart(4, "0") + "-" + label + ".json"), value)
  const stage = async <A>(name: string, run: () => Promise<A>): Promise<A> => {
    report.current_case = name
    await save()
    try {
      const result = await run()
      report.cases.push({ name, status: "passed", evidence: result })
      await save()
      return result
    } catch (error) {
      report.cases.push({ name, status: "failed", error: error instanceof Error ? error.message : "Unknown failure" })
      throw error
    }
  }
  const execute = async (label: string, argv: string[]) => {
    const result = await input.drive(argv)
    await record(label, result)
    assert.equal(result.exit, 0, "Preserve the original operation and inspect " + result.record)
    assert.equal(property(result.output).ok, true, "No successful command result at " + result.record)
    return property(result.output)
  }
  const reject = async (label: string, argv: string[], codes: readonly string[]) => {
    const result = await input.drive(argv)
    await record(label, result)
    assert.notEqual(result.exit, 0, "An unsafe selection unexpectedly succeeded")
    assert.equal(property(result.output).ok, false)
    const code = property(property(result.output).error).code
    assert.ok(typeof code === "string" && codes.includes(code), "Unexpected rejection " + String(code) + "; inspect " + result.record)
    requireZeroNotionWrites(result.output)
    return { code, notion_writes: 0, command: result.record }
  }
  const id = (suffix: string) => input.prefix + "-" + suffix
  const observe = async (label: string, library: SharedLibrary, owner: Owner, members: readonly Owner[] = [], requires: readonly Owner[] = []) => {
    const output = await execute(label + "-page", ["ctl", "api", "v1/pages/" + owner.page_id])
    requireZeroNotionWrites(output)
    const actual = observeSkillRelations(output.response, library, { pageId: owner.page_id, skillId: owner.skill_id })
    const expected = { members: ordered(members.map((row) => row.page_id)), requires: ordered(requires.map((row) => row.page_id)) }
    await record(label + "-actual-relations", { source: "independent_page_get", expected, actual })
    assert.equal(actual.enabled, true)
    assert.deepEqual(actual.members, expected.members)
    assert.deepEqual(actual.requires, expected.requires)
    return actual
  }
  const manifest = async (name: string, entries: readonly Entry[], selected = entries.map((row) => row.root)) => {
    const root = join(fixtures, name)
    await mkdir(root, { mode: 0o700 })
    for (const entry of entries) await tree(join(root, entry.root), entry.files)
    const path = join(root, "batch.json")
    await json(path, { version: 1, root: ".", skills: entries.filter((entry) => selected.includes(entry.root)).map(({ files: _files, ...entry }) => ({
      ...entry, name: entry.name ?? entry.skill_id, description: "Dedicated reference verification fixture.",
    })) })
    return { path, root, entries }
  }
  const batchArgs = (library: SharedLibrary, path: string, label: string, extra: readonly string[] = []) => [
    "ctl", "library", "import-batch", path, "--entry", library.skills.database_id,
    "--operation", id(label), "--max-requests", "10000", "--timeout", "1200000", ...extra,
  ]
  const batch = async (label: string, library: SharedLibrary, selected: Awaited<ReturnType<typeof manifest>>, extra: readonly string[] = []) => {
    const before = await treeEvidence(selected.root)
    const args = batchArgs(library, selected.path, label, extra)
    const review = await execute(label + "-dry-run", [...args, "--dry-run"])
    requireZeroNotionWrites(review)
    const applied = await execute(label + "-apply", args)
    assert.equal(applied.status, "applied")
    const owners = new Map<string, Owner>()
    for (const item of rows(applied.skills)) {
      assert.equal(typeof item.skill_id, "string")
      const skill_id = String(item.skill_id), body = property(item.body)
      const page_id = pageId(String(body.page_id))
      assert.ok(page_id, "Completed batch body has no allocated page")
      const entry = selected.entries.find((entry) => entry.skill_id === skill_id)
      assert.ok(entry)
      owners.set(skill_id, { skill_id, page_id, identity: identity(library, skill_id), input: join(selected.root, entry.root) })
    }
    assert.deepEqual(await treeEvidence(selected.root), before, "Batch compilation changed its original input")
    return { review, applied, owners }
  }
  const imported = async (label: string, library: SharedLibrary, path: string, skill_id: string) => {
    const args = ["ctl", "library", "import", path, "--entry", library.skills.database_id, "--skill-id", skill_id, "--operation", id(label), "--max-requests", "10000", "--timeout", "1200000"]
    const review = await execute(label + "-dry-run", [...args, "--dry-run"])
    requireZeroNotionWrites(review)
    const output = await execute(label + "-apply", args)
    const page_id = pageId(String(output.page_id))
    assert.ok(page_id)
    return { owner: { skill_id, page_id, identity: identity(library, skill_id), input: path }, review, output }
  }
  const exported = async (label: string, library: SharedLibrary, owner: Owner, rewrites: Readonly<Record<string, readonly [string, string][]>> = {}) => {
    const destination = join(input.root, "exports", label)
    const output = await execute(label + "-export", ["export", owner.page_id, "--database", library.skills.database_id, "--refresh", "--output", destination])
    requireZeroNotionWrites(output)
    const expected = await Promise.all(authored(await treeEvidence(owner.input)).map(async (file) => {
      let bytes = await readFile(join(owner.input, file.path))
      for (const [before, after] of rewrites[file.path] ?? []) {
        const text = bytes.toString("utf8")
        assert.equal(text.split(before).length, 2, "Expected one exact authored destination")
        bytes = Buffer.from(text.replace(before, after))
      }
      return { ...file, bytes: bytes.length, sha256: digest(bytes) }
    }))
    assert.deepEqual(authored(await treeEvidence(destination)), expected, "Export changed authored path, bytes or executable mode")
    return { destination, files: expected.length, authored_sha256: digest(JSON.stringify(expected)) }
  }
  const read = async (label: string, target: string, expected: Owner, extra: readonly string[] = []) => {
    const output = await execute(label, ["read", target, "--metrics", ...extra])
    requireZeroNotionWrites(output)
    assert.equal(property(output.record).id, expected.identity)
    assert.equal(typeof output.content, "string")
    assert.equal(output.has_more, false)
    return output
  }

  try {
    const A = await stage("attach-existing-dedicated-library", async () => {
      const output = await execute("attach-a", ["ctl", "library", "init", "--entry", input.existing_entry])
      requireZeroNotionWrites(output)
      const library = Schema.decodeUnknownSync(SharedLibrarySchema)(output.library)
      assert.equal(library.library_id, input.existing_library)
      assert.equal(library.skills.database_id, input.existing_entry)
      report.libraries.A = library
      return library
    })
    const B = await stage("initialize-new-library-and-repeat-empty-census", async () => {
      const result = await runEmptyLibrary({ root: join(input.root, "initialization"), stage: "init", container: input.parent, drive: input.drive, probe: probeEmptyLibrary })
      const library = Schema.decodeUnknownSync(SharedLibrarySchema)(property(result).library)
      assert.notEqual(library.library_id, A.library_id)
      assert.notEqual(library.skills.database_id, A.skills.database_id)
      report.libraries.B = library
      return library
    })
    const real = await stage("fixed-upstream-batch-and-exact-relative-mapping", async () => {
      const entries: Entry[] = []
      for (const skill of corpus.skills) entries.push({ root: skill.name, skill_id: id(skill.name), name: skill.name, files: await copied(skill.input_path) })
      const selected = await manifest("upstream", entries)
      const result = await batch("upstream", B, selected)
      const owner = (name: string) => {
        const value = result.owners.get(id(name))
        assert.ok(value)
        return value
      }
      const exports: unknown[] = []
      for (const skill of corpus.skills) {
        const targets = skill.name === "architect" ? [owner("arena")] : skill.name === "principle-minimize-reader-load" ? [owner("principle-guard-the-context-window")] : []
        await observe("upstream-" + skill.name, B, owner(skill.name), targets)
        const rewrites: Record<string, readonly [string, string][]> = skill.name === "architect"
          ? { "references/rationale-template.md": [["../../arena/SKILL.md", "skill://" + id("arena") + "/SKILL.md"]] }
          : skill.name === "principle-minimize-reader-load"
            ? { "SKILL.md": [["../principle-guard-the-context-window/SKILL.md", "skill://" + id("principle-guard-the-context-window") + "/SKILL.md"]] }
            : {}
        exports.push(await exported("upstream-" + skill.name, B, owner(skill.name), rewrites))
      }
      const poteto = rows(result.applied.skills).find((row) => row.skill_id === id("poteto-mode"))
      assert.ok(poteto)
      assert.deepEqual(property(poteto.members_discovery).confirmed, [], "Prose mentions must not invent poteto Members")
      await record("upstream-summary", { mapping: result.applied.mapping, rewrites: result.applied.rewrites, exports })
      return { owners: Object.fromEntries(result.owners), exports, rewrites: result.applied.rewrites }
    })
    const upstream = (name: string) => {
      const owner = real.owners[id(name)]
      assert.ok(owner)
      return owner
    }
    await stage("poteto-explicit-members-and-requires-with-all-authored-bytes", async () => {
      const source = corpus.skills.find((skill) => skill.name === "poteto-mode")
      assert.ok(source)
      const poteto = upstream("poteto-mode"), guard = upstream("principle-guard-the-context-window"), arena = upstream("arena"), unslop = upstream("unslop")
      const path = await tree(join(fixtures, "poteto-explicit"), [...await copied(source.input_path), portable(B, "poteto-mode", { members: [guard.identity, arena.identity], requires: [unslop.identity] })])
      const result = await imported("poteto-explicit", B, path, poteto.skill_id)
      assert.equal(result.owner.page_id, poteto.page_id)
      assert.equal(property(result.output.members_discovery).member_policy, "explicit")
      await observe("poteto-explicit", B, result.owner, [guard, arena], [unslop])
      const exportedTree = await exported("poteto-explicit", B, result.owner)
      assert.equal(exportedTree.files, 41)
      const content = await read("poteto-read", fileRef(poteto.identity, "SKILL.md"), poteto, ["--database", B.skills.database_id, "--refresh"])
      assert.equal(digest(String(content.content)), source.main_sha256)
      assert.deepEqual(ordered(rows(content.members).map((row) => String(row.id))), ordered([guard.identity, arena.identity]))
      assert.deepEqual(rows(content.required).map((row) => row.id), [unslop.identity])
      const repeated = await imported("poteto-repeat", B, path, poteto.skill_id)
      requireZeroNotionWrites(repeated.output)
      return { page_id: poteto.page_id, ...exportedTree, original_main_sha256: source.main_sha256, repeat_notion_writes: 0 }
    })
    await stage("cyclic-members-omission-explicit-empty-and-requires", async () => {
      const one = id("cycle-one"), two = id("cycle-two")
      const selected = await manifest("cycles", [
        { root: "one", skill_id: one, native: ["SKILL.md"], files: [textFile("SKILL.md", main(one, "[Two](../two/SKILL.md)"))] },
        { root: "two", skill_id: two, native: ["SKILL.md"], files: [textFile("SKILL.md", main(two, "[One](../one/SKILL.md)"))] },
      ])
      const result = await batch("cycles", B, selected)
      const a = result.owners.get(one)!, b = result.owners.get(two)!
      await observe("cycle-one", B, a, [b])
      await observe("cycle-two", B, b, [a])
      await execute("manual-remove-member", ["ctl", "skill", "update", a.page_id, "--entry", B.skills.database_id, "--members", ""])
      await observe("manual-member-removal", B, a)
      const repeat = await batch("cycles-repeat", B, selected)
      requireZeroNotionWrites(repeat.applied)
      await observe("omission-preserves-removal", B, a)
      await observe("other-cycle-member-preserved", B, b, [a])
      const emptyId = id("explicit-empty")
      const body = main(emptyId, "[Optional target](skill://" + two + "/SKILL.md)")
      const explicit = await tree(join(fixtures, "explicit-empty"), [textFile("SKILL.md", body), portable(B, emptyId, { members: [], requires: [b.identity] })])
      const empty = await imported("explicit-empty", B, explicit, emptyId)
      await observe("explicit-empty", B, empty.owner, [], [b])
      const omitted = await tree(join(fixtures, "existing-omitted"), [textFile("SKILL.md", body)])
      const retained = await imported("existing-omitted", B, omitted, emptyId)
      requireZeroNotionWrites(retained.output)
      await observe("omission-preserves-explicit-requires", B, empty.owner, [], [b])
      const inertId = id("inert-mentions")
      const inert = await tree(join(fixtures, "inert"), [textFile("SKILL.md", main(inertId, "Mention " + two + " in prose.\n\n~~~md\n[example](skill://" + two + "/SKILL.md)\n~~~\n\n![image](skill://" + two + "/SKILL.md)"))])
      const untouched = await imported("inert", B, inert, inertId)
      await observe("inert-links", B, untouched.owner)
      return { cycle_pages: [a.page_id, b.page_id], preserved_manual_removal: true, explicit_empty: empty.owner.page_id, requires_stayed_explicit: true, inert_page: untouched.owner.page_id }
    })
    await stage("unproven-relative-inputs-and-requires-cycle-write-nothing", async () => {
      const failures: unknown[] = []
      for (const [label, href, includeTarget] of [
        ["unlisted", "../target/SKILL.md", false],
        ["missing-path", "../target/missing.md", true],
        ["encoded-slash", "../target%2FSKILL.md", true],
      ] as const) {
        const selected = await manifest(label, [
          { root: "owner", skill_id: id(label + "-owner"), files: [textFile("SKILL.md", main(label, "[Target](" + href + ")"))] },
          { root: "target", skill_id: id(label + "-target"), files: [textFile("SKILL.md", main("Target", "# Target"))] },
        ], includeTarget ? ["owner", "target"] : ["owner"])
        failures.push(await reject(label, batchArgs(B, selected.path, label), ["CURRENT_IMPORT_BATCH_UNRESOLVED"]))
      }
      const first = id("requires-one"), second = id("requires-two")
      const selected = await manifest("requires-cycle", [
        { root: "one", skill_id: first, files: [textFile("SKILL.md", main(first, "# First")), portable(B, first, { requires: [identity(B, second)] })] },
        { root: "two", skill_id: second, files: [textFile("SKILL.md", main(second, "# Second")), portable(B, second, { requires: [identity(B, first)] })] },
      ])
      failures.push(await reject("requires-cycle", batchArgs(B, selected.path, "requires-cycle"), ["CURRENT_REQUIRES_CYCLE"]))
      return failures
    })
    const overlap = await stage("overlapping-library-identities-context-and-fixed-paths", async () => {
      const shared = id("overlap"), external = id("external"), distractor = id("display-distractor")
      const aText = main(shared, "# Library A original"), bText = main(shared, "# Library B original"), bNext = main(shared, "# Library B updated")
      const aInput = await manifest("overlap-a", [
        { root: "leaf", skill_id: shared, files: [textFile("SKILL.md", aText)] },
        { root: "external", skill_id: external, files: [textFile("SKILL.md", main(external, "# External A"))] },
      ])
      const bInput = await manifest("overlap-b", [
        { root: "leaf", skill_id: shared, files: [textFile("SKILL.md", bText)] },
        { root: "distractor", skill_id: distractor, name: shared, files: [textFile("SKILL.md", main(distractor, "# Display name distractor"))] },
      ])
      const ar = await batch("overlap-a", A, aInput), br = await batch("overlap-b", B, bInput)
      const a = ar.owners.get(shared)!, b = br.owners.get(shared)!, outside = ar.owners.get(external)!
      await observe("overlap-a", A, a)
      await observe("overlap-b", B, b)
      const aRead = await read("same-id-a", "skill://" + shared + "/SKILL.md", a, ["--database", A.skills.database_id, "--refresh"])
      const bRead = await read("same-id-b", "skill://" + shared + "/SKILL.md", b, ["--database", B.skills.database_id, "--refresh"])
      assert.equal(aRead.content, aText)
      assert.equal(bRead.content, bText)
      assert.equal(typeof aRead.ref, "string")
      assert.equal(typeof bRead.ref, "string")
      const aPin = bindSkillRef(parseSkillRef(String(aRead.ref)))
      assert.equal(aPin.selection.kind, "fixed")
      const configured = await execute("default-b", ["ctl", "config", "set", "default_database", B.skills.database_id])
      requireZeroNotionWrites(configured)
      assert.equal((await read("short-entry-default-b", "skill://" + shared + "/SKILL.md", b)).content, bText)
      assert.equal((await read("full-owner-ignores-default-b", fileRef(a.identity, "SKILL.md"), a)).content, aText)
      assert.equal((await read("from-inherits-a", "skill://" + shared + "/SKILL.md", a, ["--from", String(aRead.ref)])).content, aText)
      assert.equal((await read("relative-selected-a", "SKILL.md", a, ["--from", String(aRead.ref), "--offline"])).content, aText)
      await reject("explicit-conflicting-library", ["read", fileRef(a.identity, "SKILL.md"), "--database", B.skills.database_id, "--metrics"], ["LIBRARY_SCOPE_MISMATCH"])
      await reject("foreign-selected-snapshot", ["read", fileRef(b.identity, "SKILL.md", String(aRead.snapshot_id)), "--database", B.skills.database_id, "--offline", "--metrics"], ["SNAPSHOT_CONFLICT"])
      const changed = await tree(join(fixtures, "overlap-b-updated"), [textFile("SKILL.md", bNext)])
      await imported("overlap-b-updated", B, changed, shared)
      assert.equal((await read("fixed-a-after-b-change", String(aRead.ref), a, ["--offline"])).content, aText)
      assert.equal((await read("fixed-b-after-own-change", String(bRead.ref), b, ["--offline"])).content, bText)
      assert.equal((await read("current-b-after-change", fileRef(b.identity, "SKILL.md"), b, ["--database", B.skills.database_id, "--refresh"])).content, bNext)
      return { a, b, outside, a_pin: String(aRead.ref), b_pin: String(bRead.ref), b_next: bNext }
    })
    await stage("cross-library-copy-rebinds-only-exact-batch-owned-current-references", async () => {
      const copyId = id("copy-owner")
      const targetA = fileRef(overlap.a.identity, "SKILL.md"), targetB = fileRef(overlap.b.identity, "SKILL.md")
      const external = fileRef(overlap.outside.identity, "SKILL.md"), missing = fileRef(overlap.a.identity, "missing.md")
      const body = main(copyId, "[Current](" + targetA + ")\n[External](" + external + ")\n[Fixed](" + overlap.a_pin + ")\n[Missing path](" + missing + ")\n\n    [Example](" + targetA + ")")
      const original = await tree(join(fixtures, "copy-origin-a"), [textFile("SKILL.md", body), portable(A, copyId, { members: [overlap.a.identity], requires: [overlap.a.identity] })])
      const originalOwner = await imported("copy-origin-a", A, original, copyId)
      await observe("copy-origin-a", A, originalOwner.owner, [overlap.a], [overlap.a])
      const selected = await manifest("copy-to-b", [
        { root: "owner", skill_id: copyId, files: [textFile("SKILL.md", body)] },
        { root: "leaf", skill_id: overlap.b.skill_id, files: [textFile("SKILL.md", overlap.b_next)] },
      ])
      const preserved = await batch("copy-no-rebind", B, selected)
      const owner = preserved.owners.get(copyId)!
      assert.deepEqual(preserved.review.rewrites, [])
      await observe("unbound-foreign-link-no-members", B, owner)
      assert.equal((await read("no-rebind-keeps-a", fileRef(owner.identity, "SKILL.md"), owner, ["--database", B.skills.database_id, "--refresh"])).content, body)
      const relation = portable(A, copyId, { members: [overlap.a.identity], requires: [overlap.a.identity] })
      await writeFile(join(selected.root, "owner", MANIFEST), relation.bytes, { flag: "wx", mode: 0o600 })
      await reject("foreign-relations-without-copy-authority", batchArgs(B, selected.path, "copy-denied"), ["PORTABLE_RELATION_SCOPE"])
      const rebound = await batch("copy-rebound", B, selected, ["--rebind-from", A.library_id])
      assert.equal(rows(rebound.review.rewrites).length, 3, "Only one active current body ref and two exact relations should change")
      await observe("rebound-relations-b", B, owner, [overlap.b], [overlap.b])
      const expected = body.replace("[Current](" + targetA + ")", "[Current](" + targetB + ")")
      const readBack = await read("rebound-body", fileRef(owner.identity, "SKILL.md"), owner, ["--database", B.skills.database_id, "--refresh"])
      assert.equal(readBack.content, expected)
      assert.equal((await read("explicit-external-from-b", external, overlap.outside, ["--from", String(readBack.ref)])).content, main(overlap.outside.skill_id, "# External A"))
      await observe("origin-a-relations-unchanged", A, originalOwner.owner, [overlap.a], [overlap.a])
      const foreign = await manifest("copy-unmapped-relation", [
        { root: "owner", skill_id: id("copy-unmapped"), files: [textFile("SKILL.md", main("Unmapped", "# No mapping")), portable(A, id("copy-unmapped"), { members: [overlap.outside.identity] })] },
        { root: "leaf", skill_id: overlap.b.skill_id, files: [textFile("SKILL.md", overlap.b_next)] },
      ])
      await reject("unmapped-relation-remains-foreign", batchArgs(B, foreign.path, "copy-unmapped", ["--rebind-from", A.library_id]), ["PORTABLE_RELATION_SCOPE"])
      return { page_id: owner.page_id, source_page_id: originalOwner.owner.page_id, rewrites: rebound.review.rewrites, external_owner_preserved: overlap.outside.identity, fixed_ref_preserved: overlap.a_pin, missing_path_preserved: missing }
    })
    await verifyMembersCorpus(input.corpus)
    report.status = "passed"
    report.current_case = "complete"
    await save()
    return report
  } catch (error) {
    report.status = "failed"
    await save()
    throw new Error("Reference verification stopped at " + report.current_case + "; preserve original operations and inspect " + join(input.root, "report.json"), { cause: error })
  }
}

async function mainCommand() {
  const args = new Map<string, string>(), argv = process.argv.slice(2)
  const supported = ["--cli", "--runtime", "--output", "--corpus", "--prefix", "--parent", "--existing-entry", "--existing-library"]
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1]
    assert.ok(name && supported.includes(name) && value && !value.startsWith("--") && !args.has(name), "Supply each supported flag once with a value")
    args.set(name, value)
  }
  const required = (key: string) => {
    const value = args.get(key)
    assert.ok(value, "Missing " + key)
    return value
  }
  const root = required("--output")
  const driver = await installedDriver(required("--cli"), required("--runtime"), root)
  const report = await runSkillReferenceLive({
    root, corpus: required("--corpus"), parent: required("--parent"),
    existing_entry: required("--existing-entry"), existing_library: required("--existing-library"),
    prefix: args.get("--prefix") ?? "refs-" + Date.now().toString(36) + "-" + randomUUID().slice(0, 8),
    ...driver,
  })
  process.stdout.write(JSON.stringify({ status: report.status, report: join(root, "report.json"), libraries: Object.fromEntries(Object.entries(report.libraries).map(([name, library]) => [name, { library_id: library.library_id, entry: library.skills.database_id }])), cases: report.cases.map(({ name, status }) => ({ name, status })) }) + "\n")
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mainCommand().catch((error: unknown) => {
    process.stderr.write(JSON.stringify(sanitizeEvidence({ error: error instanceof Error ? error.message : "Reference verification failed", cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined })) + "\n")
    process.exitCode = 1
  })
}
