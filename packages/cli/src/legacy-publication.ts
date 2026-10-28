import { Schema } from "effect"
import { PublicationReceiptSchema } from "../../core/src/publication-model.ts"
import { decode, property } from "../../core/src/model.ts"

/** Offline-only wire reader. Never import from the normal CLI entrypoint. */
export const LegacyPublicationSchema = Schema.Struct({
  ...PublicationReceiptSchema.fields,
  operation: Schema.Literals(["import", "create", "replace", "write"]),
})

export function convertLegacyPublication(raw: unknown, wireHash: string) {
  const legacy = decode(LegacyPublicationSchema, raw)
  if (legacy.operation !== "import") return { value: raw, audit: undefined }
  const root = legacy.page_id ? `v1/pages/${legacy.page_id}` : undefined
  const guard = root ? property(legacy.guards[root]) : {}
  const parent = property(guard.parent)
  const creates = legacy.intents.filter((i) => i.method === "POST" && i.path === "v1/pages")
  const rootCreates = creates.filter((i) => {
    const p = property(property(i.body).parent)
    return (
      typeof legacy.data_source_id === "string" &&
      legacy.data_source_id.length > 0 &&
      Boolean(legacy.database_id && legacy.scope) &&
      p.type === "data_source_id" &&
      p.data_source_id === legacy.data_source_id
    )
  })
  const rootCreated = rootCreates.some(
    (i) =>
      i.status === "completed" &&
      typeof legacy.page_id === "string" &&
      legacy.page_id.length > 0 &&
      property(i.response).id === legacy.page_id,
  )
  const unknownCreate = rootCreates.some((i) => i.status === "pending" || i.status === "unknown")
  const boundExisting = Boolean(
    root &&
      guard.id === legacy.page_id &&
      parent.type === "data_source_id" &&
      parent.data_source_id === legacy.data_source_id &&
      (!parent.database_id || parent.database_id === legacy.database_id) &&
      typeof legacy.guards[`${root}/markdown`] === "string" &&
      legacy.scope &&
      legacy.database_id &&
      legacy.data_source_id &&
      creates.length === 0 &&
      legacy.intents.some(
        (i) => i.method === "PATCH" && (i.path === root || i.path === `${root}/markdown`),
      ),
  )
  const resolution =
    rootCreated || unknownCreate ? "create" : boundExisting ? "replace" : "unresolved"
  // An unproven historical branch is retained for review, never relabelled as create.
  const value =
    resolution === "unresolved" ? undefined : { ...property(raw), operation: resolution }
  if (value) decode(PublicationReceiptSchema, value)
  return {
    value,
    audit: {
      format: 1,
      operation_id: legacy.operation_id,
      original_operation: "import",
      original_wire_sha256: wireHash,
      original_wire: raw,
      resolution,
      runtime_operation: resolution === "unresolved" ? null : resolution,
      execution_fenced: resolution === "unresolved",
      evidence: {
        page_id: legacy.page_id ?? null,
        database_id: legacy.database_id ?? null,
        data_source_id: legacy.data_source_id ?? null,
        root_created: rootCreated,
        unknown_root_create: unknownCreate,
        guarded_existing_destination: boundExisting,
      },
      next:
        resolution === "unresolved"
          ? {
              action:
                "Inspect retained wire and exact root creation response/guard; do not replay or match by name.",
            }
          : { argv: ["ntn-skills", "operation", "show", legacy.operation_id] },
    },
  }
}
