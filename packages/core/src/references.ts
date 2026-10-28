import { Effect } from "effect"
import { HttpClient } from "effect/http"
import { readImportZip } from "./import.ts"
import type { ImportFile } from "./import.ts"
import { decode, fail, property, text, SkillsError, type NotionPageRecord } from "./model.ts"
import { Notion } from "./notion.ts"
import { requestTimeoutMs } from "./request-timeout.ts"
import { BUNDLE, canonicalMain } from "./portable.ts"
import { portableSourceDecoder } from "./portable-source.ts"
import { fileRef, normalizePath, pageId, parseRef } from "./ref.ts"
import { sha256 } from "./store.ts"
import { fromNotionMarkdown, projectNotionBlockTree, type NotionBlockBoundary } from "./markdown.ts"
import { memberIds, resolveRouterMembers } from "./router-members.ts"
import { materializeTypedLinks, readLinkBlocks } from "./typed-links.ts"
import { CURRENT_MATERIALIZATION_VERSION } from "./materialization.ts"
import { withoutCreationMarker } from "./publication-create-identity.ts"
import { decodeMarkdownFiles } from "./markdown-files.ts"
import { notionFilenameAlias } from "./publication-markdown.ts"

export interface ReferencePage {
  readonly id: string
  readonly path: string
  readonly markdown: string
  readonly blocks?: readonly NotionBlockBoundary[]
}

export interface PageLinkRewriteOptions {
  readonly preserveExternalUrls?: boolean
}

export function referencesProperty(raw: unknown) {
  const value = property(property(raw).properties).References
  if (value === undefined) return undefined
  const reference = property(value)
  if (reference.type !== "rich_text" || typeof reference.id !== "string")
    throw fail(
      "INVALID_REFERENCES",
      "References must be a rich-text property containing page mentions or links.",
    )
  return reference
}

export function pageMarkdown(raw: unknown) {
  const value = property(raw)
  if (
    value.object !== "page_markdown" ||
    typeof value.markdown !== "string" ||
    value.truncated !== false ||
    !Array.isArray(value.unknown_block_ids) ||
    value.unknown_block_ids.length
  )
    throw fail(
      "MARKDOWN_INCOMPLETE",
      "Cannot read or write truncated or unsupported page Markdown.",
    )
  return value.markdown
}

export function referencePath(title: string, exact = false) {
  const label = title.trim()
  const candidate = /\.md$/i.test(label)
    ? exact || label.startsWith("references/")
      ? label
      : `references/${label}`
    : `references/${label
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-|-$/g, "")}.md`
  if (
    normalizePath(candidate) !== candidate ||
    candidate === "references/.md" ||
    !/(?:^|\/)[^/]+\.md$/i.test(candidate)
  )
    throw fail("INVALID_REFERENCES", "Reference titles must identify a safe Markdown path.", {
      title,
    })
  return candidate
}

function relativePath(from: string, to: string) {
  const base = from.split("/").slice(0, -1)
  const target = to.split("/")
  while (base.length && base[0] === target[0]) {
    base.shift()
    target.shift()
  }
  const value = [...base.map(() => ".."), ...target].join("/")
  return value.startsWith(".") ? value : `./${value}`
}

// Transform destinations, never prose inside code fences or inline code.

