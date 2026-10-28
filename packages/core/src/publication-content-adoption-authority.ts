import { Effect, Schema } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { PublicationMarkerSchema, IntegrityIntentSchema } from "./publication-integrity-state.ts"
import type { PublicationMarker } from "./publication-integrity-state.ts"
import type { Receipt } from "./publication-model.ts"
import {
  UpstreamPlanSchema,
  UpstreamOperationSchema,
  FrozenPortableSchema,
} from "./upstream-model.ts"
import { Store, sha256 } from "./store.ts"
import { canonical } from "./publication-effect-proof.ts"
import { contentAdoptionSourceJournal } from "./publication-content-adoption-source.ts"
import {
  ContentAdoptionDescriptionMigrationSchema,
  DescriptionFinalLfMigration,
  contentAdoptionDescriptionProperties,
} from "./publication-content-adoption-description.ts"
import { publicationMetadataProperties } from "./publication-source.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Page = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
)
const Publication = Schema.String.check(Schema.isPattern(/^p_[a-zA-Z0-9-]{1,100}$/))
export const ContentAdoptionInputSchema = Schema.Struct({
  original_plan_id: Schema.String,
  member_key: Schema.String,
  page_id: Page,
  old_operation_id: Publication,
  install_source_bundle: Schema.optional(Schema.Literal(true)),
  descriptor_migration: Schema.optional(Schema.Literal(DescriptionFinalLfMigration)),
})
export type ContentAdoptionInput = typeof ContentAdoptionInputSchema.Type
export const ContentAdoptionOwnershipSchema = Schema.Struct({
  subscription_id: Page,
  member_key: Schema.String,
  mode: Schema.Literal("tracked"),
  published_hash: Hash,
  revision: Schema.String,
})
export const ContentAdoptionEvidenceSchema = Schema.Struct({
  raw: Schema.Record(Schema.String, Schema.Unknown),
  files: Schema.Array(Schema.Struct({ path: Schema.String, bytes: Schema.Number, sha256: Hash })),
  attachments: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      name: Schema.String,
      bytes: Schema.Number,
      sha256: Hash,
    }),
  ),
  page_ids: Schema.Array(Page),
  graph_sha256: Hash,
  source_proof: Schema.optional(Schema.Literals(["not_installed", "verified"])),
})
export type ContentAdoptionEvidence = typeof ContentAdoptionEvidenceSchema.Type
export const ContentAdoptionSourceInstallationSchema = Schema.Struct({
  version: Schema.Literal(1),
  property_name: Schema.Literal("Files"),
  property_id: Schema.String,
  filename: Schema.Literal("ntn-skills-source.zip"),
  sha256: Hash,
  byte_length: Schema.Number,
})
export type ContentAdoptionSourceInstallation = typeof ContentAdoptionSourceInstallationSchema.Type
export const ContentAdoptionPlanSchema = Schema.Struct({
  format: Schema.Literal(1),
  domain: Schema.Literal("content_adoption"),
  plan_id: Schema.String,
  plan_hash: Hash,
  original_plan: UpstreamPlanSchema,
  original_operation: UpstreamOperationSchema,
  item_index: Schema.Number,
  original_publication_id: Publication,
  original_integrity: IntegrityIntentSchema,
  old_operation_id: Publication,
  old_marker: PublicationMarkerSchema,
  old_history: Schema.Literal("absent_in_current_database"),
  page_id: Page,
  database_id: Page,
  data_source_id: Page,
  scope: Hash,
  frozen: FrozenPortableSchema,
  intended_hash: Hash,
  ownership: ContentAdoptionOwnershipSchema,
  evidence: ContentAdoptionEvidenceSchema,
  source_installation: Schema.optional(ContentAdoptionSourceInstallationSchema),
  descriptor_migration: Schema.optional(ContentAdoptionDescriptionMigrationSchema),
  new_operation_id: Publication,
})
export type ContentAdoptionPlan = typeof ContentAdoptionPlanSchema.Type
export const ContentAdoptionAttemptSchema = Schema.Struct({
  plan: ContentAdoptionPlanSchema,
  state: Schema.Literals(["planned", "applying", "publication_committed", "linked"]),
})
export type ContentAdoptionAttempt = typeof ContentAdoptionAttemptSchema.Type
export const contentAdoptionPlanKey = (id: string) => `content-adoption:plan:${id}`
export const contentAdoptionMemberKey = (id: string, index: number) =>
  `content-adoption:member:${id}:${index}`
