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
import { createSkill, replaceSkill, resumePublication } from "../src/mutation.ts"
import { updateSkill, reconcileOperation, showOperation } from "../src/command-operations.ts"
import { publicationSourceRows, publicationSourceSchema } from "./fixtures.ts"
import {
  exportSkill,
  portableIdentity,
  snapshotAuthoredPortable,
  snapshotPortable,
} from "../src/export.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { Notion } from "../src/notion.ts"
import { Store, StoreLive } from "../src/store.ts"
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
import { registerUpstreamRecoveryTests } from "./upstream-mode-recovery-cases.ts"
import { registerPublicationGuardTests } from "./publication-guard-cases.ts"
import { registerPublicationSourceTests } from "./publication-source-cases.ts"

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
          if (path === `v1/pages/${subscription}`)
            return {
              id: subscription,
              parent: { database_id: upstreamDatabase, data_source_id: upstreamDataSource },
              last_edited_time: edited(0),
              archived: false,
              in_trash: false,
              properties: structuredClone(subscriptionProperties),
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
              if (method === "PATCH") {
                const appended: unknown[] = []
                const append = (parent: string, raw: unknown): void => {
                  const input = property(raw),
                    type = String(input.type),
                    data = structuredClone(property(input[type]))
                  const nested = data.children
                  delete data.children
                  const child = addBlock(parent, type, data)
                  if (parent === id) appended.push(blocks.get(child))
                  if (Array.isArray(nested)) for (const item of nested) append(child, item)
                }
                for (const raw of property(payload).children as unknown[]) append(id, raw)
                revision++
                return { results: structuredClone(appended), has_more: false, next_cursor: null }
              }
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
          const uploadStatus = /^v1\/file_uploads\/(upload-(\d+))$/.exec(path)
          if (
            method === "GET" &&
            uploadStatus &&
            Number(uploadStatus[2]) > 0 &&
            Number(uploadStatus[2]) <= upload
          )
            return {
              id: uploadStatus[1],
              status: uploads.has(uploadStatus[1]!) ? "uploaded" : "pending",
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

async function withRouter(use: (f: RouterFixture) => Promise<void>) {
  const f = await fixture()
  try {
    await use(f)
  } finally {
    await f.close()
  }
}

for (const selected of [[], [beta, `skill://${alpha}/SKILL.md`, beta, alpha]] as const) {
  test(
    `Node Router create retains own resources with ${selected.length ? "sorted deduplicated" : "empty"} Members`,
    async () =>
      withRouter(async (f) => {
        const created = await f.run(createSkill(f.input, { database, members: selected }))
        expect(created).toMatchObject({
          action: "create",
          verified: true,
          record: { kind: "router", entrypoint: "ROUTER.md" },
        })
        expect(f.memberIds()).toEqual(selected.length ? [alpha, beta] : [])
        const snapshot = await f.run(openSkill(router, { refresh: true }))
        expect(snapshot.references?.map((entry) => entry.path).sort()).toEqual([
          "ROUTER.md",
          "references/guide.md",
        ])
        const entry = await f.run(readSkill(snapshot.snapshot_id))
        expect(entry).toMatchObject({ path: "ROUTER.md" })
        expect("content" in entry && entry.content).toContain("# Route requests")
        expect("content" in entry && entry.content).toContain("## Members")
        if (selected.length) {
          expect("content" in entry && entry.content).toContain("Alpha Skill")
          expect("content" in entry && entry.content).toContain("Beta Skill")
        }
        const portable = await f.run(snapshotPortable(snapshot))
        expect(portable).toMatchObject({ kind: "router", main: "ROUTER.md" })
        expect(
          Array.from(portable.files.find((file) => file.path === "assets/data.bin")!.bytes),
        ).toEqual([0, 255, 7, 128])
        expect(
          new TextDecoder().decode(
            portable.files.find((file) => file.path === "references/guide.md")!.bytes,
          ),
        ).toContain("Router reference instructions.")
        expect(
          f.requests.some(({ path }) =>
            [alpha, beta].some((id) => path.startsWith(`v1/pages/${id}/markdown`)),
          ),
        ).toBe(false)
        expect(f.requests.some(({ path }) => path.startsWith("v1/ai/skills/"))).toBe(false)
      }),
    30000,
  )
}

test(
  "Node Router replace preserves omitted Members, changes authored body/resources, then clears and replaces only the relation",
  async () =>
    withRouter(async (f) => {
      const created = await f.run(createSkill(f.input, { database, members: [beta, alpha] }))
      const original = await f.run(openSkill(router, { refresh: true }))
      await f.put("ROUTER.md", "# Revised route\n\nRead [guide](references/guide.md).\n")
      await f.put("references/guide.md", "# Revised own guide\n")
      await f.put("assets/data.bin", new Uint8Array([4, 0, 255]))
      const replaced = await f.run(replaceSkill(f.input, { target: router }))
      expect(replaced).toMatchObject({ action: "update", verified: true })
      expect(f.memberIds()).toEqual([alpha, beta])
      const snapshot = await f.run(openSkill(router, { refresh: true }))
      expect(snapshot.version_id).not.toBe(original.version_id)
      const authored = await f.run(snapshotAuthoredPortable(snapshot))
      expect(
        new TextDecoder().decode(authored.files.find((file) => file.path === authored.main)!.bytes),
      ).toContain("# Revised route")
      expect(
        Array.from(authored.files.find((file) => file.path === "assets/data.bin")!.bytes),
      ).toEqual([4, 0, 255])
      expect(
        new TextDecoder().decode(
          authored.files.find((file) => file.path === "references/guide.md")!.bytes,
        ),
      ).toContain("# Revised own guide")
      const originalGuide = await f.run(
        readSkill(created.snapshot_id!, { path: "references/guide.md" }),
      )
      expect("content" in originalGuide && originalGuide.content).toContain(
        "Router reference instructions.",
      )
      const body = f.body(),
        childIds = f.children.map((child) => child.id)
      for (const members of [[], [beta, beta]] as const) {
        const result = await f.run(replaceSkill(f.input, { target: router, members }))
        expect(result).toMatchObject({ action: "update", verified: true })
        expect(f.memberIds()).toEqual(members.length ? [beta] : [])
        expect(f.body()).toBe(body)
        expect(f.children.map((child) => child.id)).toEqual(childIds)
        const saved = await f.run(
          snapshotAuthoredPortable(await f.run(openSkill(router, { refresh: true }))),
        )
        expect(saved.files).toEqual(authored.files)
      }
      const before = f.writes.length
      expect(await f.run(replaceSkill(f.input, { target: router, members: [beta] }))).toMatchObject(
        { action: "reuse" },
      )
      expect(f.writes).toHaveLength(before)
    }),
  30000,
)

test(
  "Node Router update changes Members and versions while preserving own body and resources",
  async () =>
    withRouter(async (f) => {
      await f.run(createSkill(f.input, { database, members: [] }))
      const initial = await f.run(openSkill(router, { refresh: true }))
      const authored = await f.run(snapshotAuthoredPortable(initial)),
        body = f.body()
      for (const members of [[beta, alpha, beta], []] as const) {
        const before = await f.run(openSkill(router, { refresh: true }))
        const start = f.writes.length
        const updated = await f.run(updateSkill(`skill://${router}/ROUTER.md`, { members }))
        expect(updated.verified).toBe(true)
        expect(updated.previous_version_id).toBe(before.version_id)
        const after = await f.run(openSkill(router, { refresh: true }))
        expect(after.version_id).not.toBe(before.version_id)
        expect(f.memberIds()).toEqual(members.length ? [alpha, beta] : [])
        expect(f.body()).toBe(body)
        expect((await f.run(snapshotAuthoredPortable(after))).files).toEqual(authored.files)
        const propertyPatches = f.writes
          .slice(start)
          .filter(
            ({ path, body }) =>
              path === `v1/pages/${router}` &&
              !property(property(body).properties).Publication &&
              !property(property(body).properties).publication,
          )
        expect(propertyPatches.map(({ body }) => property(body).properties)).toEqual([
          { members: { relation: (members.length ? [alpha, beta] : []).map((id) => ({ id })) } },
        ])
      }
      await f.run(updateSkill(router, { members: [alpha] }))
      const before = await f.run(openSkill(router, { refresh: true }))
      f.members.get(alpha)!.properties.Description = {
        id: "description",
        ...rich("Updated member metadata."),
      }
      const after = await f.run(openSkill(router, { refresh: true }))
      expect(after.version_id).not.toBe(before.version_id)
      const read = await f.run(readSkill(after.snapshot_id))
      expect("content" in read && read.content).toContain("Updated member metadata.")
      const oldRead = await f.run(readSkill(before.snapshot_id))
      expect("content" in oldRead && oldRead.content).toContain("Use for alpha.")
      expect("content" in oldRead && oldRead.content).not.toContain("Updated member metadata.")
      const output = join(dirname(f.input), "snapshot-export")
      const exported = await f.run(
        exportSkill(after.snapshot_id, { output, projection: "snapshot" }),
      )
      expect(exported).toMatchObject({
        entrypoint: "ROUTER.md",
        main_path: "ROUTER.md",
        projection: "snapshot",
      })
      expect(await readFile(join(output, "ROUTER.md"), "utf8")).toContain(
        "Updated member metadata.",
      )
      expect(Array.from(await readFile(join(output, "assets/data.bin")))).toEqual([0, 255, 7, 128])
    }),
  30000,
)

const invalidCases = [
  "nested-router",
  "prompt",
  "cross-library",
  "cross-datasource",
  "unavailable",
  "trashed",
  "name",
  "resource-ref",
  "pinned-ref",
] as const
for (const invalid of invalidCases) {
  test(
    `Node Members reject ${invalid} before create/replace/update writes`,
    async () =>
      withRouter(async (f) => {
        const created = await f.run(createSkill(f.input, { database, members: [] }))
        const member = f.members.get(alpha)!
        let ref = alpha
        if (invalid === "nested-router" || invalid === "prompt")
          property(property(member.properties.Kind).select).name =
            invalid === "prompt" ? "prompt" : "router"
        if (invalid === "cross-library") member.parent.database_id = foreign
        if (invalid === "cross-datasource") member.parent.data_source_id = foreign
        if (invalid === "unavailable") f.members.delete(alpha)
        if (invalid === "trashed") member.in_trash = true
        if (invalid === "name") ref = "Alpha Skill"
        if (invalid === "resource-ref") ref = `skill://${alpha}/references/guide.md`
        if (invalid === "pinned-ref")
          ref = `skill://${alpha}/SKILL.md?snapshot=${created.snapshot_id}`
        const count = f.writes.length
        const operations = [
          createSkill(f.input, { database, name: "Another Router", members: [ref] }).pipe(
            Effect.asVoid,
          ),
          replaceSkill(f.input, { target: router, members: [ref] }).pipe(Effect.asVoid),
          updateSkill(router, { members: [ref] }).pipe(Effect.asVoid),
        ]
        for (const operation of operations) {
          const result = await f.run(operation.pipe(Effect.result))
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { code: invalid === "unavailable" ? "ACCESS_DENIED" : "INVALID_MEMBERS" },
          })
          expect(f.writes).toHaveLength(count)
        }
      }),
    30000,
  )
}

