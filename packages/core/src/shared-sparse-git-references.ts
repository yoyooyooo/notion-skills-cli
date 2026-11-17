import { fail, SkillsError } from "./model.ts"
import { normalizePath } from "./ref.ts"
import { sharedMarkdownReferences } from "./shared-file-references.ts"
import { mapMarkdownLinks } from "./typed-links.ts"

/** Check document-local references against the complete effective tree. A
 * repository-relative sibling href is not a local missing File: validate its
 * repository boundary here and defer member/auth/version checks to --from.
 * The checking projection is temporary; stored/returned bytes never change. */
export function assertSparseGitFileReferences(
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  completePaths: readonly string[],
  root: string,
) {
  const checked = files.map((file) => {
    if (!/\.(?:md|markdown)$/iu.test(file.path)) return file
    let markdown: string
    try {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    } catch {
      return file
    }
    const projected = mapMarkdownLinks(markdown, (href) => {
      if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/iu.test(href)) return href
      const path = href.split(/[?#]/u)[0]!
      let decoded: string
      try {
        decoded = decodeURIComponent(path)
      } catch {
        return href
      }
      try {
        normalizePath(decoded, file.path)
        return href
      } catch (error) {
        if (
          !(error instanceof SkillsError) ||
          error.code !== "INVALID_PATH" ||
          error.message !== "The path escapes the skill root."
        )
          throw error
        normalizePath(decoded, (root ? root + "/" : "") + file.path)
        return "https://fixed-git-sibling.invalid/explicit-read-required"
      }
    })
    return { ...file, bytes: new TextEncoder().encode(projected) }
  })
  const paths = new Set(completePaths)
  if (checked.some((file) => !paths.has(file.path)))
    throw fail(
      "SHARED_REFERENCE_INVALID",
      "Observed documents must belong to the complete fixed directory.",
    )
  const references = checked
    .filter((file) => /\.(?:md|markdown)$/iu.test(file.path))
    .flatMap((file) =>
      sharedMarkdownReferences(
        file.path,
        new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
      ),
    )
  const missing = references.filter((reference) => !paths.has(reference.target))
  if (missing.length)
    throw fail(
      "SHARED_REFERENCE_BROKEN",
      "The mixed document tree contains unresolved local references.",
      { references: missing },
    )
  return {
    checked_files: checked.filter((file) => /\.(?:md|markdown)$/iu.test(file.path)).length,
    local_references: references.length,
  }
}
