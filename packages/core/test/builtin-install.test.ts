import { afterEach, expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Deferred, Effect, Exit, Fiber, FileSystem } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { defineBuiltin, type BuiltinSkill } from "../src/builtin.ts"
import {
  BUILTIN_INSTALL_RECEIPT,
  builtinStatus,
  installBuiltin,
  resolveBuiltinDataDir,
  updateBuiltin,
  type BuiltinInstallOptions,
  type BuiltinInstallReceipt,
} from "../src/builtin-install.ts"
import { fail, property, SkillsError } from "../src/model.ts"

const encoder = new TextEncoder()
const skill = (
  body: string,
  resources: readonly { path: string; bytes: Uint8Array }[] = [],
  version = "1.0.0",
) =>
  defineBuiltin("notion/managed-fixture", version, [
    {
      path: "SKILL.md",
      bytes: encoder.encode(
        `---\nname: managed-fixture\ndescription: Builtin installation fixture\n---\n\n${body}\n`,
      ),
    },
    ...resources,
  ])
const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      // Keep released lock history inside its fixture, just like options.trash
      // keeps prior trees. No host Trash process belongs to these pure cases.
      const retained = {
        ...real,
        exitCode: (command: Parameters<typeof real.exitCode>[0]) => {
          if (command._tag !== "StandardCommand") return real.exitCode(command)
          if (
            command.command === "/bin/test" &&
            command.args.length === 2 &&
            command.args[0] === "-x" &&
            command.args[1] === "/usr/bin/trash"
          )
            return Effect.promise(() =>
              fs.access("/usr/bin/trash", constants.X_OK).then(
                () => ChildProcessSpawner.ExitCode(0),
                () => ChildProcessSpawner.ExitCode(1),
              ),
            )
          if (command.command !== "/usr/bin/trash") return real.exitCode(command)
          return Effect.promise(async () => {
            const source = command.args[0]
            const owner = [...fenceRetentions.entries()].find(([root]) =>
              source?.startsWith(`${root}${path.sep}`),
            )
            if (
              command.args.length !== 1 ||
              !source ||
              !owner ||
              path.dirname(source) !== path.join(owner[0], "data/.ntn-skills/sync/locks") ||
              !/^[a-f0-9]{64}\.[a-f0-9-]{36}\.released$/.test(path.basename(source))
            )
              throw new Error("Refusing retention outside an owned released fence")
            const before = await fs.lstat(source, { bigint: true })
            const receipt = await fs.readFile(path.join(source, "owner.json"))
            expect(before.isDirectory()).toBe(true)
            expect(JSON.parse(receipt.toString())).toMatchObject({ pid: process.pid })
            const destination = path.join(owner[0], "retained", randomUUID())
            await fs.rename(source, destination)
            const after = await fs.lstat(destination, { bigint: true })
            expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
            expect(await fs.readFile(path.join(destination, "owner.json"))).toEqual(receipt)
            await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" })
            owner[1].push(destination)
            return ChildProcessSpawner.ExitCode(0)
          })
        },
      }
      return yield* effect.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, retained),
      )
    }).pipe(Effect.provide(NodeServices.layer)),
  )
const errorOf = (effect: Effect.Effect<unknown, SkillsError, NodeServices.NodeServices>) =>
  run(effect.pipe(Effect.match({ onSuccess: () => undefined, onFailure: (error) => error })))
const roots = new Set<string>()
const fenceRetentions = new Map<string, string[]>()
afterEach(async () => {
  await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true, force: true })))
  roots.clear()
  fenceRetentions.clear()
})
const inject = (attempt: () => Promise<void>): Effect.Effect<void, SkillsError> =>
  Effect.tryPromise({
    try: attempt,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("LOCAL_IO_ERROR", "Test filesystem observer failed."),
  })
async function fixture() {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), "ntn-builtin-install-"))
  roots.add(temporary)
  const root = await fs.realpath(temporary)
  const agent = path.join(root, "agent")
  const data = path.join(root, "data")
  const home = path.join(root, "home")
  const retained = path.join(root, "retained")
  await fs.mkdir(retained)
  const retired: string[] = []
  const retiredFences: string[] = []
  fenceRetentions.set(root, retiredFences)
  const options: BuiltinInstallOptions = {
    dataDir: data,
    homeDir: home,
    trash: (source) =>
      Effect.gen(function* () {
        const filesystem = yield* FileSystem.FileSystem
        const crypto = yield* Crypto.Crypto
        const destination = path.join(retained, yield* crypto.randomUUIDv4())
        yield* filesystem.rename(source, destination)
        retired.push(destination)
      }).pipe(
        Effect.mapError(() => fail("RETENTION_FAILED", "Test tree retention failed.")),
        Effect.provide(NodeServices.layer),
      ),
  }
  const status = async (builtin: BuiltinSkill) =>
    (await run(builtinStatus([builtin], agent, options))).skills[0]!.installation
  return { root, agent, data, home, options, retired, retiredFences, status }
}