export function rewritePageLinks(
  markdown: string,
  from: string,
  pages: readonly ReferencePage[],
  direction: "local" | "notion",
  external: readonly { readonly id: string; readonly ref: string }[] = [],
  options: PageLinkRewriteOptions = {},
) {
  const byId = new Map(pages.map((page) => [page.id, page.path]))
  const byPath = new Map(pages.map((page) => [page.path, page.id]))
  const destination = (value: string) => {
    if (direction === "local") {
      const id = pageId(value)
      if (id) {
        // The reserved fragment binds each typed destination, including two paths on
        // the same page, without interpreting source examples or reading linked bodies.
        const fragment = new URL(value).hash
        if (fragment.startsWith("#ntn-skills-path=")) {
          const raw = value.slice(value.indexOf("#")).slice("#ntn-skills-path=".length)
          const marker = "&heading="
          const cut = raw.indexOf(marker)
          if (cut === -1) {
            const path = normalizePath(
              decodeURIComponent(fragment.slice("#ntn-skills-path=".length)),
            )
            return fileRef(id, path)
          }
          const path = normalizePath(decodeURIComponent(raw.slice(0, cut)))
          const heading = decodeURIComponent(raw.slice(cut + marker.length))
          if (byPath.get(path) !== id) return fileRef(id, path)
          return (
            relativePath(from, path)
              .split("/")
              .map((part) => encodeURIComponent(part))
              .join("/") + (heading ? `#${heading}` : "")
          )
        }
      }
      const target = id && byId.get(id)
      if (!target)
        return id
          ? (external.find((member) => pageId(member.id) === id)?.ref ?? fileRef(id, ""))
          : options.preserveExternalUrls
            ? value
            : (notionFilenameAlias(value) ?? value)
      const hash = new URL(value).hash
      return (
        relativePath(from, target)
          .split("/")
          .map((part) => encodeURIComponent(part))
          .join("/") + hash
      )
    }
    if (value.startsWith("skill://")) {
      const ref = parseRef(value)
      const id = pageId(ref.selector)
      if (!id || ref.snapshot)
        throw fail("INVALID_REF", "Notion page links require an exact current page identity.", {
          ref: value,
        })
      return `https://www.notion.so/${id.replaceAll("-", "")}#ntn-skills-path=${encodeURIComponent(ref.path)}`
    }
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(value)) return value
    const match = /^([^?#]+)([?#].*)?$/.exec(value)
    if (!match) return value
    let target: string
    try {
      target = normalizePath(decodeURIComponent(match[1]!), from)
    } catch {
      return value
    }
    const id = byPath.get(target)
    const suffix = match[2] ?? ""
    const heading = suffix.startsWith("#") ? suffix.slice(1) : ""
    return id
      ? heading
        ? `https://www.notion.so/${id.replaceAll("-", "")}#ntn-skills-path=${encodeURIComponent(target)}&heading=${encodeURIComponent(heading)}`
        : `https://www.notion.so/${id.replaceAll("-", "")}`
      : value
  }
  let fence: { marker: string; length: number } | undefined
  return markdown
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)
      if (fence) {
        if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length)
          fence = undefined
        return line
      }
      if (marker) {
        fence = { marker: marker[1]![0]!, length: marker[1]!.length }
        return line
      }
      return line
        .split(/(`+[^`]*`+)/g)
        .map((part, index) => {
          if (index % 2) return part
          let output = part.replace(
            /<(?:mention-page|page)\b[^>]*\burl="([^"]+)"[^>]*>([\s\S]*?)<\/(?:mention-page|page)>/g,
            (all, url: string, title: string) => {
              const changed = destination(url)
              return changed === url ? all : `[${title}](${changed})`
            },
          )
          output = output.replace(
            /(\]\(\s*<?)([^\s)>]+)(>?)(?=\s|\))/g,
            (_all, start: string, url: string, end: string) => `${start}${destination(url)}${end}`,
          )
          output = output.replace(
            /(^\s*\[[^\]]+\]:\s*<?)([^\s>]+)(>?)/g,
            (_all, start: string, url: string, end: string) => `${start}${destination(url)}${end}`,
          )
          // Bare URLs and autolinks also occur in Notion's page Markdown.
          if (direction === "local") {
            output = output.replace(/https?:\/\/[^\s<>\)\]]+/g, (url) => destination(url))
            if (!options.preserveExternalUrls)
              output = output.replace(
                /\[([^\[\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
                (all, text: string, url: string) => {
                  try {
                    const parsed = new URL(url)
                    if (
                      (parsed.pathname === "/" || parsed.pathname === "") &&
                      !parsed.search &&
                      !parsed.hash &&
                      text.toLowerCase() === parsed.hostname
                    )
                      return text
                  } catch {
                    return all
                  }
                  return all
                },
              )
          }
          return output
        })
        .join("")
    })
    .join("\n")
}

export function childPageTags(markdown: string) {
  return [...markdown.matchAll(/<page\b[^>]*\burl="[^"]+"[^>]*>[\s\S]*?<\/page>/g)].map(
    (match) => match[0],
  )
}

export function withoutChildPages(markdown: string) {
  return markdown.replace(/<page\b[^>]*\burl="[^"]+"[^>]*>[\s\S]*?<\/page>/g, "").trim()
}

function propertyEntries(page: unknown, reference: Record<string, unknown>) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const items: unknown[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const raw = property(
        yield* api.request(
          `v1/pages/${property(page).id}/properties/${reference.id}?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      )
      if (raw.object === "property_item") return [raw.rich_text]
      if (!Array.isArray(raw.results) || typeof raw.has_more !== "boolean")
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid References property items."))
      items.push(...raw.results.map((item) => property(item).rich_text))
      if (!raw.has_more) break
      if (typeof raw.next_cursor !== "string" || seen.has(raw.next_cursor))
        return yield* Effect.fail(
          fail("INVALID_RESPONSE", "References pagination returned a missing or repeating cursor."),
        )
      cursor = raw.next_cursor
      seen.add(cursor)
    } while (cursor)
    return items
  })
}

