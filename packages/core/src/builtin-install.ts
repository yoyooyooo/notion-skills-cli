import { Crypto, Effect, FileSystem, Path } from "effect"
import { builtinInfo, type BuiltinInfo, type BuiltinSkill } from "./builtin.ts"
import {
  builtinLocations,
  canonicalProfile,
  digest as treeDigest,
  equal,
  inode,
  lstat,
  observe,
  ordinaryDirectory,
  readRegular,
  resolveBuiltinDataDir,
  safeError,
  type BuiltinInstallOptions,
  type Layout,
} from "./builtin-install-tree.ts"
import { manageBuiltinTree } from "./builtin-install-transaction.ts"
import { withLocalLocks } from "./local-locks.ts"
import { fail, property, SkillsError } from "./model.ts"

export {
  BUILTIN_INSTALL_RECEIPT,
  resolveBuiltinDataDir,
  type BuiltinInstallFile,
  type BuiltinInstallReceipt,
  type BuiltinDistribution,
  type BuiltinInstallationState,
  type BuiltinInstallation,
  type BuiltinInstallBoundary,
  type BuiltinInstallOptions,
} from "./builtin-install-tree.ts"

type DistributionRecord = {
  agent_dir: string
  path: string
  target: string
  dev: string
  ino: string
  phase: "pending" | "linked"
  staged_path: string
}
type DistributionRegistry = {
  format: "ntn-skills-builtin-distributions"
  version: 1
  id: string
  data_dir: string
  path: string
  distributions: DistributionRecord[]
}

const digest = (bytes: Uint8Array | undefined) =>
  Effect.gen(function* () {
    if (!bytes) return undefined
    return yield* treeDigest(bytes)
  }).pipe(Effect.mapError(safeError))

function distributionRegistry(info: BuiltinInfo, locations: Layout) {
  return Effect.gen(function* () {
    const path = yield* Path.Path
    const directory = path.join(locations.state, "distributions")
    yield* ordinaryDirectory(locations.state)
    yield* ordinaryDirectory(directory)
    const location = path.join(directory, `${info.name}.json`)
    const stat = yield* lstat(location)
    const bytes = yield* readRegular(location)
    const after = yield* lstat(location)
    if ((stat ? inode(stat) : undefined) !== (after ? inode(after) : undefined))
      return yield* Effect.fail(
        fail(
          "BUILTIN_PATH_CHANGED",
          "The distribution registry changed identity while being read.",
          { path: location },
        ),
      )
    const empty: DistributionRegistry = {
      format: "ntn-skills-builtin-distributions",
      version: 1,
      id: info.id,
      data_dir: locations.agent,
      path: locations.target,
      distributions: [],
    }
    const registry = !stat
      ? empty
      : yield* Effect.try({
          try: () => {
            const raw = property(bytes && JSON.parse(new TextDecoder().decode(bytes)))
            if (
              Array.isArray(raw.distributions) &&
              raw.distributions.some((value) => {
                const entry = property(value)
                return "retained_path" in entry || "legacy_proof" in entry
              })
            )
              throw fail(
                "BUILTIN_MIGRATION_REQUIRED",
                "This distribution registry contains legacy migration ownership; run the explicit migration before continuing.",
                { path: location },
              )
            if (
              raw.format !== empty.format ||
              raw.version !== 1 ||
              raw.id !== info.id ||
              raw.data_dir !== locations.agent ||
              raw.path !== locations.target ||
              !Array.isArray(raw.distributions)
            )
              throw new Error("Invalid distribution registry")
            const seen = new Set<string>()
            for (const value of raw.distributions) {
              const entry = property(value)
              if (
                typeof entry.agent_dir !== "string" ||
                !path.isAbsolute(entry.agent_dir) ||
                entry.path !== path.join(entry.agent_dir, "skills", info.name) ||
                entry.target !== locations.target ||
                typeof entry.dev !== "string" ||
                !/^\d+$/.test(entry.dev) ||
                typeof entry.ino !== "string" ||
                !/^\d+$/.test(entry.ino) ||
                (entry.phase !== "pending" && entry.phase !== "linked") ||
                typeof entry.staged_path !== "string" ||
                path.dirname(entry.staged_path) !==
                  path.join(entry.agent_dir, ".ntn-skills", "distributions") ||
                seen.has(entry.path)
              )
                throw new Error("Invalid distribution record")
              seen.add(entry.path as string)
            }
            return raw as unknown as DistributionRegistry
          },
          catch: (error) =>
            error instanceof SkillsError
              ? error
              : fail(
                  "BUILTIN_DISTRIBUTION_CONFLICT",
                  "The central distribution registry is invalid; no destination may be adopted.",
                  { path: location },
                ),
        })
    return { location, registry, bytes, identity: stat ? inode(stat) : undefined }
  }).pipe(Effect.mapError(safeError))
}

