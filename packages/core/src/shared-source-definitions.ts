import { Effect, Schema } from "effect"
import { sourceDefinitionOptions } from "./shared-source-definition-options.ts"
import { fail, SkillsError } from "./model.ts"
import { normalizePath, pageId } from "./ref.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { SourceDefinitionInputSchema, type SourceDefinitionInput } from "./shared-sources-model.ts"
import { validateGitSource, validateSourceSelection } from "./upstream-source.ts"

export const sourceChecked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SOURCE_DEFINITION_INVALID", "Invalid source configuration or response."),
  })
export function sourceRich(content: string) {
  const chunks: Array<{ type: "text"; text: { content: string } }> = []
  let current = ""
  for (const char of content) {
    if (current.length + char.length > 1900) {
      chunks.push({ type: "text", text: { content: current } })
      current = ""
    }
    current += char
  }
  if (current) chunks.push({ type: "text", text: { content: current } })
  if (chunks.length > 100)
    throw fail(
      "SOURCE_DEFINITION_TOO_LARGE",
      "One native source property exceeds 100 rich-text parts.",
    )
  return chunks
}
const bounded = (value: string, label: string, max = 2048) => {
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))
    throw fail("SOURCE_DEFINITION_INVALID", `Invalid ${label}.`)
}
function rejectCredentials(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectCredentials(item)
    return
  }
  if (value === null || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:token|api[_-]?key|password|authorization|headers|credential|secret)$/iu.test(key))
      throw fail(
        "SOURCE_SECRET_FORBIDDEN",
        "Source definitions must not store credentials or arbitrary headers.",
      )
    rejectCredentials(child)
  }
}
export function validateSourceDefinition(value: unknown): SourceDefinitionInput {
  const result = Schema.decodeUnknownSync(SourceDefinitionInputSchema)(structuredClone(value), {
    onExcessProperty: "error",
  })
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(result.source_id))
    throw fail("SOURCE_DEFINITION_INVALID", "Use a stable bounded Source ID.")
  bounded(result.name, "source name", 200)
  if (result.description.length > 12000)
    throw fail("SOURCE_DEFINITION_TOO_LARGE", "Description exceeds 12000 characters.")
  rejectCredentials(result)
  const options = new Set([
    "patch",
    "member_patches",
    "require_all_included",
    "accepted_ref",
    "external_assets",
    "external_markdown",
  ])
  for (const key of Object.keys(sourceDefinitionOptions(result.options)))
    if (!options.has(key))
      throw fail(
        "SOURCE_ADAPTER_OPTIONS_UNSUPPORTED",
        "An explicit source option has no implemented adapter behavior; it cannot be silently discarded.",
        { option: key },
      )
  validateSourceSelection(result.selection)
  const adapter = result.adapter
  if (adapter.type === "git") {
    validateGitSource(adapter.url, adapter.ref)
    if (!/^(?:https?:\/\/|ssh:\/\/|git@[A-Za-z0-9.-]+:)/u.test(adapter.url))
      throw fail(
        "SOURCE_LOCAL_PATH_FORBIDDEN",
        "Shared Git sources require HTTP(S) or SSH; local paths are machine-only resources.",
      )
    if (result.policy === "pinned" && !/^[a-f0-9]{40,64}$/u.test(adapter.ref))
      throw fail("SOURCE_PIN_REQUIRED", "Pinned Git sources require a full commit identity.")
  } else if (adapter.type === "linear") {
    if (result.policy === "pinned")
      throw fail(
        "SOURCE_PIN_REQUIRED",
        "Linear is mutable; freeze a fetched snapshot instead of claiming a historical API revision.",
      )
    if (adapter.resources.length < 1 || adapter.resources.length > 80)
      throw fail("SOURCE_DEFINITION_INVALID", "Select one to 80 exact Linear resources.")
    const paths = new Set<string>()
    for (const item of adapter.resources) {
      if (
        !/^(?:[A-Za-z][A-Za-z0-9]*-[0-9]+|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/u.test(
          item.id,
        ) ||
        (item.kind === "document" && !pageId(item.id))
      )
        throw fail("SOURCE_DEFINITION_INVALID", "Use an exact issue identifier or document UUID.")
      if (normalizePath(item.path) !== item.path || !item.path || paths.has(item.path))
        throw fail(
          "SOURCE_DEFINITION_INVALID",
          "Linear output paths must be unique safe relative paths.",
        )
      paths.add(item.path)
    }
    if (!paths.has("SKILL.md"))
      throw fail(
        "SOURCE_DEFINITION_INVALID",
        "Linear resource mapping requires an explicit SKILL.md entry.",
      )
  } else {
    const url = new URL(adapter.type === "registry" ? adapter.base_url : adapter.url)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw fail("SOURCE_SECRET_FORBIDDEN", "Use a credential-free HTTPS source location.")
    if (
      result.policy === "pinned" &&
      !(adapter.type === "registry" ? adapter.version : adapter.ref)
    )
      throw fail("SOURCE_PIN_REQUIRED", "Pinned sources require an explicit revision.")
  }
  sourceRich(canonicalSharedJson(result.options))
  sourceRich(canonicalSharedJson(result.selection))
  return result
}
