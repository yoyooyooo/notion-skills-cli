import { Schema } from "effect"
import { FileEventSchema, ResourceContentSchema } from "./shared-file-state.ts"
import { PreparedSharedResourceSchema } from "./shared-resource-content.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const Fields = {
  file_id: Identity,
  path: Schema.String,
  input_path: Schema.String,
  event: FileEventSchema,
  ancestors: Schema.optional(Schema.Array(FileEventSchema)),
}
export const SharedCreateResourceSchema = Schema.Struct({
  ...Fields,
  prepared: PreparedSharedResourceSchema,
})
export const SharedCreateResourceManifestSchema = Schema.Struct({
  ...Fields,
  content: ResourceContentSchema,
})
export type SharedCreateResource = typeof SharedCreateResourceSchema.Type

/** Resource pages describe immutable bytes; their editable Markdown is never the resource body. */
export function sharedCreateResourceDescription(resource: SharedCreateResource): string {
  const content = resource.prepared.content
  return `# ${resource.path}\n\nThis page manages an exact retained resource. Its description is editable; the file bytes are retained separately.\n\nSHA-256: ${content.sha256}\n\nBytes: ${content.bytes}\n\nMode: ${content.mode ?? "unknown"}\n`
}

/** Only the generated resource-note heading is eligible. Resource bytes are
 * retained separately; no authored Markdown or link is normalized here. */
export function equivalentResourceNote(actual: string, expected: string): boolean {
  if (actual === expected) return true
  const newline = actual.indexOf("\n"),
    expectedNewline = expected.indexOf("\n")
  if (newline < 0 || expectedNewline < 0 || !actual.startsWith("# ")) return false
  const heading = actual
    .slice(0, newline)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\n]+)\)/gu, (whole, label: string, href: string) =>
      href === `http://${label}` || href === `https://${label}` ? label : whole,
    )
  return (
    heading === expected.slice(0, expectedNewline) &&
    actual.slice(newline) === expected.slice(expectedNewline)
  )
}
