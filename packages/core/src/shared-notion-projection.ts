import { Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { normalizeObservedBody } from "./shared-file-state.ts"
import { assertNotionInlineBoundary } from "./shared-notion-inline-boundary.ts"
import { projectNativeTextBreaks } from "./shared-notion-text-breaks.ts"
import {
  projectNotionMarkdownV2,
  projectNotionMarkdownV4,
  projectNotionMarkdownV5,
  type SharedNotionMarkdownPurpose,
} from "./shared-notion-markdown-v2.ts"

/**
 * An explicit authoring policy, applied before a native write is frozen.
 * This does not change observed-body normalization or promise that arbitrary
 * Markdown round-trips through Notion. Every write still checks its exact
 * projected bytes; other native transformations require review.
 */
const ProjectionV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  format: Schema.Literal("notion_markdown_v2"),
  normalization_version: Schema.Literal(1),
  input_markdown: Schema.String,
  markdown: Schema.String,
  removed_terminal_lfs: Schema.Number,
})
const ProjectionV2Schema = Schema.Struct({
  version: Schema.Literal(2),
  format: Schema.Literal("notion_markdown_v2"),
  normalization_version: Schema.Literal(1),
  purpose: Schema.Literals(["body_write", "data_source_create"]),
  input_markdown: Schema.String,
  wire_markdown: Schema.String,
  markdown: Schema.String,
  removed_terminal_lfs: Schema.Number,
})
const ProjectionV3Schema = Schema.Struct({
  version: Schema.Literal(3),
  format: Schema.Literal("notion_markdown_v2"),
  normalization_version: Schema.Literal(1),
  purpose: Schema.Literals(["body_write", "data_source_create"]),
  input_markdown: Schema.String,
  wire_markdown: Schema.String,
  markdown: Schema.String,
  removed_terminal_lfs: Schema.Number,
})
const ProjectionV4Schema = Schema.Struct({
  version: Schema.Literal(4),
  format: Schema.Literal("notion_markdown_v2"),
  normalization_version: Schema.Literal(1),
  purpose: Schema.Literals(["body_write", "data_source_create"]),
  input_markdown: Schema.String,
  wire_markdown: Schema.String,
  markdown: Schema.String,
  removed_terminal_lfs: Schema.Number,
})
const ProjectionV5Schema = Schema.Struct({
  version: Schema.Literal(5),
  format: Schema.Literal("notion_markdown_v2"),
  normalization_version: Schema.Literal(1),
  purpose: Schema.Literals(["body_write", "data_source_create"]),
  input_markdown: Schema.String,
  wire_markdown: Schema.String,
  markdown: Schema.String,
  removed_terminal_lfs: Schema.Number,
})
const ProjectionV6Schema = Schema.Struct({
  ...ProjectionV5Schema.fields,
  version: Schema.Literal(6),
})
export const SharedNotionMarkdownProjectionSchema = Schema.Union([
  ProjectionV1Schema,
  ProjectionV2Schema,
  ProjectionV3Schema,
  ProjectionV4Schema,
  ProjectionV5Schema,
  ProjectionV6Schema,
])
export type SharedNotionMarkdownProjection = typeof SharedNotionMarkdownProjectionSchema.Type
export type SharedNotionMarkdownVersion = SharedNotionMarkdownProjection["version"]

export const SharedNotionMarkdownPolicySchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    format: Schema.Literal("notion_markdown_v2"),
    normalization_version: Schema.Literal(1),
    removed_terminal_lfs: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    format: Schema.Literal("notion_markdown_v2"),
    normalization_version: Schema.Literal(1),
    removed_terminal_lfs: Schema.Number,
    purpose: Schema.Literals(["body_write", "data_source_create"]),
  }),
  Schema.Struct({
    version: Schema.Literal(3),
    format: Schema.Literal("notion_markdown_v2"),
    normalization_version: Schema.Literal(1),
    removed_terminal_lfs: Schema.Number,
    purpose: Schema.Literals(["body_write", "data_source_create"]),
  }),
  Schema.Struct({
    version: Schema.Literal(4),
    format: Schema.Literal("notion_markdown_v2"),
    normalization_version: Schema.Literal(1),
    removed_terminal_lfs: Schema.Number,
    purpose: Schema.Literals(["body_write", "data_source_create"]),
  }),
  Schema.Struct({
    version: Schema.Literal(5),
    format: Schema.Literal("notion_markdown_v2"),
    normalization_version: Schema.Literal(1),
    removed_terminal_lfs: Schema.Number,
    purpose: Schema.Literals(["body_write", "data_source_create"]),
  }),
  Schema.Struct({
    version: Schema.Literal(6),
    format: Schema.Literal("notion_markdown_v2"),
    normalization_version: Schema.Literal(1),
    removed_terminal_lfs: Schema.Number,
    purpose: Schema.Literals(["body_write", "data_source_create"]),
  }),
])

