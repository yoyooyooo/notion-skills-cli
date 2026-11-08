import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { decode, fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  reconcileSelectedSharedFileRestore,
  restoreSelectedSharedFile,
} from "../src/shared-file-restore.ts"
import {
  FileEventSchema,
  normalizeObservedBody,
  resolveFileState,
  type FileEvent,
} from "../src/shared-file-state.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { registerSourceBinding } from "../src/shared-source-binding.ts"
import { Store } from "../src/store.ts"
import {
  sharedSnapshotFixture,
  library,
  skillPage,
  id,
  rich,
  encode,
  digest,
} from "./shared-snapshot-fixture.ts"

const oid = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
const fixedFiles = (target = "From exact fixed revision\n") => [
  {
    path: "SKILL.md",
    bytes: encode(
      "---\nname: Upstream name\ndescription: Upstream description\nlicense: MIT\n---\n\n# Upstream main\n",
    ),
  },
  { path: "references/1.md", bytes: encode(target) },
  { path: "references/2.md", bytes: encode("Upstream second\n") },
]
function fixture() {
  const providerCalls: string[] = [],
    providerBodies = new Map<string, Uint8Array>()
  let onDownload: (() => void) | undefined
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      providerCalls.push(url.toString())
      const hook = onDownload
      onDownload = undefined
      hook?.()
      const bytes = providerBodies.get(url.toString())
      return HttpClientResponse.fromWeb(
        request,
        bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(bytes.slice(), { headers: { "content-length": String(bytes.length) } }),
      )
    }),
  )
  const base = sharedSnapshotFixture({ httpClient: client }),
    retired = new Map<string, unknown>()
  const run = <A, E>(
    action: Effect.Effect<
      A,
      E,
      Store | Notion | Crypto.Crypto | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
    >,
  ) =>
    base.run(
      Effect.gen(function* () {
        const original = yield* Notion,
          store = yield* Store
        const controlledStore: Store["Service"] = {
          ...store,
          writeJson: (key, value) =>
            Effect.gen(function* () {
              if (
                key.startsWith("operations/") &&
                (retired.has(key) ||
                  (base.json.has(key) &&
                    canonicalSharedJson(base.json.get(key)) !== canonicalSharedJson(value)))
              )
                return yield* Effect.fail(
                  fail(
                    "STATE_CONFLICT",
                    "A frozen restore or source dispatch cannot change or reopen",
                  ),
                )
              yield* store.writeJson(key, value)
            }),
          retireKeys: (keys) =>
            Effect.sync(() =>
              keys.map((key) => {
                if (key.startsWith("operations/") && base.json.has(key))
                  retired.set(key, structuredClone(base.json.get(key)))
                base.json.delete(key)
                return { key, retention_path: `retired/${key}` }
              }),
            ),
        }
        const api: Notion["Service"] = {
          ...original,
          request: (path, body, options) => {
            const match = /^v1\/pages\/([^/]+)\/markdown$/u.exec(path)
            if (options?.method !== "PATCH" || match === null)
              return original.request(path, body, options)
            return Effect.try({
              try: () => {
                base.calls.push({ path, body, method: "PATCH" })
                const page = match[1]!,
                  current = base.bodies.get(page),
                  updates = property(property(body).update_content).content_updates
                if (
                  current === undefined ||
                  !Array.isArray(updates) ||
                  updates.length !== 1 ||
                  property(body).markdown_version !== "v2"
                )
                  throw fail(
                    "TEST_RESTORE_REQUEST",
                    "Expected exactly one complete v2 old-body update",
                  )
                const oldText = property(updates[0]).old_str,
                  newText = property(updates[0]).new_str
                if (
                  typeof oldText !== "string" ||
                  oldText === "" ||
                  typeof newText !== "string" ||
                  !current.includes(oldText)
                )
                  throw fail(
                    "NOTION_REQUEST_FAILED",
                    "Original complete old body no longer matches",
                    {
                      phase: "definitive_rejection",
                      http_status: 400,
                      notion_code: "validation_error",
                    },
                  )
                const changed = current.replace(oldText, newText)
                base.bodies.set(page, changed)
                const row =
                  page === skillPage ? base.main : base.files.find((file) => file.id === page)
                if (row !== undefined) row.last_edited_time = new Date().toISOString()
                return { id: page, markdown: changed, truncated: false, unknown_block_ids: [] }
              },
              catch: (error) =>
                error instanceof SkillsError
                  ? error
                  : fail("TEST_RESTORE_REQUEST", "Controlled restore failed"),
            })
          },
        }
        return yield* action.pipe(
          Effect.provideService(Notion, api),
          Effect.provideService(Store, controlledStore),
        )
      }),
    )
  const seedBody = (
    fileId: string,
    page: string,
    eventId = `initial-${fileId}`,
    parents: readonly string[] = [],
  ) => {
    const markdown = normalizeObservedBody(base.bodies.get(page) ?? ""),
      hash = digest(markdown)
    const retained = { object_id: `body-${hash}`, sha256: hash, bytes: encode(markdown).length }
    base.seedFact(
      { version: 1, kind: "normalized_markdown", normalization_version: 1, markdown },
      "object",
      retained.object_id,
      retained.object_id,
      `retain-${hash}`,
    )
    const event = {
      kind: "adopted",
      file_id: fileId,
      event_id: eventId,
      parents,
      content: retained,
    }
    base.seedFact(event, "file_event", fileId, eventId)
    return retained
  }
  const register = async (
    files: readonly { path: string; bytes: Uint8Array }[],
    commit = "1".repeat(40),
    select = true,
  ) => {
    const fixedSource = {
      url: "https://github.com/example/native-restore",
      commit,
      tree: "f".repeat(40),
      root: "",
      files: files.map((file) => ({
        path: file.path,
        source_path: file.path,
        git_oid: oid(file.bytes),
        bytes: file.bytes.length,
      })),
    }
    for (const file of files)
      providerBodies.set(
        `https://raw.githubusercontent.com/example/native-restore/${commit}/${file.path}`,
        file.bytes,
      )
    const registered = await run(
      registerSourceBinding(library, { skillPageId: skillPage, mode: "create", fixedSource }),
    )
    if (select) property(base.main.properties).source = rich("source", registered.binding.source_id)
    return registered.binding
  }
  const baseline = () => {
    seedBody("file-main", skillPage)
    seedBody("file-1", id(11))
    seedBody("file-2", id(12))
  }
  const events = () =>
    run(
      querySharedRecords(library, { skillPageId: skillPage, kind: "file_event" }).pipe(
        Effect.map((rows) => rows.map((row) => decode(FileEventSchema, row.payload))),
      ),
    )
  return {
    base,
    run,
    register,
    seedBody,
    baseline,
    events,
    providerBodies,
    providerCalls,
    retired,
    onDownload: (hook: () => void) => {
      onDownload = hook
    },
    clear: () => {
      base.clearCalls()
      providerCalls.length = 0
    },
    patches: () => base.calls.filter((call) => call.method === "PATCH"),
    writes: () => base.calls.filter((call) => call.method === "PATCH" || call.path === "v1/pages"),
    plans: () =>
      [...base.records.values()]
        .map((row) =>
          property(
            property(JSON.parse(text(property(property(row.properties).payload).rich_text)))
              .payload,
          ),
        )
        .filter((payload) => payload.kind === "body_write"),
  }
}

