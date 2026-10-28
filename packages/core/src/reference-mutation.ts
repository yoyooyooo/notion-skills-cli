import { Effect } from "effect"
import type { Crypto, Path } from "effect"
import { importDocument } from "./import.ts"
import { decode, entrypointFor, fail, PageSchema, SkillsError, property } from "./model.ts"
import type { Snapshot } from "./model.ts"
import { Notion } from "./notion.ts"
import { authoredPortable, bodyIdentity, BUNDLE, portableZip, canonicalMain } from "./portable.ts"
import type { PortableSkill } from "./portable.ts"
import {
  childPageTags,
  pageMarkdown,
  rewritePageLinks,
  referencePath,
  withoutChildPages,
} from "./references.ts"
import type { ReferencePage } from "./references.ts"
import { makeSkillRefresh, openSkill, snapshotInfo } from "./snapshot.ts"
import { portableIdentity, snapshotAuthoredPortable } from "./export.ts"
import { Store } from "./store.ts"
import { invalidateSnapshotCache } from "./cache.ts"
import type { Publication } from "./publication.ts"
import {
  fromNotionMarkdown,
  markdownIdentity,
  notionMarkdownForComparison,
  samePublishedMarkdown,
  type NotionBlockBoundary,
} from "./markdown.ts"
import { pageId } from "./ref.ts"
import { memberIds } from "./router-members.ts"
import {
  preserveCreationMarker,
  withoutCreationMarkerWithBlocks,
} from "./publication-create-identity.ts"
import {
  publicationExternalLinksMatch,
  publicationSourceDestination,
  type PublicationMarkdownComparator,
} from "./publication-markdown.ts"
import { referenceLinks, referencePathsFit } from "./reference-links.ts"
import { physicalReadbackTarget } from "./publication-physical-target.ts"
import { pageLocalUnicodeFragmentTarget } from "./publication-local-fragment.ts"
import { nativeMarkdownWire } from "./native-markdown-wire.ts"
import { readMarkdownFileBlocks } from "./markdown-files.ts"

function requirePageId(input: string) {
  const id = pageId(input)
  return id
    ? Effect.succeed(id)
    : Effect.fail(
        fail("INVALID_RESPONSE", "Expected a Notion page ID.", {
          page_id: input,
        }),
      )
}

export interface ReferenceProperties {
  readonly title: string
  readonly description: string
  readonly references: string
  readonly files?: string
  readonly members?: {
    readonly property: string
    readonly ids: readonly string[]
  }
  readonly defaultContext?: { readonly property: string; readonly value: boolean }
}

function referenceValue(pages: readonly Pick<ReferencePage, "id" | "path">[]) {
  const value = referenceLinks(pages)
  return value
    ? Effect.succeed(value)
    : Effect.fail(
        fail(
          "INVALID_REFERENCES",
          "References cannot be encoded within the Notion rich text limits.",
          { count: pages.length },
        ),
      )
}

