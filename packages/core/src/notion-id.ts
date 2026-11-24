/** Normalize an exact Notion page/database ID at an external boundary. */
export function pageId(input: string): string | undefined {
  if (typeof input !== "string") return undefined
  let raw = input
  if (!/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/iu.test(raw)) {
    try {
      const url = new URL(input)
      if (
        !["https:", "http:"].includes(url.protocol) ||
        !/(^|\.)notion\.(so|site|com)$/iu.test(url.hostname) ||
        url.username || url.password || url.port
      ) return undefined
      const match = /(?:^|[-/])([a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\/?$/iu.exec(url.pathname)
      if (!match) return undefined
      raw = match[1]!
    } catch { return undefined }
  }
  const hex = raw.replaceAll("-", "").toLowerCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
