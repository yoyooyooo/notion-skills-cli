import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import type { SmokeContext } from "./context.ts"
import { checkAuthoring, type AuthoringContinuation } from "./authoring.ts"
import {
  messageFromSessionLine,
  oracleProjection,
  parseExactlyOneJsonObject,
  quoteArgv,
  runMaintenancePi,
  toolCallsFrom,
  type VisibleMessage,
} from "./maintenance-pi.ts"

const referencePaths = ["references/pi-one.md", "references/pi-two.md"] as const
const firstHeading = "## First guide\n"
const secondHeading = "## Second guide\n"
export const maintenancePiInitialMain =
  "---\nname: Installed author\ndescription: Independent installed author fixture\n---\n\n# Installed author\n\nKeep this overview while moving both complete guides to references.\n\n" +
  firstHeading +
  "\n" +
  Array.from(
    { length: 18 },
    (_, index) =>
      `First guide rule ${index + 1}: Preserve the complete source paragraph, its order and exact wording. Allocate each new reference only inside the original apply operation.`,
  ).join("\n\n") +
  "\n\n" +
  secondHeading +
  "\n" +
  Array.from(
    { length: 18 },
    (_, index) =>
      `Second guide rule ${index + 1}: Keep original page ownership and acknowledged identities. Read the complete resulting tree before claiming that the maintenance intent finished.`,
  ).join("\n\n") +
  "\n"

