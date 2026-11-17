import { expect, test } from "bun:test"
import { Effect } from "effect"
import captured from "./fixtures/to-prd-restore-readback.json"
import { makeSourceBinding } from "../src/shared-source-binding.ts"
import { resolveFileState } from "../src/shared-file-state.ts"
import { projectSharedNotionMarkdown } from "../src/shared-notion-projection.ts"
import {
  prepareSharedBodyWrite,
  executeSharedBodyWrite,
  reconcileSharedBodyWrite,
  validateSharedBodyWritePlan,
} from "../src/shared-body-write.ts"
import { makeSharedBodyWritePlan } from "../src/shared-body-write-model.ts"
import { storedSharedOperationPlan, expandSharedOperationPlan } from "../src/shared-plan-storage.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  client,
  remote,
  seed,
  library,
  skillPage,
  fileId,
  hash,
  patches,
  creates,
  eventRows,
  payloadFor,
} from "./shared-body-write-review-fixture.ts"

const accepted = { version: 1 as const, policy: "notion_import_readback_v1" as const }
const customMetadata = { mode: "100644" as const, frontmatter: "---\nlicense: Local\n---\n" }
const sourceMetadata = { mode: "100755" as const, frontmatter: "---\nlicense: MIT\n---\n" }

const envelopeBytes = (operation_id: string, payload: unknown) =>
  new TextEncoder().encode(canonicalSharedJson({ version: 1, operation_id, payload })).length

async function prepared(source = captured.source, observed = captured.observed) {
  const shared = remote(observed, customMetadata),
    api = client(shared)
  const fixed = await api.run(
    makeSourceBinding({
      url: "https://github.com/example/immutable-source",
      commit: "c".repeat(40),
      tree: "d".repeat(40),
      root: "",
      files: [
        {
          path: "SKILL.md",
          source_path: "SKILL.md",
          git_oid: "e".repeat(40),
          bytes: new TextEncoder().encode(source).length,
        },
      ],
    }),
  )
  seed(shared, "source", fixed.source_id, `register-${fixed.source_id}`, fixed.source_id, fixed)
  shared.source = fixed.source_id
  const projection = projectSharedNotionMarkdown(source, { purpose: "data_source_create" })
  const input = {
    library,
    skillPageId: skillPage,
    fileId,
    action: "restore_follow" as const,
    candidateMarkdown: projection.markdown,
    inputProjection: projection,
    authoredInputSha256: hash(source),
    acceptEquivalentReadback: true,
    source: {
      source_id: fixed.source_id,
      revision: fixed.commit,
      path: "SKILL.md",
      ...sourceMetadata,
    },
    expected: { heads: ["initial-custom"], body_sha256: hash(observed) },
  }
  const plan = await api.run(prepareSharedBodyWrite(input))
  api.calls.length = 0
  return { shared, api, fixed, plan, input }
}

test("the captured to-prd readback restores following with zero body PATCH and exact retained metadata", async () => {
  const x = await prepared(),
    { shared, api, plan } = x
  expect(new TextEncoder().encode(captured.candidate).length).toBe(2829)
  expect(new TextEncoder().encode(captured.observed).length).toBe(2842)
  expect(plan.input_projection?.version).toBe(15)
  expect(plan.input_projection?.markdown).toBe(captured.candidate)
  expect(plan.authored_input_sha256).toBe(hash(captured.source))
  expect(plan.restore_readback).toEqual(accepted)
  expect(plan.candidate.markdown).toBe(captured.observed)
  expect(plan.candidate.content.sha256).toBe(plan.before.fingerprint.sha256)
  expect(await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }))).toMatchObject({
    status: "applied",
    verified: true,
  })
  expect(patches(api)).toHaveLength(0)
  expect(shared.markdown).toBe(captured.observed)
  expect(resolveFileState(fileId, eventRows(shared)).ownership).toEqual({
    kind: "following",
    source_revision: x.fixed.commit,
    projection: { normalization_version: 1, sha256: hash(captured.observed) },
    ...sourceMetadata,
  })
  expect(plan.event).toMatchObject({
    kind: "following_restored",
    retained: { sha256: hash(captured.observed), ...customMetadata },
  })
  expect(payloadFor(shared, `body-${hash(captured.observed)}`)).toMatchObject({
    markdown: captured.observed,
  })
  shared.local.clear()
  const cold = client(shared)
  expect(await cold.run(reconcileSharedBodyWrite(library, plan))).toMatchObject({
    status: "applied",
    verified: true,
  })
  expect(patches(cold)).toHaveLength(0)
  expect(creates(cold)).toHaveLength(0)
})

test.each([
  ["text", "# Rules\n\nKeep every record.\n", "# Rules\n\nDelete every record."],
  [
    "code",
    "# Rules\n\n```py\nif ready:\n    safe()\n```\n",
    "# Rules\n\n```python\nif ready:\nsafe()\n```",
  ],
  [
    "links",
    "# Rules\n\nRead [guide](https://example.test/a).\n",
    "# Rules\n\nRead [guide](https://example.test/b).",
  ],
])(
  "changed %s stays on strict restore and cannot be disguised as no-body acceptance",
  async (component, source, observed) => {
    const { api, plan } = await prepared(source, observed)
    expect(plan.restore_readback).toBeUndefined()
    expect(plan.candidate.content.sha256).not.toBe(plan.before.fingerprint.sha256)
    const forged = await api.run(
      Effect.flip(
        makeSharedBodyWritePlan({
          ...plan,
          candidateMarkdown: plan.before.markdown,
          parents: plan.event.parents,
          restore_readback: accepted,
        }),
      ),
    )
    expect(forged).toMatchObject({ code: "SHARED_CREATE_BODY_MISMATCH", details: { component } })
    expect(patches(api)).toHaveLength(0)
    expect(creates(api)).toHaveLength(0)
  },
)

