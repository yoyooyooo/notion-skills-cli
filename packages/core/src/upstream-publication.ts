import { Effect, Layer, Path, Schema } from "effect"
import type { Crypto, FileSystem } from "effect"
import { HttpClient } from "effect/http"
import { portableIdentity, snapshotPortable } from "./export.ts"
import { createPortable, replaceSkill, resumePublication } from "./mutation.ts"
import { fail, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { portableZip, portableFiles, readPortable, type PortableSkill } from "./portable.ts"
import { beginPublication } from "./publication.ts"
import { recoverPublication } from "./publication-recovery.ts"
import { proveUnsentModePublication } from "./upstream-unsent-mode.ts"
import { PublicationReceiptSchema } from "./publication-model.ts"
import { reconcilePublication } from "./publication-reconcile.ts"
import {
  PublicationInspectDivergence,
  publicationMarker,
  publicationOwnership,
  PublicationReadOperation,
} from "./publication-integrity.ts"
import { pageId } from "./ref.ts"
import { openSkill, snapshotInfo } from "./snapshot.ts"
import { sha256, Store } from "./store.ts"
import { readImportZip } from "./import.ts"
import { ForkBaselineSchema, UpstreamPublisher } from "./upstream-model.ts"
import type { ManagedContent, PublishRequest, VerifiedPublication } from "./upstream-model.ts"
import { verifyPublicationMetadata } from "./publication-source.ts"
import { publicationIdentityForUpstream as publicationId } from "./upstream-content.ts"

const attempt = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("INVALID_UPSTREAM", "Invalid upstream publication data."),
  })
function inspectSnapshot(id: string, operationId?: string) {
  return Effect.gen(function* () {
    if (pageId(id) !== id)
      return yield* Effect.fail(
        fail("INVALID_TARGET", "Upstream publisher requires an exact page UUID."),
      )
    const api = yield* Notion
    let observedPage: unknown
    // A supplied operation verifies original source integrity on this same read.
    // Inspection alone must not substitute for that committed proof.
    const snapshot = yield* openSkill(id, { refresh: true }).pipe(
      Effect.provideService(PublicationReadOperation, operationId),
      Effect.provideService(PublicationInspectDivergence, operationId === undefined),
      Effect.provideService(Notion, {
        ...api,
        request: (path, body, options) =>
          api.request(path, body, options).pipe(
            Effect.tap((raw) =>
              path === `v1/pages/${id}`
                ? attempt(() => {
                    publicationOwnership(raw)
                    if (observedPage === undefined) observedPage = raw
                  })
                : Effect.void,
            ),
          ),
      }),
    )
    const raw = observedPage
    const ownership = yield* attempt(() => publicationOwnership(raw))
    const portable = yield* snapshotPortable(snapshot)
    let owner: ManagedContent["ownership"]
    if (
      ownership.mode ||
      ownership.upstream.length ||
      ownership.key ||
      ownership.hash ||
      ownership.revision ||
      ownership.baseline
    ) {
      if (
        !ownership.mode ||
        ownership.upstream.length !== 1 ||
        !ownership.key ||
        !ownership.hash ||
        !ownership.revision
      )
        return yield* Effect.fail(
          fail("INVALID_UPSTREAM", "Managed upstream provenance is incomplete."),
        )
      const baseline = ownership.baseline
        ? yield* attempt(() =>
            Schema.decodeUnknownSync(Schema.fromJsonString(ForkBaselineSchema))(
              ownership.baseline,
              { onExcessProperty: "error" },
            ),
          )
        : undefined
      owner = {
        subscription_id: ownership.upstream[0]!,
        member_key: ownership.key,
        mode: ownership.mode as "tracked" | "fork",
        published_hash: ownership.hash,
        revision: ownership.revision,
        ...(baseline ? { fork_baseline: baseline } : {}),
      }
    }
    const observedVersion = yield* sha256(
      JSON.stringify([snapshot.version_id, property(raw).last_edited_time, ownership]),
    )
    return {
      snapshot,
      raw,
      content: {
        page_id: id,
        version: observedVersion,
        content_hash: yield* portableIdentity(portable),
        portable,
        ...(owner ? { ownership: owner } : {}),
      } satisfies ManagedContent,
    }
  })
}
function verified(id: string, operationId: string) {
  return Effect.gen(function* () {
    const { raw, content, snapshot } = yield* inspectSnapshot(id, operationId)
    const receipt = yield* (yield* Store).readJson(
      `publications/${operationId}.json`,
      PublicationReceiptSchema,
    )
    if (receipt?.context?.source_intent) {
      if (receipt.state !== "completed")
        return yield* Effect.fail(
          fail("PUBLICATION_INCOMPLETE", "The upstream publication has unfinished metadata."),
        )
      yield* verifyPublicationMetadata(receipt, yield* Notion)
    }
    const marker = yield* attempt(() => publicationMarker(raw))
    const verifiedReuse =
      receipt?.state === "completed" &&
      receipt.page_id === id &&
      snapshot.record.locator.type === "notion_page" &&
      receipt.database_id === snapshot.record.locator.database_id &&
      receipt.data_source_id === snapshot.record.locator.data_source_id &&
      receipt.context?.source_intent?.mode === "set" &&
      receipt.context.source_intent.value.type === "upstream" &&
      receipt.intents.length === 0 &&
      property(receipt.result).reused === true &&
      property(receipt.result).snapshot_id === snapshot.snapshot_id &&
      property(receipt.result).version_id === snapshot.version_id &&
      receipt.context.ownership?.published_hash === content.content_hash
    if (marker?.state !== "committed" || (marker.operation_id !== operationId && !verifiedReuse))
      return yield* Effect.fail(
        fail("PUBLICATION_INCOMPLETE", "The upstream item has no matching committed publication.", {
          page_id: id,
          operation_id: operationId,
        }),
      )
    return {
      page_id: id,
      version: content.version,
      content_hash: content.content_hash,
      publication_operation_id: marker.operation_id,
      verified: true,
    } satisfies VerifiedPublication
  })
}

