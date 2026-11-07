import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Crypto, Effect, FileSystem, Path } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { HttpClient } from "effect/http"
import { fail, property, SkillsError, text, type Snapshot } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { fileRef, parseTarget } from "../src/ref.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { withSharedAuthoringTarget } from "../src/shared-authoring-context.ts"
import { writeSkill } from "../src/mutation.ts"
import { trashPath } from "../src/local-locks.ts"
import {
  sharedAuthoringMarkdown,
  verifySharedAuthoredSnapshot,
  writeSharedSkillFile,
} from "../src/shared-authoring.ts"
import {
  sharedSnapshotFixture,
  library,
  skillPage,
  encode,
  digest,
  id,
} from "./shared-snapshot-fixture.ts"
import { sharedCreateFixture } from "./shared-create-fixture.ts"

const options = { database: library.skills.database_id }
const mainInput = (body: string) =>
  encode(`---\nname: Managed Name\ndescription: Managed description\n---\n\n${body}`)

function failure<A>(
  result:
    | { readonly _tag: "Success"; readonly success: A }
    | { readonly _tag: "Failure"; readonly failure: unknown },
): SkillsError {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected a typed SkillsError")
  return result.failure
}

/** Extend the metadata fixture with the one actual whole-body mutation boundary. */
function withBodyWriter<A, E>(
  f: ReturnType<typeof sharedSnapshotFixture>,
  action: Effect.Effect<
    A,
    E,
    Notion | Store | Crypto.Crypto | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
  >,
  options: { readonly unknownCompletion?: boolean } = {},
) {
  return Effect.gen(function* () {
    const original = yield* Notion
    const api: Notion["Service"] = {
      ...original,
      request: (path, body, requestOptions) => {
        const recordId = text(property(property(property(body).properties).record).rich_text)
        if (
          options.unknownCompletion &&
          path === "v1/pages" &&
          recordId.startsWith("outcome-body-write-")
        )
          return original
            .request(path, body, requestOptions)
            .pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  fail("WRITE_OUTCOME_UNKNOWN", "The original completion response was lost."),
                ),
              ),
            )
        const match = /^v1\/pages\/([^/]+)\/markdown$/u.exec(path)
        if (requestOptions?.method !== "PATCH" || match === null)
          return original.request(path, body, requestOptions)
        return Effect.try({
          try: () => {
            f.calls.push({ path, method: "PATCH", body })
            const page = match[1]
            if (page === undefined) throw fail("FIXTURE_ERROR", "Missing body page")
            const current = f.bodies.get(page)
            const updates = property(property(body).update_content).content_updates
            if (current === undefined || !Array.isArray(updates) || updates.length !== 1)
              throw fail("FIXTURE_ERROR", "Not one complete body update")
            const item = property(updates[0]),
              oldText = item.old_str,
              newText = item.new_str
            if (
              typeof oldText !== "string" ||
              !oldText ||
              typeof newText !== "string" ||
              !current.includes(oldText)
            )
              throw fail("NOTION_REQUEST_FAILED", "Definitive fixture rejection", {
                phase: "definitive_rejection",
                http_status: 400,
                notion_code: "validation_error",
              })
            const changed = current.replace(oldText, newText)
            f.bodies.set(page, changed)
            const row = page === skillPage ? f.main : f.files.find((value) => value.id === page)
            if (row !== undefined) row.last_edited_time = new Date(Date.now() + 1).toISOString()
            return { id: page, markdown: changed, truncated: false, unknown_block_ids: [] }
          },
          catch: (error) =>
            error instanceof SkillsError
              ? error
              : fail("FIXTURE_ERROR", "Controlled body mutation failed"),
        })
      },
    }
    return yield* action.pipe(Effect.provideService(Notion, api))
  })
}