/** Retained v1-v5 records keep their historical bytes and policy. New policy 6
 * also predicts native text breaks and the independently observed link labels. */
export function projectSharedNotionMarkdown(
  input: string,
  options: {
    readonly version?: SharedNotionMarkdownVersion
    readonly purpose?: SharedNotionMarkdownPurpose
  } = {},
): SharedNotionMarkdownProjection {
  if (
    typeof input !== "string" ||
    input.includes("\u0000") ||
    new TextDecoder().decode(new TextEncoder().encode(input)) !== input
  )
    throw fail(
      "SHARED_MARKDOWN_PROJECTION_INVALID",
      "Native Markdown input must be complete UTF-8 text without NUL bytes.",
    )
  const normalized = normalizeObservedBody(input)
  const markdown = normalized.replace(/\n+$/u, "")
  const common = {
    format: "notion_markdown_v2",
    normalization_version: 1,
    input_markdown: input,
    markdown,
    removed_terminal_lfs: normalized.length - markdown.length,
  } as const
  if (options.version === 1) return { version: 1, ...common }
  const version = options.version ?? 6
  if (version >= 3) assertNotionInlineBoundary(markdown)
  const purpose = options.purpose ?? "body_write"
  const projected =
    version >= 5
      ? projectNotionMarkdownV5(markdown, purpose)
      : version === 4
        ? projectNotionMarkdownV4(markdown, purpose)
        : projectNotionMarkdownV2(markdown, purpose)
  return {
    version,
    ...common,
    purpose,
    wire_markdown: projected.wire,
    markdown: version === 6 ? projectNativeTextBreaks(projected.markdown) : projected.markdown,
  }
}

export function sharedNotionMarkdownWire(projection: SharedNotionMarkdownProjection): string {
  return projection.version === 1 ? projection.markdown : projection.wire_markdown
}

/** The manifest can reconstruct the full wire solely from retained input and
 * this declared immutable policy; it does not need to embed the input again. */
export function sharedNotionMarkdownPolicy(projection: SharedNotionMarkdownProjection) {
  const common = {
    format: projection.format,
    normalization_version: projection.normalization_version,
    removed_terminal_lfs: projection.removed_terminal_lfs,
  }
  return projection.version === 1
    ? { version: 1 as const, ...common }
    : { version: projection.version, ...common, purpose: projection.purpose }
}

export function validateSharedNotionMarkdownProjection(
  input: unknown,
): SharedNotionMarkdownProjection {
  let projection: SharedNotionMarkdownProjection
  try {
    projection = Schema.decodeUnknownSync(SharedNotionMarkdownProjectionSchema)(input, {
      onExcessProperty: "error",
    })
  } catch (error) {
    if (error instanceof SkillsError) throw error
    throw fail(
      "SHARED_MARKDOWN_PROJECTION_INVALID",
      "The frozen native Markdown projection has an invalid shape.",
    )
  }
  const expected = projectSharedNotionMarkdown(projection.input_markdown, {
    version: projection.version,
    ...(projection.version === 1 ? {} : { purpose: projection.purpose }),
  })
  if (
    !Number.isSafeInteger(projection.removed_terminal_lfs) ||
    projection.markdown !== expected.markdown ||
    sharedNotionMarkdownWire(projection) !== sharedNotionMarkdownWire(expected) ||
    projection.removed_terminal_lfs !== expected.removed_terminal_lfs
  )
    throw fail(
      "SHARED_MARKDOWN_PROJECTION_INVALID",
      "The frozen native Markdown projection differs from its declared input policy.",
    )
  return projection
}
