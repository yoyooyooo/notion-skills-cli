import { Schema } from "effect"
import { fail, property } from "./model.ts"
import { normalizeObservedBody } from "./shared-file-state.ts"
import {
  projectSharedNotionMarkdown,
  validateSharedNotionMarkdownProjection,
} from "./shared-notion-projection.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { SHARED_FACT_ENVELOPE_BYTES } from "./shared-record-codec.ts"

const storage = "derived-text-v1"
const ProjectionInput = Schema.Struct({
  version: Schema.Literals([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]),
  input_markdown: Schema.String,
  purpose: Schema.optional(Schema.Literals(["body_write", "data_source_create"])),
})
const invalid = () =>
  fail(
    "SHARED_PLAN_STORAGE_INVALID",
    "The stored operation cannot reconstruct its exact frozen text.",
  )

function projection(value: unknown, expand: boolean) {
  if (!expand) {
    const checked = validateSharedNotionMarkdownProjection(value)
    return {
      version: checked.version,
      input_markdown: checked.input_markdown,
      ...(checked.version === 1 ? {} : { purpose: checked.purpose }),
    }
  }
  const input = Schema.decodeUnknownSync(ProjectionInput)(value, { onExcessProperty: "error" })
  return projectSharedNotionMarkdown(input.input_markdown, {
    version: input.version,
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
  })
}

/** Only derivable fields are omitted. Exact original input, raw matching text,
 * projection version and all identity commitments remain in the same Record.
 * This is not compression, new object storage, or a larger fact byte budget. */
function transform(value: unknown, expand: boolean): Record<string, unknown> {
  const plan = { ...property(value) }
  if (!["body_write", "file_management", "skill_apply"].includes(String(plan.kind))) throw invalid()
  if (plan.kind === "skill_apply") {
    if (!Array.isArray(plan.bodies)) throw invalid()
    plan.bodies = plan.bodies.map((child) => transform(child, expand))
    if (plan.version === 2) {
      if (!Array.isArray(plan.layout)) throw invalid()
      plan.layout = plan.layout.map((child) => transform(child, expand))
    }
    return plan
  }
  if (plan.before !== null) {
    const before = { ...property(plan.before) }
    if (typeof before.raw_markdown !== "string") throw invalid()
    if (expand) {
      if (Object.hasOwn(before, "markdown")) throw invalid()
      before.markdown = normalizeObservedBody(before.raw_markdown)
    } else {
      if (before.markdown !== normalizeObservedBody(before.raw_markdown)) throw invalid()
      delete before.markdown
    }
    plan.before = before
  }
  const projectionKey = plan.kind === "body_write" ? "input_projection" : "creation_projection"
  const contentKey = plan.kind === "body_write" ? "candidate" : "content"
  const content = { ...property(plan[contentKey]) }
  if (plan[projectionKey] != null) {
    const projected = projection(plan[projectionKey], expand)
    if (expand) {
      if (Object.hasOwn(content, "markdown")) throw invalid()
      content.markdown = property(projected).markdown
    } else {
      if (content.markdown !== property(plan[projectionKey]).markdown) throw invalid()
      delete content.markdown
    }
    plan[projectionKey] = projected
  } else if (plan.kind === "file_management") {
    if (expand) {
      if (Object.hasOwn(content, "markdown")) throw invalid()
      content.markdown = property(plan.before).markdown
    } else {
      if (content.markdown !== property(property(value).before).markdown) throw invalid()
      delete content.markdown
    }
  }
  plan[contentKey] = content
  return plan
}

/** Domain validators call this before decoding their original complete schema.
 * Their existing full-plan digests still validate every reconstructed byte. */
export function expandSharedOperationPlan(value: unknown): unknown {
  const record = property(value)
  if (record.storage === undefined) return value
  if (record.storage !== storage || typeof record.operation_id !== "string") throw invalid()
  validateSharedRecordEnvelope(record.operation_id, value)
  const { storage: _storage, ...plan } = record
  return transform(plan, true)
}

export function storedSharedOperationPlan(value: { readonly operation_id: string }): unknown {
  const envelope = canonicalSharedJson({
    version: 1,
    operation_id: value.operation_id,
    payload: value,
  })
  if (new TextEncoder().encode(envelope).byteLength <= SHARED_FACT_ENVELOPE_BYTES) return value
  const encoded = { ...transform(value, false), storage }
  const storedBytes = new TextEncoder().encode(
    canonicalSharedJson({
      version: 1,
      operation_id: value.operation_id,
      payload: encoded,
    }),
  ).byteLength
  if (storedBytes > SHARED_FACT_ENVELOPE_BYTES)
    throw fail(
      "SHARED_RECORD_TOO_LARGE",
      "The operation's exact unique inputs still exceed 64 KiB after removing derived copies. Split independent edits; no dispatch or write was started.",
      {
        max_bytes: SHARED_FACT_ENVELOPE_BYTES,
        stored_plan_bytes: storedBytes,
        expanded_plan_bytes: new TextEncoder().encode(envelope).byteLength,
      },
    )
  // Prove the representation is lossless before it becomes write authority.
  if (canonicalSharedJson(expandSharedOperationPlan(encoded)) !== canonicalSharedJson(value))
    throw invalid()
  return encoded
}
