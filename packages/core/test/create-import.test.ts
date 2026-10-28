import {
  integrityRepositoryFixture,
  upstreamRepositoryFixture,
  publicationSourceRows,
  publicationSourceSchema,
} from "./fixtures.ts"
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ByteSize, Effect, FileSystem, Layer, Option, PlatformError } from "effect"
import { createPortable } from "../src/mutation.ts"
import type { PortableSkill } from "../src/portable.ts"
import { createSkill, replaceSkill, writeSkill, resumePublication } from "../src/mutation.ts"
import { reconcilePublication } from "../src/publication-reconcile.ts"
import { aliasFor, decode, fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { snapshotPortable } from "../src/export.ts"
import { cachedRemoteObservation } from "../src/cache.ts"
import { tarGzip } from "./fixtures.ts"
import { configureBuiltinDatabase, defineBuiltin, publishBuiltin } from "../src/builtin.ts"
import type { ContentKind } from "../src/model.ts"
import { MANIFEST, readPortable, portableZip } from "../src/portable.ts"
import { readImportZip } from "../src/import.ts"
import { UpstreamPublisher } from "../src/upstream-model.ts"
import { UpstreamPublisherLive } from "../src/upstream-publication.ts"
import { portableIdentity } from "../src/export.ts"
import { catalog } from "../src/catalog.ts"

const database = "12345678-1234-1234-1234-123456789abc"
const dataSource = "33333333-3333-4333-8333-333333333333"
const page = "87654321-1234-1234-1234-123456789abc"
const descriptionId = "notion%3A%2F%2Fskills%2Fdescription_property"
const filesId = "notion%3A%2F%2Fskills%2Ffiles_property"
const encoder = new TextEncoder()
let archive: Uint8Array = new Uint8Array()
const downloads = new Map<string, Uint8Array>()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const pathname = new URL(request.url).pathname
    const bytes = pathname === "/" ? archive : downloads.get(pathname)
    return bytes
      ? new Response(new Blob([new Uint8Array(bytes).buffer]))
      : new Response("Missing fixture upload", { status: 404 })
  },
})
afterAll(() => server.stop(true))

