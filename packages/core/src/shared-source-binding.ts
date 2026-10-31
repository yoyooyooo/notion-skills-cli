import { Effect, Schema } from "effect"
import { decode, fail, SkillsError } from "./model.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { validateFixedGithubSource, type FixedGithubSource } from "./shared-github-source.ts"
import { appendSharedRecord, canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const SourceIdSchema = Schema.String.check(Schema.isPattern(/^source-[a-f0-9]{64}$/u))

/** Wire shape only; the provider owns canonical URL, path, OID and file validation. */
export const SharedGitSourceBindingSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("git"),
  source_id: SourceIdSchema,
  url: Schema.String,
  commit: Schema.String,
  root: Schema.String,
  tree: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      source_path: Schema.String,
      git_oid: Schema.String,
      bytes: Schema.Number,
    }),
  ),
})
export type SharedGitSourceBinding = typeof SharedGitSourceBindingSchema.Type

function checked<A>(run: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("INVALID_SHARED_SOURCE", "Invalid fixed source binding."),
  })
}

function fixedFields(binding: SharedGitSourceBinding): FixedGithubSource {
  return {
    url: binding.url,
    commit: binding.commit,
    root: binding.root,
    tree: binding.tree,
    files: binding.files,
  }
}

/** Stable source identity includes the full fixed tree selection, not a branch label. */
export function makeSourceBinding(input: unknown) {
  return Effect.gen(function* () {
    const source = yield* checked(() => validateFixedGithubSource(input))
    const description = { version: 1, kind: "git", ...source }
    const digest = yield* sha256(canonicalSharedJson(description))
    return {
      version: 1,
      kind: "git",
      source_id: `source-${digest}`,
      ...source,
    } satisfies SharedGitSourceBinding
  })
}

/**
 * Register an already inspected fixed source. This does not contact GitHub,
 * select a new revision on a Skill, write its Source display, or publish bodies.
 */
export function registerSourceBinding(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly mode: "create" | "reconcile"
    readonly fixedSource: FixedGithubSource
  },
) {
  return Effect.gen(function* () {
    const binding = yield* makeSourceBinding(input.fixedSource)
    const record = yield* appendSharedRecord(library, {
      mode: input.mode,
      recordId: binding.source_id,
      operationId: `register-${binding.source_id}`,
      skillPageId: input.skillPageId,
      kind: "source",
      entityId: binding.source_id,
      payload: binding,
    })
    return { binding, record }
  })
}

/** Resolve exactly the selected immutable source ID; enumeration order is never version policy. */
export function resolveSourceBinding(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly sourceId: string },
) {
  return Effect.gen(function* () {
    const sourceId = yield* checked(() => decode(SourceIdSchema, input.sourceId))
    const records = yield* querySharedRecords(library, {
      skillPageId: input.skillPageId,
      kind: "source",
      entityId: sourceId,
    })
    if (records.length === 0)
      return yield* Effect.fail(
        fail(
          "SHARED_SOURCE_MISSING",
          "The exact selected source record is unavailable; current upstream content cannot replace it.",
          { source_id: sourceId },
        ),
      )
    const record = records[0]
    if (
      records.length !== 1 ||
      record === undefined ||
      record.record_id !== sourceId ||
      record.operation_id !== `register-${sourceId}`
    )
      return yield* Effect.fail(
        fail(
          "SHARED_SOURCE_CONFLICT",
          "The selected source does not have one exact immutable record identity.",
          { source_id: sourceId },
        ),
      )
    const payload = yield* checked(() => {
      try {
        return Schema.decodeUnknownSync(SharedGitSourceBindingSchema)(record.payload, {
          onExcessProperty: "error",
        })
      } catch {
        throw fail(
          "INVALID_SHARED_SOURCE",
          "The source record does not match the versioned Git binding schema.",
          { source_id: sourceId },
        )
      }
    })
    const binding = yield* makeSourceBinding(fixedFields(payload))
    if (
      payload.source_id !== sourceId ||
      binding.source_id !== sourceId ||
      canonicalSharedJson(payload) !== canonicalSharedJson(binding)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_SOURCE_CONFLICT",
          "The selected source ID does not match its canonical fixed content.",
          { source_id: sourceId },
        ),
      )
    return binding
  })
}
