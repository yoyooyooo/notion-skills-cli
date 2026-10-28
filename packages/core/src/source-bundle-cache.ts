import { Crypto, Effect } from "effect"
import type { SourceBundleCheckpoint } from "./cache.ts"
import { portableIdentity, snapshotAuthoredPortable } from "./export.ts"
import { readImportZip } from "./import.ts"
import { fail, property, SkillsError, type Snapshot } from "./model.ts"
import { Notion } from "./notion.ts"
import { BUNDLE, readPortable } from "./portable.ts"
import { canonical, metadata } from "./publication-observation.ts"
import { pageId } from "./ref.ts"
import { sha256, Store } from "./store.ts"

/** Timestamps are a cache validator, not a replacement for --refresh body proof.
 * Keep immutable attachment identity, excluding only expiring URL query values. */
function pageFingerprint(raw: unknown) {
  const page = property(raw)
  if (
    typeof page.id !== "string" ||
    pageId(page.id) !== page.id ||
    typeof page.last_edited_time !== "string" ||
    !Number.isFinite(Date.parse(page.last_edited_time)) ||
    page.in_trash === true ||
    page.archived === true
  )
    return undefined
  const attachments: unknown[] = []
  for (const [name, rawField] of Object.entries(property(page.properties))) {
    const field = property(rawField)
    if (field.type !== "files") continue
    if (!Array.isArray(field.files) || field.has_more === true) return undefined
    for (const rawFile of field.files) {
      const file = property(rawFile),
        url = property(file.file).url
      // External URLs can change bytes without any Notion edit; keep those on the full path.
      if (file.type !== "file" || typeof url !== "string") return undefined
      let identity: string
      try {
        const parsed = new URL(url)
        identity = parsed.origin + parsed.pathname
      } catch {
        return undefined
      }
      attachments.push([name, file.name, file.id ?? null, identity])
    }
  }
  return canonical([metadata(raw), attachments])
}

export function hasSourceBundle(raw: unknown) {
  return Object.values(property(property(raw).properties)).some((value) => {
    const field = property(value)
    return (
      field.type === "files" &&
      Array.isArray(field.files) &&
      field.files.filter((file) => property(file).name === BUNDLE).length === 1
    )
  })
}

/** Capture the metadata already observed by the complete reader. No extra body
 * requests or remote writes are introduced while establishing the first baseline. */
export function captureSourceBundle(rawPage: unknown, api: Notion["Service"]) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const root = String(property(rawPage).id)
    const pages = new Map<string, string>()
    const properties = new Map<string, string>()
    let stable = true
    const observe = (path: string, raw: unknown) =>
      Effect.gen(function* () {
        const match = /^v1\/pages\/([a-f0-9-]+)$/.exec(path)
        const values = match ? pages : properties
        const key = match ? match[1]! : path
        if (!match && !path.startsWith(`v1/pages/${root}/properties/`)) return
        const value = match ? pageFingerprint(raw) : canonical(raw)
        if (value === undefined) {
          stable = false
          return
        }
        const hash = yield* sha256(value)
        if (values.has(key) && values.get(key) !== hash) stable = false
        values.set(key, hash)
      })
    yield* observe(`v1/pages/${root}`, rawPage)
    const captured: Notion["Service"] = {
      ...api,
      request: (path, body, options) =>
        api.request(path, body, options).pipe(
          Effect.tap((raw) =>
            (options?.method ?? (body === undefined ? "GET" : "POST")) === "GET"
              ? observe(path, raw)
              : Effect.void,
          ),
          Effect.provideService(Crypto.Crypto, crypto),
        ),
    }
    return {
      api: captured,
      checkpoint: (snapshot: Snapshot) =>
        Effect.gen(function* () {
          if (!stable || snapshot.markdown_files || !snapshot.references?.length) return undefined
          const entries: SourceBundleCheckpoint["pages"][number][] = []
          for (const page of snapshot.references) {
            const fingerprint = pages.get(page.id)
            if (!fingerprint) return undefined
            entries.push({ id: page.id, fingerprint })
          }
          const bundle = snapshot.files.find((file) => file.path === BUNDLE)
          if (!bundle) return undefined
          const store = yield* Store
          const bytes = yield* store.readBytes(`objects/${bundle.sha256}`)
          const source = yield* Effect.try({
            try: () => readPortable(readImportZip(bytes)),
            catch: (error) =>
              error instanceof SkillsError
                ? error
                : fail("INVALID_ARCHIVE", "The verified source archive cannot be decoded."),
          })
          // An accepted manual edit can leave an older ZIP attached; only aligned file sets qualify.
          if (
            !source ||
            (yield* portableIdentity(source)) !==
              (yield* portableIdentity(yield* snapshotAuthoredPortable(snapshot)))
          )
            return undefined
          return {
            version: 1 as const,
            snapshot_id: snapshot.snapshot_id,
            version_id: snapshot.version_id,
            bundle_hash: bundle.sha256,
            pages: entries,
            properties: [...properties].map(([path, fingerprint]) => ({ path, fingerprint })),
          } satisfies SourceBundleCheckpoint
        }),
    }
  })
}

export function sourceBundleUnchanged(checkpoint: SourceBundleCheckpoint, rawPage: unknown) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const root = String(property(rawPage).id)
    const rootBefore = pageFingerprint(rawPage)
    if (
      !rootBefore ||
      checkpoint.pages[0]?.id !== root ||
      new Set(checkpoint.pages.map((page) => page.id)).size !== checkpoint.pages.length
    )
      return false
    for (const page of checkpoint.pages) {
      if (pageId(page.id) !== page.id) return false
      const raw = page.id === root ? rawPage : yield* api.request(`v1/pages/${page.id}`)
      const fingerprint = pageFingerprint(raw)
      if (!fingerprint || (yield* sha256(fingerprint)) !== page.fingerprint) return false
    }
    for (const entry of checkpoint.properties) {
      if (!entry.path.startsWith(`v1/pages/${root}/properties/`)) return false
      const value = yield* api.request(entry.path)
      if ((yield* sha256(canonical(value))) !== entry.fingerprint) return false
    }
    const rootAfter = yield* api.request(`v1/pages/${root}`)
    return pageFingerprint(rootAfter) === rootBefore
  })
}