const baselineTitle = (operationId: string) => `ntn-baseline-${operationId}`
function childPages(parent: string) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const pages: Array<{ id: string; title: string }> = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const raw = property(
        yield* api.request(
          `v1/blocks/${parent}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      )
      if (!Array.isArray(raw.results) || typeof raw.has_more !== "boolean")
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid baseline child inventory."))
      for (const block of raw.results) {
        const value = property(block)
        if (value.type === "child_page" && typeof value.id === "string")
          pages.push({ id: value.id, title: String(property(value.child_page).title) })
      }
      if (!raw.has_more) break
      if (typeof raw.next_cursor !== "string" || seen.has(raw.next_cursor))
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid baseline child pagination."))
      cursor = raw.next_cursor
      seen.add(cursor)
    } while (cursor)
    return pages
  })
}
function baselinePayload(ref: string) {
  return Effect.gen(function* () {
    const match = /^notion-baseline:\/\/([a-f0-9-]{36})#([a-f0-9]{64})$/.exec(ref)
    if (!match || pageId(match[1]!) !== match[1])
      return yield* Effect.fail(fail("INVALID_UPSTREAM", "Invalid recoverable baseline reference."))
    const api = yield* Notion
    const before = property(yield* api.request(`v1/pages/${match[1]}`))
    if (before.in_trash || before.archived)
      return yield* Effect.fail(
        fail("BASELINE_UNAVAILABLE", "The remote baseline is archived or in trash."),
      )
    let cursor: string | undefined
    const pieces: string[] = []
    const seen = new Set<string>()
    do {
      const raw = property(
        yield* api.request(
          `v1/blocks/${match[1]}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      )
      if (!Array.isArray(raw.results) || typeof raw.has_more !== "boolean")
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid baseline payload inventory."))
      for (const rawBlock of raw.results) {
        const block = property(rawBlock)
        if (block.type !== "file")
          return yield* Effect.fail(
            fail("BASELINE_DIVERGED", "Unexpected block in immutable baseline payload."),
          )
        const file = property(block.file)
        const url = property(file[String(file.type)]).url
        if (typeof url !== "string")
          return yield* Effect.fail(
            fail("BASELINE_UNAVAILABLE", "The remote baseline archive has no readable URL."),
          )
        const client = HttpClient.withScope(yield* HttpClient.HttpClient)
        const bytes = yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* client.get(url)
            if (response.status < 200 || response.status >= 300)
              return yield* Effect.fail(
                fail("BASELINE_UNAVAILABLE", "Could not download the remote baseline archive."),
              )
            return new Uint8Array(yield* response.arrayBuffer)
          }),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof SkillsError
              ? error
              : fail("BASELINE_UNAVAILABLE", "Could not download the remote baseline archive."),
          ),
        )
        if (bytes.length > 20 * 1024 * 1024)
          return yield* Effect.fail(
            fail("BASELINE_DIVERGED", "Remote baseline archive exceeds the upload limit."),
          )
        pieces.push(Buffer.from(bytes).toString("base64"))
      }
      if (!raw.has_more) break
      if (typeof raw.next_cursor !== "string" || seen.has(raw.next_cursor))
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid baseline payload pagination."))
      cursor = raw.next_cursor
      seen.add(cursor)
    } while (cursor)
    const payload = pieces.join("")
    const after = property(yield* api.request(`v1/pages/${match[1]}`))
    if (
      before.last_edited_time !== after.last_edited_time ||
      after.in_trash ||
      after.archived ||
      (yield* sha256(payload)) !== match[2]
    )
      return yield* Effect.fail(
        fail("BASELINE_DIVERGED", "The remote baseline failed its immutable payload checksum."),
      )
    return payload
  })
}

