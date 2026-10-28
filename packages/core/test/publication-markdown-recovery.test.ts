import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import { mkdtemp } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ByteSize, Effect, FileSystem, Layer, Option } from "effect"
import { createSkill, resumePublication } from "../src/mutation.ts"
import { proveObservedMarkdownNoEffect } from "../src/publication-markdown-correction.ts"
import {
  correctionCanonical,
  originalObservedMarkdownCorrectionCandidate,
  recordedObservedMarkdownCorrection,
  observedMarkdownCorrectionCoverage,
} from "../src/publication-markdown-history.ts"
import {
  publicationMarkdownReplayCandidates,
  terminalRecordedMarkdownReplay,
} from "../src/publication-markdown-replay.ts"
import { publicationJournalSettled } from "../src/publication-effect-proof.ts"
import { Lexer } from "marked"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { reconcilePublication } from "../src/publication-reconcile.ts"
import { publicationOwnership } from "../src/publication-integrity.ts"
import {
  creationMarker,
  creationMarkerProof,
  creationProofFromBody,
  withoutCreationMarker,
} from "../src/publication-create-identity.ts"
import { openSkill } from "../src/snapshot.ts"
import { snapshotAuthoredPortable } from "../src/export.ts"
import { reconcileOperation, resumeOperation } from "../src/command-operations.ts"
import { PublicationReceiptSchema, type Receipt } from "../src/publication-model.ts"
import { observePublicationListRepair } from "../src/publication-list-repair.ts"
import { restoreOrderedListStart } from "../src/markdown-blocks.ts"
import { UpstreamState } from "../src/upstream-state.ts"

const database = "44444444-4444-4444-8444-444444444444"
const root = "11111111-1111-4111-8111-111111111111"
const encoder = new TextEncoder()

