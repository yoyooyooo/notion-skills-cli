import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    cli: { type: "string", default: "ntn-skills" },
    library: { type: "string" },
    help: { type: "boolean" },
  },
})

if (values.help) {
  process.stdout.write(
    "Usage: node scripts/verify-projected-builtins.mjs --library LIBRARY_ID [--cli EXECUTABLE_OR_JS]\n" +
      "Compare consumer file bytes, directory paths and discovery descriptions with this CLI package.\n" +
      "This does not verify generated Notion pages or Source ownership, the paired runtime, or model delivery.\n" +
      "No Notion writes. JSON goes to stdout; any missing, partial, changed or unreadable item exits 1.\n",
  )
  process.exit(0)
}

const hash = (text) => createHash("sha256").update(text).digest("hex")
const reject = (code, message, details) => {
  throw Object.assign(new Error(message), { code, details })
}
const failure = (error) => ({
  code: typeof error?.code === "string" ? error.code : "VERIFICATION_FAILED",
  message: error instanceof Error ? error.message : String(error),
  ...(error?.details === undefined ? {} : { details: error.details }),
})

function command(args) {
  const argv = /\.[cm]?js$/u.test(values.cli)
    ? [process.execPath, values.cli, ...args]
    : [values.cli, ...args]
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw result.error
  let output
  try {
    output = JSON.parse(result.stdout)
  } catch {
    reject("CLI_OUTPUT_INVALID", "CLI did not return complete JSON.", {
      args,
      exit_code: result.status,
    })
  }
  if (result.status !== 0 || output?.ok !== true)
    reject(output?.error?.code ?? "CLI_FAILED", output?.error?.message ?? "CLI failed.", {
      args,
      exit_code: result.status,
      error: output?.error,
    })
  return output
}

function content(result, path) {
  if (typeof result.content !== "string" || result.path !== path)
    reject("FILE_RESULT_INVALID", "The exact requested text file was not returned.", { path })
  return result.content
}

function read(args, path, snapshot) {
  const result = command(["read", ...args, "--json"])
  content(result, path)
  if (result.effects?.remote_writes !== "none")
    reject("READ_EFFECTS_INVALID", "The read did not attest zero remote writes.", { path })
  if (snapshot !== undefined && result.snapshot_id !== snapshot)
    reject("SELECTION_CHANGED", "A supporting file left the selected main snapshot.", { path })
  return result
}

function catalog(entry) {
  const records = []
  const cursors = new Set()
  let cursor
  do {
    const page = command([
      "list",
      "--library",
      entry,
      "--limit",
      "500",
      "--json",
      ...(cursor === undefined ? ["--refresh"] : ["--cursor", cursor]),
    ])
    if (
      page.coverage?.exhaustive !== true ||
      !Array.isArray(page.coverage?.failed_sources) ||
      page.coverage.failed_sources.length !== 0 ||
      !Array.isArray(page.records) ||
      typeof page.has_more !== "boolean"
    )
      reject("CATALOG_INCOMPLETE", "The selected library was not completely discovered.", {
        coverage: page.coverage,
      })
    records.push(...page.records)
    if (!page.has_more) break
    if (typeof page.next_cursor !== "string" || cursors.has(page.next_cursor))
      reject("CATALOG_CURSOR_INVALID", "The catalog did not supply a new continuation cursor.")
    cursor = page.next_cursor
    cursors.add(cursor)
  } while (true)
  return records
}