describe("public selected-source restore-follow", () => {
  test("restores a native creation projection while retaining supporting YAML and sending no body PATCH", async () => {
    const f = fixture()
    const header = "---\nname: reference\nlicense: MIT\n---\n\n"
    const input = header + "# Reference\n\nLead\n```python\nvalue\n```\n"
    // The independent v10 native readback contract retains the py fence label.
    const observed = "# Reference\n\nLead\n\n```py\nvalue\n```"
    f.base.bodies.set(id(11), observed)
    f.baseline()
    await f.register(fixedFiles(input))
    f.clear()
    const dry = await f.run(
      restoreSelectedSharedFile({
        library,
        skillPageId: skillPage,
        path: "references/1.md",
        dryRun: true,
      }),
    )
    expect(property(property(dry).execution).kind).toBe("no_body_write")
    expect(f.writes()).toHaveLength(0)
    const result = await f.run(
      restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "references/1.md" }),
    )
    expect(result.candidate_sha256).toBe(digest(observed))
    expect(f.patches()).toHaveLength(0)
    const state = resolveFileState(
      "file-1",
      (await f.events()).filter((event) => event.file_id === "file-1"),
    )
    expect(state.ownership.kind).toBe("following")
    if (state.ownership.kind !== "following") throw new Error("Expected following")
    expect(property(state.ownership).frontmatter).toBe(header)
  })

  test("restores identical selected-source text without a body PATCH and repeats without new history", async () => {
    const f = fixture()
    f.base.bodies.set(id(11), "From exact fixed revision")
    f.baseline()
    const selected = await f.register(fixedFiles(), "1".repeat(40))
    const newer = await f.register(
      fixedFiles("A newer unselected revision\n"),
      "2".repeat(40),
      false,
    )
    const original = f.base.bodies.get(id(11))
    f.clear()
    const result = await f.run(
      restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "references/1.md" }),
    )
    expect(result.source_id).toBe(selected.source_id)
    expect(result.source_revision).toBe(selected.commit)
    expect(result.source_id).not.toBe(newer.source_id)
    expect(f.providerCalls.every((url) => url.includes(`/${selected.commit}/`))).toBe(true)
    expect(f.base.bodies.get(id(11))).toBe("From exact fixed revision")
    expect(f.patches()).toHaveLength(0)
    const first = f.plans()[0]!
    expect(property(first.before).markdown).toBe(original)
    expect(property(first.restore_source).revision).toBe(selected.commit)
    expect(property(first.input_projection).input_markdown).toBe("From exact fixed revision\n")
    const state = resolveFileState(
      "file-1",
      (await f.events()).filter((event) => event.file_id === "file-1"),
    )
    expect(state.ownership.kind).toBe("following")
    expect(result.source_sha256).toBe(digest("From exact fixed revision\n"))
    expect(result.candidate_sha256).toBe(digest("From exact fixed revision"))
    f.clear()
    await f.run(
      restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "references/1.md" }),
    )
    expect(f.patches()).toHaveLength(0)
    expect(f.writes()).toHaveLength(0)
    expect(f.providerCalls).toHaveLength(0)
    const reconciled = await f.run(
      reconcileSelectedSharedFileRestore({
        library,
        skillPageId: skillPage,
        path: "references/1.md",
        operationId: result.operation_id,
      }),
    )
    expect(reconciled.status).toBe("applied")
    expect(f.writes()).toHaveLength(0)
  })

  test("a different selected source remains previewable but cannot overwrite an editable custom body", async () => {
    const f = fixture()
    f.baseline()
    const source = await f.register(fixedFiles())
    const before = canonicalSharedJson([...f.base.records.values()])
    f.clear()
    const preview = await f.run(
      restoreSelectedSharedFile({
        library,
        skillPageId: skillPage,
        path: "references/1.md",
        dryRun: true,
      }),
    )
    expect(preview).toMatchObject({
      source_id: source.source_id,
      execution: { kind: "blocked", code: "BODY_REPLACEMENT_UNSAFE" },
    })
    const error = await f.run(
      Effect.flip(
        restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "references/1.md" }),
      ),
    )
    expect(error.code).toBe("BODY_REPLACEMENT_UNSAFE")
    expect(f.base.bodies.get(id(11))).toBe("Reference one\n")
    expect(f.writes()).toHaveLength(0)
    expect(canonicalSharedJson([...f.base.records.values()])).toBe(before)
    expect(
      resolveFileState(
        "file-1",
        (await f.events()).filter((event) => event.file_id === "file-1"),
      ).ownership.kind,
    ).toBe("custom")
  })

  test("an unknown no-body restore keeps its original operation unresolved without replay", async () => {
    const f = fixture()
    f.base.bodies.set(id(11), "From exact fixed revision")
    f.baseline()
    await f.register(fixedFiles())
    f.base.unknownEvent()
    const failed = await f.run(
      Effect.flip(
        restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "references/1.md" }),
      ),
    )
    expect(failed.code).toBe("WRITE_OUTCOME_UNKNOWN")
    const plan = f.plans()[0]!
    f.clear()
    const unresolved = await f.run(
      Effect.flip(
        reconcileSelectedSharedFileRestore({
          library,
          skillPageId: skillPage,
          path: "references/1.md",
          operationId: String(plan.operation_id),
        }),
      ),
    )
    expect(unresolved.code).toBe("SHARED_BODY_WRITE_UNRESOLVED")
    expect(f.writes()).toHaveLength(0)
    expect(f.base.bodies.get(id(11))).toBe("From exact fixed revision")
  })

  test("a moved custom file restores from its retained original source path and keeps stable page identity", async () => {
    const f = fixture()
    f.base.bodies.set(id(11), "Reference one")
    f.seedBody("file-main", skillPage)
    f.seedBody("file-2", id(12))
    const selected = await f.register(fixedFiles("Reference one\n"))
    const content = {
      object_id: `body-${digest("Reference one")}`,
      sha256: digest("Reference one"),
      bytes: encode("Reference one").length,
    }
    f.base.seedFact(
      {
        kind: "projected",
        event_id: "initial-projected-file-1",
        file_id: "file-1",
        parents: [],
        source_revision: selected.commit,
        projection: { normalization_version: 1, sha256: content.sha256 },
      },
      "file_event",
      "file-1",
      "initial-projected-file-1",
    )
    f.seedBody("file-1", id(11), "initial-file-1", ["initial-projected-file-1"])
    const event: FileEvent = {
      kind: "moved",
      event_id: "move-file-1",
      file_id: "file-1",
      parents: ["initial-file-1"],
      from_path: "references/1.md",
      to_path: "notes/one.md",
      source_path: "references/1.md",
      suppressed_paths: ["references/1.md"],
      retained: content,
    }
    f.base.seedFact(event, "file_event", "file-1", event.event_id)
    f.base.files[0]!.properties.path = rich("path", "notes/one.md")
    f.clear()
    const restored = await f.run(
      restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "notes/one.md" }),
    )
    expect(restored.source_path).toBe("references/1.md")
    expect(restored.page_id).toBe(id(11))
    expect(f.patches()).toHaveLength(0)
    const state = resolveFileState(
      "file-1",
      (await f.events()).filter((event) => event.file_id === "file-1"),
    )
    expect(state.ownership.kind).toBe("following")
    expect(state.placement).toEqual({
      path: "notes/one.md",
      source_path: "references/1.md",
      suppressed_paths: ["references/1.md"],
    })
    if (!("snapshot_id" in restored) || typeof restored.snapshot_id !== "string")
      throw new Error("Expected a verified current snapshot after restoring the moved file")
    const snapshot = property(f.base.json.get(`snapshots/${restored.snapshot_id}.json`))
    expect(
      Array.isArray(snapshot.files) &&
        snapshot.files.some((file) => property(file).path === "notes/one.md"),
    ).toBe(true)
    expect(
      Array.isArray(snapshot.files) &&
        snapshot.files.some((file) => property(file).path === "references/1.md"),
    ).toBe(false)
  })

  test("a source deletion cannot erase a custom page or infer a same-named fallback", async () => {
    const f = fixture()
    f.baseline()
    await f.register(fixedFiles().filter((file) => file.path !== "references/1.md"))
    const before = f.base.bodies.get(id(11))
    f.clear()
    expect(
      (
        await f.run(
          Effect.flip(
            restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "references/1.md" }),
          ),
        )
      ).code,
    ).toBe("SHARED_SOURCE_FILE_MISSING")
    expect(f.base.bodies.get(id(11))).toBe(before)
    expect(f.writes()).toHaveLength(0)
    expect(f.base.readBodyCount()).toBe(0)
    expect(
      resolveFileState(
        "file-1",
        (await f.events()).filter((event) => event.file_id === "file-1"),
      ).ownership.kind,
    ).toBe("custom")
  })

  test("main restore preserves current Notion metadata while canonical output retains source frontmatter extras", async () => {
    const f = fixture()
    f.base.bodies.set(skillPage, "# Upstream main")
    f.baseline()
    await f.register(fixedFiles())
    const before = structuredClone(f.base.main.properties)
    const result = await f.run(
      restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "SKILL.md" }),
    )
    expect(f.base.bodies.get(skillPage)).toBe("# Upstream main")
    expect(f.base.main.properties).toEqual(before)
    expect(f.patches().every((call) => call.path.endsWith("/markdown"))).toBe(true)
    if (!("snapshot_id" in result) || typeof result.snapshot_id !== "string")
      throw new Error("Expected a verified current snapshot after restoring the main file")
    const snapshot = property(f.base.json.get(`snapshots/${result.snapshot_id}.json`))
    const file = Array.isArray(snapshot.files)
      ? snapshot.files.map(property).find((file) => file.path === "SKILL.md")
      : undefined
    if (typeof file?.sha256 !== "string") throw new Error("Missing canonical main snapshot object")
    const main = new TextDecoder().decode(f.base.objects.get(`objects/${file.sha256}`))
    expect(main).toContain('"name": "Managed Name"')
    expect(main).toContain('"description": "Managed description"')
    expect(main).toContain('"license": "MIT"')
    expect(main).not.toContain("Upstream name")
  })

  test("local-derived source bytes require explicit archive authorization before any Notion write", async () => {
    const f = fixture()
    f.baseline()
    await f.register(fixedFiles())
    f.base.json.set(`content-restrictions/local/${digest("From exact fixed revision\n")}.json`, {
      version: 1,
      sha256: digest("From exact fixed revision\n"),
      reason: "local_resource",
    })
    f.clear()
    const error = await f.run(
      Effect.flip(
        restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "references/1.md" }),
      ),
    )
    expect(error.code).toBe("LOCAL_RESOURCE_ARCHIVE_REQUIRED")
    expect(property(error.details).paths).toEqual(["references/1.md"])
    expect(f.writes()).toHaveLength(0)
    expect(f.base.readBodyCount()).toBe(0)
    expect(f.base.bodies.get(id(11))).toBe("Reference one\n")
    const allowed = await f.run(
      Effect.flip(
        restoreSelectedSharedFile({
          library,
          skillPageId: skillPage,
          path: "references/1.md",
          allowLocalArchive: true,
        }),
      ),
    )
    expect(allowed.code).toBe("BODY_REPLACEMENT_UNSAFE")
    expect(f.writes()).toHaveLength(0)
  })

  test("a new accepted custom edit during source acquisition cannot replace the original expected frontier", async () => {
    const f = fixture()
    f.baseline()
    await f.register(fixedFiles())
    f.onDownload(() => {
      f.base.bodies.set(id(11), "Accepted by another client while the source downloaded\n")
      f.seedBody("file-1", id(11), "concurrent-custom", ["initial-file-1"])
    })
    f.clear()
    const error = await f.run(
      Effect.flip(
        restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "references/1.md" }),
      ),
    )
    expect(error.code).toBe("SHARED_BODY_WRITE_STALE")
    expect(f.base.bodies.get(id(11))).toBe(
      "Accepted by another client while the source downloaded\n",
    )
    expect(f.writes()).toHaveLength(0)
    expect(f.plans()).toHaveLength(0)
  })

  test("a changed selected source during acquisition fails without following the newer revision", async () => {
    const f = fixture()
    f.baseline()
    await f.register(fixedFiles(), "1".repeat(40))
    const changed = await f.register(fixedFiles("New selected source\n"), "2".repeat(40), false)
    f.onDownload(() => {
      property(f.base.main.properties).source = rich("source", changed.source_id)
    })
    f.clear()
    expect(
      (
        await f.run(
          Effect.flip(
            restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "references/1.md" }),
          ),
        )
      ).code,
    ).toBe("SHARED_BODY_WRITE_STALE")
    expect(f.base.bodies.get(id(11))).toBe("Reference one\n")
    expect(f.writes()).toHaveLength(0)
    expect(f.providerCalls.every((url) => url.includes(`/${"1".repeat(40)}/`))).toBe(true)
  })

  test("a logical path changed during acquisition cannot silently retarget the restored file", async () => {
    const f = fixture()
    f.baseline()
    await f.register(fixedFiles())
    f.onDownload(() => {
      f.base.files[0]!.properties.path = rich("path", "notes/renamed.md")
    })
    f.clear()
    const error = await f.run(
      Effect.flip(
        restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "references/1.md" }),
      ),
    )
    expect(error.code).toBe("SHARED_SOURCE_PATH_UNAVAILABLE")
    expect(f.base.bodies.get(id(11))).toBe("Reference one\n")
    expect(f.writes()).toHaveLength(0)
    expect(f.plans()).toHaveLength(0)
  })

  test("fixed binary resource bytes fail before reading or replacing the native editable body", async () => {
    const f = fixture()
    f.baseline()
    await f.register(
      fixedFiles().map((file) =>
        file.path === "references/1.md"
          ? { ...file, bytes: new Uint8Array([0xff, 0x00, 0x81]) }
          : file,
      ),
    )
    f.clear()
    const error = await f.run(
      Effect.flip(
        restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "references/1.md" }),
      ),
    )
    expect(error.code).toBe("BINARY_FILE")
    expect(f.writes()).toHaveLength(0)
    expect(f.base.readBodyCount()).toBe(0)
    expect(f.base.bodies.get(id(11))).toBe("Reference one\n")
  })

  test("tombstones require explicit lifecycle restoration and fail before source download", async () => {
    const f = fixture()
    f.baseline()
    await f.register(fixedFiles())
    const hash = digest("Reference one\n")
    f.base.seedFact(
      {
        kind: "deleted",
        event_id: "delete-file-1",
        file_id: "file-1",
        parents: ["initial-file-1"],
        retained: {
          object_id: `body-${hash}`,
          sha256: hash,
          bytes: encode("Reference one\n").length,
        },
      },
      "file_event",
      "file-1",
      "delete-file-1",
    )
    f.clear()
    expect(
      (
        await f.run(
          Effect.flip(
            restoreSelectedSharedFile({ library, skillPageId: skillPage, path: "references/1.md" }),
          ),
        )
      ).code,
    ).toBe("SHARED_BODY_WRITE_SCOPE")
    expect(f.providerCalls).toHaveLength(0)
    expect(f.writes()).toHaveLength(0)
    expect(f.base.bodies.get(id(11))).toBe("Reference one\n")
  })
})