test("data directory resolution honors full overrides, home expansion and unset whitespace", async () => {
  const home = path.join(tmpdir(), "builtin-resolver-home")
  const cases: readonly [Record<string, string>, string][] = [
    [{ NTN_SKILLS_DATA_HOME: " /custom/app ", XDG_DATA_HOME: "/ignored" }, "/custom/app"],
    [{ NTN_SKILLS_DATA_HOME: "~/app" }, path.join(home, "app")],
    [{ NTN_SKILLS_DATA_HOME: "~" }, home],
    [{ NTN_SKILLS_DATA_HOME: "relative/app" }, path.resolve("relative/app")],
    [{ NTN_SKILLS_DATA_HOME: " \t", XDG_DATA_HOME: " ~/xdg " }, path.join(home, "xdg/ntn-skills")],
    [{ XDG_DATA_HOME: "relative/xdg" }, path.resolve("relative/xdg/ntn-skills")],
    [
      { NTN_SKILLS_DATA_HOME: " ", XDG_DATA_HOME: "\t " },
      path.join(home, ".local/share/ntn-skills"),
    ],
  ]
  for (const [env, expected] of cases)
    expect(await run(resolveBuiltinDataDir(env, home))).toBe(expected)
  expect(await run(resolveBuiltinDataDir({ HOME: ` ${home} ` }))).toBe(
    path.join(home, ".local/share/ntn-skills"),
  )
  expect(await run(resolveBuiltinDataDir({ HOME: " \t" }))).toBe(
    path.join(homedir(), ".local/share/ntn-skills"),
  )
})

async function legacyFixture(builtin: BuiltinSkill) {
  const source = await fixture()
  const installed = await run(installBuiltin(builtin, undefined, source.options))
  const f = await fixture()
  const target = path.join(f.agent, "skills/managed-fixture")
  await fs.cp(installed.installation.path, target, { recursive: true })
  const receiptPath = path.join(target, BUILTIN_INSTALL_RECEIPT)
  const { data_dir: _dataDir, ...receipt }: BuiltinInstallReceipt = JSON.parse(
    await fs.readFile(receiptPath, "utf8"),
  )
  await fs.writeFile(
    receiptPath,
    JSON.stringify({ ...receipt, version: 1, agent_dir: f.agent, path: target }),
  )
  return { ...f, target }
}

test("status observes default and explicit destinations without creating any absent roots", async () => {
  const f = await fixture()
  const extra = path.join(f.root, "other-agent")
  for (const targets of [undefined, [f.agent, extra]]) {
    const observed = await run(builtinStatus([skill("A")], targets, f.options))
    expect(observed.data_dir).toBe(f.data)
    expect(observed.skills[0]!.installation.state).toBe("not_installed")
    expect(observed.skills[0]!.installation.distributions.map((entry) => entry.state)).toEqual(
      targets ? ["missing", "missing", "missing"] : ["missing"],
    )
    expect(await fs.readdir(f.root)).toEqual(["retained"])
  }
})

test("default and repeatable destinations share one tree and persist across unqualified updates", async () => {
  const f = await fixture()
  const original = skill("A")
  const initial = await run(installBuiltin(original, undefined, f.options))
  const shared = path.join(f.home, ".agents/skills/managed-fixture")
  expect(initial.installation.path).toBe(path.join(f.data, "skills/managed-fixture"))
  expect(await fs.readlink(shared)).toBe(initial.installation.path)
  const extra = path.join(f.root, "other-agent")
  const added = await run(installBuiltin(original, [f.agent, extra, f.agent], f.options))
  expect(added.reused).toBe(true)
  expect(added.installation.distributions).toHaveLength(3)
  const links = [
    shared,
    path.join(f.agent, "skills/managed-fixture"),
    path.join(extra, "skills/managed-fixture"),
  ]
  const identities = await Promise.all(links.map(async (link) => (await fs.lstat(link)).ino))
  const next = skill("B")
  expect((await run(updateBuiltin(next, undefined, f.options))).installation.state).toBe("current")
  const status = (await run(builtinStatus([next], undefined, f.options))).skills[0]!.installation
  expect(status.distributions.map((entry) => entry.state)).toEqual(["linked", "linked", "linked"])
  for (const [index, link] of links.entries()) {
    expect(await fs.readlink(link)).toBe(initial.installation.path)
    expect((await fs.lstat(link)).ino).toBe(identities[index]!)
    expect(await fs.readFile(path.join(link, "SKILL.md"), "utf8")).toContain("B")
  }
})

test("nested missing destinations publish every link when the child agent is selected first", async () => {
  const f = await fixture()
  const parent = path.join(f.root, "new")
  const child = path.join(parent, "child")
  const original = skill("nested destinations")
  await expect(fs.lstat(parent)).rejects.toMatchObject({ code: "ENOENT" })
  const installed = await run(installBuiltin(original, [child, parent], f.options))
  expect(installed.installation.state).toBe("current")
  expect(
    installed.installation.distributions.map((entry) => [entry.agent_dir, entry.state]),
  ).toEqual([
    [path.join(f.home, ".agents"), "linked"],
    [child, "linked"],
    [parent, "linked"],
  ])
  for (const agent of [path.join(f.home, ".agents"), child, parent]) {
    const link = path.join(agent, "skills/managed-fixture")
    expect(await fs.readlink(link)).toBe(installed.installation.path)
    expect(await fs.readFile(path.join(link, "SKILL.md"), "utf8")).toContain("nested destinations")
  }
  const status = (await run(builtinStatus([original], undefined, f.options))).skills[0]!
    .installation
  expect(status.state).toBe("current")
  expect(status.distributions.map((entry) => entry.state)).toEqual(["linked", "linked", "linked"])
  expect(status.distribution_error).toBeUndefined()
  expect(f.retired).toHaveLength(0)
})

