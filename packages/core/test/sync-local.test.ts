import { expect, test } from "bun:test"
import { Effect } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { fail, SkillsError } from "../src/model.ts"
import { portableFiles, type PortableSkill } from "../src/portable.ts"
import { makeSyncLocal, type LocalBoundary } from "../src/sync-local.ts"

const encoder = new TextEncoder()
const skill = (
  body: string,
  attachments: readonly { path: string; bytes: Uint8Array }[] = [],
): PortableSkill => ({
  name: "Local Fixture",
  description: "Filesystem sync fixture",
  main: "SKILL.md",
  files: [
    {
      path: "SKILL.md",
      bytes: encoder.encode(
        `---\nname: local-fixture\ndescription: Filesystem sync fixture\n---\n\n${body}\n`,
      ),
    },
    ...attachments,
  ],
})

async function fixture(hook?: (boundary: LocalBoundary) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ntn-sync-local-"))
  const trashRoot = path.join(root, "retained")
  await fs.mkdir(trashRoot)
  const trashed: Array<{ source: string; destination: string }> = []
  const local = makeSyncLocal({
    stateRoot: path.join(root, "state"),
    beforeBoundary: hook,
    trash: async (source) => {
      const destination = path.join(trashRoot, randomUUID())
      await fs.rename(source, destination)
      trashed.push({ source, destination })
    },
  })
  // Tests retain their scratch and evidence, exactly as production retains failures.
  return { root, local, trashed }
}
async function materialize(directory: string, content: PortableSkill) {
  await fs.mkdir(directory, { recursive: true })
  for (const file of portableFiles(content)) {
    const destination = path.join(directory, file.path)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, file.bytes)
  }
}
async function errorOf(effect: Effect.Effect<unknown, SkillsError>) {
  return Effect.runPromise(
    effect.pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined })),
  )
}

test("L1/L2/S10: relative multi-hop root and parent links survive writes and real edits", async () => {
  const { root, local } = await fixture()
  const real = path.join(root, "real", "skill")
  await materialize(real, skill("original"))
  await fs.symlink("real", path.join(root, "parent"))
  await fs.symlink("parent/skill", path.join(root, "hop"))
  await fs.symlink("hop", path.join(root, "logical"))
  const logical = path.join(root, "logical")
  const links = ["parent", "hop", "logical"]
  const before = await Promise.all(
    links.map(async (name) => ({
      name,
      ino: (await fs.lstat(path.join(root, name))).ino,
      text: await fs.readlink(path.join(root, name)),
    })),
  )
  const original = await Effect.runPromise(local.inspect(logical))
  expect(original.resolved_path).toBe(await fs.realpath(real))
  const other = await Effect.runPromise(local.inspect(path.join(root, "parent", "skill")))
  expect(other.resolved_path).toBe(original.resolved_path)
  await Effect.runPromise(
    local.commit(
      original,
      skill("pulled"),
      original.content!.files.map((file) => file.path),
      "links",
    ),
  )
  for (const link of before) {
    expect((await fs.lstat(path.join(root, link.name))).ino).toBe(link.ino)
    expect(await fs.readlink(path.join(root, link.name))).toBe(link.text)
  }
  expect(await fs.readFile(path.join(real, "SKILL.md"), "utf8")).toContain("pulled")
  await fs.writeFile(path.join(real, "SKILL.md"), skill("real edit").files[0]!.bytes)
  const edited = await Effect.runPromise(local.inspect(logical))
  expect(edited.content_id).not.toBe(original.content_id)
  expect(new TextDecoder().decode(edited.content!.files[0]!.bytes)).toContain("real edit")
})

test("link targets resolve symlink/.. in actual POSIX order", async () => {
  const { root, local } = await fixture()
  await materialize(path.join(root, "elsewhere", "skill"), skill("actual"))
  await materialize(path.join(root, "skill"), skill("lexical decoy"))
  await fs.mkdir(path.join(root, "elsewhere", "child"))
  await fs.symlink("elsewhere/child", path.join(root, "jump"))
  await fs.symlink("jump/../skill", path.join(root, "logical"))
  const inspection = await Effect.runPromise(local.inspect(path.join(root, "logical")))
  expect(inspection.resolved_path).toBe(await fs.realpath(path.join(root, "elsewhere", "skill")))
})