function inspectDistribution(
  info: BuiltinInfo,
  locations: Layout,
  agent: string,
  entry: DistributionRecord | undefined,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const destination = path.join(agent, "skills", info.name)
    const base = { agent_dir: agent, path: destination }
    return yield* Effect.gen(function* () {
      if ((yield* canonicalProfile(agent)) !== agent)
        return { ...base, state: "conflict" as const, reason: "agent_directory_changed" }
      yield* ordinaryDirectory(path.join(agent, "skills"))
      const stat = yield* lstat(destination)
      if (!entry)
        return !stat
          ? { ...base, state: "missing" as const }
          : { ...base, state: "conflict" as const, reason: "unregistered_destination" }
      if (
        stat?.isSymbolicLink() &&
        String(stat.dev) === entry.dev &&
        String(stat.ino) === entry.ino &&
        (yield* fs.readLink(destination)) === locations.target
      )
        return {
          ...base,
          state: entry.phase === "pending" ? ("interrupted" as const) : ("linked" as const),
        }
      if (entry.phase === "pending") {
        yield* ordinaryDirectory(path.join(agent, ".ntn-skills"))
        yield* ordinaryDirectory(path.dirname(entry.staged_path))
        const staged = yield* lstat(entry.staged_path)
        if (
          !staged?.isSymbolicLink() ||
          String(staged.dev) !== entry.dev ||
          String(staged.ino) !== entry.ino ||
          (yield* fs.readLink(entry.staged_path)) !== locations.target
        )
          return { ...base, state: "conflict" as const, reason: "staged_link_changed" }
      }
      if (!stat)
        return {
          ...base,
          state: entry.phase === "pending" ? ("interrupted" as const) : ("missing" as const),
        }
      return { ...base, state: "conflict" as const, reason: "registered_link_changed" }
    }).pipe(
      Effect.mapError(safeError),
      Effect.catch((error) =>
        Effect.succeed({ ...base, state: "conflict" as const, reason: error.code }),
      ),
    )
  })
}

/** Read-only, including absent data and agent directories. */
export function builtinStatus(
  skills: readonly BuiltinSkill[],
  agentDirs?: string | readonly string[],
  options: BuiltinInstallOptions = {},
) {
  return Effect.gen(function* () {
    const entries = yield* Effect.forEach(skills, (skill) =>
      Effect.gen(function* () {
        const info = yield* builtinInfo(skill)
        const { locations, agents } = yield* builtinLocations(info, agentDirs, options)
        const current = (yield* observe(info, locations)).installation
        const installation = yield* Effect.gen(function* () {
          const { registry } = yield* distributionRegistry(info, locations)
          const all = [
            ...new Set([...agents, ...registry.distributions.map((entry) => entry.agent_dir)]),
          ]
          const distributions = yield* Effect.forEach(all, (agent) =>
            inspectDistribution(
              info,
              locations,
              agent,
              registry.distributions.find((entry) => entry.agent_dir === agent),
            ),
          )
          return { ...current, distributions }
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ...current,
              distribution_error: { code: error.code, message: error.message },
            }),
          ),
        )
        return { ...info, installation }
      }),
    )
    const data_dir =
      entries[0]?.installation.data_dir ??
      (yield* canonicalProfile(
        yield* resolveBuiltinDataDir(
          {
            ...process.env,
            ...(options.dataDir ? { NTN_SKILLS_DATA_HOME: options.dataDir } : {}),
          },
          options.homeDir,
        ),
      ))
    return { source: "builtin" as const, data_dir, skills: entries, count: entries.length }
  }).pipe(Effect.mapError(safeError))
}

