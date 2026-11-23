import { Effect } from "effect"
import { withLocalLocks } from "./local-locks.ts"
import { fail, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { SKILL_REF_VERSION } from "./skill-ref.ts"
import type { CurrentWriteMode } from "./shared-current-operation.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import {
  copyValidatedCurrentSkillWrite,
  type PreparedCurrentSkillWrite,
} from "./shared-current-write-input.ts"
import type { PreparedCurrentSkillPatch } from "./shared-current-write.ts"
import { sha256, Store } from "./store.ts"

import {
  ImportPlanSchema,
  type ImportPlan,
  type Step,
  type FrozenImportValue,
  type CurrentImportDefinition,
} from "./shared-current-import-plan-model.ts"
export {
  CurrentImportDefinitionSchema,
  FrozenImportValueSchema,
  type CurrentImportDefinition,
  type FrozenImportValue,
} from "./shared-current-import-plan-model.ts"

const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_IMPORT_PLAN_INVALID", message, details)
const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The frozen import plan is invalid."),
  })

/** Freeze prepared carriers too: reopening a plan never recompresses a resource
 * or rediscovers Members from a changed catalogue. */
export function freezeCurrentImportValue(value: unknown) {
  return Effect.gen(function* () {
    const text = yield* checked(() =>
      JSON.stringify(value, (_key, item: unknown) =>
        item instanceof Uint8Array ? { $ntn_bytes: Buffer.from(item).toString("base64") } : item,
      ),
    )
    return { text, sha256: yield* sha256(text) }
  })
}
function thawValue(value: FrozenImportValue) {
  return Effect.gen(function* () {
    if ((yield* sha256(value.text)) !== value.sha256)
      return yield* Effect.fail(invalid("The frozen import payload hash changed."))
    return yield* checked(
      () =>
        JSON.parse(value.text, (_key, item: unknown) => {
          if (item === null || typeof item !== "object" || Array.isArray(item)) return item
          const raw = item as Record<string, unknown>
          if (!("$ntn_bytes" in raw)) return item
          if (Object.keys(raw).length !== 1 || typeof raw.$ntn_bytes !== "string")
            throw invalid("The frozen original has invalid byte framing.")
          const bytes = new Uint8Array(Buffer.from(raw.$ntn_bytes, "base64"))
          if (Buffer.from(bytes).toString("base64") !== raw.$ntn_bytes)
            throw invalid("The frozen original has noncanonical bytes.")
          return bytes
        }) as unknown,
    )
  })
}
export function thawCurrentImportSkill(value: FrozenImportValue) {
  return Effect.gen(function* () {
    // This existing admission boundary checks every prepared byte and fingerprint.
    const raw = yield* thawValue(value)
    return yield* copyValidatedCurrentSkillWrite(raw as PreparedCurrentSkillWrite)
  })
}
export function thawCurrentImportPatch(value: FrozenImportValue) {
  return Effect.gen(function* () {
    const raw = yield* thawValue(value)
    return yield* checked(() => {
      if (
        raw === null ||
        typeof raw !== "object" ||
        !("contract" in raw) ||
        raw.contract !== "notion-patch"
      )
        throw invalid("The frozen relation phase is not a current patch.")
      // writeCurrentSkillPatch checks every preserved binding before use.
      return raw as PreparedCurrentSkillPatch
    })
  })
}

const importProof = Symbol("frozen-current-import")
export type FrozenCurrentImportProof = {
  readonly [importProof]: true
  readonly library_id: string
  readonly skills_data_source_id: string
  readonly skill_id: string
  readonly operation_id: string
  readonly input_sha256: string
  readonly prepared_sha256: string
}
const issuedProofs = new WeakSet<FrozenCurrentImportProof>()
export function assertFrozenCurrentImportProof(
  proof: FrozenCurrentImportProof,
  library: SharedLibrary,
  request: {
    readonly skill_id: string
    readonly operation_id: string
    readonly input_sha256: string
  },
): void {
  if (
    !issuedProofs.has(proof) ||
    proof.library_id !== library.library_id ||
    proof.skills_data_source_id !== library.skills.data_source_id ||
    proof.skill_id !== request.skill_id ||
    proof.operation_id !== request.operation_id ||
    proof.input_sha256 !== request.input_sha256
  )
    throw invalid("The frozen import proof does not bind this exact writer intent.")
}
export type CurrentImportSession = {
  readonly definition: CurrentImportDefinition
  readonly step: (key: string) => Step | undefined
  readonly start: (
    key: string,
    value: Omit<Step, "phase" | "result">,
  ) => Effect.Effect<
    {
      readonly mode: "apply" | "resume"
      readonly proof: FrozenCurrentImportProof
    },
    SkillsError
  >
  readonly complete: (key: string, result: unknown) => Effect.Effect<void, SkillsError>
}

/** One lease covers compilation, remote phases and retirement. Started children
 * only resume exact writer intents; an absent CREATE is never replayed. */
