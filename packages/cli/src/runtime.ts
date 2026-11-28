import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Context, Layer, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NotionLive } from "../../core/src/notion.ts"
import { StoreLive } from "../../core/src/store.ts"
import { IndependentByteReadRuntime } from "../../core/src/shared-immutable-read.ts"
import { FixedGitObjectReaderLive } from "../../core/src/shared-fixed-git-transport.ts"
import { GhCredentialLive } from "../../core/src/github-api-access.ts"
import { SourceRefAccessContext } from "../../core/src/shared-source-ref-cache.ts"

/** Explicit child environments keep their policy; inherited children use this operation's snapshot. */
function withEnvironment(
  command: ChildProcess.Command,
  environment: Readonly<Record<string, string | undefined>>,
): ChildProcess.Command {
  if (command._tag === "PipedCommand")
    return ChildProcess.pipeTo(
      withEnvironment(command.left, environment),
      withEnvironment(command.right, environment),
      command.options,
    )
  const options = command.options
  return ChildProcess.make(command.command, command.args, {
    ...options,
    env: options.extendEnv
      ? { ...environment, ...options.env }
      : (options.env ?? { ...environment }),
    extendEnv: false,
  })
}

/** CLI and SDK share services; captured cwd/env belong only to this operation. */
export function nodeRuntime(cwd?: string, env?: Readonly<Record<string, string | undefined>>) {
  const environment = { ...(env ?? process.env) }
  const local = NodeServices.layer.pipe(
    Layer.flatMap((services) => {
      let scoped = services
      if (cwd !== undefined) {
        const native = Context.get(services, Path.Path)
        const path = Path.make({
          ...native,
          resolve: (...parts) => native.resolve(cwd, ...parts),
          relative: (from, to) =>
            native.relative(native.resolve(cwd, from), native.resolve(cwd, to)),
          toFileUrl: (input) => native.toFileUrl(native.resolve(cwd, input)),
        })
        scoped = Context.add(scoped, Path.Path, path)
      }
      const native = Context.get(services, ChildProcessSpawner.ChildProcessSpawner)
      scoped = Context.add(
        scoped,
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => native.spawn(withEnvironment(command, environment))),
      )
      return Layer.succeedContext(scoped)
    }),
  )
  const scopedLocal = Layer.merge(
    local,
    Layer.succeed(SourceRefAccessContext, { cwd: cwd ?? process.cwd(), environment }),
  )
  const store = StoreLive.pipe(Layer.provideMerge(scopedLocal))
  const platform = Layer.mergeAll(
    store,
    NodeHttpClient.layerFetch,
    Layer.succeed(IndependentByteReadRuntime, true),
    FixedGitObjectReaderLive.pipe(Layer.provide(local)),
    GhCredentialLive.pipe(Layer.provide(local)),
  )
  return { local: scopedLocal, store, live: NotionLive.pipe(Layer.provideMerge(platform)) }
}

const runtime = nodeRuntime()
export const localRuntime = runtime.local
export const storeRuntime = runtime.store
export const live = runtime.live
