/** Exact authored YAML header. Empty is a known absence; undefined remains historical unknown. */
export function nativeMainFrontmatter(text: string): string {
  return /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(text)?.[0] ?? ""
}
