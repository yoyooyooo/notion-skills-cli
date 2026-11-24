import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { property } from "../../../../packages/core/src/model.ts"
import { MANIFEST } from "../../../../packages/core/src/portable.ts"
import { fileRef, pageId } from "../../../../packages/core/src/ref.ts"
import { ImportPlanSchema } from "../../../../packages/core/src/shared-current-import-plan-model.ts"
import {
  bindSkillRef,
  formatSkillIdentity,
  parseSkillRef,
} from "../../../../packages/core/src/skill-ref.ts"
import {
  SharedLibrarySchema,
  type SharedLibrary,
} from "../../../../packages/core/src/shared-library-model.ts"
import { probeEmptyLibrary, runEmptyLibrary, verifyLibraryPlacement } from "./empty-library.ts"
import {
  installedDriver,
  observeSkillRelations,
  requireZeroNotionWrites,
  sanitizeEvidence,
  treeEvidence,
  verifyMembersCorpus,
} from "./members-live.ts"

type Drive = Awaited<ReturnType<typeof installedDriver>>["drive"]
type File = { readonly path: string; readonly bytes: Uint8Array; readonly executable?: boolean }
type Entry = {
  readonly root: string
  readonly skill_id: string
  readonly files: readonly File[]
  readonly native?: readonly string[]
  readonly name?: string
}
type Owner = {
  readonly skill_id: string
  readonly page_id: string
  readonly identity: string
  readonly input: string
}
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const encoder = new TextEncoder()
const ordered = (values: readonly string[]) => [...values].sort()
const rows = (value: unknown) => {
  assert.ok(Array.isArray(value), "Expected a complete array")
  return value.map(property)
}
const authored = (files: Awaited<ReturnType<typeof treeEvidence>>) =>
  files.filter((file) => file.path !== MANIFEST)
const identity = (library: SharedLibrary, skill_id: string) =>
  formatSkillIdentity({ libraryId: library.library_id, skillId: skill_id })
const textFile = (path: string, text: string): File => ({ path, bytes: encoder.encode(text) })
const main = (name: string, body: string) =>
  "---\nname: " +
  name +
  "\ndescription: Dedicated reference verification fixture.\n---\n\n" +
  body +
  "\n"

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
  return await Promise.all(
    (await treeEvidence(root)).map(async (file) => ({
      path: file.path,
      bytes: await readFile(join(root, file.path)),
      executable: file.mode === "100755",
    })),
  )
}
function portable(
  library: SharedLibrary,
  name: string,
  selected: { readonly members?: readonly string[]; readonly requires?: readonly string[] },
) {
  return textFile(
    MANIFEST,
    JSON.stringify({
      format: "ntn-skills",
      version: 2,
      kind: "skill",
      name,
      description: "Dedicated reference verification fixture.",
      main: "SKILL.md",
      relations: { version: 1, ownership: "notion", library_id: library.library_id, ...selected },
    }) + "\n",
  )
}

/** Continue only an acknowledged, completely retired upstream batch whose later
 * verification failed without remote writes. No state or mutation is replayed. */
async function completedUpstream(
  root: string,
  selected: {
    readonly prefix: string
    readonly parent: string
    readonly library: string
    readonly corpus_sha256: string
    readonly cli_sha256: unknown
  },
) {
  assert.ok(isAbsolute(root))
  const readJson = async (path: string) => property(JSON.parse(await readFile(path, "utf8")))
  const report = await readJson(join(root, "report.json"))
  assert.equal(report.status, "failed")
  assert.equal(report.current_case, "fixed-upstream-batch-and-exact-relative-mapping")
  assert.equal(report.prefix, selected.prefix)
  assert.equal(report.authorized_parent, selected.parent)
  assert.equal(property(report.corpus).sha256, selected.corpus_sha256)
  assert.equal(property(report.execution).cli_sha256, selected.cli_sha256)
  const cases = rows(report.cases)
  assert.deepEqual(
    cases.map((item) => [item.name, item.status]),
    [
      ["attach-existing-dedicated-library", "passed"],
      ["initialize-new-library-and-repeat-empty-census", "passed"],
      ["fixed-upstream-batch-and-exact-relative-mapping", "failed"],
    ],
  )
  const A = Schema.decodeUnknownSync(SharedLibrarySchema)(property(report.libraries).A)
  const B = Schema.decodeUnknownSync(SharedLibrarySchema)(property(report.libraries).B)
  assert.equal(A.library_id, selected.library)
  const originalRun = dirname(dirname(root))
  const receipt = await readJson(join(originalRun, "result.json"))
  assert.equal(receipt.timed_out, false)
  assert.equal(receipt.frozen_artifacts, "passed")
  assert.equal(property(receipt.runtime_check).status, "unchanged")
  const commands = []
  for (const name of (await readdir(join(root, "commands")))
    .filter((name) => /^\d+\.json$/u.test(name))
    .sort()) {
    const path = join(root, "commands", name)
    const value = await readJson(path)
    commands.push({
      path,
      value,
      argv: Schema.decodeUnknownSync(Schema.Array(Schema.String))(value.argv),
    })
  }
  const writes = commands.filter(
    (command) =>
      command.argv.slice(0, 3).join(" ") === "ctl library import-batch" &&
      !command.argv.includes("--dry-run"),
  )
  assert.equal(writes.length, 1, "Continuation requires one exact original upstream batch")
  const command = writes[0]!
  assert.equal(command.value.exit, 0)
  const applied = property(command.value.output)
  assert.equal(applied.ok, true)
  assert.equal(applied.status, "applied")
  assert.equal(applied.operation_id, selected.prefix + "-upstream")
  assert.equal(command.argv[3], join(root, "fixtures/upstream/batch.json"))
  assert.equal(command.argv[command.argv.indexOf("--library") + 1], B.library_id)
  for (const later of commands.slice(commands.indexOf(command) + 1))
    requireZeroNotionWrites(later.value.output)
  const database = join(originalRun, "state/cli/state.sqlite")
  assert.equal(property(property(report.execution).stores).NTN_SKILLS_HOME, dirname(database))
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    assert.equal(
      db
        .prepare("SELECT key FROM shared_local_records WHERE category='dispatch' AND retired=0")
        .all().length,
      0,
      "Original dispatch state must be fully retired; unknown writes cannot continue here",
    )
    const plans = db
      .prepare(
        "SELECT payload,retired FROM shared_local_records WHERE key LIKE 'operations/import-plan/%' AND json_extract(payload,'$.operation_id')=?",
      )
      .all(String(applied.operation_id))
    assert.equal(plans.length, 1)
    const row = plans[0]!
    assert.equal(row.retired, 1)
    assert.equal(typeof row.payload, "string")
    const plan = Schema.decodeUnknownSync(ImportPlanSchema)(JSON.parse(String(row.payload)))
    assert.deepEqual(plan.library, B)
    assert.equal(plan.library_id, B.library_id)
    assert.equal(plan.skills_data_source_id, B.skills.data_source_id)
    assert.equal(plan.definition.kind, "batch")
    assert.deepEqual(plan.definition.mapping, applied.mapping)
    for (const step of Object.values(plan.steps)) assert.equal(step.phase, "complete")
    for (const item of rows(applied.skills)) {
      assert.deepEqual(plan.steps["body:" + String(item.skill_id)]?.result, item.body)
      assert.deepEqual(
        plan.steps["relations:" + String(item.skill_id)]?.result ?? null,
        item.relations,
      )
    }
  } finally {
    db.close()
  }
  return {
    native_recovery: false as const,
    root,
    A,
    B,
    applied,
    command: command.path,
    initialization: join(root, "initialization/evidence/empty-library/initialization-result.json"),
  }
}

