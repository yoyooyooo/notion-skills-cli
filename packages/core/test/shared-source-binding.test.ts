import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Crypto, Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { fail, property, text, SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import type { FixedGithubSource } from "../src/shared-github-source.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  makeSourceBinding,
  registerSourceBinding,
  resolveSourceBinding,
} from "../src/shared-source-binding.ts"

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const skillId = id(1)
const dataSourceId = id(2)
const databaseId = id(3)
const fields = {
  Name: "title",
  "Record ID": "record",
  Kind: "kind",
  "Entity ID": "entity",
  Hash: "hash",
  Payload: "payload",
  Skill: "skill",
}
const library: SharedLibrary = {
  version: 1,
  library_id: "library-source",
  operation_id: "library-source",
  parent_page_id: id(4),
  skills: { database_id: id(5), data_source_id: id(6), property_ids: {} },
  files: { database_id: id(7), data_source_id: id(8), property_ids: {} },
  records: { database_id: databaseId, data_source_id: dataSourceId, property_ids: fields },
}
const source: FixedGithubSource = {
  url: "https://github.com/example/skills",
  commit: "1".repeat(40),
  root: "skills/demo",
  tree: "2".repeat(40),
  files: [
    {
      path: "SKILL.md",
      source_path: "skills/demo/SKILL.md",
      git_oid: "d670460b4b4aece5915caf5c68d12f560a9fe3e4",
      bytes: 13,
    },
    {
      path: "scripts/empty.sh",
      source_path: "skills/demo/scripts/empty.sh",
      git_oid: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
      bytes: 0,
    },
  ],
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

function fieldValue(propertyId: string, raw: unknown) {
  const value = property(raw)
  if (value.rich_text !== undefined)
    return { ...value, id: propertyId, type: "rich_text", has_more: false }
  if (value.title !== undefined) return { ...value, id: propertyId, type: "title" }
  if (value.select !== undefined) return { ...value, id: propertyId, type: "select" }
  if (value.relation !== undefined)
    return { ...value, id: propertyId, type: "relation", has_more: false }
  throw new Error("Invalid fixture property")
}
function matches(row: Record<string, unknown>, raw: unknown): boolean {
  const filter = property(raw)
  if (Array.isArray(filter.and)) return filter.and.every((part) => matches(row, part))
  if (typeof filter.property !== "string") return false
  const value = property(property(row.properties)[filter.property])
  if (filter.relation !== undefined)
    return (
      Array.isArray(value.relation) &&
      value.relation.some((entry) => property(entry).id === property(filter.relation).contains)
    )
  if (filter.select !== undefined)
    return property(value.select).name === property(filter.select).equals
  if (filter.rich_text !== undefined)
    return text(value.rich_text) === property(filter.rich_text).equals
  return false
}

function fixture(options: { unknownCreate?: "retained" | "absent" } = {}) {
  const records: Record<string, unknown>[] = []
  const calls: Array<{ path: string; body: unknown; method: string | undefined }> = []
  let nextPage = 100
  let injected = false
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("source-credential"),
    request: (path, body, requestOptions) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        calls.push({ path, body, method: requestOptions?.method })
        const url = new URL(path, "https://api.notion.com/")
        if (url.pathname === `/v1/data_sources/${dataSourceId}/query`)
          return Effect.succeed({
            object: "list",
            results: records.filter((row) => matches(row, property(body).filter)),
            has_more: false,
            next_cursor: null,
          })
        if (url.pathname === "/v1/pages" && requestOptions?.method === "POST") {
          const input = property(body)
          const row = {
            object: "page",
            id: id(nextPage++),
            parent: { ...property(input.parent), database_id: databaseId },
            properties: Object.fromEntries(
              Object.entries(property(input.properties)).map(([key, value]) => [
                key,
                fieldValue(key, value),
              ]),
            ),
          }
          const unknown = options.unknownCreate !== undefined && !injected
          if (!unknown || options.unknownCreate === "retained") records.push(row)
          if (unknown) {
            injected = true
            return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Fixture lost create response."))
          }
          return Effect.succeed(row)
        }
        return Effect.fail(
          fail("UNEXPECTED", "Source binding attempted a non-record operation.", { path }),
        )
      }),
  }
  const layer = Layer.mergeAll(NodeServices.layer, Layer.succeed(Notion, api))
  return {
    calls,
    records,
    run: <A, E>(effect: Effect.Effect<A, E, Notion | Crypto.Crypto>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer))),
  }
}

