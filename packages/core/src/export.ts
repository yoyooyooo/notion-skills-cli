import { Effect, FileSystem, Path } from "effect"
import { importDocument, readImportZip } from "./import.ts"
import type { ImportFile } from "./import.ts"
import { fail, SkillsError } from "./model.ts"
import type { Snapshot } from "./model.ts"
import {
  BUNDLE,
  MANIFEST,
  authoredPortable,
  bodyIdentity,
  canonicalMain,
  fileOrder,
  portableFiles,
  portableZip,
} from "./portable.ts"
import type { PortableSkill } from "./portable.ts"
import { portableSourceDecoder } from "./portable-source.ts"
import { normalizePath, parseTarget } from "./ref.ts"
import { targetSnapshot, snapshotInfo } from "./snapshot.ts"
import { sha256, Store } from "./store.ts"
import type { ReadPolicyOptions } from "./cache.ts"
import { childPageTags, rewritePageLinks, withoutChildPages } from "./references.ts"
import {
  fromNotionMarkdown,
  notionMarkdownForComparison,
  samePublishedMarkdown,
  type NotionBlockBoundary,
} from "./markdown.ts"
import { withoutCreationMarkerWithBlocks } from "./publication-create-identity.ts"
import {
  publicationExternalLinksMatch,
  publicationSourceDestination,
  type PublicationMarkdownMapping,
  type PublicationMarkdownComparator,
} from "./publication-markdown.ts"
import { physicalReadbackTarget } from "./publication-physical-target.ts"
import { pageLocalUnicodeFragmentTarget } from "./publication-local-fragment.ts"

interface LiveReferenceBody {
  readonly markdown: string
  readonly blocks?: readonly NotionBlockBoundary[]
  readonly published: (markdown: string) => string
  readonly mapping: PublicationMarkdownMapping
}

// A projection can preserve original bytes only with current page evidence.
// Historical snapshots without that evidence must match the authored body directly.
function recoveredBodyMatches(
  live: string,
  authored: string | undefined,
  page?: LiveReferenceBody,
) {
  if (authored === undefined) return false
  if (!page)
    return (
      samePublishedMarkdown(live, authored) &&
      publicationExternalLinksMatch(live, authored, (markdown) => markdown)
    )
  const sourceDestination = publicationSourceDestination(page.mapping.source, page.blocks)
  const compare: PublicationMarkdownComparator = (actual, expected, blocks, sameLink) => {
    const target = pageLocalUnicodeFragmentTarget(physicalReadbackTarget(expected, blocks), blocks)
    return (
      samePublishedMarkdown(actual, target, sameLink, blocks) ||
      samePublishedMarkdown(fromNotionMarkdown(actual, blocks), target, sameLink, blocks)
    )
  }
  if (
    !publicationExternalLinksMatch(
      page.markdown,
      authored,
      page.mapping.preserveExternal,
      page.blocks,
      compare,
      sourceDestination,
    )
  )
    return false
  const published = page.published(authored)
  const target = pageLocalUnicodeFragmentTarget(
    physicalReadbackTarget(published, page.blocks),
    page.blocks,
  )
  const compared = new Set(
    [
      notionMarkdownForComparison(page.markdown, target, page.blocks),
      notionMarkdownForComparison(page.markdown, authored, page.blocks),
      fromNotionMarkdown(page.markdown, page.blocks),
    ].filter((value): value is string => value !== undefined),
  )
  const sameMapped = (map: PublicationMarkdownMapping["local"]) => {
    const expected = pageLocalUnicodeFragmentTarget(map(authored), page.blocks)
    return [...compared].some((candidate) => {
      const mapped = map(candidate)
      return (
        samePublishedMarkdown(mapped, expected, undefined, page.blocks) ||
        samePublishedMarkdown(
          fromNotionMarkdown(mapped, page.blocks),
          expected,
          undefined,
          page.blocks,
        )
      )
    })
  }
  return (
    samePublishedMarkdown(page.markdown, authored, sourceDestination, page.blocks) ||
    samePublishedMarkdown(
      fromNotionMarkdown(page.markdown, page.blocks),
      authored,
      sourceDestination,
      page.blocks,
    ) ||
    sameMapped(page.mapping.local) ||
    sameMapped(page.mapping.preserveExternal)
  )
}

