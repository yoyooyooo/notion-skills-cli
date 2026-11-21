import { Crypto, Effect } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { RequestBudget, withinRequestBudget } from "./request-budget.ts"
import { resolveCurrentSourceConsumption } from "./shared-current-consumption.ts"
import { readCurrentSkillMetadata, type CurrentFileBinding } from "./shared-current-index.ts"
import { withCurrentInvocationBudget } from "./shared-current-invocation.ts"
import {
  currentOperationFailure,
  readCurrentOperationIntent,
  withCurrentOperation,
  type CurrentSkillRestoreIntent,
} from "./shared-current-operation.ts"
import { currentProjectionPolicy } from "./shared-current-projection-policy.ts"
import { projectCurrentSkill } from "./shared-current-projection-write.ts"
import { queryCurrentSourceTargetPages } from "./shared-current-source-management.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import type { SharedSourcePlanOptions } from "./shared-source-plan.ts"
import { sha256 } from "./store.ts"

const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_PROJECTION_RESTORE_CONFLICT", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The exact Skill restoration is invalid."),
  })
const binding = ({ file_id, page_id, path, content }: CurrentFileBinding) => ({
  file_id,
  page_id,
  path,
  content,
})
// Only a known successful untrash can wait for its live identity query to catch up.
// These read-only waits spend the same invocation deadline and never replay the PATCH.
const restoreVisibilityWaits = [1000, 2000, 4000, 8000] as const
type RestoreReadPurpose = "guard" | "successful_untrash"

/** Restore only the existing owner, then run the normal complete reading projection.
 * The two finite intents share the invocation budget, not a second journal or history. */
