/** Body objects shared by ordinary authoring and explicit migration origins. */
export function sharedCreateInputPayload(text: string) {
  return { version: 1 as const, kind: "utf8_input" as const, text }
}

export function sharedCreateBodyPayload(markdown: string) {
  return {
    version: 1 as const,
    kind: "normalized_markdown" as const,
    normalization_version: 1 as const,
    markdown,
  }
}