/** One retained frontier: a successful recovery of the exact native cycles
 * failure. Earlier passed cases remain prior evidence; the failed case still
 * executes all of its independent observations and remaining assertions. */
async function completedNativeRecovery(
  path: string,
  selected: Parameters<typeof completedUpstream>[1],
) {
  assert.ok(isAbsolute(path))
  const readJson = async (file: string) => property(JSON.parse(await readFile(file, "utf8")))
  const handoff = await readJson(path)
  assert.equal(handoff.status, "completed_native_recovery")
  assert.equal(handoff.prefix, selected.prefix)
  assert.equal(handoff.cli_sha256, selected.cli_sha256)
  const runRoot = dirname(dirname(dirname(path)))
  assert.equal(handoff.run_root, runRoot)
  assert.equal(handoff.state_root, join(runRoot, "state/cli"))
  assert.equal(handoff.resume_receipt, join(runRoot, "evidence/native-recovery/resume.json"))
  const run = await readJson(join(runRoot, "result.json"))
  assert.equal(run.status, "passed")
  assert.equal(run.frozen_artifacts, "passed")
  const previousReport = String(handoff.previous_report)
  const previous = await readJson(previousReport)
  const root = dirname(previousReport)
  assert.equal(previous.status, "failed")
  assert.equal(previous.current_case, "cyclic-members-omission-explicit-empty-and-requires")
  assert.equal(previous.prefix, selected.prefix)
  assert.equal(previous.authorized_parent, selected.parent)
  assert.equal(property(previous.corpus).sha256, selected.corpus_sha256)
  const cases = rows(previous.cases)
  assert.deepEqual(
    cases.map((item) => [item.name, item.status]),
    [
      ["attach-existing-dedicated-library", "passed"],
      ["reattach-completed-test-library", "passed"],
      ["fixed-upstream-batch-and-exact-relative-mapping", "passed"],
      ["poteto-explicit-members-and-requires-with-all-authored-bytes", "passed"],
      ["cyclic-members-omission-explicit-empty-and-requires", "failed"],
    ],
  )
  const A = Schema.decodeUnknownSync(SharedLibrarySchema)(property(previous.libraries).A)
  const B = Schema.decodeUnknownSync(SharedLibrarySchema)(property(previous.libraries).B)
  assert.equal(A.library_id, selected.library)
  const original = await readJson(String(handoff.original_command))
  assert.equal(dirname(String(handoff.original_command)), join(root, "commands"))
  const originalArgv = Schema.decodeUnknownSync(Schema.Array(Schema.String))(original.argv)
  assert.equal(originalArgv[3], join(root, "fixtures/cycles/batch.json"))
  assert.equal(originalArgv[originalArgv.indexOf("--library") + 1], B.library_id)
  assert.equal(originalArgv[originalArgv.indexOf("--operation") + 1], selected.prefix + "-cycles")
  const failure = property(property(original.output).error)
  assert.equal(failure.code, "WRITE_OUTCOME_UNKNOWN")
  assert.equal(property(failure.details).cause_code, "CURRENT_NATIVE_ROUNDTRIP")
  assert.equal(property(failure.details).skill_page_id, handoff.original_page_id)
  assert.equal(property(failure.details).input_sha256, handoff.original_input_sha256)
  const resumed = await readJson(String(handoff.resume_receipt))
  assert.equal(resumed.exit, 0)
  const applied = property(resumed.output)
  assert.equal(applied.ok, true)
  assert.equal(applied.status, "applied")
  assert.equal(applied.operation_id, selected.prefix + "-cycles")
  const argv = Schema.decodeUnknownSync(Schema.Array(Schema.String))(resumed.argv)
  assert.equal(argv[3], join(root, "fixtures/cycles/batch.json"))
  assert.equal(argv[argv.indexOf("--library") + 1], B.library_id)
  assert.equal(argv[argv.indexOf("--operation") + 1], selected.prefix + "-cycles")
  assert.ok(argv.includes("--resume"))
  assert.deepEqual(
    ordered(rows(applied.skills).map((item) => String(item.skill_id))),
    ordered([selected.prefix + "-cycle-one", selected.prefix + "-cycle-two"]),
  )
  const first = rows(applied.skills).find(
    (item) => item.skill_id === selected.prefix + "-cycle-one",
  )
  assert.ok(first)
  assert.equal(
    property(first.body).page_id,
    handoff.original_page_id,
    "Recovery cannot replace the original page",
  )
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(join(String(handoff.state_root), "state.sqlite"), { readOnly: true })
  try {
    assert.equal(
      db
        .prepare("SELECT key FROM shared_local_records WHERE category='dispatch' AND retired=0")
        .all().length,
      0,
    )
    const plans = db
      .prepare(
        "SELECT payload,retired FROM shared_local_records WHERE key LIKE 'operations/import-plan/%' AND json_extract(payload,'$.operation_id')=?",
      )
      .all(String(applied.operation_id))
    assert.equal(plans.length, 1)
    const row = plans[0]!
    assert.equal(row.retired, 1)
    assert.equal(typeof row.payload, "string")
    const plan = Schema.decodeUnknownSync(ImportPlanSchema)(JSON.parse(String(row.payload)))
    assert.deepEqual(plan.library, B)
    assert.equal(plan.library_id, B.library_id)
    assert.equal(plan.skills_data_source_id, B.skills.data_source_id)
    assert.deepEqual(plan.definition.mapping, applied.mapping)
    assert.equal(plan.definition.items.length, 2)
    assert.equal(
      plan.definition.items.find((item) => item.skill_id === selected.prefix + "-cycle-one")
        ?.body_input_sha256,
      handoff.original_input_sha256,
    )
    assert.equal(
      plan.steps["body:" + selected.prefix + "-cycle-one"]?.operation_id,
      property(failure.details).operation_id,
    )
    for (const item of rows(applied.skills)) {
      assert.equal(plan.steps["body:" + String(item.skill_id)]?.phase, "complete")
      assert.equal(plan.steps["relations:" + String(item.skill_id)]?.phase, "complete")
      assert.deepEqual(plan.steps["body:" + String(item.skill_id)]?.result, item.body)
      assert.deepEqual(plan.steps["relations:" + String(item.skill_id)]?.result, item.relations)
    }
  } finally {
    db.close()
  }
  const oldReal = property(cases[2]!.evidence)
  const owners = Schema.decodeUnknownSync(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        skill_id: Schema.String,
        page_id: Schema.String,
        identity: Schema.String,
        input: Schema.String,
      }),
    ),
  )(oldReal.owners)
  for (const owner of Object.values(owners)) {
    assert.equal(owner.identity, identity(B, owner.skill_id))
    assert.equal(pageId(owner.page_id), owner.page_id)
  }
  const initialization = property(previous.completed_upstream).initialization
  assert.equal(typeof initialization, "string")
  return {
    native_recovery: true as const,
    root,
    A,
    B,
    applied,
    command: String(handoff.resume_receipt),
    initialization: String(initialization),
    retained_real: { owners, exports: oldReal.exports, rewrites: oldReal.rewrites },
    retained_poteto: cases[3]!.evidence,
  }
}