test("L3: root and reference file links update final external files without replacing links", async () => {
  const { root, local } = await fixture()
  const directory = path.join(root, "skill")
  const old = skill("old", [{ path: "references/guide.md", bytes: encoder.encode("old guide") }])
  await materialize(directory, old)
  for (const relative of ["SKILL.md", "references/guide.md"]) {
    const destination = path.join(directory, relative)
    const external = path.join(root, relative === "SKILL.md" ? "main.md" : "guide.md")
    await fs.rename(destination, external)
    await fs.symlink(path.relative(path.dirname(destination), external), destination)
  }
  const mainLink = await fs.readlink(path.join(directory, "SKILL.md"))
  const guideLink = await fs.readlink(path.join(directory, "references/guide.md"))
  const original = await Effect.runPromise(local.inspect(directory))
  await Effect.runPromise(
    local.commit(
      original,
      skill("new", [{ path: "references/guide.md", bytes: encoder.encode("new guide") }]),
      old.files.map((file) => file.path),
      "file-links",
    ),
  )
  expect(await fs.readlink(path.join(directory, "SKILL.md"))).toBe(mainLink)
  expect(await fs.readlink(path.join(directory, "references/guide.md"))).toBe(guideLink)
  expect(await fs.readFile(path.join(root, "main.md"), "utf8")).toContain("new")
  expect(await fs.readFile(path.join(root, "guide.md"), "utf8")).toBe("new guide")
})

test("L4: byte-identical root, parent and per-file retargeting invalidates proofs", async () => {
  for (const kind of ["root", "parent", "file"] as const) {
    const { root, local } = await fixture()
    await materialize(path.join(root, "one", "skill"), skill("same"))
    await materialize(path.join(root, "two", "skill"), skill("same"))
    const link = path.join(root, kind === "parent" ? "parent" : "logical")
    const first = kind === "parent" ? "one" : "one/skill"
    await fs.symlink(first, link)
    const logical = kind === "parent" ? path.join(link, "skill") : link
    let replaced = link
    if (kind === "file") {
      replaced = path.join(root, "one", "skill", "SKILL.md")
      await fs.rename(replaced, path.join(root, "first.md"))
      await fs.copyFile(path.join(root, "first.md"), path.join(root, "second.md"))
      await fs.symlink(path.join(root, "first.md"), replaced)
    }
    const original = await Effect.runPromise(local.inspect(logical))
    await fs.rename(replaced, `${replaced}.retained`)
    await fs.symlink(
      kind === "file" ? path.join(root, "second.md") : kind === "parent" ? "two" : "two/skill",
      replaced,
    )
    const error = await errorOf(
      local.commit(
        original,
        skill("replacement forbidden"),
        original.content!.files.map((file) => file.path),
        `retarget-${kind}`,
      ),
    )
    expect(error?.code).toBe("SYNC_PLAN_STALE")
    expect(await fs.readFile(path.join(root, "two", "skill", "SKILL.md"), "utf8")).toContain("same")
    if (kind === "file")
      expect(await fs.readFile(path.join(root, "second.md"), "utf8")).toContain("same")
  }
})

test("L5/S11/S14: missing ordinary leaf is distinct from dangling links, cycles and missing parents", async () => {
  const { root, local } = await fixture()
  const absent = await Effect.runPromise(
    local.inspect(path.join(root, "absent"), { allowMissing: true }),
  )
  expect(absent.exists).toBe(false)
  const created = await Effect.runPromise(
    local.commit(absent, skill("initialized"), [], "initialization"),
  )
  expect(created.inspection.exists).toBe(true)
  await fs.symlink("missing", path.join(root, "dangling"))
  await fs.symlink("cycle-b", path.join(root, "cycle-a"))
  await fs.symlink("cycle-a", path.join(root, "cycle-b"))
  expect(
    (await errorOf(local.inspect(path.join(root, "dangling"), { allowMissing: true })))?.code,
  ).toBe("LOCAL_LINK_BROKEN")
  expect(
    (await errorOf(local.inspect(path.join(root, "cycle-a"), { allowMissing: true })))?.code,
  ).toBe("LOCAL_LINK_CYCLE")
  expect(
    (
      await errorOf(
        local.inspect(path.join(root, "missing-parent", "leaf"), { allowMissing: true }),
      )
    )?.code,
  ).toBe("LOCAL_MISSING")
  expect((await errorOf(local.inspect(path.join(root, "missing-established"))))?.code).toBe(
    "LOCAL_MISSING",
  )
})

