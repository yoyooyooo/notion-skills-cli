import { Effect } from "effect"
import { HttpClient } from "effect/http"
import { readImportZip } from "./import.ts"
import type { ImportFile } from "./import.ts"
import { fail, property, text, SkillsError } from "./model.ts"
import type { Skill } from "./model.ts"
import { Notion } from "./notion.ts"
import { BUNDLE, canonicalMain, readPortable } from "./portable.ts"
import { normalizePath, pageId } from "./ref.ts"
import { sha256 } from "./store.ts"

export interface ReferencePage {
  readonly id: string
  readonly path: string
  readonly markdown: string
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

export function referencePath(title: string) {
  const label = title.trim()
  const candidate = /\.md$/i.test(label)
    ? label.startsWith("references/")
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
    !candidate.startsWith("references/")
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
) {
  const byId = new Map(pages.map((page) => [page.id, page.path]))
  const byPath = new Map(pages.map((page) => [page.path, page.id]))
  const destination = (value: string) => {
    if (direction === "local") {
      const id = pageId(value)
      const target = id && byId.get(id)
      if (!target) return value
      const hash = new URL(value).hash
      return (
        relativePath(from, target)
          .split("/")
          .map((part) => encodeURIComponent(part))
          .join("/") + hash
      )
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
    return id
      ? `https://www.notion.so/${id.replaceAll("-", "")}${match[2]?.startsWith("#") ? match[2] : ""}`
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
          if (direction === "local")
            output = output.replace(/https?:\/\/[^\s<>\)\]]+/g, (url) => destination(url))
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

export function readReferences(skill: Skill, rawPage: unknown) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const reference = yield* Effect.try({
      try: () => referencesProperty(rawPage),
      catch: (error) => error as SkillsError,
    })
    if (!reference)
      return yield* Effect.fail(fail("INVALID_REFERENCES", "The skill has no References property."))
    const root = yield* api.request(`v1/pages/${skill.id}/markdown`)
    const markdown = yield* Effect.try({
      try: () => pageMarkdown(root),
      catch: (error) => error as SkillsError,
    })
    const entries = yield* propertyEntries(rawPage, reference)
    const pages: ReferencePage[] = [{ id: skill.id, path: "SKILL.md", markdown }]
    const paths = new Set(["SKILL.md"])
    const ids = new Set([skill.id])
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
        try: () => referencePath(/\.md$/i.test(label.trim()) ? label : title),
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
      const body = yield* Effect.try({
        try: () => pageMarkdown(rawMarkdown),
        catch: (error) => error as SkillsError,
      })
      ids.add(id)
      paths.add(path)
      pages.push({ id, path, markdown: body })
    }
    const files: ImportFile[] = pages.map((page) =>
      page.path === "SKILL.md"
        ? canonicalMain(
            skill.name,
            skill.description,
            rewritePageLinks(withoutChildPages(page.markdown), page.path, pages, "local"),
          )
        : {
            path: page.path,
            bytes: new TextEncoder().encode(
              rewritePageLinks(page.markdown, page.path, pages, "local"),
            ),
          },
    )
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
            Effect.timeout("60 seconds"),
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
          try: () => readPortable(readImportZip(bytes)),
          catch: (error) => error as SkillsError,
        })
        if (!bundle)
          return yield* Effect.fail(
            fail("INVALID_ARCHIVE", "Source bundle has no portability manifest."),
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
        "references-v1",
        skill.name,
        skill.description,
        entries,
        pages,
        attachmentVersions,
      ]),
    )
    return {
      property_id: String(reference.id),
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
