import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Crypto, Effect, Layer } from "effect"
import type { Receipt } from "../src/publication-model.ts"
import { publicationJournalSettled } from "../src/publication-effect-proof.ts"
import {
  proveRetainedTerminalUploadOrphan,
  retainedTerminalUploadOrphan,
} from "../src/publication-upload.ts"
import { Store, StoreLive } from "../src/store.ts"
import { trashPath } from "../src/local-locks.ts"
const digestOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const operation = "p_terminal-upload-journal"
const source = new TextEncoder().encode("# Source\n")
const artifactBytes = new TextEncoder().encode("zip!")
const artifact = {
  suboperation_id: `${operation}:upload:1`,
  filename: "ntn-skills-source.zip",
  sha256: "",
  byte_length: artifactBytes.length,
}
const receipt = (digest: string): Receipt => ({
  format: 1,
  operation_id: operation,
  operation: "replace",
  state: "failed",
  scope: "scope",
  database_id: "database",
  data_source_id: "source",
  page_id: "page",
  conflict: true,
  portable: {
    kind: "skill",
    name: "fixture",
    description: "Example",
    main: "SKILL.md",
    files: [{ path: "SKILL.md", sha256: digestOf(source) }],
  },
  guards: {},
  intents: [
    {
      path: "v1/pages/page/markdown",
      method: "PATCH",
      status: "completed",
      body: {},
      response: { id: "page" },
    },
    {
      path: "v1/file_uploads",
      method: "POST",
      status: "unknown",
      body: { filename: artifact.filename, mode: "single_part" },
      artifact: { ...artifact, sha256: digest },
      recovery: {
        kind: "remote_orphan",
        replacement_suboperation_id: `${operation}:upload:replacement:1`,
      },
    },
  ],
  stages: [],
})

test("only the exact terminal artifact counts as retained unknown history", async () => {
  const digest = digestOf(artifactBytes)
  const original = receipt(digest)
  assert.equal(publicationJournalSettled(original), true)
  assert.equal(retainedTerminalUploadOrphan(original, original.intents[1]!, 1), true)
  assert.equal(original.intents[1]!.status, "unknown")
  assert.equal(original.intents[1]!.response, undefined)
  const later = receipt(digest)
  later.intents.push({
    path: "v1/pages/page",
    method: "PATCH",
    status: "completed",
    body: {},
    response: { id: "page" },
  })
  assert.equal(publicationJournalSettled(later), false)
  const arbitrary = receipt(digest)
  arbitrary.intents[1]!.recovery = { kind: "remote_orphan", replacement_suboperation_id: "other" }
  assert.equal(publicationJournalSettled(arbitrary), false)
  const known = receipt(digest)
  known.intents[1]!.response = { id: "upload-1" }
  assert.equal(retainedTerminalUploadOrphan(known, known.intents[1]!, 1), false)
  const arbitraryBody = receipt(digest)
  arbitraryBody.intents[1] = {
    ...arbitraryBody.intents[1]!,
    body: { filename: artifact.filename, mode: "single_part", extra: true },
  }
  assert.equal(retainedTerminalUploadOrphan(arbitraryBody, arbitraryBody.intents[1]!, 1), false)
  const completed = receipt(digest)
  completed.intents[1]!.status = "completed"
  completed.intents[1]!.response = { id: "upload-1", status: "uploaded" }
  delete completed.intents[1]!.recovery
  assert.equal(publicationJournalSettled(completed), true)
  assert.equal(retainedTerminalUploadOrphan(completed, completed.intents[1]!, 1), false)
})

test("artifact byte drift refuses recovery without acknowledging the original allocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-upload-journal-"))
  const config = ConfigProvider.fromUnknown({
    NTN_SKILLS_HOME: join(directory, "state"),
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
  })
  const run = <A, E>(effect: Effect.Effect<A, E, Store | Crypto.Crypto>) =>
    Effect.runPromise(
      Effect.scoped(
        effect.pipe(
          Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),
          Effect.provide(ConfigProvider.layer(config)),
        ),
      ),
    )
  try {
    const digest = digestOf(artifactBytes)
    const original = receipt(digest)
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.writeBytes(`uploads/${digest}/${artifact.filename}`, artifactBytes)
        const proved = yield* proveRetainedTerminalUploadOrphan(original)
        assert.deepEqual(proved, { index: 1, artifact: original.intents[1]!.artifact })
        assert.equal(original.intents[1]!.status, "unknown")
        assert.equal(original.intents[1]!.response, undefined)
      }),
    )
    original.intents[1] = {
      ...original.intents[1]!,
      artifact: { ...original.intents[1]!.artifact!, byte_length: artifact.byte_length + 1 },
    }
    const drifted = await run(proveRetainedTerminalUploadOrphan(original).pipe(Effect.result))
    assert.equal(drifted._tag, "Failure")
  } finally {
    if (process.platform === "darwin")
      await Effect.runPromise(trashPath(directory).pipe(Effect.provide(NodeServices.layer)))
  }
})