test("a changed recorded distribution blocks an unqualified central update and preserves all bytes", async () => {
  const f = await fixture()
  const original = skill("A")
  const installed = await run(installBuiltin(original, f.agent, f.options))
  const link = path.join(f.agent, "skills/managed-fixture")
  const removed = path.join(f.root, "original-link")
  await fs.rename(link, removed)
  await fs.mkdir(link)
  await fs.writeFile(path.join(link, "SKILL.md"), "user bytes")
  const receipt = await fs.readFile(path.join(installed.installation.path, BUILTIN_INSTALL_RECEIPT))
  const next = skill("B")
  const status = (await run(builtinStatus([next], undefined, f.options))).skills[0]!.installation
  expect(status.state).toBe("update_available")
  expect(status.distributions.find((entry) => entry.agent_dir === f.agent)?.state).toBe("conflict")
  expect((await errorOf(updateBuiltin(next, undefined, f.options)))?.code).toBe(
    "BUILTIN_DISTRIBUTION_CONFLICT",
  )
  expect(await fs.readFile(path.join(installed.installation.path, "SKILL.md"), "utf8")).toContain(
    "A",
  )
  expect(
    await fs.readFile(path.join(installed.installation.path, BUILTIN_INSTALL_RECEIPT)),
  ).toEqual(receipt)
  expect(await fs.readFile(path.join(link, "SKILL.md"), "utf8")).toBe("user bytes")
  expect(await fs.readlink(removed)).toBe(installed.installation.path)
  expect(f.retired).toHaveLength(0)
})

test("an unregistered symlink to the canonical tree is not adopted as a managed distribution", async () => {
  const f = await fixture()
  const original = skill("A")
  const installed = await run(installBuiltin(original, undefined, f.options))
  const target = path.join(f.agent, "skills/managed-fixture")
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.symlink(installed.installation.path, target)
  const identity = (await fs.lstat(target)).ino
  const status = await f.status(original)
  expect(status.state).toBe("current")
  expect(status.distributions.find((entry) => entry.path === target)?.state).toBe("conflict")
  expect((await errorOf(installBuiltin(original, f.agent, f.options)))?.code).toBe(
    "BUILTIN_DISTRIBUTION_CONFLICT",
  )
  expect((await fs.lstat(target)).ino).toBe(identity)
  expect(await fs.readlink(target)).toBe(installed.installation.path)
  expect(f.retired).toHaveLength(0)
})

test("clean receipt-v1 destinations remain conflicts and preserve every byte without runtime migration", async () => {
  const original = skill("A", [{ path: "assets/legacy", bytes: encoder.encode("legacy bytes") }])
  const f = await legacyFixture(original)
  const receiptPath = path.join(f.target, BUILTIN_INSTALL_RECEIPT)
  const before = await fs.readFile(receiptPath)
  const identity = await fs.lstat(f.target, { bigint: true })
  const unselected = (await run(builtinStatus([original], undefined, f.options))).skills[0]!
    .installation
  expect(unselected.state).toBe("not_installed")
  expect((await errorOf(updateBuiltin(original, undefined, f.options)))?.code).toBe(
    "BUILTIN_NOT_INSTALLED",
  )
  const status = await f.status(original)
  expect(status.state).toBe("not_installed")
  expect(status.distributions.find((entry) => entry.agent_dir === f.agent)?.state).toBe("conflict")
  expect(await fs.readFile(receiptPath)).toEqual(before)
  for (const builtin of [original, skill("B")]) {
    for (const operation of [installBuiltin, updateBuiltin]) {
      expect((await errorOf(operation(builtin, f.agent, f.options)))?.code).toBe(
        "BUILTIN_DISTRIBUTION_CONFLICT",
      )
    }
  }
  const after = await fs.lstat(f.target, { bigint: true })
  expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([
    identity.ino,
    identity.mtimeNs,
    identity.ctimeNs,
  ])
  expect(await fs.readFile(receiptPath)).toEqual(before)
  expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toContain("A")
  expect(await fs.readFile(path.join(f.target, "assets/legacy"), "utf8")).toBe("legacy bytes")
  await expect(fs.lstat(f.data)).rejects.toMatchObject({ code: "ENOENT" })
  expect(f.retired).toHaveLength(0)
})

test("modified receipt-v1 destinations preserve both locations and refuse runtime replacement", async () => {
  const original = skill("A")
  const f = await legacyFixture(original)
  await fs.writeFile(path.join(f.target, "SKILL.md"), "legacy user edit")
  const receipt = await fs.readFile(path.join(f.target, BUILTIN_INSTALL_RECEIPT))
  const status = await f.status(original)
  expect(status.state).toBe("not_installed")
  expect(status.distributions.find((entry) => entry.agent_dir === f.agent)?.state).toBe("conflict")
  expect((await errorOf(installBuiltin(original, f.agent, f.options)))?.code).toBe(
    "BUILTIN_DISTRIBUTION_CONFLICT",
  )
  expect((await errorOf(updateBuiltin(skill("B"), f.agent, f.options)))?.code).toBe(
    "BUILTIN_DISTRIBUTION_CONFLICT",
  )
  expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe("legacy user edit")
  expect(await fs.readFile(path.join(f.target, BUILTIN_INSTALL_RECEIPT))).toEqual(receipt)
  await expect(fs.lstat(path.join(f.data, "skills/managed-fixture"))).rejects.toMatchObject({
    code: "ENOENT",
  })
  expect(f.retired).toHaveLength(0)
})

test("read-only status preserves unresolved legacy journals outside the v2 runtime", async () => {
  const original = skill("A", [
    { path: "assets/legacy", bytes: encoder.encode("retained legacy bytes") },
  ])
  const f = await legacyFixture(original)
  const transaction = path.join(f.agent, ".ntn-skills/builtin/managed-fixture", randomUUID())
  await fs.mkdir(transaction, { recursive: true })
  const previous = path.join(transaction, "previous")
  const receipt = await fs.readFile(path.join(f.target, BUILTIN_INSTALL_RECEIPT))
  await fs.rename(f.target, previous)
  await fs.writeFile(path.join(transaction, "journal.json"), "{incomplete")
  const status = await f.status(original)
  expect(status.state).toBe("not_installed")
  expect(status.distributions.find((entry) => entry.agent_dir === f.agent)?.state).toBe("missing")
  expect((await errorOf(updateBuiltin(skill("B"), f.agent, f.options)))?.code).toBe(
    "BUILTIN_NOT_INSTALLED",
  )
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" })
  await expect(fs.lstat(path.join(f.data, "skills/managed-fixture"))).rejects.toMatchObject({
    code: "ENOENT",
  })
  expect(await fs.readFile(path.join(previous, "SKILL.md"), "utf8")).toContain("A")
  expect(await fs.readFile(path.join(previous, "assets/legacy"), "utf8")).toBe(
    "retained legacy bytes",
  )
  expect(await fs.readFile(path.join(previous, BUILTIN_INSTALL_RECEIPT))).toEqual(receipt)
  expect(await fs.readFile(path.join(transaction, "journal.json"), "utf8")).toBe("{incomplete")
  expect(f.retired).toHaveLength(0)
})

