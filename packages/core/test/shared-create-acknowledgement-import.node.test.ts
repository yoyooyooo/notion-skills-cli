import { spawn } from "node:child_process"
import { once } from "node:events"
import { expect, test } from "vitest"

async function freshImport(entry: string, expected: string) {
  const url = new URL("../src/" + entry, import.meta.url).href
  const source = `const module = await import(${JSON.stringify(url)}); if (!( ${JSON.stringify(expected)} in module)) throw Error("Missing public module entry"); console.log("loaded")`
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  child.stdout.setEncoding("utf8").on("data", (data: string) => {
    stdout += data
  })
  child.stderr.setEncoding("utf8").on("data", (data: string) => {
    stderr += data
  })
  const [exit] = await once(child, "close")
  return { exit, stdout, stderr }
}

// A controlled Effect fixture and a preloaded bundle can hide an ESM cycle.
// Each case starts a new native Node process with no loader, build or services.
test.each([
  ["shared-create-restoration.ts", "reviewSharedCreateRestoration"],
  ["shared-create.ts", "executeSharedCreate"],
  ["shared-create-recovery-native-model.ts", "SharedCreateNativeRecoveryReviewSchema"],
  ["shared-create-recovery-native-plan.ts", "nativeMainRecoveryPlan"],
  ["shared-create-recovery-native-authority.ts", "originalNativeMainAllocation"],
  ["shared-create-recovery-native-completion.ts", "readSharedCreateNativeCompletion"],
  ["shared-create-recovery-native.ts", "reviewSharedCreateNativeRecovery"],
  ["shared-inventory-recovery.ts", "reviewInventoryNativeRecovery"],
  ["shared-create-recovery-acknowledgement-model.ts", "SharedNativeAllocationReferenceSchema"],
  ["shared-create-recovery-acknowledgements.ts", "readSharedNativeAllocationProofs"],
  ["shared-create-recovery-known-model.ts", "validateSharedCreateKnownRecoveryReview"],
  ["shared-create-recovery-prefix-model.ts", "SharedCreatePrefixBootstrapSchema"],
  ["shared-create-recovery-proof-model.ts", "SharedCreateRecoveryFileCommitmentSchema"],
  [
    "shared-create-continuation-acknowledged-model.ts",
    "validateSharedCreateAcknowledgedContinuationReview",
  ],
  ["shared-create-recovery-known-completion.ts", "readSharedCreateKnownCompletion"],
  ["shared-create-continuation-acknowledged.ts", "reviewSharedCreateAcknowledgedContinuation"],
  ["shared-create-recovery.ts", "reviewSharedCreateContinuation"],
])(
  "native Node independently initializes %s without a temporal-dead-zone cycle",
  async (entry, expected) => {
    const result = await freshImport(entry, expected)
    expect(result.exit, result.stderr).toBe(0)
    expect(result.stdout).toBe("loaded\n")
    expect(result.stderr).toBe("")
  },
  60_000,
)