function fixture(replaceBody = false, kind: ContentKind = "skill") {
  const entrypoint = { skill: "SKILL.md", router: "ROUTER.md", prompt: "PROMPT.md" }[kind]
  let referencesAvailable = kind !== "skill"
  const second = "99999999-9999-4999-8999-999999999999"
  let pages: string[] = []
  const pageBodies = new Map<string, string>()
  const pageContexts = new Map<string, boolean>()
  let defaultContextAvailable = false
  let secondTitle = "Sample Workflow"
  let secondDescription = "Use for samples."
  let secondVersion = 0
  let secondPublication: unknown[] = []
  let secondFiles: Array<{ id: string; name: string; bytes: Uint8Array }> = []
  let exists = false
  let title = "Sample Workflow"
  let description = "Use for samples."
  let version = 0
  let mutations = 0
  let race = false
  let targetUnavailable = false
  const upstreamDatabase = "44444444-4444-4444-8444-444444444444"
  const upstreamDataSource = "55555555-5555-4555-8555-555555555555"
  let upstreamQueries = 0
  let files: Array<{ id: string; name: string; bytes: Uint8Array }> = []
  let publication: unknown[] = []
  let sourceSchema: Record<string, unknown> | undefined
  const writes: Array<{ path: string; body: unknown }> = []
  let sourceFault: "before" | "after" | "ack-read" | undefined
  let sourceReadInterrupted = false
  const memberId = "22222222-2222-4222-8222-222222222222"
  let memberDescription = "Member original metadata",
    memberMissing = false,
    memberSelected = false
  const managedProperties: Record<string, unknown> = {
    Upstream: { id: "Upstream", type: "relation", relation: [] },
    "Sync Mode": { id: "Sync Mode", type: "select", select: null },
    ...Object.fromEntries(
      ["Upstream Key", "Upstream Revision", "Published Hash", "Fork Baseline"].map((name) => [
        name,
        { id: name, type: "rich_text", rich_text: [] },
      ]),
    ),
  }
  const input = new Map([
    [
      entrypoint,
      encoder.encode(
        "---\nname: sample-workflow\ndescription: Use for samples.\ncompatibility: Bun\n---\n\n# Original\n",
      ),
    ],
    ["references/guide.md", encoder.encode("Original guide.\n")],
    ["assets/data.bin", new Uint8Array([0, 255, 7])],
  ])
  if (kind !== "skill")
    input.set(
      MANIFEST,
      encoder.encode(
        JSON.stringify({
          format: "ntn-skills",
          version: 2,
          kind,
          name: "Sample Workflow",
          description: "Use for samples.",
          main: entrypoint,
        }),
      ),
    )
  if (kind !== "skill") input.delete("references/guide.md")
  const objects = new Map<string, Uint8Array>()
  const json = new Map<string, unknown>()
  const stateRoot = mkdtempSync(join(tmpdir(), "create-import-"))
  const blocks: Array<Record<string, unknown>> = []
  const uploads = new Map<string, Uint8Array>()
  let upload = 0
  const row = (id = page) => ({
    id,
    last_edited_time: new Date(
      Date.UTC(2026, 9, 18) + (id === second ? secondVersion : version) * 1000,
    ).toISOString(),
    parent: { database_id: database, data_source_id: dataSource },
    properties: {
      Publication: {
        id: "publication",
        type: "rich_text",
        rich_text: id === second ? secondPublication : publication,
      },
      Kind: { id: "kind", type: "select", select: { name: kind } },
      Members: {
        id: "members",
        type: "relation",
        relation: memberSelected ? [{ id: memberId }] : [],
      },
      ...managedProperties,
      ...(referencesAvailable
        ? { References: { id: "references", type: "rich_text", rich_text: [] } }
        : {}),
      ...(defaultContextAvailable
        ? {
            "Default Context": {
              id: "default-context",
              type: "checkbox",
              checkbox: pageContexts.get(id) ?? false,
            },
          }
        : {}),
      Title: {
        id: "title",
        type: "title",
        title: [{ plain_text: id === second ? secondTitle : title }],
      },
      Description: {
        id: descriptionId,
        type: "rich_text",
        rich_text: [{ plain_text: id === second ? secondDescription : description }],
      },
      Files: {
        id: filesId,
        type: "files",
        files: (id === second ? secondFiles : files).map((file) => ({
          id: file.id,
          name: file.name,
          type: "file",
          file: {
            url: new URL(
              `/uploads/${file.bytes.length}/${encodeURIComponent(file.name)}`,
              server.url,
            ).href,
          },
        })),
      },
    },
  })
  const store = Layer.succeed(Store, {
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    root: stateRoot,
    configRoot: stateRoot,
    cacheRoot: stateRoot,
    reserveCacheGeneration: (() => {
      let generation = 0
      return () => Effect.sync(() => ++generation)
    })(),
    listKeys: (prefix) =>
      Effect.sync(() => [...json.keys()].filter((key) => key.startsWith(`${prefix}/`))),
    retireKeys: (keys) =>
      Effect.sync(() => {
        const retired: Array<{ key: string; retention_path: string }> = []
        for (const key of keys) {
          if (!key.startsWith("cache/")) continue
          json.delete(key)
          retired.push({ key, retention_path: "fixture_trash" })
        }
        return retired
      }),
    readJson: (key, schema) =>
      Effect.succeed(json.has(key) ? decode(schema, json.get(key)) : undefined),
    writeJson: (key, value) =>
      Effect.sync(() => {
        json.set(key, value)
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!)
        : Effect.fail(fail("SNAPSHOT_MISSING", "Missing object")),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, bytes)
      }),
    output: () => Effect.fail(fail("UNUSED", "unused")),
  })
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture-credential"),
    request: (path, payload, options) =>
      Effect.gen(function* () {
        if (
          options?.method === "PATCH" ||
          path === "v1/pages" ||
          path.startsWith("v1/file_uploads")
        )
          mutations++
        if (
          options?.method === "PATCH" ||
          path === "v1/pages" ||
          path.startsWith("v1/file_uploads")
        )
          writes.push({ path, body: structuredClone(payload) })
        if (path === "v1/users/me") return { id: "fixture-user", object: "user" }
        if (path === `v1/databases/${upstreamDatabase}`)
          return {
            id: upstreamDatabase,
            database_type: null,
            title: [{ plain_text: "Subscriptions" }],
            data_sources: [{ id: upstreamDataSource, name: "Subscriptions" }],
          }
        if (path === `v1/data_sources/${upstreamDataSource}`)
          return {
            id: upstreamDataSource,
            parent: { database_id: upstreamDatabase },
            title: [{ plain_text: "Subscriptions" }],
          }
        if (path === `v1/data_sources/${upstreamDataSource}/query`) {
          upstreamQueries++
          return {
            results: [
              {
                id: "66666666-6666-4666-8666-666666666666",
                parent: { database_id: upstreamDatabase, data_source_id: upstreamDataSource },
                properties: {
                  Name: { type: "title", title: [{ plain_text: "Historical partial" }] },
                  Status: { type: "select", select: { name: "partial" } },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }
        }
        if (path === `v1/pages/${memberId}`) {
          if (memberMissing)
            return yield* Effect.fail(fail("ACCESS_DENIED", "Member is unavailable"))
          return {
            id: memberId,
            parent: { database_id: database, data_source_id: dataSource },
            properties: {
              Title: { id: "title", type: "title", title: [{ plain_text: "Member Skill" }] },
              Description: { type: "rich_text", rich_text: [{ plain_text: memberDescription }] },
              Kind: { type: "select", select: { name: "skill" } },
            },
          }
        }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: "skills",
            title: [{ plain_text: "Skills" }],
            data_sources: [{ id: dataSource, name: "Skills" }],
          }
        if (path === `v1/data_sources/${dataSource}/query`) {
          if (targetUnavailable)
            return yield* Effect.fail(fail("ACCESS_DENIED", "Target content is unavailable"))
          return { results: pages.map((id) => row(id)), has_more: false, next_cursor: null }
        }
        if (path === `v1/data_sources/${dataSource}`)
          return { id: dataSource, properties: { ...row().properties, ...sourceSchema } }
        if (path === `v1/pages/${page}/properties/references?page_size=100`)
          return { object: "list", results: [], has_more: false, next_cursor: null }
        if (path === "v1/pages") {
          const createdId = pages.length ? second : page
          const props = property(property(payload).properties)
          const titleValue = text(
            property(props[String(property(row().properties.Title).id)] ?? props.title).title,
          )
          const descriptionValue = text(
            property(props.Description ?? props[descriptionId]).rich_text,
          )
          const contextWrite = props["Default Context"] ?? props["default-context"]
          if (contextWrite !== undefined && !defaultContextAvailable)
            return yield* Effect.fail(
              fail("UNEXPECTED", "Default Context was written without a checkbox property"),
            )
          if (createdId === second) {
            secondTitle = titleValue
            secondDescription = descriptionValue
            if (contextWrite !== undefined)
              pageContexts.set(second, property(contextWrite).checkbox === true)
          } else {
            title = titleValue
            description = descriptionValue
            if (contextWrite !== undefined)
              pageContexts.set(page, property(contextWrite).checkbox === true)
          }
          if (props.References) referencesAvailable = true
          for (const name of Object.keys(managedProperties))
            if (props[String(property(managedProperties[name]).id)])
              managedProperties[name] = {
                ...property(managedProperties[name]),
                ...property(props[String(property(managedProperties[name]).id)]),
              }
          const createdPublication = (
            (property(props.Publication ?? props.publication).rich_text as unknown[]) ?? []
          ).map((value) => ({
            ...property(value),
            plain_text: property(property(value).text).content,
          }))
          if (createdId === second) secondPublication = createdPublication
          else publication = createdPublication
          pages = [...pages, createdId]
          exists = true
          if (createdId === second) secondVersion++
          else version++
          return row(createdId)
        }
        if (path === `v1/pages/${page}`) {
          if (!exists) return yield* Effect.fail(fail("SKILL_NOT_FOUND", "Missing target"))
          if (
            sourceReadInterrupted &&
            payload === undefined &&
            (!options?.method || options.method === "GET")
          ) {
            sourceReadInterrupted = false
            return yield* Effect.fail(
              fail("ACCESS_DENIED", "Source PATCH acknowledged; follow-up GET interrupted"),
            )
          }
          if (options?.method === "PATCH") {
            const props = property(property(payload).properties)
            const fault = props["Source Type"] ? sourceFault : undefined
            if (fault) sourceFault = undefined
            if (fault === "before")
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Lost source metadata request before apply"),
              )
            for (const name of Object.keys(managedProperties))
              if (props[String(property(managedProperties[name]).id)])
                managedProperties[name] = {
                  ...property(managedProperties[name]),
                  ...property(props[String(property(managedProperties[name]).id)]),
                }
            if (fault === "after") {
              version++
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Lost source metadata response after apply"),
              )
            }
            if (fault === "ack-read") sourceReadInterrupted = true
            if (props.Publication ?? props.publication) {
              publication = (
                property(props.Publication ?? props.publication).rich_text as unknown[]
              ).map((value) => ({
                ...property(value),
                plain_text: property(property(value).text).content,
              }))
              version++
              return row()
            }
            if (props.members)
              memberSelected = (property(props.members).relation as unknown[]).length > 0
            if (props.title)
              title = String(
                property(property((property(props.title).title as unknown[])[0]).text).content,
              )
            if (props["Default Context"] ?? props["default-context"])
              pageContexts.set(
                page,
                property(props["Default Context"] ?? props["default-context"]).checkbox === true,
              )
            if (props[descriptionId] ?? props.Description)
              description = text(property(props[descriptionId] ?? props.Description).rich_text)
            if (props[filesId])
              files = (property(props[filesId]).files as unknown[]).map((value) => {
                const file = property(value)
                const bytes = uploads.get(String(property(file.file_upload).id))!
                downloads.set(
                  `/uploads/${bytes.length}/${encodeURIComponent(String(file.name))}`,
                  bytes,
                )
                return {
                  id: String(property(file.file_upload).id),
                  name: String(file.name),
                  bytes,
                }
              })
            version++
          }
          return row()
        }
        if (path === `v1/pages/${second}`) {
          if (!pages.includes(second))
            return yield* Effect.fail(fail("SKILL_NOT_FOUND", "Missing target"))
          if (options?.method === "PATCH") {
            const props = property(property(payload).properties)
            if (props.Publication ?? props.publication) {
              secondPublication = (
                property(props.Publication ?? props.publication).rich_text as unknown[]
              ).map((value) => ({
                ...property(value),
                plain_text: property(property(value).text).content,
              }))
              secondVersion++
            }
            if (props.title)
              secondTitle = String(
                property(property((property(props.title).title as unknown[])[0]).text).content,
              )
            if (props["Default Context"] ?? props["default-context"])
              pageContexts.set(
                second,
                property(props["Default Context"] ?? props["default-context"]).checkbox === true,
              )
            if (props[descriptionId] ?? props.Description)
              secondDescription = text(
                property(props[descriptionId] ?? props.Description).rich_text,
              )
            if (props[filesId])
              secondFiles = (property(props[filesId]).files as unknown[]).map((value) => {
                const file = property(value),
                  bytes = uploads.get(String(property(file.file_upload).id))!
                downloads.set(
                  `/uploads/${bytes.length}/${encodeURIComponent(String(file.name))}`,
                  bytes,
                )
                return { id: String(property(file.file_upload).id), name: String(file.name), bytes }
              })
            if (!(props.Publication ?? props.publication)) secondVersion++
          }
          return row(second)
        }
        if (path === `v1/pages/${second}/markdown`) {
          if (options?.method === "PATCH") {
            const content = property(payload)
            const current = pageBodies.get(second) ?? ""
            const next =
              content.type === "update_content"
                ? String(
                    property(
                      property(property(content.update_content).content_updates as unknown[])[0],
                    ).new_str,
                  )
                : String(property(content.replace_content).new_str)
            if (
              content.type === "update_content" &&
              property(property(property(content.update_content).content_updates as unknown[])[0])
                .old_str !== current
            )
              return yield* Effect.fail(fail("WRITE_CONFLICT", "Body changed"))
            pageBodies.set(second, next)
            secondVersion++
          }
          return {
            object: "page_markdown",
            markdown: pageBodies.get(second) ?? "",
            truncated: false,
            unknown_block_ids: [],
          }
        }
        if (path === `v1/pages/${page}/markdown`) {
          if (options?.method === "PATCH") {
            const content = property(payload)
            const current = pageBodies.get(page) ?? ""
            if (content.type === "update_content") {
              const change = property(
                (property(content.update_content).content_updates as unknown[])[0],
              )
              if (change.old_str !== current)
                return yield* Effect.fail(fail("WRITE_CONFLICT", "Body changed"))
              pageBodies.set(page, String(change.new_str))
            } else {
              pageBodies.set(page, String(property(content.replace_content).new_str))
              for (const block of blocks) block.archived = true
            }
            version++
            if (replaceBody) pageBodies.set(page, "# Silently replaced instructions\n")
          }
          return {
            object: "page_markdown",
            markdown: pageBodies.get(page) ?? "",
            truncated: false,
            unknown_block_ids: [],
          }
        }
        const blockPath = /^v1\/blocks\/([^/?]+)(\/children)?(?:\?.*)?$/.exec(path)
        if (blockPath) {
          const id = blockPath[1]!
          const block = blocks.find((block) => block.id === id)
          if (blockPath[2]) {
            if (options?.method === "PATCH") {
              const append = (parent: string, raw: unknown): Record<string, unknown> => {
                const input = property(raw),
                  type = String(input.type),
                  data = structuredClone(property(input[type]))
                const nested = data.children
                delete data.children
                const value = {
                  ...input,
                  id: crypto.randomUUID(),
                  [type]: data,
                  has_children: Array.isArray(nested) && nested.length > 0,
                  parent:
                    parent === page
                      ? { type: "page_id", page_id: parent }
                      : { type: "block_id", block_id: parent },
                }
                blocks.push(value)
                if (Array.isArray(nested)) for (const child of nested) append(value.id, child)
                return value
              }
              const appended = (property(payload).children as unknown[]).map((raw) =>
                append(id, raw),
              )
              if (block) block.has_children = true
              version++
              return { results: appended, has_more: false, next_cursor: null }
            }
            return {
              results: blocks.filter(
                (value) =>
                  !value.archived &&
                  (property(value.parent).page_id ?? property(value.parent).block_id) === id,
              ),
              has_more: false,
              next_cursor: null,
            }
          }
          if (block) {
            if (options?.method === "PATCH") {
              Object.assign(block, property(payload))
              version++
            }
            return block
          }
        }
        if (path === "v1/file_uploads")
          return { id: `88888888-8888-4888-8888-${String(++upload).padStart(12, "0")}` }
        if (path.startsWith("v1/file_uploads/") && path.endsWith("/send")) {
          uploads.set(path.split("/")[2]!, objects.get(options!.file!.slice(stateRoot.length + 1))!)
          if (race) {
            version++
            pageBodies.set(page, "Concurrent body.\n")
          }
          return { status: "uploaded" }
        }
        if (path === `v1/ai/skills/${page}` || path === `v1/ai/skills/${second}`) {
          const selected = path.endsWith(second)
          const selectedId = selected ? second : page
          const selectedTitle = selected ? secondTitle : title
          const selectedDescription = selected ? secondDescription : description
          const selectedBody = pageBodies.get(selectedId) ?? ""
          const selectedFiles = selected ? secondFiles : files
          const selectedVersion = selected ? secondVersion : version
          const alias = aliasFor(selectedTitle)
          archive = tarGzip([
            {
              name: `${alias}/SKILL.md`,
              content: `---\nname: ${alias}\ndescription: ${selectedDescription}\n---\n\n${selectedBody}`,
            },
            ...selectedFiles.map((file) => ({
              name: `${alias}/${file.name}`,
              content: file.bytes,
            })),
          ])
          return { id: selectedId, version_id: `v-${selectedVersion}`, url: server.url.href }
        }
        return yield* Effect.fail(fail("UNEXPECTED", "Unexpected request", { path }))
      }),
  })
  const fs = FileSystem.makeNoop({
    stat: (path) =>
      Effect.succeed({
        type: path === "/input" ? "Directory" : "File",
        mtime: Option.none(),
        atime: Option.none(),
        birthtime: Option.none(),
        dev: 1n,
        ino: Option.none(),
        mode: 0o600,
        nlink: Option.none(),
        uid: Option.none(),
        gid: Option.none(),
        rdev: Option.none(),
        size: ByteSize.bytes(10),
        blksize: Option.none(),
        blocks: Option.none(),
      }),
    readDirectory: () => Effect.succeed([...input.keys()]),
    readFile: (path) =>
      input.has(path.slice("/input/".length))
        ? Effect.succeed(input.get(path.slice("/input/".length))!)
        : Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFile",
              pathOrDescriptor: path,
            }),
          ),
  })
  const live = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    api,
    store,
    Layer.succeed(FileSystem.FileSystem, fs),
  )
  return {
    run: <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromise(effect.pipe(Effect.provide(live)) as Effect.Effect<A, E>),
    runPublisher: <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromise(
        effect.pipe(Effect.provide(UpstreamPublisherLive), Effect.provide(live)) as Effect.Effect<
          A,
          E
        >,
      ),
    input,
    configure: (value: unknown) => json.set("config.json", value),
    enableSource: () => {
      sourceSchema = structuredClone(publicationSourceSchema)
      Object.assign(managedProperties, structuredClone(publicationSourceRows))
    },
    sourceSchema: (fields: Record<string, unknown>) => {
      sourceSchema = fields
    },
    renameSource: () => {
      sourceSchema = {
        RenamedOrigin: structuredClone(publicationSourceSchema["Source Type"]),
        RenamedBuiltin: structuredClone(publicationSourceSchema["Builtin ID"]),
      }
      managedProperties.RenamedOrigin = managedProperties["Source Type"]
      managedProperties.RenamedBuiltin = managedProperties["Builtin ID"]
      delete managedProperties["Source Type"]
      delete managedProperties["Builtin ID"]
    },
    source: () =>
      structuredClone({
        type: managedProperties["Source Type"] ?? managedProperties.RenamedOrigin,
        builtin: managedProperties["Builtin ID"] ?? managedProperties.RenamedBuiltin,
      }),
    writes,
    receipts: json,
    interruptSource: (fault: "before" | "after" | "ack-read") => {
      sourceFault = fault
    },
    editSource: () => {
      managedProperties["Source Type"] = {
        ...property(managedProperties["Source Type"]),
        select: { name: "upstream" },
      }
    },
    body: () =>
      (pageBodies.get(page) ?? "") +
      blocks
        .filter((block) => block.type === "code" && !block.archived)
        .map((block) =>
          (property(block.code).rich_text as unknown[])
            .map((span) => property(property(span).text).content)
            .join(""),
        )
        .join("\n"),
    mutations: () => mutations,
    pages: () => [...pages],
    partialUpstream: () => json.set("config.json", { upstream_database: upstreamDatabase }),
    upstreamQueries: () => upstreamQueries,
    hideTarget: () => {
      targetUnavailable = true
    },
    defaultContext: (enabled = true) => {
      defaultContextAvailable = enabled
    },
    changeMember: () => {
      memberDescription = "Member updated metadata"
    },
    hideMember: () => {
      memberMissing = true
    },
    race: () => {
      race = true
    },
  }
}

