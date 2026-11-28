import type { SourceSnapshot } from "./upstream-source.ts"
import { fail, SkillsError } from "./model.ts"
import { normalizePath } from "./ref.ts"
import { mapMarkdownLinks } from "./typed-links.ts"

/** Select only authored Markdown hrefs backed by ordinary blobs in the pinned tree. */
export function sourceExternalResourceTargets(
  members: readonly SourceSnapshot["members"][number][],
  entries: readonly {
    readonly path: string
    readonly oid: string
    readonly mode: string
    readonly type: string
  }[],
  unavailable?: (entry: { reason: "outside_source_root"; from_path: string; href: string }) => void,
) {
  const targets = new Map<string, { source_path: string; git_oid: string }>()
  for (const member of members) {
    const root = member.source_path === "." ? "" : member.source_path + "/"
    for (const file of member.portable.files) {
      if (!/\.md$/i.test(file.path)) continue
      let markdown: string
      try {
        markdown = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
      } catch (error) {
        if (file.path === member.portable.main) throw error
        // Supporting resources remain byte-exact even when their suffix is .md.
        continue
      }
      mapMarkdownLinks(markdown, (destination) => {
        if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(destination)) return destination
        const match = /^([^?#]+)(?:[?#].*)?$/.exec(destination)
        if (!match) return destination
        let path: string
        try {
          path = normalizePath(decodeURIComponent(match[1]!), root + file.path)
        } catch (error) {
          if (
            error instanceof SkillsError &&
            error.code === "INVALID_PATH" &&
            error.message === "The path escapes the skill root."
          ) {
            unavailable?.({
              reason: "outside_source_root",
              from_path: root + file.path,
              href: destination,
            })
            return destination
          }
          throw error instanceof SkillsError
            ? error
            : fail("INVALID_PATH", "Source destination contains invalid encoding.")
        }
        if (
          members.some(
            (candidate) =>
              candidate.source_path === "." || path.startsWith(candidate.source_path + "/"),
          )
        )
          return destination
        const entry = entries.find((candidate) => candidate.path === path)
        if (entry?.type === "blob" && ["100644", "100755"].includes(entry.mode))
          targets.set(path, { source_path: path, git_oid: entry.oid })
        return destination
      })
    }
  }
  return [...targets.values()].sort((a, b) => a.source_path.localeCompare(b.source_path))
}