export function snapshotPortable(snapshot: Snapshot) {
  return materializeSnapshotPortable(snapshot, true)
}

export function snapshotAuthoredPortable(snapshot: Snapshot) {
  return materializeSnapshotPortable(snapshot, false)
}

function materializeSnapshotPortable(snapshot: Snapshot, generated: boolean) {
  return Effect.gen(function* () {
    const decodeSource = yield* portableSourceDecoder
    const store = yield* Store
    const files: ImportFile[] = []
    for (const file of (!generated && snapshot.source_files) || snapshot.files) {
      const bytes = yield* store.readBytes(`objects/${file.sha256}`)
      if (bytes.length !== file.bytes || (yield* sha256(bytes)) !== file.sha256)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "Export file failed its checksum.", {
            path: file.path,
          }),
        )
      files.push({ path: file.path, bytes })
    }
    return yield* Effect.try({
      try: () => {
        if (snapshot.markdown_files)
          return {
            kind: snapshot.record.kind,
            name: snapshot.record.name,
            description: snapshot.record.description,
            main: snapshot.markdown_files.main,
            files,
          } satisfies PortableSkill
        if (generated && snapshot.source_projection)
          return {
            kind: snapshot.record.kind,
            name: snapshot.record.name,
            description: snapshot.record.description,
            main: snapshot.entrypoint,
            files,
          } satisfies PortableSkill
        const authoredRoot =
          snapshot.record.kind === "router"
            ? snapshot.references?.find((page) => page.path === snapshot.entrypoint)
            : undefined
        if (snapshot.record.kind === "router" && !authoredRoot)
          throw fail("INVALID_CONTENT_SOURCE", "Router export requires its authored root page.")
        const authoredBody = authoredRoot
          ? fromNotionMarkdown(
              rewritePageLinks(
                withoutChildPages(authoredRoot.markdown),
                snapshot.entrypoint,
                snapshot.references!,
                "local",
                snapshot.router_members,
              ),
              authoredRoot.blocks,
            )
          : undefined
        const main = files.find((file) => file.path === snapshot.entrypoint)
        if (!main) throw fail("INVALID_CONTENT", "Snapshot entrypoint is missing.")
        const doc = importDocument(main, {
          name: snapshot.record.name,
          description: snapshot.record.description,
        })
        const body = authoredBody ?? doc.body
        const materialize = (skill: PortableSkill): PortableSkill => {
          if (snapshot.record.kind !== "router" || !generated) return skill
          const authoredMain = skill.files.find((file) => file.path === skill.main)!
          const generatedMain = canonicalMain(skill.name, skill.description, doc.body, authoredMain)
          const decoder = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          })
          return {
            ...skill,
            files: skill.files.map((file) => (file.path === skill.main ? generatedMain : file)),
            projection: {
              ...skill.projection!,
              materialization: {
                authored: decoder.decode(authoredMain.bytes),
                generated: decoder.decode(generatedMain.bytes),
              },
            },
          }
        }
        const bundle = files.find((file) => file.path === BUNDLE)
        const portable = bundle ? decodeSource(readImportZip(bundle.bytes)) : undefined
        const source = portable ? authoredPortable(portable) : undefined
        if (bundle && !source)
          throw fail("INVALID_ARCHIVE", "Reserved source attachment has no portable manifest.")
        if (source && source.kind !== snapshot.record.kind)
          throw fail(
            "INVALID_CONTENT_SOURCE",
            "Portable source kind differs from the selected record.",
          )
        if (!source)
          return materialize({
            kind: snapshot.record.kind,
            name: snapshot.record.name,
            description: doc.description,
            main: snapshot.entrypoint,
            files: [
              canonicalMain(snapshot.record.name, doc.description, body, main),
              ...files.filter((file) => file.path !== snapshot.entrypoint),
            ].sort(fileOrder),
            ...(authoredBody === undefined
              ? {}
              : {
                  projection: {
                    name: snapshot.record.name,
                    description: snapshot.record.description,
                    body: authoredBody,
                  },
                }),
          } satisfies PortableSkill)
        const projection = source.projection
        const original = source.files.find((file) => file.path === source.main)!
        const sourceBody = importDocument(original, {
          name: snapshot.record.name,
          description: doc.description,
        }).body
        const livePages = snapshot.references?.map((page) => ({
          ...page,
          path: page.path === snapshot.entrypoint ? source.main : page.path,
        }))
        const referenceBody = (path: string): LiveReferenceBody | undefined => {
          if (!livePages) return undefined
          const page = livePages.find((page) => page.path === path)
          if (!page) return undefined
          const map = (markdown: string, preserveExternalUrls = false) => {
            const local = (value: string) =>
              rewritePageLinks(value, path, livePages, "local", snapshot.router_members, {
                preserveExternalUrls,
              })
            return local(
              rewritePageLinks(local(markdown), path, livePages, "notion", snapshot.router_members),
            )
          }
          const authored =
            path === source.main
              ? {
                  markdown: childPageTags(page.markdown).length
                    ? withoutChildPages(page.markdown)
                    : page.markdown,
                  blocks: page.blocks,
                }
              : withoutCreationMarkerWithBlocks(page.markdown, page.blocks)
          return {
            ...authored,
            published: (markdown) =>
              rewritePageLinks(markdown, path, livePages, "notion", snapshot.router_members),
            mapping: {
              local: (markdown) => map(markdown),
              preserveExternal: (markdown) => map(markdown, true),
              source: { path, files: source.files },
            },
          }
        }
        const unchanged =
          projection &&
          projection.name === snapshot.record.name &&
          projection.description === doc.description &&
          recoveredBodyMatches(body, sourceBody, referenceBody(source.main))
        const merged = new Map(source.files.map((file) => [file.path, file]))
        if (snapshot.references && projection?.references) {
          const live = new Set(snapshot.references.map((page) => page.path))
          for (const path of Object.keys(projection.references))
            if (!live.has(path)) merged.delete(path)
        }
        // Source main remains byte-exact until the live body or metadata changes.
        if (!unchanged)
          merged.set(
            source.main,
            canonicalMain(snapshot.record.name, doc.description, body, original),
          )
        for (const file of files)
          if (
            file.path !== snapshot.entrypoint &&
            file.path !== BUNDLE &&
            file.path !== MANIFEST &&
            file.path !== source.main
          )
            if (snapshot.references && projection?.references?.[file.path] !== undefined) {
              const currentBody = new TextDecoder("utf-8", {
                fatal: true,
              }).decode(file.bytes)
              const authoredFile = merged.get(file.path)
              const authoredText = authoredFile
                ? new TextDecoder("utf-8", { fatal: true }).decode(authoredFile.bytes)
                : undefined
              if (recoveredBodyMatches(currentBody, authoredText, referenceBody(file.path)))
                continue
              merged.set(file.path, file)
            } else merged.set(file.path, file)
        return materialize({
          kind: snapshot.record.kind,
          name: snapshot.record.name,
          description: doc.description,
          main: source.main,
          files: [...merged.values()].sort(fileOrder),
          ...(authoredBody === undefined
            ? {}
            : {
                projection: {
                  name: snapshot.record.name,
                  description: snapshot.record.description,
                  body: authoredBody,
                },
              }),
        } satisfies PortableSkill)
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_SKILL", "Could not construct a reversible export."),
    })
  })
}

