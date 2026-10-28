import { Clock, Effect } from "effect"
import { authScope } from "./catalog.ts"
import { fail, SkillsError, type Snapshot } from "./model.ts"
import { Notion } from "./notion.ts"
import { portableIdentity, snapshotAuthoredPortable } from "./export.ts"
import {
  publicationOwnership,
  publicationMarker,
  PublicationInspectDivergence,
  PublicationReadOperation,
} from "./publication-integrity.ts"
import { fileRef, resolveRef, parseRef, pageId } from "./ref.ts"
import { Store, sha256 } from "./store.ts"
import { resolvePublishedSubscription } from "./upstream-router.ts"
import {
  projectSourceMemberMarkdown,
  resolveSourceMemberLink,
  type SourceLinkContext,
} from "./upstream-member-links.ts"
import { mapMarkdownLinks } from "./typed-links.ts"
import type { SourceLinkUnavailable } from "./upstream-member-model.ts"

function memberContext(snapshot: Snapshot, rawPage: unknown) {
  return Effect.gen(function* () {
    const owner = yield* Effect.try({
      try: () => publicationOwnership(rawPage),
      catch: (e) => e as SkillsError,
    })
    if (!owner.mode || owner.mode !== "tracked" || !owner.upstream.length) return undefined
    if (snapshot.scope !== (yield* authScope))
      return yield* Effect.fail(
        fail("ACCESS_DENIED", "Source resolution belongs to another authentication scope."),
      )
    if (snapshot.record.locator.type !== "notion_page")
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBER_UNAVAILABLE",
          "Source member projection requires a content page identity.",
        ),
      )
    const resolved = yield* resolvePublishedSubscription(owner.upstream[0]!, {
      type: "member",
      pageId: snapshot.record.locator.page_id,
    }).pipe(Effect.result)
    if (resolved._tag === "Failure") {
      if (
        resolved.failure.code === "UPSTREAM_ROUTER_UNAVAILABLE" &&
        resolved.failure.message === "The subscription has no verified published active map."
      )
        return {
          unavailable: true as const,
          source_id: owner.upstream[0]!,
          revision: owner.revision,
        }
      return yield* Effect.fail(resolved.failure)
    }
    const map = resolved.success
    const current = map.published.members.filter(
      (member) => member.page_id === snapshot.record.id.replace(/^notion_page:/, ""),
    )
    if (current.length !== 1 || current[0]!.content_hash !== owner.hash)
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBER_UNAVAILABLE",
          "This page is absent from its active source publication map.",
        ),
      )
    const manifest = map.published.source_manifest
    if (!manifest)
      return yield* Effect.fail(
        fail(
          "SOURCE_MANIFEST_UNAVAILABLE",
          "This source publication predates the complete resource manifest; publish a fresh source plan.",
        ),
      )
    if (
      manifest.source_id !== map.subscription_id ||
      manifest.revision !== map.revision ||
      (current[0]!.revision !== undefined && owner.revision !== current[0]!.revision) ||
      snapshot.record.locator.type !== "notion_page" ||
      snapshot.record.locator.database_id !== map.target_database_id
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_REVISION_UNAVAILABLE",
          "The complete resource manifest differs from the active source publication.",
        ),
      )
    return {
      manifest,
      source_id: map.subscription_id,
      revision: map.revision,
      member_key: current[0]!.member_key,
      published: map.published.members,
      ...(map.source.provider.type === "git" ? { repository_url: map.source.provider.url } : {}),
    } satisfies SourceLinkContext
  })
}