export function withCurrentImportPlan<A, E, R, CE, CR>(
  library: SharedLibrary,
  request: {
    readonly operation_id: string
    readonly request_sha256: string
    readonly mode: CurrentWriteMode
  },
  compile: Effect.Effect<CurrentImportDefinition, CE, CR>,
  use: (session: CurrentImportSession) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const store = yield* Store
    const api = yield* Notion
    const scope = yield* sha256(
      canonicalSharedJson([
        api.apiOrigin ?? "https://api.notion.com",
        yield* api.credentialIdentity,
      ]),
    )
    const address = yield* sha256(
      canonicalSharedJson([
        scope,
        library.library_id,
        library.skills.data_source_id,
        request.operation_id,
      ]),
    )
    const key = `operations/import-plan/${address}/plan.json`
    return yield* withLocalLocks(
      store.root,
      [key],
      Effect.gen(function* () {
        let saved = yield* store.readJson(key, ImportPlanSchema)
        if (saved !== undefined) {
          if (
            saved.scope !== scope ||
            saved.library_id !== library.library_id ||
            saved.skills_data_source_id !== library.skills.data_source_id ||
            saved.operation_id !== request.operation_id ||
            saved.request_sha256 !== request.request_sha256 ||
            (yield* sha256(canonicalSharedJson(saved.definition))) !== saved.definition_sha256
          )
            return yield* Effect.fail(
              invalid("Resume requires the exact original batch, inputs, options and Library."),
            )
          if (request.mode !== "resume")
            return yield* Effect.fail(
              fail(
                "CURRENT_IMPORT_PLAN_PENDING",
                "This import has a frozen plan. Continue with the same --operation and --resume.",
              ),
            )
        } else {
          if (request.mode === "resume")
            return yield* Effect.fail(
              fail(
                "CURRENT_IMPORT_PLAN_NOT_FOUND",
                "The frozen import plan is unavailable. Resume cannot reconstruct Members or replay an unknown CREATE.",
              ),
            )
          const definition = yield* compile
          saved = {
            version: 1,
            ref_version: SKILL_REF_VERSION,
            scope,
            library_id: library.library_id,
            skills_data_source_id: library.skills.data_source_id,
            operation_id: request.operation_id,
            request_sha256: request.request_sha256,
            definition_sha256: yield* sha256(canonicalSharedJson(definition)),
            definition,
            steps: {},
          }
          yield* store.writeJson(key, saved)
        }
        let state: ImportPlan = saved
        const issued: FrozenCurrentImportProof[] = []
        const persist = (next: ImportPlan) =>
          store.writeJson(key, next).pipe(
            Effect.tap(
              Effect.sync(() => {
                state = next
              }),
            ),
          )
        const session: CurrentImportSession = {
          definition: state.definition,
          step: (stepKey) => state.steps[stepKey],
          start: (stepKey, value) =>
            Effect.gen(function* () {
              const old = state.steps[stepKey]
              if (
                old !== undefined &&
                (old.phase !== "started" ||
                  old.operation_id !== value.operation_id ||
                  old.skill_id !== value.skill_id ||
                  old.input_sha256 !== value.input_sha256 ||
                  old.prepared.sha256 !== value.prepared.sha256)
              )
                return yield* Effect.fail(
                  invalid("A frozen import phase cannot change or restart after completion."),
                )
              if (old === undefined)
                yield* persist({
                  ...state,
                  steps: { ...state.steps, [stepKey]: { ...value, phase: "started" } },
                })
              const proof: FrozenCurrentImportProof = {
                [importProof]: true,
                library_id: library.library_id,
                skills_data_source_id: library.skills.data_source_id,
                skill_id: value.skill_id,
                operation_id: value.operation_id,
                input_sha256: value.input_sha256,
                prepared_sha256: value.prepared.sha256,
              }
              issuedProofs.add(proof)
              issued.push(proof)
              return { mode: old === undefined ? "apply" : "resume", proof }
            }),
          complete: (stepKey, result) =>
            Effect.gen(function* () {
              const step = state.steps[stepKey]
              if (step === undefined)
                return yield* Effect.fail(invalid("An unstarted import phase cannot complete."))
              yield* persist({
                ...state,
                steps: { ...state.steps, [stepKey]: { ...step, phase: "complete", result } },
              })
            }),
        }
        const result = yield* use(session).pipe(
          Effect.mapError((error) =>
            error instanceof SkillsError && error.code === "CURRENT_OPERATION_NOT_FOUND"
              ? fail(
                  "CURRENT_IMPORT_PHASE_UNRESOLVED",
                  "The frozen phase has no observable continuation or exact completed result. It may have stopped before dispatch, but absence is not proof. Keep this plan and inspect/reconcile the original operation before authorizing any new write.",
                  {
                    operation_id: request.operation_id,
                    plan_retained: true,
                    next: "inspect_and_reconcile",
                    cause: error.code,
                  },
                )
              : error,
          ),
          Effect.ensuring(
            Effect.sync(() => {
              for (const proof of issued) issuedProofs.delete(proof)
            }),
          ),
        )
        yield* store.retireKeys([key])
        return result
      }),
    )
  })
}
