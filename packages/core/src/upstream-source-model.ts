import { Schema } from "effect"

export const SourceSpecSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("git"), url: Schema.String, ref: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("registry"),
    base_url: Schema.String,
    owner: Schema.String,
    slug: Schema.String,
    version: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("github-market"),
    url: Schema.String,
    ref: Schema.optional(Schema.String),
  }),
])
export type SourceSpec = typeof SourceSpecSchema.Type

/** Display-only browser destination; local Git paths have no web URL. */
export function sourceDisplayUrl(source: SourceSpec): string | null {
  try {
    const raw = source.type === "registry" ? source.base_url : source.url
    const scp = /^git@github\.com:(.+)$/.exec(raw)
    const parsed = new URL(scp ? `https://github.com/${scp[1]}` : raw)
    const url =
      parsed.protocol === "ssh:" && parsed.hostname === "github.com"
        ? new URL(`https://github.com${parsed.pathname}`)
        : parsed
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null
    if (source.type === "registry") {
      url.pathname = `/${encodeURIComponent(source.owner)}/skills/${encodeURIComponent(source.slug)}`
    } else {
      url.pathname = url.pathname.replace(/\.git\/?$/, "")
    }
    return url.href
  } catch {
    return null
  }
}
export const SourcePatchSchema = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      replacements: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
    }),
  ),
})
export type SourcePatch = typeof SourcePatchSchema.Type
export const GitMaterializationSchema = Schema.Struct({
  source_hash: Schema.String,
  derived_hash: Schema.String,
  links: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      declared_git_oid: Schema.String,
      source_hash: Schema.String,
      target: Schema.String,
      resolved_path: Schema.String,
    }),
  ),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      declared_git_oid: Schema.String,
      source_path: Schema.String,
      source_git_oid: Schema.String,
      materialized_file_hash: Schema.String,
    }),
  ),
})