test("L6: retarget at actual rename guard leaves both complete targets unchanged", async () => {
  let changed = false
  let logical = ""
  const { root, local } = await fixture(async (boundary) => {
    if (!changed && boundary.kind === "replace") {
      changed = true
      await fs.rename(logical, `${logical}.retained`)
      await fs.symlink("two", logical)
    }
  })
  await materialize(path.join(root, "one"), skill("original"))
  await materialize(path.join(root, "two"), skill("original"))
  logical = path.join(root, "logical")
  await fs.symlink("one", logical)
  const original = await Effect.runPromise(local.inspect(logical))
  const error = await errorOf(
    local.commit(
      original,
      skill("not written"),
      original.content!.files.map((file) => file.path),
      "boundary-drift",
    ),
  )
  expect(error?.code).toBe("SYNC_TARGET_DRIFT")
  for (const directory of ["one", "two"])
    expect(await fs.readFile(path.join(root, directory, "SKILL.md"), "utf8")).toContain("original")
  const details = error!.details as { retained: { retention_path: string }[] }
  expect((await fs.readdir(details.retained[0]!.retention_path)).length).toBeGreaterThan(0)
})

test("S13: linked-parent file removal retains actual bytes and link, preserves unrelated root files", async () => {
  const { root, local, trashed } = await fixture()
  const directory = path.join(root, "real", "skill")
  const reference = { path: "references/old.md", bytes: encoder.encode("retain me") }
  await materialize(directory, skill("body", [reference]))
  await fs.writeFile(path.join(directory, "personal.txt"), "unrelated")
  await fs.writeFile(path.join(root, "outside.md"), reference.bytes)
  await fs.rename(
    path.join(directory, reference.path),
    path.join(root, "original-reference.retained"),
  )
  await fs.symlink(path.join(root, "outside.md"), path.join(directory, reference.path))
  await fs.symlink("real", path.join(root, "parent"))
  const original = await Effect.runPromise(
    local.inspect(path.join(root, "parent", "skill"), {
      trackedPaths: ["SKILL.md", reference.path],
    }),
  )
  expect(original.content!.files.map((file) => file.path)).not.toContain("personal.txt")
  const result = await Effect.runPromise(
    local.commit(original, skill("body"), ["SKILL.md", reference.path], "removal"),
  )
  expect(result.inspection.content!.files.map((file) => file.path)).toEqual(["SKILL.md"])
  expect(await fs.readFile(path.join(directory, "personal.txt"), "utf8")).toBe("unrelated")
  expect(await fs.readlink(path.join(root, "parent"))).toBe("real")
  const oldData = trashed.find(
    (entry) => entry.source.includes(".retained") && !entry.source.includes("staging"),
  )!
  expect(await fs.readFile(oldData.destination, "utf8")).toBe("retain me")
  expect(trashed.some((entry) => entry.source.endsWith("references/old.md"))).toBe(true)
  expect(result.retained.every((entry) => entry.retention_path === "system_trash")).toBe(true)
})

test("tracked discovery includes new owned references/assets and ignores hidden internals/unrelated root files", async () => {
  const { root, local } = await fixture()
  const directory = path.join(root, "skill")
  await materialize(
    directory,
    skill("body", [
      { path: "references/new.md", bytes: encoder.encode("new reference") },
      { path: "assets/blob.bin", bytes: new Uint8Array([0, 1, 255]) },
    ]),
  )
  await fs.writeFile(path.join(directory, "personal.txt"), "personal")
  await fs.writeFile(path.join(directory, ".ntn-sync-unknown.pending"), "scratch")
  const observed = await Effect.runPromise(
    local.inspect(directory, { trackedPaths: ["SKILL.md", "references/removed.md"] }),
  )
  expect(observed.content!.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "assets/blob.bin",
    "references/new.md",
  ])
  expect(observed.proof.files.some((entry) => entry.path === "references/removed.md")).toBe(false)
  const initial = await Effect.runPromise(local.inspect(directory))
  expect(initial.content!.files.map((file) => file.path)).toContain("personal.txt")
})

