import { Crypto, Effect, Schema } from "effect"
import { fail, property, text } from "./model.ts"
import type { NotionBlockBoundary } from "./markdown.ts"
import type { Receipt } from "./publication-model.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const CreationProofSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_token: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  operation_id: Schema.String,
  intent_index: Schema.Number,
  scope: Schema.String,
  database_id: Schema.String,
  data_source_id: Schema.String,
  role: Schema.Literals(["content_root", "reference"]),
  path: Schema.String,
  parent_type: Schema.Literals(["data_source_id", "page_id"]),
  parent_id: Schema.String,
  intended_hash: Hash,
  source_sha256: Hash,
  subscription_id: Schema.optional(Schema.String),
  member_key: Schema.optional(Schema.String),
})
export type CreationProof = typeof CreationProofSchema.Type
export const CreationDiscoverySchema = Schema.Struct({
  intent_index: Schema.Number,
  operation_id: Schema.String,
  scope: Schema.String,
  database_id: Schema.String,
  data_source_id: Schema.String,
  observed_at_ms: Schema.Number,
  role: Schema.Literals(["content_root", "reference"]),
  marker_kind: Schema.Literals(["creation_v1", "legacy_operation", "publication_v2"]),
  parent_id: Schema.String,
  path: Schema.optional(Schema.String),
  operation_token: Schema.optional(Schema.String),
  complete: Schema.Boolean,
  candidate_count: Schema.Number,
  candidate_page_ids: Schema.Array(Schema.String),
  outcome: Schema.Literals(["unknown", "unique"]),
  reason: Schema.String,
})
export type CreationDiscovery = typeof CreationDiscoverySchema.Type
const PREFIX = "ntn-skills-create:v1:"

/** This reserved first paragraph is transport metadata, never authored source. */
export function creationMarker(proof: CreationProof) {
  return `${PREFIX}${Buffer.from(JSON.stringify(proof)).toString("base64url")}`
}
const paragraphText = (value: string) =>
  value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1")
export function creationMarkerProof(markdown: string): CreationProof | undefined {
  const first = paragraphText(markdown.trimStart().split(/\r?\n/, 1)[0]!)
  if (!first.startsWith(PREFIX)) return undefined
  try {
    return Schema.decodeUnknownSync(CreationProofSchema)(
      JSON.parse(Buffer.from(first.slice(PREFIX.length), "base64url").toString("utf8")),
      {
        onExcessProperty: "error",
      },
    )
  } catch {
    throw fail("PUBLICATION_INVALID", "The reserved creation identity paragraph is invalid.")
  }
}
export function withoutCreationMarker(markdown: string) {
  if (!creationMarkerProof(markdown)) return markdown
  return markdown.trimStart().replace(/^[^\r\n]+(?:\r?\n)*/, "")
}

/** Keep authored Markdown and its physical root evidence in the same frame. */
export function withoutCreationMarkerWithBlocks(
  markdown: string,
  blocks: readonly NotionBlockBoundary[] | undefined,
) {
  if (!creationMarkerProof(markdown)) return { markdown, blocks }
  if (blocks !== undefined) {
    const first = blocks[0]
    const marker = paragraphText(markdown.trimStart().split(/\r?\n/, 1)[0]!)
    if (
      !first?.id ||
      first.type !== "paragraph" ||
      first.has_children !== false ||
      first.descendants?.length ||
      first.text !== marker ||
      !first.rich_text?.length ||
      first.rich_text.some(
        (span) => span.link !== null || span.bold !== false || span.code !== false,
      ) ||
      first.rich_text.map((span) => span.text).join("") !== marker ||
      blocks.some((block, index) => index > 0 && block.id === first.id)
    )
      throw fail(
        "WRITE_VERIFICATION_FAILED",
        "The creation identity paragraph differs from its complete physical block.",
      )
  }
  return { markdown: withoutCreationMarker(markdown), blocks: blocks?.slice(1) }
}

