// Isolated real-transport fixture copied from router-authoring.node.test.ts.
import { publicationSourceRows, publicationSourceSchema } from "./fixtures.ts"
import { applyUpstream } from "../src/upstream-apply.ts"
import { freezePortable, subscriptionConfigHash, targetKey } from "../src/upstream-content.ts"
import { strictDecode, UpstreamPlanSchema, type UpstreamPlan } from "../src/upstream-model.ts"
import { getSubscription } from "../src/upstream-subscription.ts"
import type { PortableSkill } from "../src/portable.ts"

import { expect, test } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { ConfigProvider, Effect, Layer } from "effect"
import { CliConfig, CliOutput, Command } from "effect/cli"
import { createCommand, replaceCommand, updateCommand } from "../../cli/src/commands-content.ts"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createPortable, createSkill, replaceSkill, resumePublication } from "../src/mutation.ts"
import { updateSkill, reconcileOperation, showOperation } from "../src/command-operations.ts"
import {
  exportSkill,
  portableIdentity,
  snapshotAuthoredPortable,
  snapshotPortable,
} from "../src/export.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { Notion } from "../src/notion.ts"
import { sha256, Store, StoreLive } from "../src/store.ts"
import { fail, property, SkillsError } from "../src/model.ts"
import { MANIFEST, portableFiles, readPortable } from "../src/portable.ts"
import { PublicationReceiptSchema } from "../src/publication-model.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { publicationMarker } from "../src/publication-integrity.ts"
import { beginPublication } from "../src/publication.ts"
import { authScope } from "../src/catalog.ts"
import { rewritePageLinks } from "../src/references.ts"
import { UpstreamPublisherLive } from "../src/upstream-publication.ts"
import { Lexer, type Token, type Tokens } from "marked"
import { pageId } from "../src/ref.ts"

const database = "11111111-1111-4111-8111-111111111111"
const dataSource = "22222222-2222-4222-8222-222222222222"
const router = "33333333-3333-4333-8333-333333333333"
const alpha = "44444444-4444-4444-8444-444444444444"
const beta = "55555555-5555-4555-8555-555555555555"
const foreign = "66666666-6666-4666-8666-666666666666"
const upstreamDatabase = "88888888-8888-4888-8888-888888888888"
const upstreamDataSource = "99999999-9999-4999-8999-999999999999"
const subscription = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const root = Command.make("ntn-skills").pipe(
  Command.withSubcommands([createCommand, replaceCommand, updateCommand]),
)
// Preserve the original E2E shape: frontmatter and an authored Members heading are content,
// not permission to strip either before hashing or to use the generated index as source.
const authoredRouter = `---
name: Sample Router
description: Use for routing.
---
Use the generated member index to select the requested Skill.

## Members

- [Content Real Service Fixture](skill://${alpha}/SKILL.md) — Authored routing guidance.

# Route requests

Read [guide](references/guide.md).
`
const rich = (value: string) => ({
  type: "rich_text",
  rich_text: value ? [{ plain_text: value, text: { content: value } }] : [],
})
const title = (value: string) => ({
  type: "title",
  title: [{ plain_text: value, text: { content: value } }],
})
interface MemberRow {
  id: string
  last_edited_time: string
  parent: { database_id: string; data_source_id: string }
  archived: boolean
  in_trash: boolean
  properties: Record<string, unknown>
}

export interface RouterFixture {
  run: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>
  input: string
  put: (path: string, value: string | Uint8Array) => Promise<void>
  members: Map<string, MemberRow>
  properties: Record<string, unknown>
  subscriptionProperties: Record<string, unknown>
  sourceRequests: string[]
  requests: Array<{ path: string; method: string }>
  writes: Array<{ path: string; body: unknown }>
  children: Array<{ id: string; name: string; body: string; revision: number }>
  body: () => string
  memberIds: () => string[]
  losePropertyResponse: () => void
  losePropertyResponseBeforeApply: () => void
  loseChangedDescriptionResponseBeforeApply: () => void
  loseMarkerResponseBeforeApply: () => void
  editBody: () => void
  beforeRequest: (hook: (request: { path: string; method: string }) => void) => void
  close: () => Promise<void>
}