describe("shared authoring through the standard fresh snapshot", () => {
  test("a disabled author reads a library with native Members and Requires without admitting disabled targets", async () => {
    const f = sharedCreateFixture({ relations: true })
    const owner = f.skills.get(skillPage)
    if (owner === undefined) throw new Error("Expected the native fixture owner")
    property(property(owner.properties).enabled).checkbox = false
    const inspected = await f.run(readSkill(skillPage, { ...options, authoring: true }))
    expect(property(inspected).content).toContain("# Native main")
    expect(inspected.record.enabled).toBe(false)
    expect(failure(await f.run(readSkill(skillPage, options).pipe(Effect.result))).code).toBe(
      "CONTENT_DISABLED",
    )
    const otherPage = id(991)
    const member = structuredClone(owner)
    member.id = otherPage
    property(member.properties).skill_id = {
      id: "skill_id",
      type: "rich_text",
      rich_text: [{ plain_text: "other-disabled-skill" }],
      has_more: false,
    }
    f.skills.set(otherPage, member)
    for (const field of ["members", "requires"]) {
      property(property(owner.properties)[field]).relation = [{ id: otherPage }]
      f.clear()
      const rejected = failure(
        await f.run(readSkill(skillPage, { ...options, authoring: true }).pipe(Effect.result)),
      )
      expect(rejected.code).toBe("SHARED_ROUTER_MEMBER_UNAVAILABLE")
      expect(f.calls.some((call) => call.path.includes(`${otherPage}/markdown`))).toBe(false)
      property(property(owner.properties)[field]).relation = []
    }
  })

  test("explicit authoring reads one disabled owner without qualifying current consumption", async () => {
    const f = sharedSnapshotFixture({ fileCount: 1 })
    property(property(f.main.properties).enabled).checkbox = false
    expect(
      failure(await f.run(readSkill(skillPage, { ...options, refresh: true }).pipe(Effect.result)))
        .code,
    ).toBe("CONTENT_DISABLED")
    const inspected = await f.run(readSkill(skillPage, { ...options, authoring: true }))
    if (!("content" in inspected)) throw new Error("Expected the inspected body")
    expect(inspected.content).toContain("# Native main")
    expect(property(inspected.record).enabled).toBe(false)
    expect(
      [...f.json.entries()].some(
        ([key, value]) =>
          key.startsWith("cache/latest/") &&
          property(value).snapshot_id === inspected.snapshot_id &&
          property(value).invalidated === false,
      ),
    ).toBe(false)
    const fixed = await f.run(readSkill(inspected.ref))
    if (!("content" in fixed)) throw new Error("Expected the fixed body")
    expect(fixed.content).toBe(inspected.content)
    expect(failure(await f.run(readSkill(skillPage, options).pipe(Effect.result))).code).toBe(
      "CONTENT_DISABLED",
    )
    expect(
      failure(
        await f.run(
          withSharedAuthoringTarget(
            id(999),
            openSkill(skillPage, { ...options, refresh: true }),
          ).pipe(Effect.result),
        ),
      ).code,
    ).toBe("CONTENT_DISABLED")
  })

  test("a disabled author pin supports a verified public body edit without enabling consumption", async () => {
    const f = sharedSnapshotFixture({ fileCount: 1 })
    property(property(f.main.properties).enabled).checkbox = false
    const inspected = await f.run(readSkill(skillPage, { ...options, authoring: true }))
    const directory = mkdtempSync(join(tmpdir(), "shared-disabled-write-"))
    const input = join(directory, "SKILL.md")
    writeFileSync(input, mainInput("# Reviewed draft\n"))
    try {
      const written = await f.run(
        withBodyWriter(f, writeSkill(inspected.ref, { input })).pipe(
          Effect.provide(NodeServices.layer),
        ),
      )
      expect(property(written).verified).toBe(true)
      expect(property(written).action).toBe("updated")
      expect(f.bodies.get(skillPage)).toBe("# Reviewed draft")
      expect(property(property(f.main.properties).enabled).checkbox).toBe(false)
      const current = await f.run(readSkill(skillPage, { ...options, authoring: true }))
      expect(property(current).content).toContain("# Reviewed draft")
      expect(failure(await f.run(readSkill(skillPage, options).pipe(Effect.result))).code).toBe(
        "CONTENT_DISABLED",
      )
    } finally {
      if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
    }
  })

  test("a verified shared pin scopes public write without database even when an unrelated configured source fails", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await f.target(parseTarget(skillPage), options)
    f.json.set("config.json", {
      sources: [
        {
          alias: "unrelated-broken",
          database_id: id(5000),
          data_source_ids: [id(5001)],
          title: "Guizang",
          role: "content",
        },
      ],
    })
    const directory = mkdtempSync(join(tmpdir(), "shared-pinned-write-"))
    const input = join(directory, "SKILL.md")
    writeFileSync(input, mainInput("# A pinned proposed edit\n"))
    try {
      f.clearCalls()
      const result = await f.run(
        writeSkill(fileRef(snapshot.record.id, snapshot.entrypoint, snapshot.snapshot_id), {
          input,
          dryRun: true,
        }).pipe(Effect.provide(NodeServices.layer)),
      )
      expect("dry_run" in result && result.dry_run).toBe(true)
      expect(result.operation).toBe("write")
      expect(
        f.calls.some(
          (call) =>
            call.path.includes(id(5000)) ||
            call.path.includes(id(5001)) ||
            call.path.includes("/search"),
        ),
      ).toBe(false)
      expect(f.calls.some((call) => call.path === "v1/pages" || call.method === "PATCH")).toBe(
        false,
      )
    } finally {
      if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
    }
  })

  test("editing a read-back main preserves existing and new native reference links", async () => {
    const f = sharedSnapshotFixture()
    const nativeLink = `https://app.notion.com/p/${id(11).replaceAll("-", "")}`
    f.bodies.set(skillPage, `# Native main\n\n[Existing reference](${nativeLink})`)
    const inspected = await f.run(readSkill(skillPage, { ...options, authoring: true }))
    if (!("content" in inspected)) throw new Error("Expected the authoring body")
    expect(inspected.content).toContain("[Existing reference](references/1.md)")
    const directory = mkdtempSync(join(tmpdir(), "shared-native-link-write-"))
    const input = join(directory, "SKILL.md")
    const newNativeLink = `https://app.notion.com/p/${id(12).replaceAll("-", "")}`
    writeFileSync(
      input,
      `${inspected.content.trimEnd()}\n\nA new author instruction.\n\n[New reference](references/2.md)\n`,
    )
    try {
      const written = await f.run(
        withBodyWriter(f, writeSkill(inspected.ref, { input })).pipe(
          Effect.provide(NodeServices.layer),
        ),
      )
      expect(property(written).verified).toBe(true)
      expect(f.bodies.get(skillPage)).toContain(`[Existing reference](${nativeLink})`)
      expect(f.bodies.get(skillPage)).toContain(`[New reference](${newNativeLink})`)
      expect(f.bodies.get(skillPage)).toContain("A new author instruction.")
      const current = await f.run(readSkill(skillPage, { ...options, authoring: true }))
      expect(property(current).content).toContain("[Existing reference](references/1.md)")
      expect(property(current).content).toContain("[New reference](references/2.md)")
      const resource = await f.run(readSkill("references/2.md", { from: current.ref }))
      expect(property(resource).content).toContain("Reference two")
      const previous = await f.run(readSkill(inspected.ref))
      expect(property(previous).content).toBe(inspected.content)
    } finally {
      if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
    }
  })

  test.each([
    `https://www.notion.so/${id(11).replaceAll("-", "")}`,
    `https://app.notion.com/p/${id(11)}`,
  ])("unchanged public read/write preserves native spelling without a PATCH: %s", async (url) => {
    const f = sharedSnapshotFixture()
    const native = `# Native main\n\n[Reference](${url})`
    f.bodies.set(skillPage, native)
    const inspected = await f.run(readSkill(skillPage, { ...options, authoring: true }))
    if (!("content" in inspected)) throw new Error("Expected the complete authoring file")
    const directory = mkdtempSync(join(tmpdir(), "shared-unchanged-link-write-"))
    const input = join(directory, "SKILL.md")
    writeFileSync(input, inspected.content)
    f.clearCalls()
    try {
      const written = await f.run(
        withBodyWriter(f, writeSkill(inspected.ref, { input })).pipe(
          Effect.provide(NodeServices.layer),
        ),
      )
      expect(property(written).verified).toBe(true)
      expect(property(written).action).toBe("unchanged")
      expect(property(written).body_write_operation_id).toBeUndefined()
      expect(f.bodies.get(skillPage)).toBe(native)
      expect(f.writeCount()).toBe(0)
      expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
    } finally {
      if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
    }
  })

  test("fresh heads and body evidence stay in memory and are absent from immutable snapshots", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await f.target(parseTarget(skillPage), options)
    const evidence = property(property(snapshot).shared_authoring)
    expect(evidence.snapshot_id).toBe(snapshot.snapshot_id)
    expect(evidence.source_id).toBe("")
    expect(Array.isArray(evidence.files) ? evidence.files.length : -1).toBe(3)
    expect(
      property(f.json.get(`snapshots/${snapshot.snapshot_id}.json`)).shared_authoring,
    ).toBeUndefined()
  })

  test("dry run validates a bound full body without a dispatch receipt or Notion writes", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await f.target(parseTarget(skillPage), options)
    f.clearCalls()
    const result = await f.run(
      writeSharedSkillFile({
        snapshot,
        path: "SKILL.md",
        bytes: mainInput("# Proposed\n"),
        dryRun: true,
      }),
    )
    expect(result.status).toBe("planned")
    expect(result.candidate_sha256).toBe(digest("# Proposed"))
    expect(result.input_projection).toMatchObject({
      removed_terminal_lfs: 1,
      input_sha256: digest(mainInput("# Proposed\n")),
    })
    expect(f.bodies.get(skillPage)).toBe("# Native main\n")
    expect(f.calls.filter((call) => call.path === `v1/pages/${skillPage}`)).toHaveLength(1)
    expect(
      f.calls.filter((call) =>
        call.path.startsWith(`v1/data_sources/${library.files.data_source_id}/query`),
      ),
    ).toHaveLength(1)
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
  })

  test("main metadata is validated and a normal write retains the original operation before one PATCH", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await f.target(parseTarget(skillPage), options)
    const saved = structuredClone(f.json.get(`snapshots/${snapshot.snapshot_id}.json`))
    f.clearCalls()
    const result = await f.run(
      withBodyWriter(
        f,
        writeSharedSkillFile({ snapshot, path: "SKILL.md", bytes: mainInput("# Agent edit\n") }),
      ),
    )
    expect(result.status).toBe("applied")
    expect(f.bodies.get(skillPage)).toBe("# Agent edit")
    const retainedPlan = [...f.records.values()]
      .map((row) =>
        property(
          property(JSON.parse(text(property(property(row.properties).payload).rich_text))).payload,
        ),
      )
      .find((value) => value.kind === "body_write")
    expect(property(retainedPlan?.input_projection).input_markdown).toBe("# Agent edit\n")
    expect(retainedPlan?.authored_input_sha256).toBe(digest(mainInput("# Agent edit\n")))
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
    expect([...f.json.values()].some((value) => property(value).invalidated === true)).toBe(true)
    const current = await f.target(parseTarget(skillPage), options)
    if (result.status !== "applied") throw new Error("Expected the completed original body write")
    expect(() => verifySharedAuthoredSnapshot(current, result)).not.toThrow()
    expect(current.snapshot_id).not.toBe(snapshot.snapshot_id)
    expect(f.json.get(`snapshots/${snapshot.snapshot_id}.json`)).toEqual(saved)
  })

  test("unverified supporting frontmatter retains the complete input and fails before any write", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await f.target(parseTarget(skillPage), options)
    const row = f.files[0]
    if (row === undefined) throw new Error("Missing fixture file")
    const value = "---\ncustom: supporting-file-frontmatter\n---\n\nexact support text\n"
    const bytes = encode(value)
    const originalBody = f.bodies.get(row.id)
    const originalRecords = structuredClone([...f.records.entries()])
    expect(sharedAuthoringMarkdown(snapshot, "references/1.md", bytes)).toBe(value)
    f.clearCalls()
    const result = failure(
      await f.run(
        withBodyWriter(f, writeSharedSkillFile({ snapshot, path: "references/1.md", bytes })).pipe(
          Effect.result,
        ),
      ),
    )
    expect(result.code).toBe("SHARED_MARKDOWN_PROJECTION_UNSUPPORTED")
    expect(bytes).toEqual(encode(value))
    expect(f.bodies.get(row.id)).toBe(originalBody)
    expect(f.bodies.get(skillPage)).toBe("# Native main\n")
    expect(f.calls.some((call) => call.path === "v1/pages" || call.method === "PATCH")).toBe(false)
    expect([...f.records.entries()]).toEqual(originalRecords)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
  })

  test("supported UTF-8 resource bodies replace the whole existing Files page", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await f.target(parseTarget(skillPage), options)
    const row = f.files[0]
    if (row === undefined) throw new Error("Missing fixture file")
    const value = "Exact support text\n\nA second paragraph.\n"
    const result = await f.run(
      withBodyWriter(
        f,
        writeSharedSkillFile({ snapshot, path: "references/1.md", bytes: encode(value) }),
      ),
    )
    expect(result.status).toBe("applied")
    expect(f.bodies.get(row.id)).toBe("Exact support text\n\nA second paragraph.")
    expect(f.bodies.get(skillPage)).toBe("# Native main\n")
  })

  test("an invisible first plan remains a replay barrier across current TTL and a second write", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await f.target(parseTarget(skillPage), options)
    f.unknownRecord("operation", false)
    const initial = failure(
      await f.run(
        writeSharedSkillFile({ snapshot, path: "SKILL.md", bytes: mainInput("# Proposed\n") }).pipe(
          Effect.result,
        ),
      ),
    )
    expect(initial.code).toBe("WRITE_OUTCOME_UNKNOWN")
    const originalId = property(initial.details).body_write_operation_id
    const pending = [...f.json.entries()].filter(([key]) =>
      key.startsWith("operations/shared-observation-pending/"),
    )
    expect(pending).toHaveLength(1)
    const saved = structuredClone(pending)
    f.clearCalls()
    await expect(f.target(parseTarget(skillPage), options)).rejects.toThrow("original")
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect(
      [...f.json.entries()].filter(([key]) =>
        key.startsWith("operations/shared-observation-pending/"),
      ),
    ).toEqual(saved)
    const again = failure(
      await f.run(
        writeSharedSkillFile({
          snapshot,
          path: "SKILL.md",
          bytes: mainInput("# Different replacement\n"),
        }).pipe(Effect.result),
      ),
    )
    expect(property(again.details).body_write_operation_id).toBe(originalId)
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
  })

  test("an unknown completion is settled only by its exact outcome and invalidates old TTL before retirement", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await f.target(parseTarget(skillPage), options)
    const original = failure(
      await f.run(
        withBodyWriter(
          f,
          writeSharedSkillFile({
            snapshot,
            path: "SKILL.md",
            bytes: mainInput("# Applied before disconnect\n"),
          }),
          { unknownCompletion: true },
        ).pipe(Effect.result),
      ),
    )
    expect(original.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(true)
    f.clearCalls()
    await expect(f.target(parseTarget(skillPage), options)).rejects.toThrow(
      "Read the current page again",
    )
    expect(f.readBodyCount()).toBe(0)
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
    expect([...f.json.values()].some((value) => property(value).invalidated === true)).toBe(true)
    f.clearCalls()
    const current = await f.target(parseTarget(skillPage), options)
    expect(current.snapshot_id).not.toBe(snapshot.snapshot_id)
    expect(current.source).toBe("notion")
    expect(f.bodies.get(skillPage)).toBe("# Applied before disconnect")
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
  })

  test("fresh baseline rejects a changed actual body and changed source without new writes", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await f.target(parseTarget(skillPage), options)
    f.bodies.set(skillPage, "A later user edit\n")
    f.clearCalls()
    const result = failure(
      await f.run(
        writeSharedSkillFile({ snapshot, path: "SKILL.md", bytes: mainInput("# Proposed\n") }).pipe(
          Effect.result,
        ),
      ),
    )
    expect(result.code).toBe("SHARED_BODY_WRITE_STALE")
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
    expect(f.bodies.get(skillPage)).toBe("A later user edit\n")
  })

  test("sharedReadOnly refuses initial and changed adoption before every Notion write", async () => {
    const f = sharedSnapshotFixture()
    const first = failure(
      await f.run(
        openSkill(skillPage, { ...options, refresh: true, sharedReadOnly: true }).pipe(
          Effect.result,
        ),
      ),
    )
    expect(first.code).toBe("SHARED_OBSERVATION_REQUIRED")
    expect(f.writeCount()).toBe(0)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
    await f.target(parseTarget(skillPage), options)
    f.bodies.set(skillPage, "Changed after baseline\n")
    f.clearCalls()
    const next = failure(
      await f.run(
        openSkill(skillPage, { ...options, refresh: true, sharedReadOnly: true }).pipe(
          Effect.result,
        ),
      ),
    )
    expect(next.code).toBe("SHARED_OBSERVATION_REQUIRED")
    expect(f.writeCount()).toBe(0)
    expect([...f.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
  })

  test("input metadata, extra fields, foreign identity, binary bytes and unbound paths fail explicitly", async () => {
    const f = sharedSnapshotFixture(),
      snapshot = await f.target(parseTarget(skillPage), options)
    expect(sharedAuthoringMarkdown(snapshot, "SKILL.md", mainInput("# Proposed\n"))).toBe(
      "# Proposed\n",
    )
    for (const bytes of [
      encode("---\nname: Renamed\ndescription: Managed description\n---\n\nBody\n"),
      encode("---\nname: Managed Name\ndescription: Changed\n---\n\nBody\n"),
      encode(`---\nnotion_page_id: ${id(999)}\n---\n\nBody\n`),
      encode("---\nname: Managed Name\nlicense: MIT\n---\n\nBody\n"),
      new Uint8Array([0xff, 0xfe]),
      encode("body\0tail"),
    ])
      expect(() => sharedAuthoringMarkdown(snapshot, "SKILL.md", bytes)).toThrow()
    expect(() => sharedAuthoringMarkdown(snapshot, "references/new.md", encode("new"))).toThrow(
      "existing bound",
    )
  })

  test("Router writes strip only the exact frozen generated index and reject member edits", async () => {
    const f = sharedSnapshotFixture(),
      initial = await f.target(parseTarget(skillPage), options)
    const snapshot: Snapshot = {
      ...initial,
      record: { ...initial.record, kind: "router" },
      router_members: [
        {
          id: "shared_skill:library-snapshot:member",
          ref: "skill://member/SKILL.md",
          metadata: {
            version: 1,
            kind: "skill",
            enabled: true,
            library_id: library.library_id,
            name: "Member",
            description: "Description",
          },
        },
      ],
    }
    const footer = "\n\n## Members\n\n- [Member](skill://member/SKILL.md) — Description\n"
    expect(
      sharedAuthoringMarkdown(
        snapshot,
        snapshot.entrypoint,
        mainInput(`# Router instructions\n${footer}`),
      ),
    ).toBe("# Router instructions\n")
    expect(() =>
      sharedAuthoringMarkdown(
        snapshot,
        snapshot.entrypoint,
        mainInput(`# Instructions\n${footer.replace("Description", "Changed")}`),
      ),
    ).toThrow("generated Members")
    expect(() =>
      sharedAuthoringMarkdown(
        snapshot,
        snapshot.entrypoint,
        mainInput("# Instructions without the frozen index\n"),
      ),
    ).toThrow("generated Members")
  })
})
