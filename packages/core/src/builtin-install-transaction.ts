import { Crypto, Effect, FileSystem, Path } from "effect"
import { builtinInfo, type BuiltinInfo, type BuiltinSkill } from "./builtin.ts"
import {
  BUILTIN_INSTALL_RECEIPT,
  canonicalProfile,
  clean,
  digest,
  inode,
  inspect,
  installation,
  layout,
  lstat,
  observe,
  ordinaryDirectory,
  proof,
  readRegular,
  record,
  recorded,
  safeError,
  trashCapability,
  type BuiltinInstallBoundary,
  type BuiltinInstallOptions,
  type BuiltinInstallReceipt,
  type Journal,
  type Layout,
  type Pending,
} from "./builtin-install-tree.ts"
import { trashPath } from "./local-locks.ts"
import { fail, property, type SkillsError } from "./model.ts"
import { portableFiles } from "./portable.ts"

function recover<R>(
  pending: Pending,
  info: BuiltinInfo,
  locations: Layout,
  options: BuiltinInstallOptions,
  guard: () => Effect.Effect<void, SkillsError, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const journal = pending.journal
    if (!journal)
      return yield* Effect.fail(
        fail(
          "BUILTIN_INTERRUPTED",
          "The transaction requires manual inspection; no bytes were changed.",
          {
            journal_path: path.join(pending.directory, "journal.json"),
            reason: pending.reason,
          },
        ),
      )
    const staged = path.join(pending.directory, "staged")
    const previous = path.join(pending.directory, "previous")
    const targetTree = yield* inspect(locations.target, info, locations)
    const previousTree = yield* inspect(previous, info, locations)
    const stagedTree = yield* inspect(staged, info, locations)
    const stagedRecord = yield* readRegular(path.join(pending.directory, "staged.json"))
    const stagedProof = stagedRecord
      ? yield* Effect.try(() => {
          const raw = property(JSON.parse(new TextDecoder().decode(stagedRecord)))
          return raw.format === "ntn-skills-builtin-boundary" &&
            raw.version === 1 &&
            raw.operation_id === journal.operation_id &&
            raw.phase === "staged" &&
            typeof raw.proof === "string" &&
            /^[a-f\d]{64}$/.test(raw.proof)
            ? raw.proof
            : undefined
        }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      : undefined
    const published = yield* recorded(pending.directory, journal.operation_id, "published")
    const previousProof = previousTree ? yield* proof(previousTree) : undefined
    const previousMatches =
      journal.previous_proof !== undefined &&
      previousTree !== undefined &&
      previousProof === journal.previous_proof
    const retained = yield* recorded(pending.directory, journal.operation_id, "retained")
    const trashStarted = yield* recorded(pending.directory, journal.operation_id, "trash_started")
    const trashed = yield* recorded(pending.directory, journal.operation_id, "trashed")
    if (
      (published && stagedTree) ||
      (retained && previousTree && !previousMatches) ||
      ((trashStarted || trashed) && !published) ||
      (trashed && previousTree) ||
      ((retained || published || trashStarted || trashed) && !stagedProof)
    )
      return yield* Effect.fail(
        fail("BUILTIN_INTERRUPTED", "Transaction receipts contradict the observed trees."),
      )
    const boundary = (kind: BuiltinInstallBoundary["kind"], destination: string) =>
      Effect.gen(function* () {
        if (options.beforeBoundary)
          yield* options.beforeBoundary({
            kind,
            path: destination,
            operation_id: journal.operation_id,
          })
        yield* guard()
      })
    const targetProof = targetTree ? yield* proof(targetTree) : undefined
    const stagedTreeProof = stagedTree ? yield* proof(stagedTree) : undefined
    let outcome: "completed" | "rolled_back" | "not_applied"
    if (
      clean(targetTree, journal.receipt) &&
      targetTree &&
      stagedProof === targetProof &&
      !stagedTree
    ) {
      if (!published) yield* record(pending.directory, journal.operation_id, "published")
      if (journal.previous_proof && !retained)
        yield* record(pending.directory, journal.operation_id, "retained")
      if (previousTree) {
        if (!previousMatches)
          return yield* Effect.fail(
            fail(
              "BUILTIN_INTERRUPTED",
              "The retained prior tree changed; recovery cannot retire it.",
            ),
          )
        yield* trashCapability(options)
        yield* boundary("trash", previous)
        const currentTarget = yield* inspect(locations.target, info, locations)
        if (
          !clean(currentTarget, journal.receipt) ||
          !currentTarget ||
          (yield* proof(currentTarget)) !== stagedProof
        )
          return yield* Effect.fail(
            fail("BUILTIN_INTERRUPTED", "Published bytes changed before recovery retention."),
          )
        const latest = yield* inspect(previous, info, locations)
        if (!latest || (yield* proof(latest)) !== journal.previous_proof)
          return yield* Effect.fail(
            fail("BUILTIN_INTERRUPTED", "Retained bytes changed during recovery."),
          )
        yield* Effect.gen(function* () {
          if (!(yield* recorded(pending.directory, journal.operation_id, "trash_started")))
            yield* record(pending.directory, journal.operation_id, "trash_started")
          yield* (options.trash ?? trashPath)(previous)
          yield* record(pending.directory, journal.operation_id, "trashed")
        }).pipe(Effect.uninterruptible)
      } else if (
        journal.previous_proof &&
        !(yield* recorded(pending.directory, journal.operation_id, "trashed"))
      ) {
        return yield* Effect.fail(
          fail(
            "BUILTIN_INTERRUPTED",
            "Prior-tree retention has an unknown outcome; inspect the journal and system Trash.",
          ),
        )
      }
      outcome = "completed"
    } else if (
      !targetTree &&
      previousMatches &&
      stagedTree &&
      stagedProof === stagedTreeProof &&
      !published
    ) {
      yield* boundary("publish", locations.target)
      const latest = yield* inspect(previous, info, locations)
      if (!latest || (yield* proof(latest)) !== journal.previous_proof)
        return yield* Effect.fail(
          fail("BUILTIN_INTERRUPTED", "The prior tree changed before recovery."),
        )
      if (yield* lstat(locations.target))
        return yield* Effect.fail(
          fail("BUILTIN_INTERRUPTED", "Recovery destination became occupied."),
        )
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* fs.rename(previous, locations.target)
          yield* restore(guard())
          yield* record(pending.directory, journal.operation_id, "rolled_back")
        }),
      )
      return {
        operation_id: journal.operation_id,
        outcome: "rolled_back" as const,
        retained_paths: [staged],
      }
    } else if (
      !previousTree &&
      targetTree &&
      journal.previous_proof === targetProof &&
      stagedTree &&
      stagedProof === stagedTreeProof &&
      retained &&
      !published &&
      !trashStarted &&
      !trashed
    ) {
      outcome = "rolled_back"
    } else if (
      !previousTree &&
      !retained &&
      !published &&
      !trashStarted &&
      !trashed &&
      ((!targetTree && journal.previous_proof === undefined) ||
        (targetTree !== undefined && targetProof === journal.previous_proof))
    ) {
      outcome = "not_applied"
    } else {
      return yield* Effect.fail(
        fail(
          "BUILTIN_INTERRUPTED",
          "Transaction readback is ambiguous; retained and user bytes remain untouched.",
        ),
      )
    }
    yield* guard()
    yield* record(pending.directory, journal.operation_id, outcome)
    return {
      operation_id: journal.operation_id,
      outcome,
      retained_paths: stagedTree ? [staged] : [],
    }
  }).pipe(Effect.mapError(safeError))
}

