import { Clock, Effect } from "effect"
import { fail, property, text } from "./model.ts"
import { Notion } from "./notion.ts"
import type { Receipt } from "./publication-model.ts"
import { publicationMarker, verifyCreatedPublicationPage } from "./publication-integrity.ts"
import { pageMarkdown } from "./references.ts"
import { markdownIdentity } from "./markdown.ts"
import { Store } from "./store.ts"
import { authScope, explicitSource } from "./catalog.ts"
import type { CreationDiscovery } from "./publication-create-identity.ts"
import {
  creationMarker,
  creationMarkerProof,
  creationProofFromBody,
  creationProofMatchesIntent,
} from "./publication-create-identity.ts"

const canonical = (value: unknown) => JSON.stringify(value)
export function discoverPublicationCreate(receipt: Receipt, index: number) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const scope = yield* authScope
    if (scope !== receipt.scope || !receipt.database_id || !receipt.data_source_id)
      return yield* Effect.fail(
        fail(
          "PUBLICATION_SCOPE_MISMATCH",
          "Create discovery belongs to another authentication scope.",
        ),
      )
    const source = yield* explicitSource(receipt.database_id)
    if (!source.data_source_ids.includes(receipt.data_source_id))
      return yield* Effect.fail(
        fail("PUBLICATION_SOURCE_MISMATCH", "Create discovery source authority changed."),
      )
    const intent = receipt.intents[index]!
    if (!intent || intent.path !== "v1/pages" || intent.method !== "POST")
      return yield* Effect.fail(
        fail("PUBLICATION_UNRESOLVED", "Discovery requires an original page-create intent."),
      )
    const parent = property(property(intent.body).parent)
    const parentId = parent.page_id
    if (
      typeof parentId === "string"
        ? parentId !== receipt.page_id ||
          !receipt.portable.files.some((file) => {
            const proof = creationProofFromBody(intent.body)
            const title = text(property(property(property(intent.body).properties).title).title)
            return proof
              ? creationProofMatchesIntent(proof, receipt, index) &&
                  file.path === proof.path &&
                  file.sha256 === proof.source_sha256
              : file.path === `references/${title}`
          })
        : parent.data_source_id !== receipt.data_source_id
    )
      return yield* Effect.fail(
        fail(
          "PUBLICATION_SOURCE_MISMATCH",
          "Original create parent or source path differs from its bound publication.",
        ),
      )
    const proof = creationProofFromBody(intent.body)
    const integrity = yield* (yield* Store).integrity.inspect(receipt.operation_id)
    if (!integrity || (proof && proof.intended_hash !== integrity.intended_hash))
      return yield* Effect.fail(
        fail("PUBLICATION_UNRESOLVED", "Creation identity has no matching retained intended hash."),
      )
    if (proof && !creationProofMatchesIntent(proof, receipt, index))
      return yield* Effect.fail(
        fail("PUBLICATION_UNRESOLVED", "Creation identity differs from its original bound intent."),
      )
    const role = typeof parentId === "string" ? ("reference" as const) : ("content_root" as const)
    const evidence: { -readonly [K in keyof CreationDiscovery]: CreationDiscovery[K] } = {
      intent_index: index,
      operation_id: receipt.operation_id,
      scope,
      database_id: receipt.database_id,
      data_source_id: receipt.data_source_id,
      observed_at_ms: yield* Clock.currentTimeMillis,
      role,
      marker_kind: proof
        ? "creation_v1"
        : role === "reference"
          ? "legacy_operation"
          : "publication_v2",
      parent_id: String(parentId ?? parent.data_source_id),
      ...(proof ? { path: proof.path, operation_token: proof.operation_token } : {}),
      complete: false,
      candidate_count: 0,
      candidate_page_ids: [] as string[],
      outcome: "unknown" as "unknown" | "unique",
      reason: "No exact marker candidates; replay remains forbidden.",
    }
    const inventories: Record<string, unknown> = {}
    const queryObservations: Record<string, unknown> = {}
    const candidates: Array<{
      id: string
      raw: unknown
      markdown: string
      children: Record<string, unknown>
    }> = []
    const list = (base: string) =>
      Effect.gen(function* () {
        const rows: unknown[] = []
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          const path = `${base}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`
          const raw = yield* api.request(path)
          const value = property(raw)
          if (!Array.isArray(value.results) || typeof value.has_more !== "boolean")
            return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid creation child inventory."))
          inventories[path] = raw
          rows.push(...value.results)
          if (!value.has_more) break
          if (typeof value.next_cursor !== "string" || seen.has(value.next_cursor))
            return yield* Effect.fail(
              fail("INVALID_RESPONSE", "Incomplete creation child inventory pagination."),
            )
          cursor = value.next_cursor
          seen.add(cursor)
        } while (cursor)
        return rows
      })
    if (role === "reference") {
      const children = property(intent.body).children
      const savedMarker = Array.isArray(children)
        ? text(property(property(children[0]).paragraph).rich_text)
        : ""
      if (
        !savedMarker ||
        (!proof && savedMarker !== `ntn-skills-operation:${receipt.operation_id}:${index}`)
      ) {
        evidence.reason =
          "Original child request has no exact operation correlation; explicit external create evidence is required."
        return { evidence, inventories, queryObservations, candidate: undefined }
      }
      const rows = yield* list(`v1/blocks/${parentId}/children?page_size=100`)
      for (const row of rows.map(property)) {
        if (row.type !== "child_page" || typeof row.id !== "string") continue
        const markdown = pageMarkdown(yield* api.request(`v1/pages/${row.id}/markdown`))
        const actualProof = creationMarkerProof(markdown)
        const matches = proof
          ? actualProof &&
            canonical(actualProof) === canonical(proof) &&
            markdownIdentity(markdown) === markdownIdentity(creationMarker(proof))
          : markdownIdentity(markdown) === markdownIdentity(savedMarker)
        if (!matches) continue
        const raw = yield* api.request(`v1/pages/${row.id}`)
        const value = property(raw)
        if (
          property(value.parent).page_id !== parentId ||
          value.in_trash ||
          value.archived ||
          value.is_archived
        )
          continue
        yield* verifyCreatedPublicationPage(raw, intent.body)
        const childRows = yield* list(`v1/blocks/${row.id}/children?page_size=100`)
        if (childRows.some((item) => property(item).type === "child_page"))
          return yield* Effect.fail(
            fail("WRITE_CONFLICT", "Unknown reference was edited before reconciliation."),
          )
        candidates.push({
          id: row.id,
          raw,
          markdown,
          children: Object.fromEntries(
            Object.entries(inventories).filter(([path]) => path.startsWith(`v1/blocks/${row.id}/`)),
          ),
        })
      }
    } else {
      const marker = publicationMarker({
        properties: {
          Publication: {
            type: "rich_text",
            ...property(property(property(intent.body).properties).Publication),
          },
        },
      })
      if (!marker) {
        evidence.reason =
          "Original root request has no writing marker; explicit external create evidence is required."
        return { evidence, inventories, queryObservations, candidate: undefined }
      }
      if (
        marker.operation_id !== receipt.operation_id ||
        marker.intended_hash !== integrity.intended_hash
      )
        return yield* Effect.fail(
          fail(
            "PUBLICATION_UNRESOLVED",
            "Root writing marker differs from the original intended revision.",
          ),
        )
      const matches: unknown[] = []
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const request = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }
        const queryPath = `v1/data_sources/${receipt.data_source_id}/query`
        const result = property(yield* api.request(queryPath, request))
        queryObservations[
          `${queryPath}${cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : ""}`
        ] = { method: "POST", path: queryPath, body: request, response: result }
        if (!Array.isArray(result.results) || typeof result.has_more !== "boolean")
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "Invalid exact source creation query."),
          )
        for (const raw of result.results) {
          const value = property(raw)
          if (
            typeof value.id !== "string" ||
            value.in_trash ||
            value.archived ||
            value.is_archived ||
            property(value.parent).data_source_id !== receipt.data_source_id
          )
            continue
          const rich = property(property(value.properties).Publication).rich_text
          // Other rows may have independent proof versions. Only this exact operation is a candidate.
          if (!Array.isArray(rich) || !text(rich).includes(receipt.operation_id)) continue
          if (canonical(publicationMarker(raw)) === canonical(marker)) matches.push(raw)
        }
        if (!result.has_more) break
        if (typeof result.next_cursor !== "string" || seen.has(result.next_cursor))
          return yield* Effect.fail(
            fail("INVALID_RESPONSE", "Incomplete exact source creation query pagination."),
          )
        cursor = result.next_cursor
        seen.add(cursor)
      } while (cursor)
      if (matches.length !== 1) {
        evidence.complete = true
        evidence.candidate_count = matches.length
        evidence.candidate_page_ids = matches.map((raw) => String(property(raw).id))
        if (matches.length > 1)
          evidence.reason =
            "Multiple exact marker candidates; adoption and replay remain forbidden."
        return { evidence, inventories, queryObservations, candidate: undefined }
      }
      for (const raw of matches) {
        yield* verifyCreatedPublicationPage(raw, intent.body)
        const id = String(property(raw).id)
        const markdown = pageMarkdown(yield* api.request(`v1/pages/${id}/markdown`))
        const children = yield* list(`v1/blocks/${id}/children?page_size=100`)
        if (markdownIdentity(markdown) !== markdownIdentity("") || children.length)
          return yield* Effect.fail(
            fail("WRITE_CONFLICT", "Unknown root was edited before reconciliation.", {
              page_id: id,
            }),
          )
        candidates.push({
          id,
          raw,
          markdown,
          children: Object.fromEntries(
            Object.entries(inventories).filter(([path]) => path.startsWith(`v1/blocks/${id}/`)),
          ),
        })
      }
    }
    evidence.complete = true
    evidence.candidate_count = candidates.length
    evidence.candidate_page_ids = candidates.map((candidate) => candidate.id)
    if (candidates.length === 1) {
      evidence.outcome = "unique"
      evidence.reason =
        "Complete exact-source discovery proves one original create; original guards still apply."
    } else if (candidates.length > 1)
      evidence.reason = "Multiple exact marker candidates; adoption and replay remain forbidden."
    return {
      evidence,
      inventories,
      queryObservations,
      candidate: candidates.length === 1 ? candidates[0] : undefined,
    }
  })
}
