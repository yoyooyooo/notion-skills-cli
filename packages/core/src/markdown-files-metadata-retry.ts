import { Effect } from "effect"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import type { Receipt } from "./publication-model.ts"
import { canonical, observation } from "./publication-observation.ts"
import { publicationMarker, PublicationReadOperation } from "./publication-integrity.ts"
import { unresolvedIntent } from "./publication-upload.ts"
import { openSkill } from "./snapshot.ts"
import { portableIdentity, snapshotAuthoredPortable } from "./export.ts"
import { sha256, Store } from "./store.ts"
import {
  bindPublicationSource,
  isPublicationMetadataIntent,
  publicationGuardComparison,
} from "./publication-source.ts"

export interface EditableMetadataRetry {
  readonly path: string
  readonly body: unknown
}

/** The caller holds the publication lock and has checked credential scope and
 * process ownership. This opt-in can never retry append/create/upload requests. */
export function retryEditableMetadata(receipt: Receipt, api: Notion["Service"]) {
  return Effect.gen(function* () {
    const index = receipt.intents.length - 1,
      intent = receipt.intents[index]
    const path = `v1/pages/${receipt.page_id}`,
      body = property(intent?.body)
    if (
      !receipt.context?.markdown_files ||
      receipt.conflict ||
      !receipt.page_id ||
      !intent ||
      intent.path !== path ||
      intent.method !== "PATCH" ||
      Object.keys(body).join() !== "properties" ||
      receipt.intents
        .slice(0, index)
        .some(
          (item) =>
            unresolvedIntent(item) ||
            (item.status !== "completed" && item.recovery?.kind !== "idempotent_metadata"),
        ) ||
      !(unresolvedIntent(intent) || intent.recovery?.kind === "idempotent_metadata") ||
      (intent.recovery && intent.recovery.kind !== "idempotent_metadata")
    )
      return yield* Effect.fail(
        fail(
          "PUBLICATION_UNRESOLVED",
          "Select one original terminal editable-file ownership or commit request.",
        ),
      )
    const fields = property(body.properties)
    if (
      !isPublicationMetadataIntent(receipt, intent) &&
      Object.keys(fields).join() !== "Publication"
    )
      return yield* Effect.fail(
        fail("PUBLICATION_UNRESOLVED", "The request is not exact frozen publication metadata."),
      )
    const store = yield* Store
    const integrity = yield* store.integrity.inspect(receipt.operation_id)
    const commit =
      Object.keys(fields).join() === "Publication"
        ? publicationMarker({
            properties: { Publication: { type: "rich_text", ...property(fields.Publication) } },
          })
        : undefined
    if (
      !isPublicationMetadataIntent(receipt, intent) &&
      (!commit ||
        commit.state !== "committed" ||
        canonical(commit) !== canonical(integrity?.marker))
    )
      return yield* Effect.fail(
        fail(
          "PUBLICATION_UNRESOLVED",
          "The original metadata request is not its exact ownership or durable commit.",
        ),
      )
    if (receipt.data_source_id) yield* bindPublicationSource(receipt, receipt.data_source_id, api)
    const root = yield* api.request(path),
      marker = publicationMarker(root)
    if (
      !integrity ||
      marker?.operation_id !== receipt.operation_id ||
      marker.intended_hash !== integrity.intended_hash ||
      !receipt.guards[path] ||
      typeof receipt.guards[path + "/markdown"] !== "string"
    )
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The original publication marker or source authority changed."),
      )
    for (const [guard, expected] of Object.entries(receipt.guards))
      if (
        publicationGuardComparison(
          receipt,
          guard,
          observation(guard, yield* api.request(guard)),
        ) !== publicationGuardComparison(receipt, guard, expected)
      )
        return yield* Effect.fail(
          fail("WRITE_CONFLICT", "The original metadata retry guard changed.", { path: guard }),
        )
    const snapshot = yield* openSkill(receipt.page_id, {
      database: receipt.database_id,
      refresh: true,
    }).pipe(
      Effect.provideService(PublicationReadOperation, receipt.operation_id),
      Effect.provideService(Notion, api),
    )
    const files = yield* Effect.forEach(receipt.portable.files, (file) =>
      Effect.gen(function* () {
        const bytes = yield* store.readBytes(`objects/${file.sha256}`)
        if ((yield* sha256(bytes)) !== file.sha256)
          return yield* Effect.fail(fail("STATE_CORRUPT", "Frozen metadata-retry source changed."))
        return { path: file.path, bytes }
      }),
    )
    if (
      (yield* portableIdentity({ ...receipt.portable, files })) !==
      (yield* portableIdentity(yield* snapshotAuthoredPortable(snapshot)))
    )
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "Live editable files differ from the original metadata source."),
      )
    if (
      publicationGuardComparison(receipt, path, observation(path, yield* api.request(path))) !==
      publicationGuardComparison(receipt, path, receipt.guards[path])
    )
      return yield* Effect.fail(
        fail("PUBLICATION_CHANGED", "Metadata changed during retry verification."),
      )
    // The original request stays unknown. This certificate excludes only its
    // idempotent field assignment from unresolved effects, never its history.
    intent.recovery = {
      kind: "idempotent_metadata",
      replacement_suboperation_id: `${receipt.operation_id}:metadata:${index + 1}`,
    }
    yield* store.writeJson(`publications/${receipt.operation_id}.json`, receipt)
    return { path, body: intent.body }
  })
}
