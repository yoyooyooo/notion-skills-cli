import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { NotionLive, StoreLive, Store, SyncLocalLive } from "@notion-skills-cli/core"
import { UpstreamState } from "../../core/src/upstream-state.ts"
import { UpstreamPublisherLive } from "../../core/src/upstream-publication.ts"

export const localRuntime = NodeServices.layer
export const storeRuntime = StoreLive.pipe(Layer.provideMerge(localRuntime))
const platform = Layer.mergeAll(
  storeRuntime,
  NodeHttpClient.layerFetch,
  SyncLocalLive.pipe(Layer.provide(localRuntime)),
)
export const live = NotionLive.pipe(Layer.provideMerge(platform))
export const upstreamLive = UpstreamPublisherLive.pipe(
  Layer.provideMerge(
    Layer.effect(
      UpstreamState,
      Effect.map(Store, (store) => store.upstream),
    ).pipe(Layer.provideMerge(live)),
  ),
)
