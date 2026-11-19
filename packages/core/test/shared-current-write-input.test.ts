import { describe, expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect } from "effect"
import {
  copyValidatedCurrentSkillWrite,
  prepareCurrentSkillWrite,
  type CurrentSkillWriteInput,
} from "../src/shared-current-write-input.ts"

const bytes = (text: string) => new TextEncoder().encode(text)
const input = (files: CurrentSkillWriteInput["files"]): CurrentSkillWriteInput => ({
  skill_id: "input-boundary",
  kind: "skill",
  name: "Input boundary",
  description: "Current input validation",
  files,
})
const run = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const main = { path: "SKILL.md", bytes: bytes("# Main\n") }

describe("current write input boundaries", () => {
  test("the complete input cannot remove a file that its main or a child still references", async () => {
    for (const files of [
      [{ path: "SKILL.md", bytes: bytes("[Guide](references/guide.md)\n") }],
      [main, { path: "references/guide.md", bytes: bytes("[Other](other.md)\n") }],
    ])
      await expect(run(prepareCurrentSkillWrite(input(files)))).rejects.toMatchObject({
        code: "SHARED_REFERENCE_BROKEN",
      })
    const plan = await run(
      prepareCurrentSkillWrite(
        input([
          { path: "SKILL.md", bytes: bytes("[Guide](references/guide.md)\n") },
          { path: "references/guide.md", bytes: bytes("[Main](../SKILL.md)\n") },
        ]),
      ),
    )
    expect(plan.files).toHaveLength(2)
  })

  test("JavaScript callers cannot turn a numeric File ID into a partly applied remote tree", async () => {
    const selected = input([
      main,
      {
        path: "child.md",
        bytes: bytes("# Child\n"),
        authority: { kind: "native" },
        // @ts-expect-error The public runtime boundary also receives untyped JavaScript inputs.
        file_id: 123,
      },
    ])
    await expect(run(prepareCurrentSkillWrite(selected))).rejects.toMatchObject({
      code: "CURRENT_WRITE_INPUT_INVALID",
    })
  })

  test("prepared input revalidates File ID types before trusting its content fingerprint", async () => {
    const plan = await run(prepareCurrentSkillWrite(input([main])))
    const changed = { ...plan, files: plan.files.map((file) => ({ ...file, file_id: 123 })) }
    // @ts-expect-error Reproduce an invalid prepared plan crossing the asynchronous API boundary.
    await expect(run(copyValidatedCurrentSkillWrite(changed))).rejects.toMatchObject({
      code: "CURRENT_WRITE_INPUT_INVALID",
    })
  })

  test("native Content size is checked in UTF-8 bytes during preparation; resource keeps the complete original", async () => {
    for (const header of ["x".repeat(200000), "字".repeat(45000)]) {
      const original = bytes("---\nnote: " + header + "\n---\n# Short body\n")
      const selected = { path: "child.md", bytes: original }
      await expect(
        run(
          prepareCurrentSkillWrite(input([main, { ...selected, authority: { kind: "native" } }])),
        ),
      ).rejects.toMatchObject({
        code: "CURRENT_WRITE_INPUT_INVALID",
        message: expect.stringContaining("Content property"),
      })
      const resource = await run(
        prepareCurrentSkillWrite(input([main, { ...selected, authority: { kind: "resource" } }])),
      )
      const child = resource.files.find((file) => file.path === "child.md")!
      expect(child.kind).toBe("resource")
      expect(child.bytes).toEqual(original)
    }
  })
})