/** Real remote payload; no expiring download URL or machine-local snapshot is a baseline authority. */
export function readUpstreamBaseline(ref: string) {
  return Effect.gen(function* () {
    const payload = yield* baselinePayload(ref)
    return yield* attempt(() => {
      const files = readImportZip(new Uint8Array(Buffer.from(payload, "base64")))
      const portable = readPortable(files)
      if (!portable) throw fail("BASELINE_DIVERGED", "Baseline has no portable manifest.")
      portableFiles(portable)
      return portable
    })
  })
}
function saveBaseline(
  page: string,
  version: string,
  accepted?: {
    readonly portable: PortableSkill
    readonly content_hash: string
    readonly revision: string
  },
) {
  return Effect.gen(function* () {
    const { content } = yield* inspectSnapshot(page)
    if (content.version !== version)
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "Content changed before its fork baseline could be frozen."),
      )
    if (!content.ownership)
      return yield* Effect.fail(
        fail("INVALID_UPSTREAM", "Only an owned upstream item can create a fork baseline."),
      )
    const portable = accepted?.portable ?? content.portable
    if (accepted && (yield* portableIdentity(portable)) !== accepted.content_hash)
      return yield* Effect.fail(
        fail("BASELINE_DIVERGED", "Accepted baseline differs from its content hash."),
      )
    const archive = yield* attempt(() => portableZip(portable))
    const payload = Buffer.from(archive).toString("base64")
    const hash = yield* sha256(payload)
    const operationId = `b_${yield* sha256(JSON.stringify([page, content.ownership.subscription_id, accepted?.revision ?? content.ownership.revision, hash]))}`
    const store = yield* Store
    let intent = yield* store.integrity.baseline(operationId)
    if (!intent) {
      intent = {
        version: 1,
        operation_id: operationId,
        parent_page_id: content.ownership.subscription_id,
        payload,
        hash,
        state: "prepared",
      }
      yield* store.integrity.saveBaseline(intent)
    }
    const api = yield* Notion
    if (!intent.page_id && intent.state === "unknown") {
      const candidates = (yield* childPages(intent.parent_page_id)).filter(
        (item) => item.title === baselineTitle(operationId),
      )
      const matches: string[] = []
      for (const candidate of candidates) {
        const readback = yield* baselinePayload(`notion-baseline://${candidate.id}#${hash}`).pipe(
          Effect.result,
        )
        if (readback._tag === "Success" && readback.success === payload) matches.push(candidate.id)
      }
      if (matches.length !== 1)
        return yield* Effect.fail(
          fail(
            "WRITE_OUTCOME_UNKNOWN",
            "Baseline creation cannot yet be uniquely reconciled; no create was replayed.",
            { operation_id: operationId, parent_page_id: intent.parent_page_id },
          ),
        )
      intent = { ...intent, page_id: matches[0]!, state: "complete" }
      yield* store.integrity.saveBaseline(intent)
    }
    if (!intent.page_id) {
      const hashBytes = yield* sha256(archive)
      const uploadKey = `uploads/${hashBytes}/fork-baseline.zip`
      yield* store.writeBytes(uploadKey, archive)
      const path = yield* Path.Path
      const upload = property(
        yield* api.request("v1/file_uploads", {
          filename: "fork-baseline.zip",
          mode: "single_part",
        }),
      )
      if (typeof upload.id !== "string")
        return yield* Effect.fail(
          fail("WRITE_OUTCOME_UNKNOWN", "Baseline archive upload returned no identity."),
        )
      const uploaded = property(
        yield* api.request(`v1/file_uploads/${upload.id}/send`, undefined, {
          method: "POST",
          file: path.join(store.root, uploadKey),
        }),
      )
      if (uploaded.status !== "uploaded")
        return yield* Effect.fail(
          fail("BASELINE_UNAVAILABLE", "Baseline archive upload has not completed."),
        )
      intent = { ...intent, state: "unknown" }
      yield* store.integrity.saveBaseline(intent)
      const created = property(
        yield* api.request("v1/pages", {
          parent: { type: "page_id", page_id: intent.parent_page_id },
          properties: {
            title: { title: [{ type: "text", text: { content: baselineTitle(operationId) } }] },
          },
          children: [
            {
              object: "block",
              type: "file",
              file: { type: "file_upload", file_upload: { id: upload.id } },
            },
          ],
        }),
      )
      if (typeof created.id !== "string")
        return yield* Effect.fail(
          fail("WRITE_OUTCOME_UNKNOWN", "Baseline creation returned no exact page identity.", {
            operation_id: operationId,
          }),
        )
      intent = { ...intent, page_id: created.id, state: "created" }
      yield* store.integrity.saveBaseline(intent)
    }
    const ref = `notion-baseline://${intent.page_id}#${hash}`
    const restored = yield* readUpstreamBaseline(ref)
    if ((yield* portableIdentity(restored)) !== (yield* portableIdentity(portable)))
      return yield* Effect.fail(
        fail("BASELINE_DIVERGED", "Restored baseline differs from the accepted content."),
      )
    yield* store.integrity.saveBaseline({ ...intent, state: "complete" })
    return ref
  })
}