function verifySkill(builtin, records, entry) {
  const packaged = command(["ctl", "builtin", "read", builtin.id])
  content(packaged, "SKILL.md")
  if (!Array.isArray(packaged.files) || typeof packaged.builtin?.description !== "string")
    reject("PACKAGE_RESULT_INVALID", "The package did not expose its complete file metadata.")
  const matches = records.filter((record) => record.name === packaged.builtin.notion_name)
  if (matches.length !== 1)
    reject("PROJECTED_SKILL_NOT_UNIQUE", "Expected one projected Skill in the selected library.", {
      name: packaged.builtin.notion_name,
      matches: matches.map((record) => ({ id: record.id, ref: record.ref })),
    })
  const selected = matches[0]
  if (selected.enabled !== true || typeof selected.ref !== "string")
    reject("PROJECTED_SKILL_UNAVAILABLE", "The projected Skill is not enabled with an exact ref.")
  const main = read([selected.ref, "--library", entry, "--refresh"], "SKILL.md")
  if (typeof main.ref !== "string" || typeof main.snapshot_id !== "string")
    reject("SELECTION_INVALID", "The main read did not return its exact local selection.")
  const inventory = command(["files", main.snapshot_id])
  if (!Array.isArray(inventory.files) || inventory.snapshot_id !== main.snapshot_id)
    reject("DIRECTORY_INVALID", "The complete directory did not retain the main selection.")
  const expectedPaths = packaged.files.map((file) => file.path).sort()
  const actualPaths = inventory.files.map((file) => file.path).sort()
  const files = packaged.files.map((file) => {
    const expected =
      file.path === "SKILL.md"
        ? packaged
        : command(["ctl", "builtin", "read", builtin.id, "--path", file.path])
    if (
      expected.builtin?.content_id !== packaged.builtin.content_id ||
      expected.builtin?.package_version !== packaged.builtin.package_version
    )
      reject("PACKAGE_SELECTION_CHANGED", "The CLI package changed during verification.", {
        path: file.path,
      })
    const actual =
      file.path === "SKILL.md"
        ? main
        : read([file.path, "--from", main.ref], file.path, main.snapshot_id)
    const expectedText = content(expected, file.path)
    const actualText = content(actual, file.path)
    return {
      path: file.path,
      matches: actualText === expectedText,
      expected_sha256: hash(expectedText),
      actual_sha256: hash(actualText),
      expected_bytes: Buffer.byteLength(expectedText),
      actual_bytes: Buffer.byteLength(actualText),
    }
  })
  const description = {
    matches: selected.description === packaged.builtin.description,
    expected: packaged.builtin.description,
    actual: selected.description,
  }
  const directory = {
    matches: JSON.stringify(actualPaths) === JSON.stringify(expectedPaths),
    expected_paths: expectedPaths,
    actual_paths: actualPaths,
  }
  return {
    builtin_id: builtin.id,
    package_version: packaged.builtin.package_version,
    package_content_id: packaged.builtin.content_id,
    page_id: selected.locator?.page_id,
    ref: main.ref,
    snapshot_id: main.snapshot_id,
    description,
    directory,
    files,
    ok: description.matches && directory.matches && files.every((file) => file.matches),
  }
}

const report = {
  ok: false,
  cli: values.cli,
  entry: values.library,
  mode: "read-only",
  // Scope describes the checks; only ok:true attests that all comparisons passed.
  proof_scope: {
    consumer_file_bytes: true,
    discovery_description: true,
    generated_notion_pages: false,
    source_ownership: false,
    paired_runtime: false,
    model_delivery: false,
  },
  skills: [],
}
try {
  if (!values.library)
    reject("LIBRARY_CONTEXT_REQUIRED", "Supply one exact registered library with --library.")
  const builtins = command(["ctl", "builtin", "list"])
  if (!Array.isArray(builtins.skills) || builtins.skills.length === 0)
    reject("PACKAGE_CATALOG_INVALID", "The CLI did not expose any packaged Skills.")
  const records = catalog(values.library)
  for (const builtin of builtins.skills) {
    try {
      report.skills.push(verifySkill(builtin, records, values.library))
    } catch (error) {
      report.skills.push({ builtin_id: builtin.id, ok: false, error: failure(error) })
    }
  }
  report.ok = report.skills.every((skill) => skill.ok)
} catch (error) {
  report.error = failure(error)
}
process.stdout.write(JSON.stringify(report, null, 2) + "\n")
process.exitCode = report.ok ? 0 : 1
