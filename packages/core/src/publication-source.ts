import { Effect, Schema } from "effect"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import {
  PublicationSourceSchema,
  type PublicationSource,
  type PublicationSourceIntent,
  type Receipt,
} from "./publication-model.ts"
import {
  canonical,
  metadataContent,
  publicationPropertiesMatch,
} from "./publication-observation.ts"

const sourceChoices = ["builtin", "manual", "upstream"]
const schemaFailure = () =>
  fail(
    "DATABASE_SCHEMA_CONFLICT",
    "Source Type must be a select with exactly builtin/upstream/manual and Builtin ID must be rich_text. Run ctl database init --content-database <content-id> --upstream-database <upstream-id> before explicit source publication.",
  )

export function initialPublicationSource(
  operation: Receipt["operation"],
  source?: PublicationSource,
  ownership?: unknown,
): PublicationSourceIntent {
  if (source !== undefined) {
    const raw = property(source)
    if (Object.keys(raw).sort().join() !== (raw.type === "builtin" ? "builtinId,type" : "type"))
      throw fail("INVALID_ARGUMENT", "Invalid publication source.")
    const parsed = Schema.decodeUnknownSync(PublicationSourceSchema)(source)
    if (ownership && parsed.type !== "upstream")
      throw fail("INVALID_ARGUMENT", "Upstream ownership requires upstream source.")
    return { mode: "set", value: parsed }
  }
  return ownership
    ? { mode: "set", value: { type: "upstream" } }
    : { mode: operation === "create" ? "manual_when_supported" : "preserve" }
}

function compatibleSourceField(raw: unknown) {
  const field = property(raw),
    options = property(field.select).options
  return (
    field.type === "select" &&
    typeof field.id === "string" &&
    Array.isArray(options) &&
    canonical(options.map((option) => property(option).name).sort()) === canonical(sourceChoices)
  )
}
function compatibleBuiltinField(raw: unknown) {
  const field = property(raw)
  return field.type === "rich_text" && typeof field.id === "string"
}

/** Bind once before any mutation. Historical omission and legacy unavailability stay frozen. */
export function bindPublicationSource(
  receipt: Receipt,
  dataSourceId: string,
  api: Notion["Service"],
) {
  return Effect.gen(function* () {
    const intent = receipt.context?.source_intent
    if (!intent || intent.mode === "preserve") return
    if (
      receipt.source_binding?.data_source_id !== undefined &&
      receipt.source_binding.data_source_id !== dataSourceId
    )
      return yield* Effect.fail(fail("WRITE_CONFLICT", "The frozen source data source changed."))
    if (receipt.source_binding?.status === "unavailable") {
      if (intent.mode !== "manual_when_supported")
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "Only optional manual source may retain unavailable fields."),
        )
      return
    }
    if (!receipt.source_binding && receipt.intents.length)
      return yield* Effect.fail(
        fail("PUBLICATION_UNRESOLVED", "Mutation history has no frozen source field decision."),
      )
    const schema = property(yield* api.request(`v1/data_sources/${dataSourceId}`))
    if (schema.id !== undefined && schema.id !== dataSourceId)
      return yield* Effect.fail(schemaFailure())
    const fields = property(schema.properties)
    const binding = receipt.source_binding
    const source =
      binding?.status === "bound"
        ? Object.values(fields).find((field) => property(field).id === binding.source_type_id)
        : fields["Source Type"]
    const builtin =
      binding?.status === "bound"
        ? Object.values(fields).find((field) => property(field).id === binding.builtin_id_id)
        : fields["Builtin ID"]
    if (
      (source !== undefined && !compatibleSourceField(source)) ||
      (builtin !== undefined && !compatibleBuiltinField(builtin))
    )
      return yield* Effect.fail(schemaFailure())
    if (!source || !builtin) {
      if (binding || intent.mode === "set") return yield* Effect.fail(schemaFailure())
      receipt.source_binding = { status: "unavailable", data_source_id: dataSourceId }
      return
    }
    if (!binding)
      receipt.source_binding = {
        status: "bound",
        data_source_id: dataSourceId,
        source_type_id: String(property(source).id),
        builtin_id_id: String(property(builtin).id),
      }
  })
}

/** This exact body is shared by writing, comparison and bounded recovery. */
export function publicationMetadataProperties(
  receipt: Pick<Receipt, "context" | "source_binding">,
): Record<string, unknown> {
  const rich = (content: string) => ({
    rich_text:
      content || !receipt.context?.source_intent ? [{ type: "text", text: { content } }] : [],
  })
  const owner = receipt.context?.ownership
  const fields: Record<string, unknown> = owner
    ? {
        Upstream: { relation: [{ id: owner.subscription_id }] },
        "Sync Mode": { select: { name: owner.mode } },
        "Upstream Key": rich(owner.member_key),
        "Upstream Revision": rich(owner.revision),
        "Published Hash": rich(owner.published_hash),
        "Fork Baseline": rich(owner.fork_baseline ? JSON.stringify(owner.fork_baseline) : ""),
      }
    : {}
  const intent = receipt.context?.source_intent,
    binding = receipt.source_binding
  if (intent && intent.mode !== "preserve" && binding?.status === "bound") {
    const source = intent.mode === "set" ? intent.value : { type: "manual" as const }
    fields[binding.source_type_id] = { select: { name: source.type } }
    fields[binding.builtin_id_id] = {
      rich_text:
        source.type === "builtin" ? [{ type: "text", text: { content: source.builtinId } }] : [],
    }
  }
  return fields
}
export function isPublicationMetadataRequest(
  receipt: Receipt,
  path: string,
  body: unknown,
  method: string,
) {
  const fields = publicationMetadataProperties(receipt)
  return (
    Object.keys(fields).length > 0 &&
    method === "PATCH" &&
    path === `v1/pages/${receipt.page_id}` &&
    canonical(body) === canonical({ properties: fields })
  )
}
export function isPublicationMetadataIntent(receipt: Receipt, intent: Receipt["intents"][number]) {
  return isPublicationMetadataRequest(receipt, intent.path, intent.body, intent.method)
}
export function unobservedPublicationMetadataAck(
  receipt: Receipt,
  intent: Receipt["intents"][number],
) {
  return (
    intent.status === "completed" &&
    isPublicationMetadataIntent(receipt, intent) &&
    intent.guards?.[intent.path] !== undefined &&
    receipt.guards[intent.path] !== undefined &&
    publicationGuardComparison(receipt, intent.path, intent.guards[intent.path]) ===
      publicationGuardComparison(receipt, intent.path, receipt.guards[intent.path])
  )
}

