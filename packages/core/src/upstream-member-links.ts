import { Effect } from "effect"
import type { SourceSnapshot } from "./upstream-source.ts"
import { fail, SkillsError } from "./model.ts"
import { fileRef, normalizePath, pageId } from "./ref.ts"
import { sha256 } from "./store.ts"
import { mapMarkdownLinks } from "./typed-links.ts"

import type { SourceMemberManifest } from "./upstream-member-model.ts"
export {
  SourceMemberManifestSchema,
  SourceProjectionSchema,
  type SourceMemberManifest,
} from "./upstream-member-model.ts"

export function buildSourceMemberManifest(sourceId: string, snapshot: SourceSnapshot) {
  return Effect.gen(function* () {
    const members: SourceMemberManifest["members"][number][] = []
    for (const member of snapshot.members) {
      const resources: { path: string; sha256: string }[] = []
      for (const file of member.portable.files)
        resources.push({ path: file.path, sha256: yield* sha256(file.bytes) })
      members.push({
        member_key: member.member_key,
        source_path: member.source_path,
        main: member.portable.main,
        resources,
        ...(member.git_materialization
          ? { upstream_hash: member.upstream_hash, git_materialization: member.git_materialization }
          : {}),
      })
    }
    const manifest: SourceMemberManifest = {
      version: 1,
      source_id: sourceId,
      revision: snapshot.revision,
      members,
      ...(snapshot.external_resources ? { external_resources: snapshot.external_resources } : {}),
      ...(snapshot.unavailable?.length ? { unavailable: snapshot.unavailable } : {}),
    }
    return yield* Effect.try({
      try: () => validateSourceMemberManifest(manifest),
      catch: (e) => e as SkillsError,
    })
  })
}

export function validateSourceMemberManifest(manifest: SourceMemberManifest) {
  if (!manifest.source_id || !manifest.revision)
    throw fail("INVALID_SOURCE_MANIFEST", "Source manifest requires an exact source and revision.")
  const keys = new Set<string>()
  const roots = new Set<string>()
  for (const member of manifest.members) {
    if (
      !member.member_key ||
      keys.has(member.member_key) ||
      roots.has(member.source_path) ||
      (member.source_path !== "." && normalizePath(member.source_path) !== member.source_path)
    )
      throw fail("INVALID_SOURCE_MANIFEST", "Source member identities must be unique safe paths.")
    keys.add(member.member_key)
    roots.add(member.source_path)
    const paths = new Set<string>()
    for (const file of member.resources) {
      if (
        !file.path ||
        normalizePath(file.path) !== file.path ||
        paths.has(file.path) ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      )
        throw fail(
          "INVALID_SOURCE_MANIFEST",
          "Source resources require unique safe paths and exact hashes.",
        )
      paths.add(file.path)
    }
    if (member.main && !paths.has(member.main))
      throw fail(
        "INVALID_SOURCE_MANIFEST",
        "The source entrypoint is absent from its resource inventory.",
      )
  }
  for (const root of roots)
    if (
      [...roots].some((other) => root !== other && (other === "." || root.startsWith(other + "/")))
    )
      throw fail("INVALID_SOURCE_MANIFEST", "Source member roots must not overlap.")
  const externalPaths = new Set<string>()
  for (const resource of manifest.external_resources ?? []) {
    if (
      !resource.source_path ||
      normalizePath(resource.source_path) !== resource.source_path ||
      externalPaths.has(resource.source_path) ||
      !/^[a-f0-9]{40,64}$/.test(resource.git_oid) ||
      !/^[a-f0-9]{64}$/.test(resource.sha256)
    )
      throw fail(
        "INVALID_SOURCE_MANIFEST",
        "External source resources require exact safe Git blob identities and hashes.",
      )
    externalPaths.add(resource.source_path)
  }
  return manifest
}

export interface SourceLinkContext {
  readonly manifest: SourceMemberManifest
  readonly source_id: string
  readonly revision: string
  readonly member_key: string
  readonly published: readonly { readonly member_key: string; readonly page_id: string }[]
  readonly repository_url?: string
}

