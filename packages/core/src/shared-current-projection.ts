import { SourceLexer } from "@notion-skills-cli/markdown"
import { Effect } from "effect"
import type { Token } from "marked"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { normalizePath, pageId } from "./ref.ts"
import type { CurrentFileContent } from "./shared-current-file.ts"
import type { CurrentOperationAction } from "./shared-current-operation.ts"
import { currentResourceAttachmentIdentity } from "./shared-current-resource.ts"

type Rich = {
  readonly type: "text"
  readonly text: { readonly content: string; readonly link?: { readonly url: string } }
  readonly annotations?: {
    readonly bold?: boolean
    readonly italic?: boolean
    readonly strikethrough?: boolean
    readonly code?: boolean
  }
}
type TextKind =
  | "paragraph"
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "quote"
  | "bulleted_list_item"
type TextBody = { readonly rich_text: readonly Rich[] }
type TextBlock = {
  [K in TextKind]: { readonly object: "block"; readonly type: K } & { readonly [P in K]: TextBody }
}[TextKind]
type UploadBody =
  | {
      readonly type: "file_upload"
      readonly file_upload: { readonly id: string }
      readonly caption: readonly Rich[]
    }
  | { readonly type: "current_attachment"; readonly caption: readonly Rich[] }
export type CurrentProjectionBlock =
  | TextBlock
  | {
      readonly object: "block"
      readonly type: "code"
      readonly code: TextBody & { readonly language: string; readonly caption: readonly Rich[] }
    }
  | { readonly object: "block"; readonly type: "divider"; readonly divider: Record<string, never> }
  | {
      readonly object: "block"
      readonly type: "file"
      readonly file: UploadBody & { readonly name: string }
    }
  | { readonly object: "block"; readonly type: "image"; readonly image: UploadBody }

export type CurrentProjectionPlan = {
  readonly path: string
  readonly representation: "markdown" | "code" | "binary"
  readonly blocks: readonly CurrentProjectionBlock[]
}
/** A name alone is a read-only plan; appending an attachment requires its upload handle. */
export type CurrentProjectionUpload = { readonly id?: string; readonly name: string }
type RequestOptions = NonNullable<Parameters<Notion["Service"]["request"]>[2]>
type Observation<A> =
  | { readonly status: "complete"; readonly value: A }
  | { readonly status: "missing" }
export type CurrentProjectionDispatch<R> = <A>(input: {
  readonly key: string
  readonly replay: "never" | "idempotent"
  readonly request: {
    readonly path: string
    readonly body?: unknown
    readonly options?: RequestOptions
  }
  readonly observe: (options: {
    readonly fresh: boolean
  }) => Effect.Effect<Observation<A>, SkillsError, R | Notion>
  readonly acknowledge: (response: unknown) => Effect.Effect<A, SkillsError, R | Notion>
}) => Effect.Effect<A, SkillsError, R | Notion>

const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_PROJECTION_INVALID", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The current reading projection is invalid."),
  })
const exactPage = (value: string) => {
  const id = pageId(value)
  if (!id || !/^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/iu.test(value))
    throw invalid("Projection pages require exact Notion IDs.")
  return id
}

/** Splits JavaScript text without separating a Unicode surrogate pair. */
function chunks(text: string, size: number): string[] {
  const result: string[] = []
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + size, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--
    result.push(text.slice(start, end))
    start = end
  }
  return result
}
function rich(text: string, annotations?: Rich["annotations"], url?: string): Rich[] {
  return chunks(text, 2000).map((content) => ({
    type: "text",
    text: { content, ...(url === undefined ? {} : { link: { url } }) },
    ...(annotations === undefined ? {} : { annotations }),
  }))
}
function textBlock(type: TextKind, spans: readonly Rich[]): TextBlock {
  const body = { rich_text: spans }
  switch (type) {
    case "paragraph":
      return { object: "block", type, paragraph: body }
    case "heading_1":
      return { object: "block", type, heading_1: body }
    case "heading_2":
      return { object: "block", type, heading_2: body }
    case "heading_3":
      return { object: "block", type, heading_3: body }
    case "quote":
      return { object: "block", type, quote: body }
    case "bulleted_list_item":
      return { object: "block", type, bulleted_list_item: body }
  }
}
const languages: Readonly<Record<string, string>> = {
  md: "markdown",
  markdown: "markdown",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  py: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "c++",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  dockerfile: "docker",
  diff: "diff",
  patch: "diff",
}
function language(value: string): string {
  const normalized = value.toLowerCase().trim().split(/\s/u)[0] ?? ""
  return (
    (Object.hasOwn(languages, normalized) ? languages[normalized] : undefined) ??
    (Object.values(languages).includes(normalized) ? normalized : "plain text")
  )
}
function code(text: string, lang: string): CurrentProjectionBlock[] {
  const parts = chunks(text, 16000)
  return (parts.length ? parts : [""]).map((content) => ({
    object: "block",
    type: "code",
    code: { language: language(lang), rich_text: rich(content), caption: [] },
  }))
}

