import { Effect, Layer } from "effect"
import { Store } from "@notion-skills-cli/core"
import { UpstreamState } from "../../core/src/upstream-state.ts"
import { UpstreamPublisherLive } from "../../core/src/upstream-publication.ts"
import { live } from "./runtime.ts"

export { localRuntime, storeRuntime, live } from "./runtime.ts"
export const upstreamLive = UpstreamPublisherLive.pipe(
  Layer.provideMerge(
    Layer.effect(
      UpstreamState,
      Effect.map(Store, (store) => store.upstream),
    ).pipe(Layer.provideMerge(live)),
  ),
)
