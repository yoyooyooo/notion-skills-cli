import { Effect } from "effect"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import { hostname } from "node:os"
import * as path from "node:path"
import { fail, property, SkillsError } from "./model.ts"

const asError = (error: unknown) => {
  if (error instanceof SkillsError) return error
  const code =
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined
  return fail("STORAGE_ERROR", "The local retention or lock operation failed.", {
    syscall_code: code,
  })
}

export async function retainInTrash(location: string): Promise<void> {
  if (process.platform !== "darwin")
    throw fail(
      "RETENTION_UNAVAILABLE",
      "System Trash is required; bytes have been retained in place.",
      { path: location },
    )
  try {
    await fs.access("/usr/bin/trash", fs.constants.X_OK)
  } catch {
    throw fail(
      "RETENTION_UNAVAILABLE",
      "The /usr/bin/trash capability is required; bytes have been retained in place.",
      { path: location },
    )
  }
  await new Promise<void>((resolve, reject) =>
    execFile("/usr/bin/trash", [location], (error) =>
      error
        ? reject(
            fail("RETENTION_FAILED", "System Trash failed; retained bytes remain available.", {
              path: location,
            }),
          )
        : resolve(),
    ),
  )
}
/** System Trash, never unlink/rm. No Store dependency, including transitively. */
export const trashPath = (location: string): Effect.Effect<void, SkillsError> =>
  Effect.tryPromise({ try: () => retainInTrash(location), catch: asError })

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
  const release = async (locks: readonly string[]) => {
    for (const location of [...locks].reverse()) {
      const retired = `${location}.${randomUUID()}.released`
      await fs.rename(location, retired)
      // Retirement already released the exclusive key. Trash failure does not
      // affect the completed operation: this owned history stays retained.
      if (process.platform === "darwin") {
        try {
          await retainInTrash(retired)
        } catch {
          /* retained in state */
        }
      }
    }
  }
  const acquire = async () => {
    const locksRoot = path.join(stateRoot, "sync", "locks")
    await fs.mkdir(locksRoot, { recursive: true, mode: 0o700 })
    const acquired: string[] = []
    try {
      for (const key of [...new Set(keys)].sort()) {
        const location = path.join(locksRoot, createHash("sha256").update(key).digest("hex"))
        try {
          await fs.mkdir(location, { mode: 0o700 })
        } catch (error) {
          if (
            error === null ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "EEXIST"
          )
            throw error
          const identity = await fs.lstat(location, { bigint: true })
          let owner: { pid?: number; same_host?: boolean } = {}
          try {
            const raw = property(
              JSON.parse(await fs.readFile(path.join(location, "owner.json"), "utf8")),
            )
            owner = {
              ...(typeof raw.pid === "number" && Number.isSafeInteger(raw.pid) && raw.pid > 0
                ? { pid: raw.pid }
                : {}),
              same_host: raw.host === hostname(),
            }
          } catch {
            /* unknown owners remain fenced */
          }
          let dead = false
          if (owner.same_host && owner.pid !== undefined) {
            try {
              process.kill(owner.pid, 0)
            } catch (error) {
              dead =
                error !== null &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "ESRCH"
            }
          }
          if (!dead)
            throw fail("SYNC_LOCKED", "A live or unidentifiable process owns this fence.", {
              key,
              lock_path: location,
              owner,
            })
          // Exclusive recovery claim lives inside the exact stale lock inode.
          try {
            await fs.mkdir(path.join(location, "recovery"), { mode: 0o700 })
          } catch {
            throw fail("SYNC_LOCKED", "Another process is retaining the dead lock.", {
              key,
              lock_path: location,
            })
          }
          const latest = await fs.lstat(location, { bigint: true })
          if (latest.dev !== identity.dev || latest.ino !== identity.ino)
            throw fail("SYNC_LOCKED", "Lock identity changed during recovery.", { key })
          await fs.rename(location, `${location}.${randomUUID()}.crashed`)
          try {
            await fs.mkdir(location, { mode: 0o700 })
          } catch {
            throw fail("SYNC_LOCKED", "Another process acquired the recovered fence.", { key })
          }
        }
        acquired.push(location)
        await fs.writeFile(
          path.join(location, "owner.json"),
          JSON.stringify({ pid: process.pid, host: hostname(), operation_id: randomUUID(), key }),
          { flag: "wx", mode: 0o600 },
        )
      }
      return acquired
    } catch (error) {
      await release(acquired)
      throw error
    }
  }
  return Effect.acquireUseRelease(
    Effect.tryPromise({ try: acquire, catch: asError }),
    () => effect,
    (locks) => Effect.tryPromise({ try: () => release(locks), catch: asError }).pipe(Effect.orDie),
  )
}