/** Display decoding does not alter the exact bytes held by the selected authority. */
export function decodeCurrentProjectionText(bytes: Uint8Array): string | undefined {
  let encoding = "utf-8"
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le"
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be"
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) return
    return text.replace(/\r\n?/gu, "\n")
  } catch {
    return
  }
}

const opaqueExtensions = new Set([
  "pdf",
  "doc",
  "docx",
  "dotx",
  "xls",
  "xlt",
  "xla",
  "xlsx",
  "xltx",
  "ppt",
  "pps",
  "ppa",
  "pptx",
  "potx",
  "odt",
  "ods",
  "odp",
  "epub",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  "zip",
  "gz",
  "gzip",
  "tar",
  "tgz",
  "bz2",
  "tbz2",
  "xz",
  "zst",
  "7z",
  "rar",
  "jar",
  "cab",
  "dmg",
  "iso",
  "gif",
  "heic",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
  "ico",
  "bmp",
  "avif",
  "apng",
  "aac",
  "adts",
  "mid",
  "midi",
  "mp3",
  "mpga",
  "m4a",
  "m4b",
  "oga",
  "ogg",
  "opus",
  "wav",
  "wma",
  "weba",
  "flac",
  "amv",
  "asf",
  "wmv",
  "avi",
  "f4v",
  "flv",
  "gifv",
  "m4v",
  "mp4",
  "mkv",
  "webm",
  "mov",
  "qt",
  "mpeg",
  "ogv",
  "3gp",
  "3g2",
  "dwg",
  "dwf",
  "rvt",
  "rfa",
  "3dm",
  "3mf",
  "glb",
  "usdz",
  "bin",
  "exe",
  "dll",
  "so",
  "dylib",
  "wasm",
  "o",
  "a",
  "class",
  "db",
  "sqlite",
  "parquet",
  "npy",
  "npz",
  "pkl",
])
function currentProjectionText(path: string, bytes: Uint8Array): string | undefined {
  const leaf = path.split("/").at(-1) ?? ""
  const extension = leaf.includes(".") ? leaf.split(".").at(-1)!.toLowerCase() : ""
  return opaqueExtensions.has(extension) ? undefined : decodeCurrentProjectionText(bytes)
}

/** Known originals remain downloadable even when their container happens to contain only ASCII. */
export function isCurrentProjectionBinary(path: string, bytes: Uint8Array): boolean {
  return currentProjectionText(path, bytes) === undefined
}

