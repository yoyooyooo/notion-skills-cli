import { fail, property } from "./model.ts"
import {
  nativeMainFrontmatter,
  splitNativeSupportingMarkdown,
} from "./shared-native-file-metadata.ts"
import { restoreSharedNativeFileLinks } from "./shared-native-file-content.ts"
import { normalizeObservedBody } from "./shared-file-state.ts"
import { parseYaml } from "./yaml.ts"

/** Validate all YAML fields and retain their exact authored spelling. Native
 * catalog metadata remains explicit; a Description update alone is not a file. */
export function completeNativeMainInput(input: {
  readonly text: string
  readonly name: string
  readonly description: string
  readonly path: string
  readonly bindings: readonly { readonly page_id: string; readonly path: string }[]
}) {
  if (input.text.includes("\0"))
    throw fail("INVALID_INPUT", "The complete main input cannot contain NUL bytes.")
  const frontmatter = nativeMainFrontmatter(input.text).replace(/^\uFEFF/u, "")
  if (!frontmatter)
    throw fail("INVALID_SKILL", "The complete main input requires SKILL.md with YAML frontmatter.")
  const yaml = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(frontmatter)!
  const value = parseYaml(yaml[1]!)
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw fail("INVALID_SKILL", "The complete main frontmatter must be a metadata mapping.")
  const metadata = property(value)
  if (metadata.name !== input.name || metadata.description !== input.description)
    throw fail(
      "SHARED_METADATA_CONFLICT",
      "Align the native Name and Description explicitly before authoring the complete main input; no body or frontmatter was written.",
    )
  if (metadata.notion_page_id !== undefined)
    throw fail(
      "SHARED_FRONTMATTER_UNSUPPORTED",
      "notion_page_id is a runtime owner hint omitted from native exports; remove it explicitly before complete main authoring. No authored field was discarded.",
    )
  const body = restoreSharedNativeFileLinks(
    normalizeObservedBody(splitNativeSupportingMarkdown(input.text).body),
    input.path,
    input.bindings,
  )
  if (!body.length)
    throw fail(
      "SHARED_GIT_MAIN_UNSUPPORTED",
      "A complete main input requires a nonempty Markdown body.",
    )
  return { frontmatter, body }
}