for (const external of ["members", "default-context", "provenance", "body"] as const) {
  test(
    `Node publication reconciliation retains conflict after external ${external} change`,
    async () =>
      withRouter(async (f) => {
        await f.run(createSkill(f.input, { database, members: [alpha] }))
        f.losePropertyResponse()
        const result = await f.run(
          updateSkill(router, { description: "Applied requested metadata." }).pipe(Effect.result),
        )
        if (result._tag !== "Failure") throw new Error("Expected a lost applied property response")
        expect(result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
        const operation = String(property(result.failure.details).operation_id)
        if (external === "members")
          f.properties.Members = {
            id: "members",
            type: "relation",
            relation: [{ id: beta }],
            has_more: false,
          }
        if (external === "default-context")
          f.properties["Default Context"] = { id: "default", type: "checkbox", checkbox: true }
        if (external === "provenance")
          f.properties["Upstream Revision"] = {
            id: "Upstream Revision",
            ...rich("external-revision"),
          }
        if (external === "body") f.editBody()
        const writes = f.writes.length,
          start = f.requests.length
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(await f.run(reconcileOperation(operation))).toMatchObject({
            verified: false,
            result: { outcome: "conflict" },
          })
          expect(await f.run(showOperation(operation))).toMatchObject({
            verified: false,
            resume_supported: false,
          })
          const receipt = await f.run(
            Effect.flatMap(Store, (store) =>
              store.readJson(`publications/${operation}.json`, PublicationReceiptSchema),
            ),
          )
          expect(receipt?.conflict).toBe(true)
        }
        expect(f.writes).toHaveLength(writes)
        expect(f.requests.slice(start).every(({ method }) => method === "GET")).toBe(true)
      }),
    30000,
  )
}

