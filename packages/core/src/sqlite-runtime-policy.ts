import { Effect } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { fail, type SkillsError } from "./model.ts"

export const SUPPORTED_NODE_RANGE = "^22.22.3 || >=24.20.0"

const versionParts = (value: string): readonly [number, number, number] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) return undefined
  const parts = match.slice(1).map(Number)
  if (!parts.every(Number.isSafeInteger)) return undefined
  return parts as [number, number, number]
}

export const isSupportedNodeVersion = (value: string): boolean => {
  const parts = versionParts(value.replace(/^v/, ""))
  if (!parts) return false
  const [major, minor, patch] = parts
  return (
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 3))) ||
    major > 24 ||
    (major === 24 && minor >= 20)
  )
}

/** SQLite's official WAL-reset fixes: 3.51.3 onward in major 3, and
 * maintenance backports 3.50.7 and 3.44.6. Unknown major/vendor suffixes
 * require a new policy review, rather than assuming they contain the fix.
 * https://sqlite.org/wal.html#the_wal_reset_bug
 */
export const isWalSafeSqliteVersion = (value: string): boolean => {
  const parts = versionParts(value)
  if (!parts) return false
  const [major, minor, patch] = parts
  return (
    major === 3 &&
    (minor > 51 ||
      (minor === 51 && patch >= 3) ||
      (minor === 50 && patch >= 7) ||
      (minor === 44 && patch >= 6))
  )
}

export const assertSqliteRuntime: Effect.Effect<string, SkillsError, SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ version: string }>`SELECT sqlite_version() AS version`.pipe(
      Effect.mapError(() =>
        fail("STATE_RUNTIME_UNSUPPORTED", "Unable to establish the SQLite runtime version."),
      ),
    )
    const version = rows.length === 1 ? rows[0]?.version : undefined
    if (typeof version !== "string" || !isWalSafeSqliteVersion(version)) {
      return yield* Effect.fail(
        fail("STATE_RUNTIME_UNSUPPORTED", "SQLite must include the official WAL-reset fix.", {
          sqlite_version: version ?? null,
          reference: "https://sqlite.org/wal.html#the_wal_reset_bug",
        }),
      )
    }
    return version
  })

/** Run before opening any state file. The official driver's in-memory
 * connection has WAL disabled and is closed by Scope on success or failure.
 */
export const probeSqliteRuntime: Effect.Effect<string, SkillsError> = Effect.suspend(() => {
  if (
    typeof process === "undefined" ||
    process.versions.bun ||
    !isSupportedNodeVersion(process.versions.node)
  ) {
    return Effect.fail(
      fail("STATE_RUNTIME_UNSUPPORTED", `State storage requires Node ${SUPPORTED_NODE_RANGE}.`, {
        node: typeof process === "undefined" ? null : process.versions.node,
      }),
    )
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const { SqliteClient } = yield* Effect.tryPromise({
        try: () => import("@effect/sql-sqlite-node"),
        catch: () =>
          fail("STATE_RUNTIME_UNSUPPORTED", "Unable to load the official SQLite runtime driver."),
      })
      const sql = yield* SqliteClient.make({ filename: ":memory:", disableWAL: true }).pipe(
        Effect.mapError(() =>
          fail("STATE_RUNTIME_UNSUPPORTED", "Unable to open the official SQLite runtime probe."),
        ),
      )
      return yield* assertSqliteRuntime.pipe(Effect.provideService(SqlClient.SqlClient, sql))
    }),
  ).pipe(Effect.provide(Reactivity.layer))
})
