import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHttpProbe } from "./http-probe.ts"
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { portableZip, MANIFEST } from "../../core/src/portable.ts"
import { reviewSharedMigrationConversion } from "../../core/src/shared-migration-conversion.ts"
import { reviewSharedMigration } from "../../core/src/shared-migration-review.ts"
import type { SharedMigrationInput } from "../../core/src/shared-migration-plan.ts"
import { sharedCreateFixture } from "../../core/test/shared-create-fixture.ts"
import { migrationConversionFixture } from "../../core/test/shared-migration-conversion-fixture.ts"
import { legacyCommittedPublicationFixture } from "../../core/test/shared-migration-legacy-publication-fixture.ts"
import {
  readMigrationJson,
  readMigrationRetained,
} from "../src/commands-library-migration-input.ts"

const main = new URL("../dist/ntn-skills.js", import.meta.url).pathname
const http = createHttpProbe()
afterAll(() => http.close())
const node = (() => {
  const executable = Bun.which("node")
  if (!executable) throw new Error("Production migration-command tests require Node.js.")
  return executable
})()

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: new URL("../../../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ])
  if (exit !== 0) throw new Error(`Production CLI build failed: ${stdout}\n${stderr}`)
}, 120_000)

// Retain each controlled filesystem root for review; no permanent cleanup.
const directory = () => mkdtemp(join(tmpdir(), "ntn-library-migration-cli-"))
async function invoke(root: string, args: string[]) {
  const requestsBefore = http.calls()
  const child = Bun.spawn([node, main, "ctl", "library", "migration", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      NOTION_API_TOKEN: "controlled-offline-probe-token",
      NOTION_WORKSPACE_ID: "",
      NOTION_API_BASE_URL: http.origin,
      HOME: join(root, "home"),
      NTN_SKILLS_DATA_HOME: "",
      NTN_SKILLS_HOME: join(root, "state"),
      NTN_SKILLS_CONFIG_HOME: join(root, "config"),
      NTN_SKILLS_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
    },
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const online = http.calls() !== requestsBefore
  return { stdout, stderr, exit, online }
}
function failed(result: Awaited<ReturnType<typeof invoke>>, code: string) {
  expect(result.exit).not.toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code } })
  expect(result.online).toBe(false)
}

test("production migration help exposes exact review, approval and read-only recovery boundaries offline", async () => {
  const root = await directory()
  for (const [args, flags] of [
    [["--help"], ["plan", "review", "apply", "reconcile", "recovery"]],
    [
      ["review", "--help"],
      ["--input", "--legacy-id", "--entry", "--files", "--preimages", "--source-files"],
    ],
    [
      ["apply", "--help"],
      ["--input", "--review", "--review-id", "--dry-run"],
    ],
    [
      ["reconcile", "--help"],
      ["--entry", "--operation", "--target"],
    ],
    [
      ["recovery", "--help"],
      ["review", "apply", "reconcile", "continuation"],
    ],
    [
      ["recovery", "continuation", "review", "--help"],
      ["--entry", "--operation", "--target", "terminal"],
    ],
    [
      ["recovery", "continuation", "apply", "--help"],
      ["--input", "--review", "--review-id", "--dry-run"],
    ],
    [
      ["recovery", "review", "--help"],
      ["--entry", "--operation", "--target", "post_failure_current_read"],
    ],
    [
      ["recovery", "apply", "--help"],
      ["--input", "--review", "--review-id", "--dry-run"],
    ],
    [
      ["recovery", "reconcile", "--help"],
      ["--entry", "--operation", "--target", "zero POST/PATCH"],
    ],
  ] satisfies Array<[string[], string[]]>) {
    const result = await invoke(root, args)
    expect(result.exit, result.stdout + result.stderr).toBe(0)
    expect(result.stderr).toBe("")
    for (const flag of flags) expect(result.stdout).toContain(flag)
    expect(result.online).toBe(false)
  }
  failed(
    await invoke(root, ["apply", "--input", "missing", "--review", "missing"]),
    "INVALID_ARGUMENT",
  )
  failed(
    await invoke(root, ["reconcile", "--entry", "missing", "--operation", "original", "--resume"]),
    "INVALID_ARGUMENT",
  )
  failed(
    await invoke(root, ["recovery", "apply", "--input", "missing", "--review", "missing"]),
    "INVALID_ARGUMENT",
  )
  failed(
    await invoke(root, ["recovery", "review", "--entry", "missing", "--operation", "original"]),
    "INVALID_ARGUMENT",
  )
  failed(
    await invoke(root, [
      "recovery",
      "reconcile",
      "--entry",
      "missing",
      "--operation",
      "original",
      "--target",
      "not-a-page",
    ]),
    "INVALID_ARGUMENT",
  )
  failed(
    await invoke(root, [
      "reconcile",
      "--entry",
      "missing",
      "--operation",
      `skill-create-${"0".repeat(64)}`,
      "--target",
      "not-a-page",
    ]),
    "INVALID_ARGUMENT",
  )
})