test(
  "formal CLI create --member preserves authored frontmatter/resources independently of generated Members",
  async () =>
    withRouter(async (f) => {
      // These bytes are copied from the failed real operation's retained objects:
      // main 75f861eebe4c91d2f9fefa804080b4b6bb02e6a65483c3b157b695b89ead5591,
      // reference 997f1ed88ffd840234a740fe1b5746d39263b2503a2d387a8788df397b9a0280.
      const originalMain = await readFile(
        new URL("./fixtures/router-original/ROUTER.md", import.meta.url),
        "utf8",
      )
      const originalReference = await readFile(
        new URL("./fixtures/router-original/references/export.md", import.meta.url),
        "utf8",
      )
      const originalManifest = await readFile(
        new URL("./fixtures/router-original/.ntn-skills.json", import.meta.url),
        "utf8",
      )
      await f.put(MANIFEST, originalManifest)
      const golden = readPortable([
        { path: MANIFEST, bytes: new TextEncoder().encode(originalManifest) },
        { path: "ROUTER.md", bytes: new TextEncoder().encode(originalMain) },
        { path: "references/export.md", bytes: new TextEncoder().encode(originalReference) },
      ])!
      expect(golden).toMatchObject({ kind: "router", main: "ROUTER.md" })
      const roundtrip = portableFiles(golden)
      expect(roundtrip.find((file) => file.path === MANIFEST)!.bytes).toEqual(
        new TextEncoder().encode(originalManifest),
      )
      expect(readPortable(roundtrip)).toEqual(golden)
      await f.put("ROUTER.md", originalMain)
      await rm(join(f.input, "references/guide.md"))
      await f.put("references/export.md", originalReference)
      await f.run(
        Command.runWith(root, { version: "test", renderErrors: false })([
          "create",
          f.input,
          "--database",
          database,
          "--member",
          beta,
          "--member",
          alpha,
        ]),
      )
      expect(f.memberIds()).toEqual([alpha, beta])
      const before = await f.run(openSkill(router, { refresh: true }))
      const authored = await f.run(snapshotAuthoredPortable(before))
      expect(
        new TextDecoder().decode(authored.files.find((file) => file.path === "ROUTER.md")!.bytes),
      ).toBe(originalMain)
      expect(before.record).toMatchObject({
        name: "Exclusive Router Member",
        description: "Router created by independent e2e with formal --member",
      })
      expect(f.body()).toContain("[Content Real Service Fixture](https://")
      expect(f.body()).not.toContain("(skill://")
      expect(f.body()).toContain("https://app.notion.com/p/3fc5636c236e81d7bbfefb6082c1ce7d")
      expect(f.body()).not.toContain("#ntn-skills-path=")
      expect(
        f.writes.some(
          ({ path, body }) =>
            /^v1\/blocks\/[^/]+$/.test(path) &&
            JSON.stringify(body).includes("#ntn-skills-path=SKILL.md"),
        ),
      ).toBe(true)
      const sourceOutput = join(dirname(f.input), "source-export")
      const authoredId = await f.run(portableIdentity(authored))
      await f.run(exportSkill(before.snapshot_id, { output: sourceOutput, projection: "source" }))
      expect(await readFile(join(sourceOutput, "ROUTER.md"), "utf8")).toBe(originalMain)
      expect(await readFile(join(sourceOutput, "references/export.md"), "utf8")).toBe(
        originalReference,
      )
      expect(Array.from(await readFile(join(sourceOutput, "assets/data.bin")))).toEqual([
        0, 255, 7, 128,
      ])
      const member = f.members.get(alpha)!
      member.properties.Description = {
        id: "description",
        ...rich("New generated member metadata."),
      }
      member.last_edited_time = "2026-10-17T00:01:00.000Z"
      const after = await f.run(openSkill(router, { refresh: true }))
      expect(after.version_id).not.toBe(before.version_id)
      expect((await f.run(snapshotAuthoredPortable(after))).files).toEqual(authored.files)
      const materialized = await f.run(snapshotPortable(after))
      expect(
        new TextDecoder().decode(
          materialized.files.find((file) => file.path === "ROUTER.md")!.bytes,
        ),
      ).toContain("New generated member metadata.")
      expect(await f.run(portableIdentity(await f.run(snapshotAuthoredPortable(after))))).toBe(
        authoredId,
      )
      const snapshotOutput = join(dirname(f.input), "generated-export")
      await f.run(
        exportSkill(after.snapshot_id, { output: snapshotOutput, projection: "snapshot" }),
      )
      expect(await readFile(join(snapshotOutput, "ROUTER.md"), "utf8")).toContain(
        "New generated member metadata.",
      )
      await f.run(
        Command.runWith(root, { version: "test", renderErrors: false })([
          "update",
          router,
          "--clear-members",
        ]),
      )
      expect(f.memberIds()).toEqual([])
      await f.run(
        Command.runWith(root, { version: "test", renderErrors: false })([
          "replace",
          f.input,
          "--target",
          router,
          "--member",
          beta,
        ]),
      )
      expect(f.memberIds()).toEqual([beta])
      expect(
        (await f.run(snapshotAuthoredPortable(await f.run(openSkill(router, { refresh: true })))))
          .files,
      ).toEqual(authored.files)
      expect(
        f.requests.some(({ path, method }) =>
          [alpha, beta].some(
            (id) =>
              path.startsWith(`v1/pages/${id}/markdown`) ||
              path.startsWith(`v1/blocks/${id}/children`) ||
              (path === `v1/pages/${id}` && method !== "GET"),
          ),
        ),
      ).toBe(false)
    }),
  30000,
)

