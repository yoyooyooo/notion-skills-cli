import { afterAll, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { copyFile, mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { createRequestMetrics } from "../src/request-metrics.ts"
import { trashPath } from "../src/local-locks.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import { discoverRegisteredSourceMembers } from "../src/shared-source-member-discovery.ts"
import { parseCurrentSourceConfiguration } from "../src/shared-current-source-management.ts"
import { prepareCurrentSource } from "../src/shared-current-source-input.ts"
import { withCurrentInvocationBudget } from "../src/shared-current-invocation.ts"
import { sourceDiscoveryInput } from "../src/shared-source-adapters.ts"
import {
  discoverSource,
  discoverSourceDirectory,
  SourceSnapshotSchema,
} from "../src/upstream-source.ts"
import {
  library,
  materializationFixture,
  sourceId,
} from "./shared-source-materialization-fixture.ts"

const { startSdkGitFixture } = await import(
  new URL("../../../scripts/sdk-source-fixture.mjs", import.meta.url).href
)
const root = await realpath(await mkdtemp(join(tmpdir(), "source-directory-")))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
})
const utf8 = new TextEncoder()
const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Complete source directory metadata\n---\n\nUse the original Skill.\n`
function git(cwd: string, args: readonly string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Directory Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Directory Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  }).trim()
}
async function fixture(
  files: ReadonlyMap<string, string | Uint8Array>,
  brokenResource = false,
  links: Readonly<Record<string, string>> = {},
) {
  const directory = await mkdtemp(join(root, "case-")),
    repository = join(directory, "source.git")
  await mkdir(repository)
  git(repository, ["init", "-b", "main"])
  for (const [path, bytes] of files) {
    await mkdir(join(repository, path, ".."), { recursive: true })
    await writeFile(join(repository, path), bytes)
  }
  if (brokenResource) await symlink("missing.bin", join(repository, "skills/other/resource.bin"))
  for (const [path, target] of Object.entries(links)) {
    await mkdir(join(repository, path, ".."), { recursive: true })
    await symlink(target, join(repository, path))
  }
  git(repository, ["add", "."])
  git(repository, ["commit", "--no-gpg-sign", "-m", "complete directory fixture"])
  git(repository, ["config", "uploadpack.allowFilter", "true"])
  git(repository, ["config", "uploadpack.allowAnySHA1InWant", "true"])
  const revision = git(repository, ["rev-parse", "HEAD"]),
    transport = await startSdkGitFixture(repository, join(directory, "git.jsonl"))
  const f = await materializationFixture(directory)
  for (const row of f.table("skills")) f.pages.delete(String(row.id))
  const properties = property(f.pages.get(f.sourcePage)!.properties)
  for (const [name, value] of Object.entries({
    Location: transport.url,
    Ref: revision,
    Options: "{}",
    Contributions: "[]",
    Content: "",
    "Last Revision": "",
  })) {
    const id = library.sources.property_ids[name]!
    properties[id] = { id, type: "rich_text", rich_text: sourceRich(value) }
  }
  f.clearCalls()
  const lookup = async (query: string) => {
    const metrics = createRequestMetrics()
    const value = await f.run(
      Effect.flatMap(Notion, (api) =>
        discoverRegisteredSourceMembers(library, { query }).pipe(
          Effect.provideService(Notion, { ...api, metrics }),
        ),
      ),
    )
    const observed = metrics.snapshot()
    if (process.env.NTN_SOURCE_DIRECTORY_EVIDENCE)
      await writeFile(
        join(
          process.env.NTN_SOURCE_DIRECTORY_EVIDENCE,
          `${directory.split("/").at(-1)}-${query}.json`,
        ),
        JSON.stringify(
          { revision, query, value, metrics: observed, git: transport.requests },
          null,
          2,
        ),
      )
    return { value, metrics: observed }
  }
  const definition = () =>
    parseCurrentSourceConfiguration(library, f.pages.get(f.sourcePage)).definition
  return { ...f, directory, repository, revision, transport, lookup, definition }
}

test("registered directory observes every Skill name without acquiring their large resources", async () => {
  const mains = [skill("selected"), skill("other")]
  const f = await fixture(
    new Map<string, string | Uint8Array>([
      ["skills/selected/SKILL.md", mains[0]!],
      ["skills/other/SKILL.md", mains[1]!],
      ["skills/selected/large.bin", randomBytes(2 * 1024 * 1024)],
      ["skills/other/large.bin", randomBytes(2 * 1024 * 1024)],
    ]),
  )
  try {
    const { value, metrics } = await f.lookup("selected")
    expect(value.coverage).toBe("complete")
    expect(value.failures).toEqual([])
    expect(value.candidates).toHaveLength(1)
    expect(value.candidates[0]).toMatchObject({
      source_id: sourceId,
      member_key: "skills/selected",
      expected_source_commit: f.revision,
      name: "selected",
      readiness: "materializable",
    })
    expect(metrics.source_acquisitions?.cat_file_bytes).toBe(utf8.encode(mains.join("")).length)
    expect(metrics.source_acquisitions?.repository_object_bytes).toBeLessThan(256 * 1024)
    expect(f.mutations()).toEqual([])
    // The exact manager preparation still acquires and validates all selected
    // resources. No complete body or resource hash was fabricated by the directory.
    const fullMetrics = createRequestMetrics()
    const prepared = await f.run(
      prepareCurrentSource(
        { version: 1, definition: f.definition(), contributions: [] },
        { memberKeys: ["skills/selected"], metrics: fullMetrics },
      ),
    )
    expect(prepared.targets).toHaveLength(1)
    expect(prepared.targets[0]!.files.find((file) => file.path === "large.bin")?.bytes.length).toBe(
      2 * 1024 * 1024,
    )
    expect(fullMetrics.snapshot().source_acquisitions?.cat_file_bytes).toBe(
      utf8.encode(mains[0]!).length + 2 * 1024 * 1024,
    )
    expect(f.mutations()).toEqual([])
  } finally {
    await f.transport.close()
  }
}, 30000)

test("an unrelated broken resource does not make the exact name directory incomplete", async () => {
  const f = await fixture(
    new Map([
      ["skills/selected/SKILL.md", skill("selected")],
      ["skills/other/SKILL.md", skill("other")],
    ]),
    true,
  )
  try {
    const { value } = await f.lookup("selected")
    expect(value.coverage).toBe("complete")
    expect(value.failures).toEqual([])
    expect(value.candidates.map((entry) => entry.member_key)).toEqual(["skills/selected"])
    expect(f.mutations()).toEqual([])
    const full = await f.run(
      prepareCurrentSource(
        { version: 1, definition: f.definition(), contributions: [] },
        { memberKeys: ["skills/other"] },
      ).pipe(Effect.result),
    )
    expect(full).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_GIT_LINK_MISSING" } })
    expect(f.mutations()).toEqual([])
  } finally {
    await f.transport.close()
  }
}, 30000)

test("typed metadata and complete content share mapping, portable and patch semantics", async () => {
  const manifest = JSON.stringify({
    format: "ntn-skills",
    version: 2,
    kind: "skill",
    name: "stored-name",
    description: "Stored description",
    main: "ENTRY.md",
  })
  const f = await fixture(
    new Map([
      ["skills/plain/SKILL.md", skill("plain-name")],
      ["skills/portable/SKILL.md", skill("ignored-name")],
      ["skills/portable/.ntn-skills.json", manifest],
      ["skills/portable/ENTRY.md", "Old entrypoint body"],
      ["skills/portable/ALT.md", "Actual selected entrypoint body"],
      ["skills/portable/resource.txt", "original supporting resource"],
    ]),
  )
  try {
    const input = {
      ...sourceDiscoveryInput(f.definition()),
      mapping: { "skills/plain": "mapped-plain", "skills/portable": "mapped-portable" },
      patch: {
        version: 1 as const,
        files: [
          {
            path: "SKILL.md",
            replacements: [
              {
                from: "description: Complete source directory metadata",
                to: "description: Patched frontmatter description",
              },
            ],
          },
        ],
      },
      member_patches: {
        "skills/portable": {
          version: 1 as const,
          files: [
            {
              path: ".ntn-skills.json",
              replacements: [
                { from: "Stored description", to: "Patched portable description" },
                { from: "ENTRY.md", to: "ALT.md" },
              ],
            },
            { path: "resource.txt", replacements: [{ from: "original", to: "adapted" }] },
          ],
        },
      },
    }
    const metrics = createRequestMetrics()
    // Reusing full-acquisition options cannot silently narrow a complete directory.
    const options = { metrics, onlyMembers: ["skills/plain"] }
    const directory = await f.run(discoverSourceDirectory(input, options))
    expect(directory.kind).toBe("source_directory")
    expect(directory.revision).toBe(f.revision)
    expect(Schema.is(SourceSnapshotSchema)(directory)).toBe(false)
    expect(directory.members).toEqual([
      {
        member_key: "skills/plain",
        source_path: "skills/plain",
        name: "mapped-plain",
        description: "Patched frontmatter description",
        main: "SKILL.md",
      },
      {
        member_key: "skills/portable",
        source_path: "skills/portable",
        name: "mapped-portable",
        description: "Patched portable description",
        main: "ALT.md",
      },
    ])
    expect(metrics.snapshot().source_acquisitions?.cat_file_bytes).toBe(
      utf8.encode(skill("plain-name") + skill("ignored-name") + manifest).length,
    )
    const full = await f.run(discoverSource(input))
    expect(
      full.members.map((member) => ({
        member_key: member.member_key,
        source_path: member.source_path,
        name: member.portable.name,
        description: member.portable.description,
        main: member.portable.main,
      })),
    ).toEqual(directory.members)
    expect(
      new TextDecoder().decode(
        full.members[1]!.portable.files.find((file) => file.path === "resource.txt")!.bytes,
      ),
    ).toBe("adapted supporting resource")
  } finally {
    await f.transport.close()
  }
}, 30000)

test.each([
  ["unknown-version", { version: 3 }],
  ["unknown-field", { extra_metadata: true }],
  ["unsafe-main", { main: "../outside.md" }],
  ["missing-main", { main: "missing.md" }],
] as const)(
  "unreadable portable metadata preserves a partial directory (%s)",
  async (_label, override) => {
    const f = await fixture(
      new Map([
        ["skills/plain/SKILL.md", skill("plain-name")],
        [
          "skills/plain/.ntn-skills.json",
          JSON.stringify({
            format: "ntn-skills",
            version: 2,
            kind: "skill",
            name: "portable-name",
            description: "Portable description",
            main: "SKILL.md",
            ...override,
          }),
        ],
      ]),
    )
    try {
      const { value } = await f.lookup("not-present")
      expect(value.coverage).toBe("partial")
      expect(value.candidates).toEqual([])
      expect(value.failures).toHaveLength(1)
      expect(value.failures[0]!.source_id).toBe(sourceId)
      expect(f.mutations()).toEqual([])
    } finally {
      await f.transport.close()
    }
  },
  30000,
)

test("metadata links resolve through the same fixed member boundary without reading unrelated links", async () => {
  const body = skill("linked-metadata")
  const f = await fixture(new Map([["skills/linked/metadata.md", body]]), false, {
    "skills/linked/SKILL.md": "metadata.md",
    "skills/linked/irrelevant.bin": "missing.bin",
  })
  try {
    const { value, metrics } = await f.lookup("linked-metadata")
    expect(value.coverage).toBe("complete")
    expect(value.candidates.map((entry) => entry.member_key)).toEqual(["skills/linked"])
    expect(metrics.source_acquisitions?.cat_file_bytes).toBe(
      utf8.encode(body + "metadata.md").length,
    )
    expect(f.mutations()).toEqual([])
  } finally {
    await f.transport.close()
  }
}, 30000)

test("duplicate Source identities reject every duplicate before any Git acquisition", async () => {
  const f = await fixture(new Map([["skills/plain/SKILL.md", skill("plain-name")]]))
  try {
    const row = structuredClone(f.pages.get(f.sourcePage)!)
    row.id = "00000000-0000-4000-8000-000000009999"
    f.pages.set(String(row.id), row)
    const { value, metrics } = await f.lookup("plain-name")
    expect(value.coverage).toBe("partial")
    expect(value.candidates).toEqual([])
    expect(value.failures).toEqual([
      { source_id: sourceId, code: "CURRENT_SOURCE_DUPLICATE" },
      { source_id: sourceId, code: "CURRENT_SOURCE_DUPLICATE" },
    ])
    expect(metrics.source_acquisitions).toBeUndefined()
    expect(f.transport.requests).toEqual([])
    expect(f.mutations()).toEqual([])
  } finally {
    await f.transport.close()
  }
}, 30000)

test("four bounded Source acquisitions retain registration order after independent completion", async () => {
  const f = await fixture(new Map([["skills/plain/SKILL.md", skill("plain-name")]]))
  const sourceIds = [sourceId]
  for (let i = 1; i < 6; i++) {
    const row = structuredClone(f.pages.get(f.sourcePage)!)
    row.id = `00000000-0000-4000-8000-${(9000 + i).toString(16).padStart(12, "0")}`
    const source = `${sourceId}-${i}`
    sourceIds.push(source)
    const id = library.sources.property_ids["Source ID"]!
    property(row.properties)[id] = { id, type: "rich_text", rich_text: sourceRich(source) }
    f.pages.set(String(row.id), row)
  }
  let release = () => {}
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    release()
  }, 5000)
  let started = 0,
    active = 0,
    maximum = 0
  const originalMetrics = createRequestMetrics()
  const metrics: ReturnType<typeof createRequestMetrics> = {
    ...originalMetrics,
    beginSourceAcquisition(input) {
      const finish = originalMetrics.beginSourceAcquisition(input)
      active++
      maximum = Math.max(maximum, active)
      return (result) => {
        active--
        finish(result)
      }
    },
  }
  try {
    const value = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const real = yield* ChildProcessSpawner.ChildProcessSpawner
        const routed = ChildProcessSpawner.make((command) => {
          if (
            command._tag === "StandardCommand" &&
            command.args.includes("fetch") &&
            command.args.includes("--depth=1")
          ) {
            started++
            if (started === 4) release()
            if (started <= 4)
              return Effect.promise(() => barrier).pipe(Effect.flatMap(() => real.spawn(command)))
          }
          return real.spawn(command)
        })
        return yield* discoverRegisteredSourceMembers(library, { query: "plain-name" }).pipe(
          Effect.provideService(Notion, { ...api, metrics }),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, routed),
        )
      }),
    )
    expect(timedOut).toBe(false)
    expect(started).toBe(6)
    expect(maximum).toBe(4)
    expect(active).toBe(0)
    expect(value.coverage).toBe("complete")
    expect(value.candidates.map((entry) => entry.source_id)).toEqual(sourceIds)
    expect(value.failures).toEqual([])
    expect(f.mutations()).toEqual([])
  } finally {
    release()
    clearTimeout(timer)
    await f.transport.close()
  }
}, 30000)

test("one parent deadline settles all concurrent Git groups without publishing late candidates", async () => {
  const f = await fixture(new Map([["skills/plain/SKILL.md", skill("plain-name")]]))
  const requests: { path: string; closed: boolean }[] = []
  const children: { handle: ChildProcessSpawner.ChildProcessHandle; args: readonly string[] }[] = []
  const groups = (pids: readonly number[]) =>
    execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,command="], { encoding: "utf8" })
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\s\S]+)$/u.exec(line)
        return match && (pids.includes(Number(match[1])) || pids.includes(Number(match[3])))
          ? [
              {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                pgid: Number(match[3]),
                state: match[4]!,
                command: match[5]!,
              },
            ]
          : []
      })
  let before: ReturnType<typeof groups> = []
  const server = createServer((request, response) => {
    const row = { path: request.url ?? "", closed: false }
    requests.push(row)
    response.once("close", () => {
      row.closed = true
    })
    if (requests.length === 4) before = groups(children.map((child) => Number(child.handle.pid)))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Pending Git service has no TCP address")
  const template = structuredClone(f.pages.get(f.sourcePage)!)
  for (let index = 0; index < 6; index++) {
    const row = index === 0 ? f.pages.get(f.sourcePage)! : structuredClone(template)
    if (index > 0)
      row.id = `00000000-0000-4000-8000-${(10000 + index).toString(16).padStart(12, "0")}`
    const properties = property(row.properties)
    for (const [name, value] of Object.entries({
      "Source ID": `${sourceId}-${index}`,
      Location: `http://127.0.0.1:${address.port}/pending-${index}.git`,
    })) {
      const id = library.sources.property_ids[name]!
      properties[id] = { id, type: "rich_text", rich_text: sourceRich(value) }
    }
    f.pages.set(String(row.id), row)
  }
  const metrics = createRequestMetrics()
  try {
    const started = performance.now()
    const outcome = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const real = yield* ChildProcessSpawner.ChildProcessSpawner
        const observed = ChildProcessSpawner.make((command) =>
          real.spawn(command).pipe(
            Effect.tap((handle) =>
              Effect.sync(() => {
                if (command._tag === "StandardCommand")
                  children.push({ handle, args: [...command.args] })
              }),
            ),
          ),
        )
        return yield* withCurrentInvocationBudget(
          discoverRegisteredSourceMembers(library, { query: "plain-name" }),
          { requests: 100, bytes: 1024 * 1024, duration_ms: 3000 },
        ).pipe(
          Effect.result,
          Effect.provideService(Notion, { ...api, metrics }),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
        )
      }),
    )
    const elapsed_ms = performance.now() - started
    const exits = await Promise.all(
      children.map(async ({ handle, args }) => {
        // The real platform handle reports a signalled exit as PlatformError,
        // rather than inventing an integer exit code for SIGTERM.
        const observed = await Effect.runPromise(handle.exitCode.pipe(Effect.result))
        return {
          pid: Number(handle.pid),
          args,
          exit_code: observed._tag === "Success" ? Number(observed.success) : null,
          exit_observation: observed,
          running: await Effect.runPromise(handle.isRunning),
        }
      }),
    )
    const after = groups(exits.map((entry) => entry.pid))
    const candidateKeys = [...f.json.keys()].filter((key) =>
      key.startsWith("cache/source-members/"),
    )
    await writeFile(
      join(f.directory, "deadline-evidence.json"),
      JSON.stringify(
        {
          duration_ms: 3000,
          elapsed_ms,
          requests,
          before,
          exits,
          after,
          outcome,
          candidate_keys: candidateKeys,
          metrics: metrics.snapshot(),
          mutations: f.mutations(),
        },
        null,
        2,
      ),
    )
    if (process.env.NTN_SOURCE_DIRECTORY_EVIDENCE) {
      await copyFile(
        join(f.directory, "deadline-evidence.json"),
        join(process.env.NTN_SOURCE_DIRECTORY_EVIDENCE, "deadline-evidence.json"),
      )
      await writeFile(
        join(process.env.NTN_SOURCE_DIRECTORY_EVIDENCE, "deadline-evidence-ref.json"),
        JSON.stringify({ path: join(f.directory, "deadline-evidence.json") }),
      )
    }
    expect(requests).toHaveLength(4)
    expect(
      before.filter((entry) => entry.command.includes("remote-http")).length,
    ).toBeGreaterThanOrEqual(4)
    expect(exits.filter((entry) => entry.args.includes("fetch"))).toHaveLength(4)
    expect(exits.every((entry) => !entry.running)).toBe(true)
    expect(after.filter((entry) => !entry.state.startsWith("Z"))).toEqual([])
    expect(elapsed_ms).toBeLessThan(5500)
    expect(metrics.snapshot().source_acquisitions).toMatchObject({ attempts: 4, in_flight: 0 })
    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { code: "REQUEST_BUDGET_EXHAUSTED" },
    })
    expect(candidateKeys).toEqual([])
    expect(f.mutations()).toEqual([])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await f.transport.close()
  }
}, 15000)

test("directory retains duplicate aliases and isolates ambiguity to the requested alias", async () => {
  const f = await fixture(
    new Map([
      ["skills/selected/SKILL.md", skill("selected")],
      ["skills/one/SKILL.md", skill("shared-name")],
      ["skills/two/SKILL.md", skill("shared-name")],
    ]),
  )
  try {
    const selected = await f.lookup("selected")
    expect(selected.value.coverage).toBe("complete")
    expect(selected.value.candidates.map((entry) => entry.member_key)).toEqual(["skills/selected"])
    const ambiguous = await f.lookup("shared-name")
    expect(ambiguous.value.coverage).toBe("complete")
    expect(ambiguous.value.candidates.map((entry) => entry.member_key)).toEqual([
      "skills/one",
      "skills/two",
    ])
    expect(new Set(ambiguous.value.candidates.map((entry) => entry.expected_skill_id)).size).toBe(2)
    expect(f.mutations()).toEqual([])
  } finally {
    await f.transport.close()
  }
}, 30000)
