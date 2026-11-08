/** Exact authored YAML header. Empty is a known absence; undefined remains historical unknown. */
export function nativeMainFrontmatter(text: string): string {
  return /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(text)?.[0] ?? ""
}

/** Supporting YAML is authored file metadata, never Markdown for the native page. */
export function splitNativeSupportingMarkdown(text: string): {
  readonly body: string
  readonly frontmatter?: string
} {
  const header = nativeMainFrontmatter(text)
  if (header === "") return { body: text }
  const rest = text.slice(header.length)
  const separator = /^(?:\r?\n)*/u.exec(rest)![0]
  return { frontmatter: header + separator, body: rest.slice(separator.length) }
}

export function nativeSupportingMarkdown(
  body: string,
  metadata: { readonly frontmatter?: string },
): string {
  return (metadata.frontmatter ?? "") + body
}
