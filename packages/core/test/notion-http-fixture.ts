import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { decode } from "../src/model.ts"
import { NotionTransport } from "../src/notion.ts"
import { NotionCredentialProviderLive } from "../src/notion-credential.ts"
import { makeRequestScheduler, NotionRequestScheduler } from "../src/notion-request-scheduler.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

export const fixtureToken = "owned_http_fixture_token"
function storeLayer(token: () => string | undefined) {
  return Layer.succeed(Store, {
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    root: "/http-fixture",
    configRoot: "/http-fixture",
    cacheRoot: "/http-fixture",
    reserveCacheGeneration: () => Effect.succeed(1),
    listKeys: () => Effect.succeed([]),
    retireKeys: () => Effect.succeed([]),
    readJson: (_key, schema) => Effect.sync(() => decode(schema, { token: token() })),
    writeJson: () => Effect.void,
    readBytes: () => Effect.succeed(new Uint8Array()),
    writeBytes: () => Effect.void,
    output: () => Effect.succeed({ output: "", reused: false }),
  })
}

export function runtime(
  origin: string,
  options: {
    token?: () => string | undefined
    config?: Record<string, string>
    fileSystem?: FileSystem.FileSystem
    intervalMs?: number
  } = {},
) {
  const state = new Map<string, number>()
  const scheduler = Layer.effect(
    NotionRequestScheduler,
    makeRequestScheduler(
      {
        claim: (key, now, interval) =>
          Effect.sync(() => {
            const at = state.get(key) ?? 0
            if (now < at) return { admitted: false, at }
            state.set(key, now + interval)
            return { admitted: true }
          }),
        defer: (key, until) =>
          Effect.sync(() => {
            state.set(key, Math.max(state.get(key) ?? 0, until))
          }),
      },
      { intervalMs: options.intervalMs },
    ),
  )
  return NotionTransport.pipe(
    Layer.provide(NotionCredentialProviderLive),
    Layer.provide(scheduler),
    Layer.provide(storeLayer(options.token ?? (() => fixtureToken))),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          NOTION_API_BASE_URL: origin,
          NTN_SKILLS_REQUEST_TIMEOUT_MS: "10000",
          ...options.config,
        }),
      ),
    ),
    Layer.provide(
      options.fileSystem
        ? Layer.merge(NodeServices.layer, Layer.succeed(FileSystem.FileSystem, options.fileSystem))
        : NodeServices.layer,
    ),
  )
}

export async function localServer<A>(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
  use: (origin: string) => Promise<A>,
): Promise<A> {
  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No loopback address")
  try {
    return await use(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}
export function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, { "content-type": "application/json", ...headers })
  response.end(JSON.stringify(value))
}
