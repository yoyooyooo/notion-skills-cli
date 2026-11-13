import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import type { SmokeContext } from "./context.ts"
import { checkAuthoring } from "./authoring.ts"
import { runMaintenancePi } from "./maintenance-pi.ts"

export async function checkInstalledMaintenancePi(consumer: SmokeContext) {
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
        const current = await input.noWrites("pi-source-authoring", [
          "read",
          input.target,
          "--database",
          input.database,
          "--authoring",
          "--read-only",
          "--json",
        ])
        assert.ok(
          current &&
            typeof current === "object" &&
            "content" in current &&
            typeof current.content === "string",
        )
        const directory = await input.directory("requested-input", {
          "SKILL.md":
            current.content.trimEnd() +
            "\n\n[First guide](references/pi-one.md)\n\n[Second guide](references/pi-two.md)\n",
          "references/pi-one.md": "# First guide\n\nComplete first maintenance reference.\n",
          "references/pi-two.md": "# Second guide\n\nComplete second maintenance reference.\n",
        })
        return runMaintenancePi(input, {
          brokerRoot,
          brokerPackage,
          piHost,
          inputDir: directory,
          output: join(scratch, "actual-pi"),
          timeoutMs: 240000,
        })
      },
      { maintenanceOnly: true },
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
