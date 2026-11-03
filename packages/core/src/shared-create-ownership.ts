import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import type { SharedCreatePlan } from "./shared-create-model.ts"
import type { SharedCreateBinding } from "./shared-create-outcome.ts"
import { Store } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Operation = Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u))
const Page = Schema.String.check(Schema.isUUID())
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))

/** Only original POST acknowledgements confer ownership. Records remain history. */
export const SharedCreateOwnershipSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Hash,
  operation_id: Operation,
  library_id: Identity,
  skill_id: Identity,
  skill_page_id: Page,
  coverage: Schema.Literal("created_native_content_pages"),
  created_page_ids: Schema.Array(Page),
  created_pages: Schema.Array(
    Schema.Struct({
      page_id: Page,
      kind: Schema.Literals(["skill", "file"]),
      database_id: Page,
      data_source_id: Page,
      file_id: Identity,
    }),
  ),
})
export type SharedCreateOwnership = typeof SharedCreateOwnershipSchema.Type

export function sharedCreateOwnershipKey(scope: string, operationId: string) {
  return Effect.try({
    try: () => {
      Schema.decodeUnknownSync(Hash)(scope)
      Schema.decodeUnknownSync(Operation)(operationId)
      return `operations/shared-native-create-owned/${scope}/${operationId}.json`
    },
    catch: () =>
      fail(
        "OWNERSHIP_RECEIPT_INVALID",
        "Select an exact credential scope and native create operation.",
      ),
  })
}

function validate(receipt: SharedCreateOwnership, scope: string, operationId: string) {
  const ids = receipt.created_pages.map((page) => page.page_id)
  const skills = receipt.created_pages.filter((page) => page.kind === "skill")
  if (
    receipt.scope !== scope ||
    receipt.operation_id !== operationId ||
    ids.length === 0 ||
    ids.length > 10_000 ||
    new Set(ids).size !== ids.length ||
    skills.length !== 1 ||
    skills[0]?.page_id !== receipt.skill_page_id ||
    canonicalSharedJson(ids) !== canonicalSharedJson(receipt.created_page_ids)
  )
    throw fail(
      "OWNERSHIP_RECEIPT_INVALID",
      "The native ownership receipt differs from its original scope or page set.",
    )
  return receipt
}

/** Missing historical receipts never infer ownership from names or current pages. */
export function loadSharedCreateOwnership(scope: string, operationId: string) {
  return Effect.gen(function* () {
    const key = yield* sharedCreateOwnershipKey(scope, operationId)
    const receipt = yield* (yield* Store).readJson(key, SharedCreateOwnershipSchema)
    if (receipt === undefined) return undefined
    return yield* Effect.try({
      try: () => validate(receipt, scope, operationId),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("OWNERSHIP_RECEIPT_INVALID", "Invalid native ownership receipt."),
    })
  })
}

/** Called only after exact completion, while the original marked dispatch remains. */
export function saveSharedCreateOwnership(
  scope: string,
  plan: SharedCreatePlan,
  bindings: readonly SharedCreateBinding[],
) {
  return Effect.gen(function* () {
    const root = bindings.find((binding) => binding.path === plan.entrypoint)
    if (!root || bindings.length !== plan.files.length)
      return yield* Effect.fail(
        fail(
          "OWNERSHIP_RECEIPT_INVALID",
          "Completed creation lacks its exact acknowledged page set.",
        ),
      )
    const created = bindings
      .map((binding) => {
        const kind = binding.path === plan.entrypoint ? ("skill" as const) : ("file" as const)
        const table = kind === "skill" ? plan.library.skills : plan.library.files
        return {
          page_id: binding.page_id,
          kind,
          database_id: table.database_id,
          data_source_id: table.data_source_id,
          file_id: binding.file_id,
        }
      })
      .sort((left, right) => left.page_id.localeCompare(right.page_id))
    const receipt = yield* Effect.try({
      try: () =>
        validate(
          Schema.decodeUnknownSync(SharedCreateOwnershipSchema)({
            version: 1,
            scope,
            operation_id: plan.operation_id,
            library_id: plan.library.library_id,
            skill_id: plan.skill_id,
            skill_page_id: root.page_id,
            coverage: "created_native_content_pages",
            created_page_ids: created.map((page) => page.page_id),
            created_pages: created,
          }),
          scope,
          plan.operation_id,
        ),
      catch: () =>
        fail(
          "OWNERSHIP_RECEIPT_INVALID",
          "Completed creation has invalid acknowledged ownership evidence.",
        ),
    })
    const existing = yield* loadSharedCreateOwnership(scope, plan.operation_id)
    if (existing !== undefined) {
      if (canonicalSharedJson(existing) !== canonicalSharedJson(receipt))
        return yield* Effect.fail(
          fail("STATE_CONFLICT", "An existing native ownership receipt cannot be overwritten."),
        )
      return existing
    }
    yield* (yield* Store).writeJson(
      yield* sharedCreateOwnershipKey(scope, plan.operation_id),
      receipt,
    )
    return receipt
  })
}