function inline(
  tokens: readonly Token[],
  styles: Rich["annotations"] = {},
  rewrite?: (href: string) => string | undefined,
): Rich[] {
  return tokens.flatMap((token): Rich[] => {
    if (token.type === "strong" || token.type === "em" || token.type === "del")
      return inline(
        token.tokens ?? SourceLexer.lexInline(token.text),
        {
          ...styles,
          [token.type === "strong" ? "bold" : token.type === "em" ? "italic" : "strikethrough"]:
            true,
        },
        rewrite,
      )
    if (token.type === "link") {
      const href = rewrite?.(token.href) ?? token.href
      if (!/^https?:\/\//iu.test(href) || href.length > 2000) return rich(token.raw, styles)
      return inline(token.tokens ?? SourceLexer.lexInline(token.text), styles, rewrite).map(
        (span) => ({
          ...span,
          text: { ...span.text, link: { url: href } },
        }),
      )
    }
    if (token.type === "codespan") return rich(token.text, { ...styles, code: true })
    if (token.type === "br") return rich("\n", styles)
    if (token.type === "text" || token.type === "escape") return rich(token.text, styles)
    // Images, HTML and unknown inline grammar remain visible literal text.
    return rich(token.raw, styles)
  })
}
function simpleListItems(token: Token): readonly { raw: string; text: string }[] | undefined {
  if (token.type !== "list" || token.ordered !== false || !Array.isArray(token.items)) return
  const result: { raw: string; text: string }[] = []
  for (const raw of token.items) {
    const item = property(raw)
    if (
      item.task === true ||
      typeof item.raw !== "string" ||
      typeof item.text !== "string" ||
      !Array.isArray(item.tokens) ||
      item.tokens.length !== 1 ||
      !["paragraph", "text"].includes(String(property(item.tokens[0]).type))
    )
      return
    result.push({ raw: item.raw, text: item.text })
  }
  return result
}
function readableMarkdown(
  text: string,
  rewrite?: (href: string) => string | undefined,
): CurrentProjectionBlock[] {
  const result: CurrentProjectionBlock[] = []
  const formatted = (kind: TextKind, tokens: readonly Token[], raw: string) => {
    const spans = inline(tokens, {}, rewrite)
    if (
      spans.length > 100 ||
      spans.reduce((sum, span) => sum + span.text.content.length, 0) > 16000
    )
      result.push(...code(raw, "markdown"))
    else result.push(textBlock(kind, spans))
  }
  for (const token of SourceLexer.lex(text)) {
    const items = simpleListItems(token)
    if (token.type === "space") continue
    if (token.type === "heading" && token.depth <= 3) {
      formatted(
        token.depth === 1 ? "heading_1" : token.depth === 2 ? "heading_2" : "heading_3",
        token.tokens ?? SourceLexer.lexInline(token.text),
        token.raw,
      )
    } else if (token.type === "paragraph" || token.type === "text") {
      formatted("paragraph", token.tokens ?? SourceLexer.lexInline(token.text), token.raw)
    } else if (token.type === "code") result.push(...code(token.text, token.lang ?? ""))
    else if (token.type === "hr") result.push({ object: "block", type: "divider", divider: {} })
    else if (
      token.type === "blockquote" &&
      token.tokens?.length === 1 &&
      token.tokens[0]?.type === "paragraph"
    ) {
      formatted(
        "quote",
        token.tokens[0].tokens ?? SourceLexer.lexInline(token.tokens[0].text),
        token.raw,
      )
    } else if (items !== undefined) {
      for (const item of items)
        formatted("bulleted_list_item", SourceLexer.lexInline(item.text), item.raw)
    } else result.push(...code(token.raw, "markdown"))
    // Stop building a huge fragmented tree as soon as the bounded display fallback is needed.
    if (result.length > 8192) return code(text, "markdown")
  }
  // Excessively fragmented Markdown stays complete without creating unbounded tiny blocks.
  return result
}

/** One current renderer. Unsupported Markdown is readable complete source, never a stub. */
export function renderCurrentProjection(input: {
  readonly path: string
  readonly bytes: Uint8Array
  readonly attachment?: CurrentProjectionUpload
  readonly imagePreview?: boolean
  readonly rewriteLink?: (href: string) => string | undefined
}): CurrentProjectionPlan {
  if (
    !input.path ||
    normalizePath(input.path) !== input.path ||
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength > 64 * 1024 * 1024
  )
    throw invalid("Select one canonical current file of at most 64 MiB.")
  if (input.attachment !== undefined) {
    if (input.attachment.id !== undefined) exactPage(input.attachment.id)
    if (
      !input.attachment.name ||
      input.attachment.name.length > 255 ||
      /[\u0000-\u001f]/u.test(input.attachment.name)
    )
      throw invalid("An original attachment requires its bounded filename.")
  }
  const text = currentProjectionText(input.path, input.bytes)
  const ext = input.path.split("/").at(-1)!.split(".").at(-1)!.toLowerCase()
  const markdown = text !== undefined && /^(?:md|markdown)$/u.test(ext)
  const blocks: CurrentProjectionBlock[] =
    text === undefined ? [] : markdown ? readableMarkdown(text, input.rewriteLink) : code(text, ext)
  if (text === undefined && input.attachment === undefined)
    throw fail(
      "CURRENT_PROJECTION_ORIGINAL_REQUIRED",
      "An opaque file requires its usable original attachment.",
      { path: input.path },
    )
  if (input.attachment !== undefined) {
    const upload: UploadBody =
      input.attachment.id === undefined
        ? { type: "current_attachment", caption: [] }
        : { type: "file_upload", file_upload: { id: input.attachment.id }, caption: [] }
    if (
      text === undefined &&
      input.imagePreview !== false &&
      /^(?:png|jpg|jpeg|gif|webp)$/u.test(ext)
    )
      blocks.push({ object: "block", type: "image", image: upload })
    blocks.push({ object: "block", type: "file", file: { ...upload, name: input.attachment.name } })
  }
  return {
    path: input.path,
    representation: text === undefined ? "binary" : markdown ? "markdown" : "code",
    blocks,
  }
}

/** Both limits apply to the actual serialized request, including JSON escaping. */
export function currentProjectionBatches(
  blocks: readonly CurrentProjectionBlock[],
): readonly (readonly CurrentProjectionBlock[])[] {
  const batches: CurrentProjectionBlock[][] = []
  let batch: CurrentProjectionBlock[] = []
  const overhead = new TextEncoder().encode(JSON.stringify({ children: [] })).byteLength
  let size = overhead
  for (const block of blocks) {
    if (
      (block.type === "file" && block.file.type === "current_attachment") ||
      (block.type === "image" && block.image.type === "current_attachment")
    )
      throw fail(
        "CURRENT_PROJECTION_UPLOAD_REQUIRED",
        "Rebuilding an attachment projection requires its current upload handle.",
      )
    const blockBytes = new TextEncoder().encode(JSON.stringify(block)).byteLength
    if (overhead + blockBytes > 450000)
      throw invalid("One reading block exceeds the Notion request boundary.")
    if (batch.length === 100 || size + blockBytes + (batch.length ? 1 : 0) > 450000) {
      if (!batch.length) throw invalid("One reading block exceeds the Notion request boundary.")
      batches.push(batch)
      batch = []
      size = overhead
    }
    size += blockBytes + (batch.length ? 1 : 0)
    batch.push(block)
  }
  if (batch.length) batches.push(batch)
  return batches
}

/** Notion serializes equivalent HTTP(S) URLs, including an origin's trailing slash.
 * Compare that representation without changing the planned blocks or request identity. */
function canonicalLink(link: string | null): string | null {
  if (link === null) return null
  try {
    const url = new URL(link)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : link
  } catch {
    return link
  }
}

function canonicalRich(input: unknown) {
  if (!Array.isArray(input)) return
  const result: {
    text: string
    link: string | null
    annotations: Record<string, boolean | string>
  }[] = []
  for (const value of input) {
    const span = property(value),
      text = property(span.text),
      style = property(span.annotations)
    const rawLink = text.link == null ? null : property(text.link).url
    if (
      span.type !== "text" ||
      typeof text.content !== "string" ||
      (span.plain_text !== undefined && span.plain_text !== text.content) ||
      (rawLink !== null && typeof rawLink !== "string")
    )
      return
    const link = canonicalLink(rawLink)
    const annotations: Record<string, boolean | string> = {}
    for (const key of ["bold", "italic", "strikethrough", "code", "underline"]) {
      if (style[key] !== undefined && typeof style[key] !== "boolean") return
      annotations[key] = style[key] === true
    }
    if (style.color !== undefined && typeof style.color !== "string") return
    annotations.color = style.color ?? "default"
    if (!text.content) continue
    const previous = result.at(-1)
    if (
      previous !== undefined &&
      previous.link === link &&
      JSON.stringify(previous.annotations) === JSON.stringify(annotations)
    )
      previous.text += text.content
    else result.push({ text: text.content, link, annotations })
  }
  return result
}
function canonicalBlock(raw: unknown, attachment?: unknown): string | undefined {
  const block = property(raw)
  if (
    block.has_children === true ||
    block.in_trash === true ||
    block.archived === true ||
    typeof block.type !== "string"
  )
    return
  const type = block.type,
    body = property(block[type])
  if (type === "file" || type === "image") {
    const caption = canonicalRich(body.caption ?? [])
    if (caption === undefined || (type === "file" && typeof body.name !== "string")) return
    let locator: string
    try {
      locator =
        (body.type === "file_upload" || body.type === "current_attachment") &&
        attachment !== undefined
          ? currentResourceAttachmentIdentity(attachment)
          : currentResourceAttachmentIdentity({
              ...body,
              name: type === "file" ? body.name : "image",
            })
    } catch {
      return
    }
    return JSON.stringify({
      type,
      ...(type === "file" ? { name: body.name } : {}),
      caption,
      locator,
    })
  }
  if (type === "divider") return JSON.stringify({ type })
  if (
    ![
      "paragraph",
      "heading_1",
      "heading_2",
      "heading_3",
      "quote",
      "bulleted_list_item",
      "code",
    ].includes(type)
  )
    return
  const spans = canonicalRich(body.rich_text)
  if (
    spans === undefined ||
    (body.color !== undefined && body.color !== "default") ||
    body.is_toggleable === true
  )
    return
  if (type !== "code") return JSON.stringify({ type, spans })
  const caption = canonicalRich(body.caption ?? [])
  if (caption === undefined || typeof body.language !== "string") return
  return JSON.stringify({ type, spans, language: body.language, caption })
}
type ObservedBlock = { readonly id: string; readonly value: Record<string, unknown> }
function observedBlock(raw: unknown, owner: string): ObservedBlock {
  const value = property(raw),
    parent = property(value.parent)
  if (
    value.object !== "block" ||
    typeof value.id !== "string" ||
    typeof value.type !== "string" ||
    typeof value.has_children !== "boolean" ||
    !["page_id", "block_id"].includes(String(parent.type)) ||
    typeof parent[String(parent.type)] !== "string" ||
    exactPage(String(parent[String(parent.type)])) !== owner ||
    value.in_trash === true ||
    value.archived === true
  )
    throw invalid("The projection contains a foreign or unavailable block.")
  return { id: exactPage(value.id), value }
}
/** Complete physical children shared by projection and authored native management. */
export function readCurrentBodyBlocks(page: string) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const blocks: ObservedBlock[] = [],
      ids = new Set<string>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const response = property(
        yield* api.request(
          `v1/blocks/${page}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
          undefined,
          { content: "body" },
        ),
      )
      const batch = yield* checked(() => {
        if (
          response.object !== "list" ||
          !Array.isArray(response.results) ||
          typeof response.has_more !== "boolean" ||
          property(response.request_status).type === "incomplete" ||
          property(response.request_status).incomplete_reason != null
        )
          throw invalid("Projection pagination is incomplete.")
        if (!response.has_more && response.next_cursor !== null)
          throw invalid("Projection pagination has no explicit end.")
        return response.results.map((raw) => observedBlock(raw, page))
      })
      for (const block of batch) {
        if (ids.has(block.id))
          return yield* Effect.fail(invalid("Projection pagination repeated a physical block."))
        ids.add(block.id)
        blocks.push(block)
      }
      if (blocks.length > 20000)
        return yield* Effect.fail(
          invalid("Projection inventory exceeds its complete page boundary."),
        )
      if (!response.has_more) break
      if (
        typeof response.next_cursor !== "string" ||
        !response.next_cursor ||
        cursors.has(response.next_cursor)
      )
        return yield* Effect.fail(invalid("Projection pagination repeated or omitted a cursor."))
      cursor = response.next_cursor
      cursors.add(cursor)
    } while (cursor)
    return blocks
  })
}

function assertReplaceableTree(roots: readonly ObservedBlock[]) {
  return Effect.gen(function* () {
    const pending = [...roots],
      seen = new Set<string>()
    while (pending.length) {
      const block = pending.pop()!
      if (seen.has(block.id) || seen.size >= 20000)
        return yield* Effect.fail(
          invalid("The current body subtree is repeated or exceeds its complete scan boundary."),
        )
      seen.add(block.id)
      if (["child_page", "child_database"].includes(String(block.value.type)))
        return yield* Effect.fail(
          fail(
            "CURRENT_PROJECTION_CHILD_CONTENT",
            "Move current child pages or databases before replacing this body.",
          ),
        )
      if (block.value.has_children === true)
        pending.push(...(yield* readCurrentBodyBlocks(block.id)))
    }
  })
}

/** A changed body may be replaced only after its complete nested child content is accounted for. */
export function assertCurrentBodyReplaceable(pageId: string) {
  return Effect.gen(function* () {
    const page = yield* checked(() => exactPage(pageId))
    yield* assertReplaceableTree(yield* readCurrentBodyBlocks(page))
  })
}

function expectedProjection(plan: CurrentProjectionPlan, attachment?: unknown) {
  return checked(() =>
    plan.blocks.map((block) => {
      const canonical = canonicalBlock(block, attachment)
      if (canonical === undefined)
        throw invalid("The planned projection lacks a verified original attachment or valid block.")
      return canonical
    }),
  )
}

/** Inspect an existing current body without allocating uploads or entering a write operation. */
export function inspectCurrentProjection(input: {
  readonly pageId: string
  readonly plan: CurrentProjectionPlan
  readonly attachment?: unknown
}) {
  return Effect.gen(function* () {
    const page = yield* checked(() => exactPage(input.pageId))
    const expected = yield* expectedProjection(input.plan, input.attachment)
    const actual = yield* readCurrentBodyBlocks(page)
    return {
      page_id: page,
      path: input.plan.path,
      blocks: actual.length,
      matches:
        actual.length === expected.length &&
        actual.every((block, index) => canonicalBlock(block.value) === expected[index]),
    }
  })
}

/** Reconstruct only the exact pending body request for read-only cancellation. */
export function currentProjectionPendingAction(input: {
  readonly pageId: string
  readonly key: string
  readonly plan: CurrentProjectionPlan
  readonly attachment?: unknown
}): Effect.Effect<CurrentOperationAction<void, Notion>, SkillsError> {
  return Effect.gen(function* () {
    const page = yield* checked(() => exactPage(input.pageId))
    const expected = yield* expectedProjection(input.plan, input.attachment)
    const batches = yield* checked(() => currentProjectionBatches(input.plan.blocks))
    const boundaries = new Set([0])
    let offset = 0
    const selected = batches.flatMap((batch) => {
      const start = offset
      offset += batch.length
      boundaries.add(offset)
      return input.key === `projection:${page}:append:${start}`
        ? [{ batch, start, end: offset }]
        : []
    })[0]
    const step =
      input.key === `projection:${page}:clear`
        ? { kind: "clear" as const }
        : selected === undefined
          ? undefined
          : { kind: "append" as const, ...selected }
    if (step === undefined)
      return yield* Effect.fail(
        invalid("The pending action is not a complete batch in this projection plan."),
      )
    return {
      key: input.key,
      replay: step.kind === "clear" ? "idempotent" : "never",
      request:
        step.kind === "clear"
          ? {
              path: `v1/pages/${page}/markdown`,
              body: {
                markdown_version: "v2",
                type: "replace_content",
                replace_content: { new_str: "" },
              },
              options: { method: "PATCH", content: "body" },
            }
          : {
              path: `v1/blocks/${page}/children`,
              body: { children: step.batch },
              options: { method: "PATCH", content: "body" },
            },
      observe: () =>
        Effect.gen(function* () {
          const actual = yield* readCurrentBodyBlocks(page)
          const prefix =
            actual.length <= expected.length &&
            actual.every((block, index) => canonicalBlock(block.value) === expected[index])
          if (step.kind === "clear")
            return prefix && boundaries.has(actual.length)
              ? ({ status: "complete", value: undefined } as const)
              : ({ status: "missing" } as const)
          if (
            !prefix ||
            actual.length < step.start ||
            (actual.length > step.start && actual.length < step.end)
          )
            return yield* Effect.fail(
              fail(
                "CURRENT_PROJECTION_CONFLICT",
                "Current reading blocks differ from the pending operation's complete prefix.",
              ),
            )
          return actual.length >= step.end
            ? ({ status: "complete", value: undefined } as const)
            : ({ status: "missing" } as const)
        }),
    }
  })
}

/** Mutations run only through the owner's finite operation session. No private journal is created. */
export function applyCurrentProjection<R>(input: {
  readonly pageId: string
  readonly content: CurrentFileContent
  readonly plan: CurrentProjectionPlan
  readonly attachment?: unknown
  readonly assertCurrent: Effect.Effect<void, SkillsError, R>
  readonly dispatch: CurrentProjectionDispatch<R>
}) {
  return Effect.gen(function* () {
    const page = yield* checked(() => exactPage(input.pageId))
    if (input.content.kind === "native")
      return yield* Effect.fail(
        fail(
          "CURRENT_PROJECTION_AUTHOR_BODY",
          "Generated reading must not overwrite a native author body.",
        ),
      )
    const expected = yield* expectedProjection(input.plan, input.attachment)
    const batches = yield* checked(() => currentProjectionBatches(input.plan.blocks))
    const batchBoundaries = new Set([0])
    let boundary = 0
    for (const batch of batches) {
      boundary += batch.length
      batchBoundaries.add(boundary)
    }
    yield* input.assertCurrent
    let actual = yield* readCurrentBodyBlocks(page)
    const original = actual.map((block) => canonicalBlock(block.value))
    const prefix = () =>
      actual.length <= expected.length &&
      actual.every((block, index) => canonicalBlock(block.value) === expected[index])
    const refresh = (fresh: boolean) =>
      fresh
        ? readCurrentBodyBlocks(page).pipe(
            Effect.map((blocks) => {
              actual = blocks
            }),
          )
        : Effect.void
    const observePrefix = (count: number, fresh: boolean) =>
      Effect.gen(function* () {
        yield* refresh(fresh)
        if (!prefix()) return { status: "missing" } satisfies Observation<void>
        return actual.length >= count
          ? ({ status: "complete", value: undefined } satisfies Observation<void>)
          : ({ status: "missing" } satisfies Observation<void>)
      })
    yield* input.dispatch({
      key: `projection:${page}:clear`,
      replay: "idempotent",
      request: {
        path: `v1/pages/${page}/markdown`,
        body: { markdown_version: "v2", type: "replace_content", replace_content: { new_str: "" } },
        options: { method: "PATCH", content: "body" },
      },
      observe: ({ fresh }) =>
        Effect.gen(function* () {
          const observed = yield* observePrefix(0, fresh)
          if (observed.status === "complete" && batchBoundaries.has(actual.length)) return observed
          // An existing shorter body is not a completed append batch. A pending
          // unknown append remains protected by the session's different-key guard.
          yield* assertReplaceableTree(actual)
          yield* input.assertCurrent
          return { status: "missing" } as const
        }),
      acknowledge: (response) =>
        checked(() => {
          const value = property(response)
          if (
            value.object !== "page_markdown" ||
            typeof value.id !== "string" ||
            exactPage(value.id) !== page ||
            value.markdown !== "" ||
            value.truncated !== false ||
            !Array.isArray(value.unknown_block_ids) ||
            value.unknown_block_ids.length ||
            (value.warnings !== undefined &&
              (!Array.isArray(value.warnings) || value.warnings.length))
          )
            throw invalid("Clearing the generated body did not return a complete empty page.")
          actual = []
        }),
    })
    let offset = 0
    for (const batch of batches) {
      const start = offset,
        end = start + batch.length
      yield* input.assertCurrent
      yield* input.dispatch({
        key: `projection:${page}:append:${start}`,
        replay: "never",
        request: {
          path: `v1/blocks/${page}/children`,
          body: { children: batch },
          options: { method: "PATCH", content: "body" },
        },
        observe: ({ fresh }) =>
          Effect.gen(function* () {
            const observed = yield* observePrefix(end, fresh)
            if (
              !prefix() ||
              actual.length < start ||
              (actual.length > start && actual.length < end)
            )
              return yield* Effect.fail(
                fail(
                  "CURRENT_PROJECTION_CONFLICT",
                  "Current reading blocks differ from this operation's complete prefix.",
                ),
              )
            return observed
          }),
        acknowledge: (response) =>
          checked(() => {
            const value = property(response)
            if (
              value.object !== "list" ||
              !Array.isArray(value.results) ||
              value.has_more !== false ||
              value.next_cursor !== null ||
              value.results.length !== batch.length
            )
              throw invalid("The appended reading batch is incomplete.")
            const added = value.results.map((raw) => observedBlock(raw, page))
            const ids = new Set(actual.map((block) => block.id))
            for (const [index, block] of added.entries()) {
              if (ids.has(block.id) || canonicalBlock(block.value) !== expected[start + index])
                throw invalid(
                  "An appended reading block differs from the intended complete content.",
                )
              ids.add(block.id)
            }
            if (actual.length !== start || !prefix())
              throw invalid("The reading batch no longer follows the observed prefix.")
            actual = [...actual, ...added]
          }),
      })
      offset = end
    }
    const unchanged =
      original.length === expected.length &&
      original.every((value, index) => value === expected[index])
    if (!unchanged) actual = yield* readCurrentBodyBlocks(page)
    if (actual.length !== expected.length || !prefix())
      return yield* Effect.fail(
        fail(
          "CURRENT_PROJECTION_INCOMPLETE",
          "The complete current reading body does not match its intended projection.",
        ),
      )
    yield* input.assertCurrent
    return { page_id: page, path: input.plan.path, blocks: actual.length, changed: !unchanged }
  })
}