test.each(["body", "heads", "source"] as const)(
  "equivalent restore refuses stale %s before any write",
  async (changed) => {
    const x = await prepared(),
      { shared, plan } = x
    if (changed === "body") shared.markdown += "\nA later user edit."
    if (changed === "source") shared.source = ""
    if (changed === "heads") {
      const event = {
        ...shared.initial,
        event_id: "concurrent-custom",
        parents: [shared.initial.event_id],
      }
      seed(shared, "file_event", event.event_id, event.event_id, fileId, event)
    }
    const api = client(shared)
    expect(
      await api.run(Effect.flip(executeSharedBodyWrite(library, { plan, mode: "create" }))),
    ).toMatchObject({ code: "SHARED_BODY_WRITE_STALE" })
    expect(patches(api)).toHaveLength(0)
    expect(creates(api)).toHaveLength(0)
  },
)

test("a body change after plan retention prevents a no-body following event", async () => {
  const x = await prepared(),
    { shared, plan } = x
  const api = client(shared, {
    afterRecord: (_kind, record) => {
      if (record === plan.operation_id) shared.markdown += "\nChanged after preparation."
    },
  })
  expect(
    await api.run(Effect.flip(executeSharedBodyWrite(library, { plan, mode: "create" }))),
  ).toMatchObject({ code: "SHARED_BODY_WRITE_STALE" })
  expect(patches(api)).toHaveLength(0)
  expect(eventRows(shared)).toEqual([shared.initial])
  expect(shared.markdown).toContain("Changed after preparation.")
})

test("the acceptance is hashed, cannot enter ordinary writes, and leaves old projected plans valid", async () => {
  const x = await prepared(),
    { api, plan } = x
  const { restore_readback: _acceptance, ...changed } = plan
  expect(await api.run(Effect.flip(validateSharedBodyWritePlan(changed)))).toMatchObject({
    code: "SHARED_BODY_WRITE_INVALID",
  })
  expect(
    await api.run(
      Effect.flip(prepareSharedBodyWrite({ ...x.input, action: "write", source: undefined })),
    ),
  ).toMatchObject({ code: "INVALID_ARGUMENT" })
  const original = await api.run(
    prepareSharedBodyWrite({ ...x.input, acceptEquivalentReadback: false }),
  )
  expect(original.restore_readback).toBeUndefined()
  expect(original.candidate.markdown).toBe(captured.candidate)
  expect((await api.run(validateSharedBodyWritePlan(original))).operation_id).toBe(
    original.operation_id,
  )
  expect(original.operation_id).not.toBe(plan.operation_id)
})

test("large equivalent restores retain their exact source and current body in derived-text-v1", async () => {
  const source = Array.from({ length: 6 }, () => captured.source).join("\n\n")
  const observed = Array.from({ length: 6 }, () => captured.observed).join("\n\n")
  const x = await prepared(source, observed),
    { api, plan, shared } = x
  expect(plan.restore_readback).toEqual(accepted)
  expect(envelopeBytes(plan.operation_id, plan)).toBeGreaterThan(64 * 1024)
  const stored = storedSharedOperationPlan(plan)
  expect(stored).toMatchObject({ storage: "derived-text-v1", restore_readback: accepted })
  expect(envelopeBytes(plan.operation_id, stored)).toBeLessThanOrEqual(64 * 1024)
  expect(canonicalSharedJson(expandSharedOperationPlan(stored))).toBe(canonicalSharedJson(plan))
  expect((await api.run(validateSharedBodyWritePlan(stored))).operation_id).toBe(plan.operation_id)

  const strict = await api.run(
    prepareSharedBodyWrite({ ...x.input, acceptEquivalentReadback: false }),
  )
  const strictStored = storedSharedOperationPlan(strict)
  expect(strictStored).toMatchObject({ storage: "derived-text-v1" })
  expect(strict.restore_readback).toBeUndefined()
  expect(strict.candidate.markdown).toBe(strict.input_projection!.markdown)
  expect(canonicalSharedJson(expandSharedOperationPlan(strictStored))).toBe(
    canonicalSharedJson(strict),
  )
  expect((await api.run(validateSharedBodyWritePlan(strictStored))).operation_id).toBe(
    strict.operation_id,
  )

  expect(await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }))).toMatchObject({
    status: "applied",
    verified: true,
  })
  expect(patches(api)).toHaveLength(0)
  expect(shared.markdown).toBe(observed)
  expect(
    canonicalSharedJson(expandSharedOperationPlan(payloadFor(shared, plan.operation_id))),
  ).toBe(canonicalSharedJson(plan))
  shared.local.clear()
  const cold = client(shared)
  expect(await cold.run(reconcileSharedBodyWrite(library, plan))).toMatchObject({
    status: "applied",
    verified: true,
  })
  expect(patches(cold)).toHaveLength(0)
  expect(creates(cold)).toHaveLength(0)
})