async function fixture(upstream = false): Promise<RouterFixture> {
  const directory = await mkdtemp(join(tmpdir(), "ntn-router-authoring-"))
  const input = join(directory, "input")
  const downloads = new Map<string, Uint8Array>()
  const sourceRequests: string[] = []
  const baselines = new Map<string, { name: string; blocks: unknown[] }>()
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/source")) sourceRequests.push(request.url)
    const bytes = downloads.get(request.url ?? "")
    response.writeHead(bytes ? 200 : 404)
    response.end(bytes)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP fixture server")
  const base = `http://127.0.0.1:${address.port}`
  const requests: Array<{ path: string; method: string }> = []
  const writes: Array<{ path: string; body: unknown }> = []
  const children: Array<{ id: string; name: string; body: string; revision: number }> = []
  let beforeRequest: ((request: { path: string; method: string }) => void) | undefined
  const edited = (revision: number) =>
    new Date(Date.UTC(2026, 9, 17) + revision * 1000).toISOString()
  const uploads = new Map<string, Uint8Array>()
  const members = new Map<string, MemberRow>(
    [alpha, beta].map((id, index) => [
      id,
      {
        id,
        last_edited_time: "2026-10-17T00:00:00.000Z",
        parent: { database_id: database, data_source_id: dataSource },
        archived: false,
        in_trash: false,
        properties: {
          Name: { id: "title", ...title(index ? "Beta Skill" : "Alpha Skill") },
          Description: { id: "description", ...rich(index ? "Use for beta." : "Use for alpha.") },
          Kind: { id: "kind", type: "select", select: { name: "skill" } },
        },
      },
    ]),
  )
  const properties: Record<string, unknown> = {
    ...(upstream ? structuredClone(publicationSourceRows) : {}),
    Name: { id: "title", ...title("Sample Router") },
    Description: { id: "description", ...rich("Use for routing.") },
    Kind: { id: "kind", type: "select", select: { name: "router" } },
    References: { id: "references", ...rich("") },
    Members: { id: "members", type: "relation", relation: [], has_more: false },
    Files: { id: "files", type: "files", files: [] },
    Publication: { id: "publication", ...rich("") },
    "Default Context": { id: "default", type: "checkbox", checkbox: false },
    Upstream: { id: "upstream", type: "relation", relation: [], has_more: false },
    "Sync Mode": { id: "sync-mode", type: "select", select: null },
    ...Object.fromEntries(
      ["Upstream Key", "Upstream Revision", "Published Hash", "Fork Baseline"].map((name) => [
        name,
        { id: name, ...rich("") },
      ]),
    ),
  }
  const subscriptionProperties: Record<string, unknown> = {
    Name: { id: "title", ...title("Frozen mode subscription") },
    Description: rich("Use for mode recovery."),
    "Default Context": { type: "checkbox", checkbox: false },
    Enabled: { type: "checkbox", checkbox: true },
    Status: { type: "select", select: { name: "verified" } },
    Source: rich(
      JSON.stringify({
        provider: {
          type: "registry",
          base_url: `${base}/source`,
          owner: "fixture",
          slug: "frozen",
          version: "v1",
        },
      }),
    ),
    Ref: rich("v1"),
    "Target Database ID": rich(database),
    Roots: rich("[]"),
    Include: rich("[]"),
    Exclude: rich("[]"),
    Mapping: rich("{}"),
    "Published Members": rich(""),
  }
  // The isolated fixture also models the real parent map PATCH/readback used by applyUpstream.
  for (const [name, field] of Object.entries(subscriptionProperties))
    subscriptionProperties[name] = { id: name, ...property(field) }
  let subscriptionRevision = 0
  let exists = false,
    main = "",
    revision = 0,
    upload = 0,
    losePropertyResponse = false,
    loseBeforeApply = false,
    loseMarkerBeforeApply = false,
    loseChangedDescription = false
  const row = () =>
    structuredClone({
      id: router,
      parent: { database_id: database, data_source_id: dataSource },
      properties,
      last_edited_time: edited(revision),
      archived: false,
      in_trash: false,
    })
  const saveProperties = (raw: unknown) => {
    for (const [key, value] of Object.entries(property(raw))) {
      const name =
        Object.keys(properties).find((name) => property(properties[name]).id === key) ?? key
      const previous = property(properties[name]),
        next = property(value)
      const type = previous.type ?? Object.keys(next)[0]
      const normalized: Record<string, unknown> = {
        ...previous,
        ...structuredClone(next),
        id: previous.id ?? key,
        type,
      }
      if (Array.isArray(next.rich_text))
        normalized.rich_text = next.rich_text.map((item) => ({
          ...property(item),
          plain_text: property(property(item).text).content,
        }))
      if (Array.isArray(next.title))
        normalized.title = next.title.map((item) => ({
          ...property(item),
          plain_text: property(property(item).text).content,
        }))
      if (Array.isArray(next.files))
        normalized.files = next.files.map((rawFile) => {
          const file = property(rawFile)
          if (!file.file_upload) return file
          const id = String(property(file.file_upload).id),
            bytes = uploads.get(id)
          if (!bytes) throw new Error(`Missing uploaded bytes ${id}`)
          const path = `/downloads/${id}`
          downloads.set(path, bytes)
          return { id, name: file.name, type: "file", file: { url: `${base}${path}` } }
        })
      properties[name] = normalized
    }
  }
  // Markdown transport normalizes Notion destinations, even after a block PATCH
  // restores the exact rich-text URL. Keep those two representations independent.
  const canonicalUrl = (url: string) => {
    const id = /^https?:\/\//.test(url) && pageId(url)
    return id ? `https://app.notion.com/p/${id.replaceAll("-", "")}` : url
  }
  const normalizeMarkdown = (markdown: string) => {
    let fence: string | undefined
    return markdown
      .split("\n")
      .map((line) => {
        const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
        if (fence) {
          if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
          return line
        }
        if (marker) {
          fence = marker
          return line
        }
        return line
          .split(/(`+[^`]*`+)/g)
          .map((part, index) =>
            index % 2
              ? part
              : part
                  .replace(
                    /(\]\(\s*<?)([^\s)>]+)(>?)(?=\s|\))/g,
                    (_all, start: string, url: string, end: string) =>
                      url.startsWith("skill://")
                        ? `${start}${url}${end}`
                        : `${start}${canonicalUrl(url)}${end}`,
                  )
                  .replace(
                    /(^\s*\[[^\]]+\]:\s*<?)([^\s>]+)(>?)/g,
                    (_all, start: string, url: string, end: string) =>
                      `${start}${canonicalUrl(url)}${end}`,
                  )
                  .replace(/https?:\/\/[^\s<>\)\]"']+/g, canonicalUrl)
                  .replace(/\[([^\]]+)\]\(skill:\/\/[^)]+\)/g, "$1"),
          )
          .join("")
      })
      .join("\n")
  }
  const blocks = new Map<string, Record<string, unknown>>()
  const blockChildren = new Map<string, string[]>()
  let blockSequence = 0
  const richResponse = (values: unknown[]) =>
    values.map((raw) => {
      const value = property(raw),
        text = property(value.text)
      const url = property(text.link).url
      return {
        ...value,
        type: "text",
        text: { ...text, link: typeof url === "string" ? { url } : null },
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: "default",
          ...property(value.annotations),
        },
        plain_text: String(text.content ?? ""),
        href: typeof url === "string" ? url : null,
      }
    })
  const inline = (
    tokens: readonly Token[],
    annotations: Record<string, unknown> = {},
    url?: string,
  ): unknown[] =>
    tokens.flatMap((token): unknown[] => {
      if (token.type === "link") return inline(token.tokens ?? [], annotations, token.href)
      if (token.type === "strong" || token.type === "em" || token.type === "del")
        return inline(
          token.tokens ?? [],
          {
            ...annotations,
            [token.type === "strong" ? "bold" : token.type === "em" ? "italic" : "strikethrough"]:
              true,
          },
          url,
        )
      if (token.type === "text" && token.tokens) return inline(token.tokens, annotations, url)
      const content =
        token.type === "br"
          ? "\n"
          : token.type === "html"
            ? token.raw.replace(/<[^>]+>/g, "")
            : String("text" in token ? token.text : token.raw)
      return richResponse([
        {
          type: "text",
          text: { content, ...(url ? { link: { url } } : {}) },
          annotations: { ...annotations, ...(token.type === "codespan" ? { code: true } : {}) },
        },
      ])
    })
  const addBlock = (parent: string, type: string, data: Record<string, unknown>) => {
    const id = `cccccccc-cccc-4ccc-8ccc-${String(++blockSequence).padStart(12, "0")}`
    const block = {
      object: "block",
      id,
      type,
      parent: blocks.has(parent)
        ? { type: "block_id", block_id: parent }
        : { type: "page_id", page_id: parent },
      has_children: false,
      archived: false,
      in_trash: false,
      created_time: edited(0),
      last_edited_time: edited(0),
      [type]: data,
    }
    blocks.set(id, block)
    blockChildren.set(parent, [...(blockChildren.get(parent) ?? []), id])
    const owner = blocks.get(parent)
    if (owner) owner.has_children = true
    return id
  }
  const buildBlocks = (parent: string, tokens: readonly Token[]) => {
    for (const token of tokens) {
      if (token.type === "space" || token.type === "def") continue
      if (token.type === "list") {
        for (const item of token.items) {
          const [first, ...rest] = item.tokens
          const type = item.task
            ? "to_do"
            : token.ordered
              ? "numbered_list_item"
              : "bulleted_list_item"
          const id = addBlock(parent, type, {
            rich_text: first && "tokens" in first && first.tokens ? inline(first.tokens) : [],
            color: "default",
            ...(item.task ? { checked: item.checked === true } : {}),
          })
          buildBlocks(id, rest)
        }
      } else if (token.type === "table") {
        const id = addBlock(parent, "table", {
          table_width: token.header.length,
          has_column_header: true,
          has_row_header: false,
        })
        for (const row of [token.header, ...token.rows])
          addBlock(id, "table_row", {
            cells: row.map((cell: Tokens.TableCell) => inline(cell.tokens)),
          })
      } else if (token.type === "code") {
        addBlock(parent, "code", {
          rich_text: richResponse([{ text: { content: token.text } }]),
          language: token.lang ?? "plain text",
          caption: [],
        })
      } else if (token.type === "blockquote") {
        const [first, ...rest] = token.tokens ?? []
        const id = addBlock(parent, "quote", {
          rich_text: first && "tokens" in first && first.tokens ? inline(first.tokens) : [],
          color: "default",
        })
        buildBlocks(id, rest)
      } else if (token.type === "hr") addBlock(parent, "divider", {})
      else if (token.type === "html" && /^\s*<page\b/.test(token.raw)) continue
      else {
        const type = token.type === "heading" ? `heading_${Math.min(token.depth, 3)}` : "paragraph"
        addBlock(parent, type, {
          rich_text: "tokens" in token && token.tokens ? inline(token.tokens) : inline([token]),
          color: "default",
        })
      }
    }
  }
  const replaceBlocks = (page: string, markdown: string) => {
    const remove = (parent: string) => {
      for (const id of blockChildren.get(parent) ?? []) {
        remove(id)
        blocks.delete(id)
      }
      blockChildren.delete(parent)
    }
    remove(page)
    buildBlocks(page, Lexer.lex(markdown.replace(/<page\b[^>]*>[\s\S]*?<\/page>/g, "")))
  }
  const childBlock = (child: RouterFixture["children"][number]) => ({
    object: "block",
    id: child.id,
    type: "child_page",
    parent: { type: "page_id", page_id: router },
    has_children: true,
    archived: false,
    in_trash: false,
    last_edited_time: edited(child.revision),
    child_page: { title: child.name },
  })
  const paginate = (path: string, results: unknown[]) => {
    const params = new URL(path, "https://api.notion.com").searchParams
    const start = Number(params.get("start_cursor") ?? 0)
    const size = Math.min(Number(params.get("page_size") ?? 100), 100)
    const end = start + size
    return {
      object: "list",
      results: structuredClone(results.slice(start, end)),
      has_more: end < results.length,
      next_cursor: end < results.length ? String(end) : null,
    }
  }
  const api = Notion.of({
    version: Effect.succeed("controlled-node"),
    credentialIdentity: Effect.succeed("router-authoring-credential"),
    request: (path, payload, options) =>
      Effect.tryPromise({
        try: async () => {
          const method = options?.method ?? (payload === undefined ? "GET" : "POST")
          beforeRequest?.({ path, method })
          requests.push({ path, method })
          if (method !== "GET" && !path.endsWith("/query"))
            writes.push({ path, body: structuredClone(payload) })
          if (path === "v1/users/me") return { id: "node-consumer", object: "user" }
          if (path === `v1/databases/${upstreamDatabase}`)
            return {
              id: upstreamDatabase,
              database_type: null,
              title: [],
              data_sources: [{ id: upstreamDataSource, name: "Upstream" }],
            }
          if (path === `v1/data_sources/${upstreamDataSource}`)
            return {
              id: upstreamDataSource,
              parent: { database_id: upstreamDatabase },
              title: [],
              properties: structuredClone(subscriptionProperties),
            }
          if (path === `v1/pages/${subscription}`) {
            if (method === "PATCH") {
              for (const [key, change] of Object.entries(property(property(payload).properties))) {
                const name =
                  Object.keys(subscriptionProperties).find(
                    (name) => property(subscriptionProperties[name]).id === key,
                  ) ?? key
                const value = property(change)
                subscriptionProperties[name] = {
                  ...property(subscriptionProperties[name]),
                  ...structuredClone(value),
                  ...(Array.isArray(value.rich_text)
                    ? {
                        rich_text: value.rich_text.map((span) => ({
                          ...property(span),
                          plain_text: property(property(span).text).content,
                        })),
                      }
                    : {}),
                }
              }
              subscriptionRevision++
            }
            return {
              id: subscription,
              parent: { database_id: upstreamDatabase, data_source_id: upstreamDataSource },
              last_edited_time: edited(subscriptionRevision),
              archived: false,
              in_trash: false,
              properties: structuredClone(subscriptionProperties),
            }
          }
          if (path === `v1/databases/${database}`)
            return {
              id: database,
              database_type: "skills",
              title: [],
              data_sources: [{ id: dataSource, name: "Content" }],
            }
          if (path === `v1/data_sources/${dataSource}`)
            return {
              id: dataSource,
              parent: { database_id: database },
              properties: {
                ...structuredClone(properties),
                ...(upstream ? structuredClone(publicationSourceSchema) : {}),
              },
            }
          if (path === `v1/data_sources/${dataSource}/query`)
            return { results: exists ? [row()] : [], has_more: false, next_cursor: null }
          if (path === "v1/pages") {
            if (property(property(payload).parent).data_source_id) {
              exists = true
              saveProperties(property(payload).properties)
              revision++
              return row()
            }
            if (property(property(payload).parent).page_id === subscription) {
              const id = `bbbbbbbb-bbbb-4bbb-8bbb-${String(baselines.size + 1).padStart(12, "0")}`
              const values = property(property(property(payload).properties).title)
                .title as unknown[]
              const blocks = (property(payload).children as unknown[]).map((raw) => {
                const file = property(property(raw).file)
                const bytes = uploads.get(String(property(file.file_upload).id))
                if (!bytes) throw new Error("Missing baseline upload")
                const path = `/downloads/${id}`
                downloads.set(path, bytes)
                return { type: "file", file: { type: "file", file: { url: `${base}${path}` } } }
              })
              baselines.set(id, {
                name: String(property(property(values[0]).text).content),
                blocks,
              })
              return { id }
            }
            const values = property(property(property(payload).properties).title).title as unknown[]
            const child = {
              id: `77777777-7777-4777-8777-${String(children.length + 1).padStart(12, "0")}`,
              name: String(property(property(values[0]).text).content),
              body: "",
              revision: 0,
            }
            children.push(child)
            return {
              id: child.id,
              parent: { type: "page_id", page_id: router },
              archived: false,
              in_trash: false,
              last_edited_time: edited(child.revision),
              properties: { title: title(child.name) },
            }
          }
          if (path === `v1/pages/${router}`) {
            if (!exists) throw fail("SKILL_NOT_FOUND", "Router not created")
            if (method === "PATCH") {
              const changes = property(property(payload).properties)
              const descriptionChange = property(
                changes.description ?? changes.Description,
              ).rich_text
              const currentDescription = property(properties.Description).rich_text
              const descriptionText = Array.isArray(descriptionChange)
                ? descriptionChange
                    .map((item) =>
                      String(
                        property(property(item).text).content ?? property(item).plain_text ?? "",
                      ),
                    )
                    .join("")
                : undefined
              const currentDescriptionText = Array.isArray(currentDescription)
                ? currentDescription
                    .map((item) =>
                      String(
                        property(property(item).text).content ?? property(item).plain_text ?? "",
                      ),
                    )
                    .join("")
                : undefined
              if (
                loseChangedDescription &&
                descriptionText !== undefined &&
                descriptionText !== currentDescriptionText
              ) {
                loseChangedDescription = false
                throw fail(
                  "WRITE_OUTCOME_UNKNOWN",
                  "Changed description transport lost before apply",
                )
              }
              const markerChange = property(changes.Publication ?? changes.publication)
              const markerText = (markerChange.rich_text as unknown[] | undefined)
                ?.map((item) => String(property(property(item).text).content ?? ""))
                .join("")
              if (
                loseMarkerBeforeApply &&
                markerText &&
                property(JSON.parse(markerText)).state === "writing"
              ) {
                loseMarkerBeforeApply = false
                throw fail("WRITE_OUTCOME_UNKNOWN", "Writing marker transport lost before apply")
              }
              if (loseBeforeApply && !changes.Publication && !changes.publication) {
                loseBeforeApply = false
                throw fail("WRITE_OUTCOME_UNKNOWN", "Property transport lost before apply")
              }
              saveProperties(changes)
              revision++
              if (losePropertyResponse && !changes.Publication && !changes.publication) {
                losePropertyResponse = false
                throw fail("WRITE_OUTCOME_UNKNOWN", "Applied property response lost")
              }
            }
            return row()
          }
          for (const id of [alpha, beta])
            if (path === `v1/pages/${id}`) {
              const member = members.get(id)
              if (!member) throw fail("ACCESS_DENIED", "Member unavailable")
              return structuredClone(member)
            }
          if (path.startsWith(`v1/pages/${router}/properties/references`))
            return {
              object: "list",
              results: (property(properties.References).rich_text as unknown[]).map(
                (rich_text) => ({ rich_text }),
              ),
              has_more: false,
              next_cursor: null,
            }
          for (const [id, baseline] of baselines) {
            if (path === `v1/pages/${id}`)
              return {
                id,
                last_edited_time: edited(0),
                archived: false,
                in_trash: false,
                properties: { title: title(baseline.name) },
              }
            if (path.startsWith(`v1/blocks/${id}/children`))
              return {
                results: structuredClone(baseline.blocks),
                has_more: false,
                next_cursor: null,
              }
          }
          const blockPath = /^v1\/blocks\/([^/?]+)(\/children)?(?:\?.*)?$/.exec(path)
          if (blockPath) {
            const id = blockPath[1]!
            if (blockPath[2]) {
              const results = (blockChildren.get(id) ?? []).map((id) => blocks.get(id)!)
              if (id === router) results.push(...children.map(childBlock))
              if (id !== router && !blocks.has(id) && !children.some((child) => child.id === id))
                throw fail("OBJECT_NOT_FOUND", "Block parent unavailable")
              return paginate(path, results)
            }
            const block = blocks.get(id)
            if (block) {
              if (method === "PATCH") {
                const type = String(block.type),
                  changes = property(property(payload)[type])
                const data = { ...property(block[type]), ...structuredClone(changes) }
                if (Array.isArray(changes.rich_text))
                  data.rich_text = richResponse(changes.rich_text)
                if (Array.isArray(changes.cells))
                  data.cells = changes.cells.map((cell) => richResponse(cell as unknown[]))
                block[type] = data
                let ancestor = block
                while (property(ancestor.parent).type === "block_id")
                  ancestor = blocks.get(String(property(ancestor.parent).block_id))!
                const owner = String(property(ancestor.parent).page_id)
                const child = children.find((child) => child.id === owner)
                const nextRevision = child ? ++child.revision : ++revision
                block.last_edited_time = edited(nextRevision)
              }
              return structuredClone(block)
            }
            const child = children.find((child) => child.id === id)
            if (child && method === "GET") return childBlock(child)
            throw fail("OBJECT_NOT_FOUND", "Block unavailable")
          }
          if (path === "v1/file_uploads") return { id: `upload-${++upload}` }
          if (path.startsWith("v1/file_uploads/") && path.endsWith("/send")) {
            uploads.set(path.split("/")[2]!, new Uint8Array(await readFile(options!.file!)))
            return { status: "uploaded" }
          }
          const id = path.split("/")[2],
            child = children.find((child) => child.id === id)
          if (path.endsWith("/markdown") && (id === router || child)) {
            const parentMarkdown = () => {
              const tags = children
                .filter((child) => !main.includes(child.id.replaceAll("-", "")))
                .map(
                  (child) =>
                    `<page url="https://app.notion.com/p/${child.id.replaceAll("-", "")}">${child.name}</page>`,
                )
                .join("\n")
              return `${main}${tags ? "\n" + tags : ""}`
            }
            if (method === "PATCH") {
              const content = property(payload)
              let next: string
              if (content.type === "update_content") {
                const change = property(
                  (property(content.update_content).content_updates as unknown[])[0],
                )
                if (change.old_str !== (child ? child.body : parentMarkdown()))
                  throw fail("WRITE_CONFLICT", "Markdown changed")
                next = String(change.new_str)
              } else next = String(property(content.replace_content).new_str)
              // Markdown writes create blocks with normalized destinations. Only
              // individual block PATCH retains an authored Notion URL fragment.
              next = normalizeMarkdown(next)
              replaceBlocks(id!, next)
              if (child) {
                child.body = next
                child.revision++
              } else {
                main = next
                revision++
              }
            }
            return {
              object: "page_markdown",
              markdown: normalizeMarkdown(child ? child.body : parentMarkdown()),
              truncated: false,
              unknown_block_ids: [],
            }
          }
          if (child)
            return {
              id: child.id,
              parent: { type: "page_id", page_id: router },
              archived: false,
              in_trash: false,
              last_edited_time: edited(child.revision),
              properties: { title: title(child.name) },
            }
          throw fail("UNEXPECTED", `Unexpected controlled request ${method} ${path}`)
        },
        catch: (error) =>
          error instanceof SkillsError ? error : fail("FIXTURE_FAILED", String(error)),
      }),
  })
  const roots = ConfigProvider.fromUnknown({
    NTN_SKILLS_HOME: join(directory, "state"),
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
  })
  // Each call builds and closes fresh Store/publisher layers over the same durable roots.
  const run = <A, E>(effect: Effect.Effect<A, E, any>) => {
    const services = StoreLive.pipe(
      Layer.provideMerge(Layer.merge(NodeServices.layer, NodeHttpClient.layerFetch)),
      Layer.provideMerge(Layer.succeed(Notion, api)),
    )
    const live = Layer.merge(
      Layer.effect(
        UpstreamState,
        Effect.map(Store, (store) => store.upstream),
      ),
      UpstreamPublisherLive,
    ).pipe(Layer.provideMerge(services))
    return Effect.runPromise(
      Effect.scoped(effect).pipe(
        Effect.provide(live),
        Effect.provide(ConfigProvider.layer(roots)),
        Effect.provide(CliConfig.layer({})),
        Effect.provide(CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))),
      ) as Effect.Effect<A, E>,
    )
  }
  const put = async (path: string, value: string | Uint8Array) => {
    await mkdir(dirname(join(input, path)), { recursive: true })
    await writeFile(join(input, path), value)
  }
  if (upstream)
    await run(
      Effect.flatMap(Store, (store) =>
        store.writeJson("config.json", { upstream_database: upstreamDatabase }),
      ),
    )
  await put(
    MANIFEST,
    JSON.stringify({
      format: "ntn-skills",
      version: 2,
      kind: upstream ? "skill" : "router",
      name: upstream ? "Frozen Mode Skill" : "Sample Router",
      description: upstream ? "Use for mode recovery." : "Use for routing.",
      main: upstream ? "SKILL.md" : "ROUTER.md",
    }),
  )
  await put(
    upstream ? "SKILL.md" : "ROUTER.md",
    upstream ? "# Frozen mode bytes\n\nRead [guide](references/guide.md).\n" : authoredRouter,
  )
  await put("references/guide.md", "# Own guide\n\nRouter reference instructions.\n")
  await put("assets/data.bin", new Uint8Array([0, 255, 7, 128]))
  return {
    run,
    input,
    put,
    members,
    properties,
    subscriptionProperties,
    sourceRequests,
    requests,
    writes,
    children,
    beforeRequest: (hook) => {
      beforeRequest = hook
    },
    body: () => main,
    memberIds: () =>
      (property(properties.Members).relation as Array<{ id: string }>).map((item) => item.id),
    losePropertyResponse: () => {
      losePropertyResponse = true
    },
    losePropertyResponseBeforeApply: () => {
      loseBeforeApply = true
    },
    loseChangedDescriptionResponseBeforeApply: () => {
      loseChangedDescription = true
    },
    loseMarkerResponseBeforeApply: () => {
      loseMarkerBeforeApply = true
    },
    editBody: () => {
      main = "External author body.\n"
      replaceBlocks(router, main)
      revision++
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(directory, { recursive: true, force: true })
    },
  }
}

const selectedMember = "fixture/read-recovery"
const earlierMember = "fixture/earlier"

async function originalReadFailurePlan(f: RouterFixture) {
  const portable: PortableSkill = {
    kind: "skill",
    name: "Frozen Mode Skill",
    description: "Use for mode recovery.",
    main: "SKILL.md",
    files: [
      {
        path: "SKILL.md",
        bytes: new TextEncoder().encode("# Frozen text\n\nRead [guide](references/guide.md).\n"),
      },
      {
        path: "references/guide.md",
        bytes: new TextEncoder().encode("# Own guide\n\nKeep the original frozen text.\n"),
      },
    ],
  }
  const result = await f.run(
    Effect.gen(function* () {
      const current = yield* getSubscription(subscription)
      const frozen = yield* freezePortable(portable)
      const contentHash = yield* portableIdentity(portable)
      const earlier: PortableSkill = { ...portable, name: "Unselected Earlier Skill" }
      const earlierFrozen = yield* freezePortable(earlier)
      const earlierHash = yield* portableIdentity(earlier)
      const decoded = strictDecode(UpstreamPlanSchema, {
        version: 1,
        plan_id: "pending",
        plan_hash: "pending",
        created_at: 1,
        subscription_id: subscription,
        subscription_version: current.version,
        scope: yield* authScope,
        database_id: current.database_id,
        config_hash: yield* subscriptionConfigHash(current),
        revision: "v1",
        source_manifest: {
          version: 1,
          source_id: subscription,
          revision: "v1",
          members: [
            { key: earlierMember, value: earlierFrozen },
            { key: selectedMember, value: frozen },
          ].map(({ key, value }) => {
            return {
              member_key: key,
              source_path: key,
              main: value.main,
              resources: value.files.map((file) => ({ path: file.path, sha256: file.hash })),
            }
          }),
        },
        provenance: { fixture: "natural-prepublication-read-failure" },
        publisher_subscription_id: subscription,
        target_database_id: database,
        items: [
          {
            member_key: earlierMember,
            target_key: targetKey(current, earlierMember),
            action: "create",
            reason: "source-changed",
            generation: 0,
            deltas: [],
            candidate: earlierFrozen,
            accepted: earlierFrozen,
            content_hash: earlierHash,
          },
          {
            member_key: selectedMember,
            target_key: targetKey(current, selectedMember),
            action: "create",
            reason: "source-changed",
            generation: 0,
            deltas: [],
            candidate: frozen,
            accepted: frozen,
            content_hash: contentHash,
          },
        ],
      })
      const { plan_id: _id, plan_hash: _hash, ...body } = decoded
      const planHash = yield* sha256(JSON.stringify(body))
      const plan: UpstreamPlan = { ...body, plan_id: `up_${planHash}`, plan_hash: planHash }
      // Seed only the reviewed frozen plan. applyUpstream creates the original
      // operation, error outcome, integrity, map checkpoint and every receipt itself.
      yield* (yield* UpstreamState).savePlan(plan)
      const operationId = `uo_${yield* sha256(plan.plan_id)}`
      const alias = `${operationId}:1`
      return { plan, operationId, alias, publicationId: `p_${yield* sha256(alias)}`, contentHash }
    }),
  )
  return { ...result, portable }
}

type OriginalReadFailure = Awaited<ReturnType<typeof originalReadFailurePlan>>
const readFailureEvidence = (f: RouterFixture, original: OriginalReadFailure) =>
  f.run(
    Effect.gen(function* () {
      const store = yield* Store,
        state = yield* UpstreamState
      return {
        plan: yield* state.plan(original.plan.plan_id),
        operation: yield* state.operation(original.plan.plan_id),
        receipt: yield* store.readJson(
          `publications/${original.publicationId}.json`,
          PublicationReceiptSchema,
        ),
        integrity: yield* store.integrity.inspect(original.publicationId),
        bindings: yield* state.bindings(subscription),
      }
    }),
  )

function assertUnboundReadFailure(
  original: OriginalReadFailure,
  evidence: Awaited<ReturnType<typeof readFailureEvidence>>,
  error: string,
) {
  expect(evidence.plan).toEqual(original.plan)
  expect(evidence.operation).toMatchObject({
    operation_id: original.operationId,
    plan_id: original.plan.plan_id,
    state: "unknown",
    items: [
      { member_key: earlierMember, status: "pending" },
      {
        member_key: selectedMember,
        status: "unknown",
        error_code: error,
        publication_operation_id: original.alias,
      },
    ],
  })
  expect(evidence.receipt).toBeUndefined()
  expect(evidence.integrity).toMatchObject({
    version: 1,
    operation_id: original.publicationId,
    marker: { version: 2, operation_id: original.publicationId, state: "writing" },
  })
  expect(evidence.integrity?.page_id).toBeUndefined()
  expect(evidence.integrity?.marker).not.toHaveProperty("creation")
  expect(evidence.integrity?.marker).not.toHaveProperty("base_revision")
  expect(evidence.integrity?.marker.intended_hash).toBe(evidence.integrity?.intended_hash)
  expect(evidence.bindings).toEqual([])
}

const rootCreates = (f: RouterFixture) =>
  f.writes.filter(
    ({ path, body }) =>
      path === "v1/pages" && property(property(body).parent).data_source_id === dataSource,
  )

for (const scenario of [
  { title: "RATE_LIMITED GET", raised: "RATE_LIMITED", retained: "RATE_LIMITED", query: false },
  {
    title: "CATALOG_INCOMPLETE GET",
    raised: "CATALOG_INCOMPLETE",
    retained: "CATALOG_INCOMPLETE",
    query: false,
  },
  {
    title: "NTN_UNAVAILABLE GET",
    raised: "NTN_UNAVAILABLE",
    retained: "NTN_UNAVAILABLE",
    query: false,
  },
  {
    title: "catalog query read failure",
    raised: "NTN_UNAVAILABLE",
    retained: "CATALOG_INCOMPLETE",
    query: true,
  },
]) {
  test(`original selected plan naturally recovers ${scenario.title} before bind`, async () => {
    const f = await fixture(true)
    try {
      const original = await originalReadFailurePlan(f)
      let rejected = false
      f.beforeRequest(({ path, method }) => {
        if (
          !rejected &&
          path === `v1/data_sources/${dataSource}${scenario.query ? "/query" : ""}` &&
          method === (scenario.query ? "POST" : "GET")
        ) {
          rejected = true
          throw fail(scenario.raised, "Controlled original read failure")
        }
      })
      const first = await f.run(applyUpstream(original.plan.plan_id, [selectedMember]))
      expect(rejected).toBe(true)
      const retained = await readFailureEvidence(f, original)
      assertUnboundReadFailure(original, retained, scenario.retained)
      expect(first).toEqual(retained.operation)
      const child = await f.run(showOperation(original.alias).pipe(Effect.result))
      expect(child).toMatchObject({
        _tag: "Failure",
        failure: {
          code: "OPERATION_NOT_FOUND",
          details: {
            operation_id: original.alias,
            publication_operation_id: original.publicationId,
            parent_operation_id: original.operationId,
            next: { argv: ["ntn-skills", "operation", "show", original.operationId] },
          },
        },
      })
      expect(f.writes.every((write) => write.path === `v1/pages/${subscription}`)).toBe(true)
      expect(rootCreates(f)).toEqual([])
      f.beforeRequest(() => {})
      const resumed = await f.run(applyUpstream(original.plan.plan_id, [selectedMember]))
      expect(resumed.operation_id).toBe(first.operation_id)
      expect(resumed.state).toBe("partial")
      expect(resumed.items[0]).toEqual(first.items[0])
      expect(resumed.items[1]).toMatchObject({
        member_key: selectedMember,
        status: "verified",
        page_id: router,
        publication_operation_id: original.publicationId,
      })
      const completed = await readFailureEvidence(f, original)
      expect(completed.plan).toEqual(original.plan)
      expect(completed.receipt).toMatchObject({
        operation_id: original.publicationId,
        state: "completed",
        page_id: router,
        operation: "create",
        context: {
          ownership: {
            subscription_id: subscription,
            member_key: selectedMember,
            mode: "tracked",
            published_hash: original.contentHash,
            revision: "v1",
          },
        },
      })
      expect(completed.receipt?.portable.files).toEqual(
        original.plan.items[1]!.candidate!.files.map((file) => ({
          path: file.path,
          sha256: file.hash,
        })),
      )
      expect(completed.integrity?.intended_hash).toBe(retained.integrity?.intended_hash)
      expect(completed.integrity?.marker).toMatchObject({
        state: "committed",
        operation_id: original.publicationId,
      })
      expect(completed.bindings).toHaveLength(1)
      expect(completed.bindings[0]).toMatchObject({
        member_key: selectedMember,
        generation: 1,
        page_id: router,
        accepted: original.plan.items[1]!.accepted,
        materialized: original.plan.items[1]!.candidate,
      })
      expect(rootCreates(f)).toHaveLength(1)
      expect(f.children).toHaveLength(1)
      const snapshot = await f.run(openSkill(router, { refresh: true }))
      const exported = await f.run(snapshotAuthoredPortable(snapshot))
      expect(await f.run(portableIdentity(exported))).toBe(original.contentHash)
      const writes = f.writes.length
      const repeated = await f.run(applyUpstream(original.plan.plan_id, [selectedMember]))
      expect(repeated.items).toEqual(resumed.items)
      expect(repeated.operation_id).toBe(original.operationId)
      expect(f.writes).toHaveLength(writes)
      expect(rootCreates(f)).toHaveLength(1)
      expect(f.sourceRequests).toEqual([])
    } finally {
      await f.close()
    }
  }, 60000)
}

for (const error of ["NOTION_REQUEST_FAILED", "WRITE_OUTCOME_UNKNOWN"]) {
  test(`unclassified ${error} keeps the original unbound child unknown`, async () => {
    const f = await fixture(true)
    try {
      const original = await originalReadFailurePlan(f)
      let rejected = false
      f.beforeRequest(({ path, method }) => {
        if (!rejected && method === "GET" && path === `v1/data_sources/${dataSource}`) {
          rejected = true
          throw fail(error, "Unclassified original read failure")
        }
      })
      await f.run(applyUpstream(original.plan.plan_id, [selectedMember]))
      expect(rejected).toBe(true)
      const before = await readFailureEvidence(f, original)
      assertUnboundReadFailure(original, before, error)
      f.beforeRequest(() => {})
      const writes = f.writes.length
      await f.run(applyUpstream(original.plan.plan_id, [selectedMember]))
      expect(await readFailureEvidence(f, original)).toEqual(before)
      expect(f.writes).toHaveLength(writes)
      expect(rootCreates(f)).toEqual([])
    } finally {
      await f.close()
    }
  }, 60000)
}

test("an actual same-name CREATE_CONFLICT is neither adopted nor replayed by read-failure recovery", async () => {
  const f = await fixture(true)
  try {
    const original = await originalReadFailurePlan(f)
    await f.run(createPortable(original.portable, { database }))
    expect(rootCreates(f)).toHaveLength(1)
    const rootBody = f.body(),
      children = structuredClone(f.children)
    await f.run(applyUpstream(original.plan.plan_id, [selectedMember]))
    const before = await readFailureEvidence(f, original)
    assertUnboundReadFailure(original, before, "CREATE_CONFLICT")
    const writes = f.writes.length
    await f.run(applyUpstream(original.plan.plan_id, [selectedMember]))
    expect(await readFailureEvidence(f, original)).toEqual(before)
    expect(f.writes).toHaveLength(writes)
    expect(rootCreates(f)).toHaveLength(1)
    expect(f.body()).toBe(rootBody)
    expect(f.children).toEqual(children)
  } finally {
    await f.close()
  }
}, 60000)

test("NTN_UNAVAILABLE recovery repeats current configuration proof inside the publication lock", async () => {
  const f = await fixture(true)
  try {
    const original = await originalReadFailurePlan(f)
    let rejected = false
    f.beforeRequest(({ path, method }) => {
      if (!rejected && method === "GET" && path === `v1/data_sources/${dataSource}`) {
        rejected = true
        throw fail("NTN_UNAVAILABLE", "Original pre-bind read failure")
      }
    })
    await f.run(applyUpstream(original.plan.plan_id, [selectedMember]))
    const before = await readFailureEvidence(f, original)
    assertUnboundReadFailure(original, before, "NTN_UNAVAILABLE")
    let scopes = 0
    f.beforeRequest(({ path }) => {
      if (path === "v1/users/me" && ++scopes === 3)
        f.subscriptionProperties.Include = rich('["changed-after-first-proof/**"]')
    })
    const writes = f.writes.length
    await f.run(applyUpstream(original.plan.plan_id, [selectedMember]))
    expect(scopes).toBeGreaterThanOrEqual(3)
    const after = await readFailureEvidence(f, original)
    expect(after).toEqual(before)
    expect(f.writes).toHaveLength(writes)
    expect(rootCreates(f)).toEqual([])
  } finally {
    await f.close()
  }
}, 60000)