test("invalid or linked distribution registries preserve central status and reject mutations", async () => {
  for (const kind of ["malformed", "symlink"] as const) {
    const f = await fixture()
    const original = skill("A")
    const installed = await run(installBuiltin(original, f.agent, f.options))
    const registry = path.join(f.data, ".ntn-skills/distributions/managed-fixture.json")
    const saved = path.join(f.root, "saved-registry.json")
    await fs.rename(registry, saved)
    if (kind === "malformed") await fs.writeFile(registry, "{broken")
    else await fs.symlink(saved, registry)
    const before = await fs.lstat(registry, { bigint: true })
    const entries = await fs.readdir(path.dirname(registry))
    const canonicalBytes = await fs.readFile(path.join(installed.installation.path, "SKILL.md"))
    const receipt = await fs.readFile(
      path.join(installed.installation.path, BUILTIN_INSTALL_RECEIPT),
    )
    const savedBytes = await fs.readFile(saved)
    const status = await f.status(original)
    expect(status.state).toBe("current")
    expect(status.distributions).toEqual([])
    expect(status.distribution_error?.code).toBe("BUILTIN_DISTRIBUTION_CONFLICT")
    expect(status.distribution_error?.message.length).toBeGreaterThan(0)
    const after = await fs.lstat(registry, { bigint: true })
    expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
      before.ino,
      before.size,
      before.mtimeNs,
      before.ctimeNs,
    ])
    expect(await fs.readdir(path.dirname(registry))).toEqual(entries)
    expect((await errorOf(installBuiltin(original, f.agent, f.options)))?.code).toBe(
      "BUILTIN_DISTRIBUTION_CONFLICT",
    )
    expect((await errorOf(updateBuiltin(skill("B"), f.agent, f.options)))?.code).toBe(
      "BUILTIN_DISTRIBUTION_CONFLICT",
    )
    expect(await fs.readFile(path.join(installed.installation.path, "SKILL.md"))).toEqual(
      canonicalBytes,
    )
    expect(
      await fs.readFile(path.join(installed.installation.path, BUILTIN_INSTALL_RECEIPT)),
    ).toEqual(receipt)
    expect(await fs.readFile(saved)).toEqual(savedBytes)
    if (kind === "symlink") expect(await fs.readlink(registry)).toBe(saved)
    else expect(await fs.readFile(registry, "utf8")).toBe("{broken")
    expect(f.retired).toHaveLength(0)
  }
})

test("legacy migration registry fields fence status and every mutation without changing ownership bytes", async () => {
  for (const field of ["retained_path", "legacy_proof"] as const) {
    const f = await fixture()
    const original = skill("A")
    const installed = await run(installBuiltin(original, f.agent, f.options))
    const registryPath = path.join(f.data, ".ntn-skills/distributions/managed-fixture.json")
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"))
    registry.distributions[0][field] =
      field === "retained_path" ? path.join(f.root, "retained-legacy") : { dev: "1", ino: "2" }
    await fs.writeFile(registryPath, JSON.stringify(registry))
    const registryBytes = await fs.readFile(registryPath)
    const registryIdentity = await fs.lstat(registryPath, { bigint: true })
    const receiptPath = path.join(installed.installation.path, BUILTIN_INSTALL_RECEIPT)
    const receiptBytes = await fs.readFile(receiptPath)
    const target = path.join(f.agent, "skills/managed-fixture")
    const linkIdentity = (await fs.lstat(target)).ino
    for (const builtin of [original, skill("B")]) {
      const status = await f.status(builtin)
      expect(status.state).toBe(builtin === original ? "current" : "update_available")
      expect(status.distribution_error?.code).toBe("BUILTIN_MIGRATION_REQUIRED")
      for (const operation of [installBuiltin, updateBuiltin]) {
        expect((await errorOf(operation(builtin, f.agent, f.options)))?.code).toBe(
          "BUILTIN_MIGRATION_REQUIRED",
        )
      }
    }
    const after = await fs.lstat(registryPath, { bigint: true })
    expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([
      registryIdentity.ino,
      registryIdentity.mtimeNs,
      registryIdentity.ctimeNs,
    ])
    expect(await fs.readFile(registryPath)).toEqual(registryBytes)
    expect(await fs.readFile(receiptPath)).toEqual(receiptBytes)
    expect(await fs.readFile(path.join(installed.installation.path, "SKILL.md"), "utf8")).toContain(
      "A",
    )
    expect((await fs.lstat(target)).ino).toBe(linkIdentity)
    expect(await fs.readlink(target)).toBe(installed.installation.path)
    expect(f.retired).toHaveLength(0)
  }
})

