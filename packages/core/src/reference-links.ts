export interface ReferenceLink {
  readonly path: string
  readonly id: string
}

export interface ReferenceBinding extends ReferenceLink {
  readonly url: string
}

export interface ReferenceText {
  readonly type: "text"
  readonly text: {
    readonly content: string
    readonly link?: { readonly url: string }
  }
}

export interface ReferenceLinksValue {
  readonly rich_text: readonly ReferenceText[]
}

export interface DecodedReferenceLinks {
  readonly representation: "legacy" | "compact"
  readonly bindings: readonly ReferenceBinding[]
}

const maxReferences = 100
const legacyReferences = 50
const maxText = 2000
const uuid = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i
const notionLink = /^https:\/\/www\.notion\.so\/([a-f0-9]{32})$/i
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function keys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).every((key) => expected.includes(key))
}

function canonicalId(value: string) {
  const raw = value.replaceAll("-", "").toLowerCase()
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

function referencePath(value: string) {
  return (
    /(?:^|\/)[^/]+\.md$/i.test(value) &&
    !/[\r\n\0\\?#]/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    !value.startsWith("/") &&
    !/^[a-zA-Z]:/.test(value)
  )
}

/** Preflight every source path before allocation. A compact separator costs one code unit. */
export function referencePathsFit(paths: readonly string[]) {
  return (
    paths.length <= maxReferences &&
    new Set(paths).size === paths.length &&
    paths.every(
      (path) =>
        referencePath(path) && path.length <= maxText - (paths.length > legacyReferences ? 1 : 0),
    )
  )
}

/** Keep the historical wire bytes through 50 references; larger values use one link per item. */
export function referenceLinks(pages: readonly ReferenceLink[]): ReferenceLinksValue | undefined {
  if (
    !referencePathsFit(pages.map((page) => page.path)) ||
    pages.some((page) => !uuid.test(page.id)) ||
    new Set(pages.map((page) => canonicalId(page.id))).size !== pages.length
  )
    return undefined
  if (pages.length <= legacyReferences)
    return {
      rich_text: pages.flatMap((page, index): ReferenceText[] => [
        ...(index ? [{ type: "text" as const, text: { content: "\n" } }] : []),
        {
          type: "text",
          text: {
            content: page.path,
            link: { url: `https://www.notion.so/${page.id.replaceAll("-", "")}` },
          },
        },
      ]),
    }
  return {
    rich_text: pages.map(
      (page, index): ReferenceText => ({
        type: "text",
        text: {
          content: `${index ? "\n" : ""}${page.path}`,
          link: { url: `https://www.notion.so/${page.id.replaceAll("-", "")}` },
        },
      }),
    ),
  }
}

function textItem(value: unknown, readback: boolean) {
  const item = object(value)
  const text = object(item?.text)
  if (
    !item ||
    item.type !== "text" ||
    !text ||
    typeof text.content !== "string" ||
    text.content.length > maxText ||
    !keys(
      item,
      readback ? ["type", "text", "annotations", "plain_text", "href"] : ["type", "text"],
    ) ||
    !keys(text, ["content", "link"])
  )
    return undefined
  const link = object(text.link)
  if (
    text.link !== undefined &&
    text.link !== null &&
    (!link || !keys(link, ["url"]) || typeof link.url !== "string")
  )
    return undefined
  if (!readback && text.link === null) return undefined
  const url = link?.url
  if (url !== undefined && (typeof url !== "string" || !notionLink.test(url))) return undefined
  if (readback) {
    if (own(item, "plain_text") && item.plain_text !== text.content) return undefined
    if (own(item, "href") && item.href !== (url ?? null)) return undefined
    if (own(item, "annotations")) {
      const annotations = object(item.annotations)
      if (
        !annotations ||
        Object.entries(annotations).some(([key, value]) =>
          key === "color"
            ? value !== "default"
            : !["bold", "italic", "strikethrough", "underline", "code"].includes(key) ||
              value !== false,
        )
      )
        return undefined
    }
  }
  return { content: text.content, url: url as string | undefined }
}

/** Decode only the two complete publisher grammars. No trim, link alias or partial array proof. */
export function decodeReferenceLinks(
  value: unknown,
  options: { readonly readback?: boolean; readonly oversizedLegacy?: boolean } = {},
): DecodedReferenceLinks | undefined {
  const field = object(value)
  if (!field || !keys(field, ["rich_text"]) || !Array.isArray(field.rich_text)) return undefined
  const raw = field.rich_text
  if (raw.length > (options.oversizedLegacy ? maxReferences * 2 - 1 : maxReferences))
    return undefined
  const items = raw.map((entry) => textItem(entry, options.readback === true))
  if (items.some((entry) => entry === undefined)) return undefined
  if (items.length === 0) return { representation: "legacy", bindings: [] }
  const compact =
    items.length > legacyReferences && items.every((entry) => entry!.url !== undefined)
  const result: ReferenceBinding[] = []
  if (!compact && items.length % 2 !== 1) return undefined
  for (const [index, entry] of items.entries()) {
    if (!compact && index % 2 === 1) {
      if (entry!.content !== "\n" || entry!.url !== undefined) return undefined
      continue
    }
    const prefix = compact && index > 0 ? "\n" : ""
    if (!entry!.url || !entry!.content.startsWith(prefix)) return undefined
    const path = entry!.content.slice(prefix.length)
    if (!referencePath(path)) return undefined
    const id = canonicalId(notionLink.exec(entry!.url)![1]!)
    if (result.some((other) => other.path === path || other.id === id)) return undefined
    result.push({ path, id, url: entry!.url })
  }
  if (
    result.length > maxReferences ||
    (!compact && result.length > legacyReferences && !options.oversizedLegacy)
  )
    return undefined
  return { representation: compact ? "compact" : "legacy", bindings: result }
}