test("create uses authoritative target content while normal discovery retains partial upstream failures", async () => {
  const f = fixture()
  f.partialUpstream()
  const normal = await f.run(catalog({ database, refresh: true }))
  expect(normal.coverage.failed_sources.length).toBe(1)
  expect(normal.coverage.exhaustive).toBe(false)
  const queries = f.upstreamQueries()
  expect(queries).toBe(1)
  const created = await f.run(createSkill("/input", { database }))
  expect(created.action).toBe("create")
  expect(f.upstreamQueries()).toBe(queries)
  const before = f.mutations()
  const conflict = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  expect(conflict._tag === "Failure" && conflict.failure.code).toBe("CREATE_CONFLICT")
  expect(f.mutations()).toBe(before)
})

test("ordinary create rejects a same invocation while explicit member rebuild creates another page", async () => {
  const f = fixture()
  f.defaultContext()
  const first = await f.run(createSkill("/input", { database }))
  expect(first.action).toBe("create")
  expect("record" in first && first.record.default_context).toBe(false)
  const original = f.pages()
  expect(original).toEqual([page])
  const before = f.mutations()
  const rejected = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  expect(rejected._tag === "Failure" && rejected.failure.code).toBe("CREATE_CONFLICT")
  expect(f.pages()).toEqual(original)
  expect(f.mutations()).toBe(before)
  const originalWrites = f.writes.filter((write) => write.path === `v1/pages/${page}`)
  const portable: PortableSkill = {
    kind: "skill",
    name: "Sample Workflow",
    description: "Use for samples.",
    main: "SKILL.md",
    files: [{ path: "SKILL.md", bytes: f.input.get("SKILL.md")! }],
  }
  const missing = fixture()
  const unavailable = await missing.run(
    createPortable(portable, { database, allowSameName: true, defaultContext: true }).pipe(
      Effect.result,
    ),
  )
  expect(unavailable._tag === "Failure" && unavailable.failure.code).toBe("PROPERTY_UNAVAILABLE")
  expect(missing.pages()).toEqual([])
  const rebuilt = await f.run(
    createPortable(portable, { database, allowSameName: true, defaultContext: true }),
  )
  expect(rebuilt.action).toBe("create")
  expect(
    "record" in rebuilt &&
      rebuilt.record.locator.type === "notion_page" &&
      rebuilt.record.locator.page_id,
  ).toBe("99999999-9999-4999-8999-999999999999")
  expect("record" in rebuilt && rebuilt.record.default_context).toBe(true)
  const opened = await f.run(openSkill("99999999-9999-4999-8999-999999999999"))
  expect(opened.record.default_context).toBe(true)
  const reread = await f.run(readSkill(opened.snapshot_id))
  expect("record" in reread && reread.record.default_context).toBe(true)
  const retained = await f.run(openSkill(page))
  expect(retained.record.default_context).toBe(false)
  expect(f.pages()).toEqual([page, "99999999-9999-4999-8999-999999999999"])
  const originalPage = f.writes.filter((write) => write.path === `v1/pages/${page}`)
  expect(originalPage).toEqual(originalWrites)
})