export function portableIdentity(skill: PortableSkill) {
  return Effect.gen(function* () {
    skill = authoredPortable(skill)
    const files: Array<[string, string]> = []
    for (const file of [...skill.files].sort(fileOrder)) {
      const authored =
        skill.kind === "router" && file.path === skill.main
          ? importDocument(file, {
              name: skill.name,
              description: skill.description,
            }).body
          : undefined
      const bytes =
        authored === undefined
          ? file.bytes
          : canonicalMain(skill.name, skill.description, bodyIdentity(authored), file).bytes
      files.push([file.path, yield* sha256(bytes)])
    }
    return yield* sha256(JSON.stringify([skill.name, skill.description, skill.main, files]))
  })
}

export interface ExportOptions extends ReadPolicyOptions {
  readonly database?: string
  readonly output: string
  readonly projection?: "source" | "snapshot"
  readonly format?: "zip" | "directory"
}
export function exportSkill(selectorInput: string, options: ExportOptions) {
  return Effect.gen(function* () {
    const target = yield* Effect.try({
      try: () => parseTarget(selectorInput),
      catch: (e) => e as SkillsError,
    })
    const projection = options.projection ?? "source"
    const snapshot = yield* targetSnapshot(
      target,
      options,
      projection === "source" ? "authored" : "generated",
    )
    let skill: PortableSkill
    if (projection === "snapshot") {
      const store = yield* Store
      const files: ImportFile[] = []
      for (const file of snapshot.files) {
        const bytes = yield* store.readBytes(`objects/${file.sha256}`)
        if (bytes.length !== file.bytes || (yield* sha256(bytes)) !== file.sha256)
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "Export file failed its checksum.", {
              path: file.path,
            }),
          )
        files.push({ path: file.path, bytes })
      }
      skill = {
        kind: snapshot.record.kind,
        name: snapshot.record.name,
        description: snapshot.record.description,
        main: snapshot.entrypoint,
        files,
      }
    } else skill = yield* snapshotAuthoredPortable(snapshot)
    const exported = yield* exportPortable(skill, options)
    return {
      ...snapshotInfo(snapshot),
      ...exported,
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "OUTPUT_FAILED",
            "Could not write the Skill export; inspect output before retrying.",
            { output: options.output },
          ),
    ),
  )
}