export function preserveCreationMarker(before: string, authored: string) {
  const proof = creationMarkerProof(before)
  return proof ? `${creationMarker(proof)}\n\n${withoutCreationMarker(authored)}` : authored
}
export function creationMarkerBlock(proof: CreationProof) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: creationMarker(proof) } }] },
  }
}
export function creationProofFromBody(body: unknown): CreationProof | undefined {
  const raw = property(body)
  if (property(raw.parent).data_source_id) {
    const rich = property(property(raw.properties).Publication).rich_text
    if (!Array.isArray(rich)) return undefined
    try {
      const proof = property(JSON.parse(text(rich))).creation
      return proof === undefined
        ? undefined
        : Schema.decodeUnknownSync(CreationProofSchema)(proof, { onExcessProperty: "error" })
    } catch {
      throw fail("PUBLICATION_INVALID", "Initial Publication creation identity is invalid.")
    }
  }
  const children = raw.children
  if (!Array.isArray(children)) return undefined
  return creationMarkerProof(text(property(property(children[0]).paragraph).rich_text))
}
export function prepareCreationProof(receipt: Receipt, body: unknown, intendedHash: string) {
  return Effect.gen(function* () {
    const parent = property(property(body).parent)
    const root = typeof parent.data_source_id === "string"
    const title = text(property(property(property(body).properties).title).title)
    const path = root
      ? receipt.portable.main
      : receipt.portable.files.some((file) => file.path === title)
        ? title
        : `references/${title}`
    const source = receipt.portable.files.find((file) => file.path === path)
    if (
      !receipt.scope ||
      !receipt.database_id ||
      !receipt.data_source_id ||
      !source ||
      (root ? parent.data_source_id !== receipt.data_source_id : parent.page_id !== receipt.page_id)
    )
      return yield* Effect.fail(
        fail("PUBLICATION_UNRESOLVED", "Create payload does not match its bound source intent."),
      )
    const crypto = yield* Crypto.Crypto
    const operation_token = yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(() =>
          fail("CRYPTO_ERROR", "Could not allocate a creation correlation token."),
        ),
      )
    return {
      version: 1,
      operation_token,
      operation_id: receipt.operation_id,
      intent_index: receipt.intents.length,
      scope: receipt.scope,
      database_id: receipt.database_id,
      data_source_id: receipt.data_source_id,
      role: root ? "content_root" : "reference",
      path,
      parent_type: root ? "data_source_id" : "page_id",
      parent_id: String(root ? parent.data_source_id : parent.page_id),
      intended_hash: intendedHash,
      source_sha256: source.sha256,
      ...(receipt.context?.ownership
        ? {
            subscription_id: receipt.context.ownership.subscription_id,
            member_key: receipt.context.ownership.member_key,
          }
        : {}),
    } satisfies CreationProof
  })
}

/** An identity must agree with every original local bound before discovery can adopt it. */
export function creationProofMatchesIntent(proof: CreationProof, receipt: Receipt, index: number) {
  const parent = property(property(receipt.intents[index]?.body).parent)
  const root = proof.role === "content_root"
  const title = text(
    property(property(property(receipt.intents[index]?.body).properties).title).title,
  )
  const expectedPath = root ? receipt.portable.main : proof.path
  return (
    proof.operation_id === receipt.operation_id &&
    proof.intent_index === index &&
    proof.scope === receipt.scope &&
    proof.database_id === receipt.database_id &&
    proof.data_source_id === receipt.data_source_id &&
    proof.parent_type === (root ? "data_source_id" : "page_id") &&
    proof.parent_id === (root ? parent.data_source_id : parent.page_id) &&
    proof.path === expectedPath &&
    (root ||
      title === proof.path ||
      (proof.path.startsWith("references/") && title === proof.path.slice("references/".length))) &&
    (root
      ? parent.data_source_id === receipt.data_source_id
      : proof.parent_id === receipt.page_id) &&
    receipt.portable.files.some(
      (file) => file.path === proof.path && file.sha256 === proof.source_sha256,
    ) &&
    proof.subscription_id === receipt.context?.ownership?.subscription_id &&
    proof.member_key === receipt.context?.ownership?.member_key
  )
}
