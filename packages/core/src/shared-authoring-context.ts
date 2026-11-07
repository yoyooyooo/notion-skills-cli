import { Context, Effect, Option } from "effect"
import { fail, SkillsError, SnapshotSchema, type Snapshot } from "./model.ts"
import { pageId, parseTarget } from "./ref.ts"
import { Store } from "./store.ts"

/** Explicit authoring admits one exact native owner, never its linked targets. */
class SharedAuthoringTarget extends Context.Service<
  SharedAuthoringTarget,
  { readonly page_id: string }
>()("ntn-skills/SharedAuthoringTarget") {}

export function isSharedAuthoringTarget(selected: string) {
  return Effect.serviceOption(SharedAuthoringTarget).pipe(
    Effect.map((current) => Option.isSome(current) && current.value.page_id === selected),
  )
}

export function withSharedAuthoringTarget<A, E, R>(
  selected: string,
  effect: Effect.Effect<A, E, R>,
) {
  return pageId(selected) === selected
    ? effect.pipe(Effect.provideService(SharedAuthoringTarget, { page_id: selected }))
    : Effect.fail(fail("EXACT_TARGET_REQUIRED", "Authoring requires an exact native page."))
}

/** Existing mutation entrypoints already express author intent. Resolve only
 * their exact page or retained pin; names never broaden the disabled scope. */
export function withSharedAuthoringRequest<A, E, R>(
  input: string | Snapshot,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    let selected: string | undefined
    if (typeof input === "string") {
      const target = yield* Effect.try({
        try: () => parseTarget(input),
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("INVALID_TARGET", "The authoring target could not be decoded."),
      })
      selected = pageId(target.selector)
      if (target.snapshot) {
        const snapshot = yield* (yield* Store).readJson(
          `snapshots/${target.snapshot}.json`,
          SnapshotSchema,
        )
        if (snapshot?.record.locator.type === "shared_skill")
          selected = snapshot.record.locator.page_id
      }
    } else if (input.record.locator.type === "shared_skill") selected = input.record.locator.page_id
    return yield* selected === undefined ? effect : withSharedAuthoringTarget(selected, effect)
  })
}