/** Compare only the two frozen source fields by ID; historical observations stay intact. */
export function publicationGuardComparison(receipt: Receipt, path: string, observed: unknown) {
  const binding = receipt.source_binding
  if (binding?.status !== "bound" || path !== `v1/pages/${receipt.page_id}`)
    return canonical(observed)
  const value = property(observed)
  return canonical({
    ...value,
    properties: publicationSourcePropertiesComparison(binding, property(value.properties)),
  })
}

export function publicationSourcePropertiesComparison(
  binding: Extract<Receipt["source_binding"], { status: "bound" }>,
  fields: Record<string, unknown>,
) {
  return Object.entries(fields)
    .map(([name, field]) => {
      const id = property(field).id
      return [
        id === binding.source_type_id || id === binding.builtin_id_id ? ["id", id] : ["name", name],
        field,
      ]
    })
    .sort((a, b) => canonical(a[0]).localeCompare(canonical(b[0])))
}

/** Positive proof for the one frozen assignment, including all unaffected resources. */
export function publicationMetadataApplied(
  receipt: Receipt,
  intent: Receipt["intents"][number],
  before: unknown,
  after: unknown,
) {
  if (
    !isPublicationMetadataIntent(receipt, intent) ||
    !intent.guards?.[intent.path] ||
    publicationGuardComparison(receipt, intent.path, intent.guards[intent.path]) !==
      publicationGuardComparison(receipt, intent.path, before) ||
    !publicationMetadataMatches(receipt, after)
  )
    return false
  const requested = publicationMetadataProperties(receipt)
  const beforeFields = property(property(before).properties),
    afterFields = property(property(after).properties)
  for (const key of Object.keys(requested)) {
    const original = property(
      beforeFields[key] ?? Object.values(beforeFields).find((field) => property(field).id === key),
    )
    const current = property(
      afterFields[key] ?? Object.values(afterFields).find((field) => property(field).id === key),
    )
    if (
      typeof original.id !== "string" ||
      current.id !== original.id ||
      current.type !== original.type
    )
      return false
  }
  const unchanged = (raw: unknown) => {
    const value = property(metadataContent(raw))
    return {
      ...value,
      properties: Object.fromEntries(
        Object.entries(property(value.properties)).filter(
          ([name, field]) =>
            !Object.hasOwn(requested, name) &&
            !Object.hasOwn(requested, String(property(field).id)),
        ),
      ),
    }
  }
  for (const [name, raw] of Object.entries(property(property(before).properties))) {
    const field = property(raw)
    if (
      !Object.hasOwn(requested, name) &&
      !Object.hasOwn(requested, String(field.id)) &&
      Array.isArray(field.files) &&
      field.files.some((file) => typeof property(file).id !== "string")
    )
      return false
  }
  return (
    publicationGuardComparison(receipt, intent.path, unchanged(before)) ===
    publicationGuardComparison(receipt, intent.path, unchanged(after))
  )
}
export function publicationMetadataMatches(receipt: Receipt, raw: unknown) {
  const intent = receipt.context?.source_intent
  if (intent && intent.mode !== "preserve" && !receipt.source_binding) return false
  return publicationPropertiesMatch(raw, publicationMetadataProperties(receipt))
}
export function verifyPublicationMetadata(receipt: Receipt, api: Notion["Service"]) {
  return Effect.gen(function* () {
    if (
      receipt.context?.source_intent &&
      receipt.context.source_intent.mode !== "preserve" &&
      !receipt.source_binding
    )
      return yield* Effect.fail(
        fail("PUBLICATION_INCOMPLETE", "The frozen source assignment has not been bound."),
      )
    if (receipt.data_source_id) yield* bindPublicationSource(receipt, receipt.data_source_id, api)
    if (
      Object.keys(publicationMetadataProperties(receipt)).length &&
      (!receipt.page_id ||
        !publicationMetadataMatches(receipt, yield* api.request(`v1/pages/${receipt.page_id}`)))
    )
      return yield* Effect.fail(
        fail(
          "PUBLICATION_INCOMPLETE",
          "The requested publication metadata differs from the live page.",
        ),
      )
  })
}

export function rejectPublicationSourceOverride(options: {
  readonly source?: unknown
  readonly ownership?: unknown
  readonly retainedSource?: unknown
}) {
  return Effect.gen(function* () {
    if (
      options.source !== undefined ||
      options.ownership !== undefined ||
      options.retainedSource !== undefined
    )
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Resume uses frozen publication metadata; source and ownership overrides are not accepted.",
        ),
      )
  })
}