export const contentAdoptionPublicationKey = (id: string) => `content-adoption:publication:${id}`
export const adoptionRefusal = (message: string, details?: unknown) =>
  fail("CONTENT_ADOPTION_REFUSED", message, details)
export const adoptionTry = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : adoptionRefusal("Content adoption evidence is invalid."),
  })

export function contentAdoptionWriting(plan: ContentAdoptionPlan): PublicationMarker {
  if (plan.old_marker.state !== "writing")
    throw adoptionRefusal("The retained old marker is not writing.")
  return {
    ...plan.old_marker,
    operation_id: plan.new_operation_id,
    intended_hash: plan.intended_hash,
  }
}
export function contentAdoptionOwnershipProperties(plan: {
  readonly ownership: ContentAdoptionPlan["ownership"]
}) {
  const rich = (content: string) => ({ rich_text: [{ type: "text", text: { content } }] })
  return {
    Upstream: { relation: [{ id: plan.ownership.subscription_id }] },
    "Sync Mode": { select: { name: "tracked" } },
    "Upstream Key": rich(plan.ownership.member_key),
    "Upstream Revision": rich(plan.ownership.revision),
    "Published Hash": rich(plan.ownership.published_hash),
    "Fork Baseline": rich(""),
  }
}
export function contentAdoptionMarkerBody(marker: PublicationMarker) {
  // The durable schema orders keys differently from commitPublicationIntegrity.
  // Reconstruct that exact native request string; all marker values stay bound.
  const serialized =
    marker.state === "committed"
      ? {
          version: marker.version,
          state: marker.state,
          operation_id: marker.operation_id,
          intended_hash: marker.intended_hash,
          revision: marker.revision,
          manifest_hash: marker.manifest_hash,
          ownership_hash: marker.ownership_hash,
          ...(marker.creation ? { creation: marker.creation } : {}),
        }
      : marker
  return {
    properties: {
      Publication: { rich_text: [{ type: "text", text: { content: JSON.stringify(serialized) } }] },
    },
  }
}
/** One existing handoff effect owns both requested property values. Its journal,
 * mutation authority and sender must agree on this exact combined request. */
export function contentAdoptionHandoffBody(plan: ContentAdoptionPlan) {
  const body = contentAdoptionMarkerBody(contentAdoptionWriting(plan))
  return plan.descriptor_migration
    ? {
        properties: {
          ...body.properties,
          ...contentAdoptionDescriptionProperties(plan.descriptor_migration),
        },
      }
    : body
}
export function loadContentAdoptionPlan(reference: {
  readonly plan_id: string
  readonly plan_hash: string
}) {
  return Effect.gen(function* () {
    const store = yield* Store
    const attempt = yield* Schema.decodeUnknownEffect(ContentAdoptionAttemptSchema)(
      yield* store.upstream.command(contentAdoptionPlanKey(reference.plan_id)),
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(() => adoptionRefusal("The durable adoption plan is missing or invalid.")),
    )
    const plan = attempt.plan
    if (plan.descriptor_migration && !plan.source_installation)
      return yield* Effect.fail(
        adoptionRefusal(
          "The explicit Description migration requires original source installation.",
        ),
      )
    const { plan_hash: _hash, plan_id: _id, ...body } = plan
    if (
      plan.plan_id !== reference.plan_id ||
      plan.plan_hash !== reference.plan_hash ||
      plan.plan_id !== `ca_${plan.plan_hash}` ||
      (yield* sha256(canonical(body))) !== plan.plan_hash
    )
      return yield* Effect.fail(adoptionRefusal("The adoption plan digest changed."))
    const member = property(
      yield* store.upstream.command(
        contentAdoptionMemberKey(plan.original_plan.plan_id, plan.item_index),
      ),
    )
    const publication = property(
      yield* store.upstream.command(contentAdoptionPublicationKey(plan.new_operation_id)),
    )
    if (member.plan_id !== plan.plan_id || publication.plan_id !== plan.plan_id)
      return yield* Effect.fail(adoptionRefusal("The single adoption attempt identity changed."))
    return attempt
  })
}