test(
  "member metadata changed during publication conflicts instead of silently authorizing a new dependency",
  async () =>
    withRouter(async (f) => {
      const result = await f.run(
        createSkill(f.input, {
          database,
          members: [alpha, beta],
          onProgress: (event) =>
            event.stage === "body:ROUTER.md" && event.status === "started"
              ? Effect.sync(() => {
                  f.members.get(alpha)!.properties.Description = {
                    id: "description",
                    ...rich("External concurrent edit."),
                  }
                  f.members.get(alpha)!.last_edited_time = "2026-10-17T00:02:00.000Z"
                })
              : Effect.void,
        }).pipe(Effect.result),
      )
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "WRITE_PARTIAL", details: { cause_code: "WRITE_CONFLICT" } },
      })
    }),
  30000,
)

for (const external of [false, true]) {
  test(
    `metadata-only member dependency resume ${external ? "rejects an external member edit" : "succeeds without member body reads or writes"}`,
    async () =>
      withRouter(async (f) => {
        const stopped = await f.run(
          createSkill(f.input, {
            database,
            members: [alpha, beta],
            onProgress: (event) =>
              event.stage === "upload:source_bundle" && event.status === "started"
                ? Effect.fail(fail("PROGRESS_OUTPUT_FAILED", "Controlled output interruption"))
                : Effect.void,
          }).pipe(Effect.result),
        )
        if (stopped._tag !== "Failure")
          throw new Error("Expected retained publication interruption")
        expect(stopped.failure).toMatchObject({
          code: "WRITE_PARTIAL",
          details: { cause_code: "PROGRESS_OUTPUT_FAILED" },
        })
        const operation = String(property(stopped.failure.details).operation_id)
        const prepared = await f.run(
          Effect.flatMap(Store, (store) => store.integrity.inspect(operation)),
        )
        if (!prepared) throw new Error("Expected durable original integrity intent")
        expect(prepared.marker.state).toBe("writing")
        if (!external) {
          const reconcileStart = f.requests.length
          const writes = f.writes.length
          const reconciled = await f.run(reconcileOperation(operation))
          expect(reconciled.result).not.toMatchObject({ outcome: "conflict" })
          expect(f.writes).toHaveLength(writes)
          expect(f.requests.slice(reconcileStart).every(({ method }) => method === "GET")).toBe(
            true,
          )
          expect(
            await f.run(Effect.flatMap(Store, (store) => store.integrity.inspect(operation))),
          ).toEqual(prepared)
        }
        if (external) {
          f.members.get(alpha)!.properties.Description = {
            id: "description",
            ...rich("External member metadata."),
          }
          f.members.get(alpha)!.last_edited_time = "2026-10-17T00:03:00.000Z"
        }
        const start = f.requests.length
        const resumed = await f.run(resumePublication(operation).pipe(Effect.result))
        if (external) {
          expect(resumed).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_CONFLICT" } })
          expect(f.requests.slice(start).every(({ method }) => method === "GET")).toBe(true)
        } else {
          expect(resumed).toMatchObject({
            _tag: "Success",
            success: { verified: true, operation_id: operation },
          })
          const committed = await f.run(
            Effect.flatMap(Store, (store) => store.integrity.inspect(operation)),
          )
          expect(committed).toMatchObject({
            operation_id: operation,
            intended_hash: prepared.intended_hash,
            marker: {
              state: "committed",
              operation_id: operation,
              intended_hash: prepared.intended_hash,
            },
          })
          expect(publicationMarker({ properties: f.properties })).toMatchObject({
            state: "committed",
            operation_id: operation,
            intended_hash: prepared.intended_hash,
          })
        }
        expect(
          f.requests
            .slice(start)
            .some(({ path, method }) =>
              [alpha, beta].some(
                (id) =>
                  path.startsWith(`v1/pages/${id}/markdown`) ||
                  path.startsWith(`v1/blocks/${id}/children`) ||
                  (path === `v1/pages/${id}` && method !== "GET"),
              ),
            ),
        ).toBe(false)
      }),
    30000,
  )
}