function manageBuiltin(
  skill: BuiltinSkill,
  agentDirs: string | readonly string[] | undefined,
  operation: "install" | "update",
  options: BuiltinInstallOptions,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const info = yield* builtinInfo(skill)
    const { locations, agents } = yield* builtinLocations(info, agentDirs, options)
    const initial = yield* distributionRegistry(info, locations)
    const initialAgents = [
      ...new Set([...agents, ...initial.registry.distributions.map((entry) => entry.agent_dir)]),
    ]
    const initialDistributions = yield* Effect.forEach(initialAgents, (agent) =>
      inspectDistribution(
        info,
        locations,
        agent,
        initial.registry.distributions.find((entry) => entry.agent_dir === agent),
      ),
    )
    const initialCurrent = yield* observe(info, locations)
    const initialConflict = initialDistributions.find((entry) => entry.state === "conflict")
    if (initialConflict)
      return yield* Effect.fail(
        fail(
          "BUILTIN_DISTRIBUTION_CONFLICT",
          "A distribution destination conflicts with this installation; existing bytes were preserved.",
          { installation: initialCurrent.installation, distribution: initialConflict },
        ),
      )
    if (operation === "update" && initialCurrent.installation.state === "not_installed")
      return yield* Effect.fail(
        fail(
          "BUILTIN_NOT_INSTALLED",
          "Install this built-in before updating it.",
          initialCurrent.installation,
        ),
      )
    yield* fs.makeDirectory(locations.agent, { recursive: true, mode: 0o700 })
    for (const directory of [
      locations.state,
      path.join(locations.state, "sync"),
      path.join(locations.state, "sync", "locks"),
    ])
      yield* ordinaryDirectory(directory, true)
    return yield* withLocalLocks(
      locations.state,
      [`builtin-central:${locations.agent}:${info.name}`],
      Effect.gen(function* () {
        const stored = yield* distributionRegistry(info, locations)
        const registry = stored.registry
        let registryHash = yield* digest(stored.bytes)
        let registryIdentity = stored.identity
        const all = [
          ...new Set([...agents, ...registry.distributions.map((entry) => entry.agent_dir)]),
        ]
        const inspectAll = () =>
          Effect.forEach(all, (agent) =>
            inspectDistribution(
              info,
              locations,
              agent,
              registry.distributions.find((entry) => entry.agent_dir === agent),
            ),
          )
        const preflight = yield* inspectAll()
        const conflict = preflight.find((entry) => entry.state === "conflict")
        if (conflict)
          return yield* Effect.fail(
            fail(
              "BUILTIN_DISTRIBUTION_CONFLICT",
              "A distribution destination conflicts with this installation; existing bytes were preserved.",
              { distribution: conflict },
            ),
          )
        const distributionParents = [
          ...new Set(all.flatMap((agent) => [agent, path.join(agent, "skills")])),
        ]
        const identities = (directories: readonly string[]) =>
          Effect.forEach(directories, (directory) =>
            ordinaryDirectory(directory).pipe(
              Effect.map((stat) => (stat ? inode(stat) : undefined)),
            ),
          )
        const distributionIdentities = yield* identities(distributionParents)
        const registryGuard = () =>
          Effect.gen(function* () {
            const latest = yield* distributionRegistry(info, locations)
            if (
              latest.identity !== registryIdentity ||
              (yield* digest(latest.bytes)) !== registryHash
            )
              return yield* Effect.fail(
                fail(
                  "BUILTIN_DISTRIBUTION_CONFLICT",
                  "The distribution registry changed during the operation.",
                ),
              )
          })
        const distributionGuard = () =>
          Effect.gen(function* () {
            if (!equal(yield* identities(distributionParents), distributionIdentities))
              return yield* Effect.fail(
                fail(
                  "BUILTIN_PATH_CHANGED",
                  "A distribution parent changed during the central operation.",
                ),
              )
            const current = yield* inspectAll()
            if (!equal(current, preflight))
              return yield* Effect.fail(
                fail(
                  "BUILTIN_DISTRIBUTION_CONFLICT",
                  "A distribution changed during the central operation.",
                  { distributions: current },
                ),
              )
            yield* registryGuard()
          })
        const result = yield* manageBuiltinTree(
          skill,
          locations.agent,
          operation,
          options,
          distributionGuard,
        )
        let linked = false
        yield* Effect.gen(function* () {
          yield* ordinaryDirectory(path.join(locations.state, "distributions"), true)
          const centralDirectories = [
            locations.agent,
            locations.state,
            path.join(locations.state, "distributions"),
            path.dirname(locations.target),
          ]
          const centralIdentities = yield* identities(centralDirectories)
          const centralGuard = () =>
            Effect.gen(function* () {
              const current = yield* identities(centralDirectories)
              if (
                current.some((identity) => identity === undefined) ||
                !equal(current, centralIdentities)
              )
                return yield* Effect.fail(
                  fail("BUILTIN_PATH_CHANGED", "A central distribution parent changed identity."),
                )
              yield* registryGuard()
            })
          const save = () =>
            Effect.gen(function* () {
              yield* centralGuard()
              const temporary = `${stored.location}.${yield* crypto.randomUUIDv4()}`
              const bytes = new TextEncoder().encode(JSON.stringify(registry) + "\n")
              yield* fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
              const temporaryStat = yield* lstat(temporary)
              if (!temporaryStat?.isFile())
                return yield* Effect.fail(
                  fail(
                    "BUILTIN_PATH_CHANGED",
                    "The staged distribution registry changed identity.",
                  ),
                )
              yield* centralGuard()
              yield* fs.rename(temporary, stored.location)
              const written = yield* lstat(stored.location)
              if (!written?.isFile() || inode(written) !== inode(temporaryStat))
                return yield* Effect.fail(
                  fail(
                    "BUILTIN_PATH_CHANGED",
                    "The published distribution registry changed identity.",
                  ),
                )
              registryIdentity = inode(written)
              registryHash = yield* digest(bytes)
              yield* registryGuard()
            }).pipe(Effect.mapError(safeError), Effect.uninterruptible)
          const ownedLink = (location: string, entry: DistributionRecord) =>
            Effect.gen(function* () {
              const stat = yield* lstat(location)
              return Boolean(
                stat?.isSymbolicLink() &&
                  String(stat.dev) === entry.dev &&
                  String(stat.ino) === entry.ino &&
                  (yield* fs.readLink(location)) === locations.target,
              )
            })
          for (const agent of all) {
            let entry = registry.distributions.find((entry) => entry.agent_dir === agent)
            const observed = yield* inspectDistribution(info, locations, agent, entry)
            if (observed.state === "conflict")
              return yield* Effect.fail(
                fail("BUILTIN_DISTRIBUTION_CONFLICT", "The distribution changed before linking.", {
                  distribution: observed,
                }),
              )
            if (observed.state === "linked") continue
            const directories = [
              agent,
              path.join(agent, "skills"),
              path.join(agent, ".ntn-skills"),
              path.join(agent, ".ntn-skills", "distributions"),
            ]
            for (const directory of directories) {
              if (!equal(yield* identities(distributionParents), distributionIdentities))
                return yield* Effect.fail(
                  fail("BUILTIN_PATH_CHANGED", "A distribution parent changed before linking."),
                )
              const missing: string[] = []
              let ancestor = directory
              while (!(yield* ordinaryDirectory(ancestor))) {
                missing.push(ancestor)
                const parent = path.dirname(ancestor)
                if (parent === ancestor)
                  return yield* Effect.fail(
                    fail("BUILTIN_PATH_CHANGED", "A distribution ancestor is unavailable."),
                  )
                ancestor = parent
              }
              for (const created of missing.reverse()) {
                // Exclusive creation proves which formerly missing snapshots belong
                // to this operation, including ancestors shared by nested agents.
                yield* fs.makeDirectory(created, { mode: 0o700 })
                const stat = yield* ordinaryDirectory(created)
                if (!stat)
                  return yield* Effect.fail(
                    fail("BUILTIN_PATH_CHANGED", "A created distribution parent disappeared."),
                  )
                const index = distributionParents.indexOf(created)
                if (index !== -1 && distributionIdentities[index] === undefined)
                  distributionIdentities[index] = inode(stat)
              }
            }
            const parentIdentities = yield* identities(directories)
            const guard = () =>
              Effect.gen(function* () {
                yield* centralGuard()
                if ((yield* canonicalProfile(agent)) !== agent)
                  return yield* Effect.fail(
                    fail("BUILTIN_PATH_CHANGED", "An agent directory changed while linking."),
                  )
                const currentParents = yield* identities(directories)
                if (
                  currentParents.some((identity) => identity === undefined) ||
                  !equal(currentParents, parentIdentities)
                )
                  return yield* Effect.fail(
                    fail("BUILTIN_PATH_CHANGED", "A distribution parent changed identity."),
                  )
                const current = yield* observe(info, locations)
                if (current.installation.state !== "current")
                  return yield* Effect.fail(
                    fail(
                      "BUILTIN_MODIFIED",
                      "Central content changed before distribution.",
                      current.installation,
                    ),
                  )
              })
            if (!entry || (observed.state === "missing" && entry.phase === "linked")) {
              const operationId = yield* crypto.randomUUIDv4()
              const staged = path.join(
                agent,
                ".ntn-skills",
                "distributions",
                `${info.name}-${operationId}.link`,
              )
              const previousEntry = entry
              entry = yield* Effect.gen(function* () {
                yield* guard()
                yield* fs.symlink(locations.target, staged)
                const stat = yield* lstat(staged)
                if (!stat?.isSymbolicLink() || (yield* fs.readLink(staged)) !== locations.target)
                  return yield* Effect.fail(
                    fail("BUILTIN_INTERRUPTED", "The staged distribution link cannot be proved."),
                  )
                const next: DistributionRecord = {
                  agent_dir: agent,
                  path: observed.path,
                  target: locations.target,
                  phase: "pending",
                  staged_path: staged,
                  dev: String(stat.dev),
                  ino: String(stat.ino),
                }
                if (previousEntry)
                  registry.distributions[registry.distributions.indexOf(previousEntry)] = next
                else registry.distributions.push(next)
                yield* save()
                return next
              }).pipe(Effect.uninterruptible)
            }
            if (!entry)
              return yield* Effect.fail(
                fail("BUILTIN_INTERRUPTED", "The distribution registration is missing."),
              )
            const registered = entry
            if (!(yield* ownedLink(registered.path, registered))) {
              if (!(yield* ownedLink(registered.staged_path, registered)))
                return yield* Effect.fail(
                  fail(
                    "BUILTIN_INTERRUPTED",
                    "The staged distribution link cannot be proved; existing bytes remain untouched.",
                    { distribution: registered },
                  ),
                )
              if (options.beforeBoundary)
                yield* options.beforeBoundary({
                  kind: "publish",
                  path: registered.path,
                  operation_id: path.basename(registered.staged_path),
                })
              yield* Effect.gen(function* () {
                yield* guard()
                if (!(yield* ownedLink(registered.staged_path, registered)))
                  return yield* Effect.fail(
                    fail(
                      "BUILTIN_INTERRUPTED",
                      "The distribution link changed before publication.",
                      { distribution: registered },
                    ),
                  )
                if (yield* lstat(registered.path))
                  return yield* Effect.fail(
                    fail(
                      "BUILTIN_DISTRIBUTION_CONFLICT",
                      "The distribution destination became occupied.",
                      { path: registered.path },
                    ),
                  )
                yield* fs.rename(registered.staged_path, registered.path)
                linked = true
              }).pipe(Effect.uninterruptible)
            }
            yield* Effect.gen(function* () {
              yield* guard()
              if (!(yield* ownedLink(registered.path, registered)))
                return yield* Effect.fail(
                  fail(
                    "BUILTIN_DISTRIBUTION_CONFLICT",
                    "The distribution failed ownership readback.",
                    { distribution: registered },
                  ),
                )
              registered.phase = "linked"
              yield* save()
            }).pipe(Effect.uninterruptible)
          }
        }).pipe(
          Effect.mapError((error) => {
            const cause = safeError(error)
            return fail(
              [
                "BUILTIN_DISTRIBUTION_CONFLICT",
                "BUILTIN_MODIFIED",
                "BUILTIN_MIGRATION_REQUIRED",
                "RETENTION_UNAVAILABLE",
              ].includes(cause.code)
                ? cause.code
                : "BUILTIN_INTERRUPTED",
              "Distribution publication did not complete; inspect status and retry without changing registered bytes.",
              {
                installation: result.installation,
                cause: cause.code,
                reason: cause.message,
                details: cause.details,
                distributions: registry.distributions,
              },
            )
          }),
        )
        const status = yield* builtinStatus([skill], agentDirs, options)
        return {
          ...result,
          operation,
          installation: {
            ...status.skills[0]!.installation,
            reload_required: result.installation.reload_required || linked,
          },
        }
      }),
    )
  }).pipe(Effect.mapError(safeError))
}

export function installBuiltin(
  skill: BuiltinSkill,
  agentDirs?: string | readonly string[],
  options: BuiltinInstallOptions = {},
) {
  return manageBuiltin(skill, agentDirs, "install", options)
}
export function updateBuiltin(
  skill: BuiltinSkill,
  agentDirs?: string | readonly string[],
  options: BuiltinInstallOptions = {},
) {
  return manageBuiltin(skill, agentDirs, "update", options)
}