for (const name of ["Tty7", "n8n-workflow", "React19", "中文", "Agent Workflow"]) {
  test(`create preserves the authored display name ${name}`, async () => {
    const f = fixture()
    const source = encoder.encode(
      `---\nname: ${JSON.stringify(name)}\ndescription: Use this workflow\n---\n\n# Original\n`,
    )
    f.input.set("SKILL.md", source)
    const created = await f.run(createSkill("/input", { database }))
    expect("record" in created && created.record.name).toBe(name)
    const exported = await f.run(snapshotPortable(await f.run(openSkill(page))))
    expect(exported.name).toBe(name)
    expect(exported.files.find((file) => file.path === exported.main)?.bytes).toEqual(source)
  })
}

test("create refuses incomplete target content before mutation even with unrelated partial upstream", async () => {
  const f = fixture()
  f.partialUpstream()
  f.hideTarget()
  const result = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure.code).toBe("CATALOG_INCOMPLETE")
  expect(f.mutations()).toBe(0)
  expect(f.upstreamQueries()).toBe(0)
})

test("create rejects existing names; explicit replace reuses or replaces the selected page and file set", async () => {
  const f = fixture()
  const first = await f.run(createSkill("/input", { database }))
  expect(first.action).toBe("create")
  expect("record" in first && first.record.id).toBe(`notion_page:${page}`)
  const original = await f.run(readSkill(first.snapshot_id!, { path: "references/guide.md" }))
  expect("content" in original && original.content).toBe("Original guide.\n")
  const before = f.mutations()
  const conflict = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  expect(conflict._tag === "Failure" && conflict.failure.code).toBe("CREATE_CONFLICT")
  const reused = await f.run(replaceSkill("/input", { database, target: page }))
  expect(reused.operation).toBe("replace")
  expect(reused.action).toBe("reuse")
  expect(reused.reused).toBe(true)
  expect(f.mutations()).toBe(before)
  f.input.set(
    "SKILL.md",
    encoder.encode("---\nname: sample-workflow\ndescription: Use for samples.\n---\n\n# Updated\n"),
  )
  f.input.delete("references/guide.md")
  f.input.set("references/new.md", encoder.encode("New guide.\n"))
  const preview = await f.run(
    replaceSkill("/input", {
      database,
      target: `https://www.notion.so/${page.replaceAll("-", "")}`,
      dryRun: true,
    }),
  )
  expect(preview.action).toBe("update")
  expect(f.mutations()).toBe(before)
  const updated = await f.run(replaceSkill("/input", { database, target: page }))
  expect(updated.action).toBe("update")
  expect("record" in updated && updated.record.id).toBe(`notion_page:${page}`)
  expect(f.body()).toBe("# Updated\n")
  const removed = await f.run(
    readSkill(updated.snapshot_id!, { path: "references/guide.md" }).pipe(Effect.result),
  )
  expect(removed._tag === "Failure" && removed.failure.code).toBe("FILE_NOT_FOUND")
  const historical = await f.run(readSkill(first.snapshot_id!, { path: "references/guide.md" }))
  expect("content" in historical && historical.content).toBe("Original guide.\n")
})