/** A fresh output directory is a new journey. Unknown writes retain their original
 * operation and state; this lever never repairs a failed page or replays its CREATE. */
export async function runSkillReferenceLive(input: {
  readonly root: string
  readonly prefix: string
  readonly corpus: string
  readonly parent: string
  readonly existing_library: string
  readonly completed_upstream?: string
  readonly completed_native_recovery?: string
  readonly drive: Drive
  readonly execution: Record<string, unknown>
}) {
  assert.ok(isAbsolute(input.root))
  assert.match(input.prefix, /^[a-z0-9][a-z0-9-]{0,60}$/u)
  assert.equal(pageId(input.parent), input.parent)
  assert.equal(pageId(input.existing_library), input.existing_library)
  const corpus = await verifyMembersCorpus(input.corpus)
  assert.ok(
    input.completed_upstream === undefined || input.completed_native_recovery === undefined,
    "Select one exact continuation frontier",
  )
  const selection = {
    prefix: input.prefix,
    parent: input.parent,
    library: input.existing_library,
    corpus_sha256: corpus.corpus_sha256,
    cli_sha256: input.execution.cli_sha256,
  }
  const continued =
    input.completed_native_recovery !== undefined
      ? await completedNativeRecovery(input.completed_native_recovery, selection)
      : input.completed_upstream === undefined
        ? undefined
        : await completedUpstream(input.completed_upstream, selection)
  await mkdir(dirname(input.root), { recursive: true, mode: 0o700 })
  await mkdir(input.root, { mode: 0o700 }) // Refuse to overwrite an earlier journey.
  const fixtures = join(input.root, "fixtures")
  await mkdir(fixtures, { mode: 0o700 })
  await mkdir(join(input.root, "exports"), { mode: 0o700 })
  const report = {
    version: 1,
    status: "running",
    current_case: "admission",
    prefix: input.prefix,
    execution: input.execution,
    authorized_parent: input.parent,
    completed_upstream:
      continued === undefined || continued.native_recovery
        ? null
        : {
            report: join(continued.root, "report.json"),
            command: continued.command,
            initialization: continued.initialization,
            mutation_replayed: false,
          },
    completed_native_recovery: input.completed_native_recovery ?? null,
    corpus: {
      path: input.corpus,
      sha256: corpus.corpus_sha256,
      repository_url: corpus.repository_url,
      skills: corpus.skills.map(({ files: _files, ...skill }) => skill),
    },
    libraries: {} as Record<string, SharedLibrary>,
    cases: [] as Array<{ name: string; status: string; evidence?: unknown; error?: string }>,
    boundary:
      "Real installed CLI and real Notion. Parent allocation is explicit test setup. Unknown-outcome recovery and crash injection remain controlled-test evidence.",
  }
  const save = () => json(join(input.root, "report.json"), report)
  let observation = 0
  const record = (label: string, value: unknown) =>
    json(
      join(
        input.root,
        "observations",
        String(++observation).padStart(4, "0") + "-" + label + ".json",
      ),
      value,
    )
  const stage = async <A>(name: string, run: () => Promise<A>): Promise<A> => {
    report.current_case = name
    await save()
    try {
      const result = await run()
      report.cases.push({ name, status: "passed", evidence: result })
      await save()
      return result
    } catch (error) {
      report.cases.push({
        name,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown failure",
      })
      throw error
    }
  }
  const execute = async (label: string, argv: string[]) => {
    const result = await input.drive(argv)
    await record(label, result)
    assert.equal(result.exit, 0, "Preserve the original operation and inspect " + result.record)
    assert.equal(
      property(result.output).ok,
      true,
      "No successful command result at " + result.record,
    )
    return property(result.output)
  }
  const reject = async (label: string, argv: string[], codes: readonly string[]) => {
    const result = await input.drive(argv)
    await record(label, result)
    assert.notEqual(result.exit, 0, "An unsafe selection unexpectedly succeeded")
    assert.equal(property(result.output).ok, false)
    const code = property(property(result.output).error).code
    assert.ok(
      typeof code === "string" && codes.includes(code),
      "Unexpected rejection " + String(code) + "; inspect " + result.record,
    )
    requireZeroNotionWrites(result.output)
    return { code, notion_writes: 0, command: result.record }
  }
  const id = (suffix: string) => input.prefix + "-" + suffix
  const verifyPlacement = async (label: string, library: SharedLibrary) => {
    const facts = await verifyLibraryPlacement({
      library,
      parent: input.parent,
      probe: async (request) =>
        Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
          await probeEmptyLibrary(request),
        ),
    })
    await record(label + "-physical-library-placement", facts)
  }
  const observe = async (
    label: string,
    library: SharedLibrary,
    owner: Owner,
    members: readonly Owner[] = [],
    requires: readonly Owner[] = [],
  ) => {
    const output = await execute(label + "-page", ["ctl", "api", "v1/pages/" + owner.page_id])
    requireZeroNotionWrites(output)
    const actual = observeSkillRelations(output.response, library, {
      pageId: owner.page_id,
      skillId: owner.skill_id,
    })
    const expected = {
      members: ordered(members.map((row) => row.page_id)),
      requires: ordered(requires.map((row) => row.page_id)),
    }
    await record(label + "-actual-relations", { source: "independent_page_get", expected, actual })
    assert.equal(actual.enabled, true)
    assert.deepEqual(actual.members, expected.members)
    assert.deepEqual(actual.requires, expected.requires)
    return actual
  }
  const manifest = async (
    name: string,
    entries: readonly Entry[],
    selected = entries.map((row) => row.root),
  ) => {
    const root = join(fixtures, name)
    await mkdir(root, { mode: 0o700 })
    for (const entry of entries) await tree(join(root, entry.root), entry.files)
    const path = join(root, "batch.json")
    await json(path, {
      version: 1,
      root: ".",
      skills: entries
        .filter((entry) => selected.includes(entry.root))
        .map(({ files: _files, ...entry }) => ({
          ...entry,
          name: entry.name ?? entry.skill_id,
          description: "Dedicated reference verification fixture.",
        })),
    })
    return { path, root, entries }
  }
  const batchArgs = (
    library: SharedLibrary,
    path: string,
    label: string,
    extra: readonly string[] = [],
  ) => [
    "ctl",
    "library",
    "import-batch",
    path,
    "--library",
    library.library_id,
    "--operation",
    id(label),
    "--max-requests",
    "10000",
    "--timeout",
    "1200000",
    ...extra,
  ]
  const batchOwners = (
    library: SharedLibrary,
    selected: Awaited<ReturnType<typeof manifest>>,
    applied: Record<string, unknown>,
  ) => {
    const owners = new Map<string, Owner>()
    for (const item of rows(applied.skills)) {
      assert.equal(typeof item.skill_id, "string")
      const skill_id = String(item.skill_id),
        body = property(item.body)
      const page_id = pageId(String(body.page_id))
      assert.ok(page_id, "Completed batch body has no allocated page")
      const entry = selected.entries.find((entry) => entry.skill_id === skill_id)
      assert.ok(entry)
      owners.set(skill_id, {
        skill_id,
        page_id,
        identity: identity(library, skill_id),
        input: join(selected.root, entry.root),
      })
    }
    assert.equal(owners.size, selected.entries.length)
    return owners
  }
  const batch = async (
    label: string,
    library: SharedLibrary,
    selected: Awaited<ReturnType<typeof manifest>>,
    extra: readonly string[] = [],
  ) => {
    const before = await treeEvidence(selected.root)
    const args = batchArgs(library, selected.path, label, extra)
    const review = await execute(label + "-dry-run", [...args, "--dry-run"])
    requireZeroNotionWrites(review)
    const applied = await execute(label + "-apply", args)
    assert.equal(applied.status, "applied")
    const owners = batchOwners(library, selected, applied)
    assert.deepEqual(
      await treeEvidence(selected.root),
      before,
      "Batch compilation changed its original input",
    )
    return { review, applied, owners }
  }
  const imported = async (
    label: string,
    library: SharedLibrary,
    path: string,
    skill_id: string,
  ) => {
    const args = [
      "ctl",
      "library",
      "import",
      path,
      "--library",
      library.library_id,
      "--skill-id",
      skill_id,
      "--operation",
      id(label),
      "--max-requests",
      "10000",
      "--timeout",
      "1200000",
    ]
    const review = await execute(label + "-dry-run", [...args, "--dry-run"])
    requireZeroNotionWrites(review)
    const output = await execute(label + "-apply", args)
    const page_id = pageId(String(output.page_id))
    assert.ok(page_id)
    return {
      owner: { skill_id, page_id, identity: identity(library, skill_id), input: path },
      review,
      output,
    }
  }
  const exported = async (
    label: string,
    library: SharedLibrary,
    owner: Owner,
    rewrites: Readonly<Record<string, readonly [string, string][]>> = {},
  ) => {
    const destination = join(input.root, "exports", label)
    const output = await execute(label + "-export", [
      "export",
      owner.page_id,
      "--library",
      library.library_id,
      "--refresh",
      "--output",
      destination,
    ])
    requireZeroNotionWrites(output)
    const expected = await Promise.all(
      authored(await treeEvidence(owner.input)).map(async (file) => {
        let bytes = await readFile(join(owner.input, file.path))
        for (const [before, after] of rewrites[file.path] ?? []) {
          const text = bytes.toString("utf8")
          assert.equal(text.split(before).length, 2, "Expected one exact authored destination")
          bytes = Buffer.from(text.replace(before, after))
        }
        return { ...file, bytes: bytes.length, sha256: digest(bytes) }
      }),
    )
    assert.deepEqual(
      authored(await treeEvidence(destination)),
      expected,
      "Export changed authored path, bytes or executable mode",
    )
    return {
      destination,
      files: expected.length,
      authored_sha256: digest(JSON.stringify(expected)),
    }
  }
  const read = async (
    label: string,
    target: string,
    expected: Owner,
    extra: readonly string[] = [],
  ) => {
    const output = await execute(label, ["read", target, "--metrics", ...extra])
    requireZeroNotionWrites(output)
    assert.equal(property(output.record).id, expected.identity)
    assert.equal(typeof output.content, "string")
    assert.equal(output.has_more, false)
    return output
  }

  try {
    const A = await stage("attach-existing-dedicated-library", async () => {
      const output = await execute("attach-a", [
        "ctl",
        "library",
        "init",
        "--library",
        input.existing_library,
      ])
      requireZeroNotionWrites(output)
      const library = Schema.decodeUnknownSync(SharedLibrarySchema)(output.library)
      assert.equal(library.library_id, input.existing_library)
      await verifyPlacement("existing-a", library)
      if (continued !== undefined) assert.deepEqual(library, continued.A)
      report.libraries.A = library
      return library
    })
    const B = await stage(
      continued === undefined
        ? "initialize-new-library-and-repeat-empty-census"
        : "reattach-completed-test-library",
      async () => {
        if (continued !== undefined) {
          const attached = await execute("reattach-completed-b", [
            "ctl",
            "library",
            "init",
            "--library",
            continued.B.library_id,
          ])
          requireZeroNotionWrites(attached)
          const library = Schema.decodeUnknownSync(SharedLibrarySchema)(attached.library)
          assert.deepEqual(library, continued.B)
          await verifyPlacement("continued-b", library)
          report.libraries.B = library
          return library
        }
        const result = await runEmptyLibrary({
          root: join(input.root, "initialization"),
          stage: "init",
          container: input.parent,
          drive: input.drive,
          probe: async (request) =>
            Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
              await probeEmptyLibrary(request),
            ),
        })
        const library = Schema.decodeUnknownSync(SharedLibrarySchema)(property(result).library)
        assert.notEqual(library.library_id, A.library_id)
        assert.notEqual(library.library_id, input.parent)
        for (const role of ["skills", "files", "records", "sources"] as const) {
          assert.notEqual(library[role].database_id, A[role].database_id)
          assert.notEqual(library[role].data_source_id, A[role].data_source_id)
        }
        report.libraries.B = library
        return library
      },
    )
    if (continued?.native_recovery) {
      report.cases.push(
        {
          name: "fixed-upstream-batch-and-exact-relative-mapping",
          status: "retained_passed",
          evidence: {
            previous_report: join(continued.root, "report.json"),
            value: continued.retained_real,
          },
        },
        {
          name: "poteto-explicit-members-and-requires-with-all-authored-bytes",
          status: "retained_passed",
          evidence: {
            previous_report: join(continued.root, "report.json"),
            value: continued.retained_poteto,
          },
        },
      )
      await save()
    }
    const real = continued?.native_recovery
      ? continued.retained_real
      : await stage("fixed-upstream-batch-and-exact-relative-mapping", async () => {
          const entries: Entry[] = []
          for (const skill of corpus.skills)
            entries.push({
              root: skill.name,
              skill_id: id(skill.name),
              name: skill.name,
              files: await copied(skill.input_path),
            })
          const selected = await manifest("upstream", entries)
          let result: {
            readonly applied: Record<string, unknown>
            readonly owners: Map<string, Owner>
          }
          if (continued === undefined) result = await batch("upstream", B, selected)
          else {
            assert.equal(continued.native_recovery, false)
            assert.deepEqual(
              await treeEvidence(selected.root),
              await treeEvidence(join(continued.root, "fixtures/upstream")),
              "Continuation requires the exact original authored inputs and manifest",
            )
            assert.deepEqual(
              continued.applied.mapping,
              entries.map((entry) => ({ root: entry.root, identity: identity(B, entry.skill_id) })),
            )
            result = {
              applied: continued.applied,
              owners: batchOwners(B, selected, continued.applied),
            }
            await record("completed-upstream-receipt", {
              source: continued.command,
              operation_id: continued.applied.operation_id,
              mutation_replayed: false,
            })
          }
          const owner = (name: string) => {
            const value = result.owners.get(id(name))
            assert.ok(value)
            return value
          }
          const exports: unknown[] = []
          for (const skill of corpus.skills) {
            const targets =
              skill.name === "architect"
                ? [owner("arena")]
                : skill.name === "principle-minimize-reader-load"
                  ? [owner("principle-guard-the-context-window")]
                  : []
            await observe("upstream-" + skill.name, B, owner(skill.name), targets)
            const rewrites: Record<string, readonly [string, string][]> =
              skill.name === "architect"
                ? {
                    "references/rationale-template.md": [
                      ["../../arena/SKILL.md", "skill://" + id("arena") + "/SKILL.md"],
                    ],
                  }
                : skill.name === "principle-minimize-reader-load"
                  ? {
                      "SKILL.md": [
                        [
                          "../principle-guard-the-context-window/SKILL.md",
                          "skill://" + id("principle-guard-the-context-window") + "/SKILL.md",
                        ],
                      ],
                    }
                  : {}
            exports.push(await exported("upstream-" + skill.name, B, owner(skill.name), rewrites))
          }
          const poteto = rows(result.applied.skills).find(
            (row) => row.skill_id === id("poteto-mode"),
          )
          assert.ok(poteto)
          assert.deepEqual(
            property(poteto.members_discovery).confirmed,
            [],
            "Prose mentions must not invent poteto Members",
          )
          await record("upstream-summary", {
            mapping: result.applied.mapping,
            rewrites: result.applied.rewrites,
            exports,
          })
          return {
            owners: Object.fromEntries(result.owners),
            exports,
            rewrites: result.applied.rewrites,
          }
        })
    const upstream = (name: string) => {
      const owner = real.owners[id(name)]
      assert.ok(owner)
      return owner
    }
    if (!continued?.native_recovery)
      await stage("poteto-explicit-members-and-requires-with-all-authored-bytes", async () => {
        const source = corpus.skills.find((skill) => skill.name === "poteto-mode")
        assert.ok(source)
        const poteto = upstream("poteto-mode"),
          guard = upstream("principle-guard-the-context-window"),
          arena = upstream("arena"),
          unslop = upstream("unslop")
        const path = await tree(join(fixtures, "poteto-explicit"), [
          ...(await copied(source.input_path)),
          portable(B, "poteto-mode", {
            members: [guard.identity, arena.identity],
            requires: [unslop.identity],
          }),
        ])
        const result = await imported("poteto-explicit", B, path, poteto.skill_id)
        assert.equal(result.owner.page_id, poteto.page_id)
        assert.equal(property(result.output.members_discovery).member_policy, "explicit")
        await observe("poteto-explicit", B, result.owner, [guard, arena], [unslop])
        const exportedTree = await exported("poteto-explicit", B, result.owner)
        assert.equal(exportedTree.files, 41)
        const content = await read("poteto-read", fileRef(poteto.identity, "SKILL.md"), poteto, [
          "--library",
          B.library_id,
          "--refresh",
        ])
        assert.equal(digest(String(content.content)), source.main_sha256)
        assert.deepEqual(
          ordered(rows(content.members).map((row) => String(row.id))),
          ordered([guard.identity, arena.identity]),
        )
        assert.deepEqual(
          rows(content.required).map((row) => row.id),
          [unslop.identity],
        )
        const repeated = await imported("poteto-repeat", B, path, poteto.skill_id)
        requireZeroNotionWrites(repeated.output)
        return {
          page_id: poteto.page_id,
          ...exportedTree,
          original_main_sha256: source.main_sha256,
          repeat_notion_writes: 0,
        }
      })
    await stage("cyclic-members-omission-explicit-empty-and-requires", async () => {
      const one = id("cycle-one"),
        two = id("cycle-two")
      const selected = await manifest("cycles", [
        {
          root: "one",
          skill_id: one,
          native: ["SKILL.md"],
          files: [textFile("SKILL.md", main(one, "[Two](../two/SKILL.md)"))],
        },
        {
          root: "two",
          skill_id: two,
          native: ["SKILL.md"],
          files: [textFile("SKILL.md", main(two, "[One](../one/SKILL.md)"))],
        },
      ])
      const result = continued?.native_recovery
        ? { applied: continued.applied, owners: batchOwners(B, selected, continued.applied) }
        : await batch("cycles", B, selected)
      if (continued?.native_recovery) {
        assert.deepEqual(
          await treeEvidence(selected.root),
          await treeEvidence(join(continued.root, "fixtures/cycles")),
          "Recovery continuation keeps the exact original cyclic inputs",
        )
        await record("recovered-cycles-receipt", {
          source: continued.command,
          operation_id: continued.applied.operation_id,
          mutation_replayed: false,
        })
      }
      const a = result.owners.get(one)!,
        b = result.owners.get(two)!
      await observe("cycle-one", B, a, [b])
      await observe("cycle-two", B, b, [a])
      await execute("manual-remove-member", [
        "ctl",
        "library",
        "skill",
        "update",
        a.page_id,
        "--library",
        B.library_id,
        "--members",
        "",
      ])
      await observe("manual-member-removal", B, a)
      const repeat = await batch("cycles-repeat", B, selected)
      requireZeroNotionWrites(repeat.applied)
      await observe("omission-preserves-removal", B, a)
      await observe("other-cycle-member-preserved", B, b, [a])
      const emptyId = id("explicit-empty")
      const body = main(emptyId, "[Optional target](skill://" + two + "/SKILL.md)")
      const explicit = await tree(join(fixtures, "explicit-empty"), [
        textFile("SKILL.md", body),
        portable(B, emptyId, { members: [], requires: [b.identity] }),
      ])
      const empty = await imported("explicit-empty", B, explicit, emptyId)
      await observe("explicit-empty", B, empty.owner, [], [b])
      const omitted = await tree(join(fixtures, "existing-omitted"), [textFile("SKILL.md", body)])
      const retained = await imported("existing-omitted", B, omitted, emptyId)
      requireZeroNotionWrites(retained.output)
      await observe("omission-preserves-explicit-requires", B, empty.owner, [], [b])
      const inertId = id("inert-mentions")
      const inert = await tree(join(fixtures, "inert"), [
        textFile(
          "SKILL.md",
          main(
            inertId,
            "Mention " +
              two +
              " in prose.\n\n~~~md\n[example](skill://" +
              two +
              "/SKILL.md)\n~~~\n\n![image](skill://" +
              two +
              "/SKILL.md)",
          ),
        ),
      ])
      const untouched = await imported("inert", B, inert, inertId)
      await observe("inert-links", B, untouched.owner)
      return {
        cycle_pages: [a.page_id, b.page_id],
        preserved_manual_removal: true,
        explicit_empty: empty.owner.page_id,
        requires_stayed_explicit: true,
        inert_page: untouched.owner.page_id,
      }
    })
    await stage("unproven-relative-inputs-and-requires-cycle-write-nothing", async () => {
      const failures: unknown[] = []
      for (const [label, href, includeTarget] of [
        ["unlisted", "../target/SKILL.md", false],
        ["missing-path", "../target/missing.md", true],
        ["encoded-slash", "../target%2FSKILL.md", true],
      ] as const) {
        const selected = await manifest(
          label,
          [
            {
              root: "owner",
              skill_id: id(label + "-owner"),
              files: [textFile("SKILL.md", main(label, "[Target](" + href + ")"))],
            },
            {
              root: "target",
              skill_id: id(label + "-target"),
              files: [textFile("SKILL.md", main("Target", "# Target"))],
            },
          ],
          includeTarget ? ["owner", "target"] : ["owner"],
        )
        failures.push(
          await reject(label, batchArgs(B, selected.path, label), [
            "CURRENT_IMPORT_BATCH_UNRESOLVED",
          ]),
        )
      }
      const first = id("requires-one"),
        second = id("requires-two")
      const selected = await manifest("requires-cycle", [
        {
          root: "one",
          skill_id: first,
          files: [
            textFile("SKILL.md", main(first, "# First")),
            portable(B, first, { requires: [identity(B, second)] }),
          ],
        },
        {
          root: "two",
          skill_id: second,
          files: [
            textFile("SKILL.md", main(second, "# Second")),
            portable(B, second, { requires: [identity(B, first)] }),
          ],
        },
      ])
      failures.push(
        await reject("requires-cycle", batchArgs(B, selected.path, "requires-cycle"), [
          "CURRENT_REQUIRES_CYCLE",
        ]),
      )
      return failures
    })
    const overlap = await stage(
      "overlapping-library-identities-context-and-fixed-paths",
      async () => {
        const shared = id("overlap"),
          external = id("external"),
          distractor = id("display-distractor")
        const aText = main(shared, "# Library A original"),
          bText = main(shared, "# Library B original"),
          bNext = main(shared, "# Library B updated")
        const aInput = await manifest("overlap-a", [
          { root: "leaf", skill_id: shared, files: [textFile("SKILL.md", aText)] },
          {
            root: "external",
            skill_id: external,
            files: [textFile("SKILL.md", main(external, "# External A"))],
          },
        ])
        const bInput = await manifest("overlap-b", [
          { root: "leaf", skill_id: shared, files: [textFile("SKILL.md", bText)] },
          {
            root: "distractor",
            skill_id: distractor,
            name: shared,
            files: [textFile("SKILL.md", main(distractor, "# Display name distractor"))],
          },
        ])
        const ar = await batch("overlap-a", A, aInput),
          br = await batch("overlap-b", B, bInput)
        const a = ar.owners.get(shared)!,
          b = br.owners.get(shared)!,
          outside = ar.owners.get(external)!
        await observe("overlap-a", A, a)
        await observe("overlap-b", B, b)
        const aRead = await read("same-id-a", "skill://" + shared + "/SKILL.md", a, [
          "--library",
          A.library_id,
          "--refresh",
        ])
        const bRead = await read("same-id-b", "skill://" + shared + "/SKILL.md", b, [
          "--library",
          B.library_id,
          "--refresh",
        ])
        assert.equal(aRead.content, aText)
        assert.equal(bRead.content, bText)
        assert.equal(typeof aRead.ref, "string")
        assert.equal(typeof bRead.ref, "string")
        const aPin = bindSkillRef(parseSkillRef(String(aRead.ref)))
        assert.equal(aPin.selection.kind, "fixed")
        const configured = await execute("default-b", [
          "ctl",
          "config",
          "set",
          "default_library",
          B.library_id,
        ])
        requireZeroNotionWrites(configured)
        assert.equal(
          (await read("short-entry-default-b", "skill://" + shared + "/SKILL.md", b)).content,
          bText,
        )
        assert.equal(
          (await read("full-owner-ignores-default-b", fileRef(a.identity, "SKILL.md"), a)).content,
          aText,
        )
        assert.equal(
          (
            await read("from-inherits-a", "skill://" + shared + "/SKILL.md", a, [
              "--from",
              String(aRead.ref),
            ])
          ).content,
          aText,
        )
        assert.equal(
          (
            await read("relative-selected-a", "SKILL.md", a, [
              "--from",
              String(aRead.ref),
              "--offline",
            ])
          ).content,
          aText,
        )
        await reject(
          "explicit-conflicting-library",
          ["read", fileRef(a.identity, "SKILL.md"), "--library", B.library_id, "--metrics"],
          ["LIBRARY_SCOPE_MISMATCH"],
        )
        await reject(
          "foreign-selected-snapshot",
          [
            "read",
            fileRef(b.identity, "SKILL.md", String(aRead.snapshot_id)),
            "--library",
            B.library_id,
            "--offline",
            "--metrics",
          ],
          ["SNAPSHOT_CONFLICT"],
        )
        const changed = await tree(join(fixtures, "overlap-b-updated"), [
          textFile("SKILL.md", bNext),
        ])
        await imported("overlap-b-updated", B, changed, shared)
        assert.equal(
          (await read("fixed-a-after-b-change", String(aRead.ref), a, ["--offline"])).content,
          aText,
        )
        assert.equal(
          (await read("fixed-b-after-own-change", String(bRead.ref), b, ["--offline"])).content,
          bText,
        )
        assert.equal(
          (
            await read("current-b-after-change", fileRef(b.identity, "SKILL.md"), b, [
              "--library",
              B.library_id,
              "--refresh",
            ])
          ).content,
          bNext,
        )
        return { a, b, outside, a_pin: String(aRead.ref), b_pin: String(bRead.ref), b_next: bNext }
      },
    )
    await stage(
      "cross-library-copy-rebinds-only-exact-batch-owned-current-references",
      async () => {
        const originShortId = id("origin-short")
        const originPin = parseSkillRef(overlap.a_pin).selection
        assert.equal(originPin.kind, "fixed")
        assert.ok(originPin.kind === "fixed")
        const shortCurrent = "skill://" + overlap.a.skill_id + "/SKILL.md"
        const shortFixed = shortCurrent + "?snapshot=" + originPin.snapshotId
        const originBody = main(
          originShortId,
          "[External](" + shortCurrent + ")\n[Fixed](" + shortFixed + ")",
        )
        const originInput = await tree(join(fixtures, "origin-short"), [
          textFile("SKILL.md", originBody),
          portable(A, originShortId, {}),
        ])
        const originImported = await imported("origin-short", B, originInput, originShortId)
        assert.equal(rows(originImported.review.rewrites).length, 2)
        assert.deepEqual(originImported.output.rewrites, originImported.review.rewrites)
        await observe("origin-short-no-destination-members", B, originImported.owner)
        const originExpected = originBody
          .replace(
            "[External](" + shortCurrent + ")",
            "[External](" + fileRef(overlap.a.identity, "SKILL.md") + ")",
          )
          .replace("[Fixed](" + shortFixed + ")", "[Fixed](" + overlap.a_pin + ")")
        assert.equal(
          (
            await read(
              "origin-short-preserves-a",
              fileRef(originImported.owner.identity, "SKILL.md"),
              originImported.owner,
              ["--library", B.library_id, "--refresh"],
            )
          ).content,
          originExpected,
        )
        assert.equal(await readFile(join(originInput, "SKILL.md"), "utf8"), originBody)
        const copyId = id("copy-owner")
        const targetA = fileRef(overlap.a.identity, "SKILL.md"),
          targetB = fileRef(overlap.b.identity, "SKILL.md")
        const external = fileRef(overlap.outside.identity, "SKILL.md"),
          missing = fileRef(overlap.a.identity, "missing.md")
        const body = main(
          copyId,
          "[Current](" +
            targetA +
            ")\n[External](" +
            external +
            ")\n[Fixed](" +
            overlap.a_pin +
            ")\n[Missing path](" +
            missing +
            ")\n\n    [Example](" +
            targetA +
            ")",
        )
        const original = await tree(join(fixtures, "copy-origin-a"), [
          textFile("SKILL.md", body),
          portable(A, copyId, { members: [overlap.a.identity], requires: [overlap.a.identity] }),
        ])
        const originalOwner = await imported("copy-origin-a", A, original, copyId)
        await observe("copy-origin-a", A, originalOwner.owner, [overlap.a], [overlap.a])
        const selected = await manifest("copy-to-b", [
          { root: "owner", skill_id: copyId, files: [textFile("SKILL.md", body)] },
          {
            root: "leaf",
            skill_id: overlap.b.skill_id,
            files: [textFile("SKILL.md", overlap.b_next)],
          },
        ])
        const preserved = await batch("copy-no-rebind", B, selected)
        const owner = preserved.owners.get(copyId)!
        assert.deepEqual(preserved.review.rewrites, [])
        await observe("unbound-foreign-link-no-members", B, owner)
        assert.equal(
          (
            await read("no-rebind-keeps-a", fileRef(owner.identity, "SKILL.md"), owner, [
              "--library",
              B.library_id,
              "--refresh",
            ])
          ).content,
          body,
        )
        const relation = portable(A, copyId, {
          members: [overlap.a.identity],
          requires: [overlap.a.identity],
        })
        await writeFile(join(selected.root, "owner", MANIFEST), relation.bytes, {
          flag: "wx",
          mode: 0o600,
        })
        await reject(
          "foreign-relations-without-copy-authority",
          batchArgs(B, selected.path, "copy-denied"),
          ["PORTABLE_RELATION_SCOPE"],
        )
        const rebound = await batch("copy-rebound", B, selected, ["--rebind-from", A.library_id])
        assert.equal(
          rows(rebound.review.rewrites).length,
          3,
          "Only one active current body ref and two exact relations should change",
        )
        await observe("rebound-relations-b", B, owner, [overlap.b], [overlap.b])
        const expected = body.replace("[Current](" + targetA + ")", "[Current](" + targetB + ")")
        const readBack = await read("rebound-body", fileRef(owner.identity, "SKILL.md"), owner, [
          "--library",
          B.library_id,
          "--refresh",
        ])
        assert.equal(readBack.content, expected)
        assert.equal(
          (
            await read("explicit-external-from-b", external, overlap.outside, [
              "--from",
              String(readBack.ref),
            ])
          ).content,
          main(overlap.outside.skill_id, "# External A"),
        )
        await observe(
          "origin-a-relations-unchanged",
          A,
          originalOwner.owner,
          [overlap.a],
          [overlap.a],
        )
        const foreign = await manifest("copy-unmapped-relation", [
          {
            root: "owner",
            skill_id: id("copy-unmapped"),
            files: [
              textFile("SKILL.md", main("Unmapped", "# No mapping")),
              portable(A, id("copy-unmapped"), { members: [overlap.outside.identity] }),
            ],
          },
          {
            root: "leaf",
            skill_id: overlap.b.skill_id,
            files: [textFile("SKILL.md", overlap.b_next)],
          },
        ])
        await reject(
          "unmapped-relation-remains-foreign",
          batchArgs(B, foreign.path, "copy-unmapped", ["--rebind-from", A.library_id]),
          ["PORTABLE_RELATION_SCOPE"],
        )
        return {
          origin_short: {
            ...originImported.owner,
            body_sha256: digest(originExpected),
            fixed_ref: overlap.a_pin,
            rewrites: originImported.output.rewrites,
          },
          page_id: owner.page_id,
          source_page_id: originalOwner.owner.page_id,
          rewrites: rebound.review.rewrites,
          external_owner_preserved: overlap.outside.identity,
          fixed_ref_preserved: overlap.a_pin,
          missing_path_preserved: missing,
        }
      },
    )
    await verifyMembersCorpus(input.corpus)
    report.status = "passed"
    report.current_case = "complete"
    await save()
    return report
  } catch (error) {
    report.status = "failed"
    await save()
    throw new Error(
      "Reference verification stopped at " +
        report.current_case +
        "; preserve original operations and inspect " +
        join(input.root, "report.json"),
      { cause: error },
    )
  }
}

