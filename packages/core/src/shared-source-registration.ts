import { Crypto, Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { SharedLibrarySchema, type SharedLibrary } from "./shared-library-model.ts"
import { appendSharedRecord, canonicalSharedJson } from "./shared-records.ts"
import {
  SharedGitSourceBindingSchema,
  type SharedGitSourceBinding,
} from "./shared-source-binding-model.ts"
import { SharedSourcePlanSchema, type SharedSourcePlan } from "./shared-source-plan.ts"
import { sha256, Store } from "./store.ts"

export const SharedSourceIdSchema = Schema.String.check(
  Schema.isPattern(/^source(?:-plan)?-[a-f0-9]{64}$/u),
)
const UuidSchema = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
)
export const SharedSourceRegistrationSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_registration"),
  credential_scope: Schema.String,
  library: SharedLibrarySchema,
  skill_page_id: UuidSchema,
  source_id: SharedSourceIdSchema,
  payload: Schema.Union([SharedGitSourceBindingSchema, SharedSourcePlanSchema]),
  dispatch_id: UuidSchema,
})
export type SharedSourceRegistration = typeof SharedSourceRegistrationSchema.Type
type SourcePayload = SharedGitSourceBinding | SharedSourcePlan

function checked<A>(operation: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: operation,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SOURCE_REGISTRATION_CORRUPT", "The frozen source registration is invalid."),
  })
}

function registrationScope(library: SharedLibrary, skillPageId: string, sourceId: string) {
  return Effect.gen(function* () {
    const selected = yield* checked(() => {
      const skill = pageId(skillPageId)
      if (!skill)
        throw fail("INVALID_ARGUMENT", "Source registration requires an exact Skill page ID.")
      Schema.decodeUnknownSync(SharedSourceIdSchema)(sourceId)
      const frozenLibrary = Schema.decodeUnknownSync(SharedLibrarySchema)(
        structuredClone(library),
        { onExcessProperty: "error" },
      )
      return { skill, library: frozenLibrary }
    })
    const credential = yield* (yield* Notion).credentialIdentity
    const scope = yield* sha256(
      JSON.stringify([
        credential,
        selected.library.library_id,
        selected.library.skills.data_source_id,
        selected.library.records.data_source_id,
        selected.skill,
      ]),
    )
    return {
      credential,
      library: selected.library,
      skill: selected.skill,
      sourceId,
      key: `operations/shared-source-registration/${scope}/${sourceId}.json`,
    }
  })
}

function pending(scope: Effect.Success<ReturnType<typeof registrationScope>>) {
  return Effect.gen(function* () {
    const value = yield* (yield* Store).readJson(scope.key, Schema.Unknown)
    if (value === undefined) return undefined
    const record = yield* checked(() =>
      Schema.decodeUnknownSync(SharedSourceRegistrationSchema)(value, {
        onExcessProperty: "error",
      }),
    )
    if (
      record.credential_scope !== scope.credential ||
      record.skill_page_id !== scope.skill ||
      record.source_id !== scope.sourceId ||
      record.library.library_id !== scope.library.library_id ||
      record.library.skills.data_source_id !== scope.library.skills.data_source_id ||
      record.library.records.data_source_id !== scope.library.records.data_source_id ||
      (record.payload.kind === "git"
        ? record.payload.source_id !== scope.sourceId
        : !scope.sourceId.startsWith("source-plan-"))
    ) {
      return yield* Effect.fail(
        fail(
          "SOURCE_REGISTRATION_CONFLICT",
          "The retained registration belongs to another credential, Skill, library, or source identity.",
        ),
      )
    }
    return record
  })
}

/** The local dispatch receipt is independent of source bodies and is never a provider cache entry. */
export function loadPendingSharedSourceRegistration(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly sourceId: string },
) {
  return Effect.gen(function* () {
    return yield* pending(yield* registrationScope(library, input.skillPageId, input.sourceId))
  })
}

/** Called with a canonical payload and its provider-verified ID. Existing dispatch always becomes read-only reconciliation. */
export function registerSharedSourceFact(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly sourceId: string
    readonly mode: "create" | "reconcile"
    readonly payload: SourcePayload
  },
) {
  return Effect.gen(function* () {
    const scope = yield* registrationScope(library, input.skillPageId, input.sourceId)
    const frozenPayload = yield* checked(() =>
      Schema.decodeUnknownSync(
        Schema.Union([SharedGitSourceBindingSchema, SharedSourcePlanSchema]),
      )(structuredClone(input.payload), { onExcessProperty: "error" }),
    )
    const original = yield* pending(scope)
    if (
      original !== undefined &&
      canonicalSharedJson(original.payload) !== canonicalSharedJson(frozenPayload)
    ) {
      return yield* Effect.fail(
        fail(
          "SOURCE_REGISTRATION_CONFLICT",
          "A retained source registration cannot be replaced with a different frozen payload.",
        ),
      )
    }
    const mode = original !== undefined ? "reconcile" : input.mode
    const store = yield* Store
    const dispatch =
      mode === "create"
        ? yield* (yield* Crypto.Crypto)
            .randomUUIDv4()
            .pipe(
              Effect.mapError(() =>
                fail("CRYPTO_ERROR", "Could not establish a unique local source dispatch."),
              ),
            )
        : undefined
    const receipt: SharedSourceRegistration | undefined =
      dispatch === undefined
        ? undefined
        : {
            version: 1,
            kind: "source_registration",
            credential_scope: scope.credential,
            library: scope.library,
            skill_page_id: scope.skill,
            source_id: scope.sourceId,
            payload: frozenPayload,
            dispatch_id: dispatch,
          }
    return yield* appendSharedRecord(original?.library ?? scope.library, {
      mode,
      recordId: scope.sourceId,
      operationId: `register-${scope.sourceId}`,
      skillPageId: scope.skill,
      kind: "source",
      entityId: scope.sourceId,
      payload: original?.payload ?? frozenPayload,
      ...(receipt === undefined ? {} : { beforeCreate: store.writeJson(scope.key, receipt) }),
    })
  })
}
