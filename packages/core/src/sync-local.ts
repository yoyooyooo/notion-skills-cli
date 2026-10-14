import { Context, Effect, Layer } from "effect"
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { importDocument, type ImportFile } from "./import.ts"
import { fail, SkillsError } from "./model.ts"
import { MANIFEST, portableFiles, readPortable, type PortableSkill } from "./portable.ts"
import { retainInTrash, withLocalLocks } from "./local-locks.ts"
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
  readonly trash?: (location: string) => Promise<void>
  /** Runs immediately BEFORE the real destination guard and syscall, not at preflight. */
  readonly beforeBoundary?: (boundary: LocalBoundary) => Promise<void>
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

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const missing = (error: unknown) =>
  error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"
const safeError = (error: unknown) => {
  if (error instanceof SkillsError) return error
  const code =
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined
  return fail("LOCAL_IO_ERROR", "Local filesystem operation failed.", { syscall_code: code })
}
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: safeError })

/** Walks each component, including every relative link hop. Missing symlink targets are never ordinary missing leaves. */
async function resolveProof(
  input: string,
  allowMissing: boolean,
  allowDangling = false,
): Promise<PathProof> {
  const absolute = path.resolve(input)
  let pending = absolute
    .split(path.sep)
    .filter(Boolean)
    .map((component) => ({ component, required: false }))
  let current = path.parse(absolute).root
  const nodes: PathNode[] = []
  const rootInfo = await fs.lstat(current, { bigint: true })
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
    let info
    try {
      info = await fs.lstat(next, { bigint: true })
    } catch (error) {
      if (!missing(error)) throw error
      if (required && !allowDangling)
        throw fail("LOCAL_LINK_BROKEN", "A local symbolic link is dangling.", { path: next })
      if (!allowMissing)
        throw fail("LOCAL_MISSING", "The local Skill directory or file is missing.", { path: next })
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
      throw fail(
        "INVALID_PATH",
        "Local Skill paths must be ordinary files, directories or symbolic links.",
        { path: next },
      )
    if (kind === "link") {
      if (++hops > 40)
        throw fail("LOCAL_LINK_CYCLE", "The local symbolic link chain is cyclic or too deep.", {
          path: next,
        })
      const link = await fs.readlink(next)
      nodes.push({ path: next, kind, dev: String(info.dev), ino: String(info.ino), link })
      // Do not normalize link/.. before following link: POSIX resolves .. from
      // the already-resolved directory, not from the link's lexical location.
      const targetParts = link.split(path.sep).filter(Boolean)
      pending = [...targetParts.map((component) => ({ component, required: true })), ...pending]
      if (path.isAbsolute(link)) current = path.parse(link).root
      continue
    }
    nodes.push({ path: next, kind, dev: String(info.dev), ino: String(info.ino) })
    if (pending.length && kind !== "directory")
      throw fail("INVALID_PATH", "A local parent is not a directory.", { path: next })
    current = next
  }
  return { nodes, resolved_path: current, exists: true }
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

export function makeSyncLocal(options: SyncLocalOptions = {}): SyncLocal["Service"] {
  const stateRoot = path.resolve(
    options.stateRoot ??
      process.env.NTN_SKILLS_HOME ??
      path.join(
        process.env.XDG_STATE_HOME ??
          path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".local", "state"),
        "ntn-skills",
      ),
  )
  const trash = options.trash ?? retainInTrash
  const inspect = async (
    logicalPath: string,
    inspectOptions: { allowMissing?: boolean; trackedPaths?: readonly string[] } = {},
  ): Promise<LocalInspection> => {
    const logical = path.resolve(logicalPath)
    const root = await resolveProof(logical, !!inspectOptions.allowMissing)
    if (!root.exists) {
      // Registration permits precisely one ordinary leaf under an existing resolved parent.
      const parent = await resolveProof(path.dirname(logical), false)
      if (parent.nodes.at(-1)?.kind !== "directory")
        throw fail("INVALID_PATH", "The local parent must be a directory.")
      return {
        logical_path: logical,
        resolved_path: root.resolved_path,
        exists: false,
        proof: { root, files: [] },
        file_hashes: [],
      }
    }
    if (root.nodes.at(-1)?.kind !== "directory")
      throw fail("INVALID_PATH", "The bound local path must be a directory.", { path: logical })
    const selected = new Set<string>()
    const directories = new Set<string>()
    const proofs = new Map<string, PathProof>()
    const walk = async (relative: string, ancestors: readonly string[] = []) => {
      const location = path.join(logical, relative)
      const proof = await resolveProof(location, true)
      proofs.set(relative, proof)
      if (!proof.exists) return
      if (proof.nodes.at(-1)?.kind === "directory") {
        if (ancestors.includes(proof.resolved_path))
          throw fail("LOCAL_LINK_CYCLE", "A local directory link creates a traversal cycle.", {
            path: location,
          })
        directories.add(relative)
        for (const child of (await fs.readdir(proof.resolved_path)).sort()) {
          if (child.startsWith(".")) continue
          await walk(relative ? `${relative}/${child}` : child, [...ancestors, proof.resolved_path])
        }
      } else selected.add(relative)
    }
    if (inspectOptions.trackedPaths === undefined) {
      for (const child of (await fs.readdir(root.resolved_path)).sort())
        if (!child.startsWith(".")) await walk(child, [root.resolved_path])
    } else {
      for (const relative of [...new Set(inspectOptions.trackedPaths)].sort())
        await walk(validRelative(relative), [root.resolved_path])
      const owned = new Set([
        "references",
        "assets",
        "scripts",
        "templates",
        ...inspectOptions.trackedPaths
          .filter((entry) => entry.includes("/"))
          .map((entry) => entry.split("/")[0]!),
      ])
      for (const directory of [...owned].sort())
        await walk(validRelative(directory), [root.resolved_path])
    }
    // The portable manifest controls metadata/entrypoint; it is also committed and fenced.
    await walk(MANIFEST, [root.resolved_path])
    const files: ImportFile[] = []
    let totalBytes = 0
    for (const relative of [...selected].sort()) {
      const proof = proofs.get(relative)!
      const bytes = await fs.readFile(proof.resolved_path)
      if (!equal(proof, await resolveProof(path.join(logical, relative), false)))
        throw fail(
          "SYNC_TARGET_DRIFT",
          "A local destination changed while it was being inspected.",
          { path: relative },
        )
      files.push({ path: relative, bytes })
      totalBytes += bytes.length
      if (files.length > 10_000 || totalBytes > 128 * 1024 * 1024)
        throw fail("ARCHIVE_TOO_LARGE", "Local Skill exceeds 128 MiB or 10,000 files.")
    }
    if (!equal(root, await resolveProof(logical, false)))
      throw fail("SYNC_TARGET_DRIFT", "The local directory changed during inspection.")
    let content = readPortable(files)
    if (!content) {
      const main = files.find((file) => file.path === "SKILL.md")
      if (!main)
        throw fail("LOCAL_MISSING", "The local Skill entrypoint is missing.", { path: logical })
      const metadata = importDocument(main)
      content = { name: metadata.name, description: metadata.description, main: main.path, files }
    }
    const file_hashes = files.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: digest(file.bytes),
    }))
    const content_id = digest(
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
  }

  const commit = async (
    expected: LocalInspection,
    content: PortableSkill,
    trackedPaths: readonly string[],
    operationId: string,
  ): Promise<LocalCommit> => {
    const incoming = portableFiles(content)
    for (const file of incoming) validRelative(file.path)
    const tracked = [
      ...new Set([...trackedPaths, ...expected.file_hashes.map((file) => file.path), MANIFEST]),
    ].map(validRelative)
    if (!options.trash) {
      if (process.platform !== "darwin")
        throw fail("RETENTION_UNAVAILABLE", "System Trash is required before local commit.")
      try {
        await fs.access("/usr/bin/trash", fs.constants.X_OK)
      } catch {
        throw fail(
          "RETENTION_UNAVAILABLE",
          "The /usr/bin/trash capability is required before local commit.",
        )
      }
    }
    const current = await inspect(expected.logical_path, {
      allowMissing: !expected.exists,
      ...(expected.exists ? { trackedPaths } : {}),
    })
    if (
      !equal(current.proof, expected.proof) ||
      current.content_id !== expected.content_id ||
      !equal(current.file_hashes, expected.file_hashes)
    )
      throw fail(
        "SYNC_PLAN_STALE",
        "Local content or destination no longer matches the saved inspection.",
      )
    const scratch = path.join(
      stateRoot,
      "sync",
      "staging",
      `${digest(operationId)}-${randomUUID()}`,
    )
    await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
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
    ]) {
      for (const node of proof.nodes) if (node.kind !== "file") immutable.set(node.path, node)
    }
    const checkImmutable = async () => {
      for (const [location, node] of immutable) {
        if (retiredLinks.has(location)) continue
        const info = await fs.lstat(location, { bigint: true })
        const link = node.kind === "link" ? await fs.readlink(location) : undefined
        if (
          String(info.dev) !== node.dev ||
          String(info.ino) !== node.ino ||
          (node.kind === "link"
            ? !info.isSymbolicLink() || link !== node.link
            : !info.isDirectory())
        )
          throw fail(
            "SYNC_TARGET_DRIFT",
            "An original parent or link identity changed during commit.",
            { path: location },
          )
      }
    }
    const capture = async (changedPath?: string) => {
      // Own writes change one final file, never the authority of parent/link nodes.
      await checkImmutable()
      const nextRoot = await resolveProof(expected.logical_path, true, true)
      if (rootProof.exists && !equal(rootProof, nextRoot))
        throw fail("SYNC_TARGET_DRIFT", "The root changed during a local syscall.")
      const nextGuarded = new Map<string, { proof: PathProof; hash?: string }>()
      if (nextRoot.exists)
        for (const relative of allPaths) {
          const proof = await resolveProof(path.join(expected.logical_path, relative), true, true)
          const hash =
            proof.exists && proof.nodes.at(-1)?.kind === "file"
              ? digest(await fs.readFile(proof.resolved_path))
              : undefined
          const previous = guarded.get(relative)
          if (
            previous?.hash !== undefined &&
            previous.proof.resolved_path !== changedPath &&
            hash !== previous.hash
          )
            throw fail(
              "SYNC_TARGET_DRIFT",
              "An unrelated tracked file changed during a local syscall.",
              { path: relative },
            )
          nextGuarded.set(relative, { proof, ...(hash === undefined ? {} : { hash }) })
          for (const node of proof.nodes) if (node.kind !== "file") immutable.set(node.path, node)
        }
      for (const node of nextRoot.nodes) if (node.kind !== "file") immutable.set(node.path, node)
      rootProof = nextRoot
      guarded = nextGuarded
    }
    const guard = async (kind: LocalBoundary["kind"], location: string) => {
      await options.beforeBoundary?.({ kind, path: location, operation_id: operationId })
      await checkImmutable()
      if (!equal(rootProof, await resolveProof(expected.logical_path, true, true)))
        throw fail("SYNC_TARGET_DRIFT", "The local root or parent link changed at commit.", {
          path: location,
        })
      for (const [relative, entry] of guarded) {
        const proof = await resolveProof(path.join(expected.logical_path, relative), true, true)
        if (
          !equal(proof, entry.proof) ||
          (entry.hash !== undefined &&
            digest(await fs.readFile(proof.resolved_path)) !== entry.hash)
        )
          throw fail("SYNC_TARGET_DRIFT", "A local file target or content changed at commit.", {
            path: relative,
          })
      }
    }
    try {
      for (let index = 0; index < incoming.length; index++)
        await fs.writeFile(path.join(scratch, String(index)), incoming[index]!.bytes, {
          flag: "wx",
          mode: 0o600,
        })
      const restaged = await inspect(expected.logical_path, {
        allowMissing: !expected.exists,
        ...(expected.exists ? { trackedPaths } : {}),
      })
      if (
        !equal(restaged.proof, expected.proof) ||
        !equal(restaged.file_hashes, expected.file_hashes)
      )
        throw fail("SYNC_TARGET_DRIFT", "The local target changed while content was staged.")
      const destinations = new Map<string, string>()
      for (const file of incoming) {
        const proof = await resolveProof(path.join(expected.logical_path, file.path), true)
        if (proof.exists && !expected.file_hashes.some((entry) => entry.path === file.path))
          throw fail(
            "OUTPUT_CONFLICT",
            "Incoming portable content collides with an unrelated local file.",
            { path: file.path },
          )
        const previous = destinations.get(proof.resolved_path)
        if (previous !== undefined)
          throw fail("INVALID_PATH", "Two portable files resolve to the same actual destination.", {
            paths: [previous, file.path],
          })
        destinations.set(proof.resolved_path, file.path)
      }
      await capture()
      if (!expected.exists) {
        await guard("mkdir", expected.resolved_path)
        await fs.mkdir(expected.resolved_path, { mode: 0o700 })
        await capture()
      }
      for (const relative of allPaths) {
        const fileIndex = incoming.findIndex((file) => file.path === relative)
        const desired = fileIndex < 0 ? undefined : incoming[fileIndex]!
        const proof = await resolveProof(path.join(expected.logical_path, relative), true)
        if (!proof.exists && !desired) continue
        if (proof.exists && proof.nodes.at(-1)?.kind !== "file")
          throw fail("INVALID_PATH", "A portable destination is not an ordinary file.", {
            path: relative,
          })
        if (desired && proof.exists && digest(desired.bytes) === guarded.get(relative)?.hash)
          continue
        const destination = proof.resolved_path
        // Create only missing owned parents, guarding each actual mkdir separately.
        const missingParents: string[] = []
        let parent = path.dirname(destination)
        while (true) {
          try {
            await fs.lstat(parent)
            break
          } catch (error) {
            if (!missing(error)) throw error
            missingParents.unshift(parent)
            parent = path.dirname(parent)
          }
        }
        for (const directory of missingParents) {
          await guard("mkdir", directory)
          await fs.mkdir(directory, { mode: 0o700 })
          await capture()
        }
        let staged: string | undefined
        if (desired) {
          staged = path.join(path.dirname(destination), `.ntn-sync-${randomUUID()}.pending`)
          await guard("replace", destination)
          await fs.copyFile(
            path.join(scratch, String(fileIndex)),
            staged,
            fs.constants.COPYFILE_EXCL,
          )
          retained.push({ path: staged, retention_path: staged })
          await capture()
        }
        if (proof.exists) {
          const backup = path.join(path.dirname(destination), `.ntn-sync-${randomUUID()}.retained`)
          await guard(desired ? "replace" : "remove", destination)
          await fs.rename(destination, backup)
          retained.push({ path: destination, retention_path: backup })
          await capture(destination)
          if (!desired) {
            // Resolve the logical leaf's parent before locating its final-file
            // link; parent-directory links are never removed.
            const logicalFile = path.join(expected.logical_path, relative)
            const realParent = await resolveProof(path.dirname(logicalFile), false)
            const linkPath = path.join(realParent.resolved_path, path.basename(logicalFile))
            const lastLink = proof.nodes.findLast(
              (node) => node.kind === "link" && node.path === linkPath,
            )
            if (lastLink) {
              await guard("remove", linkPath)
              await trash(linkPath)
              retiredLinks.add(linkPath)
              await capture(linkPath)
              retained.push({ path: logicalFile, retention_path: "system_trash" })
            }
          }
        }
        if (staged) {
          await guard("replace", destination)
          await fs.rename(staged, destination)
          retained.splice(
            retained.findIndex((entry) => entry.path === staged),
            1,
          )
          await capture(destination)
        }
        completed.push(relative)
      }
      const inspection = await inspect(expected.logical_path, {
        trackedPaths: incoming.map((file) => file.path),
      })
      if (
        !equal(
          inspection.file_hashes,
          incoming.map((file) => ({
            path: file.path,
            bytes: file.bytes.length,
            sha256: digest(file.bytes),
          })),
        )
      )
        throw fail("WRITE_PARTIAL", "Local readback did not match the complete intended file set.")
      for (const entry of retained) {
        if (entry.retention_path === "system_trash") continue
        await trash(entry.retention_path!)
        entry.retention_path = "system_trash"
      }
      return { inspection, retained }
    } catch (error) {
      const cause = safeError(error)
      throw fail(cause.code === "SYNC_TARGET_DRIFT" ? cause.code : "WRITE_PARTIAL", cause.message, {
        operation_id: operationId,
        completed,
        retained,
        cause_code: cause.code,
      })
    }
  }

  return {
    inspect: (logical, inspectOptions) => attempt(() => inspect(logical, inspectOptions)),
    // A Promise syscall cannot be cancelled. Waiting for completion keeps the process lock
    // scoped to the actual IO; the sync owner's durable receipt governs process death.
    commit: (expected, content, tracked, operation) =>
      Effect.uninterruptible(attempt(() => commit(expected, content, tracked, operation))),
    withLocks: (keys, effect) => withLocalLocks(stateRoot, keys, effect),
  }
}

/** Node-compatible adapter. Guards precede every destination syscall. Node has no
 * directory-fd-relative compare-and-swap: an external writer can still retarget a
 * link between the final check and syscall. Process locks fence cooperating writers,
 * and readback detects divergence; this service does not claim atomic filesystem CAS.
 */
export const SyncLocalLive = Layer.sync(SyncLocal, () => makeSyncLocal())