export interface ContentAdoptionJournal {
  readonly completed: number
  readonly pending_index?: number
  readonly pending_effect?: number
  readonly pending_kind?: "property" | "allocation" | "send" | "attachment"
  readonly retry_index?: number
}
/** Ordinary adoption has three root property effects. The explicit source
 * installation contract adds its one frozen allocation, send and attachment.
 * A failed unknown retains its original row before the exact real retry. */
export function contentAdoptionJournal(
  receipt: Receipt,
  plan: ContentAdoptionPlan,
  committed: PublicationMarker | undefined,
): ContentAdoptionJournal | undefined {
  const reference = receipt.context?.content_adoption
  if (
    !reference ||
    reference.plan_id !== plan.plan_id ||
    reference.plan_hash !== plan.plan_hash ||
    receipt.operation !== "replace" ||
    receipt.operation_id !== plan.new_operation_id ||
    receipt.page_id !== plan.page_id ||
    receipt.scope !== plan.scope ||
    receipt.database_id !== plan.database_id ||
    receipt.data_source_id !== plan.data_source_id ||
    receipt.context?.write_path !== undefined ||
    receipt.context.members !== undefined ||
    canonical(receipt.context.ownership) !== canonical(plan.ownership) ||
    canonical(receipt.portable) !==
      canonical({
        ...plan.frozen,
        files: plan.frozen.files.map((file) => ({ path: file.path, sha256: file.hash })),
      })
  )
    return undefined
  const bodies: unknown[] = [
    contentAdoptionHandoffBody(plan),
    { properties: publicationMetadataProperties(receipt) },
  ]
  if (
    committed?.state === "committed" &&
    committed.operation_id === plan.new_operation_id &&
    committed.intended_hash === plan.intended_hash &&
    canonical(committed.creation) === canonical(plan.old_marker.creation)
  )
    bodies.push(contentAdoptionMarkerBody(committed))
  if (plan.source_installation) return contentAdoptionSourceJournal(receipt, plan, bodies)
  if (plan.evidence.source_proof !== undefined) return undefined
  let completed = 0
  for (let index = 0; index < receipt.intents.length; index++) {
    const intent = receipt.intents[index]!
    if (
      completed >= bodies.length ||
      intent.path !== `v1/pages/${plan.page_id}` ||
      intent.method !== "PATCH" ||
      intent.recovery ||
      intent.artifact ||
      intent.list_start_repair ||
      intent.typed_links ||
      !intent.guards ||
      !intent.guards[intent.path] ||
      typeof intent.guards[intent.path + "/markdown"] !== "string" ||
      canonical(intent.body) !== canonical(bodies[completed])
    )
      return undefined
    if (intent.status === "completed") {
      const response = property(intent.response)
      if (
        response.id !== plan.page_id ||
        response.superseded_by !== undefined ||
        response.replayed_by_intent !== undefined ||
        (response.recovery !== undefined && response.recovery !== "observed_applied")
      )
        return undefined
      completed++
      continue
    }
    if (intent.status === "failed") {
      const response = property(intent.response)
      if (
        response.recovery !== "known_not_applied" ||
        !["unknown", "pending"].includes(String(response.prior_status)) ||
        response.replayed_by_intent !== index + 1 ||
        response.id !== undefined
      )
        return undefined
      if (index === receipt.intents.length - 1) return { completed, retry_index: index }
      continue
    }
    if (index !== receipt.intents.length - 1 || intent.response !== undefined) return undefined
    return { completed, pending_index: index, pending_effect: completed }
  }
  return { completed }
}
