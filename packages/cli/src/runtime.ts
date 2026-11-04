import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Context, Layer, Path } from "effect"
import { NotionLive } from "../../core/src/notion.ts"
import { StoreLive } from "../../core/src/store.ts"
import { SyncLocalLive } from "../../core/src/sync-local.ts"

/** CLI and SDK use the same services. A captured cwd belongs to one SDK operation. */
export function nodeRuntime(cwd?: string) {
  const local =
    cwd === undefined
      ? NodeServices.layer
      : NodeServices.layer.pipe(
          Layer.flatMap((services) => {
            const native = Context.get(services, Path.Path)
            const path = Path.make({
              ...native,
              resolve: (...parts) => native.resolve(cwd, ...parts),
              relative: (from, to) =>
                native.relative(native.resolve(cwd, from), native.resolve(cwd, to)),
              toFileUrl: (input) => native.toFileUrl(native.resolve(cwd, input)),
            })
            return Layer.succeedContext(Context.add(services, Path.Path, path))
          }),
        )
  const store = StoreLive.pipe(Layer.provideMerge(local))
  const platform = Layer.mergeAll(
    store,
    NodeHttpClient.layerFetch,
    SyncLocalLive.pipe(Layer.provide(local)),
  )
  return { local, store, live: NotionLive.pipe(Layer.provideMerge(platform)) }
}

const runtime = nodeRuntime()
export const localRuntime = runtime.local
export const storeRuntime = runtime.store
export const live = runtime.live