function fixture(
  failure: "registration" | "body" | "create" | "child_create" | "list_normal",
  stateRoot: string,
  managed = false,
  initialEvidence?: "stable" | "missing",
) {
  let credential = "credential"
  let exists = false
  let interrupted = false
  let main = ""
  const markdownFaults: Array<"before" | "after"> = []
  let markdownAttempts = 0
  let bodyRevision = 0
  let receiptHook: ((key: string, value: unknown) => void) | undefined
  let sourceReads = 0
  let rootReads = 0
  let afterRootRead: (() => void) | undefined
  let rawRootsOverride: unknown | undefined
  let rawReferencesOverride: unknown | undefined
  let alterDuringSourceRead: (() => void) | undefined
  const integrityState = new Map<string, unknown>()
  const blocks = () =>
    Lexer.lex(main)
      .filter((token) => token.type !== "space" && token.type !== "def")
      .map((token, index) => {
        const type =
          token.type === "code"
            ? "code"
            : token.type === "heading"
              ? `heading_${token.depth}`
              : "paragraph"
        const content = "text" in token ? String(token.text) : token.raw
        const id = `55555555-5555-4555-8555-${String(index + 1).padStart(12, "0")}`
        return {
          object: "block",
          id,
          type,
          parent: { type: "page_id", page_id: root },
          has_children: false,
          archived: false,
          in_trash: false,
          last_edited_time: `body-${bodyRevision}`,
          [type]: {
            rich_text: [{ type: "text", text: { content, link: null }, plain_text: content }],
            ...(type === "code" ? { language: "plain text", caption: [] } : {}),
          },
        }
      })
  let mutations = 0
  let rootRevision = 0
  const childRevisions: Record<string, number> = {}
  let crashReferencesRead = false
  let nextReceiptWrite: (() => void) | undefined
  let propertyRequests = 0
  let queryMode: "normal" | "duplicate" | "partial" | "paged" = "normal"
  let childInventoryMode: "normal" | "paged" | "partial" = "normal"
  const pagePosts: unknown[] = []
  const children: Array<{ id: string; title: string; body: string }> = []
  let references: unknown[] = []
  const savedProperties: Record<string, unknown> = {}
  const listMode = failure === "list_normal"
  let listPatches = 0
  let listStart: number | undefined
  let listRevision = 0
  let listRootsChange: ((roots: unknown[]) => unknown[]) | undefined
  let evidenceIdentity = initialEvidence
  const listIds = [
    "33333333-3333-4333-8333-000000000001",
    "33333333-3333-4333-8333-000000000002",
    "33333333-3333-4333-8333-000000000003",
  ]
  const listRoots = () => {
    if (!main) return []
    const rich = (content: string, code = false) => ({
      type: "text",
      plain_text: content,
      text: { content, link: null },
      annotations: { bold: false, code },
    })
    const roots: unknown[] = [
      { type: "heading_1", heading_1: { rich_text: [rich("Sample")] } },
      {
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: [rich("First exact item.")],
          list_format: "numbers",
          ...(listStart === undefined ? {} : { list_start_index: listStart }),
        },
      },
      {
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: [rich("Keep "), rich("code", true), rich(" exact.")],
          list_format: "numbers",
        },
      },
    ].map((body, index) => ({
      object: "block",
      id: listIds[index],
      ...body,
      parent: { type: "page_id", page_id: root },
      has_children: false,
      archived: false,
      in_trash: false,
      last_edited_time: index === 1 ? `list-${listRevision}` : "block-0",
    }))
    return listRootsChange ? listRootsChange(roots) : roots
  }
  const applyListEffect = () => {
    listStart = 0
    listRevision++
    rootRevision++
    main = main
      .replace(/^1\. First exact item\./m, "0. First exact item.")
      .replace(/^2\. Keep/m, "1. Keep")
  }
  const persistProperties = (raw: unknown) => {
    for (const [key, rawValue] of Object.entries(property(raw))) {
      if (key === "references" || key === "References") continue
      const value = property(rawValue)
      const name =
        (
          {
            title: "Name",
            description: "Description",
            references: "References",
            publication: "Publication",
            kind: "Kind",
            files: "Files",
            upstream: "Upstream",
            mode: "Sync Mode",
            key: "Upstream Key",
            revision: "Upstream Revision",
            hash: "Published Hash",
            baseline: "Fork Baseline",
          } as Record<string, string>
        )[key] ?? key
      const type = Array.isArray(value.rich_text)
        ? "rich_text"
        : Array.isArray(value.title)
          ? "title"
          : "select" in value
            ? "select"
            : Array.isArray(value.files)
              ? "files"
              : Array.isArray(value.relation)
                ? "relation"
                : undefined
      savedProperties[name] = {
        id: key,
        ...value,
        ...(type ? { type } : {}),
        ...(Array.isArray(value.rich_text)
          ? {
              rich_text: value.rich_text.map((item) => ({
                ...property(item),
                plain_text: property(property(item).text).content,
              })),
            }
          : {}),
      }
    }
  }
  const input = new Map([
    [
      "SKILL.md",
      encoder.encode(
        "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nRead [guide](references/guide.md).\n",
      ),
    ],
    ["references/guide.md", encoder.encode("# Guide\n\nRead [policy](./policy.md).\n")],
    [
      "references/policy.md",
      encoder.encode("# Policy\n\nA consumer must keep original page identities.\n"),
    ],
  ])
  if (listMode) {
    input.clear()
    input.set(
      "SKILL.md",
      encoder.encode(
        "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\n0. First exact item.\n1. Keep `code` exact.\n",
      ),
    )
  }
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  const properties = () => ({
    Name: { id: "title", type: "title", title: [{ plain_text: "Sample Skill" }] },
    Description: {
      id: "description",
      type: "rich_text",
      rich_text: [
        {
          type: "text",
          plain_text: "Use for recovery.",
          text: { content: "Use for recovery.", link: null },
        },
      ],
    },
    References: { id: "references", type: "rich_text", rich_text: references },
    Publication: { id: "publication", type: "rich_text", rich_text: [] },
    Kind: { id: "kind", type: "select", select: { name: "skill" } },
    ...(evidenceIdentity
      ? {
          Evidence: {
            id: "evidence",
            type: "files",
            files: [
              {
                name: "evidence.txt",
                type: "external",
                ...(evidenceIdentity === "stable"
                  ? { id: "77777777-7777-4777-8777-777777777777" }
                  : {}),
                external: { url: "data:text/plain,evidence%20fixture%20bytes" },
              },
            ],
          },
        }
      : {}),
    ...(managed
      ? {
          Upstream: { id: "upstream", type: "relation", relation: [], has_more: false },
          "Sync Mode": { id: "mode", type: "select", select: null },
          "Upstream Key": { id: "key", type: "rich_text", rich_text: [] },
          "Upstream Revision": { id: "revision", type: "rich_text", rich_text: [] },
          "Published Hash": { id: "hash", type: "rich_text", rich_text: [] },
          "Fork Baseline": { id: "baseline", type: "rich_text", rich_text: [] },
        }
      : {}),
    ...savedProperties,
    Updated: { id: "updated", type: "last_edited_time", last_edited_time: `root-${rootRevision}` },
  })
  const row = () => ({
    id: root,
    last_edited_time: `root-${rootRevision}`,
    parent: { type: "data_source_id", database_id: database, data_source_id: "ds" },
    properties: properties(),
  })
  const upstream = upstreamRepositoryFixture()
  const store = Layer.succeed(Store, {
    upstream,
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
    integrity: integrityRepositoryFixture(integrityState),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    root: stateRoot,
    configRoot: "/memory",
    cacheRoot: "/memory",
    reserveCacheGeneration: (() => {
      let generation = 0
      return () => Effect.sync(() => ++generation)
    })(),
    listKeys: (prefix) =>
      Effect.sync(() => [...json.keys()].filter((key) => key.startsWith(`${prefix}/`))),
    retireKeys: (keys) =>
      Effect.sync(() => {
        for (const key of keys) json.delete(key)
        return keys.map((key) => ({ key, retention_path: "fixture_trash" }))
      }),
    readJson: (key, schema) =>
      Effect.succeed(json.has(key) ? decode(schema, json.get(key)) : undefined),
    writeJson: (key, value) =>
      Effect.sync(() => {
        // Durable JSON has the same undefined-field behavior as the real store.
        json.set(key, JSON.parse(JSON.stringify(value)))
        if (receiptHook) receiptHook(key, structuredClone(value))
        if (key.startsWith("publications/") && nextReceiptWrite) {
          const hook = nextReceiptWrite
          nextReceiptWrite = undefined
          hook()
        }
      }),
    readBytes: (key) =>
      Effect.gen(function* () {
        sourceReads++
        if (alterDuringSourceRead) {
          const change = alterDuringSourceRead
          alterDuringSourceRead = undefined
          change()
        }
        if (!objects.has(key)) return yield* Effect.fail(fail("SNAPSHOT_MISSING", "Missing object"))
        return objects.get(key)!
      }),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, bytes)
      }),
    output: () => Effect.fail(fail("UNUSED", "unused")),
  })
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.sync(() => credential),
    request: (path, payload, options) =>
      Effect.gen(function* () {
        if (path === "v1/users/me") return { id: "fixture", object: "user" }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: null,
            title: [],
            data_sources: [{ id: "ds", name: "Skills" }],
          }
        if (path === "v1/data_sources/ds") return { properties: properties() }
        if (path === "v1/data_sources/ds/query") {
          if (queryMode === "partial")
            return { results: exists ? [row()] : [], has_more: true, next_cursor: null }
          if (queryMode === "paged" && !property(payload).start_cursor)
            return { results: [], has_more: true, next_cursor: "root-next" }
          return {
            results: exists
              ? [
                  row(),
                  ...(queryMode === "duplicate"
                    ? [{ ...row(), id: "99999999-9999-4999-8999-999999999999" }]
                    : []),
                ]
              : [],
            has_more: false,
            next_cursor: null,
          }
        }
        if (path === "v1/pages") {
          pagePosts.push(structuredClone(payload))
          mutations++
          rootRevision++
          if (property(payload).parent && property(property(payload).parent).data_source_id) {
            exists = true
            persistProperties(property(payload).properties)
            if (failure === "create" && !interrupted) {
              interrupted = true
              return yield* Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Create response lost"))
            }
            return row()
          }
          const titleValues = property(property(property(payload).properties).title).title
          if (!Array.isArray(titleValues))
            return yield* Effect.fail(fail("INVALID_RESPONSE", "Missing title fixture input"))
          const title = String(property(property(titleValues[0]).text).content)
          const child = {
            id: `22222222-2222-4222-8222-${String(children.length + 1).padStart(12, "0")}`,
            title,
            body: ((property(payload).children as unknown[]) ?? [])
              .map((block) => {
                const values = property(property(block).paragraph).rich_text
                return Array.isArray(values)
                  ? values
                      .map((item) => String(property(property(item).text).content ?? ""))
                      .join("")
                  : ""
              })
              .join("\n"),
          }
          children.push(child)
          childRevisions[child.id] = 0
          if (failure === "child_create" && !interrupted) {
            interrupted = true
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Child response lost after initial POST"),
            )
          }
          return {
            id: child.id,
            last_edited_time: `child-${childRevisions[child.id]}`,
            parent: { type: "page_id", page_id: root },
            properties: { title: { type: "title", title: [{ plain_text: title }] } },
          }
        }
        if (path === `v1/pages/${root}`) {
          if (options?.method !== "PATCH") {
            rootReads++
            if (afterRootRead) {
              const change = afterRootRead
              afterRootRead = undefined
              change()
            }
          }
          if (options?.method === "PATCH") {
            mutations++
            if (property(property(payload).properties).references) {
              if (failure === "registration" && !interrupted) {
                interrupted = true
                return yield* Effect.fail(fail("ACCESS_DENIED", "Registration interrupted"))
              }
              const values = property(property(property(payload).properties).references).rich_text
              if (!Array.isArray(values))
                return yield* Effect.fail(
                  fail("INVALID_RESPONSE", "Missing References fixture input"),
                )
              references = values.map((value) => {
                const item = property(value)
                return { ...item, plain_text: property(item.text).content }
              })
              rootRevision++
            }
            persistProperties(property(payload).properties)
            rootRevision++
          }
          return row()
        }
        if (path.includes("/blocks/") && path.includes("/children")) {
          const id = path.split("/")[2]
          if (!listMode && id === root && children.length === 0)
            return rawRootsOverride ?? { results: blocks(), has_more: false, next_cursor: null }
          if (listMode && id === root) {
            return { results: listRoots(), has_more: false, next_cursor: null }
          }
          return {
            results:
              id === root
                ? (childInventoryMode === "paged" && !path.includes("start_cursor=")
                    ? []
                    : children
                  ).map((child) => ({
                    id: child.id,
                    type: "child_page",
                    child_page: { title: child.title },
                  }))
                : [],
            has_more:
              id === root &&
              (childInventoryMode === "partial" ||
                (childInventoryMode === "paged" && !path.includes("start_cursor="))),
            next_cursor:
              id === root && childInventoryMode === "paged" && !path.includes("start_cursor=")
                ? "children-next"
                : null,
          }
        }
        if (path.includes(`/pages/${root}/properties/references`)) {
          if (rawReferencesOverride !== undefined) return rawReferencesOverride
          if (crashReferencesRead) {
            crashReferencesRead = false
            return yield* Effect.die("Process exited during version validation")
          }
          return {
            request_id: `property-request-${++propertyRequests}`,
            results: references.map((rich_text) => ({ rich_text })),
            has_more: false,
            next_cursor: null,
          }
        }
        const id = path.split("/")[2]
        if (!listMode && /^v1\/blocks\/[^/]+$/.test(path) && options?.method !== "PATCH") {
          const block = blocks().find((block) => block.id === id)
          if (block) return block
        }
        if (listMode && /^v1\/blocks\/[^/]+$/.test(path)) {
          const block = listRoots().find((block) => property(block).id === id)
          if (!block) return yield* Effect.fail(fail("UNEXPECTED", "Unknown list block fixture."))
          if (options?.method === "PATCH") {
            if (
              id !== listIds[1] ||
              JSON.stringify(payload) !==
                JSON.stringify({ numbered_list_item: { list_start_index: 0 } })
            )
              return yield* Effect.fail(fail("UNEXPECTED", "Unexpected list correction request."))
            mutations++
            listPatches++
            // Model the public schema, not a hypothetical writable list start.
            // A production correction must be refused before this transport.
            return yield* Effect.fail(
              fail("NOTION_REQUEST_FAILED", "Unsupported numbered-list field.", {
                http_status: 400,
                notion_code: "validation_error",
                phase: "definitive_rejection",
              }),
            )
          }
          return listRoots().find((block) => property(block).id === id)!
        }
        const child = children.find((child) => child.id === id)
        if (path.endsWith("/markdown")) {
          if (options?.method === "PATCH") {
            mutations++
            const markdownFault = id === root ? markdownFaults.shift() : undefined
            if (id === root) markdownAttempts++
            if (markdownFault === "before")
              return yield* Effect.fail(
                fail(
                  "WRITE_OUTCOME_UNKNOWN",
                  "Original Markdown failed before effect; response lost",
                ),
              )
            if (child) childRevisions[child.id] = (childRevisions[child.id] ?? 0) + 1
            else rootRevision++
            const body = String(property(property(payload).replace_content).new_str)
            if (child) child.body = body
            else {
              bodyRevision++
              main = listMode
                ? body
                    .replace(/^0\. First exact item\./m, "1. First exact item.")
                    .replace(/^1\. Keep/m, "2. Keep")
                : body
              if (listMode) {
                listStart = undefined
                listRevision = 0
              }
            }
            if (markdownFault === "after")
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Original Markdown applied; response lost"),
              )
            if (failure === "body" && child?.title === "policy.md" && !interrupted) {
              interrupted = true
              return yield* Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Response lost after write"))
            }
          }
          const tags =
            id === root
              ? children
                  .map(
                    (child) =>
                      `<page url="https://www.notion.so/${child.id.replaceAll("-", "")}">${child.title}</page>`,
                  )
                  .join("\n")
              : ""
          return {
            object: "page_markdown",
            id,
            markdown: child ? child.body : `${main}${tags ? "\n" + tags : ""}`,
            truncated: false,
            unknown_block_ids: [],
          }
        }
        if (child)
          return {
            id: child.id,
            last_edited_time: `child-${childRevisions[child.id]}`,
            parent: { type: "page_id", page_id: root },
            properties: { title: { type: "title", title: [{ plain_text: child.title }] } },
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
    readFile: (path) => Effect.succeed(input.get(path.slice("/input/".length))!),
  })
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    Layer.succeed(UpstreamState, upstream),
    store,
    api,
    Layer.succeed(FileSystem.FileSystem, fs),
  )
  return {
    children,
    markdownFault: (fault: "before" | "after") => {
      markdownFaults.push(fault)
    },
    markdownAttempts: () => markdownAttempts,
    rootBody: () => main,
    sourceReads: () => sourceReads,
    rootReads: () => rootReads,
    receiptHook: (hook: ((key: string, value: unknown) => void) | undefined) => {
      receiptHook = hook
    },
    rootReadHook: (hook: () => void) => {
      afterRootRead = hook
    },
    sourceReadHook: (hook: () => void) => {
      alterDuringSourceRead = hook
    },
    changeRevision: () => {
      rootRevision++
    },
    rawRoots: (value: unknown) => {
      rawRootsOverride = value
    },
    rawReferences: (value: unknown) => {
      rawReferencesOverride = value
    },
    integrityState,
    input,
    json,
    objects,
    pagePosts,
    rootPage: row,
    editProperties: persistProperties,
    setQueryMode: (value: typeof queryMode) => {
      queryMode = value
    },
    setChildInventoryMode: (value: typeof childInventoryMode) => {
      childInventoryMode = value
    },
    duplicateChild: (otherOperation = false) => {
      const child = children[0]!
      const proof = creationMarkerProof(child.body)!
      children.push({
        ...child,
        id: "99999999-9999-4999-8999-999999999999",
        body: otherOperation ? creationMarker({ ...proof, operation_id: "p_other" }) : child.body,
      })
    },
    clearPublication: () => {
      delete savedProperties.Publication
    },
    setCredential: (value: string) => {
      credential = value
    },
    crashAfterRootRead: () => {
      crashReferencesRead = true
    },
    onNextReceiptWrite: (hook: () => void) => {
      nextReceiptWrite = hook
    },
    editRoot: (value: string) => {
      main = value
    },
    omitFirstReference: () => {
      references = references.slice(1)
    },
    mutations: () => mutations,
    listPatches: () => listPatches,
    editListRoots: (change: (roots: unknown[]) => unknown[]) => {
      listRootsChange = change
    },
    applyListEffect,
    setEvidenceIdentity: (value: "stable" | "missing") => {
      evidenceIdentity = value
      rootRevision++
    },
    run: <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>),
  }
}

