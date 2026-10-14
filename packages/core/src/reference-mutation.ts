import { Effect } from "effect"
import type { Crypto, Path } from "effect"
import { importDocument } from "./import.ts"
import { decode, fail, PageSchema, SkillsError, property } from "./model.ts"
import type { Snapshot } from "./model.ts"
import { Notion } from "./notion.ts"
import { bodyIdentity, BUNDLE, portableZip, canonicalMain } from "./portable.ts"
import type { PortableSkill } from "./portable.ts"
import { childPageTags, pageMarkdown, rewritePageLinks, referencePath } from "./references.ts"
import type { ReferencePage } from "./references.ts"
import { openSkill, snapshotInfo } from "./snapshot.ts"
import { portableIdentity, snapshotPortable } from "./export.ts"
import { Store } from "./store.ts"
import { invalidateSnapshotCache } from "./cache.ts"

export interface ReferenceProperties {
  readonly title: string
  readonly description: string
  readonly references: string
  readonly files?: string
}

export function referenceContentIdentity(portable: PortableSkill) {
  return Effect.gen(function* () {
    const files = yield* Effect.try({
      try: () => {
        const main = portable.files.find((file) => file.path === portable.main)!
        const doc = importDocument(main, { name: portable.name, description: portable.description })
        const pages = portable.files.map((file, index) => ({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          path: file.path === portable.main ? "SKILL.md" : file.path,
          markdown: "",
        }))
        const normalized = (body: string, path: string) =>
          bodyIdentity(
            rewritePageLinks(rewritePageLinks(body, path, pages, "notion"), path, pages, "local"),
          )
        return portable.files.map((file) =>
          file.path === portable.main
            ? canonicalMain(portable.name, portable.description, normalized(doc.body, "SKILL.md"))
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
    return yield* portableIdentity({ ...portable, main: "SKILL.md", files })
  })
}
export function referenceInput(portable: PortableSkill, hasFiles: boolean) {
  return Effect.gen(function* () {
    const referenceFiles = portable.files.filter(
      (file) => file.path !== portable.main && /^references\/.*\.md$/i.test(file.path),
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
    const bodies = new Map<string, string>()
    for (const file of referenceFiles) {
      const body = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
        catch: () =>
          fail("INVALID_REFERENCES", "Reference Markdown must be UTF-8.", { path: file.path }),
      })
      if (body.includes("\0"))
        return yield* Effect.fail(
          fail("INVALID_REFERENCES", "Reference Markdown must be text.", { path: file.path }),
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
  operation: "create" | "import" | "write",
  current: Snapshot | undefined,
  upload: (
    input: { bytes: Uint8Array },
    filename: string,
  ) => Effect.Effect<
    { name: string; type: "file_upload"; file_upload: { id: string } },
    SkillsError,
    Notion | Store | Path.Path | Crypto.Crypto
  >,
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const contentId = yield* portableIdentity(portable)
    const { referenceFiles, bodies } = yield* referenceInput(portable, Boolean(props.files))
    const completed: string[] = []
    let id = current?.skill.id
    let stage = "prepare"
    const checkVersion = (snapshot: Snapshot) =>
      Effect.gen(function* () {
        const latest = yield* openSkill(snapshot.skill.id, { refresh: true })
        if (latest.version_id !== snapshot.version_id)
          return yield* Effect.fail(
            fail(
              "WRITE_CONFLICT",
              "The skill or a reference page changed; read it again before writing.",
              {
                page_id: snapshot.skill.id,
                expected_version: snapshot.version_id,
                actual_version: latest.version_id,
              },
            ),
          )
      })
    return yield* Effect.gen(function* () {
      if (current) yield* checkVersion(current)
      else {
        stage = "create_page"
        const raw = yield* api.request("v1/pages", {
          parent: { type: "data_source_id", data_source_id: source.data_source_id },
          properties: {
            [props.title]: { title: [{ text: { content: doc.name } }] },
            [props.description]: { rich_text: [{ text: { content: doc.description } }] },
          },
        })
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
            const path = referencePath(title)
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
      const pages: ReferencePage[] = [{ id: id!, path: "SKILL.md", markdown: "" }]
      const register = (references: readonly ReferencePage[]) =>
        api.request(
          `v1/pages/${id}`,
          {
            properties: {
              [props.references]: {
                rich_text: references
                  .filter((page) => page.path !== "SKILL.md")
                  .flatMap((page, index) => [
                    ...(index ? [{ type: "text", text: { content: "\n" } }] : []),
                    {
                      type: "text",
                      text: {
                        content: page.path,
                        link: { url: `https://www.notion.so/${page.id.replaceAll("-", "")}` },
                      },
                    },
                  ]),
              },
            },
          },
          { method: "PATCH" },
        )
      // Allocate every page first, so forward and cyclic links can be written in one pass.
      for (const file of referenceFiles) {
        const old = existing.find((page) => page.path === file.path)
        if (old) pages.push(old)
        else {
          stage = `create_reference:${file.path}`
          const raw = yield* api.request("v1/pages", {
            parent: { type: "page_id", page_id: id },
            properties: {
              title: { title: [{ text: { content: file.path.slice("references/".length) } }] },
            },
          })
          completed.push(stage)
          pages.push({ id: decode(PageSchema, raw).id, path: file.path, markdown: "" })
          stage = `register_reference:${file.path}`
          yield* register([
            ...existing.filter((page) => !pages.some((allocated) => allocated.id === page.id)),
            ...pages,
          ])
          completed.push(stage)
        }
      }
      stage = "references"
      yield* register([
        ...existing.filter((page) => !pages.some((allocated) => allocated.id === page.id)),
        ...pages,
      ])
      completed.push(stage)
      // Refresh after allocation; child-page blocks are kept during content replacement.
      let checkpoint = yield* openSkill(id!, { refresh: true })
      const writePage = (page: ReferencePage, body: string) =>
        Effect.gen(function* () {
          const before = pageMarkdown(yield* api.request(`v1/pages/${page.id}/markdown`))
          const content = rewritePageLinks(body, page.path, pages, "notion")
          const tags = childPageTags(before)
          const next = tags.length ? `${content.trim()}\n${tags.join("\n")}` : content
          if (bodyIdentity(before) !== bodyIdentity(next)) {
            yield* checkVersion(checkpoint)
            stage = `body:${page.path}`
            const written = yield* api.request(
              `v1/pages/${page.id}/markdown`,
              { type: "replace_content", replace_content: { new_str: next } },
              { method: "PATCH" },
            )
            pageMarkdown(written)
            completed.push(stage)
            checkpoint = yield* openSkill(id!, { refresh: true })
          }
        })
      for (const page of pages.slice(1)) yield* writePage(page, bodies.get(page.path)!)
      yield* writePage(pages[0]!, doc.body)
      stage = "references"
      yield* checkVersion(checkpoint)
      yield* api.request(
        `v1/pages/${id}`,
        {
          properties: {
            [props.title]: { title: [{ text: { content: doc.name } }] },
            [props.description]: { rich_text: [{ text: { content: doc.description } }] },
            [props.references]: {
              rich_text: pages.slice(1).flatMap((page, index) => [
                ...(index ? [{ type: "text", text: { content: "\n" } }] : []),
                {
                  type: "text",
                  text: {
                    content: page.path,
                    link: { url: `https://www.notion.so/${page.id.replaceAll("-", "")}` },
                  },
                },
              ]),
            },
          },
        },
        { method: "PATCH" },
      )
      completed.push(stage)
      checkpoint = yield* openSkill(id!, { refresh: true })
      if (props.files) {
        stage = "source_bundle"
        const main = checkpoint.files.find((file) => file.path === "SKILL.md")!
        const store = yield* Store
        const localDoc = importDocument(
          { path: "SKILL.md", bytes: yield* store.readBytes(`objects/${main.sha256}`) },
          { name: doc.name, description: doc.description },
        )
        const referenceProjection: Record<string, string> = {}
        for (const page of checkpoint.references?.slice(1) ?? []) {
          const file = checkpoint.files.find((file) => file.path === page.path)!
          referenceProjection[page.path] = bodyIdentity(
            new TextDecoder().decode(yield* store.readBytes(`objects/${file.sha256}`)),
          )
        }
        const bytes = yield* Effect.try({
          try: () =>
            portableZip(
              {
                ...portable,
                projection: {
                  name: doc.name,
                  description: doc.description,
                  body: bodyIdentity(localDoc.body),
                  references: referenceProjection,
                },
              },
              true,
            ),
          catch: (error) => error as SkillsError,
        })
        const bundle = yield* upload({ bytes }, BUNDLE)
        completed.push("upload:source_bundle")
        yield* checkVersion(checkpoint)
        yield* api.request(
          `v1/pages/${id}`,
          { properties: { [props.files]: { files: [bundle] } } },
          { method: "PATCH" },
        )
        completed.push(stage)
      }
      stage = "verify"
      const snapshot = yield* openSkill(id!, { refresh: true })
      const saved = yield* snapshotPortable(snapshot)
      const savedId = yield* portableIdentity(saved)
      if (
        props.files
          ? savedId !== contentId
          : (yield* referenceContentIdentity(saved)) !== (yield* referenceContentIdentity(portable))
      )
        return yield* Effect.fail(
          fail(
            "WRITE_VERIFICATION_FAILED",
            "Saved reference pages or Skill files differ from the submitted content.",
          ),
        )
      return {
        ...snapshotInfo(snapshot),
        operation,
        action: current ? ("update" as const) : ("create" as const),
        verified: true,
        content_id: savedId,
        reused: false,
        ...(current
          ? { previous_version_id: current.version_id, expected_version_id: current.version_id }
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
