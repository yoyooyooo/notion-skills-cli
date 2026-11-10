import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { fingerprintSkillInput } from "../src/shared-input-fingerprint.ts"

const files = [
  { path: "SKILL.md", sha256: "a".repeat(64), bytes: 20, mode: "100644" as const },
  { path: "scripts/run.sh", sha256: "b".repeat(64), bytes: 30, mode: "100755" as const },
]
const fingerprint = (entries = files, main = "SKILL.md") =>
  Effect.runPromise(
    fingerprintSkillInput({ main, files: entries }).pipe(Effect.provide(NodeServices.layer)),
  )

test("input fingerprint depends on the sorted relative file set, not enumeration order", async () => {
  expect(await fingerprint()).toBe(await fingerprint([...files].reverse()))
  expect(await fingerprint()).toMatch(/^[a-f0-9]{64}$/u)
})

test("content, mode, relative path, entrypoint and file membership each change the input fingerprint", async () => {
  const before = await fingerprint()
  for (const next of [
    [{ ...files[0]!, sha256: "c".repeat(64) }, files[1]!],
    [files[0]!, { ...files[1]!, mode: "100644" as const }],
    [files[0]!, { ...files[1]!, path: "scripts/renamed.sh" }],
    [files[0]!],
  ])
    expect(await fingerprint(next)).not.toBe(before)
  expect(await fingerprint(files, "scripts/run.sh")).not.toBe(before)
})

test("incomplete, duplicate and escaping file manifests cannot acquire an input fingerprint", async () => {
  await expect(fingerprint([files[0]!, files[0]!])).rejects.toThrow()
  await expect(fingerprint([{ ...files[0]!, path: "../SKILL.md" }])).rejects.toThrow()
  await expect(fingerprint([{ ...files[0]!, sha256: "unknown" }])).rejects.toThrow()
  await expect(fingerprint([])).rejects.toThrow()
})