test("publication rejects altered live instructions despite an intact source bundle", async () => {
  const f = fixture(true)
  const result = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw new Error("Expected saved-content rejection")
  expect(result.failure.code).toBe("WRITE_PARTIAL")
  expect(property(result.failure.details).cause_code).toBe("WRITE_VERIFICATION_FAILED")
  const repeated = await f.run(
    replaceSkill("/input", { database, target: page }).pipe(Effect.result),
  )
  expect(repeated._tag).toBe("Failure")
})

test("replace refuses a concurrent change before committing an uploaded source bundle", async () => {
  const f = fixture()
  await f.run(createSkill("/input", { database }))
  const baseline = await f.run(openSkill(page, { refresh: true }))
  expect(await f.run(cachedRemoteObservation(page, baseline.scope))).toBeDefined()
  f.input.set("references/guide.md", encoder.encode("Updated guide.\n"))
  f.race()
  const result = await f.run(replaceSkill("/input", { database, target: page }).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure).toMatchObject({
    code: "WRITE_PARTIAL",
    details: { cause_code: "WRITE_CONFLICT", page_id: page },
  })
  expect(f.body()).toBe("Concurrent body.\n")
  expect(await f.run(cachedRemoteObservation(page, baseline.scope))).toBeUndefined()
})

test("explicit pinned replace renames only its selected page and rejects stale baselines", async () => {
  const f = fixture()
  const first = await f.run(createSkill("/input", { database }))
  const baseline = await f.run(openSkill(page, { refresh: true }))
  const unchanged = await f.run(
    replaceSkill(await f.run(snapshotPortable(baseline)), { target: baseline }),
  )
  expect(unchanged.action).toBe("reuse")
  f.input.set(
    "SKILL.md",
    encoder.encode(
      "---\nname: renamed-workflow\ndescription: Use for renamed samples.\n---\n\n# Renamed\n",
    ),
  )
  const updated = await f.run(replaceSkill("/input", { database, target: first.snapshot_id! }))
  expect(updated.action).toBe("update")
  expect("record" in updated && updated.record.id).toBe(`notion_page:${page}`)
  expect("record" in updated && updated.record.name).toBe("renamed-workflow")
  expect(updated.previous_version_id).toBe(baseline.version_id)
  const observed = await f.run(cachedRemoteObservation(page, baseline.scope))
  expect(observed?.snapshot.snapshot_id).toBe(updated.snapshot_id)
  const before = f.mutations()
  const stale = await f.run(
    replaceSkill("/input", { target: first.snapshot_id! }).pipe(Effect.result),
  )
  expect(stale._tag === "Failure" && stale.failure.code).toBe("WRITE_CONFLICT")
  expect(f.mutations()).toBe(before)
})

