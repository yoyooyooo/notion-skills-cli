import { Crypto, Effect, FileSystem, Option, Path } from "effect"
import type { HttpClient } from "effect/http"
import { fail, property, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { RequestBudget } from "../src/request-budget.ts"
import { Store } from "../src/store.ts"
import { id, library, sharedSnapshotFixture } from "./shared-snapshot-fixture.ts"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function auditFixture(fileCount = 3) {
  const root = await mkdtemp(join(tmpdir(), "ntn-audit-test-"))
  const fixture = sharedSnapshotFixture({ fileCount })
  property(fixture.main.properties).tags = { id: "tags", type: "multi_select", multi_select: [] }
  await fixture.open()
  fixture.clearCalls()
  const ledger: Array<{ path: string; body: unknown; method: string }> = []
  let credential = "controlled-credential"
  let origin = "https://api.notion.test",
    version = "2025-09-03"
  let intercept:
    | ((path: string, body: unknown) => Effect.Effect<unknown, SkillsError> | undefined)
    | undefined
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Notion | Store | Crypto.Crypto | FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
    >,
  ) =>
    fixture.run(
      Effect.gen(function* () {
        const original = yield* Notion
        const api: Notion["Service"] = {
          ...original,
          credentialIdentity: Effect.sync(() => credential),
          apiOrigin: origin,
          version: Effect.sync(() => version),
          requestMetrics: fixture.requestMetrics,
          request: (path, body, options) =>
            Effect.gen(function* () {
              const selected = Option.getOrUndefined(yield* Effect.serviceOption(RequestBudget))
              if (selected)
                yield* selected.admit(
                  body === undefined ? 0 : new TextEncoder().encode(JSON.stringify(body)).length,
                )
              ledger.push({
                path,
                body,
                method: options?.method ?? (body === undefined ? "GET" : "POST"),
              })
              const value = yield* intercept?.(path, body) ??
                original.request(
                  path,
                  path.startsWith(`v1/data_sources/${library.records.data_source_id}/query`) &&
                    body !== undefined &&
                    typeof body === "object" &&
                    body !== null &&
                    !("filter" in body)
                    ? { ...body, filter: { and: [] } }
                    : body,
                  options,
                )
              const response = path === "v1/users/me" ? { object: "user", id: id(9000) } : value
              selected?.responseBytes(new TextEncoder().encode(JSON.stringify(response)).length)
              return response
            }),
        }
        const store = yield* Store
        return yield* effect.pipe(
          Effect.provideService(Notion, api),
          Effect.provideService(Store, { ...store, root }),
        )
      }),
    )
  return {
    ...fixture,
    run,
    ledger,
    credential: (value: string) => {
      credential = value
    },
    endpoint: (value: { readonly origin?: string; readonly version?: string }) => {
      origin = value.origin ?? origin
      version = value.version ?? version
    },
    intercept: (value: typeof intercept) => {
      intercept = value
    },
    deny: (path: string) => {
      intercept = (actual) =>
        actual === path
          ? Effect.fail(fail("ACCESS_DENIED", "Controlled permission denial."))
          : undefined
    },
    clearLedger: () => {
      ledger.length = 0
      fixture.clearCalls()
    },
  }
}
