import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Crypto, Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { property } from "../src/model.ts"
import {
  makeSharedBodyWritePlan,
  validateSharedBodyWritePlan,
} from "../src/shared-body-write-model.ts"
import { projectSharedNotionMarkdown } from "../src/shared-notion-projection.ts"
import { expandSharedOperationPlan, storedSharedOperationPlan } from "../src/shared-plan-storage.ts"
import { SHARED_FACT_ENVELOPE_BYTES } from "../src/shared-record-codec.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const page = "00000000-0000-4000-8000-000000000001"
const paragraph = [
  "Keep [complete evidence](https://example.com/doc?view=source#details) and **every token**.",
  "",
  "| Symbol | Notes |",
  "| --- | --- |",
  "| C++ | Preserve the complete source |",
  "",
  "~~~ts",
  "const value = 42; // retain code",
  "~~~",
  "",
].join("\n")
const body = paragraph.repeat(105)
const run = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const envelopeBytes = (plan: { readonly operation_id: string }) =>
  Buffer.byteLength(
    canonicalSharedJson({ version: 1, operation_id: plan.operation_id, payload: plan }),
  )

function restorePlan(version: 15 | 16 | 17, input = body) {
  const before = "# Previous complete body\n\n" + input
  const projection = projectSharedNotionMarkdown("# Selected complete body\n\n" + input, {
    version,
    purpose: "data_source_create",
  })
  return run(
    makeSharedBodyWritePlan({
      library_id: "library-storage",
      skill_page_id: page,
      skill_id: "skill-storage",
      file_id: "file-main",
      page_id: page,
      path: "SKILL.md",
      source_id: "source-storage",
      source_context: { selected_version: "source-storage", definition: null },
      action: "restore_follow",
      restore_source: {
        source_id: "source-storage",
        revision: "a".repeat(40),
        path: "SKILL.md",
        mode: "100755",
        frontmatter: "---\nlicense: MIT\n---\n",
      },
      before: {
        page_id: page,
        raw_markdown: before,
        markdown: before,
        fingerprint: { normalization_version: 1, sha256: hash(before) },
        bytes: Buffer.byteLength(before),
        downloaded_at: 1,
        mode: "100644",
      },
      candidateMarkdown: projection.markdown,
      input_projection: projection,
      parents: ["adopt-" + hash("previous event")],
    }),
  )
}

for (const version of [15, 16, 17] as const)
  test(
    "compact projection " + version + " preserves complete bytes and the original plan identity",
    async () => {
      const plan = await restorePlan(version)
      expect(envelopeBytes(plan)).toBeGreaterThan(SHARED_FACT_ENVELOPE_BYTES)
      const stored = property(storedSharedOperationPlan(plan))
      expect(stored.storage).toBe("derived-text-v1")
      expect(
        Buffer.byteLength(
          canonicalSharedJson({ version: 1, operation_id: plan.operation_id, payload: stored }),
        ),
      ).toBeLessThanOrEqual(SHARED_FACT_ENVELOPE_BYTES)
      expect(expandSharedOperationPlan(stored)).toEqual(plan)
      expect(await run(validateSharedBodyWritePlan(stored))).toEqual(plan)
      expect(plan.before.raw_markdown).toBe("# Previous complete body\n\n" + body)
      expect(plan.input_projection?.input_markdown).toBe("# Selected complete body\n\n" + body)
      expect(plan.candidate.content.mode).toBe("100755")
      if (plan.candidate.content.kind === "resource") throw new Error("Expected retained Markdown")
      expect(plan.candidate.content.frontmatter).toBe("---\nlicense: MIT\n---\n")
    },
  )

test("compact plans still reject unknown versions, incompatible purposes and changed retained input", async () => {
  const plan = await restorePlan(17)
  const stored = property(storedSharedOperationPlan(plan))
  for (const version of [0, 18]) {
    const changed = structuredClone(stored)
    property(changed.input_projection).version = version
    expect(() => expandSharedOperationPlan(changed)).toThrow()
  }
  const purpose = structuredClone(stored)
  property(purpose.input_projection).purpose = "body_write"
  expect(() => expandSharedOperationPlan(purpose)).toThrow()
  const changed = structuredClone(stored)
  const retained = property(changed.input_projection).input_markdown
  if (typeof retained !== "string") throw new Error("Expected complete retained input")
  property(changed.input_projection).input_markdown = retained + "\nUnapproved extra content."
  await expect(run(validateSharedBodyWritePlan(changed))).rejects.toMatchObject({
    code: "SHARED_BODY_WRITE_INVALID",
  })
})

test("unique retained inputs above 64 KiB still fail before any dispatch", async () => {
  await expect(restorePlan(17, paragraph.repeat(500))).rejects.toMatchObject({
    code: "SHARED_RECORD_TOO_LARGE",
  })
  expect(SHARED_FACT_ENVELOPE_BYTES).toBe(64 * 1024)
})