export function referenceContentIdentity(portable: PortableSkill) {
  return Effect.gen(function* () {
    const files = yield* Effect.try({
      try: () => {
        portable = authoredPortable(portable)
        const main = portable.files.find((file) => file.path === portable.main)!
        const doc = importDocument(main, {
          name: portable.name,
          description: portable.description,
        })
        const authoredBody = doc.body
        const pages = portable.files.map((file, index) => ({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          path: file.path === portable.main ? portable.main : file.path,
          markdown: "",
        }))
        const normalized = (body: string, path: string) =>
          markdownIdentity(
            rewritePageLinks(rewritePageLinks(body, path, pages, "notion"), path, pages, "local"),
          )
        return portable.files.map((file) =>
          file.path === portable.main
            ? canonicalMain(
                portable.name,
                portable.description,
                normalized(authoredBody, portable.main),
                { path: portable.main, bytes: new Uint8Array() },
              )
            : {
                ...file,
                bytes: new TextEncoder().encode(
                  normalized(
                    new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
                    file.path,
                  ),
                ),
              },
        )
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_REFERENCES", "Page-only skills require UTF-8 Markdown files."),
    })
    return yield* portableIdentity({
      ...portable,
      files,
      projection: undefined,
    })
  })
}

export function referencePagesMatch(snapshot: Snapshot, portable: PortableSkill) {
  return Effect.gen(function* () {
    const pages = snapshot.references
    if (!pages?.some((page) => page.path === snapshot.entrypoint))
      return yield* Effect.fail(
        fail("WRITE_VERIFICATION_FAILED", "Saved authored page graph is unavailable."),
      )
    // Compare live authored pages directly: the retained source bundle is never page authority.
    const livePages = pages.map((page) => ({
      ...page,
      path: page.path === snapshot.entrypoint ? portable.main : page.path,
    }))
    const submitted = {
      ...portable,
      files: portable.files.filter(
        (file) => file.path === portable.main || /\.md$/i.test(file.path),
      ),
    }
    const sourceFiles = new Map(submitted.files.map((file) => [file.path, file]))
    const livePaths = new Set(livePages.map((page) => page.path))
    if (
      snapshot.record.kind !== portable.kind ||
      snapshot.record.name !== portable.name ||
      snapshot.record.description !== portable.description ||
      sourceFiles.size !== submitted.files.length ||
      livePaths.size !== livePages.length ||
      new Set(livePages.map((page) => page.id)).size !== livePages.length ||
      sourceFiles.size !== livePaths.size ||
      [...sourceFiles.keys()].some((path) => !livePaths.has(path))
    )
      return yield* Effect.fail(
        fail(
          "WRITE_VERIFICATION_FAILED",
          "Saved authored page metadata or complete reference paths differ from the submitted skill.",
        ),
      )
    const authoredPages = yield* Effect.try({
      try: () =>
        livePages.map((page) =>
          page.path === portable.main
            ? page
            : { ...page, ...withoutCreationMarkerWithBlocks(page.markdown, page.blocks) },
        ),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("WRITE_VERIFICATION_FAILED", "Saved reference creation identity is invalid."),
    })
    const normalizedSaved: PortableSkill = {
      kind: snapshot.record.kind,
      name: snapshot.record.name,
      description: snapshot.record.description,
      main: portable.main,
      files: authoredPages.map((page) => {
        const authored =
          page.path === portable.main ? withoutChildPages(page.markdown) : page.markdown
        const body = fromNotionMarkdown(
          rewritePageLinks(authored, page.path, livePages, "local", snapshot.router_members),
          page.blocks,
        )
        return page.path === portable.main
          ? canonicalMain(snapshot.record.name, snapshot.record.description, body, {
              path: portable.main,
              bytes: new Uint8Array(),
            })
          : { path: page.path, bytes: new TextEncoder().encode(body) }
      }),
    }
    const actual = yield* referenceContentIdentity(normalizedSaved)
    const expected = yield* referenceContentIdentity(submitted)
    const samePublishedBody = (page: ReferencePage) => {
      const file = sourceFiles.get(page.path)!
      const submittedBody =
        file.path === portable.main
          ? importDocument(file, {
              name: portable.name,
              description: portable.description,
            }).body
          : new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
      const authored =
        page.path === portable.main
          ? childPageTags(page.markdown).length
            ? withoutChildPages(page.markdown)
            : page.markdown
          : page.markdown
      // Apply the same graph mapping to both sides, including ./path aliases.
      // The original source still binds every explicit external destination.
      const map = (markdown: string, preserveExternalUrls = false) => {
        const local = (value: string) =>
          rewritePageLinks(value, page.path, livePages, "local", snapshot.router_members, {
            preserveExternalUrls,
          })
        return local(
          rewritePageLinks(
            local(markdown),
            page.path,
            livePages,
            "notion",
            snapshot.router_members,
          ),
        )
      }
      const sourceDestination =
        page.blocks === undefined
          ? undefined
          : publicationSourceDestination({ path: page.path, files: portable.files }, page.blocks)
      const compare: PublicationMarkdownComparator = (actual, expected, blocks, sameLink) => {
        const view = pageLocalUnicodeFragmentTarget(
          physicalReadbackTarget(expected, blocks),
          blocks,
        )
        return (
          samePublishedMarkdown(actual, view, sameLink, blocks) ||
          samePublishedMarkdown(fromNotionMarkdown(actual, blocks), view, sameLink, blocks)
        )
      }
      if (
        !publicationExternalLinksMatch(
          authored,
          submittedBody,
          (markdown) => map(markdown, true),
          page.blocks,
          compare,
          sourceDestination,
        )
      )
        return false
      if (
        actual === expected ||
        samePublishedMarkdown(authored, submittedBody, sourceDestination, page.blocks) ||
        samePublishedMarkdown(
          fromNotionMarkdown(authored, page.blocks),
          submittedBody,
          sourceDestination,
          page.blocks,
        )
      )
        return true
      // Preserve physical readback boundaries before changing page destinations.
      // Target-directed recovery may have no additional edits to return.
      const publishedTarget = pageLocalUnicodeFragmentTarget(
        physicalReadbackTarget(
          rewritePageLinks(submittedBody, page.path, livePages, "notion", snapshot.router_members),
          page.blocks,
        ),
        page.blocks,
      )
      const compared = new Set(
        [
          notionMarkdownForComparison(authored, publishedTarget, page.blocks),
          notionMarkdownForComparison(authored, submittedBody, page.blocks),
          fromNotionMarkdown(authored, page.blocks),
        ].filter((value): value is string => value !== undefined),
      )
      // Each mapping must prove the whole body. Preserving external URLs also
      // retains bare filename autolinks alongside known page destinations.
      return [...compared].some((candidate) =>
        [false, true].some((preserveExternal) => {
          const mapped = map(candidate, preserveExternal)
          const target = pageLocalUnicodeFragmentTarget(
            map(submittedBody, preserveExternal),
            page.blocks,
          )
          return (
            samePublishedMarkdown(mapped, target, undefined, page.blocks) ||
            samePublishedMarkdown(
              fromNotionMarkdown(mapped, page.blocks),
              target,
              undefined,
              page.blocks,
            )
          )
        }),
      )
    }
    const differentPage = authoredPages.find((page) => !samePublishedBody(page))
    if (differentPage)
      return yield* Effect.fail(
        fail(
          "WRITE_VERIFICATION_FAILED",
          "Saved page Markdown differs from the submitted instructions or references.",
          {
            actual,
            expected,
            main: portable.main,
            page_id: differentPage.id,
            path: differentPage.path,
          },
        ),
      )
    return true
  })
}

export function referenceInput(portable: PortableSkill, hasFiles: boolean) {
  return Effect.gen(function* () {
    const referenceFiles = portable.files.filter(
      (file) => file.path !== portable.main && /\.md$/i.test(file.path),
    )
    const canonical = entrypointFor(portable.kind)
    if (portable.main !== canonical && referenceFiles.some((file) => file.path === canonical))
      return yield* Effect.fail(
        fail(
          "INVALID_CONTENT_SOURCE",
          "The canonical entrypoint collides with another source Markdown page.",
          { path: canonical, main: portable.main },
        ),
      )
    const otherFiles = portable.files.filter(
      (file) => file.path !== portable.main && !referenceFiles.includes(file),
    )
    if (!hasFiles && otherFiles.length)
      return yield* Effect.fail(
        fail(
          "UNSUPPORTED_FILE",
          "This database needs a Files property to retain non-reference files.",
          { paths: otherFiles.map((file) => file.path) },
        ),
      )
    if (referenceFiles.length > 100)
      return yield* Effect.fail(
        fail("INVALID_REFERENCES", "References supports at most 100 pages per skill."),
      )
    if (!referencePathsFit(referenceFiles.map((file) => file.path)))
      return yield* Effect.fail(
        fail(
          "INVALID_REFERENCES",
          "Reference paths cannot be encoded within the Notion rich text limits.",
        ),
      )
    const bodies = new Map<string, string>()
    for (const file of referenceFiles) {
      const body = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
        catch: () =>
          fail("INVALID_REFERENCES", "Reference Markdown must be UTF-8.", {
            path: file.path,
          }),
      })
      if (body.includes("\0"))
        return yield* Effect.fail(
          fail("INVALID_REFERENCES", "Reference Markdown must be text.", {
            path: file.path,
          }),
        )
      bodies.set(file.path, body)
    }
    return { referenceFiles, bodies }
  })
}