test("public plan retains empty approval and invalid review or UTF-8 cannot contact Notion", async () => {
  const root = await directory(),
    fixture = migrationConversionFixture({ main: "Retained main" })
  const input = join(root, "frozen.json"),
    review = join(root, "review.json"),
    bad = join(root, "invalid-utf8.json")
  const frozen = { ...fixture.migrationInput, approved_legacy_ids: [] }
  const original = JSON.stringify(frozen, null, 2) + "\n"
  await writeFile(input, original)
  const planned = await invoke(root, ["plan", "--input", input])
  expect(planned.exit, planned.stdout + planned.stderr).toBe(0)
  expect(JSON.parse(planned.stdout)).toMatchObject({
    ok: true,
    apply_allowed: false,
    evidence: { approved_legacy_ids: [] },
  })
  expect(planned.online).toBe(false)
  expect(await readFile(input, "utf8")).toBe(original)
  await writeFile(review, "{}\n")
  failed(
    await invoke(root, [
      "recovery",
      "apply",
      "--input",
      input,
      "--review",
      review,
      "--review-id",
      `create-recovery-${"0".repeat(64)}`,
    ]),
    "SHARED_CREATE_RECOVERY_INVALID",
  )
  failed(
    await invoke(root, [
      "apply",
      "--input",
      input,
      "--review",
      review,
      "--review-id",
      `migration-review-${"0".repeat(64)}`,
    ]),
    "SHARED_MIGRATION_REVIEW_INVALID",
  )
  await writeFile(bad, new Uint8Array([0xff, 0xfe]))
  failed(
    await invoke(root, [
      "apply",
      "--input",
      input,
      "--review",
      bad,
      "--review-id",
      `migration-review-${"0".repeat(64)}`,
    ]),
    "MIGRATION_INPUT_INVALID_UTF8",
  )
})

test("production apply checks the independently supplied review digest before any target access", async () => {
  const root = await directory(),
    f = sharedCreateFixture(),
    fixture = migrationConversionFixture({ main: "Retained main" })
  const frozen = { ...fixture.migrationInput, approved_legacy_ids: [] }
  const review = await f.run(reviewSharedMigration({ ...fixture.input, migration_input: frozen }))
  const inputPath = join(root, "approved.json"),
    reviewPath = join(root, "review.json")
  await writeFile(inputPath, JSON.stringify(fixture.migrationInput))
  await writeFile(reviewPath, JSON.stringify({ ok: true, review_id: review.review_id, review }))
  failed(
    await invoke(root, [
      "apply",
      "--input",
      inputPath,
      "--review",
      reviewPath,
      "--review-id",
      `migration-review-${"0".repeat(64)}`,
    ]),
    "SHARED_MIGRATION_REVIEW_CHANGED",
  )
  expect(f.writes()).toHaveLength(0)
})

test("the public retained-input loader selects the proved as-of policy before checking unresolved legacy history", async () => {
  const root = await directory(),
    original = await legacyCommittedPublicationFixture(),
    base = migrationConversionFixture(),
    f = sharedCreateFixture()
  const entry = original.derived.entry,
    files = join(root, "native"),
    preimages = join(root, "preimages"),
    sourceFiles = join(root, "source")
  if (original.snapshot.record.locator.type !== "notion_page")
    throw new Error("The retained publication fixture must identify its original Notion page")
  const originalPage = original.snapshot.record.locator.page_id
  await Promise.all([files, preimages, sourceFiles].map((path) => mkdir(path)))
  for (const file of original.native_files) {
    await mkdir(dirname(join(files, file.path)), { recursive: true })
    await writeFile(join(files, file.path), file.bytes)
  }
  for (const raw of original.proof.native_preimages)
    await writeFile(
      join(preimages, `${raw.page_id}.${raw.markdown_version}.json`),
      raw.response_json,
    )
  for (const file of original.source_files) {
    await mkdir(dirname(join(sourceFiles, file.path)), { recursive: true })
    await writeFile(join(sourceFiles, file.path), file.bytes)
  }
  const frozen: SharedMigrationInput = {
    ...base.migrationInput,
    scope: original.derived.scope,
    approved_legacy_ids: [],
    catalog: {
      coverage: { ...base.migrationInput.catalog.coverage, exhaustive: false },
      entries: [entry],
    },
    preservation: {
      ...base.migrationInput.preservation,
      sources: { complete: false, items: [original.derived.source] },
      operations: {
        complete: false,
        items: [
          {
            legacy_id: "retained-unknown-operation",
            raw: { state: "unknown", page_id: originalPage },
            complete: false,
            references: [],
            retention_ref: "retained:original-operation",
            retention_verified: true,
            terminal_verified: false,
          },
        ],
      },
    },
  }
  const before = structuredClone(frozen)
  const loaded = await Effect.runPromise(
    readMigrationRetained({
      migrationInput: frozen,
      legacyId: entry.legacy_id,
      library: base.input.library,
      files,
      preimages,
      sourceFiles,
    }).pipe(Effect.provide(NodeServices.layer)),
  )
  expect(loaded.input.execution_policy).toBe("copy_to_new_native_v2")
  const review = await f.run(reviewSharedMigration(loaded.input))
  expect(review.origin.candidate.execution_policy).toBe("copy_to_new_native_v2")
  expect(review.origin.candidate.files).toHaveLength(2)
  expect(review.retained_operations).toEqual(frozen.preservation.operations)
  expect(review.retained_catalog_coverage).toEqual(frozen.catalog.coverage)
  expect(review.originally_approved_legacy_ids).toEqual([])
  expect(frozen).toEqual(before)
  expect(f.writes()).toHaveLength(0)
  expect(f.pending()).toHaveLength(0)
})