test(
  "public publication writer cannot PATCH a metadata-only member dependency",
  async () =>
    withRouter(async (f) => {
      const rejected = await f.run(
        Effect.gen(function* () {
          const publication = yield* beginPublication(
            {
              kind: "router",
              name: "Sample Router",
              description: "Use for routing.",
              main: "ROUTER.md",
              files: [{ path: "ROUTER.md", bytes: new TextEncoder().encode(authoredRouter) }],
            },
            "replace",
            {},
            { members: [alpha, beta] },
          )
          yield* publication.bind(
            { database_id: database, data_source_id: dataSource, page_id: router },
            yield* authScope,
          )
          yield* publication.notion.request(`v1/pages/${alpha}`)
          const requests = f.requests.length
          const writes = f.writes.length
          const result = yield* publication.notion
            .request(
              `v1/pages/${alpha}`,
              {
                properties: {
                  description: {
                    rich_text: [{ text: { content: "Unauthorized dependency mutation" } }],
                  },
                },
              },
              { method: "PATCH" },
            )
            .pipe(Effect.result)
          expect(f.requests).toHaveLength(requests)
          expect(f.writes).toHaveLength(writes)
          return result
        }),
      )
      expect(rejected).toMatchObject({
        _tag: "Failure",
        failure: { code: "PUBLICATION_UNRESOLVED", details: { path: `v1/pages/${alpha}` } },
      })
    }),
  30000,
)