const originalSource =
  '---\n"description": "Use for recovery."\n"name": "sample-skill"\n---\n\n# Sample\n\nKeep the original complete instructions.\n\n```\nexact original code\n```\n'

async function originalUnknown() {
  const f = fixture("body", await mkdtemp(join(tmpdir(), "observed-markdown-recovery-")))
  f.input.clear()
  f.input.set("SKILL.md", encoder.encode(originalSource))
  f.markdownFault("before")
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  expect(stopped._tag).toBe("Failure")
  if (stopped._tag !== "Failure") throw new Error("Expected the real original transport failure")
  const id = String(property(stopped.failure.details).operation_id)
  const key = `publications/${id}.json`
  const receipt = () => decode(PublicationReceiptSchema, f.json.get(key))
  const original = structuredClone(receipt())
  expect(original.intents).toHaveLength(3)
  expect(original.intents[0]).toMatchObject({
    path: "v1/pages",
    method: "POST",
    status: "completed",
    response: { id: root },
  })
  expect(original.intents[1]).toMatchObject({
    path: `v1/pages/${root}`,
    method: "PATCH",
    status: "completed",
    response: { id: root },
  })
  expect(original.intents[2]).toMatchObject({
    path: `v1/pages/${root}/markdown`,
    method: "PATCH",
    status: "unknown",
  })
  expect(original.intents[2]!.response).toBeUndefined()
  expect(original.owner).toBeUndefined()
  expect(original.conflict).toBeUndefined()
  expect(f.rootBody()).toBe("")
  expect(f.markdownAttempts()).toBe(1)
  return { f, id, key, receipt, original }
}

