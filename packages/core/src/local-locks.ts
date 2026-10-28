import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, FileSystem, Option, Path, PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { lstat, type BigIntStats } from "node:fs"
import { hostname } from "node:os"
import { fail, property, SkillsError } from "./model.ts"

const asError = (error: unknown) => {
  if (error instanceof SkillsError) return error
  const cause = PlatformError.isPlatformError(error) ? error.reason.cause : error
  const code =
    cause !== null && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined
  return fail("STORAGE_ERROR", "The local retention or lock operation failed.", {
    syscall_code: code,
  })
}

const retain = (location: string, spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  Effect.gen(function* () {
    const unavailable = fail(
      "RETENTION_UNAVAILABLE",
      "The /usr/bin/trash capability is required; bytes have been retained in place.",
      { path: location },
    )
    if (process.platform !== "darwin")
      return yield* Effect.fail(
        fail(
          "RETENTION_UNAVAILABLE",
          "System Trash is required; bytes have been retained in place.",
          { path: location },
        ),
      )
    // FileSystem.access has no executable-access option. The official process
    // service preserves the X_OK preflight without another host filesystem API.
    const executable = yield* spawner
      .exitCode(
        ChildProcess.make("/bin/test", ["-x", "/usr/bin/trash"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.mapError(() => unavailable))
    if (executable !== 0) return yield* Effect.fail(unavailable)
    const failed = fail(
      "RETENTION_FAILED",
      "System Trash failed; retained bytes remain available.",
      {
        path: location,
      },
    )
    const exit = yield* spawner
      .exitCode(
        ChildProcess.make("/usr/bin/trash", [location], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.mapError(() => failed))
    if (exit !== 0) return yield* Effect.fail(failed)
  })

/** System Trash, never unlink/rm. No Store dependency, including transitively. */
export const trashPath = (location: string): Effect.Effect<void, SkillsError> =>
  Effect.gen(function* () {
    return yield* retain(location, yield* ChildProcessSpawner.ChildProcessSpawner)
  }).pipe(Effect.provide(NodeServices.layer))

// FileSystem.stat follows symlinks and has no no-follow option. This host
// primitive preserves exact bigint metadata for fence and local-path proofs.
export const lstatNoFollow = (
  location: string,
): Effect.Effect<BigIntStats | undefined, SkillsError> =>
  Effect.callback<BigIntStats | undefined, SkillsError>((resume) => {
    lstat(location, { bigint: true }, (error, info) => {
      resume(
        error
          ? error.code === "ENOENT"
            ? Effect.succeed(undefined)
            : Effect.fail(asError(error))
          : Effect.succeed(info),
      )
    })
  })

const fenceIdentity = (location: string) =>
  lstatNoFollow(location).pipe(
    Effect.flatMap((info) =>
      info === undefined ? Effect.fail(asError({ code: "ENOENT" })) : Effect.succeed(info),
    ),
  )

/** Cross-process locks protect cooperating local writers. Released/dead directories
 * are retained, receipts never removed. ESRCH on this host is the only dead-owner
 * proof; PID reuse and uncertain host identity conservatively remain fenced. A
 * crash before owner publication or during recovery needs operator inspection of
 * receipts and retention of the unidentified fence; it is never guessed dead.
 */
export function withLocalLocks<T, E, R>(
  stateRoot: string,
  keys: readonly string[],
  effect: Effect.Effect<T, E, R>,
): Effect.Effect<T, E | SkillsError, R> {
  return Effect.scoped(
    Effect.gen(function* () {
      const suppliedSpawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner)
      // Capture host services only for lock IO. The caller's Effect keeps its own
      // runtime services, and each acquired fence belongs to this outer Scope.
      const acquire = yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const crypto = yield* Crypto.Crypto
        const spawner = Option.isSome(suppliedSpawner)
          ? suppliedSpawner.value
          : yield* ChildProcessSpawner.ChildProcessSpawner
        const locksRoot = path.join(stateRoot, "sync", "locks")
        yield* fs.makeDirectory(locksRoot, { recursive: true, mode: 0o700 })
        const release = (location: string) =>
          Effect.gen(function* () {
            const retired = `${location}.${yield* crypto.randomUUIDv4()}.released`
            yield* fs.rename(location, retired)
            // Retirement released the key. Trash failure keeps owned history
            // retained in state and does not affect the completed operation.
            if (process.platform === "darwin")
              yield* retain(retired, spawner).pipe(Effect.catch(() => Effect.void))
          }).pipe(Effect.mapError(asError), Effect.orDie)
        return (key: string) =>
          Effect.gen(function* () {
            const hash = yield* crypto.digest("SHA-256", new TextEncoder().encode(key))
            const location = path.join(
              locksRoot,
              Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""),
            )
            yield* Effect.acquireRelease(
              fs.makeDirectory(location, { mode: 0o700 }).pipe(
                Effect.catch(
                  (error): Effect.Effect<void, SkillsError | PlatformError.PlatformError> => {
                    if (error.reason._tag !== "AlreadyExists") return Effect.fail(error)
                    return Effect.gen(function* () {
                      const identity = yield* fenceIdentity(location)
                      const owner = yield* fs
                        .readFileString(path.join(location, "owner.json"))
                        .pipe(
                          Effect.flatMap((text) =>
                            Effect.try(() => {
                              const raw = property(JSON.parse(text))
                              return {
                                ...(typeof raw.pid === "number" &&
                                Number.isSafeInteger(raw.pid) &&
                                raw.pid > 0
                                  ? { pid: raw.pid }
                                  : {}),
                                same_host: raw.host === hostname(),
                              }
                            }),
                          ),
                          // Invalid, unreadable, or unknown owners remain fenced.
                          Effect.catch(() =>
                            Effect.succeed<{ pid?: number; same_host?: boolean }>({}),
                          ),
                        )
                      const dead = yield* Effect.sync(() => {
                        if (owner.same_host && owner.pid !== undefined) {
                          try {
                            process.kill(owner.pid, 0)
                          } catch (error) {
                            return (
                              error !== null &&
                              typeof error === "object" &&
                              "code" in error &&
                              error.code === "ESRCH"
                            )
                          }
                        }
                        return false
                      })
                      if (!dead)
                        return yield* Effect.fail(
                          fail("SYNC_LOCKED", "A live or unidentifiable process owns this fence.", {
                            key,
                            lock_path: location,
                            owner,
                          }),
                        )
                      // The exclusive recovery claim belongs to the exact stale
                      // inode; unidentifiable claims and all receipts stay retained.
                      yield* fs
                        .makeDirectory(path.join(location, "recovery"), { mode: 0o700 })
                        .pipe(
                          Effect.mapError(() =>
                            fail("SYNC_LOCKED", "Another process is retaining the dead lock.", {
                              key,
                              lock_path: location,
                            }),
                          ),
                        )
                      const latest = yield* fenceIdentity(location)
                      if (latest.dev !== identity.dev || latest.ino !== identity.ino)
                        return yield* Effect.fail(
                          fail("SYNC_LOCKED", "Lock identity changed during recovery.", { key }),
                        )
                      yield* fs.rename(
                        location,
                        `${location}.${yield* crypto.randomUUIDv4()}.crashed`,
                      )
                      yield* fs.makeDirectory(location, { mode: 0o700 }).pipe(
                        Effect.mapError(() =>
                          fail("SYNC_LOCKED", "Another process acquired the recovered fence.", {
                            key,
                          }),
                        ),
                      )
                    })
                  },
                ),
                Effect.as(location),
              ),
              release,
            )
            // The Scope owns this fence before owner publication, so a failed
            // write or interruption also retires this partially acquired lock.
            const operationId = yield* crypto.randomUUIDv4()
            yield* fs.writeFileString(
              path.join(location, "owner.json"),
              JSON.stringify({
                pid: process.pid,
                host: hostname(),
                operation_id: operationId,
                key,
              }),
              { flag: "wx", mode: 0o600 },
            )
          }).pipe(Effect.mapError(asError), Effect.uninterruptible)
      }).pipe(Effect.mapError(asError), Effect.provide(NodeServices.layer))
      for (const key of [...new Set(keys)].sort()) yield* acquire(key)
      return yield* effect
    }),
  )
}