test("pending distribution publication recovers its staged link and never adopts an incidental link", async () => {
  for (const incidental of [false, true]) {
    const f = await fixture()
    const target = path.join(f.agent, "skills/managed-fixture")
    const canonical = path.join(f.data, "skills/managed-fixture")
    const error = await errorOf(
      installBuiltin(skill("A"), f.agent, {
        ...f.options,
        beforeBoundary: (boundary) =>
          inject(async () => {
            if (boundary.kind !== "publish" || boundary.path !== target) return
            if (incidental) await fs.symlink(canonical, target)
            throw fail("LOCAL_IO_ERROR", "Injected distribution publication boundary")
          }),
      }),
    )
    expect(error?.code).toBe("BUILTIN_INTERRUPTED")
    const status = await f.status(skill("A"))
    expect(status.state).toBe("current")
    expect(status.distributions.find((entry) => entry.path === target)?.state).toBe(
      incidental ? "conflict" : "interrupted",
    )
    const staging = path.join(f.agent, ".ntn-skills/distributions")
    const [staged] = await fs.readdir(staging)
    const stagedPath = path.join(staging, staged!)
    const stagedIdentity = (await fs.lstat(stagedPath)).ino
    if (incidental) {
      const identity = (await fs.lstat(target)).ino
      expect((await errorOf(installBuiltin(skill("A"), undefined, f.options)))?.code).toBe(
        "BUILTIN_DISTRIBUTION_CONFLICT",
      )
      expect((await fs.lstat(target)).ino).toBe(identity)
      expect((await fs.lstat(stagedPath)).ino).toBe(stagedIdentity)
    } else {
      const recovered = await run(installBuiltin(skill("A"), undefined, f.options))
      expect(recovered.reused).toBe(true)
      expect(recovered.installation.distributions.every((entry) => entry.state === "linked")).toBe(
        true,
      )
      expect((await fs.lstat(target)).ino).toBe(stagedIdentity)
      expect(await fs.readdir(staging)).toEqual([])
    }
    expect(await fs.readlink(target)).toBe(canonical)
    expect(f.retired).toHaveLength(0)
  }
})

test("status is read-only; install receipts include every exported file and content, not package version, owns equality", async () => {
  const f = await fixture()
  const original = skill("original", [
    { path: ".hidden/config", bytes: encoder.encode("hidden baseline") },
  ])
  expect((await f.status(original)).state).toBe("not_installed")
  expect(await fs.readdir(f.root)).toEqual(["retained"])
  expect((await errorOf(updateBuiltin(original, f.agent, f.options)))?.code).toBe(
    "BUILTIN_NOT_INSTALLED",
  )
  expect(await fs.readdir(f.root)).toEqual(["retained"])
  const installed = await run(installBuiltin(original, f.agent, f.options))
  expect(installed.installation.state).toBe("current")
  expect(installed.installation.reload_required).toBe(true)
  expect(installed.reused).toBe(false)
  const receiptPath = path.join(installed.installation.path, BUILTIN_INSTALL_RECEIPT)
  const bytes = await fs.readFile(receiptPath)
  const receipt: BuiltinInstallReceipt = JSON.parse(bytes.toString())
  expect(receipt.version).toBe(2)
  expect(receipt.data_dir).toBe(await fs.realpath(f.data))
  expect(receipt.path).toBe(path.join(f.data, "skills/managed-fixture"))
  expect("agent_dir" in receipt).toBe(false)
  expect(receipt.files.map((file) => file.path)).toEqual([
    ".hidden/config",
    ".ntn-skills.json",
    "SKILL.md",
  ])
  expect(receipt.files.every((file) => /^[a-f\d]{64}$/.test(file.sha256))).toBe(true)
  const repeated = await run(installBuiltin({ ...original, version: "2.0.0" }, f.agent, f.options))
  expect(repeated.reused).toBe(true)
  expect(repeated.installation.installed_package_version).toBe("1.0.0")
  expect(await fs.readFile(receiptPath)).toEqual(bytes)
})

test("A to B replaces the whole tree, removes retired resources and retains the old complete tree outside skills", async () => {
  const f = await fixture()
  const old = skill("A", [{ path: "assets/removed.bin", bytes: new Uint8Array([0, 255, 7]) }])
  const next = skill(
    "B",
    [{ path: "references/new.md", bytes: encoder.encode("new reference") }],
    "2.0.0",
  )
  await run(installBuiltin(old, f.agent, f.options))
  expect((await f.status(next)).state).toBe("update_available")
  expect((await errorOf(installBuiltin(next, f.agent, f.options)))?.code).toBe(
    "BUILTIN_UPDATE_AVAILABLE",
  )
  const result = await run(updateBuiltin(next, f.agent, f.options))
  expect(result.installation.state).toBe("current")
  expect(result.reused).toBe(false)
  expect(await fs.readdir(path.join(f.data, "skills"))).toEqual(["managed-fixture"])
  expect((await fs.readdir(result.installation.path)).sort()).toEqual(
    [BUILTIN_INSTALL_RECEIPT, ".ntn-skills.json", "SKILL.md", "references"].sort(),
  )
  expect(await fs.readFile(path.join(result.installation.path, "references/new.md"), "utf8")).toBe(
    "new reference",
  )
  expect(f.retired).toHaveLength(1)
  expect(await fs.readFile(path.join(f.retired[0]!, "assets/removed.bin"))).toEqual(
    Buffer.from([0, 255, 7]),
  )
  expect((await run(updateBuiltin(next, f.agent, f.options))).reused).toBe(true)
})