test("R5: failure after old-file retention keeps old and staged bytes with actual partial receipt", async () => {
  let destination = ""
  let boundaries = 0
  const { root, local } = await fixture(async (boundary) => {
    if (boundary.path === destination && boundary.kind === "replace" && ++boundaries === 3)
      throw fail("LOCAL_IO_ERROR", "Injected destination rename failure")
  })
  const directory = path.join(root, "skill")
  await materialize(directory, skill("old bytes"))
  const original = await Effect.runPromise(local.inspect(directory))
  // macOS tmpdir may be /var/... while actual commit destinations use
  // /private/var/... after following the system parent link.
  destination = path.join(original.resolved_path, "SKILL.md")
  const error = await errorOf(
    local.commit(original, skill("new bytes"), ["SKILL.md"], "rename-failure"),
  )
  expect(error?.code).toBe("WRITE_PARTIAL")
  const details = error!.details as {
    retained: { path: string; retention_path: string }[]
    operation_id: string
  }
  expect(details.operation_id).toBe("rename-failure")
  const old = details.retained.find((entry) => entry.path === destination)!
  expect(await fs.readFile(old.retention_path, "utf8")).toContain("old bytes")
  const staged = details.retained.find((entry) => entry.path.endsWith(".pending"))!
  expect(await fs.readFile(staged.retention_path, "utf8")).toContain("new bytes")
  expect((await fs.readdir(details.retained[0]!.retention_path)).length).toBeGreaterThan(0)
})

test("L7: a second real process is fenced while the first owns a target lock", async () => {
  const { root, local } = await fixture()
  const key = "real-target:/fixture"
  const module = fileURLToPath(new URL("../src/sync-local.ts", import.meta.url))
  // The workspace root has no hoisted effect package; use the same installed
  // module URL as this test instead of resolving a bare import from --eval.
  const effectModule = import.meta.resolve("effect")
  const source = `import {Effect} from ${JSON.stringify(effectModule)};import {makeSyncLocal} from ${JSON.stringify(module)}; const local=makeSyncLocal({stateRoot:${JSON.stringify(path.join(root, "state"))}}); await Effect.runPromise(local.withLocks([${JSON.stringify(key)}],Effect.succeed('forbidden')).pipe(Effect.match({onFailure:e=>console.log(e.code),onSuccess:()=>console.log('UNFENCED')})));`
  const result = await Effect.runPromise(
    local.withLocks(
      [key],
      Effect.tryPromise({
        try: () =>
          new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, ["--eval", source], {
              cwd: fileURLToPath(new URL("..", import.meta.url)),
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
              code === 0
                ? resolve(stdout.trim())
                : reject(
                    fail("LOCAL_IO_ERROR", "Lock contender process failed", {
                      exit_code: code,
                      stderr,
                    }),
                  ),
            )
          }),
        catch: (error) =>
          error instanceof SkillsError ? error : fail("LOCAL_IO_ERROR", "Child process failed"),
      }),
    ),
  )
  expect(result).toBe("SYNC_LOCKED")
  expect(await Effect.runPromise(local.withLocks([key], Effect.succeed("released")))).toBe(
    "released",
  )
})

test("dead process fences are retained and recoverable; unknown owners stay fenced", async () => {
  const { root, local } = await fixture()
  const locks = path.join(root, "state", "sync", "locks")
  await fs.mkdir(locks, { recursive: true })
  const pid = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--eval", ""], { stdio: "ignore" })
    child.on("error", reject)
    child.on("exit", () => resolve(child.pid!))
  })
  const key = "dead-owner"
  const lock = path.join(locks, createHash("sha256").update(key).digest("hex"))
  await fs.mkdir(lock)
  await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid, host: hostname() }))
  expect(await Effect.runPromise(local.withLocks([key], Effect.succeed("reconciled")))).toBe(
    "reconciled",
  )
  expect((await fs.readdir(locks)).some((entry) => entry.endsWith(".crashed"))).toBe(true)
  const unknown = "unknown-owner"
  await fs.mkdir(path.join(locks, createHash("sha256").update(unknown).digest("hex")))
  expect((await errorOf(local.withLocks([unknown], Effect.succeed("forbidden"))))?.code).toBe(
    "SYNC_LOCKED",
  )
})

test("incoming files cannot overwrite untracked root content", async () => {
  const { root, local } = await fixture()
  const directory = path.join(root, "skill")
  await materialize(directory, skill("body"))
  await fs.writeFile(path.join(directory, "personal.txt"), "keep personal")
  const expected = await Effect.runPromise(local.inspect(directory, { trackedPaths: ["SKILL.md"] }))
  const error = await errorOf(
    local.commit(
      expected,
      skill("body", [{ path: "personal.txt", bytes: encoder.encode("replacement") }]),
      ["SKILL.md"],
      "untracked-collision",
    ),
  )
  expect(error?.code).toBe("WRITE_PARTIAL")
  const details = error?.details
  expect(
    details !== null &&
      typeof details === "object" &&
      "cause_code" in details &&
      details.cause_code,
  ).toBe("OUTPUT_CONFLICT")
  expect(await fs.readFile(path.join(directory, "personal.txt"), "utf8")).toBe("keep personal")
})