export function exportPortable(
  skill: PortableSkill,
  options: Pick<ExportOptions, "output" | "format" | "projection">,
) {
  return Effect.gen(function* () {
    const format = options.format ?? (/\.zip$/i.test(options.output) ? "zip" : "directory")
    const projection = options.projection ?? "source"
    if (projection === "source") skill = authoredPortable(skill)
    const files = yield* Effect.try({
      try: () => portableFiles(skill, skill.kind === "router", projection === "snapshot"),
      catch: (e) => e as SkillsError,
    })
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const destination = path.resolve(options.output)
    let reused = false
    if (format === "zip") {
      const bytes = yield* Effect.try({
        try: () => portableZip(skill, skill.kind === "router", projection === "snapshot"),
        catch: (e) => e as SkillsError,
      })
      const store = yield* Store
      reused = (yield* store.output(destination, bytes)).reused
    } else {
      const exists = yield* fs.exists(destination)
      if (exists) {
        const names = yield* fs
          .readDirectory(destination, { recursive: true })
          .pipe(
            Effect.mapError(() =>
              fail("OUTPUT_CONFLICT", "Output is not an identical Skill directory."),
            ),
          )
        const existing: string[] = []
        for (const name of names)
          if ((yield* fs.stat(path.join(destination, name))).type !== "Directory")
            existing.push(name.split(path.sep).join("/"))
        if (
          JSON.stringify(existing.sort()) !== JSON.stringify(files.map((file) => file.path).sort())
        )
          return yield* Effect.fail(
            fail("OUTPUT_CONFLICT", "Output directory contains different files."),
          )
        for (const file of files) {
          const old = yield* fs.readFile(path.join(destination, normalizePath(file.path)))
          if ((yield* sha256(old)) !== (yield* sha256(file.bytes)))
            return yield* Effect.fail(
              fail("OUTPUT_CONFLICT", "Existing output file differs.", {
                path: file.path,
              }),
            )
        }
        reused = true
      } else {
        yield* fs.makeDirectory(destination, { mode: 0o700 })
        for (const file of files) {
          const output = path.join(destination, normalizePath(file.path))
          yield* fs.makeDirectory(path.dirname(output), {
            recursive: true,
            mode: 0o700,
          })
          yield* fs.writeFile(output, file.bytes, { flag: "wx", mode: 0o600 })
        }
      }
    }
    const inventory = []
    for (const file of files)
      inventory.push({
        path: file.path,
        bytes: file.bytes.length,
        hash: yield* sha256(file.bytes),
        role:
          file.path === MANIFEST
            ? "manifest"
            : file.path === BUNDLE
              ? "source_bundle"
              : file.path === skill.main
                ? "entrypoint"
                : "resource",
      })
    return {
      operation: "export",
      format,
      output: destination,
      reused,
      content_id: yield* portableIdentity(skill),
      main_path: skill.main,
      entrypoint: skill.main,
      projection,
      files: inventory,
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "OUTPUT_FAILED",
            "Could not write the Skill export; inspect output before retrying.",
            { output: options.output },
          ),
    ),
  )
}