export const UpstreamPublisherLive = Layer.effect(
  UpstreamPublisher,
  Effect.gen(function* () {
    type PublisherEnvironment =
      | Notion
      | Store
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | HttpClient.HttpClient
    const services = yield* Effect.context<PublisherEnvironment>()
    const bind = <A>(effect: Effect.Effect<A, SkillsError, PublisherEnvironment>) =>
      effect.pipe(Effect.provide(services))
    const reconcile = (operationId: string) =>
      bind(
        Effect.gen(function* () {
          const store = yield* Store
          const location = yield* publicationId(operationId)
          const receipt = yield* store.readJson(
            `publications/${location.id}.json`,
            PublicationReceiptSchema,
          )
          if (!receipt) return undefined
          if (
            receipt.state === "completed" &&
            receipt.page_id &&
            receipt.intents.length === 0 &&
            property(receipt.result).reused === true
          )
            return yield* verified(receipt.page_id, location.id)
          const reconciliation = yield* reconcilePublication(location.id)
          if (reconciliation.outcome === "conflict")
            return yield* Effect.fail(
              fail(
                "WRITE_CONFLICT",
                "Upstream publication reconciliation observed an external edit.",
                { operation_id: location.id },
              ),
            )
          const latest = yield* store.readJson(
            `publications/${location.id}.json`,
            PublicationReceiptSchema,
          )
          if (!latest?.page_id) return undefined
          const result = yield* verified(latest.page_id, location.id).pipe(Effect.result)
          return result._tag === "Success" ? result.success : undefined
        }),
      )
    return {
      inspect: (id) => bind(Effect.map(inspectSnapshot(id), (value) => value.content)),
      publish: (request: PublishRequest) =>
        bind(
          Effect.gen(function* () {
            const store = yield* Store
            const location = yield* publicationId(request.operation_id)
            const existing = yield* store.readJson(
              `publications/${location.id}.json`,
              PublicationReceiptSchema,
            )
            if (existing) {
              if (
                request.resume_only &&
                (!request.expected ||
                  existing.page_id !== request.expected.page_id ||
                  existing.database_id !== request.target_database_id ||
                  existing.operation_id !== location.id ||
                  existing.operation !== "replace" ||
                  JSON.stringify(existing.context?.ownership) !== JSON.stringify(request.ownership))
              )
                return yield* Effect.fail(
                  fail(
                    "WRITE_CONFLICT",
                    "The retained publication differs from the original frozen apply request.",
                  ),
                )
              if (request.resume_only) {
                const files = []
                for (const file of existing.portable.files) {
                  const bytes = yield* store.readBytes(`objects/${file.sha256}`)
                  if ((yield* sha256(bytes)) !== file.sha256)
                    return yield* Effect.fail(
                      fail("STATE_CORRUPT", "An original apply object failed its frozen checksum."),
                    )
                  files.push({ path: file.path, bytes })
                }
                if (
                  (yield* portableIdentity({ ...existing.portable, files })) !==
                  request.ownership.published_hash
                )
                  return yield* Effect.fail(
                    fail(
                      "STATE_CORRUPT",
                      "The original publication bytes differ from the frozen apply hash.",
                    ),
                  )
              }
              if ((yield* portableIdentity(request.portable)) !== request.ownership.published_hash)
                return yield* Effect.fail(
                  fail("STATE_CORRUPT", "The frozen apply bytes differ from their published hash."),
                )
              const result = yield* reconcile(request.operation_id)
              if (result) return result
              const resumed = property(yield* resumePublication(location.id))
              const record = property(resumed.record)
              const id = property(record.locator).page_id
              if (typeof id !== "string")
                return yield* Effect.fail(
                  fail(
                    "PUBLICATION_UNRESOLVED",
                    "Resumed upstream publication returned no page identity.",
                  ),
                )
              return yield* verified(id, location.id)
            }
            if (request.resume_only)
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_UNRESOLVED",
                  "The original apply child is absent; no create or new publication was replayed.",
                ),
              )
            if ((yield* portableIdentity(request.portable)) !== request.ownership.published_hash)
              return yield* Effect.fail(
                fail(
                  "INVALID_UPSTREAM",
                  "Published Hash differs from the requested upstream content.",
                ),
              )
            const options = {
              database: request.target_database_id,
              operationId: location.id,
              ownership: request.ownership,
              source: { type: "upstream" as const },
              storage: "notion_blocks" as const,
              ...(request.allow_same_name ? { allowSameName: true as const } : {}),
              ...(request.default_context === undefined
                ? {}
                : { defaultContext: request.default_context }),
            }
            let raw: unknown
            if (request.expected) {
              const current = yield* inspectSnapshot(request.expected.page_id)
              if (
                current.content.version !== request.expected.version ||
                current.content.content_hash !== request.expected.hash
              )
                return yield* Effect.fail(
                  fail("WRITE_CONFLICT", "Upstream target changed since the frozen plan."),
                )
              if (
                !current.content.ownership ||
                current.content.ownership.subscription_id !== request.ownership.subscription_id ||
                current.content.ownership.member_key !== request.ownership.member_key
              )
                return yield* Effect.fail(
                  fail("WRITE_CONFLICT", "Upstream ownership differs from the frozen plan."),
                )
              raw = yield* replaceSkill(request.portable, {
                ...options,
                target: current.snapshot,
              }).pipe(Effect.provideService(PublicationReadOperation, location.id))
            } else raw = yield* createPortable(request.portable, options)
            const id = property(property(property(raw).record).locator).page_id
            if (typeof id !== "string")
              return yield* Effect.fail(
                fail(
                  "PUBLICATION_UNRESOLVED",
                  "Upstream publication returned no exact page identity.",
                ),
              )
            return yield* verified(id, location.id)
          }),
        ),
      reconcile,
      setMode: (request) =>
        bind(
          Effect.gen(function* () {
            const store = yield* Store
            const location = request.operation_id
              ? yield* publicationId(request.operation_id)
              : undefined
            const existing = location
              ? yield* store.readJson(`publications/${location.id}.json`, PublicationReceiptSchema)
              : undefined
            if (existing && location) {
              const intended = existing.context?.ownership
              if (
                existing.operation_id !== location.id ||
                existing.page_id !== request.page_id ||
                !intended ||
                intended.mode !== request.mode ||
                (request.fork_baseline !== undefined &&
                  JSON.stringify(intended.fork_baseline) !==
                    JSON.stringify(request.fork_baseline)) ||
                (request.published_hash !== undefined &&
                  intended.published_hash !== request.published_hash) ||
                (request.revision !== undefined && intended.revision !== request.revision)
              )
                return yield* Effect.fail(
                  fail("WRITE_CONFLICT", "The frozen mode child differs from its parent intent."),
                )
              const unsent =
                existing.intents.length === 0 &&
                (yield* proveUnsentModePublication(
                  existing,
                  request.expected_version,
                  (yield* inspectSnapshot(request.page_id)).content,
                ))
              const settled = unsent ? undefined : yield* reconcile(request.operation_id!)
              if (!settled)
                yield* recoverPublication(
                  location.id,
                  { modeOnly: true },
                  (_portable, id, database, session) =>
                    openSkill(id, { database, refresh: true }).pipe(
                      Effect.provideService(Notion, session.notion),
                      Effect.map(snapshotInfo),
                    ),
                )
              yield* verified(request.page_id, location.id)
              const actual = yield* inspectSnapshot(request.page_id)
              if (
                actual.content.ownership?.mode !== request.mode ||
                JSON.stringify(actual.content.ownership.fork_baseline) !==
                  JSON.stringify(request.fork_baseline ?? actual.content.ownership.fork_baseline) ||
                (request.published_hash !== undefined &&
                  actual.content.ownership.published_hash !== request.published_hash) ||
                (request.revision !== undefined &&
                  actual.content.ownership.revision !== request.revision)
              )
                return yield* Effect.fail(
                  fail(
                    "WRITE_CONFLICT",
                    "The saved mode transition differs from the requested state.",
                  ),
                )
              return
            }
            const current = yield* inspectSnapshot(request.page_id)
            if (current.content.version !== request.expected_version)
              return yield* Effect.fail(
                fail("WRITE_CONFLICT", "Content changed before the explicit mode transition."),
              )
            const owner = current.content.ownership
            if (!owner)
              return yield* Effect.fail(
                fail("INVALID_UPSTREAM", "Only a managed upstream item can change mode."),
              )
            if (request.mode === "fork" && !request.fork_baseline)
              return yield* Effect.fail(
                fail("INVALID_UPSTREAM", "Fork requires a recoverable baseline."),
              )
            if (request.fork_baseline) {
              const baseline = yield* readUpstreamBaseline(request.fork_baseline.portable_ref)
              if ((yield* portableIdentity(baseline)) !== request.fork_baseline.content_hash)
                return yield* Effect.fail(
                  fail(
                    "BASELINE_DIVERGED",
                    "Fork baseline does not match its committed content hash.",
                  ),
                )
            }
            if (
              request.published_hash !== undefined &&
              request.published_hash !== current.content.content_hash
            )
              return yield* Effect.fail(
                fail(
                  "WRITE_CONFLICT",
                  "An explicit tracked baseline must match the current complete content.",
                ),
              )
            const session = yield* beginPublication(current.content.portable, "write", {
              ...(location ? { operationId: location.id } : {}),
              source: { type: "upstream" },
              ownership: {
                ...owner,
                mode: request.mode,
                ...(request.published_hash !== undefined
                  ? { published_hash: request.published_hash }
                  : {}),
                ...(request.revision !== undefined ? { revision: request.revision } : {}),
                ...(request.fork_baseline ? { fork_baseline: request.fork_baseline } : {}),
              },
            })
            const locator = current.snapshot.record.locator
            if (locator.type !== "notion_page")
              return yield* Effect.fail(
                fail("INVALID_TARGET", "Mode transitions require a content page."),
              )
            yield* session.bind(
              {
                database_id: locator.database_id,
                data_source_id: locator.data_source_id,
                page_id: locator.page_id,
              },
              current.snapshot.scope,
            )
            yield* session.finish(
              Effect.gen(function* () {
                const latest = yield* inspectSnapshot(request.page_id)
                if (latest.content.version !== request.expected_version)
                  return yield* Effect.fail(
                    fail("WRITE_CONFLICT", "Content changed during mode transition preflight."),
                  )
                return { verified: true }
              }).pipe(Effect.provideService(Notion, session.notion)),
            )
          }),
        ),
      recoverableBaseline: (id, version, accepted) => bind(saveBaseline(id, version, accepted)),
      readBaseline: (ref) => bind(readUpstreamBaseline(ref)),
    }
  }),
)
/** Explicitly inspect a direct Notion edit without publishing it as a valid cached observation. */
export function inspectPublicationEdit(id: string) {
  return Effect.gen(function* () {
    const { snapshot, raw, content } = yield* inspectSnapshot(id)
    return {
      ...snapshotInfo(snapshot),
      version_id: content.version,
      publication: publicationMarker(raw),
      content_hash: content.content_hash,
      requires_acceptance: true,
      files: content.portable.files.map((file) => ({
        path: file.path,
        bytes: file.bytes.length,
        base64: Buffer.from(file.bytes).toString("base64"),
      })),
    }
  })
}