/** Prepare local intent only. The legacy branch remains an explicit two-step regression. */
export async function prepareMaintenancePiIntent(
  input: Pick<AuthoringContinuation, "target" | "database" | "noWrites" | "invoke" | "directory">,
  scratch: string,
  mode: "single-apply" | "legacy-preallocated" = "single-apply",
) {
  const current = await input.noWrites("pi-source-authoring", [
    "read",
    input.target,
    "--database",
    input.database,
    "--refresh",
    "--authoring",
    "--read-only",
    "--json",
  ])
  assert.ok(
    current &&
      typeof current === "object" &&
      "content" in current &&
      typeof current.content === "string" &&
      "ref" in current &&
      typeof current.ref === "string" &&
      "snapshot_id" in current &&
      typeof current.snapshot_id === "string" &&
      "file_bindings" in current &&
      Array.isArray(current.file_bindings),
  )
  const paths = current.file_bindings.map((binding: unknown) => {
    assert.ok(binding && typeof binding === "object" && "path" in binding)
    assert.equal(typeof binding.path, "string")
    return binding.path
  })
  for (const path of referencePaths)
    assert.ok(!paths.includes(path), `PI_REFERENCE_ALREADY_ALLOCATED:${path}`)
  const first = current.content.indexOf("\n\n" + firstHeading)
  const second = current.content.indexOf("\n\n" + secondHeading)
  assert.ok(first > 0 && second > first, "PI_SPLIT_SOURCE_SECTIONS_MISSING")
  const files = {
    "SKILL.md":
      current.content.slice(0, first).trimEnd() +
      "\n\n[First guide](references/pi-one.md)\n\n[Second guide](references/pi-two.md)",
    "references/pi-one.md": current.content.slice(first + 2, second).trimEnd(),
    "references/pi-two.md": current.content.slice(second + 2).trimEnd(),
  }
  let legacyResult: unknown
  if (mode === "legacy-preallocated") {
    const baseline = await input.directory("pi-native-reference-baseline", {
      "references/pi-one.md": "# First guide\n\nOriginal first reference.\n",
      "references/pi-two.md": "# Second guide\n\nOriginal second reference.\n",
    })
    legacyResult = await input.invoke("pi-reference-baseline", [
      "apply",
      current.ref,
      "--input",
      baseline,
    ])
    assert.ok(
      legacyResult &&
        typeof legacyResult === "object" &&
        "verified" in legacyResult &&
        legacyResult.verified === true &&
        "status" in legacyResult &&
        legacyResult.status === "applied",
    )
  }
  const sha = (value: string) => createHash("sha256").update(value).digest("hex")
  await writeFile(
    join(scratch, "fixture-stage.json"),
    JSON.stringify(
      {
        scope:
          mode === "single-apply"
            ? "public_installed_cli_single_apply_intent_before_pi"
            : "public_installed_cli_reference_allocation_before_pi",
        mode,
        autonomous_model_action: false,
        preallocated_references: mode === "legacy-preallocated",
        original_ref: current.ref,
        original_snapshot_id: current.snapshot_id,
        original_file_bindings: current.file_bindings,
        original_main: { bytes: Buffer.byteLength(current.content), sha256: sha(current.content) },
        requested_files: Object.entries(files).map(([path, content]) => ({
          path,
          bytes: Buffer.byteLength(content),
          sha256: sha(content),
        })),
        legacy_result: legacyResult ?? null,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  )
  return {
    directory: await input.directory("requested-input", files),
    files,
    originalSnapshot: current.snapshot_id,
    originalBindings: current.file_bindings,
  }
}

export async function checkInstalledMaintenancePi(
  consumer: Pick<
    SmokeContext,
    "scratch" | "runtime" | "executable" | "cli" | "evidence" | "installed" | "run"
  >,
) {
  const selected = {
    brokerRoot: process.env.MNT_VERIFY_BROKER_ROOT,
    brokerPackage: process.env.MNT_VERIFY_BROKER_PACKAGE,
    piHost: process.env.MNT_VERIFY_PI,
  }
  const required = process.env.MNT_VERIFY_PI_REQUIRED === "1"
  if (!required && Object.values(selected).every((value) => value === undefined))
    return {
      status: "not_run",
      reason:
        "Set the explicit pinned Broker and Pi verification inputs; the primary CI lane requires this gate.",
    }
  const absolute = (value: string | undefined, name: string) => {
    assert.ok(value && isAbsolute(value), `${name} must identify an explicit verified input`)
    return value
  }
  const brokerRoot = absolute(selected.brokerRoot, "MNT_VERIFY_BROKER_ROOT")
  const brokerPackage = absolute(selected.brokerPackage, "MNT_VERIFY_BROKER_PACKAGE")
  const piHost = absolute(selected.piHost, "MNT_VERIFY_PI")
  const scratch = join(consumer.scratch, "maintenance-pi")
  await mkdir(scratch, { mode: 0o700 })
  const packageBytes = await readFile(join(brokerPackage, "package.json"))
  assert.equal(JSON.parse(packageBytes.toString()).name, "pi-context-broker")
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
  const inputs = {
    brokerPackage,
    brokerPackageSha256: sha(packageBytes),
    brokerEntrySha256: sha(await readFile(join(brokerPackage, "src/index.ts"))),
    bundledCliSha256: sha(await readFile(join(brokerPackage, "dist/ntn-skills.mjs"))),
    cliSha256: sha(await readFile(consumer.executable)),
    piHost,
  }
  await writeFile(join(scratch, "inputs.json"), JSON.stringify(inputs, null, 2) + "\n", {
    mode: 0o600,
  })
  let report: unknown
  try {
    report = await checkAuthoring(
      { ...consumer, scratch },
      async (input) => {
        const prepared = await prepareMaintenancePiIntent(input, scratch)
        const before = oracleProjection(input.observe(), input.target)
        for (const path of referencePaths) assert.ok(!before.directoryPaths.includes(path))
        const result = await runMaintenancePi(input, {
          brokerRoot,
          brokerPackage,
          piHost,
          inputDir: prepared.directory,
          output: join(scratch, "actual-pi"),
          timeoutMs: 240000,
        })
        const after = input.observe()
        const projected = oracleProjection(after, input.target)
        const expectedMain = prepared.files["SKILL.md"]
        const metadata = /^---\n[^]*?\n---\n\n/u.exec(expectedMain)?.[0]
        assert.ok(metadata, "The authored main retains its original metadata")
        assert.equal(projected.body, expectedMain.slice(metadata.length))
        const current = await input.noWrites("pi-final-authoring", [
          "read",
          input.target,
          "--database",
          input.database,
          "--refresh",
          "--authoring",
          "--read-only",
          "--json",
        ])
        assert.ok(
          current &&
            typeof current === "object" &&
            "content" in current &&
            current.content === expectedMain + "\n" &&
            "file_bindings" in current &&
            Array.isArray(current.file_bindings),
        )
        const finalBindings: unknown[] = current.file_bindings
        assert.equal(finalBindings.length, prepared.originalBindings.length + 2)
        const originalPages = new Set(
          prepared.originalBindings.map((binding: { page_id: string }) => binding.page_id),
        )
        const originalFiles = new Set(
          prepared.originalBindings.map((binding: { file_id: string }) => binding.file_id),
        )
        const newReferences = referencePaths.map((path) => {
          const matches = finalBindings.filter(
            (binding: unknown) =>
              binding && typeof binding === "object" && "path" in binding && binding.path === path,
          )
          assert.equal(matches.length, 1)
          const binding = matches[0]
          assert.ok(
            binding &&
              typeof binding === "object" &&
              "page_id" in binding &&
              typeof binding.page_id === "string" &&
              "file_id" in binding &&
              typeof binding.file_id === "string",
          )
          assert.ok(!originalPages.has(binding.page_id))
          assert.ok(!originalFiles.has(binding.file_id))
          const body = after.bodies.find(([page]) => page === binding.page_id)?.[1]
          assert.equal(typeof body, "string")
          assert.ok(body !== undefined)
          assert.equal(body, prepared.files[path], `${path}: complete original section`)
          return { ...binding, bytes: Buffer.byteLength(body), sha256: sha(Buffer.from(body)) }
        })
        assert.equal(new Set(newReferences.map((binding) => binding.page_id)).size, 2)
        assert.equal(new Set(newReferences.map((binding) => binding.file_id)).size, 2)
        const oldFiles = await input.noWrites("pi-original-tree", [
          "files",
          prepared.originalSnapshot,
          "--offline",
        ])
        assert.ok(
          oldFiles &&
            typeof oldFiles === "object" &&
            "files" in oldFiles &&
            Array.isArray(oldFiles.files),
        )
        for (const path of referencePaths)
          assert.ok(!oldFiles.files.some((file: { path: string }) => file.path === path))
        assert.equal(oldFiles.files.length, prepared.originalBindings.length)
        assert.equal(typeof result.operation_id, "string")
        assert.ok(Array.isArray(result.sessions))
        const nativeMessages: VisibleMessage[] = []
        const nativeSessions: { path: string; sha256: string }[] = []
        for (const session of result.sessions) {
          assert.equal(typeof session.path, "string")
          const bytes = await readFile(session.path)
          assert.equal(sha(bytes), session.sha256)
          nativeSessions.push({ path: session.path, sha256: sha(bytes) })
          for (const line of bytes.toString("utf8").split("\n")) {
            if (!line.trim()) continue
            const message = messageFromSessionLine(JSON.parse(line))
            if (message) nativeMessages.push(message)
          }
        }
        const nativeCalls = toolCallsFrom(nativeMessages)
        const applyCalls = nativeCalls.filter((call) => {
          const command = call.arguments?.command
          return (
            call.name === "bash" &&
            typeof command === "string" &&
            /(?:^|\s)'apply'(?:\s|$)/u.test(command) &&
            !command.includes("'--dry-run'")
          )
        })
        assert.equal(applyCalls.length, 1)
        assert.equal(applyCalls[0]?.id, "mnt-apply")
        const authoringText = nativeCalls.find(
          (call) => call.id === "mnt-authoring-read",
        )?.resultText
        assert.equal(typeof authoringText, "string")
        assert.ok(authoringText)
        const authoring = parseExactlyOneJsonObject(authoringText)
        assert.equal(typeof authoring.ref, "string")
        assert.ok(typeof authoring.ref === "string")
        assert.equal(
          applyCalls[0]?.arguments?.command,
          quoteArgv([
            input.context.runtime,
            input.context.executable,
            "apply",
            authoring.ref,
            "--input",
            prepared.directory,
          ]),
        )
        await writeFile(
          join(scratch, "single-apply-proof.json"),
          JSON.stringify(
            {
              status: "passed",
              preallocated_references: false,
              operation_id: result.operation_id,
              actual_apply_count: applyCalls.length,
              actual_apply_command: applyCalls[0]?.arguments?.command,
              native_sessions: nativeSessions,
              source_sections_complete: true,
              main_native_links_verified: true,
              new_references: newReferences,
              old_tree_file_count: oldFiles.files.length,
              new_tree_file_count: finalBindings.length,
              boundaries: {
                controlled_http: true,
                real_pi: true,
                real_notion: false,
                real_model: false,
              },
            },
            null,
            2,
          ) + "\n",
          { mode: 0o600, flag: "wx" },
        )
        return result
      },
      { maintenanceOnly: true, maintenanceMain: maintenancePiInitialMain },
    )
    return { status: "passed", inputs, report, evidence: scratch }
  } finally {
    await writeFile(
      join(scratch, "terminal.json"),
      JSON.stringify(
        { status: report ? "passed" : "failed", inputs, report: report ?? null, evidence: scratch },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    )
  }
}