test.each(["hidden", "changed", "deleted", "directory", "link"] as const)(
  "%s modifications protect all user bytes",
  async (change) => {
    const f = await fixture()
    const original = skill("original", [{ path: "assets/data", bytes: encoder.encode("data") }])
    const installed = await run(installBuiltin(original, f.agent, f.options))
    const target = installed.installation.path
    const external = path.join(f.root, "external")
    await fs.writeFile(external, "external user bytes")
    if (change === "hidden") await fs.writeFile(path.join(target, ".user-settings"), "user bytes")
    if (change === "changed") await fs.writeFile(path.join(target, "assets/data"), "edited")
    if (change === "deleted")
      await fs.rename(path.join(target, "assets/data"), path.join(f.root, "removed"))
    if (change === "directory") await fs.mkdir(path.join(target, ".empty-user-directory"))
    if (change === "link") {
      await fs.rename(path.join(target, "assets/data"), path.join(f.root, "original-data"))
      await fs.symlink(external, path.join(target, "assets/data"))
    }
    const state = await f.status(original)
    expect(state.state).toBe("modified")
    expect(state.changed_paths!.length).toBeGreaterThan(0)
    expect((await errorOf(installBuiltin(original, f.agent, f.options)))?.code).toBe(
      "BUILTIN_MODIFIED",
    )
    expect((await errorOf(updateBuiltin(skill("new"), f.agent, f.options)))?.code).toBe(
      "BUILTIN_MODIFIED",
    )
    expect(await fs.readFile(external, "utf8")).toBe("external user bytes")
    expect(f.retired).toHaveLength(0)
    if (change === "hidden")
      expect(await fs.readFile(path.join(target, ".user-settings"), "utf8")).toBe("user bytes")
    if (change === "link")
      expect(await fs.readlink(path.join(target, "assets/data"))).toBe(external)
  },
)

test("unregistered, malformed-receipt and linked central directories are never adopted", async () => {
  for (const kind of ["missing-receipt", "malformed", "symlink"] as const) {
    const f = await fixture()
    const target = path.join(f.data, "skills/managed-fixture")
    await fs.mkdir(path.dirname(target), { recursive: true })
    const directory = kind === "symlink" ? path.join(f.root, "user-skill") : target
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, "SKILL.md"), "user main")
    if (kind === "malformed")
      await fs.writeFile(path.join(directory, BUILTIN_INSTALL_RECEIPT), "{broken")
    if (kind === "symlink") await fs.symlink(directory, target)
    expect((await f.status(skill("packaged"))).state).toBe("unmanaged")
    expect((await errorOf(installBuiltin(skill("packaged"), f.agent, f.options)))?.code).toBe(
      "BUILTIN_UNMANAGED",
    )
    expect(await fs.readFile(path.join(directory, "SKILL.md"), "utf8")).toBe("user main")
  }
})

test("interrupted rename rolls back only the exact retained prior tree and requires an explicit retry", async () => {
  const f = await fixture()
  const old = skill("A")
  const next = skill("B")
  await run(installBuiltin(old, f.agent, f.options))
  const interrupted = await errorOf(
    updateBuiltin(next, f.agent, {
      ...f.options,
      beforeBoundary: (boundary) =>
        boundary.kind === "publish"
          ? Effect.fail(fail("LOCAL_IO_ERROR", "Injected process boundary"))
          : Effect.void,
    }),
  )
  expect(interrupted?.code).toBe("BUILTIN_INTERRUPTED")
  expect((await f.status(next)).state).toBe("interrupted")
  const recovered = await errorOf(updateBuiltin(next, f.agent, f.options))
  expect(recovered?.code).toBe("BUILTIN_INTERRUPTED")
  expect(property(property(recovered!.details).recovery).outcome).toBe("rolled_back")
  expect((await f.status(next)).state).toBe("update_available")
  expect(await fs.readFile(path.join(f.data, "skills/managed-fixture/SKILL.md"), "utf8")).toContain(
    "A",
  )
  expect((await run(updateBuiltin(next, f.agent, f.options))).installation.state).toBe("current")
})

test("rollback readback recognizes the exact restored tree after a crash before its terminal receipt", async () => {
  const f = await fixture()
  const old = skill("A", [{ path: "assets/old", bytes: encoder.encode("original resource") }])
  const next = skill("B")
  await run(installBuiltin(old, f.agent, f.options))
  const installed = path.join(f.data, "skills/managed-fixture")
  const originals = await Promise.all(
    ["SKILL.md", BUILTIN_INSTALL_RECEIPT, "assets/old"].map((file) =>
      fs.readFile(path.join(installed, file)),
    ),
  )
  const interrupted = await errorOf(
    updateBuiltin(next, f.agent, {
      ...f.options,
      beforeBoundary: (boundary) =>
        boundary.kind === "publish"
          ? Effect.fail(fail("LOCAL_IO_ERROR", "Injected publication boundary"))
          : Effect.void,
    }),
  )
  expect(interrupted?.code).toBe("BUILTIN_INTERRUPTED")
  const pending = await f.status(next)
  const transaction = path.dirname(pending.journal_path!)
  await fs.rename(path.join(transaction, "previous"), pending.path)
  expect((await fs.readdir(transaction)).includes("rolled_back.json")).toBe(false)
  const recovered = await errorOf(updateBuiltin(next, f.agent, f.options))
  expect(recovered?.code).toBe("BUILTIN_INTERRUPTED")
  expect(property(property(recovered!.details).recovery).outcome).toBe("rolled_back")
  expect((await f.status(next)).state).toBe("update_available")
  for (const [index, file] of ["SKILL.md", BUILTIN_INSTALL_RECEIPT, "assets/old"].entries())
    expect(await fs.readFile(path.join(pending.path, file))).toEqual(originals[index]!)
  expect(
    JSON.parse(await fs.readFile(path.join(transaction, "rolled_back.json"), "utf8")),
  ).toMatchObject({ phase: "rolled_back" })
  expect((await run(updateBuiltin(next, f.agent, f.options))).installation.state).toBe("current")
  expect(f.retired).toHaveLength(1)
  for (const [index, file] of ["SKILL.md", BUILTIN_INSTALL_RECEIPT, "assets/old"].entries())
    expect(await fs.readFile(path.join(f.retired[0]!, file))).toEqual(originals[index]!)
  expect(f.retiredFences).toHaveLength(process.platform === "darwin" ? 4 : 0)
  expect(
    (await fs.readdir(path.join(f.data, ".ntn-skills/sync/locks"))).filter((entry) =>
      /^[a-f0-9]{64}$/.test(entry),
    ),
  ).toEqual([])
  for (const fence of f.retiredFences)
    expect(JSON.parse(await fs.readFile(path.join(fence, "owner.json"), "utf8"))).toMatchObject({
      pid: process.pid,
      key: `builtin-central:${f.data}:managed-fixture`,
    })
})