export function saveReferences(
  portable: PortableSkill,
  doc: { name: string; description: string; body: string },
  props: ReferenceProperties,
  source: { database_id: string; data_source_id: string },
  operation: "create" | "replace" | "write",
  current: Snapshot | undefined,
  upload: (
    input: { bytes: Uint8Array },
    filename: string,
  ) => Effect.Effect<
    { name: string; type: "file_upload"; file_upload: { id: string } },
    SkillsError,
    Notion | Store | Path.Path | Crypto.Crypto
  >,
  publication?: Publication,
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const contentId = yield* portableIdentity(portable)
    const { referenceFiles, bodies } = yield* referenceInput(portable, Boolean(props.files))
    const completed: string[] = []
    let id = current ? yield* requirePageId(current.record.id) : undefined
    let stage = "prepare"
    const run = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
      publication ? publication.run(name, effect) : effect
    const validate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      publication ? publication.validate(effect) : effect
    let refresh = current ? yield* makeSkillRefresh(current) : undefined
    let revisions: Map<string, string> | undefined
    const revisionIds = (snapshot: Snapshot) =>
      Effect.gen(function* () {
        return [
          yield* requirePageId(snapshot.record.id),
          ...(snapshot.references ?? []).map((page) => page.id),
        ]
      })
    const readRevision = (id: string) =>
      Effect.gen(function* () {
        const raw = property(yield* api.request(`v1/pages/${id}`))
        if (
          raw.in_trash === true ||
          raw.archived === true ||
          typeof raw.last_edited_time !== "string"
        )
          return undefined
        return String(raw.last_edited_time)
      })
    const checkVersion = (snapshot: Snapshot, targetId?: string) =>
      validate(
        Effect.gen(function* () {
          if (revisions) {
            const ids = targetId
              ? [...new Set([targetId, yield* requirePageId(snapshot.record.id)])]
              : yield* revisionIds(snapshot)
            for (const id of ids) {
              const revision = yield* readRevision(id)
              if (revision === undefined || revision !== revisions.get(id))
                return yield* Effect.fail(
                  fail(
                    "WRITE_CONFLICT",
                    "The skill or a reference page changed; read it again before writing.",
                    { page_id: snapshot.record.id },
                  ),
                )
            }
            return
          }
          const latest = yield* refresh
            ? refresh(snapshot)
            : openSkill(snapshot.record.id, { refresh: true })
          if (latest.version_id !== snapshot.version_id)
            return yield* Effect.fail(
              fail(
                "WRITE_CONFLICT",
                "The skill or a reference page changed; read it again before writing.",
                {
                  page_id: snapshot.record.id,
                  expected_version: snapshot.version_id,
                  actual_version: latest.version_id,
                },
              ),
            )
        }),
      )
    return yield* Effect.gen(function* () {
      if (current) {
        yield* checkVersion(current)
      } else {
        stage = "create_page"
        const raw = yield* run(
          stage,
          api.request("v1/pages", {
            parent: {
              type: "data_source_id",
              data_source_id: source.data_source_id,
            },
            properties: {
              Kind: { select: { name: portable.kind } },
              [props.title]: { title: [{ text: { content: doc.name } }] },
              [props.description]: {
                rich_text: [{ text: { content: doc.description } }],
              },
              ...(props.defaultContext
                ? { [props.defaultContext.property]: { checkbox: props.defaultContext.value } }
                : {}),
            },
          }),
        )
        completed.push(stage)
        id = decode(PageSchema, raw).id
      }
      const existing = [...(current?.references ?? [])]
      if (current) {
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          const children = property(
            yield* api.request(
              `v1/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
            ),
          )
          if (!Array.isArray(children.results) || typeof children.has_more !== "boolean")
            return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid child-page response."))
          for (const raw of children.results) {
            const child = property(raw)
            const title = property(child.child_page).title
            if (child.type !== "child_page" || typeof title !== "string" || !/\.md$/i.test(title))
              continue
            const path =
              existing.find((page) => page.id === child.id)?.path ??
              referenceFiles.find((file) => file.path === title)?.path ??
              referencePath(title)
            if (!referenceFiles.some((file) => file.path === path)) continue
            const previous = existing.find((page) => page.path === path)
            if (previous && previous.id !== child.id)
              return yield* Effect.fail(
                fail(
                  "REFERENCE_PATH_CONFLICT",
                  "Multiple child pages identify the same reference.",
                  {
                    path,
                    page_ids: [previous.id, child.id],
                  },
                ),
              )
            if (!previous) {
              if (typeof child.id !== "string")
                return yield* Effect.fail(fail("INVALID_RESPONSE", "Child page has no ID."))
              existing.push({ id: child.id, path, markdown: "" })
            }
          }
          if (!children.has_more) break
          if (typeof children.next_cursor !== "string" || seen.has(children.next_cursor))
            return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid child-page pagination."))
          cursor = children.next_cursor
          seen.add(cursor)
        } while (cursor)
      }
      const pages: ReferencePage[] = [{ id: id!, path: portable.main, markdown: "" }]
      const register = (references: readonly ReferencePage[]) =>
        Effect.gen(function* () {
          const value = yield* referenceValue(
            references.filter((page) => page.path !== pages[0]!.path),
          )
          return yield* api.request(
            `v1/pages/${id}`,
            { properties: { [props.references]: value } },
            { method: "PATCH" },
          )
        })
      // Allocate every page first, so forward and cyclic links can be written in one pass.
      for (const file of referenceFiles) {
        const old = existing.find((page) => page.path === file.path)
        if (old) pages.push(old)
        else {
          stage = `create_reference:${file.path}`
          const raw = yield* run(
            stage,
            api.request("v1/pages", {
              parent: { type: "page_id", page_id: id },
              properties: {
                title: {
                  title: [
                    {
                      text: {
                        content:
                          file.path.startsWith("references/") &&
                          !portable.files.some(
                            (source) => source.path === file.path.slice("references/".length),
                          )
                            ? file.path.slice("references/".length)
                            : file.path,
                      },
                    },
                  ],
                },
              },
            }),
          )
          completed.push(stage)
          pages.push({
            id: decode(PageSchema, raw).id,
            path: file.path,
            markdown: "",
          })
          stage = `register_reference:${file.path}`
          yield* run(
            stage,
            register([
              ...existing.filter((page) => !pages.some((allocated) => allocated.id === page.id)),
              ...pages,
            ]),
          )
          completed.push(stage)
        }
      }
      stage = "references"
      yield* run(
        stage,
        register([
          ...existing.filter((page) => !pages.some((allocated) => allocated.id === page.id)),
          ...pages,
        ]),
      )
      completed.push(stage)
      if (current?.markdown_files) {
        // Retain concrete ancestry only immediately before root replacement:
        // earlier child allocations must not repeatedly re-read this old tree.
        for (const block of yield* readMarkdownFileBlocks(id!, api))
          if (block.type !== "child_page") yield* api.request(`v1/blocks/${String(block.id)}`)
        // Switch the root before taking a native checkpoint: while the marker
        // exists, reads intentionally expose literal files instead of References.
        const before = pageMarkdown(yield* api.request(`v1/pages/${id}/markdown`))
        const tags = childPageTags(before)
        const content = rewritePageLinks(doc.body, portable.main, pages, "notion")
        stage = `body:${portable.main}`
        const written = yield* run(
          stage,
          api.request(
            `v1/pages/${id}/markdown`,
            {
              markdown_version: "v2",
              type: "replace_content",
              replace_content: {
                new_str: nativeMarkdownWire(
                  tags.length ? `${content.trim()}\n${tags.join("\n")}` : content,
                ),
              },
            },
            { method: "PATCH" },
          ),
        )
        pageMarkdown(written)
        completed.push(stage)
      }
      // Refresh after allocation; child-page blocks are kept during content replacement.
      let checkpoint = yield* run(
        "checkpoint",
        current && refresh ? refresh(current) : openSkill(id!, { refresh: true }),
      )
      refresh ??= yield* makeSkillRefresh(checkpoint)
      const seeded = new Map<string, string>()
      const checkpointIds = yield* revisionIds(checkpoint)
      for (const id of checkpointIds) {
        const revision = yield* readRevision(id)
        if (revision === undefined)
          return yield* Effect.fail(
            fail(
              "WRITE_CONFLICT",
              "A reference page has no exact revision; read it again before writing.",
              { page_id: id },
            ),
          )
        seeded.set(id, revision)
      }
      revisions = seeded
      const acceptOwnWrite = (ids: readonly string[]) =>
        Effect.gen(function* () {
          for (const id of ids) {
            const revision = yield* readRevision(id)
            if (revision === undefined)
              return yield* Effect.fail(
                fail(
                  "WRITE_CONFLICT",
                  "A reference page has no exact revision; read it again before writing.",
                  { page_id: id },
                ),
              )
            revisions!.set(id, revision)
          }
        })
      const writePage = (page: ReferencePage, body: string) =>
        Effect.gen(function* () {
          const previous = checkpoint.references?.find((entry) => entry.id === page.id)
          if (!previous)
            return yield* Effect.fail(
              fail("WRITE_CONFLICT", "The allocated reference page is missing."),
            )
          const before = previous.markdown
          const content = rewritePageLinks(body, page.path, pages, "notion")
          const tags = childPageTags(before)
          const authored = tags.length ? `${content.trim()}\n${tags.join("\n")}` : content
          const next = preserveCreationMarker(before, authored)
          if (
            markdownIdentity(
              fromNotionMarkdown(
                rewritePageLinks(before, page.path, pages, "local"),
                previous.blocks,
              ),
            ) !== markdownIdentity(rewritePageLinks(next, page.path, pages, "local")) &&
            !(
              // Prove the original readback before URL mapping. A recovered
              // candidate is already converted and must never be converted again.
              notionMarkdownForComparison(before, next, previous.blocks) !== undefined &&
              samePublishedMarkdown(before, next, undefined, previous.blocks) &&
              publicationExternalLinksMatch(
                before,
                next,
                (markdown) => markdown,
                previous.blocks,
                (actual, target, blocks, sameLink) =>
                  samePublishedMarkdown(actual, target, sameLink, blocks),
              )
            )
          ) {
            stage = `body:${page.path}`
            yield* run(
              stage,
              Effect.gen(function* () {
                yield* checkVersion(checkpoint, page.id)
                const written = yield* api.request(
                  `v1/pages/${page.id}/markdown`,
                  {
                    markdown_version: "v2",
                    type: "replace_content",
                    replace_content: { new_str: nativeMarkdownWire(next) },
                  },
                  { method: "PATCH" },
                )
                pageMarkdown(written)
                completed.push(stage)
                yield* acceptOwnWrite([page.id, yield* requirePageId(checkpoint.record.id)])
              }),
            )
          }
        })
      for (const page of pages.slice(1)) yield* writePage(page, bodies.get(page.path)!)
      yield* writePage(pages[0]!, doc.body)
      stage = "metadata"
      const finalReferences = yield* referenceValue(pages.slice(1))
      yield* checkVersion(checkpoint, id)
      yield* run(
        stage,
        api.request(
          `v1/pages/${id}`,
          {
            properties: {
              ...(operation === "write"
                ? {}
                : {
                    Kind: { select: { name: portable.kind } },
                    [props.title]: { title: [{ text: { content: doc.name } }] },
                    [props.description]: {
                      rich_text: [{ text: { content: doc.description } }],
                    },
                  }),
              ...(props.members
                ? {
                    [props.members.property]: {
                      relation: props.members.ids.map((id) => ({ id })),
                    },
                  }
                : {}),
              [props.references]: finalReferences,
            },
          },
          { method: "PATCH" },
        ),
      )
      completed.push(stage)
      if (revisions) yield* acceptOwnWrite([id!])
      checkpoint = yield* run("checkpoint", refresh!(checkpoint))
      if (props.files) {
        stage = "source_bundle"
        const main = checkpoint.files.find((file) => file.path === checkpoint.entrypoint)!
        const store = yield* Store
        const localDoc = importDocument(
          {
            path: checkpoint.entrypoint,
            bytes: yield* store.readBytes(`objects/${main.sha256}`),
          },
          { name: doc.name, description: doc.description },
        )
        const referenceProjection: Record<string, string> = {}
        for (const page of checkpoint.references?.slice(1) ?? []) {
          const file = checkpoint.files.find((file) => file.path === page.path)!
          referenceProjection[page.path] = bodyIdentity(
            new TextDecoder().decode(yield* store.readBytes(`objects/${file.sha256}`)),
          )
        }
        const authoredRoot = checkpoint.references?.find(
          (page) => page.path === checkpoint.entrypoint,
        )
        const projectedBody =
          portable.kind === "router" && authoredRoot
            ? fromNotionMarkdown(
                rewritePageLinks(
                  withoutChildPages(authoredRoot.markdown),
                  portable.main,
                  checkpoint.references!,
                  "local",
                  checkpoint.router_members,
                ),
                authoredRoot.blocks,
              )
            : localDoc.body
        const bytes = yield* Effect.try({
          try: () =>
            portableZip(
              {
                ...portable,
                projection: {
                  name: doc.name,
                  description: doc.description,
                  body: bodyIdentity(projectedBody),
                  references: referenceProjection,
                },
              },
              true,
            ),
          catch: (error) => error as SkillsError,
        })
        const bundle = yield* run("upload:source_bundle", upload({ bytes }, BUNDLE))
        completed.push("upload:source_bundle")
        yield* checkVersion(checkpoint, id)
        yield* run(
          stage,
          api.request(
            `v1/pages/${id}`,
            { properties: { [props.files]: { files: [bundle] } } },
            { method: "PATCH" },
          ),
        )
        completed.push(stage)
      }
      stage = "verify"
      const { snapshot, savedId } = yield* validate(
        Effect.gen(function* () {
          const snapshot = yield* run(stage, refresh!(checkpoint))
          if (snapshot.record.name !== doc.name || snapshot.record.description !== doc.description)
            return yield* Effect.fail(
              fail("WRITE_VERIFICATION_FAILED", "Skill metadata differs from the expected values."),
            )
          if (
            props.defaultContext &&
            snapshot.record.default_context !== props.defaultContext.value
          )
            return yield* Effect.fail(
              fail(
                "WRITE_VERIFICATION_FAILED",
                "Saved member Default Context differs from the frozen value.",
              ),
            )
          if (props.members) {
            const raw = yield* api.request(`v1/pages/${id}`)
            const actual = yield* Effect.try({
              try: () => memberIds(raw),
              catch: (error) => error as SkillsError,
            })
            if (JSON.stringify(actual) !== JSON.stringify(props.members.ids))
              return yield* Effect.fail(
                fail(
                  "WRITE_VERIFICATION_FAILED",
                  "Saved Router Members differ from the requested relation.",
                ),
              )
          }
          if (!(yield* referencePagesMatch(snapshot, portable)))
            return yield* Effect.fail(
              fail(
                "WRITE_VERIFICATION_FAILED",
                "Saved page Markdown differs from the submitted instructions or references.",
              ),
            )
          const saved = yield* snapshotAuthoredPortable(snapshot)
          const savedId = yield* portableIdentity(saved)
          if (
            props.files
              ? savedId !== contentId
              : (yield* referenceContentIdentity(saved)) !==
                (yield* referenceContentIdentity(portable))
          )
            return yield* Effect.fail(
              fail(
                "WRITE_VERIFICATION_FAILED",
                "Saved reference pages or Skill files differ from the submitted content.",
              ),
            )
          return { snapshot, savedId }
        }),
      )
      return {
        ...snapshotInfo(snapshot),
        operation,
        action: current ? ("update" as const) : ("create" as const),
        verified: true,
        content_id: savedId,
        reused: false,
        ...(current
          ? {
              previous_version_id: current.version_id,
              expected_version_id: current.version_id,
            }
          : {}),
      }
    }).pipe(
      Effect.mapError((error) =>
        fail(
          error.code === "WRITE_OUTCOME_UNKNOWN"
            ? error.code
            : completed.length
              ? "WRITE_PARTIAL"
              : error.code,
          error.message,
          {
            ...source,
            ...(id ? { page_id: id } : {}),
            stage,
            completed,
            cause_code: error.code,
            cause_details: error.details,
          },
        ),
      ),
      Effect.tapError((error) =>
        id && (error.code === "WRITE_PARTIAL" || error.code === "WRITE_OUTCOME_UNKNOWN")
          ? invalidateSnapshotCache(id, current?.scope).pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ),
    )
  })
}