function changeStoredPayload(
  row: Record<string, unknown>,
  change: (payload: Record<string, unknown>) => unknown,
) {
  const props = property(row.properties)
  const parsed: unknown = JSON.parse(text(property(props[fields.Payload]).rich_text))
  const envelope = property(parsed)
  const encoded = canonicalSharedJson({ ...envelope, payload: change(property(envelope.payload)) })
  props[fields.Payload] = {
    id: fields.Payload,
    type: "rich_text",
    rich_text: [{ plain_text: encoded }],
  }
  props[fields.Hash] = {
    id: fields.Hash,
    type: "rich_text",
    rich_text: [{ plain_text: digest(encoded) }],
  }
}

describe("immutable shared Git source binding", () => {
  test("registers the full fixed selection without contacting the provider or writing a page body", async () => {
    const f = fixture()
    const result = await f.run(
      registerSourceBinding(library, { skillPageId: skillId, mode: "create", fixedSource: source }),
    )
    expect(result.binding).toMatchObject({ version: 1, kind: "git", ...source })
    expect(result.binding.source_id).toMatch(/^source-[a-f0-9]{64}$/u)
    expect(result.record).toMatchObject({
      record_id: result.binding.source_id,
      entity_id: result.binding.source_id,
      kind: "source",
      operation_id: `register-${result.binding.source_id}`,
      payload: result.binding,
    })
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]?.path).toBe("v1/pages")
    expect(property(f.calls[1]?.body)).not.toHaveProperty("markdown")
    expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
  })

  test("canonical file order produces one source ID and reattaches without another create", async () => {
    const f = fixture()
    const first = await f.run(
      registerSourceBinding(library, { skillPageId: skillId, mode: "create", fixedSource: source }),
    )
    const second = await f.run(
      registerSourceBinding(library, {
        skillPageId: skillId,
        mode: "create",
        fixedSource: { ...source, files: [...source.files].reverse() },
      }),
    )
    expect(second.binding).toEqual(first.binding)
    expect(second.record.page_id).toBe(first.record.page_id)
    expect(f.records).toHaveLength(1)
    expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(1)
  })

  test("source identity binds repository, commit, tree, root and every file descriptor", async () => {
    const f = fixture()
    const original = await f.run(makeSourceBinding(source))
    const variations: FixedGithubSource[] = [
      { ...source, url: "https://github.com/another/skills" },
      { ...source, commit: "3".repeat(40) },
      { ...source, tree: "3".repeat(40) },
      {
        ...source,
        root: "other",
        files: source.files.map((file) => ({ ...file, source_path: `other/${file.path}` })),
      },
      { ...source, files: source.files.map((file) => ({ ...file, bytes: file.bytes + 1 })) },
      { ...source, files: source.files.map((file) => ({ ...file, git_oid: "4".repeat(40) })) },
    ]
    for (const variant of variations)
      expect((await f.run(makeSourceBinding(variant))).source_id).not.toBe(original.source_id)
    expect(f.calls).toHaveLength(0)
  })

  test("resolves the exact chosen revision even after another commit was registered", async () => {
    const f = fixture()
    const first = await f.run(
      registerSourceBinding(library, { skillPageId: skillId, mode: "create", fixedSource: source }),
    )
    const next = await f.run(
      registerSourceBinding(library, {
        skillPageId: skillId,
        mode: "create",
        fixedSource: { ...source, commit: "3".repeat(40) },
      }),
    )
    f.calls.length = 0
    const selected = await f.run(
      resolveSourceBinding(library, { skillPageId: skillId, sourceId: first.binding.source_id }),
    )
    expect(selected).toEqual(first.binding)
    expect(selected.commit).not.toBe(next.binding.commit)
    expect(f.calls).toHaveLength(1)
    expect(property(f.calls[0]?.body).filter).toEqual({
      and: [
        { property: fields.Skill, relation: { contains: skillId } },
        { property: fields.Kind, select: { equals: "source" } },
        { property: fields["Entity ID"], rich_text: { equals: first.binding.source_id } },
      ],
    })
  })

  test("missing fixed source fails without an upstream or current-version fallback", async () => {
    const f = fixture()
    const result = await f.run(
      resolveSourceBinding(library, {
        skillPageId: skillId,
        sourceId: `source-${"0".repeat(64)}`,
      }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected a missing selected source")
    expect(result.failure.code).toBe("SHARED_SOURCE_MISSING")
    expect(f.calls).toHaveLength(1)
  })

  test("rejects branch selectors and invalid fixed inputs before any Notion request", async () => {
    const f = fixture()
    await expect(
      f.run(resolveSourceBinding(library, { skillPageId: skillId, sourceId: "latest" })),
    ).rejects.toThrow()
    await expect(
      f.run(
        registerSourceBinding(library, {
          skillPageId: skillId,
          mode: "create",
          fixedSource: { ...source, commit: "main" },
        }),
      ),
    ).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
  })

  test("unknown registration is reconciled using the same immutable IDs", async () => {
    const f = fixture({ unknownCreate: "retained" })
    const first = await f.run(
      registerSourceBinding(library, {
        skillPageId: skillId,
        mode: "create",
        fixedSource: source,
      }).pipe(Effect.result),
    )
    expect(first._tag).toBe("Failure")
    if (first._tag !== "Failure") throw new Error("Expected unknown result")
    expect(first.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
    const second = await f.run(
      registerSourceBinding(library, {
        skillPageId: skillId,
        mode: "reconcile",
        fixedSource: source,
      }),
    )
    expect(property(first.failure.details).record_id).toBe(second.binding.source_id)
    expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(1)
  })

  test("unknown absence never grants permission to create again in reconcile mode", async () => {
    const f = fixture({ unknownCreate: "absent" })
    await f.run(
      registerSourceBinding(library, {
        skillPageId: skillId,
        mode: "create",
        fixedSource: source,
      }).pipe(Effect.result),
    )
    const second = await f.run(
      registerSourceBinding(library, {
        skillPageId: skillId,
        mode: "reconcile",
        fixedSource: source,
      }).pipe(Effect.result),
    )
    expect(second._tag).toBe("Failure")
    if (second._tag !== "Failure") throw new Error("Expected unresolved result")
    expect(second.failure.code).toBe("SHARED_RECORD_UNRESOLVED")
    expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(1)
  })

  test("coalesces physical duplicates of the same immutable fact", async () => {
    const f = fixture()
    const registered = await f.run(
      registerSourceBinding(library, { skillPageId: skillId, mode: "create", fixedSource: source }),
    )
    const row = f.records[0]
    if (row === undefined) throw new Error("Missing registered record")
    f.records.push({ ...structuredClone(row), id: id(999) })
    expect(
      await f.run(
        resolveSourceBinding(library, {
          skillPageId: skillId,
          sourceId: registered.binding.source_id,
        }),
      ),
    ).toEqual(registered.binding)
  })

  test("rejects changed fixed content even when the Records envelope hash is recomputed", async () => {
    const f = fixture()
    const registered = await f.run(
      registerSourceBinding(library, { skillPageId: skillId, mode: "create", fixedSource: source }),
    )
    const row = f.records[0]
    if (row === undefined) throw new Error("Missing registered record")
    changeStoredPayload(row, (payload) => ({ ...payload, commit: "3".repeat(40) }))
    const result = await f.run(
      resolveSourceBinding(library, {
        skillPageId: skillId,
        sourceId: registered.binding.source_id,
      }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected fixed identity conflict")
    expect(result.failure.code).toBe("SHARED_SOURCE_CONFLICT")
  })

  test("rejects incompatible duplicate claims for one source ID", async () => {
    const f = fixture()
    const registered = await f.run(
      registerSourceBinding(library, { skillPageId: skillId, mode: "create", fixedSource: source }),
    )
    const row = f.records[0]
    if (row === undefined) throw new Error("Missing registered record")
    const duplicate = { ...structuredClone(row), id: id(999) }
    changeStoredPayload(duplicate, (payload) => ({ ...payload, tree: "3".repeat(40) }))
    f.records.push(duplicate)
    const result = await f.run(
      resolveSourceBinding(library, {
        skillPageId: skillId,
        sourceId: registered.binding.source_id,
      }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected record conflict")
    expect(result.failure.code).toBe("SHARED_RECORD_CONFLICT")
  })

  test("schema version and undeclared payload fields cannot change the fixed contract silently", async () => {
    for (const change of [
      (payload: Record<string, unknown>) => ({ ...payload, version: 2 }),
      (payload: Record<string, unknown>) => ({ ...payload, selected_branch: "main" }),
    ]) {
      const f = fixture()
      const registered = await f.run(
        registerSourceBinding(library, {
          skillPageId: skillId,
          mode: "create",
          fixedSource: source,
        }),
      )
      const row = f.records[0]
      if (row === undefined) throw new Error("Missing registered record")
      changeStoredPayload(row, change)
      const result = await f.run(
        resolveSourceBinding(library, {
          skillPageId: skillId,
          sourceId: registered.binding.source_id,
        }).pipe(Effect.result),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") throw new Error("Expected invalid source schema")
      expect(result.failure.code).toBe("INVALID_SHARED_SOURCE")
    }
  })
})