export function restoreCurrentSkillProjection(
  library: SharedLibrary,
  input: {
    readonly target: string
    readonly include?: readonly string[]
    readonly exclude?: readonly string[]
    readonly sourceOptions?: SharedSourcePlanOptions
  },
) {
  return Effect.gen(function* () {
    const { target, policy } = yield* checked(() => {
      const target = pageId(input.target)
      if (target === undefined) throw invalid("Restore one exact Skill page ID or Notion URL.")
      return { target, policy: currentProjectionPolicy(input) }
    })
    const api = yield* Notion
    const read = (purpose: RestoreReadPurpose = "guard") =>
      Effect.gen(function* () {
        const raw = property(yield* api.request(`v1/pages/${target}`))
        const trashed = raw.in_trash === true || raw.archived === true || raw.is_archived === true
        // This normalization admits only owner metadata, never a Files inventory.
        // Ordinary index and body readers still require the real live page.
        const owner = yield* readCurrentSkillMetadata(library, target, {
          ...raw,
          in_trash: false,
          archived: false,
          is_archived: false,
        })
        if (owner.state.state !== "ready")
          return yield* Effect.fail(invalid("Restore requires a ready Skill without content work."))
        const live = (yield* queryCurrentSourceTargetPages(library, {
          skillIds: [owner.skill_id],
        })).get(owner.skill_id)
        if (
          (live !== undefined && live.page_id !== target) ||
          (!trashed && live === undefined && purpose === "guard")
        )
          return yield* Effect.fail(
            invalid("The stable Skill identity belongs to a different or unavailable live page."),
          )
        return { owner, trashed, indexed: live !== undefined }
      })
    const initial = yield* read()
    const pending = yield* readCurrentOperationIntent(library, {
      kind: "skill",
      id: initial.owner.skill_id,
    })
    if (
      pending !== undefined &&
      !("restore" in pending.intent) &&
      (!("projection" in pending.intent) || initial.trashed)
    )
      return yield* Effect.fail(
        currentOperationFailure(
          invalid(
            "Restore cannot take over unfinished content or a projection whose page was subsequently trashed.",
            { restore_blocked: true },
          ),
          pending.intent,
          null,
          target,
        ),
      )
    const frozen = pending !== undefined && "restore" in pending.intent ? pending.intent : undefined
    let restoration:
      | { readonly status: "restored"; readonly operation_id: string }
      | { readonly status: "unchanged" } = {
      status: "unchanged",
    }
    if (initial.trashed || frozen !== undefined) {
      const fingerprint = (owner: typeof initial.owner) =>
        Effect.gen(function* () {
          // Files relations to a trashed owner are not visible in Notion. Freeze
          // the independently available Source contribution and owner only;
          // normal projection checks the complete live tree after restoration.
          const consumption = yield* resolveCurrentSourceConsumption(library, owner.skill_id, {
            sourceOptions: input.sourceOptions,
          })
          if (
            owner.main.content.kind === "source" &&
            canonicalSharedJson(
              consumption.files.find((file) => file.path === owner.main.path)?.content,
            ) !== canonicalSharedJson(owner.main.content)
          )
            return yield* Effect.fail(invalid("The main no longer matches its current Source."))
          return yield* sha256(
            canonicalSharedJson({
              purpose: "restore_current_skill",
              version: 2,
              skill_id: owner.skill_id,
              page_id: target,
              kind: owner.kind,
              main: binding(owner.main),
              source_consumption: {
                files: consumption.files,
                source_fingerprint: consumption.source_fingerprint,
              },
              policy,
            }),
          )
        })
      const input_sha256 = yield* fingerprint(initial.owner).pipe(
        Effect.mapError((error) =>
          frozen === undefined ? error : currentOperationFailure(error, frozen, null, target),
        ),
      )
      if (
        frozen !== undefined &&
        (frozen.restore.page_id !== target ||
          frozen.input_sha256 !== input_sha256 ||
          canonicalSharedJson(frozen.restore.policy) !== canonicalSharedJson(policy))
      )
        return yield* Effect.fail(
          currentOperationFailure(
            invalid("The current Skill or reading policy differs from the unfinished restoration."),
            frozen,
            null,
            target,
          ),
        )
      const operation_id =
        frozen?.operation_id ??
        (yield* (yield* Crypto.Crypto)
          .randomUUIDv4()
          .pipe(Effect.mapError(() => fail("CRYPTO_ERROR", "Cannot identify Skill restoration."))))
      const intent: CurrentSkillRestoreIntent = {
        operation_id,
        input_sha256,
        owner: { kind: "skill", id: initial.owner.skill_id },
        restore: { page_id: target, policy },
      }
      const assertCurrent = (purpose: RestoreReadPurpose = "guard") =>
        Effect.gen(function* () {
          const current = yield* read(purpose)
          if ((yield* fingerprint(current.owner)) !== input_sha256)
            return yield* Effect.fail(invalid("The current Skill changed during restoration."))
          return current
        })
      yield* withCurrentOperation(library, {
        intent,
        // The finite Record may exist before the trashed page can be related to it.
        // Bind only this same physical page after its live state is observed.
        ownerPageId: null,
        mode: frozen === undefined ? "apply" : "resume",
        beforeMutation: assertCurrent().pipe(Effect.asVoid),
        run: (session) =>
          Effect.gen(function* () {
            if (session.ownerPageId === null) yield* session.activate()
            yield* session.dispatch({
              key: "$owner.restore",
              replay: "idempotent",
              request: {
                path: `v1/pages/${target}`,
                body: { in_trash: false },
                options: { method: "PATCH" },
              },
              observe: () =>
                assertCurrent().pipe(
                  Effect.map((current) =>
                    current.trashed
                      ? ({ status: "missing" } as const)
                      : ({ status: "complete", value: undefined } as const),
                  ),
                ),
              acknowledge: () =>
                Effect.gen(function* () {
                  const budget = yield* RequestBudget
                  for (let attempt = 0; ; attempt += 1) {
                    // Each observation still checks the exact owner, complete unique
                    // identity query, Source readiness and the frozen fingerprint.
                    const current = yield* assertCurrent("successful_untrash")
                    if (current.trashed)
                      return yield* Effect.fail(
                        invalid("The restored Skill has not been observed live."),
                      )
                    if (current.indexed) return
                    const wait = restoreVisibilityWaits[attempt]
                    if (wait === undefined)
                      return yield* Effect.fail(
                        invalid(
                          "The restored Skill is still unavailable in its live identity query.",
                        ),
                      )
                    yield* budget.check
                    yield* withinRequestBudget(Effect.sleep(wait), budget)
                  }
                }),
            })
            if (session.ownerPageId === null) yield* session.bindOwner(target)
            else if (session.ownerPageId !== target)
              return yield* Effect.fail(invalid("Restoration changed its exact Skill page."))
          }),
        verify: () =>
          assertCurrent().pipe(
            Effect.flatMap((current) =>
              current.trashed
                ? Effect.fail(invalid("The restored Skill has not been observed live."))
                : Effect.void,
            ),
          ),
      })
      restoration = { status: "restored", operation_id }
    }
    const projection = yield* projectCurrentSkill(library, {
      target,
      mode: "auto",
      ...policy,
      sourceOptions: input.sourceOptions,
    }).pipe(
      Effect.mapError((error) => {
        const details = property(error.details)
        // A read or budget failure can occur after the restoration retired but
        // before projection acquired an intent. Preserve this public command's
        // coordinates without inventing an operation or taking over another one.
        return details.owner !== undefined
          ? error
          : fail(error.code, error.message, {
              ...details,
              restore: true,
              skill_page_id: target,
              projection_policy: policy,
            })
      }),
    )
    return {
      ...projection,
      status:
        restoration.status === "restored" && projection.status === "unchanged"
          ? ("applied" as const)
          : projection.status,
      restoration,
    }
  }).pipe(
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}
