import { createHash } from "node:crypto"
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import type { SmokeContext } from "./context.ts"

export async function checkBuiltinLifecycle(context: SmokeContext) {
  const { scratch, env, installed, manifest, check, cli, rejected, evidence } = context
  const officialId = "notion/ntn-skills-maintain"
  const officialCatalog = await cli(["ctl", "builtin", "list"])
  const expectedBuiltinIds = ["notion/ntn-skills", officialId, "notion/ntn-skills-sync"]
  check(
    officialCatalog.count === expectedBuiltinIds.length &&
      JSON.stringify(officialCatalog.skills.map((skill: { id: string }) => skill.id).sort()) ===
        JSON.stringify([...expectedBuiltinIds].sort()),
    "Installed package does not expose the complete three-Skill catalog.",
  )
  const builtinDataDir = join(env.XDG_DATA_HOME, "ntn-skills")
  check(
    officialCatalog.data_dir === builtinDataDir &&
      officialCatalog.skills.every(
        (skill: { installation: { state: string; data_dir: string } }) =>
          skill.installation.state === "not_installed" &&
          skill.installation.data_dir === builtinDataDir,
      ),
    "Default built-in catalog omitted central installation and distribution status.",
  )
  const officialRead = await cli(["ctl", "builtin", "read", officialId])
  const officialReference = await cli([
    "ctl",
    "builtin",
    "read",
    officialId,
    "--path",
    "references/operations.md",
  ])
  const officialOutput = join(scratch, "official-maintain")
  const officialExport = await cli([
    "ctl",
    "builtin",
    "export",
    officialId,
    "--output",
    officialOutput,
  ])
  const officialPortable = JSON.parse(
    await readFile(join(officialOutput, ".ntn-skills.json"), "utf8"),
  )
  check(
    officialPortable.version === 2 &&
      officialPortable.kind === "skill" &&
      officialPortable.main === "SKILL.md",
    "Built-in export lost its explicit Skill kind or portable v2 entrypoint.",
  )
  for (const [path, response] of [
    ["SKILL.md", officialRead],
    ["references/operations.md", officialReference],
  ] as const) {
    const source = await readFile(
      join(installed, "skills/notion/ntn-skills-maintain", path),
      "utf8",
    )
    check(
      response.content === source &&
        (await readFile(join(officialOutput, path), "utf8")) === source,
      "Installed built-in bytes differ between CLI, exported Skill and package files.",
    )
  }
  check(
    officialRead.builtin.origin === "builtin" &&
      officialRead.builtin.publisher === "ntn-skills" &&
      officialRead.builtin.package_version === manifest.version,
    "Built-in package provenance is missing.",
  )
  check(
    (await cli(["ctl", "builtin", "export", officialId, "--output", officialOutput])).reused ===
      true,
    "Identical official export was not reused.",
  )
  await writeFile(join(officialOutput, "SKILL.md"), "User customized content\n")
  await rejected(
    ["ctl", "builtin", "export", officialId, "--output", officialOutput],
    "OUTPUT_CONFLICT",
    1,
  )
  check(
    (await readFile(join(officialOutput, "SKILL.md"), "utf8")) === "User customized content\n",
    "Built-in export overwrote local customization.",
  )
  const officialZip = await cli([
    "ctl",
    "builtin",
    "export",
    officialId,
    "--output",
    join(scratch, "official.zip"),
  ])
  await rejected(["ctl", "builtin", "read", "ntn-skills-maintain"], "BUILTIN_NOT_FOUND", 1)
  await rejected(["ctl", "builtin", "publish", officialId, "--target", "Ntn Skills Maintain"])
  await rejected(["read", "ntn-skills-maintain"], "NTN_UNAVAILABLE", 1)
  const officialAgent = join(scratch, "builtin-agent")
  const otherOfficialAgent = join(scratch, "other builtin agent")
  const defaultOfficialAgent = join(env.HOME, ".agents")
  const officialAgentFlags = ["--agent-dir", officialAgent, "--agent-dir", otherOfficialAgent]
  const absentBuiltinStatus = await cli([
    "ctl",
    "builtin",
    "status",
    officialId,
    ...officialAgentFlags,
  ])
  check(
    absentBuiltinStatus.skills[0].installation.state === "not_installed" &&
      absentBuiltinStatus.skills[0].installation.distributions.length === 3,
    "Missing built-in status differs.",
  )
  for (const root of [officialAgent, otherOfficialAgent, defaultOfficialAgent, builtinDataDir])
    check(
      !(await access(root).then(
        () => true,
        () => false,
      )),
      "Read-only built-in status created storage or distribution roots.",
    )
  await rejected(["ctl", "builtin", "update", officialId], "BUILTIN_NOT_INSTALLED", 1)
  const officialInstall = await cli(["ctl", "builtin", "install", officialId])
  const officialInstallPath = officialInstall.installation.path
  check(
    officialInstallPath === join(builtinDataDir, "skills", "ntn-skills-maintain") &&
      officialInstall.installation.data_dir === builtinDataDir,
    "Default built-in install did not use canonical XDG storage.",
  )
  const officialDistribution = await cli([
    "ctl",
    "builtin",
    "install",
    officialId,
    ...officialAgentFlags,
  ])
  check(
    officialDistribution.reused && officialDistribution.installation.distributions.length === 3,
    "Repeated agent targets did not reuse canonical content and register all distributions.",
  )
  for (const agent of [defaultOfficialAgent, officialAgent, otherOfficialAgent]) {
    const path = join(agent, "skills", "ntn-skills-maintain")
    check(
      (await lstat(path)).isSymbolicLink() &&
        (await readlink(path)) === officialInstallPath &&
        (await realpath(path)) === officialInstallPath &&
        officialDistribution.installation.distributions.some(
          (distribution: { agent_dir: string; path: string; state: string }) =>
            distribution.agent_dir === agent &&
            distribution.path === path &&
            distribution.state === "linked",
        ),
      "An agent distribution is not a registered link to canonical storage.",
    )
  }
  const officialReceiptPath = join(officialInstallPath, ".ntn-builtin-install.json")
  const officialReceiptBytes = await readFile(officialReceiptPath)
  const officialReceipt = JSON.parse(officialReceiptBytes.toString("utf8"))
  check(
    officialInstall.installation.state === "current" &&
      officialInstall.installation.reload_required &&
      !officialInstall.reused &&
      officialReceipt.format === "ntn-skills-builtin-install" &&
      officialReceipt.version === 2 &&
      officialReceipt.data_dir === builtinDataDir &&
      officialReceipt.path === officialInstallPath &&
      officialReceipt.content_id === officialRead.builtin.content_id &&
      officialReceipt.files.some((file: { path: string }) => file.path === ".ntn-skills.json"),
    "Built-in installation omitted state or its complete portable receipt.",
  )
  for (const file of officialReceipt.files) {
    const bytes = await readFile(join(officialInstallPath, file.path))
    check(
      bytes.length === file.bytes &&
        createHash("sha256").update(bytes).digest("hex") === file.sha256,
      "Built-in installation bytes differ from their receipt.",
    )
  }
  const additionalBuiltins = []
  for (const [id, directory] of [
    ["notion/ntn-skills", "skills/ntn-skills"],
    ["notion/ntn-skills-sync", "skills/notion/ntn-skills-sync"],
  ] as const) {
    const read = await cli(["ctl", "builtin", "read", id])
    const output = join(scratch, `builtin-export-${read.builtin.name}`)
    const exported = await cli(["ctl", "builtin", "export", id, "--output", output])
    const installation = await cli(["ctl", "builtin", "install", id, "--agent-dir", officialAgent])
    const receiptPath = join(installation.installation.path, ".ntn-builtin-install.json")
    const receiptBytes = await readFile(receiptPath)
    const receipt = JSON.parse(receiptBytes.toString("utf8"))
    check(
      receipt.id === id &&
        receipt.content_id === read.builtin.content_id &&
        installation.installation.state === "current" &&
        !installation.reused,
      "Another built-in identity was installed or its first installation was not current.",
    )
    const files = []
    for (const file of read.files) {
      const response = await cli(["ctl", "builtin", "read", id, "--path", file.path])
      const source = await readFile(join(installed, directory, file.path))
      check(
        Buffer.from(response.content).equals(source) &&
          (await readFile(join(output, file.path))).equals(source) &&
          (await readFile(join(installation.installation.path, file.path))).equals(source),
        "Built-in main/reference bytes differ across package, CLI, export and installed directory.",
      )
      files.push({ path: file.path, sha256: createHash("sha256").update(source).digest("hex") })
    }
    for (const file of receipt.files) {
      const bytes = await readFile(join(installation.installation.path, file.path))
      check(
        bytes.length === file.bytes &&
          createHash("sha256").update(bytes).digest("hex") === file.sha256,
        "Additional built-in installation differs from its complete-file receipt.",
      )
    }
    check(
      (await cli(["ctl", "builtin", "install", id, "--agent-dir", officialAgent])).reused &&
        (await cli(["ctl", "builtin", "update", id, "--agent-dir", officialAgent])).reused &&
        (await readFile(receiptPath)).equals(receiptBytes),
      "Idempotent management changed an additional built-in receipt.",
    )
    additionalBuiltins.push({ id, read, exported, installation, receipt, files })
  }
  check(
    (await cli(["ctl", "builtin", "list", ...officialAgentFlags])).skills.find(
      (skill: { id: string }) => skill.id === officialId,
    )?.installation.state === "current",
    "Built-in list with repeated targets omitted current state.",
  )
  check(
    (await cli(["ctl", "builtin", "status"])).skills.every(
      (skill: { installation: { state: string } }) => skill.installation.state === "current",
    ),
    "All-built-in status omitted its installation.",
  )
  check(
    (await cli(["ctl", "builtin", "install", officialId, ...officialAgentFlags])).reused === true,
    "Repeated built-in installation was not idempotent.",
  )
  check(
    (await cli(["ctl", "builtin", "update", officialId, ...officialAgentFlags])).reused === true &&
      (await cli(["ctl", "builtin", "update", officialId])).installation.distributions.length === 3,
    "An identical built-in update changed its tree.",
  )
  check(
    (await readFile(officialReceiptPath)).equals(officialReceiptBytes),
    "Idempotent management rewrote the receipt.",
  )
  await writeFile(join(officialInstallPath, ".user-local"), "preserved hidden user bytes\n")
  const modifiedBuiltinStatus = await cli(["ctl", "builtin", "status", officialId])
  check(
    modifiedBuiltinStatus.skills[0].installation.state === "modified" &&
      modifiedBuiltinStatus.skills[0].installation.changed_paths.includes(".user-local"),
    "Hidden user additions did not protect the installed tree.",
  )
  for (const operation of ["install", "update"])
    await rejected(["ctl", "builtin", operation, officialId], "BUILTIN_MODIFIED", 1)
  check(
    (await readFile(join(officialInstallPath, ".user-local"), "utf8")) ===
      "preserved hidden user bytes\n",
    "Built-in management overwrote a hidden user file.",
  )
  const copiedEntrypointAgent = join(scratch, "copied-entrypoint-agent")
  const copiedEntrypoint = join(copiedEntrypointAgent, "skills", "ntn-skills", "SKILL.md")
  await mkdir(dirname(copiedEntrypoint), { recursive: true })
  const copiedEntrypointBytes = await readFile(join(installed, "skills/ntn-skills/SKILL.md"))
  await writeFile(copiedEntrypoint, copiedEntrypointBytes)
  for (const operation of ["install", "update"]) {
    await rejected(
      ["ctl", "builtin", operation, "notion/ntn-skills", "--agent-dir", copiedEntrypointAgent],
      "BUILTIN_DISTRIBUTION_CONFLICT",
      1,
    )
    check(
      (await readFile(copiedEntrypoint)).equals(copiedEntrypointBytes) &&
        JSON.stringify((await readdir(dirname(copiedEntrypoint))).sort()) ===
          JSON.stringify(["SKILL.md"]),
      "Managing a copied entrypoint changed or adopted its unregistered bytes.",
    )
  }
  for (const additional of additionalBuiltins) {
    check(
      (await cli(["ctl", "builtin", "status", additional.id, "--agent-dir", officialAgent]))
        .skills[0].installation.state === "current",
      "Refusing a modified builtin changed an adjacent managed Skill.",
    )
  }
  evidence.builtins = {
    catalog: officialCatalog,
    additional_skills: additionalBuiltins,
    read: officialRead,
    reference: officialReference,
    exported: officialExport,
    zip: officialZip,
    customization_preserved: true,
    installation: officialInstall,
    distribution: officialDistribution,
    receipt: officialReceipt,
    modified_status: modifiedBuiltinStatus,
    unregistered_preserved: true,
    copied_entrypoint_preserved: true,
  }
}
