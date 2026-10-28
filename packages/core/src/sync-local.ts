import {
  ByteSize,
  Config,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { importDocument, type ImportFile } from "./import.ts"
import { fail, SkillsError } from "./model.ts"
import { MANIFEST, portableFiles, readPortable, type PortableSkill } from "./portable.ts"
import { lstatNoFollow, trashPath, withLocalLocks } from "./local-locks.ts"
export { trashPath } from "./local-locks.ts"
import { normalizePath } from "./ref.ts"

export interface PathNode {
  readonly path: string
  readonly kind: "directory" | "file" | "link"
  readonly dev: string
  readonly ino: string
  readonly link?: string
}
export interface PathProof {
  readonly nodes: readonly PathNode[]
  readonly resolved_path: string
  readonly exists: boolean
}
export interface LocalInspection {
  readonly logical_path: string
  readonly resolved_path: string
  readonly exists: boolean
  readonly proof: {
    readonly root: PathProof
    readonly files: readonly { readonly path: string; readonly proof: PathProof }[]
  }
  readonly content?: PortableSkill
  readonly content_id?: string
  readonly file_hashes: readonly {
    readonly path: string
    readonly bytes: number
    readonly sha256: string
  }[]
}
export interface LocalCommit {
  readonly inspection: LocalInspection
  readonly retained: readonly { readonly path: string; readonly retention_path?: string }[]
}
export interface LocalBoundary {
  readonly kind: "mkdir" | "replace" | "remove"
  readonly path: string
  readonly operation_id: string
}
export interface SyncLocalOptions {
  readonly stateRoot?: string
  /** System Trash adapter. Tests may move bytes into their own retained directory. */
  readonly trash?: (location: string) => Effect.Effect<void, SkillsError>
  /** Runs immediately BEFORE the real destination guard and syscall, not at preflight. */
  readonly beforeBoundary?: (boundary: LocalBoundary) => Effect.Effect<void, SkillsError>
}
export class SyncLocal extends Context.Service<
  SyncLocal,
  {
    readonly inspect: (
      logicalPath: string,
      options?: { allowMissing?: boolean; trackedPaths?: readonly string[] },
    ) => Effect.Effect<LocalInspection, SkillsError>
    readonly commit: (
      expected: LocalInspection,
      content: PortableSkill,
      trackedPaths: readonly string[],
      operationId: string,
    ) => Effect.Effect<LocalCommit, SkillsError>
    readonly withLocks: <T, E, R>(
      keys: readonly string[],
      effect: Effect.Effect<T, E, R>,
    ) => Effect.Effect<T, E | SkillsError, R>
  }
>()("ntn-skills/SyncLocal") {}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const safeError = (error: unknown): SkillsError => {
  if (error instanceof SkillsError) return error
  const cause = PlatformError.isPlatformError(error) ? error.reason.cause : error
  const code =
    cause !== null && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined
  return fail("LOCAL_IO_ERROR", "Local filesystem operation failed.", { syscall_code: code })
}
function validRelative(input: string): string {
  if (
    !input ||
    normalizePath(input) !== input ||
    (input.split("/").some((part) => part.startsWith(".")) && input !== MANIFEST)
  )
    throw fail("INVALID_PATH", "Sync requires normalized non-hidden portable file paths.", {
      path: input,
    })
  return input
}

/** The host Layer supplies capabilities once; each operation owns its file scopes. */
export const makeSyncLocal = (options: SyncLocalOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    let selectedRoot = options.stateRoot
    if (selectedRoot === undefined) {
      selectedRoot = Option.getOrUndefined(
        yield* Config.String("NTN_SKILLS_HOME").pipe(Config.option),
      )
      if (selectedRoot === undefined) {
        let stateHome = Option.getOrUndefined(
          yield* Config.String("XDG_STATE_HOME").pipe(Config.option),
        )
        if (stateHome === undefined) {
          const home =
            Option.getOrUndefined(yield* Config.String("HOME").pipe(Config.option)) ??
            (yield* Config.String("USERPROFILE").pipe(Config.withDefault(".")))
          stateHome = path.join(home, ".local", "state")
        }
        selectedRoot = path.join(stateHome, "ntn-skills")
      }
    }
    const stateRoot = path.resolve(selectedRoot)
    const trash = options.trash ?? trashPath
    const digest = (bytes: string | Uint8Array) =>
      crypto
        .digest("SHA-256", typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)
        .pipe(
          Effect.map((hash) =>
            Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""),
          ),
          Effect.mapError(safeError),
        )
    const lstat = (location: string) => lstatNoFollow(location).pipe(Effect.mapError(safeError))
    const drift = (location: string) =>
      fail("SYNC_TARGET_DRIFT", "A local destination changed identity or contents.", {
        path: location,
      })

    /** Walk each link hop in POSIX order; missing link targets are not missing leaves. */
    const resolveProof = (
      input: string,
      allowMissing: boolean,
      allowDangling = false,
    ): Effect.Effect<PathProof, SkillsError> =>
      Effect.gen(function* () {
        const absolute = path.resolve(input)
        let pending = absolute
          .split(path.sep)
          .filter(Boolean)
          .map((component) => ({ component, required: false }))
        let current = path.parse(absolute).root
        const nodes: PathNode[] = []
        const rootInfo = yield* lstat(current)
        if (!rootInfo?.isDirectory())
          return yield* Effect.fail(fail("INVALID_PATH", "The filesystem root is not a directory."))
        nodes.push({
          path: current,
          kind: "directory",
          dev: String(rootInfo.dev),
          ino: String(rootInfo.ino),
        })
        let hops = 0
        while (pending.length) {
          const { component, required } = pending.shift()!
          if (component === ".") continue
          if (component === "..") {
            current = path.dirname(current)
            continue
          }
          const next = path.join(current, component)
          const info = yield* lstat(next)
          if (!info) {
            if (required && !allowDangling)
              return yield* Effect.fail(
                fail("LOCAL_LINK_BROKEN", "A local symbolic link is dangling.", { path: next }),
              )
            if (!allowMissing)
              return yield* Effect.fail(
                fail("LOCAL_MISSING", "The local Skill directory or file is missing.", {
                  path: next,
                }),
              )
            return {
              nodes,
              resolved_path: path.join(next, ...pending.map((item) => item.component)),
              exists: false,
            }
          }
          const kind = info.isSymbolicLink()
            ? "link"
            : info.isDirectory()
              ? "directory"
              : info.isFile()
                ? "file"
                : undefined
          if (!kind)
            return yield* Effect.fail(
              fail(
                "INVALID_PATH",
                "Local Skill paths must be ordinary files, directories or symbolic links.",
                { path: next },
              ),
            )
          if (kind === "link") {
            if (++hops > 40)
              return yield* Effect.fail(
                fail("LOCAL_LINK_CYCLE", "The local symbolic link chain is cyclic or too deep.", {
                  path: next,
                }),
              )
            const link = yield* fs.readLink(next)
            const after = yield* lstat(next)
            if (!after?.isSymbolicLink() || info.dev !== after.dev || info.ino !== after.ino)
              return yield* Effect.fail(drift(next))
            nodes.push({ path: next, kind, dev: String(info.dev), ino: String(info.ino), link })
            // Do not normalize link/.. before resolving the linked directory.
            pending = [
              ...link
                .split(path.sep)
                .filter(Boolean)
                .map((component) => ({ component, required: true })),
              ...pending,
            ]
            if (path.isAbsolute(link)) current = path.parse(link).root
            continue
          }
          nodes.push({ path: next, kind, dev: String(info.dev), ino: String(info.ino) })
          if (pending.length && kind !== "directory")
            return yield* Effect.fail(
              fail("INVALID_PATH", "A local parent is not a directory.", { path: next }),
            )
          current = next
        }
        if ((yield* fs.realPath(absolute)) !== current) return yield* Effect.fail(drift(absolute))
        return { nodes, resolved_path: current, exists: true }
      }).pipe(Effect.mapError(safeError))

    /** This read owns the no-follow handle, including interruption and typed failure. */
    const readRegular = (location: string): Effect.Effect<Uint8Array, SkillsError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const before = yield* lstat(location)
          if (!before?.isFile()) return yield* Effect.fail(drift(location))
          const handle = yield* fs.open(location, { flag: "r", noFollow: true })
          const opened = yield* handle.stat
          if (
            opened.dev !== BigInt.asUintN(64, before.dev) ||
            Option.getOrUndefined(opened.ino) !== BigInt.asUintN(64, before.ino)
          )
            return yield* Effect.fail(drift(location))
          const size = Number(ByteSize.toBigInt(opened.size))
          if (!Number.isSafeInteger(size) || size > 128 * 1024 * 1024)
            return yield* Effect.fail(
              fail("ARCHIVE_TOO_LARGE", "Local Skill exceeds 128 MiB or 10,000 files."),
            )
          const bytes = new Uint8Array(size)
          let offset = 0
          while (offset < size) {
            const count = yield* handle.read(bytes.subarray(offset))
            if (!count) break
            offset += count
          }
          const extra = yield* handle.readAlloc(1)
          const after = yield* handle.stat
          const linked = yield* lstat(location)
          if (
            !linked?.isFile() ||
            before.dev !== linked.dev ||
            before.ino !== linked.ino ||
            before.size !== linked.size ||
            before.mtimeNs !== linked.mtimeNs ||
            before.ctimeNs !== linked.ctimeNs ||
            opened.size !== after.size ||
            offset !== size ||
            Option.isSome(extra)
          )
            return yield* Effect.fail(drift(location))
          return bytes
        }),
      ).pipe(Effect.mapError(safeError))
    const writeExclusive = (location: string, bytes: Uint8Array) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs.open(location, { flag: "wx", mode: 0o600, noFollow: true })
          yield* handle.writeAll(bytes)
          yield* handle.sync
        }),
      ).pipe(Effect.mapError(safeError))

    const inspect: SyncLocal["Service"]["inspect"] = (logicalPath, inspectOptions = {}) =>
      Effect.gen(function* () {
        const logical = path.resolve(logicalPath)
        const root = yield* resolveProof(logical, !!inspectOptions.allowMissing)
        if (!root.exists) {
          const parent = yield* resolveProof(path.dirname(logical), false)
          if (parent.nodes.at(-1)?.kind !== "directory")
            return yield* Effect.fail(fail("INVALID_PATH", "The local parent must be a directory."))
          return {
            logical_path: logical,
            resolved_path: root.resolved_path,
            exists: false,
            proof: { root, files: [] },
            file_hashes: [],
          }
        }
        if (root.nodes.at(-1)?.kind !== "directory")
          return yield* Effect.fail(
            fail("INVALID_PATH", "The bound local path must be a directory.", { path: logical }),
          )
        const selected = new Set<string>()
        const directories = new Set<string>()
        const proofs = new Map<string, PathProof>()
        const walk = (
          relative: string,
          ancestors: readonly string[] = [],
        ): Effect.Effect<void, SkillsError> =>
          Effect.gen(function* () {
            const location = path.join(logical, relative)
            const proof = yield* resolveProof(location, true)
            proofs.set(relative, proof)
            if (!proof.exists) return
            if (proof.nodes.at(-1)?.kind === "directory") {
              if (ancestors.includes(proof.resolved_path))
                return yield* Effect.fail(
                  fail("LOCAL_LINK_CYCLE", "A local directory link creates a traversal cycle.", {
                    path: location,
                  }),
                )
              directories.add(relative)
              for (const child of (yield* fs.readDirectory(proof.resolved_path)).sort()) {
                if (!child.startsWith("."))
                  yield* walk(relative ? `${relative}/${child}` : child, [
                    ...ancestors,
                    proof.resolved_path,
                  ])
              }
            } else selected.add(relative)
          }).pipe(Effect.mapError(safeError))
        if (inspectOptions.trackedPaths === undefined) {
          for (const child of (yield* fs.readDirectory(root.resolved_path)).sort())
            if (!child.startsWith(".")) yield* walk(child, [root.resolved_path])
        } else {
          const paths = yield* Effect.try({
            try: () => [...new Set(inspectOptions.trackedPaths)].sort().map(validRelative),
            catch: safeError,
          })
          for (const relative of paths) yield* walk(relative, [root.resolved_path])
          const owned = new Set([
            "references",
            "assets",
            "scripts",
            "templates",
            ...paths.filter((entry) => entry.includes("/")).map((entry) => entry.split("/")[0]!),
          ])
          for (const directory of [...owned].sort()) yield* walk(directory, [root.resolved_path])
        }
        yield* walk(MANIFEST, [root.resolved_path])
        const files: ImportFile[] = []
        let totalBytes = 0
        for (const relative of [...selected].sort()) {
          const proof = proofs.get(relative)!
          const bytes = yield* readRegular(proof.resolved_path)
          if (!equal(proof, yield* resolveProof(path.join(logical, relative), false)))
            return yield* Effect.fail(drift(relative))
          files.push({ path: relative, bytes })
          totalBytes += bytes.length
          if (files.length > 10_000 || totalBytes > 128 * 1024 * 1024)
            return yield* Effect.fail(
              fail("ARCHIVE_TOO_LARGE", "Local Skill exceeds 128 MiB or 10,000 files."),
            )
        }
        if (!equal(root, yield* resolveProof(logical, false)))
          return yield* Effect.fail(drift(logical))
        const content = yield* Effect.try({
          try: () => {
            const portable = readPortable(files)
            if (portable) return portable
            const main = files.find((file) => file.path === "SKILL.md")
            if (!main)
              throw fail("LOCAL_MISSING", "The local Skill entrypoint is missing.", {
                path: logical,
              })
            const metadata = importDocument(main)
            return {
              kind: "skill" as const,
              name: metadata.name,
              description: metadata.description,
              main: main.path,
              files,
            }
          },
          catch: safeError,
        })
        const file_hashes = yield* Effect.forEach(files, (file) =>
          digest(file.bytes).pipe(
            Effect.map((sha256) => ({ path: file.path, bytes: file.bytes.length, sha256 })),
          ),
        )
        const content_id = yield* digest(
          JSON.stringify({
            name: content.name,
            description: content.description,
            main: content.main,
            files: file_hashes.filter((file) => file.path !== MANIFEST),
          }),
        )
        return {
          logical_path: logical,
          resolved_path: root.resolved_path,
          exists: true,
          proof: {
            root,
            files: [...proofs]
              .filter(
                ([relative, proof]) =>
                  proof.exists &&
                  (!directories.has(relative) ||
                    ["references", "assets", "scripts", "templates"].includes(relative)),
              )
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([relative, proof]) => ({ path: relative, proof })),
          },
          content,
          content_id,
          file_hashes,
        }
      }).pipe(Effect.mapError(safeError))

    const commit: SyncLocal["Service"]["commit"] = (expected, content, trackedPaths, operationId) =>
      Effect.gen(function* () {
        const { incoming, tracked } = yield* Effect.try({
          try: () => {
            const incoming = portableFiles(content)
            for (const file of incoming) validRelative(file.path)
            return {
              incoming,
              tracked: [
                ...new Set([
                  ...trackedPaths,
                  ...expected.file_hashes.map((file) => file.path),
                  MANIFEST,
                ]),
              ].map(validRelative),
            }
          },
          catch: safeError,
        })
        if (!options.trash) {
          const unavailable = fail(
            "RETENTION_UNAVAILABLE",
            "The /usr/bin/trash capability is required before local commit.",
          )
          if (process.platform !== "darwin") return yield* Effect.fail(unavailable)
          const exit = yield* spawner
            .exitCode(
              ChildProcess.make("/bin/test", ["-x", "/usr/bin/trash"], {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              }),
            )
            .pipe(Effect.mapError(() => unavailable))
          if (exit !== 0) return yield* Effect.fail(unavailable)
        }
        const current = yield* inspect(expected.logical_path, {
          allowMissing: !expected.exists,
          ...(expected.exists ? { trackedPaths } : {}),
        })
        if (
          !equal(current.proof, expected.proof) ||
          current.content_id !== expected.content_id ||
          !equal(current.file_hashes, expected.file_hashes)
        )
          return yield* Effect.fail(
            fail(
              "SYNC_PLAN_STALE",
              "Local content or destination no longer matches the saved inspection.",
            ),
          )
        const scratch = path.join(
          stateRoot,
          "sync",
          "staging",
          `${yield* digest(operationId)}-${yield* crypto.randomUUIDv4()}`,
        )
        // Recovery bytes intentionally outlive interruption. Their locators are stable
        // under the operation hash; only a completed readback authorizes Trash.
        yield* fs.makeDirectory(scratch, { recursive: true, mode: 0o700 })
        const retained: Array<{ path: string; retention_path?: string }> = [
          { path: scratch, retention_path: scratch },
        ]
        const completed: string[] = []
        const allPaths = [...new Set([...tracked, ...incoming.map((file) => file.path)])].sort()
        let rootProof = expected.proof.root
        let guarded = new Map<string, { proof: PathProof; hash?: string }>()
        const retiredLinks = new Set<string>()
        const immutable = new Map<string, PathNode>()
        for (const proof of [
          expected.proof.root,
          ...expected.proof.files.map((entry) => entry.proof),
        ])
          for (const node of proof.nodes) if (node.kind !== "file") immutable.set(node.path, node)
        const checkImmutable = () =>
          Effect.gen(function* () {
            for (const [location, node] of immutable) {
              if (retiredLinks.has(location)) continue
              const info = yield* lstat(location)
              const link = node.kind === "link" && info ? yield* fs.readLink(location) : undefined
              if (
                !info ||
                String(info.dev) !== node.dev ||
                String(info.ino) !== node.ino ||
                (node.kind === "link"
                  ? !info.isSymbolicLink() || link !== node.link
                  : !info.isDirectory())
              )
                return yield* Effect.fail(drift(location))
            }
          }).pipe(Effect.mapError(safeError))
        const capture = (changedPath?: string) =>
          Effect.gen(function* () {
            yield* checkImmutable()
            const nextRoot = yield* resolveProof(expected.logical_path, true, true)
            if (rootProof.exists && !equal(rootProof, nextRoot))
              return yield* Effect.fail(drift(expected.logical_path))
            const nextGuarded = new Map<string, { proof: PathProof; hash?: string }>()
            if (nextRoot.exists)
              for (const relative of allPaths) {
                const proof = yield* resolveProof(
                  path.join(expected.logical_path, relative),
                  true,
                  true,
                )
                const hash =
                  proof.exists && proof.nodes.at(-1)?.kind === "file"
                    ? yield* digest(yield* readRegular(proof.resolved_path))
                    : undefined
                const previous = guarded.get(relative)
                if (
                  previous?.hash !== undefined &&
                  previous.proof.resolved_path !== changedPath &&
                  hash !== previous.hash
                )
                  return yield* Effect.fail(drift(relative))
                nextGuarded.set(relative, { proof, ...(hash === undefined ? {} : { hash }) })
                for (const node of proof.nodes)
                  if (node.kind !== "file") immutable.set(node.path, node)
              }
            for (const node of nextRoot.nodes)
              if (node.kind !== "file") immutable.set(node.path, node)
            rootProof = nextRoot
            guarded = nextGuarded
          })
        const guard = () =>
          Effect.gen(function* () {
            yield* checkImmutable()
            if (!equal(rootProof, yield* resolveProof(expected.logical_path, true, true)))
              return yield* Effect.fail(drift(expected.logical_path))
            for (const [relative, entry] of guarded) {
              const proof = yield* resolveProof(
                path.join(expected.logical_path, relative),
                true,
                true,
              )
              if (
                !equal(proof, entry.proof) ||
                (entry.hash !== undefined &&
                  (yield* digest(yield* readRegular(proof.resolved_path))) !== entry.hash)
              )
                return yield* Effect.fail(drift(relative))
            }
          })
        // Hooks and staging are interruptible. A guarded syscall and its recovery
        // bookkeeping are one bounded region, so cancellation cannot orphan ownership.
        const boundary = <A, E>(
          kind: LocalBoundary["kind"],
          location: string,
          mutation: Effect.Effect<A, E>,
        ) =>
          Effect.gen(function* () {
            if (options.beforeBoundary)
              yield* options.beforeBoundary({ kind, path: location, operation_id: operationId })
            return yield* Effect.uninterruptible(guard().pipe(Effect.andThen(mutation)))
          })
        return yield* Effect.gen(function* () {
          for (let index = 0; index < incoming.length; index++)
            yield* writeExclusive(path.join(scratch, String(index)), incoming[index]!.bytes)
          const restaged = yield* inspect(expected.logical_path, {
            allowMissing: !expected.exists,
            ...(expected.exists ? { trackedPaths } : {}),
          })
          if (
            !equal(restaged.proof, expected.proof) ||
            !equal(restaged.file_hashes, expected.file_hashes)
          )
            return yield* Effect.fail(drift(expected.logical_path))
          const destinations = new Map<string, string>()
          for (const file of incoming) {
            const proof = yield* resolveProof(path.join(expected.logical_path, file.path), true)
            if (proof.exists && !expected.file_hashes.some((entry) => entry.path === file.path))
              return yield* Effect.fail(
                fail(
                  "OUTPUT_CONFLICT",
                  "Incoming portable content collides with an unrelated local file.",
                  { path: file.path },
                ),
              )
            const previous = destinations.get(proof.resolved_path)
            if (previous !== undefined)
              return yield* Effect.fail(
                fail("INVALID_PATH", "Two portable files resolve to the same actual destination.", {
                  paths: [previous, file.path],
                }),
              )
            destinations.set(proof.resolved_path, file.path)
          }
          yield* capture()
          if (!expected.exists)
            yield* boundary(
              "mkdir",
              expected.resolved_path,
              Effect.gen(function* () {
                yield* fs.makeDirectory(expected.resolved_path, { mode: 0o700 })
                yield* capture()
              }),
            )
          for (const relative of allPaths) {
            const fileIndex = incoming.findIndex((file) => file.path === relative)
            const desired = fileIndex < 0 ? undefined : incoming[fileIndex]!
            const proof = yield* resolveProof(path.join(expected.logical_path, relative), true)
            if (!proof.exists && !desired) continue
            if (proof.exists && proof.nodes.at(-1)?.kind !== "file")
              return yield* Effect.fail(
                fail("INVALID_PATH", "A portable destination is not an ordinary file.", {
                  path: relative,
                }),
              )
            if (
              desired &&
              proof.exists &&
              (yield* digest(desired.bytes)) === guarded.get(relative)?.hash
            )
              continue
            const destination = proof.resolved_path
            const missingParents: string[] = []
            let parent = path.dirname(destination)
            while (!(yield* lstat(parent))) {
              missingParents.unshift(parent)
              parent = path.dirname(parent)
            }
            for (const directory of missingParents)
              yield* boundary(
                "mkdir",
                directory,
                Effect.gen(function* () {
                  yield* fs.makeDirectory(directory, { mode: 0o700 })
                  yield* capture()
                }),
              )
            let staged: string | undefined
            if (desired) {
              staged = path.join(
                path.dirname(destination),
                `.ntn-sync-${yield* crypto.randomUUIDv4()}.pending`,
              )
              const stagedPath = staged
              yield* boundary(
                "replace",
                destination,
                Effect.gen(function* () {
                  // Register the candidate before writing: a failed write preserves a
                  // partial candidate with an explicit locator, never an unknown file.
                  retained.push({ path: stagedPath, retention_path: stagedPath })
                  yield* writeExclusive(stagedPath, desired.bytes)
                  yield* capture()
                }),
              )
            }
            if (proof.exists) {
              const backup = path.join(
                path.dirname(destination),
                `.ntn-sync-${yield* crypto.randomUUIDv4()}.retained`,
              )
              yield* boundary(
                desired ? "replace" : "remove",
                destination,
                Effect.gen(function* () {
                  yield* fs.rename(destination, backup)
                  retained.push({ path: destination, retention_path: backup })
                  yield* capture(destination)
                }),
              )
              if (!desired) {
                const logicalFile = path.join(expected.logical_path, relative)
                const realParent = yield* resolveProof(path.dirname(logicalFile), false)
                const linkPath = path.join(realParent.resolved_path, path.basename(logicalFile))
                const lastLink = proof.nodes.findLast(
                  (node) => node.kind === "link" && node.path === linkPath,
                )
                if (lastLink)
                  yield* boundary(
                    "remove",
                    linkPath,
                    Effect.gen(function* () {
                      yield* trash(linkPath)
                      retiredLinks.add(linkPath)
                      retained.push({ path: logicalFile, retention_path: "system_trash" })
                      yield* capture(linkPath)
                    }),
                  )
              }
            }
            if (staged) {
              const stagedPath = staged
              yield* boundary(
                "replace",
                destination,
                Effect.gen(function* () {
                  yield* fs.rename(stagedPath, destination)
                  retained.splice(
                    retained.findIndex((entry) => entry.path === stagedPath),
                    1,
                  )
                  yield* capture(destination)
                }),
              )
            }
            completed.push(relative)
          }
          const inspection = yield* inspect(expected.logical_path, {
            trackedPaths: incoming.map((file) => file.path),
          })
          const hashes = yield* Effect.forEach(incoming, (file) =>
            digest(file.bytes).pipe(
              Effect.map((sha256) => ({ path: file.path, bytes: file.bytes.length, sha256 })),
            ),
          )
          if (!equal(inspection.file_hashes, hashes))
            return yield* Effect.fail(
              fail("WRITE_PARTIAL", "Local readback did not match the complete intended file set."),
            )
          for (const entry of retained)
            if (entry.retention_path !== "system_trash")
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* trash(entry.retention_path!)
                  entry.retention_path = "system_trash"
                }),
              )
          return { inspection, retained }
        }).pipe(
          Effect.mapError((error) => {
            const cause = safeError(error)
            return fail(
              cause.code === "SYNC_TARGET_DRIFT" ? cause.code : "WRITE_PARTIAL",
              cause.message,
              { operation_id: operationId, completed, retained, cause_code: cause.code },
            )
          }),
        )
      }).pipe(Effect.mapError(safeError))
    return {
      inspect,
      commit,
      withLocks: (keys, effect) => withLocalLocks(stateRoot, keys, effect),
    } satisfies SyncLocal["Service"]
  }).pipe(Effect.mapError(safeError))

/** Guards precede every destination syscall. There is no directory-fd-relative
 * compare-and-swap in the official filesystem: external writers can retarget
 * between guard and syscall. Process locks fence cooperating writers; readback
 * detects divergence. No atomic filesystem CAS or automatic rollback is claimed.
 */
export const SyncLocalLive = Layer.effect(SyncLocal, makeSyncLocal())