test("explicit replace rejects names, missing, reference-file, foreign-scope and wrong-database targets without creation", async () => {
  const f = fixture()
  const missing = await f.run(
    replaceSkill("/input", { target: page, database }).pipe(Effect.result),
  )
  expect(missing._tag === "Failure" && missing.failure.code).toBe("SKILL_NOT_FOUND")
  expect(f.mutations()).toBe(0)
  const first = await f.run(createSkill("/input", { database }))
  const before = f.mutations()
  const absent = await f.run(
    replaceSkill("/input", {} as Parameters<typeof replaceSkill>[1]).pipe(Effect.result),
  )
  expect(absent._tag === "Failure" && absent.failure.code).toBe("EXACT_TARGET_REQUIRED")
  for (const target of ["Sample Workflow", "sample-workflow", `skill://sample-workflow/SKILL.md`]) {
    const named = await f.run(replaceSkill("/input", { target, database }).pipe(Effect.result))
    expect(named._tag === "Failure" && named.failure.code).toBe("EXACT_TARGET_REQUIRED")
  }
  const reference = await f.run(
    replaceSkill("/input", {
      target: `skill://${page}/references/guide.md?snapshot=${first.snapshot_id}`,
    }).pipe(Effect.result),
  )
  expect(reference._tag === "Failure" && reference.failure.code).toBe("EXACT_TARGET_REQUIRED")
  const baseline = await f.run(openSkill(page, { refresh: true }))
  const portable = await f.run(snapshotPortable(baseline))
  const foreign = await f.run(
    replaceSkill(portable, { target: { ...baseline, scope: "foreign" } }).pipe(Effect.result),
  )
  expect(foreign._tag === "Failure" && foreign.failure.code).toBe("SNAPSHOT_CONFLICT")
  const wrongDatabase = await f.run(
    replaceSkill("/input", {
      target: first.snapshot_id!,
      database: "99999999-9999-4999-8999-999999999999",
    }).pipe(Effect.result),
  )
  expect(wrongDatabase._tag === "Failure" && wrongDatabase.failure.code).toBe("SKILL_NOT_FOUND")
  expect(f.mutations()).toBe(before)
})

test("built-in publication rejects same-name pages and updates only explicit versioned identities", async () => {
  const f = fixture()
  f.enableSource()
  const builtin = defineBuiltin(
    "notion/sample-workflow",
    "test",
    [...f.input].map(([path, bytes]) => ({ path, bytes })),
  )
  f.configure({
    sources: [],
    builtin_database: database,
    default_database: "99999999-9999-4999-8999-999999999999",
  })
  const preview = await f.run(publishBuiltin(builtin, { dryRun: true }))
  expect(preview.action).toBe("create")
  expect(f.mutations()).toBe(0)
  const first = await f.run(publishBuiltin(builtin))
  expect("record" in first && first.record.id).toBe(`notion_page:${page}`)
  const before = f.mutations()
  const collision = await f.run(publishBuiltin(builtin).pipe(Effect.result))
  expect(collision._tag === "Failure" && collision.failure.code).toBe("CREATE_CONFLICT")
  const named = await f.run(
    publishBuiltin(builtin, { target: "Sample Workflow" }).pipe(Effect.result),
  )
  expect(named._tag === "Failure" && named.failure.code).toBe("EXACT_TARGET_REQUIRED")
  expect(f.mutations()).toBe(before)
  f.configure({ sources: [], builtin_database: "99999999-9999-4999-8999-999999999999" })
  const updatedBuiltin = defineBuiltin(
    "notion/sample-workflow",
    "test-next",
    builtin.portable.files.map((file) =>
      file.path === "SKILL.md"
        ? {
            ...file,
            bytes: encoder.encode(
              "---\nname: sample-workflow\ndescription: Use for samples.\n---\n\n# New official content\n",
            ),
          }
        : file,
    ),
  )
  const updated = await f.run(publishBuiltin(updatedBuiltin, { target: first.snapshot_id! }))
  expect(updated.action).toBe("update")
  expect("record" in updated && updated.record.id).toBe(`notion_page:${page}`)
  expect(f.body()).toBe("# New official content\n")
  const stale = await f.run(
    publishBuiltin(builtin, { target: first.snapshot_id! }).pipe(Effect.result),
  )
  expect(stale._tag === "Failure" && stale.failure.code).toBe("WRITE_CONFLICT")
})

test("built-in database preferences validate aliases and preserve unrelated configuration", async () => {
  const f = fixture()
  f.configure({
    token: "private-fixture-token",
    sources: [
      { database_id: database, alias: "library", title: "Skills", data_source_ids: [dataSource] },
    ],
    default_database: database,
    cache_policy: { read_max_age_ms: 12, catalog_max_age_ms: 34 },
  })
  const configured = await f.run(configureBuiltinDatabase("library"))
  expect(configured.builtin_database).toBe(database)
  expect(configured.default_database).toBe(database)
  expect(configured.token_configured).toBe(true)
  expect(configured).not.toHaveProperty("token")
  const invalid = await f.run(configureBuiltinDatabase("unknown").pipe(Effect.result))
  expect(invalid._tag === "Failure" && invalid.failure.code).toBe("DATABASE_NOT_FOUND")
  const cleared = await f.run(configureBuiltinDatabase())
  expect(cleared).not.toHaveProperty("builtin_database")
  expect(cleared.sources).toEqual(configured.sources)
  expect(cleared.cache_policy).toEqual(configured.cache_policy)
  expect(cleared.token_configured).toBe(true)
})