/** Optional source links enrich an already readable, complete current Notion graph. */
export function projectUpstreamMemberSnapshot(
  snapshot: Snapshot,
  rawPage: unknown,
  options: { readonly optional?: boolean } = {},
) {
  return Effect.gen(function* () {
    if ((yield* PublicationReadOperation) || (yield* PublicationInspectDivergence)) return snapshot
    const owner = yield* Effect.try({
      try: () => publicationOwnership(rawPage),
      catch: (error) => error as SkillsError,
    })
    if (
      owner.mode === "tracked" &&
      (yield* portableIdentity(yield* snapshotAuthoredPortable(snapshot))) !== owner.hash
    )
      return snapshot
    const source = yield* memberContext(snapshot, rawPage).pipe(Effect.result)
    if (source._tag === "Failure") {
      if (
        !options.optional ||
        (source.failure.code === "ACCESS_DENIED" &&
          source.failure.message === "Source resolution belongs to another authentication scope.")
      )
        return yield* Effect.fail(source.failure)
      // Source access/configuration/map failures remove derived cross-member links,
      // not access to the member's independently verified current files.
      return snapshot
    }
    const context = source.success
    if (!context) return snapshot
    if ("unavailable" in context) {
      const marker = yield* Effect.try({
        try: () => publicationMarker(rawPage),
        catch: (error) => error as SkillsError,
      })
      if (marker?.state !== "committed")
        return yield* Effect.fail(
          fail(
            "PUBLICATION_INCOMPLETE",
            "An independently readable member requires a committed publication proof.",
          ),
        )
    }
    const store = yield* Store
    const sourceFiles = snapshot.source_files ?? snapshot.files
    const files: Snapshot["files"][number][] = []
    const changes: { path: string; source_hash: string; derived_hash: string }[] = []
    const unavailable: SourceLinkUnavailable[] = []
    const mapUnavailable = "unavailable" in context
    const own = mapUnavailable
      ? undefined
      : context.manifest.members.find((member) => member.member_key === context.member_key)
    if (!mapUnavailable && !own) {
      if (options.optional) return snapshot
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBER_UNAVAILABLE",
          "The selected member is absent from the source resource manifest.",
        ),
      )
    }
    for (const file of sourceFiles) {
      const sourcePath = file.path === snapshot.entrypoint ? (own?.main ?? file.path) : file.path
      if (
        !/\.md$/i.test(file.path) ||
        (!mapUnavailable && !own!.resources.some((resource) => resource.path === sourcePath))
      ) {
        files.push(file)
        continue
      }
      const bytes = yield* store.readBytes(`objects/${file.sha256}`)
      if (bytes.length !== file.bytes || (yield* sha256(bytes)) !== file.sha256)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "Source projection bytes failed their checksum.", {
            path: file.path,
          }),
        )
      const projected = yield* Effect.try({
        try: () => {
          const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
          if ("unavailable" in context) {
            mapMarkdownLinks(markdown, (href) => {
              if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return href
              try {
                resolveRef(
                  fileRef(snapshot.record.id, sourcePath),
                  decodeURIComponent(href.split(/[?#]/)[0]!),
                )
              } catch (error) {
                if (
                  error instanceof SkillsError &&
                  error.code === "INVALID_PATH" &&
                  error.message === "The path escapes the skill root."
                )
                  unavailable.push({
                    from_path: file.path,
                    href,
                    reason: "published_map_unavailable",
                  })
                else throw error
              }
              return href
            })
            return markdown
          }
          return projectSourceMemberMarkdown(context, sourcePath, markdown, (entry) =>
            unavailable.push(entry),
          )
        },
        catch: (e) =>
          e instanceof SkillsError ? e : fail("INVALID_CONTENT", "Source Markdown must be UTF-8."),
      })
      const derived = new TextEncoder().encode(projected)
      const hash = yield* sha256(derived)
      yield* store.writeBytes(`objects/${hash}`, derived)
      files.push({ path: file.path, bytes: derived.length, sha256: hash })
      changes.push({ path: file.path, source_hash: file.sha256, derived_hash: hash })
    }
    const projection = {
      source_id: context.source_id,
      revision: context.revision,
      manifest_hash: yield* sha256(
        JSON.stringify("unavailable" in context ? context : [context.manifest, context.published]),
      ),
      files: changes,
      unavailable,
    }
    const version = yield* sha256(JSON.stringify([snapshot.version_id, projection, files]))
    const derived: Snapshot = {
      ...snapshot,
      source_files: sourceFiles,
      source_projection: projection,
      version_id: version,
      snapshot_id: `s_${yield* sha256(JSON.stringify([snapshot.scope, snapshot.record.id, version]))}`,
      created_at: yield* Clock.currentTimeMillis,
      files,
    }
    yield* store.writeJson(`snapshots/${derived.snapshot_id}.json`, derived)
    return derived
  })
}

/** --from shares the same source identity and nested containing-file basis as projection. */
export function resolveUpstreamMemberRelative(snapshot: Snapshot, from: string, relative: string) {
  return Effect.gen(function* () {
    const local = fileRef(snapshot.record.id, from, snapshot.snapshot_id)
    if (snapshot.record.locator.type !== "notion_page" || !snapshot.source_projection)
      return yield* Effect.try({
        try: () => resolveRef(local, relative),
        catch: (e) => e as SkillsError,
      })
    const api = yield* Notion
    const raw = yield* api.request(`v1/pages/${snapshot.record.locator.page_id}`)
    const context = yield* memberContext(snapshot, raw)
    if (!context)
      return yield* Effect.fail(
        fail(
          "SOURCE_REVISION_UNAVAILABLE",
          "The pinned source member no longer belongs to an active tracked publication.",
        ),
      )
    if ("unavailable" in context) {
      const own = yield* Effect.try({
        try: () => resolveRef(local, relative),
        catch: (error) => error as SkillsError,
      }).pipe(Effect.result)
      if (own._tag === "Success") return own.success
    }
    if ("unavailable" in context)
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBER_UNAVAILABLE",
          "The source publication map is unavailable; a cross-member target cannot be materialized.",
        ),
      )
    if (
      snapshot.source_projection.source_id !== context.source_id ||
      snapshot.source_projection.revision !== context.revision ||
      snapshot.source_projection.manifest_hash !==
        (yield* sha256(JSON.stringify([context.manifest, context.published])))
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_REVISION_UNAVAILABLE",
          "The pinned snapshot source revision is no longer active.",
        ),
      )
    const member = context.manifest.members.find((entry) => entry.member_key === context.member_key)
    const sourcePath = from === snapshot.entrypoint ? (member?.main ?? from) : from
    const ref = yield* Effect.try({
      try: () => resolveSourceMemberLink(context, sourcePath, relative),
      catch: (e) => e as SkillsError,
    })
    if (ref !== relative && ref.startsWith("skill://")) {
      const target = yield* Effect.try({
        try: () => pageId(parseRef(ref).selector),
        catch: (error) => error as SkillsError,
      })
      if (!target)
        return yield* Effect.fail(
          fail(
            "SOURCE_MEMBER_UNAVAILABLE",
            "Cross-member references require exact page identities.",
          ),
        )
      if (target !== snapshot.record.locator.page_id) {
        const verified = yield* resolvePublishedSubscription(context.source_id, {
          type: "member",
          pageId: target,
        })
        if (
          verified.revision !== context.revision ||
          !verified.published.source_manifest ||
          (yield* sha256(
            JSON.stringify([verified.published.source_manifest, verified.published.members]),
          )) !== snapshot.source_projection.manifest_hash
        )
          return yield* Effect.fail(
            fail(
              "SOURCE_REVISION_UNAVAILABLE",
              "The source map changed while resolving the selected dependency.",
            ),
          )
      }
    }
    return ref === relative ? resolveRef(local, relative) : ref
  })
}
