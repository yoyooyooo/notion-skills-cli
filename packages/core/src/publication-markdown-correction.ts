import { Effect } from "effect"
import { authScope, explicitSource } from "./catalog.ts"
import { importDocument } from "./import.ts"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import {
  PublicationReceiptSchema,
  type Receipt,
  type ObservedMarkdownCorrectionCheckpoint,
} from "./publication-model.ts"
import { publicationMarkerAuthority } from "./publication-effect-proof.ts"
import { publicationMarker, verifyCreatedPublicationPage } from "./publication-integrity.ts"
import { metadata, observation, publicationPropertiesMatch } from "./publication-observation.ts"
import { pageMarkdown, rewritePageLinks } from "./references.ts"
import { normalizePath } from "./ref.ts"
import { Store, sha256 } from "./store.ts"
import {
  correctionCanonical,
  correctionHash,
  originalObservedMarkdownCorrectionCandidate,
  recordedObservedMarkdownCorrection,
} from "./publication-markdown-history.ts"

const refused = (message: string) =>
  Effect.fail(fail("PUBLICATION_MARKDOWN_CORRECTION_UNPROVEN", message))

/** Fresh GET-only proof. The initial phase records a wrong derived observation;
 * the replay phase repeats every proof before the one original request is sent.
 * Neither phase changes a receipt, source, marker, guard or remote resource. */