async function mainCommand() {
  const args = new Map<string, string>(),
    argv = process.argv.slice(2)
  const supported = [
    "--cli",
    "--runtime",
    "--output",
    "--corpus",
    "--prefix",
    "--parent",
    "--existing-library",
    "--completed-upstream",
    "--completed-native-recovery",
  ]
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index],
      value = argv[index + 1]
    assert.ok(
      name && supported.includes(name) && value && !value.startsWith("--") && !args.has(name),
      "Supply each supported flag once with a value",
    )
    args.set(name, value)
  }
  const required = (key: string) => {
    const value = args.get(key)
    assert.ok(value, "Missing " + key)
    return value
  }
  const root = required("--output")
  const driver = await installedDriver(required("--cli"), required("--runtime"), root)
  const previousRoot = args.get("--completed-upstream")
  const recoveredPath = args.get("--completed-native-recovery")
  const previousPrefix =
    recoveredPath !== undefined
      ? property(JSON.parse(await readFile(recoveredPath, "utf8"))).prefix
      : previousRoot === undefined
        ? undefined
        : property(JSON.parse(await readFile(join(previousRoot, "report.json"), "utf8"))).prefix
  if (previousPrefix !== undefined) assert.equal(typeof previousPrefix, "string")
  const report = await runSkillReferenceLive({
    root,
    corpus: required("--corpus"),
    parent: required("--parent"),
    existing_library: required("--existing-library"),
    ...(previousRoot === undefined ? {} : { completed_upstream: previousRoot }),
    ...(recoveredPath === undefined ? {} : { completed_native_recovery: recoveredPath }),
    prefix:
      args.get("--prefix") ??
      (typeof previousPrefix === "string"
        ? previousPrefix
        : "refs-" + Date.now().toString(36) + "-" + randomUUID().slice(0, 8)),
    ...driver,
  })
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      report: join(root, "report.json"),
      libraries: Object.fromEntries(
        Object.entries(report.libraries).map(([name, library]) => [
          name,
          { library_id: library.library_id },
        ]),
      ),
      cases: report.cases.map(({ name, status }) => ({ name, status })),
    }) + "\n",
  )
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mainCommand().catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify(
        sanitizeEvidence({
          error: error instanceof Error ? error.message : "Reference verification failed",
          cause:
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : undefined,
        }),
      ) + "\n",
    )
    process.exitCode = 1
  })
}