for (const [kind, entrypoint] of [
  ["skill", "SKILL.md"],
  ["router", "ROUTER.md"],
  ["prompt", "PROMPT.md"],
] as const) {
  test(`${kind} source bundle survives create read export and unchanged replace`, async () => {
    const f = fixture(false, kind)
    const created = await f.run(createSkill("/input", { database }))
    if (!("record" in created)) throw new Error("Expected a created content record")
    expect(created.record).toMatchObject({ kind, entrypoint, id: `notion_page:${page}` })
    const snapshot = await f.run(openSkill(page, { refresh: true }))
    expect(snapshot.entrypoint).toBe(entrypoint)
    expect(snapshot.record.entrypoint).toBe(entrypoint)
    const read = await f.run(readSkill(snapshot.snapshot_id))
    if (!("path" in read)) throw new Error("Expected the record entrypoint read")
    expect(read.path).toBe(entrypoint)
    const portable = await f.run(snapshotPortable(snapshot))
    expect(portable.kind).toBe(kind)
    expect(portable.main).toBe(entrypoint)
    for (const file of portable.files) {
      if (kind === "router" && file.path === entrypoint) {
        expect(new TextDecoder().decode(file.bytes)).toContain("# Original")
        expect(new TextDecoder().decode(file.bytes)).toContain("## Members")
        expect(portable.projection?.body.trim()).toBe("# Original")
      } else expect(file.bytes).toEqual(f.input.get(file.path)!)
    }
    const exported = readPortable(readImportZip(portableZip(portable, kind === "router")))!
    expect(exported.kind).toBe(kind)
    expect(exported.main).toBe(entrypoint)
    expect(exported.files).toEqual(portable.files)
    const before = f.mutations()
    const replaced = await f.run(replaceSkill(portable, { target: snapshot }))
    expect(replaced).toMatchObject({ action: "reuse", reused: true, record: { kind, entrypoint } })
    expect(f.mutations()).toBe(before)
    const duplicate = await f.run(createSkill("/input", { database }).pipe(Effect.result))
    expect(duplicate._tag === "Failure" && duplicate.failure.code).toBe("CREATE_CONFLICT")
  })
}

test("Router Members remain metadata only, refresh versions after member edits and fail on inaccessible members", async () => {
  const f = fixture(false, "router")
  await f.run(
    createSkill("/input", { database, members: ["22222222-2222-4222-8222-222222222222"] }),
  )
  const first = await f.run(openSkill(page, { refresh: true }))
  const main = await f.run(readSkill(first.snapshot_id))
  expect("content" in main && main.content).toContain("Member original metadata")
  expect(first.references).toHaveLength(1)
  expect(first.references![0]!.markdown).toBe("# Original\n")
  f.changeMember()
  const changed = await f.run(openSkill(page, { refresh: true }))
  expect(changed.snapshot_id).not.toBe(first.snapshot_id)
  expect(changed.version_id).not.toBe(first.version_id)
  const read = await f.run(readSkill(changed.snapshot_id))
  expect("content" in read && read.content).toContain("Member updated metadata")
  f.hideMember()
  const missing = await f.run(openSkill(page, { refresh: true }).pipe(Effect.result))
  expect(missing._tag === "Failure" && missing.failure.code).toBe("ACCESS_DENIED")
})

test("official upstream publisher updates the existing tracked page after a source change and rejects stale observations", async () => {
  const f = fixture()
  f.enableSource()
  const make = (body: string) => ({
    kind: "skill" as const,
    name: "Sample",
    description: "desc",
    main: "SKILL.md",
    files: [
      {
        path: "SKILL.md",
        bytes: encoder.encode(`---\nname: Sample\ndescription: desc\n---\n\n${body}\n`),
      },
    ],
  })
  await f.runPublisher(
    Effect.gen(function* () {
      const publisher = yield* UpstreamPublisher
      const first = make("first source"),
        second = make("second source")
      const ownership = {
        subscription_id: "11111111-1111-4111-8111-111111111111",
        member_key: "alpha",
        mode: "tracked" as const,
        published_hash: yield* portableIdentity(first),
        revision: "rev1",
      }
      const created = yield* publisher.publish({
        operation_id: "p_upstream-first",
        target_database_id: database,
        portable: first,
        ownership,
      })
      const current = yield* publisher.inspect(created.page_id)
      const updated = yield* publisher.publish({
        operation_id: "p_upstream-second",
        target_database_id: database,
        portable: second,
        ownership: {
          ...ownership,
          published_hash: yield* portableIdentity(second),
          revision: "rev2",
        },
        expected: {
          page_id: current.page_id,
          version: current.version,
          hash: current.content_hash,
        },
      })
      expect(updated.page_id).toBe(created.page_id)
      expect(updated.verified).toBe(true)
      expect(f.body()).toContain("second source")
      const stale = yield* publisher
        .publish({
          operation_id: "p_upstream-stale",
          target_database_id: database,
          portable: first,
          ownership,
          expected: {
            page_id: current.page_id,
            version: current.version,
            hash: current.content_hash,
          },
        })
        .pipe(Effect.result)
      expect(stale._tag === "Failure" && stale.failure.code).toBe("WRITE_CONFLICT")
    }),
  )
})

test("new ordinary publication classifies manual, while replace and write preserve builtin origin", async () => {
  const f = fixture()
  f.enableSource()
  const created = await f.run(createSkill("/input", { database }))
  expect(property(f.source().type).select).toEqual({ name: "manual" })
  expect(property(f.source().builtin).rich_text).toEqual([])
  expect("record" in created && created.record).not.toHaveProperty("source_type")
  const builtin = defineBuiltin(
    "notion/sample-workflow",
    "test",
    [...f.input].map(([path, bytes]) => ({ path, bytes })),
  )
  const start = f.writes.length
  const preview = await f.run(publishBuiltin(builtin, { target: page, dryRun: true }))
  expect(preview).toMatchObject({ action: "update", reused: false })
  expect(f.writes.length).toBe(start)
  const classified = await f.run(publishBuiltin(builtin, { target: page }))
  expect(classified).toMatchObject({ action: "update", reused: false })
  expect(f.writes.slice(start).every((write) => write.path === `v1/pages/${page}`)).toBe(true)
  expect(property(f.source().type).select).toEqual({ name: "builtin" })
  expect(property(f.source().builtin).rich_text).toEqual([
    { type: "text", text: { content: builtin.id } },
  ])
  const beforeRepeat = f.mutations()
  expect(await f.run(publishBuiltin(builtin, { target: page, dryRun: true }))).toMatchObject({
    action: "reuse",
    reused: true,
  })
  expect(await f.run(publishBuiltin(builtin, { target: page }))).toMatchObject({
    action: "reuse",
    reused: true,
  })
  expect(await f.run(replaceSkill("/input", { target: page }))).toMatchObject({
    action: "reuse",
    reused: true,
  })
  expect(f.mutations()).toBe(beforeRepeat)
  const origin = f.source()
  f.input.set(
    "SKILL.md",
    encoder.encode(
      "---\nname: sample-workflow\ndescription: Use for samples.\n---\n\n# Local edit\n",
    ),
  )
  await f.run(writeSkill(page, { input: "/input/SKILL.md", database }))
  expect(f.source()).toEqual(origin)
})

