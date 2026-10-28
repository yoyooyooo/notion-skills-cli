import { SqliteClient } from "@effect/sql-sqlite-node"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { Effect } from "effect"
import {
  assertSqliteRuntime,
  isSupportedNodeVersion,
  isWalSafeSqliteVersion,
  probeSqliteRuntime,
} from "../src/sqlite-runtime-policy.ts"

test("WAL fixes compare numeric release components and include only documented branches", () => {
  for (const version of [
    "3.44.6",
    "3.44.10",
    "3.50.7",
    "3.50.10",
    "3.51.3",
    "3.51.10",
    "3.52.0",
    "3.100.0",
  ]) {
    expect(isWalSafeSqliteVersion(version), version).toBe(true)
  }
  for (const version of [
    "3.44.5",
    "3.45.9",
    "3.49.99",
    "3.50.6",
    "3.51.2",
    "3.9.99",
    "4.0.0",
    "3.51.3-vendor",
    "3.51",
    "3.51.3.1",
    " 3.51.3",
    "3.51.9007199254740992",
  ]) {
    expect(isWalSafeSqliteVersion(version), version).toBe(false)
  }
})

test("Node supports maintained fixed minimum lines", () => {
  for (const version of ["22.22.3", "v22.22.3", "22.23.0", "24.20.0", "25.0.0"])
    expect(isSupportedNodeVersion(version), version).toBe(true)
  for (const version of ["22.19.0", "22.22.2", "23.99.0", "24.19.9", "22.22.3-vendor", "invalid"])
    expect(isSupportedNodeVersion(version), version).toBe(false)
})

test("actual official SQLite runtime passes scoped preflight", async () => {
  const version = await Effect.runPromise(probeSqliteRuntime)
  expect(isWalSafeSqliteVersion(version)).toBe(true)
})

test("official probe has no WAL and Scope releases its connection", async () => {
  const sql = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* SqliteClient.make({ filename: ":memory:", disableWAL: true })
        const mode = yield* client<{ journal_mode: string }>`PRAGMA journal_mode`
        expect(mode[0]?.journal_mode).toBe("memory")
        yield* assertSqliteRuntime.pipe(Effect.provideService(SqlClient.SqlClient, client))
        return client
      }),
    ).pipe(Effect.provide(Reactivity.layer)),
  )
  const result = await Effect.runPromise(
    Effect.result(assertSqliteRuntime.pipe(Effect.provideService(SqlClient.SqlClient, sql))),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("STATE_RUNTIME_UNSUPPORTED")
})