test("the public retained-input loader preserves exact files, raw response bytes and the full Source tree", async () => {
  const root = await directory(),
    fixture = migrationConversionFixture({ main: "Retained main", following: true })
  const files = join(root, "files"),
    preimages = join(root, "preimages"),
    sourceFiles = join(root, "source")
  await Promise.all([files, preimages, sourceFiles].map((path) => mkdir(path)))
  for (const file of fixture.input.files) {
    const original = fixture.entry.files.find((item) => item.legacy_id === file.legacy_id)
    if (!original) throw new Error("Missing controlled legacy file")
    await mkdir(dirname(join(files, original.path)), { recursive: true })
    await writeFile(join(files, original.path), file.bytes)
    await writeFile(
      join(
        preimages,
        `${file.native_preimage.page_id}.${file.native_preimage.markdown_version}.json`,
      ),
      file.native_preimage.response_json,
    )
  }
  for (const file of fixture.input.source_files ?? []) {
    await mkdir(dirname(join(sourceFiles, file.path)), { recursive: true })
    await writeFile(join(sourceFiles, file.path), file.bytes)
  }
  await writeFile(join(files, "ntn-skills.manifest.json"), '{"retained":"unselected"}\n')
  const frozen = { ...fixture.migrationInput, approved_legacy_ids: [] },
    original = structuredClone(frozen)
  const args = {
    migrationInput: frozen,
    legacyId: fixture.entry.legacy_id,
    library: fixture.input.library,
    files,
    preimages,
    sourceFiles,
  }
  const loaded = await Effect.runPromise(
    readMigrationRetained(args).pipe(Effect.provide(NodeServices.layer)),
  )
  expect(loaded.unselected_input_paths).toEqual(["ntn-skills.manifest.json"])
  expect(loaded.unselected_source_input_paths).toEqual([])
  expect(fixture.input.files).toEqual(loaded.input.files)
  const sourceBytes = (items: typeof fixture.input.source_files) =>
    items
      ?.map(({ path, bytes }) => ({ path, bytes }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  expect(sourceBytes(loaded.input.source_files)).toEqual(sourceBytes(fixture.input.source_files))
  const candidate = await Effect.runPromise(
    reviewSharedMigrationConversion(loaded.input).pipe(Effect.provide(NodeServices.layer)),
  )
  expect(candidate.files).toHaveLength(2)
  expect(candidate.source_files).toHaveLength(3)
  expect(candidate.source_files.find((file) => file.path === "assets/original.bin")?.base64).toBe(
    "AP8B",
  )
  expect(frozen).toEqual(original)

  const sourceZip = join(root, "retained-source.zip")
  await writeFile(
    sourceZip,
    portableZip({
      kind: "skill",
      name: "Preserved Source container",
      description: "Container metadata does not replace Source bytes",
      main: "SKILL.md",
      files: fixture.input.source_files ?? [],
    }),
  )
  const zipped = await Effect.runPromise(
    readMigrationRetained({ ...args, sourceFiles: sourceZip }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  )
  expect(zipped.unselected_source_input_paths).toEqual([MANIFEST])
  expect(zipped.input.source_files).toEqual(loaded.input.source_files)
  expect(
    await Effect.runPromise(
      reviewSharedMigrationConversion(zipped.input).pipe(Effect.provide(NodeServices.layer)),
    ),
  ).toEqual(candidate)

  const first = fixture.input.files[0]
  if (!first) throw new Error("Missing controlled native response")
  const rawPath = join(
    preimages,
    `${first.native_preimage.page_id}.${first.native_preimage.markdown_version}.json`,
  )
  await writeFile(rawPath, first.native_preimage.response_json + "\n")
  const changed = await Effect.runPromise(
    readMigrationRetained(args).pipe(Effect.provide(NodeServices.layer)),
  )
  const rejected = await Effect.runPromise(
    Effect.flip(reviewSharedMigrationConversion(changed.input)).pipe(
      Effect.provide(NodeServices.layer),
    ),
  )
  expect(rejected.code).toBe("SHARED_MIGRATION_CONVERSION_PREIMAGE")
  const badJson = join(root, "bad.json")
  await writeFile(badJson, "not JSON")
  expect(
    (
      await Effect.runPromise(
        Effect.flip(readMigrationJson(badJson)).pipe(Effect.provide(NodeServices.layer)),
      )
    ).code,
  ).toBe("MIGRATION_INPUT_INVALID_JSON")
})