for (const historical of [false, true])
  test(`legacy ${historical ? "old receipt" : "frozen unavailable"} never acquires source on resume`, async () => {
    const f = fixture()
    const created = await f.run(createSkill("/input", { database }))
    const receipt = property(f.receipts.get(`publications/${created.operation_id}.json`))
    expect(receipt.source_binding).toMatchObject({
      status: "unavailable",
      data_source_id: dataSource,
    })
    if (historical) {
      delete property(receipt.context).source_intent
      delete receipt.source_binding
    }
    f.enableSource()
    const before = f.mutations()
    await f.run(resumePublication(created.operation_id))
    expect(f.mutations()).toBe(before)
    expect(property(f.source().type).select).toBeNull()
    expect(property(f.source().builtin).rich_text).toEqual([])
  })

for (const invalid of ["missing", "extra-choice", "wrong-type", "partial"] as const)
  test(`explicit source refuses ${invalid} schema before mutation`, async () => {
    const f = fixture()
    f.configure({ default_database: database })
    const builtin = defineBuiltin(
      "notion/sample-workflow",
      "test",
      [...f.input].map(([path, bytes]) => ({ path, bytes })),
    )
    if (invalid !== "missing") {
      const fields: Record<string, unknown> = structuredClone(publicationSourceSchema)
      if (invalid === "extra-choice")
        property(fields["Source Type"]).select = {
          options: [
            { name: "builtin" },
            { name: "upstream" },
            { name: "manual" },
            { name: "guessed" },
          ],
        }
      if (invalid === "wrong-type")
        fields["Builtin ID"] = { id: "builtin", type: "checkbox", checkbox: {} }
      if (invalid === "partial") delete fields["Builtin ID"]
      f.sourceSchema(fields)
    }
    const result = await f.run(publishBuiltin(builtin).pipe(Effect.result))
    expect(result._tag === "Failure" && result.failure.code).toBe("DATABASE_SCHEMA_CONFLICT")
    expect(result._tag === "Failure" && result.failure.message).toContain("ctl database init")
    expect(f.mutations()).toBe(0)
  })

for (const [storage, fault, reconcile] of [
  ["notion_blocks", "before", false],
  ["notion_blocks", "after", false],
  ["notion_blocks", "ack-read", false],
  ["notion_blocks", "ack-read", true],
  ["markdown_files", "ack-read", false],
  ["markdown_files", "ack-read", true],
] as const)
  test(`${storage} builtin metadata ${fault}${reconcile ? "-reconcile" : ""} interruption resumes exact frozen values without uploading content`, async () => {
    const f = fixture()
    if (storage === "markdown_files")
      f.input.set("assets/data.bin", encoder.encode("Editable UTF-8 resource.\n"))
    await f.run(createSkill("/input", { database, storage }))
    f.enableSource()
    const builtin = defineBuiltin(
      "notion/sample-workflow",
      "test",
      [...f.input].map(([path, bytes]) => ({ path, bytes })),
    )
    const start = f.writes.length
    f.interruptSource(fault)
    const interrupted = await f.run(publishBuiltin(builtin, { target: page }).pipe(Effect.result))
    expect(interrupted._tag).toBe("Failure")
    if (interrupted._tag !== "Failure") throw new Error("Expected source transport interruption")
    const operationId = String(property(interrupted.failure.details).operation_id)
    const frozen = structuredClone(property(f.receipts.get(`publications/${operationId}.json`)))
    const sourceIndex = (frozen.intents as unknown[]).findIndex(
      (intent) => property(property(property(intent).body).properties)["Source Type"] !== undefined,
    )
    const sourceIntent = property((frozen.intents as unknown[])[sourceIndex])
    if (fault === "ack-read") {
      expect(sourceIndex).toBeGreaterThanOrEqual(0)
      expect(sourceIntent.status).toBe("completed")
      expect(sourceIntent.response).toMatchObject({ id: page })
    }
    const override = await f.run(
      resumePublication(operationId, {
        source: { type: "builtin", builtinId: "notion/other" },
      }).pipe(Effect.result),
    )
    expect(override._tag === "Failure" && override.failure.code).toBe("INVALID_ARGUMENT")
    f.renameSource()
    if (reconcile) {
      const writes = f.mutations()
      const observed = await f.run(reconcilePublication(operationId))
      expect([
        "success",
        storage === "markdown_files" ? "needs_safe_resume" : "needs_safe_commit",
      ]).toContain(observed.outcome)
      expect(f.mutations()).toBe(writes)
    }
    const resumed = await f.run(resumePublication(operationId))
    expect(resumed).toMatchObject({ action: "update", reused: false, verified: true })
    expect(f.writes.slice(start).every((write) => write.path === `v1/pages/${page}`)).toBe(true)
    expect(property(f.source().type).select).toEqual({ name: "builtin" })
    expect(property(f.source().builtin).rich_text).toEqual([
      { type: "text", text: { content: builtin.id } },
    ])
    if (fault === "ack-read") {
      expect(
        f.writes
          .slice(start)
          .filter(
            (write) => property(property(write.body).properties)["Source Type"] !== undefined,
          ),
      ).toHaveLength(1)
      const retained = property(
        (property(f.receipts.get(`publications/${operationId}.json`)).intents as unknown[])[
          sourceIndex
        ],
      )
      expect(retained.status).toBe("completed")
      expect(retained.response).toEqual(sourceIntent.response)
    }
  })

for (const change of ["field-id", "unrecognized-request", "external-source-edit"] as const)
  test(`frozen builtin recovery refuses ${change} without replay`, async () => {
    const f = fixture()
    await f.run(createSkill("/input", { database }))
    f.enableSource()
    const builtin = defineBuiltin(
      "notion/sample-workflow",
      "test",
      [...f.input].map(([path, bytes]) => ({ path, bytes })),
    )
    f.interruptSource("before")
    const interrupted = await f.run(publishBuiltin(builtin, { target: page }).pipe(Effect.result))
    if (interrupted._tag !== "Failure") throw new Error("Expected source request loss")
    const operationId = String(property(interrupted.failure.details).operation_id)
    if (change === "field-id") {
      const fields = structuredClone(publicationSourceSchema)
      property(fields["Source Type"]).id = "recreated-source-field"
      f.sourceSchema(fields)
    } else if (change === "external-source-edit") {
      f.editSource()
    } else {
      const receipt = property(f.receipts.get(`publications/${operationId}.json`))
      const intent = (receipt.intents as unknown[]).at(-1)
      property(property(property(intent).body).properties).Description = {
        rich_text: [{ type: "text", text: { content: "Unreviewed rewrite" } }],
      }
    }
    const before = f.mutations()
    const result = await f.run(resumePublication(operationId).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    expect(f.mutations()).toBe(before)
    expect(property(f.source().type).select).toEqual(
      change === "external-source-edit" ? { name: "upstream" } : null,
    )
  })