/** Resolve in the source repository, then cross the member boundary by exact identity. */
export function resolveSourceMemberLink(
  context: SourceLinkContext,
  from: string,
  destination: string,
) {
  const { manifest } = context
  validateSourceMemberManifest(manifest)
  if (context.source_id !== manifest.source_id || context.revision !== manifest.revision)
    throw fail(
      "SOURCE_REVISION_UNAVAILABLE",
      "Source resolution requires the matching published source revision.",
    )
  const member = manifest.members.find((entry) => entry.member_key === context.member_key)
  if (!member)
    throw fail(
      "SOURCE_MEMBER_UNAVAILABLE",
      "The source member is absent from the current scan manifest.",
    )
  if (!member.resources.some((file) => file.path === from))
    throw fail(
      "SOURCE_RESOURCE_UNAVAILABLE",
      "The containing resource is absent from the source manifest.",
      { from },
    )
  if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(destination)) return destination
  const match = /^([^?#]+)([?#].*)?$/.exec(destination)
  if (!match) return destination
  let decoded: string
  try {
    decoded = decodeURIComponent(match[1]!)
  } catch {
    throw fail("INVALID_PATH", "Source destination contains invalid percent encoding.")
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded))
    throw fail("INVALID_PATH", "Source destination contains control characters.")
  const root = member.source_path === "." ? "" : member.source_path + "/"
  // normalizePath allows ../ while it remains inside the source repository.
  const repositoryPath = normalizePath(decoded, root + from)
  const target = manifest.members.find(
    (entry) => entry.source_path === "." || repositoryPath.startsWith(entry.source_path + "/"),
  )
  if (!target) {
    if (
      manifest.members.some((entry) => {
        const parent = entry.source_path.split("/").slice(0, -1).join("/")
        return parent && repositoryPath.startsWith(parent + "/")
      })
    )
      throw fail(
        "SOURCE_MEMBER_UNAVAILABLE",
        "The destination member is absent from the current subscribed scan.",
        { source_path: repositoryPath },
      )
    const external = manifest.external_resources?.find(
      (resource) => resource.source_path === repositoryPath,
    )
    if (external && context.repository_url) {
      const url = new URL(context.repository_url)
      if (
        url.protocol === "https:" &&
        url.hostname === "github.com" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /^\/[^/]+\/[^/]+\/?$/.test(url.pathname) &&
        /^[a-f0-9]{40,64}$/.test(context.revision)
      ) {
        const repository = url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "")
        return `https://github.com${repository}/blob/${context.revision}/${repositoryPath.split("/").map(encodeURIComponent).join("/")}${match[2] ?? ""}`
      }
    }
    throw fail(
      "SOURCE_PREREQUISITE_UNAVAILABLE",
      "The destination is a source repository prerequisite outside the subscribed resources.",
      { from, destination, source_path: repositoryPath },
    )
  }
  const path =
    target.source_path === "."
      ? repositoryPath
      : repositoryPath.slice(target.source_path.length + 1)
  if (target.member_key === member.member_key) return destination
  if (!target.resources.some((file) => file.path === path))
    throw fail(
      "SOURCE_RESOURCE_UNAVAILABLE",
      "The destination resource is absent from the current source scan.",
      { member_key: target.member_key, path },
    )
  if (match[2])
    throw fail(
      "INVALID_REF",
      "Cross-member resource references cannot carry an authored query or anchor.",
      { destination },
    )
  const published = context.published.filter((entry) => entry.member_key === target.member_key)
  if (published.length !== 1 || pageId(published[0]!.page_id) !== published[0]!.page_id)
    throw fail(
      "SOURCE_MEMBER_UNAVAILABLE",
      "The target source member has no exact active published page; retry after publication completes.",
      {
        source_id: context.source_id,
        revision: context.revision,
        member_key: target.member_key,
        path,
      },
    )
  return fileRef(published[0]!.page_id, path === target.main ? "SKILL.md" : path)
}

export function projectSourceMemberMarkdown(
  context: SourceLinkContext,
  from: string,
  markdown: string,
  unavailable?: (entry: {
    from_path: string
    href: string
    reason: "outside_source_root" | "target_unavailable"
  }) => void,
) {
  return mapMarkdownLinks(markdown, (destination) => {
    try {
      return resolveSourceMemberLink(context, from, destination)
    } catch (error) {
      if (error instanceof SkillsError && error.code === "SOURCE_MEMBER_UNAVAILABLE") {
        unavailable?.({ from_path: from, href: destination, reason: "target_unavailable" })
        return destination
      }
      if (
        error instanceof SkillsError &&
        error.code === "INVALID_PATH" &&
        error.message === "The path escapes the skill root."
      ) {
        unavailable?.({ from_path: from, href: destination, reason: "outside_source_root" })
        return destination
      }
      throw error
    }
  })
}

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