test("Notion link destinations roundtrip same-page paths, definitions and angles without touching code", () => {
  const main = `skill://${alpha}/SKILL.md`
  const guide = `skill://${alpha}/references/guide.md`
  const mainUrl = `https://www.notion.so/${alpha.replaceAll("-", "")}#ntn-skills-path=SKILL.md`
  const guideUrl = `https://www.notion.so/${alpha.replaceAll("-", "")}#ntn-skills-path=references%2Fguide.md`
  const source = [
    `[main](${main}) and [guide](<${guide}> "Guide title")`,
    "[main by definition][main-ref] and [guide by definition][guide-ref]",
    `[main-ref]: ${main} "Main title"`,
    `[guide-ref]: <${guide}> "Guide title"`,
    `Inline code: \`[not a link](${main})\` and \`\`[also literal](<${guide}>)\`\`.`,
    "```markdown",
    `[fenced literal](${guide})`,
    `[literal-definition]: <${main}>`,
    "```",
    "~~~markdown",
    `[tilde literal](${main})`,
    "~~~",
    "",
  ].join("\n")
  // Even when the destination page is known locally, each HTTPS destination's
  // encoded resource path wins over any page-ID-only lookup or member hint.
  const pages = [{ id: alpha, path: "references/local-alias.md", markdown: "" }]
  const remote = rewritePageLinks(source, "ROUTER.md", pages, "notion")
  expect(remote).toBe(
    [
      `[main](${mainUrl}) and [guide](<${guideUrl}> "Guide title")`,
      "[main by definition][main-ref] and [guide by definition][guide-ref]",
      `[main-ref]: ${mainUrl} "Main title"`,
      `[guide-ref]: <${guideUrl}> "Guide title"`,
      `Inline code: \`[not a link](${main})\` and \`\`[also literal](<${guide}>)\`\`.`,
      "```markdown",
      `[fenced literal](${guide})`,
      `[literal-definition]: <${main}>`,
      "```",
      "~~~markdown",
      `[tilde literal](${main})`,
      "~~~",
      "",
    ].join("\n"),
  )
  expect(rewritePageLinks(remote, "ROUTER.md", pages, "local", [{ id: alpha, ref: main }])).toBe(
    source,
  )
})

registerUpstreamRecoveryTests(fixture)
registerPublicationGuardTests(fixture)
registerPublicationSourceTests(fixture)