test("publication refuses an empty directory created by an external writer at the boundary", async () => {
  const f = await fixture()
  let occupiedInode = 0
  const error = await errorOf(
    installBuiltin(skill("A"), f.agent, {
      ...f.options,
      beforeBoundary: (boundary) =>
        inject(async () => {
          if (boundary.kind !== "publish") return
          await fs.mkdir(boundary.path)
          occupiedInode = (await fs.lstat(boundary.path)).ino
        }),
    }),
  )
  expect(error?.code).toBe("BUILTIN_INTERRUPTED")
  expect(property(error!.details).cause).toBe("BUILTIN_UNMANAGED")
  const pending = await f.status(skill("A"))
  expect((await fs.lstat(pending.path)).ino).toBe(occupiedInode)
  expect(await fs.readdir(pending.path)).toEqual([])
  expect(
    await fs.readFile(path.join(path.dirname(pending.journal_path!), "staged/SKILL.md"), "utf8"),
  ).toContain("A")
})

test("rollback refuses an empty directory created by an external writer at the recovery boundary", async () => {
  const f = await fixture()
  await run(installBuiltin(skill("A"), f.agent, f.options))
  const next = skill("B")
  await errorOf(
    updateBuiltin(next, f.agent, {
      ...f.options,
      beforeBoundary: (boundary) =>
        boundary.kind === "publish"
          ? Effect.fail(fail("LOCAL_IO_ERROR", "Injected publication boundary"))
          : Effect.void,
    }),
  )
  const pending = await f.status(next)
  let occupiedInode = 0
  const recovered = await errorOf(
    updateBuiltin(next, f.agent, {
      ...f.options,
      beforeBoundary: (boundary) =>
        inject(async () => {
          if (boundary.kind !== "publish") return
          await fs.mkdir(boundary.path)
          occupiedInode = (await fs.lstat(boundary.path)).ino
        }),
    }),
  )
  expect(recovered?.code).toBe("BUILTIN_INTERRUPTED")
  expect((await fs.lstat(pending.path)).ino).toBe(occupiedInode)
  expect(await fs.readdir(pending.path)).toEqual([])
  expect(
    await fs.readFile(path.join(path.dirname(pending.journal_path!), "previous/SKILL.md"), "utf8"),
  ).toContain("A")
  expect((await f.status(next)).state).toBe("interrupted")
  expect(f.retired).toHaveLength(0)
})

test("recovery refuses third-party destination bytes even when they reproduce the new receipt", async () => {
  const f = await fixture()
  await run(installBuiltin(skill("A"), f.agent, f.options))
  const next = skill("B")
  await errorOf(
    updateBuiltin(next, f.agent, {
      ...f.options,
      beforeBoundary: (boundary) =>
        boundary.kind === "publish"
          ? Effect.fail(fail("LOCAL_IO_ERROR", "Injected interruption"))
          : Effect.void,
    }),
  )
  const interrupted = await f.status(next)
  const transaction = path.dirname(interrupted.journal_path!)
  const target = interrupted.path
  await fs.cp(path.join(transaction, "staged"), target, { recursive: true })
  expect((await errorOf(updateBuiltin(next, f.agent, f.options)))?.code).toBe("BUILTIN_INTERRUPTED")
  expect((await f.status(next)).state).toBe("interrupted")
  expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toContain("B")
  expect(f.retired).toHaveLength(0)
})

test("published-tree recovery finishes retention once and keeps all old resource bytes", async () => {
  const f = await fixture()
  const old = skill("A", [{ path: "assets/retired", bytes: encoder.encode("old resource") }])
  const next = skill("B")
  await run(installBuiltin(old, f.agent, f.options))
  const interrupted = await errorOf(
    updateBuiltin(next, f.agent, {
      ...f.options,
      beforeBoundary: (boundary) =>
        boundary.kind === "trash"
          ? Effect.fail(fail("LOCAL_IO_ERROR", "Injected retention boundary"))
          : Effect.void,
    }),
  )
  expect(interrupted?.code).toBe("BUILTIN_INTERRUPTED")
  expect((await f.status(next)).state).toBe("interrupted")
  const recovered = await errorOf(updateBuiltin(next, f.agent, f.options))
  expect(property(property(recovered!.details).recovery).outcome).toBe("completed")
  expect((await f.status(next)).state).toBe("current")
  expect(f.retired).toHaveLength(1)
  expect(await fs.readFile(path.join(f.retired[0]!, "assets/retired"), "utf8")).toBe("old resource")
  expect((await run(updateBuiltin(next, f.agent, f.options))).reused).toBe(true)
})

test("an incomplete journal fences an absent destination without creating or adopting a skill", async () => {
  const f = await fixture()
  const directory = path.join(f.data, ".ntn-skills/builtin/managed-fixture", randomUUID())
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "journal.json"), "{incomplete")
  expect((await f.status(skill("A"))).state).toBe("interrupted")
  expect((await errorOf(installBuiltin(skill("A"), f.agent, f.options)))?.code).toBe(
    "BUILTIN_INTERRUPTED",
  )
  expect(await fs.readFile(path.join(directory, "journal.json"), "utf8")).toBe("{incomplete")
  expect((await fs.readdir(f.data)).includes("skills")).toBe(false)
})