export function manageBuiltinTree<R>(
  skill: BuiltinSkill,
  agentDir: string,
  operation: "install" | "update",
  options: BuiltinInstallOptions,
  distributionGuard: () => Effect.Effect<void, SkillsError, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const info = yield* builtinInfo(skill)
    const files = yield* Effect.try({ try: () => portableFiles(skill.portable), catch: safeError })
    if (
      files.some(
        (file) =>
          file.path === BUILTIN_INSTALL_RECEIPT ||
          file.path.startsWith(`${BUILTIN_INSTALL_RECEIPT}/`),
      )
    )
      return yield* Effect.fail(
        fail("INVALID_SKILL", "The built-in contains the reserved installation receipt path."),
      )
    const agent = yield* canonicalProfile(agentDir)
    const locations = yield* layout(agent, info)
    if (operation === "update" && !(yield* lstat(agent)))
      return yield* Effect.fail(
        fail("BUILTIN_NOT_INSTALLED", "Install this built-in before updating it.", {
          path: locations.target,
        }),
      )
    yield* fs.makeDirectory(agent, { recursive: true, mode: 0o700 })
    const root = yield* ordinaryDirectory(agent)
    if (!root || (yield* fs.realPath(agentDir)) !== agent)
      return yield* Effect.fail(
        fail("BUILTIN_PATH_CHANGED", "The central data directory changed before locking."),
      )
    for (const directory of [
      locations.state,
      path.join(locations.state, "sync"),
      path.join(locations.state, "sync", "locks"),
    ])
      yield* ordinaryDirectory(directory, true)
    const rootIdentity = inode(root)
    const guard = () =>
      Effect.gen(function* () {
        yield* distributionGuard()
        const root = yield* ordinaryDirectory(agent)
        if (!root || inode(root) !== rootIdentity || (yield* fs.realPath(agentDir)) !== agent)
          return yield* Effect.fail(
            fail("BUILTIN_PATH_CHANGED", "The active profile changed during the operation."),
          )
        for (const directory of [
          locations.state,
          path.join(locations.state, "builtin"),
          locations.transactions,
          path.dirname(locations.target),
        ])
          yield* ordinaryDirectory(directory)
      }).pipe(Effect.mapError(safeError))
    yield* guard()
    const observed = yield* observe(info, locations)
    if (observed.pending.length) {
      if (observed.pending.length !== 1)
        return yield* Effect.fail(
          fail(
            "BUILTIN_INTERRUPTED",
            "Multiple pending transactions require inspection.",
            observed.installation,
          ),
        )
      const recoveryDirectories = [
        locations.state,
        path.join(locations.state, "builtin"),
        locations.transactions,
        observed.pending[0]!.directory,
        path.dirname(locations.target),
      ]
      const recoveryIdentities = yield* Effect.forEach(
        recoveryDirectories,
        (directory) =>
          Effect.gen(function* () {
            const stat = yield* ordinaryDirectory(directory)
            return [directory, stat ? inode(stat) : undefined] as const
          }),
        { concurrency: "unbounded" },
      )
      const recoveryGuard = () =>
        Effect.gen(function* () {
          yield* guard()
          for (const [directory, identity] of recoveryIdentities) {
            const current = yield* ordinaryDirectory(directory)
            if ((current ? inode(current) : undefined) !== identity)
              return yield* Effect.fail(
                fail("BUILTIN_PATH_CHANGED", "A recovery parent changed identity."),
              )
          }
        })
      const recovery = yield* recover(
        observed.pending[0]!,
        info,
        locations,
        options,
        recoveryGuard,
      ).pipe(
        Effect.mapError((error) =>
          fail(
            "BUILTIN_INTERRUPTED",
            "The pending transaction remains fenced; inspect retained bytes before retrying.",
            {
              installation: observed.installation,
              cause: safeError(error).code,
              reason: safeError(error).message,
            },
          ),
        ),
      )
      const current = yield* observe(info, locations)
      return yield* Effect.fail(
        fail(
          "BUILTIN_INTERRUPTED",
          "The prior transaction was recovered. Observe status, then repeat the requested operation.",
          { recovery, installation: current.installation },
        ),
      )
    }
    const state = observed.installation.state
    if (state === "unmanaged")
      return yield* Effect.fail(
        fail(
          "BUILTIN_UNMANAGED",
          "An unregistered directory already occupies the built-in destination.",
          observed.installation,
        ),
      )
    if (state === "modified")
      return yield* Effect.fail(
        fail(
          "BUILTIN_MODIFIED",
          "Installed bytes differ from their receipt; local changes were preserved.",
          observed.installation,
        ),
      )
    if (state === "not_installed" && operation === "update")
      return yield* Effect.fail(
        fail(
          "BUILTIN_NOT_INSTALLED",
          "Install this built-in before updating it.",
          observed.installation,
        ),
      )
    if (state === "current")
      return {
        source: "builtin" as const,
        operation,
        builtin: info,
        installation: observed.installation,
        reused: true,
      }
    if (state === "update_available" && operation === "install")
      return yield* Effect.fail(
        fail(
          "BUILTIN_UPDATE_AVAILABLE",
          "A clean older installation exists; use builtin update explicitly.",
          observed.installation,
        ),
      )
    if (observed.tree) yield* trashCapability(options)
    yield* guard()
    for (const directory of [
      path.dirname(locations.target),
      path.join(locations.state, "builtin"),
      locations.transactions,
    ])
      yield* ordinaryDirectory(directory, true)
    const skillsDirectory = yield* ordinaryDirectory(path.dirname(locations.target))
    if (!skillsDirectory)
      return yield* Effect.fail(
        fail("BUILTIN_PATH_CHANGED", "The skills directory disappeared before replacement."),
      )
    const skillsIdentity = inode(skillsDirectory)
    const managementIdentities = yield* Effect.forEach(
      [locations.state, path.join(locations.state, "builtin"), locations.transactions],
      (directory) =>
        Effect.gen(function* () {
          const stat = yield* ordinaryDirectory(directory)
          if (!stat)
            return yield* Effect.fail(
              fail(
                "BUILTIN_PATH_CHANGED",
                "A management directory disappeared before replacement.",
              ),
            )
          return [directory, inode(stat)] as const
        }),
      { concurrency: "unbounded" },
    )
    const destinationGuard = () =>
      Effect.gen(function* () {
        yield* guard()
        const skillsDirectory = yield* ordinaryDirectory(path.dirname(locations.target))
        if (!skillsDirectory || inode(skillsDirectory) !== skillsIdentity)
          return yield* Effect.fail(
            fail("BUILTIN_PATH_CHANGED", "The skills directory changed identity."),
          )
        for (const [directory, identity] of managementIdentities) {
          const stat = yield* ordinaryDirectory(directory)
          if (!stat || inode(stat) !== identity)
            return yield* Effect.fail(
              fail("BUILTIN_PATH_CHANGED", "The management directory changed identity."),
            )
        }
      })
    const operationId = yield* crypto.randomUUIDv4()
    const directory = path.join(locations.transactions, operationId)
    const staged = path.join(directory, "staged")
    const previous = path.join(directory, "previous")
    const receipt: BuiltinInstallReceipt = {
      format: "ntn-skills-builtin-install",
      version: 2,
      id: info.id,
      data_dir: agent,
      path: locations.target,
      package_version: info.package_version,
      content_id: info.content_id,
      files: yield* Effect.forEach(files, (file) =>
        Effect.gen(function* () {
          const sha256 = yield* digest(file.bytes)
          return {
            path: file.path,
            bytes: file.bytes.length,
            sha256,
          }
        }),
      ),
    }
    const journal: Journal = {
      format: "ntn-skills-builtin-transaction",
      version: 1,
      operation_id: operationId,
      operation,
      receipt,
      ...(observed.tree ? { previous_proof: yield* proof(observed.tree) } : {}),
    }
    yield* fs.makeDirectory(directory, { mode: 0o700 })
    const transactionDirectory = yield* ordinaryDirectory(directory)
    if (!transactionDirectory)
      return yield* Effect.fail(
        fail("BUILTIN_PATH_CHANGED", "The transaction directory disappeared before staging."),
      )
    managementIdentities.push([directory, inode(transactionDirectory)])
    return yield* Effect.gen(function* () {
      yield* fs.writeFileString(
        path.join(directory, "journal.json"),
        JSON.stringify(journal) + "\n",
        {
          flag: "wx",
          mode: 0o600,
        },
      )
      if (options.beforeBoundary)
        yield* options.beforeBoundary({ kind: "stage", path: staged, operation_id: operationId })
      yield* destinationGuard()
      yield* fs.makeDirectory(staged, { mode: 0o700 })
      for (const file of files) {
        const destination = path.join(staged, file.path)
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true, mode: 0o700 })
        yield* fs.writeFile(destination, file.bytes, { flag: "wx", mode: 0o600 })
      }
      yield* fs.writeFileString(
        path.join(staged, BUILTIN_INSTALL_RECEIPT),
        JSON.stringify(receipt) + "\n",
        { flag: "wx", mode: 0o600 },
      )
      const stagedTree = yield* inspect(staged, info, locations)
      if (!clean(stagedTree, receipt) || !stagedTree)
        return yield* Effect.fail(
          fail("BUILTIN_INTERRUPTED", "The staged tree failed complete readback."),
        )
      const stagedProof = yield* proof(stagedTree)
      yield* record(directory, operationId, "staged", { proof: stagedProof })
      if (observed.tree) {
        if (options.beforeBoundary)
          yield* options.beforeBoundary({
            kind: "retain",
            path: locations.target,
            operation_id: operationId,
          })
        yield* destinationGuard()
        const latest = yield* inspect(locations.target, info, locations)
        if (!latest || (yield* proof(latest)) !== journal.previous_proof)
          return yield* Effect.fail(
            fail("BUILTIN_MODIFIED", "Installed bytes or identity changed before replacement."),
          )
        yield* Effect.gen(function* () {
          yield* fs.rename(locations.target, previous)
          yield* record(directory, operationId, "retained")
        }).pipe(Effect.uninterruptible)
      }
      if (options.beforeBoundary)
        yield* options.beforeBoundary({
          kind: "publish",
          path: locations.target,
          operation_id: operationId,
        })
      yield* destinationGuard()
      const beforePublish = yield* inspect(staged, info, locations)
      if (
        !clean(beforePublish, receipt) ||
        !beforePublish ||
        (yield* proof(beforePublish)) !== stagedProof
      )
        return yield* Effect.fail(
          fail("BUILTIN_INTERRUPTED", "Staged bytes changed before publication."),
        )
      if (yield* lstat(locations.target))
        return yield* Effect.fail(
          fail(
            observed.tree ? "BUILTIN_MODIFIED" : "BUILTIN_UNMANAGED",
            "The destination became occupied before publication.",
          ),
        )
      yield* Effect.gen(function* () {
        yield* fs.rename(staged, locations.target)
        yield* record(directory, operationId, "published")
      }).pipe(Effect.uninterruptible)
      if (!clean(yield* inspect(locations.target, info, locations), receipt))
        return yield* Effect.fail(
          fail("BUILTIN_INTERRUPTED", "The published tree failed complete readback."),
        )
      if (observed.tree) {
        if (options.beforeBoundary)
          yield* options.beforeBoundary({
            kind: "trash",
            path: previous,
            operation_id: operationId,
          })
        yield* destinationGuard()
        const currentPublished = yield* inspect(locations.target, info, locations)
        if (
          !clean(currentPublished, receipt) ||
          !currentPublished ||
          (yield* proof(currentPublished)) !== stagedProof
        )
          return yield* Effect.fail(
            fail(
              "BUILTIN_INTERRUPTED",
              "Published bytes changed before retention; prior bytes remain retained.",
            ),
          )
        const retained = yield* inspect(previous, info, locations)
        if (!retained || (yield* proof(retained)) !== journal.previous_proof)
          return yield* Effect.fail(
            fail(
              "BUILTIN_INTERRUPTED",
              "Retained prior bytes changed; they were preserved in place.",
            ),
          )
        yield* Effect.gen(function* () {
          yield* record(directory, operationId, "trash_started")
          yield* (options.trash ?? trashPath)(previous)
          yield* record(directory, operationId, "trashed")
        }).pipe(Effect.uninterruptible)
      }
      yield* record(directory, operationId, "completed")
      return {
        source: "builtin" as const,
        operation,
        builtin: info,
        reused: false,
        installation: {
          ...installation(info, locations, yield* inspect(locations.target, info, locations)),
          reload_required: true,
        },
      }
    }).pipe(
      Effect.mapError((error) =>
        fail(
          "BUILTIN_INTERRUPTED",
          "The installation was interrupted; status and the retained journal describe recovery.",
          {
            journal_path: path.join(directory, "journal.json"),
            operation_id: operationId,
            retained_paths: [staged, previous],
            cause: safeError(error).code,
            reason: safeError(error).message,
          },
        ),
      ),
    )
  }).pipe(Effect.mapError(safeError))
}
