import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const workflow = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")
const runner = readFileSync(new URL("../../../scripts/package-smoke.ts", import.meta.url), "utf8")
const packageCheck = readFileSync(
  new URL("../../../scripts/package-check.ts", import.meta.url),
  "utf8",
)
function verify(text: string, entry: string, distribution: string) {
  const begin = text.indexOf("      - name: Prepare pinned Pi maintenance gate")
  const end = text.indexOf("      - name: Pack and test a fresh consumer", begin)
  if (begin < 0 || end <= begin) throw new Error("MNT_CI_HOST_PREPARATION_MISSING")
  const host = text.slice(begin, end)
  const consumer = text.slice(
    end,
    text.indexOf("      - name: Upload consumer verification evidence", end),
  )
  const artifact = text.slice(text.indexOf("      - name: Upload consumer verification evidence"))
  const required = [
    "if: matrix.os == 'ubuntu-latest' && matrix.node == '24.20.0'",
    "checkout --detach d8bef63eb486bde0b6abcf8c3f3d0efd712f33a9",
    'NTN_SKILLS_BUILD_ENTRY="$GITHUB_WORKSPACE/packages/cli/dist/ntn-skills.js"',
    "bun scripts/pack.mjs --target broker",
    "npm install --prefix",
    "@earendil-works/pi-coding-agent@1.5.0",
    "MNT_VERIFY_PI_REQUIRED=1",
    "MNT_VERIFY_BROKER_PACKAGE=",
    "MNT_VERIFY_PI=",
  ]
  if (
    required.some((value) => !host.includes(value)) ||
    /continue-on-error|\|\|\s*true/u.test(host + consumer)
  )
    throw new Error("MNT_CI_GATE_WEAKENED")
  if (!consumer.includes("bun scripts/package-check.ts") || consumer.includes("if:"))
    throw new Error("MNT_CI_INSTALLED_GATE_MISSING")
  if (
    !artifact.includes("if: always()") ||
    !artifact.includes("**/maintenance-pi/**") ||
    !artifact.includes("**/controlled-authoring/**")
  )
    throw new Error("MNT_CI_ORIGINALS_NOT_RETAINED")
  if (
    !entry.includes("await checkInstalledMaintenancePi(consumer)") ||
    !entry.includes("maintenance_pi: maintenancePi") ||
    !distribution.includes('join(root, "scripts/package-smoke.ts")')
  )
    throw new Error("MNT_CI_ENTRY_DISCONNECTED")
}

test("the primary installed package lane requires real Pi, candidate SDK and retained failed originals", () => {
  expect(() => verify(workflow, runner, packageCheck)).not.toThrow()
})
test("missing, softened or disconnected maintenance gates fail the independent workflow contract", () => {
  for (const change of [
    (text: string) => text.replace("MNT_VERIFY_PI_REQUIRED=1", "MNT_VERIFY_PI_REQUIRED=0"),
    (text: string) =>
      text.replace(
        "@earendil-works/pi-coding-agent@1.5.0",
        "@earendil-works/pi-coding-agent@latest",
      ),
    (text: string) => text.replace("--target broker", "--target other"),
    (text: string) =>
      text.replace(
        "      - name: Pack and test a fresh consumer",
        "      - name: Pack and test a fresh consumer\n        continue-on-error: true",
      ),
    (text: string) => text.replace("**/maintenance-pi/**", "**/unrelated/**"),
    (text: string) => text.replace("NTN_SKILLS_BUILD_ENTRY", "UNUSED_CLI_ENTRY"),
  ])
    expect(() => verify(change(workflow), runner, packageCheck)).toThrow()
  expect(() =>
    verify(
      workflow,
      runner.replace("await checkInstalledMaintenancePi(consumer)", "undefined"),
      packageCheck,
    ),
  ).toThrow()
})