function rootBlockBoundaries(page: string, blocks: readonly Record<string, unknown>[]) {
  const id = pageId(page)
  if (!id) return undefined
  if (
    blocks.some((block) => {
      const parent = property(block.parent)
      const owner =
        parent.type === "page_id"
          ? parent.page_id
          : parent.type === "block_id"
            ? parent.block_id
            : undefined
      return typeof owner !== "string" || !pageId(owner)
    })
  )
    return undefined
  return projectNotionBlockTree(id, blocks)
}

function stableBlockBoundaries(
  id: string,
  before: unknown,
  blocks: readonly Record<string, unknown>[],
  api: Notion["Service"],
) {
  return Effect.gen(function* () {
    const boundaries = rootBlockBoundaries(id, blocks)
    const page = property(before),
      revision = page.last_edited_time
    if (
      !boundaries ||
      typeof revision !== "string" ||
      typeof page.id !== "string" ||
      pageId(page.id) !== pageId(id) ||
      page.in_trash === true ||
      page.archived === true
    )
      return undefined
    const after = property(yield* api.request(`v1/pages/${id}`))
    if (typeof after.last_edited_time !== "string") return undefined
    if (
      after.last_edited_time !== revision ||
      typeof after.id !== "string" ||
      pageId(after.id) !== pageId(id) ||
      after.in_trash === true ||
      after.archived === true
    )
      return yield* Effect.fail(
        fail("PUBLICATION_CHANGED", "A page changed while reading its block structure.", {
          page_id: id,
        }),
      )
    return boundaries
  })
}