export function proveObservedMarkdownNoEffect(
  receipt: Receipt,
  transport: Notion["Service"],
  phase: "initial" | "replay",
) {
  return Effect.gen(function* () {
    const original = structuredClone(receipt)
    const recorded = phase === "replay" ? recordedObservedMarkdownCorrection(original) : undefined
    const candidate =
      phase === "initial"
        ? originalObservedMarkdownCorrectionCandidate(original)
        : original.intents.length === 3 && !original.conflict
          ? recorded?.candidate
          : undefined
    if (!candidate)
      return yield* refused(
        "The original derived observation is outside the bounded empty-page correction.",
      )
    const retained = correctionCanonical(original)
    const key = `publications/${original.operation_id}.json`
    const store = yield* Store
    const readApi: Notion["Service"] = {
      ...transport,
      request: (path, body, options) => {
        if (
          body !== undefined ||
          options?.file !== undefined ||
          (options?.method !== undefined && options.method !== "GET")
        )
          return refused("Observed Markdown correction proof permits GET requests only.")
        return transport.request(path, undefined, { method: "GET" })
      },
    }
    const checkLocal = () =>
      Effect.gen(function* () {
        const current = yield* store.readJson(key, PublicationReceiptSchema)
        if (
          !current ||
          correctionCanonical(current) !== retained ||
          correctionCanonical(receipt) !== retained
        )
          return yield* refused("The original receipt changed during the no-effect proof.")
        const integrity = yield* store.integrity.inspect(original.operation_id)
        if (
          !integrity ||
          integrity.operation_id !== original.operation_id ||
          integrity.marker.state !== "writing"
        )
          return yield* refused("The original writing ledger is missing or changed.")
        const files: { path: string; bytes: Uint8Array }[] = []
        const entries: Array<readonly [string, number, string]> = []
        const paths = new Set<string>()
        for (const file of [...original.portable.files].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        )) {
          if (
            !file.path ||
            normalizePath(file.path) !== file.path ||
            paths.has(file.path) ||
            !/^[a-f0-9]{64}$/.test(file.sha256)
          )
            return yield* refused("Original frozen file paths or hashes are invalid.")
          paths.add(file.path)
          const bytes = yield* store.readBytes(`objects/${file.sha256}`)
          if ((yield* sha256(bytes)) !== file.sha256)
            return yield* refused("An original frozen source object changed.")
          files.push({ path: file.path, bytes })
          entries.push([file.path, bytes.length, file.sha256])
        }
        const main = files.find((file) => file.path === original.portable.main)
        if (!main) return yield* refused("The original main source is missing.")
        const intended = yield* sha256(
          correctionCanonical([
            original.portable.kind,
            original.portable.name,
            original.portable.description,
            original.portable.main,
            entries,
          ]),
        )
        if (
          intended !== integrity.intended_hash ||
          (recorded && recorded.checkpoint.intended_hash !== intended)
        )
          return yield* refused(
            "Frozen source bytes no longer match the original intended identity.",
          )
        const document = yield* Effect.try({
          try: () =>
            importDocument(main, {
              name: original.portable.name,
              description: original.portable.description,
            }),
          catch: () =>
            fail(
              "PUBLICATION_MARKDOWN_CORRECTION_UNPROVEN",
              "The original main source is invalid.",
            ),
        })
        const target = rewritePageLinks(
          document.body,
          original.portable.main,
          [
            {
              id: candidate.page_id,
              path: original.portable.main,
              markdown: "",
            },
          ],
          "notion",
        )
        if (target !== candidate.target)
          return yield* refused(
            "The retained whole-body request differs from its complete frozen source.",
          )
        return {
          integrity,
          source_sha256: yield* sha256(main.bytes),
          target_sha256: yield* sha256(target),
        }
      })
    const localBefore = yield* checkLocal()
    const scope = yield* authScope.pipe(Effect.provideService(Notion, readApi))
    const source = yield* explicitSource(original.database_id!).pipe(
      Effect.provideService(Notion, readApi),
    )
    if (scope !== original.scope || !source.data_source_ids.includes(candidate.data_source_id))
      return yield* refused("The original credential or database binding changed.")
    const before = yield* readApi.request(candidate.rootPath)
    const beforeMetadata = metadata(before)
    if (
      correctionCanonical(beforeMetadata) !==
        correctionCanonical(original.guards[candidate.rootPath]) ||
      !publicationMarkerAuthority(original, before, localBefore.integrity, publicationMarker)
    )
      return yield* refused("The original root metadata, revision or marker authority changed.")
    for (const field of Object.values(property(property(before).properties)).map(property)) {
      if (
        field.has_more === true ||
        (field.type === "files" && (!Array.isArray(field.files) || field.files.length !== 0))
      )
        return yield* refused("The original empty page has an incomplete property or attachment.")
    }
    const created = original.intents[0],
      registered = original.intents[1]
    if (!created || !registered) return yield* refused("Original page requests are missing.")
    yield* verifyCreatedPublicationPage(before, created.body)
    if (!publicationPropertiesMatch(before, property(registered.body).properties))
      return yield* refused("The original empty References request is no longer current.")
    const body = yield* readApi.request(candidate.bodyPath)
    if (pageMarkdown(body) !== "")
      return yield* refused("The current body is not the retained empty preimage.")
    const inventory = yield* readApi.request(candidate.inventoryPath)
    const roots = property(inventory)
    if (
      !Array.isArray(roots.results) ||
      roots.results.length !== 0 ||
      roots.has_more !== false ||
      roots.next_cursor !== null
    )
      return yield* refused("The complete root inventory is no longer empty.")
    const references = yield* readApi.request(candidate.referencesPath)
    const items = property(references)
    if (
      !Array.isArray(items.results) ||
      items.results.length !== 0 ||
      items.has_more !== false ||
      items.next_cursor !== null
    )
      return yield* refused("The complete References property is no longer empty.")
    const raw = {
      [candidate.rootPath]: before,
      [candidate.bodyPath]: body,
      [candidate.inventoryPath]: inventory,
      [candidate.referencesPath]: references,
    }
    for (const [path, expected] of Object.entries(original.guards))
      if (
        !(path in raw) ||
        correctionCanonical(observation(path, raw[path])) !== correctionCanonical(expected)
      )
        return yield* refused("An original retained guard changed during the empty-page proof.")
    const after = yield* readApi.request(candidate.rootPath)
    const afterMetadata = metadata(after)
    const localAfter = yield* checkLocal()
    if (
      correctionCanonical(afterMetadata) !== correctionCanonical(beforeMetadata) ||
      correctionCanonical(localAfter) !== correctionCanonical(localBefore) ||
      !publicationMarkerAuthority(original, after, localAfter.integrity, publicationMarker)
    )
      return yield* refused("Remote or local authority changed across the complete proof.")
    const evidence: ObservedMarkdownCorrectionCheckpoint = {
      version: 1,
      operation_id: original.operation_id,
      page_id: candidate.page_id,
      scope: original.scope!,
      database_id: original.database_id!,
      data_source_id: candidate.data_source_id,
      intended_hash: localBefore.integrity.intended_hash,
      original_intent_count: 3,
      original_journal_sha256: correctionHash(original.intents),
      original_guards: structuredClone(original.guards),
      original_guards_sha256: correctionHash(original.guards),
      original_portable_sha256: correctionHash(original.portable),
      original_context_sha256: correctionHash(original.context),
      original_receipt_sha256: correctionHash(original),
      integrity_sha256: correctionHash(localBefore.integrity),
      source_sha256: localBefore.source_sha256,
      target_sha256: localBefore.target_sha256,
      metadata_before_sha256: correctionHash(beforeMetadata),
      metadata_after_sha256: correctionHash(afterMetadata),
      inventory_sha256: correctionHash(inventory),
      references_sha256: correctionHash(references),
    }
    return { candidate, evidence }
  }).pipe(
    Effect.catchDefect((error) =>
      Effect.fail(
        error instanceof SkillsError
          ? error
          : fail(
              "PUBLICATION_MARKDOWN_CORRECTION_UNPROVEN",
              "Original no-effect evidence could not be proved.",
            ),
      ),
    ),
  )
}