/** A maintainer accepts exactly the inspected revision; ordinary writes never clear divergence. */
export function acceptPublicationEdit(id: string, expectedVersion: string) {
  return Effect.gen(function* () {
    if (pageId(id) !== id || !expectedVersion)
      return yield* Effect.fail(
        fail(
          "EXACT_TARGET_REQUIRED",
          "Accepting a direct edit requires its exact page UUID and inspected version.",
        ),
      )
    const inspected = yield* inspectSnapshot(id)
    const current = inspected.snapshot
    if (inspected.content.version !== expectedVersion)
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The direct Notion edit differs from the inspected version."),
      )
    if (current.record.locator.type !== "notion_page")
      return yield* Effect.fail(
        fail("EXACT_TARGET_REQUIRED", "Only content pages can accept a direct edit."),
      )
    const portable = yield* snapshotPortable(current)
    const session = yield* beginPublication(portable, "write")
    yield* session.bind(
      {
        database_id: current.record.locator.database_id,
        data_source_id: current.record.locator.data_source_id,
        page_id: id,
      },
      current.scope,
    )
    return yield* session.finish(
      Effect.gen(function* () {
        const latestInspection = yield* inspectSnapshot(id)
        const latest = latestInspection.snapshot
        if (
          latestInspection.content.version !== expectedVersion ||
          (yield* portableIdentity(yield* snapshotPortable(latest))) !==
            (yield* portableIdentity(portable))
        )
          return yield* Effect.fail(
            fail("WRITE_CONFLICT", "The direct Notion edit changed before acceptance."),
          )
        yield* session.run(
          "accept-direct-edit",
          session.notion.request(`v1/pages/${id}`, { properties: {} }, { method: "PATCH" }),
        )
        return { ...snapshotInfo(latest), accepted: true, verified: true }
      }).pipe(Effect.provideService(Notion, session.notion)),
    )
  })
}
