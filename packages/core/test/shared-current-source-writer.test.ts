import { afterAll, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { Store } from "../src/store.ts"
import {
  SourceManagerExecution,
  withCurrentSourceWriter,
} from "../src/shared-current-source-writer.ts"
import { applyCurrentSource } from "../src/shared-current-source-write.ts"
import { syncCurrentSources } from "../src/shared-current-source-sync.ts"
import {
  changeCurrentSourceEnabled,
  removeCurrentSource,
} from "../src/shared-current-source-lifecycle.ts"
import { changeCurrentSourceFileAuthority } from "../src/shared-current-source-file.ts"
import { currentWriteFixture, library } from "./shared-current-write-fixture.ts"

const root = await mkdtemp(join(tmpdir(), "ntn-current-source-writer-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
})
const request = {
  source_ids: ["writer-source"],
  manager_id: "writer-test",
  execution_id: "a".repeat(64),
  mode: "changed" as const,
  projection: "none" as const,
}

test("apply and sync enter the same manager Store fence before reading or planning", async () => {
  const f = currentWriteFixture(root)
  let enter = () => {},
    release = () => {}
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const writer = f.run(
    withCurrentSourceWriter(
      library,
      Effect.promise(async () => {
        enter()
        await held
      }),
    ),
  )
  await entered
  try {
    await expect(
      f.run(applyCurrentSource(library, { operation_id: "apply-overlap", declaration: {} })),
    ).rejects.toMatchObject({ code: "SYNC_LOCKED" })
    const result = await f.run(syncCurrentSources(library, request))
    expect(result.status).toBe("retryable")
    expect(result.results[0]?.error?.code).toBe("SYNC_LOCKED")
    expect(f.calls).toEqual([])
  } finally {
    release()
    await writer
  }
})

test("nested Source parent and child operations reuse only their already acquired Store scope", async () => {
  const f = currentWriteFixture(root)
  expect(
    await f.run(
      withCurrentSourceWriter(library, withCurrentSourceWriter(library, Effect.succeed("nested"))),
    ),
  ).toBe("nested")
  expect(f.calls).toEqual([])
})

test("a configured client cannot bypass its manager through Source lifecycle, file, apply or sync commands", async () => {
  const f = currentWriteFixture(root)
  const store = await f.run(Store)
  await writeFile(join(store.configRoot, "source-manager.json"), "{}", { mode: 0o600 })
  await expect(
    f.run(applyCurrentSource(library, { operation_id: "local-apply", declaration: {} })),
  ).rejects.toMatchObject({ code: "SOURCE_MANAGER_REQUIRED" })
  await expect(
    f.run(
      changeCurrentSourceEnabled(library, {
        source_id: "writer-source",
        operation_id: "local-enable",
        enabled: true,
      }),
    ),
  ).rejects.toMatchObject({ code: "SOURCE_MANAGER_REQUIRED" })
  await expect(
    f.run(
      removeCurrentSource(library, { source_id: "writer-source", operation_id: "local-remove" }),
    ),
  ).rejects.toMatchObject({ code: "SOURCE_MANAGER_REQUIRED" })
  await expect(
    f.run(
      changeCurrentSourceFileAuthority(library, {
        source_id: "writer-source",
        operation_id: "local-file",
        source_path: "SKILL.md",
        skill_id: "writer-skill",
        file_id: "writer-file",
        action: { kind: "restore_follow" },
      }),
    ),
  ).rejects.toMatchObject({ code: "SOURCE_MANAGER_REQUIRED" })
  const result = await f.run(syncCurrentSources(library, request))
  expect(result.results[0]?.error?.code).toBe("SOURCE_MANAGER_REQUIRED")
  expect(f.calls).toEqual([])
  expect(
    await f.run(
      withCurrentSourceWriter(library, Effect.succeed("manager")).pipe(
        Effect.provideService(SourceManagerExecution, {
          library_id: library.library_id,
          store_root: store.root,
          source_ids: ["writer-source"],
        }),
      ),
    ),
  ).toBe("manager")
  await expect(
    f.run(
      withCurrentSourceWriter(library, Effect.void).pipe(
        Effect.provideService(SourceManagerExecution, {
          library_id: library.library_id,
          store_root: store.root + "-other",
          source_ids: ["writer-source"],
        }),
      ),
    ),
  ).rejects.toMatchObject({ code: "SOURCE_MANAGER_SCOPE_MISMATCH" })
})