test("a canonical data-directory alias shares a real-process fence with its installation owner", async () => {
  const f = await fixture()
  const original = skill("one writer")
  const alias = path.join(f.root, "alias")
  const effectModule = import.meta.resolve("effect")
  const nodeModule = import.meta.resolve("@effect/platform-node/NodeServices")
  const installModule = fileURLToPath(new URL("../src/builtin-install.ts", import.meta.url))
  let output = ""
  await run(
    installBuiltin(original, f.agent, {
      ...f.options,
      beforeBoundary: (boundary) =>
        inject(async () => {
          if (boundary.kind !== "stage") return
          await fs.symlink(f.data, alias)
          const serialized = JSON.stringify(original)
          const source = `import {Effect} from ${JSON.stringify(effectModule)};import * as NodeServices from ${JSON.stringify(nodeModule)};import {installBuiltin} from ${JSON.stringify(installModule)};const skill=JSON.parse(${JSON.stringify(serialized)},(key,value)=>key==='bytes'?Uint8Array.from(Object.values(value)):value);await Effect.runPromise(installBuiltin(skill,${JSON.stringify(f.agent)},{dataDir:${JSON.stringify(alias)},homeDir:${JSON.stringify(f.home)}}).pipe(Effect.provide(NodeServices.layer),Effect.match({onFailure:e=>console.log(e.code),onSuccess:()=>console.log('UNFENCED')})));`
          output = await new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, ["--eval", source], {
              stdio: ["ignore", "pipe", "pipe"],
            })
            let stdout = ""
            let stderr = ""
            child.stdout.on("data", (bytes) => {
              stdout += bytes
            })
            child.stderr.on("data", (bytes) => {
              stderr += bytes
            })
            child.on("error", reject)
            child.on("close", (code) =>
              code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)),
            )
          })
        }),
    }),
  )
  expect(output).toBe("SYNC_LOCKED")
})

test("central parent drift at a rename boundary preserves prior and staged bytes", async () => {
  const f = await fixture()
  await run(installBuiltin(skill("A"), f.agent, f.options))
  const oldSkills = path.join(f.root, "previous-skills")
  const error = await errorOf(
    updateBuiltin(skill("B"), f.agent, {
      ...f.options,
      beforeBoundary: (boundary) =>
        inject(async () => {
          if (boundary.kind !== "retain") return
          await fs.rename(path.join(f.data, "skills"), oldSkills)
          await fs.mkdir(path.join(f.data, "skills"))
        }),
    }),
  )
  expect(error?.code).toBe("BUILTIN_INTERRUPTED")
  expect(property(error!.details).cause).toBe("BUILTIN_PATH_CHANGED")
  expect(await fs.readFile(path.join(oldSkills, "managed-fixture/SKILL.md"), "utf8")).toContain("A")
  expect(await fs.readdir(path.join(f.data, "skills"))).toEqual([])
  expect(f.retired).toHaveLength(0)
})

test("fiber interruption closes an in-flight no-follow inspection handle", async () => {
  const f = await fixture()
  const original = skill("A")
  const installed = await run(installBuiltin(original, f.agent, f.options))
  const receiptPath = path.join(installed.installation.path, BUILTIN_INSTALL_RECEIPT)
  await run(
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.FileSystem
      const reading = yield* Deferred.make<void>()
      let opened: FileSystem.File | undefined
      const observed = FileSystem.FileSystem.of({
        ...filesystem,
        open: (location, options) =>
          filesystem.open(location, options).pipe(
            Effect.map((handle) => {
              if (location !== receiptPath) return handle
              expect(options?.noFollow).toBe(true)
              opened = handle
              return Object.assign(Object.create(handle) as FileSystem.File, {
                read: () => Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never)),
              })
            }),
          ),
      })
      const fiber = yield* builtinStatus([original], f.agent, f.options).pipe(
        Effect.provideService(FileSystem.FileSystem, observed),
        Effect.forkChild,
      )
      yield* Deferred.await(reading)
      yield* Fiber.interrupt(fiber)
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
      expect(opened).toBeDefined()
      expect(Exit.isFailure(yield* Effect.exit(opened!.stat))).toBe(true)
    }),
  )
  expect((await f.status(original)).state).toBe("current")
})

test("fiber interruption preserves the journal and releases the central writer lock", async () => {
  const f = await fixture()
  const original = skill("A")
  await run(
    Effect.gen(function* () {
      const staged = yield* Deferred.make<void>()
      const fiber = yield* installBuiltin(original, f.agent, {
        ...f.options,
        beforeBoundary: (boundary) =>
          boundary.kind === "stage"
            ? Deferred.succeed(staged, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      }).pipe(Effect.forkChild)
      yield* Deferred.await(staged)
      yield* Fiber.interrupt(fiber)
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    }),
  )
  const pending = await f.status(original)
  expect(pending.state).toBe("interrupted")
  const journal = await fs.readFile(pending.journal_path!)
  const recovered = await errorOf(installBuiltin(original, f.agent, f.options))
  expect(recovered?.code).toBe("BUILTIN_INTERRUPTED")
  expect(property(property(recovered!.details).recovery).outcome).toBe("not_applied")
  expect(await fs.readFile(pending.journal_path!)).toEqual(journal)
  expect((await f.status(original)).state).toBe("not_installed")
  expect((await run(installBuiltin(original, f.agent, f.options))).installation.state).toBe(
    "current",
  )
})