// Editable Markdown files consume the live code-block bytes, never an archived ZIP.
export function readReferences(skill: NotionPageRecord, rawPage: unknown) {
  return Effect.gen(function* () {
    const decodeSource = yield* portableSourceDecoder
    const api = yield* Notion
    const reference = yield* Effect.try({
      try: () => referencesProperty(rawPage),
      catch: (error) => error as SkillsError,
    })
    if (!reference)
      return yield* Effect.fail(fail("INVALID_REFERENCES", "The skill has no References property."))
    const root = yield* api.request(`v1/pages/${skill.locator.page_id}/markdown`)
    const rawMarkdownValue = root
    const blocks = yield* readLinkBlocks(skill.locator.page_id, api, { structureEvidence: true })
    const editable = yield* Effect.try({
      try: () => decodeMarkdownFiles(blocks),
      catch: (error) => error as SkillsError,
    })
    if (editable) {
      const after = property(yield* api.request(`v1/pages/${skill.locator.page_id}`))
      const before = property(rawPage)
      if (
        typeof before.last_edited_time !== "string" ||
        after.last_edited_time !== before.last_edited_time ||
        after.id !== before.id ||
        after.in_trash === true ||
        after.archived === true ||
        JSON.stringify(after.properties) !== JSON.stringify(before.properties) ||
        JSON.stringify(after.parent) !== JSON.stringify(before.parent)
      )
        return yield* Effect.fail(
          fail("PUBLICATION_CHANGED", "The editable file page changed during its complete read."),
        )
      const files = editable.files.map((file) => ({
        ...file,
        path: file.path === editable.main ? skill.entrypoint : file.path,
      }))
      return {
        property_id: String(reference.id),
        members: [],
        pages: [],
        files,
        markdown_files: { main: skill.entrypoint },
        version_id: yield* sha256(
          JSON.stringify([
            CURRENT_MATERIALIZATION_VERSION,
            skill,
            yield* Effect.forEach(files, (file) =>
              sha256(file.bytes).pipe(Effect.map((hash) => [file.path, hash])),
            ),
          ]),
        ),
      }
    }
    const rawMarkdown = yield* Effect.try({
      try: () => pageMarkdown(rawMarkdownValue),
      catch: (error) => error as SkillsError,
    })
    const markdown = yield* materializeTypedLinks(skill.locator.page_id, rawMarkdown, api, blocks)
    const entries = yield* propertyEntries(rawPage, reference)
    const members =
      skill.kind === "router"
        ? yield* Effect.gen(function* () {
            const ids = yield* Effect.try({
              try: () => memberIds(rawPage),
              catch: (error) => error as SkillsError,
            })
            return yield* resolveRouterMembers(ids, skill.locator)
          })
        : []
    const memberIndex =
      skill.kind === "router"
        ? `\n\n## Members\n\n${members.map((member) => `- [${member.name}](${member.ref}) — ${member.description}`).join("\n")}\n`
        : ""
    const pages: ReferencePage[] = [
      {
        id: skill.locator.page_id,
        path: skill.entrypoint,
        markdown,
        blocks: undefined,
      },
    ]
    const paths = new Set([skill.entrypoint])
    const ids = new Set([skill.locator.page_id])
    for (const raw of entries) {
      const entry = property(raw)
      const mention = property(entry.mention)
      const linked = property(property(entry.text).link).url ?? entry.href
      const id =
        mention.type === "page"
          ? pageId(String(property(mention.page).id))
          : typeof linked === "string"
            ? pageId(linked)
            : undefined
      if (!id) {
        if (text([entry]).trim())
          return yield* Effect.fail(
            fail("INVALID_REFERENCES", "References accepts only Notion page mentions or links.", {
              page_id: skill.id,
            }),
          )
        continue
      }
      if (ids.has(id)) continue
      const rawReference = yield* api.request(`v1/pages/${id}`)
      if (property(rawReference).in_trash)
        return yield* Effect.fail(
          fail("REFERENCE_NOT_FOUND", "A reference page is in trash.", { page_id: id }),
        )
      const label = text([entry])
      const title = text(
        Object.values(property(property(rawReference).properties))
          .map(property)
          .find((value) => value.type === "title")?.title,
      )
      const path = yield* Effect.try({
        try: () =>
          referencePath(/\.md$/i.test(label.trim()) ? label : title, /\.md$/i.test(label.trim())),
        catch: (error) => error as SkillsError,
      })
      if (paths.has(path))
        return yield* Effect.fail(
          fail(
            "REFERENCE_PATH_CONFLICT",
            "Reference pages resolve to the same path; label their links with distinct filenames.",
            { path },
          ),
        )
      const rawMarkdown = yield* api.request(`v1/pages/${id}/markdown`)
      const savedBody = yield* Effect.try({
        try: () => pageMarkdown(rawMarkdown),
        catch: (error) => error as SkillsError,
      })
      const blocks = yield* readLinkBlocks(id, api, { structureEvidence: true })
      const body = yield* materializeTypedLinks(id, savedBody, api, blocks)
      const boundaries = yield* stableBlockBoundaries(id, rawReference, blocks, api)
      ids.add(id)
      paths.add(path)
      pages.push({ id, path, markdown: body, blocks: boundaries })
    }
    const attachments = Object.values(property(property(rawPage).properties))
      .map(property)
      .find((value) => value.type === "files")
    const preserved: ImportFile[] = []
    const attachmentVersions: unknown[] = []
    for (const raw of Array.isArray(attachments?.files) ? attachments.files : []) {
      const attachment = property(raw)
      const url = property(
        attachment[typeof attachment.type === "string" ? attachment.type : ""],
      ).url
      if (typeof url !== "string" || typeof attachment.name !== "string")
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid skill attachment."))
      const timeoutMs = yield* requestTimeoutMs
      const client = HttpClient.withScope(yield* HttpClient.HttpClient)
      const bytes = yield* Effect.gen(function* () {
        for (let attempt = 0; ; attempt++) {
          const downloaded = yield* Effect.scoped(
            Effect.gen(function* () {
              const response = yield* client.get(url)
              if (response.status < 200 || response.status >= 300)
                return yield* Effect.fail(
                  fail("DOWNLOAD_FAILED", "Could not download a skill attachment.", {
                    path: attachment.name,
                    status: response.status,
                  }),
                )
              return new Uint8Array(yield* response.arrayBuffer)
            }),
          ).pipe(
            Effect.timeout(timeoutMs),
            Effect.mapError((error) => {
              if (error instanceof SkillsError) return error
              const reason = property(error).reason
              const cause = property(reason).cause
              const tls = /certificate|TLS|SSL|CERT_/i.test(
                String(property(cause).code ?? "") + String(property(cause).message ?? ""),
              )
              return fail("DOWNLOAD_FAILED", "Could not download a skill attachment.", {
                path: attachment.name,
                reason: tls
                  ? "tls"
                  : property(error)._tag === "TimeoutError"
                    ? "timeout"
                    : ["TransportError", "DecodeError"].includes(String(property(reason)._tag))
                      ? "network"
                      : "invalid_response",
              })
            }),
            Effect.result,
          )
          if (downloaded._tag === "Success") return downloaded.success
          const details = property(downloaded.failure.details)
          if (
            attempt < 3 &&
            ([429, 500, 502, 503, 504].includes(Number(details.status)) ||
              ["network", "timeout"].includes(String(details.reason)))
          ) {
            yield* Effect.sleep(`${2 ** attempt} seconds`)
            continue
          }
          return yield* Effect.fail(downloaded.failure)
        }
      })
      if (bytes.length > 32 * 1024 * 1024)
        return yield* Effect.fail(fail("ARCHIVE_TOO_LARGE", "Skill attachment exceeds 32 MiB."))
      attachmentVersions.push([attachment.name, yield* sha256(bytes)])
      if (attachment.name === BUNDLE) {
        const bundle = yield* Effect.try({
          try: () => decodeSource(readImportZip(bytes)),
          catch: (error) => error as SkillsError,
        })
        if (!bundle)
          return yield* Effect.fail(
            fail("INVALID_ARCHIVE", "Source bundle has no portability manifest."),
          )
        if (bundle.kind !== skill.kind)
          return yield* Effect.fail(
            fail(
              "INVALID_CONTENT_SOURCE",
              "Portable source kind differs from the selected record.",
            ),
          )
        preserved.push(
          { path: BUNDLE, bytes },
          ...bundle.files.filter(
            (file) =>
              file.path !== bundle.main &&
              !paths.has(file.path) &&
              bundle.projection?.references?.[file.path] === undefined,
          ),
        )
      } else if (!paths.has(attachment.name))
        preserved.push({ path: normalizePath(attachment.name), bytes })
    }
    // The root bracket also spans its References pagination, child reads and
    // attachment capture, so graph materialization cannot borrow a newer root.
    pages[0] = {
      ...pages[0]!,
      blocks: yield* stableBlockBoundaries(skill.locator.page_id, rawPage, blocks, api),
    }
    const files: ImportFile[] = pages.map((page) =>
      page.path === skill.entrypoint
        ? canonicalMain(
            skill.name,
            skill.description,
            rewritePageLinks(
              fromNotionMarkdown(withoutChildPages(page.markdown), page.blocks),
              page.path,
              pages,
              "local",
              members,
            ) + memberIndex,
            { path: skill.entrypoint, bytes: new Uint8Array() },
          )
        : {
            path: page.path,
            bytes: new TextEncoder().encode(
              rewritePageLinks(
                fromNotionMarkdown(withoutCreationMarker(page.markdown), page.blocks),
                page.path,
                pages,
                "local",
                members,
              ),
            ),
          },
    )
    if (
      files.length + preserved.length > 10_000 ||
      [...files, ...preserved].reduce((size, file) => size + file.bytes.length, 0) >
        128 * 1024 * 1024
    )
      return yield* Effect.fail(
        fail("ARCHIVE_TOO_LARGE", "Skill content exceeds 128 MiB or 10,000 files."),
      )
    const version = yield* sha256(
      JSON.stringify([
        CURRENT_MATERIALIZATION_VERSION,
        skill.kind,
        skill.entrypoint,
        members,
        skill.name,
        skill.description,
        entries,
        pages,
        attachmentVersions,
      ]),
    )
    return {
      property_id: String(reference.id),
      members,
      pages,
      files: [...files, ...preserved],
      version_id: version,
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail("DOWNLOAD_FAILED", "Could not download a skill attachment."),
    ),
  )
}