async function assertCompleted(state: Awaited<ReturnType<typeof originalUnknown>>) {
  const { f, id, receipt } = state
  expect(receipt()).toMatchObject({ page_id: root, state: "completed", result: { verified: true } })
  expect(receipt().owner).toBeUndefined()
  expect(receipt().conflict).toBeUndefined()
  expect(publicationJournalSettled(receipt())).toBe(true)
  const target = property(property(state.original.intents[2]!.body).replace_content).new_str
  if (typeof target !== "string") throw new Error("Expected the original whole Markdown request")
  expect(f.rootBody()).toBe(target)
  expect(f.children).toHaveLength(0)
  expect(f.pagePosts).toHaveLength(1)
  const current = await f.run(openSkill(root, { database, refresh: true }))
  const authored = await f.run(snapshotAuthoredPortable(current))
  expect(authored.files.map((file) => file.path)).toEqual(["SKILL.md"])
  expect(new TextDecoder().decode(authored.files[0]!.bytes)).toBe(originalSource)
  const writes = f.mutations()
  const again = await f.run(resumePublication(id))
  expect(again).toMatchObject({ operation_id: id, verified: true })
  expect(f.mutations()).toBe(writes)
}

test("real unknown-before-effect Markdown appends a real successor and proves failed history", async () => {
  const state = await originalUnknown(),
    { f, id, receipt, original } = state
  const result = await f.run(resumePublication(id))
  expect(result).toMatchObject({ operation_id: id, verified: true, resumed: true })
  expect(receipt().intents[2]).toMatchObject({
    path: original.intents[2]!.path,
    body: original.intents[2]!.body,
    status: "failed",
    response: { prior_status: "unknown", recovery: "known_not_applied", replayed_by_intent: 3 },
  })
  expect(receipt().intents[3]).toMatchObject({
    path: original.intents[2]!.path,
    body: original.intents[2]!.body,
    status: "completed",
    response: { id: root },
  })
  expect(receipt().intents.slice(0, 2)).toEqual(original.intents.slice(0, 2))
  expect(publicationMarkdownReplayCandidates(receipt())).toEqual([
    { path: `v1/pages/${root}/markdown`, intent_index: 2, covered_by_intent_index: 3 },
  ])
  expect(f.markdownAttempts()).toBe(2)
  await assertCompleted(state)
})

test("consecutive unknown-before-effect attempts preserve their exact whole-request successor chain", async () => {
  const state = await originalUnknown(),
    { f, id, receipt } = state
  f.markdownFault("before")
  const failed = await f.run(resumePublication(id).pipe(Effect.result))
  expect(failed._tag).toBe("Failure")
  expect(receipt().intents[2]).toMatchObject({
    status: "failed",
    response: { recovery: "known_not_applied", replayed_by_intent: 3 },
  })
  expect(receipt().intents[3]).toMatchObject({ status: "unknown" })
  expect(publicationMarkdownReplayCandidates(receipt())).toEqual([])
  await f.run(resumePublication(id))
  expect(receipt().intents[3]).toMatchObject({
    status: "failed",
    response: { recovery: "known_not_applied", replayed_by_intent: 4 },
  })
  expect(receipt().intents[4]).toMatchObject({ status: "completed", response: { id: root } })
  expect(
    publicationMarkdownReplayCandidates(receipt()).map((item) => [
      item.intent_index,
      item.covered_by_intent_index,
    ]),
  ).toEqual([
    [2, 4],
    [3, 4],
  ])
  expect(f.markdownAttempts()).toBe(3)
  await assertCompleted(state)
})
