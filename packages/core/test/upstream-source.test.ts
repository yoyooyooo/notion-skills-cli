import { expect, test } from "bun:test"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverSource,
  type DiscoverSourceInput,
  type SourcePatch,
} from "../src/upstream-source.ts"
import { portableIdentity } from "../src/export.ts"

const services = Layer.merge(NodeServices.layer, NodeHttpClient.layerFetch)
const utf8 = new TextEncoder()
const binary = new Uint8Array([0, 255, 128, 1, 13, 10, 0])
const skill = (name: string, body = "Read [guide](../guide/SKILL.md).") =>
  `---\nname: ${name}\ndescription: Use when exercising source discovery\n---\n\n${body}\n`
function git(directory: string, args: readonly string[]) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Source Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Source Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  }).trim()
}
async function repository(operation: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ntn-source-test-"))
  try {
    git(directory, ["init", "-b", "main"])
    await operation(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
async function put(directory: string, path: string, contents: string | Uint8Array) {
  await mkdir(join(directory, path, ".."), { recursive: true })
  await writeFile(join(directory, path), contents)
}
function commit(directory: string) {
  git(directory, ["add", "."])
  git(directory, ["commit", "--no-gpg-sign", "-m", "controlled source"])
  return git(directory, ["rev-parse", "HEAD"])
}
function input(
  directory: string,
  overrides: Partial<DiscoverSourceInput> = {},
): DiscoverSourceInput {
  return {
    source: { type: "git", url: directory, ref: "main" },
    roots: ["skills"],
    include: [],
    exclude: [],
    mapping: {},
    ...overrides,
  }
}
function discover(input: DiscoverSourceInput) {
  return Effect.runPromise(discoverSource(input).pipe(Effect.provide(services)))
}
function result(input: DiscoverSourceInput) {
  return Effect.runPromise(discoverSource(input).pipe(Effect.result, Effect.provide(services)))
}

test("Git snapshot pins a commit, retains binary bytes, filters one roster and maps names by stable path", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("alpha"))
    await put(directory, "skills/alpha/assets/image.bin", binary)
    await put(directory, "skills/alpha/.hidden", "preserve hidden files\n")
    await put(directory, "skills/beta/SKILL.md", skill("beta"))
    await put(directory, "skills/deprecated/old/SKILL.md", skill("old"))
    await put(directory, "elsewhere/outside/SKILL.md", skill("outside"))
    const revision = commit(directory)
    // Dirty working-tree bytes must never enter the fetched object snapshot.
    await put(directory, "skills/alpha/assets/image.bin", "uncommitted corruption")
    const snapshot = await discover(
      input(directory, {
        include: ["skills/**"],
        exclude: ["skills/deprecated/**", "skills/beta/**"],
        mapping: { "skills/alpha": "Mapped Alpha" },
      }),
    )
    expect(snapshot.revision).toBe(revision)
    expect(snapshot.provenance).toMatchObject({ provider: "git", resolved_ref: revision })
    expect(snapshot.provenance.tree_hash).toBe(git(directory, ["rev-parse", `${revision}^{tree}`]))
    expect(snapshot.members.map((member) => member.member_key)).toEqual(["skills/alpha"])
    const member = snapshot.members[0]!
    expect(member.source_path).toBe("skills/alpha")
    expect(member.portable.name).toBe("Mapped Alpha")
    expect(member.portable.files.find((file) => file.path === "assets/image.bin")!.bytes).toEqual(
      binary,
    )
    expect(member.portable.files.find((file) => file.path === "SKILL.md")!.bytes).toEqual(
      utf8.encode(skill("alpha")),
    )
    expect(member.portable.files.some((file) => file.path === ".hidden")).toBe(true)
    expect(member.upstream_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(member.portable.kind).toBe("skill")
    expect(member.content_hash).toBe(
      await Effect.runPromise(portableIdentity(member.portable).pipe(Effect.provide(services))),
    )
    expect(member.patch_hash).toBeUndefined()
  })
})

test("source descriptions retain complete long metadata, stable identity and original bytes", async () => {
  await repository(async (directory) => {
    const description = "Complete original metadata. ".repeat(50)
    const original = utf8.encode(
      `---\nname: tty7\ndescription: ${JSON.stringify(description)}\n---\n\nOriginal body.\n`,
    )
    await put(directory, "skills/tty7/SKILL.md", original)
    commit(directory)
    const snapshot = await discover(input(directory))
    const member = snapshot.members[0]!
    expect(member.member_key).toBe("skills/tty7")
    expect(member.portable.name).toBe("tty7")
    expect(member.portable.description).toBe(description)
    expect(member.portable.files.find((file) => file.path === "SKILL.md")!.bytes).toEqual(original)
    expect(member.patch_hash).toBeUndefined()
  })
})

test("Git literal paths preserve brackets Unicode spaces and pathspec characters", async () => {
  await repository(async (directory) => {
    const key = "skills/[示例] literal space"
    const paths = [
      "references/[guide].md",
      "assets/图 像.bin",
      "references/a*b?.md",
      "references/topic:detail.md",
    ]
    await put(directory, `${key}/SKILL.md`, skill("alpha"))
    for (const path of paths) await put(directory, `${key}/${path}`, binary)
    // An unrelated legitimate path must not invalidate the whole tree either.
    await put(directory, "docs/[elsewhere]/说明 space.txt", "unselected")
    const revision = commit(directory)
    const snapshot = await discover(
      input(directory, { roots: [key], include: [key], mapping: { [key]: "Literal Skill" } }),
    )
    expect(snapshot.revision).toBe(revision)
    expect(snapshot.members.map((member) => member.member_key)).toEqual([key])
    expect(snapshot.members[0]!.portable.name).toBe("Literal Skill")
    for (const path of paths)
      expect(snapshot.members[0]!.portable.files.find((file) => file.path === path)?.bytes).toEqual(
        binary,
      )
    for (const root of [
      "../escape",
      "/absolute",
      "C:/absolute",
      "skills/../escape",
      "skills/\0escape",
    ])
      expect(await result(input(directory, { roots: [root] }))).toMatchObject({
        _tag: "Failure",
        failure: { code: "UPSTREAM_UNSAFE_PATH" },
      })
  })
})

test("accepted_ref reacquires an older immutable roster and hash after main changes", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("alpha", "Accepted body"))
    const accepted = commit(directory)
    const before = await discover(input(directory))
    await put(directory, "skills/alpha/SKILL.md", skill("alpha", "New upstream body"))
    await put(directory, "skills/beta/SKILL.md", skill("beta"))
    const head = commit(directory)
    const latest = await discover(input(directory))
    const baseline = await discover(input(directory, { accepted_ref: accepted }))
    expect(latest.revision).toBe(head)
    expect(latest.members).toHaveLength(2)
    expect(baseline.revision).toBe(accepted)
    expect(baseline.members).toEqual(before.members)
    expect(latest.members[0]!.upstream_hash).not.toBe(before.members[0]!.upstream_hash)
  })
})

test("explicit patch preserves raw upstream, patch identity and adapted content independently", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("alpha"))
    await put(directory, "skills/alpha/assets/raw.bin", binary)
    commit(directory)
    const patch: SourcePatch = {
      version: 1,
      files: [
        {
          path: "SKILL.md",
          replacements: [{ from: "[guide](../guide/SKILL.md)", to: "the installed guide skill" }],
        },
      ],
    }
    const raw = await discover(input(directory))
    const adapted = await discover(input(directory, { patch }))
    const again = await discover(input(directory, { patch }))
    expect(adapted.members[0]!.upstream_hash).toBe(raw.members[0]!.upstream_hash)
    expect(adapted.members[0]!.content_hash).not.toBe(raw.members[0]!.content_hash)
    expect(adapted.members[0]!.patch_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(adapted.members[0]!.patch_hash).toBe(
      createHash("sha256").update(JSON.stringify(patch)).digest("hex"),
    )
    expect(adapted.members).toEqual(again.members)
    expect(
      new TextDecoder().decode(
        adapted.members[0]!.portable.files.find((file) => file.path === "SKILL.md")!.bytes,
      ),
    ).toContain("the installed guide skill")
    expect(
      adapted.members[0]!.portable.files.find((file) => file.path === "assets/raw.bin")!.bytes,
    ).toEqual(binary)
    expect((await discover(input(directory))).members).toEqual(raw.members)
    expect(
      await result(
        input(directory, {
          patch: {
            version: 1,
            files: [{ path: "SKILL.md", replacements: [{ from: "absent", to: "new" }] }],
          },
        }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_PATCH_CONFLICT" } })
    expect(
      await result(
        input(directory, {
          patch: {
            version: 1,
            files: [{ path: "../escape", replacements: [{ from: "Read", to: "Write" }] }],
          },
        }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_UNSAFE_PATH" } })
  })
})

test("member patch adapts only the exact selected member and preserves single patch identity", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("alpha"))
    await put(directory, "skills/alpha/assets/raw.bin", binary)
    await put(directory, "skills/alpha-extra/SKILL.md", skill("alpha-extra"))
    await put(directory, "skills/alpha-extra/assets/raw.bin", binary)
    commit(directory)
    const patch: SourcePatch = {
      version: 1,
      files: [
        {
          path: "SKILL.md",
          replacements: [{ from: "[guide](../guide/SKILL.md)", to: "the installed guide skill" }],
        },
      ],
    }
    const raw = await discover(input(directory))
    const adapted = await discover(input(directory, { member_patches: { "skills/alpha": patch } }))
    expect(adapted.members.map((member) => member.member_key)).toEqual([
      "skills/alpha",
      "skills/alpha-extra",
    ])
    const alpha = adapted.members[0]!
    expect(alpha.upstream_hash).toBe(raw.members[0]!.upstream_hash)
    expect(alpha.patch_hash).toBe(createHash("sha256").update(JSON.stringify(patch)).digest("hex"))
    expect(alpha.portable.files.find((file) => file.path === "SKILL.md")!.bytes).toEqual(
      utf8.encode(skill("alpha", "Read the installed guide skill.")),
    )
    expect(alpha.portable.files.find((file) => file.path === "assets/raw.bin")!.bytes).toEqual(
      binary,
    )
    expect(alpha.content_hash).not.toBe(raw.members[0]!.content_hash)
    expect(alpha.content_hash).toBe(
      await Effect.runPromise(portableIdentity(alpha.portable).pipe(Effect.provide(services))),
    )
    expect(adapted.members[1]).toEqual(raw.members[1])
    expect(adapted.members[1]!.patch_hash).toBeUndefined()
  })
})

test("member patches reject missing and nonselected keys even when empty selection is allowed", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("alpha"))
    await put(directory, "skills/beta/SKILL.md", skill("beta"))
    commit(directory)
    const patch: SourcePatch = {
      version: 1,
      files: [{ path: "SKILL.md", replacements: [{ from: "Read", to: "Use" }] }],
    }
    const cases: Partial<DiscoverSourceInput>[] = [
      { member_patches: { "skills/missing": patch } },
      { member_patches: { "skills/missing": patch }, allow_empty: true },
      { member_patches: { "skills/beta": patch }, include: ["skills/alpha"] },
      {
        member_patches: { "skills/beta": patch },
        exclude: ["skills/beta"],
        allow_empty: true,
      },
      {
        member_patches: { "skills/alpha": patch },
        exclude: ["skills/**"],
        allow_empty: true,
      },
    ]
    for (const overrides of cases)
      expect(await result(input(directory, overrides))).toMatchObject({
        _tag: "Failure",
        failure: { code: "UPSTREAM_PATCH_CONFLICT" },
      })
  })
})

test("global and member patches reject the same relative file even with disjoint replacements", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("alpha", "Global token and member token."))
    await put(directory, "skills/beta/SKILL.md", skill("beta", "Global token and member token."))
    commit(directory)
    expect(
      await result(
        input(directory, {
          patch: {
            version: 1,
            files: [
              { path: "SKILL.md", replacements: [{ from: "Global token", to: "Global edit" }] },
            ],
          },
          member_patches: {
            "skills/alpha": {
              version: 1,
              files: [
                { path: "SKILL.md", replacements: [{ from: "member token", to: "member edit" }] },
              ],
            },
          },
        }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_PATCH_CONFLICT" } })
  })
})

test("disjoint global and member patches compose in global first identity with adapted resource bytes", async () => {
  await repository(async (directory) => {
    for (const name of ["alpha", "beta"]) {
      await put(directory, `skills/${name}/SKILL.md`, skill(name))
      await put(directory, `skills/${name}/references/guide.md`, "Use the upstream resource.\n")
      await put(directory, `skills/${name}/assets/raw.bin`, binary)
    }
    commit(directory)
    const globalPatch: SourcePatch = {
      version: 1,
      files: [
        {
          path: "SKILL.md",
          replacements: [{ from: "[guide](../guide/SKILL.md)", to: "the installed guide skill" }],
        },
      ],
    }
    const memberPatch: SourcePatch = {
      version: 1,
      files: [
        {
          path: "references/guide.md",
          replacements: [{ from: "upstream resource", to: "adapted resource" }],
        },
      ],
    }
    const raw = await discover(input(directory))
    const adapted = await discover(
      input(directory, {
        patch: globalPatch,
        member_patches: { "skills/alpha": memberPatch },
      }),
    )
    expect(adapted.members.map((member) => member.member_key)).toEqual([
      "skills/alpha",
      "skills/beta",
    ])
    for (const [index, name] of ["alpha", "beta"].entries()) {
      const member = adapted.members[index]!
      expect(member.upstream_hash).toBe(raw.members[index]!.upstream_hash)
      expect(member.portable.files.find((file) => file.path === "SKILL.md")!.bytes).toEqual(
        utf8.encode(skill(name, "Read the installed guide skill.")),
      )
      expect(
        member.portable.files.find((file) => file.path === "references/guide.md")!.bytes,
      ).toEqual(
        utf8.encode(
          name === "alpha" ? "Use the adapted resource.\n" : "Use the upstream resource.\n",
        ),
      )
      expect(member.portable.files.find((file) => file.path === "assets/raw.bin")!.bytes).toEqual(
        binary,
      )
      expect(member.content_hash).not.toBe(raw.members[index]!.content_hash)
      expect(member.content_hash).toBe(
        await Effect.runPromise(portableIdentity(member.portable).pipe(Effect.provide(services))),
      )
      expect(member.patch_hash).toBe(
        createHash("sha256")
          .update(
            JSON.stringify(
              name === "alpha" ? { global: globalPatch, member: memberPatch } : globalPatch,
            ),
          )
          .digest("hex"),
      )
    }
  })
})

test("composed global and member patches each require exactly one replacement match", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("alpha", "unique repeated repeated"))
    await put(directory, "skills/alpha/references/guide.md", "unique repeated repeated\n")
    commit(directory)
    for (const scope of ["global", "member"])
      for (const from of ["absent", "repeated"])
        expect(
          await result(
            input(directory, {
              patch: {
                version: 1,
                files: [
                  {
                    path: "SKILL.md",
                    replacements: [{ from: scope === "global" ? from : "unique", to: "adapted" }],
                  },
                ],
              },
              member_patches: {
                "skills/alpha": {
                  version: 1,
                  files: [
                    {
                      path: "references/guide.md",
                      replacements: [{ from: scope === "member" ? from : "unique", to: "adapted" }],
                    },
                  ],
                },
              },
            }),
          ),
        ).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_PATCH_CONFLICT" } })
  })
})

test("patch refuses multiple or overlapping occurrences and duplicate patch paths", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("alpha", "aaaa"))
    commit(directory)
    for (const files of [
      [{ path: "SKILL.md", replacements: [{ from: "aa", to: "b" }] }],
      [
        { path: "SKILL.md", replacements: [{ from: "aaaa", to: "b" }] },
        { path: "SKILL.md", replacements: [{ from: "aaaa", to: "c" }] },
      ],
    ])
      expect(await result(input(directory, { patch: { version: 1, files } }))).toMatchObject({
        _tag: "Failure",
        failure: { code: "UPSTREAM_PATCH_CONFLICT" },
      })
  })
})

test("selection fails closed on incomplete includes, missing roots and name collisions", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("same"))
    await put(directory, "skills/beta/SKILL.md", skill("same"))
    await put(directory, "skills/incomplete/README.md", "No skill entrypoint")
    commit(directory)
    expect(await result(input(directory, { include: ["skills/incomplete"] }))).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_INCOMPLETE_MEMBER" },
    })
    expect(await result(input(directory, { roots: ["missing"] }))).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_MISSING_ROOT" },
    })
    expect(await result(input(directory))).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_NAME_COLLISION" },
    })
    const mapped = await discover(input(directory, { mapping: { "skills/beta": "Distinct Name" } }))
    expect(mapped.members.map((member) => member.portable.name)).toEqual(["same", "Distinct Name"])
    expect(
      await result(
        input(directory, { include: ["skills/alpha"], mapping: { "skills/beta": "Beta" } }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_INVALID_MAPPING" } })
    expect(await result(input(directory, { roots: ["../escape"] }))).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_UNSAFE_PATH" },
    })
  })
})

test("Git object discovery rejects absolute links and submodules without dereferencing", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("alpha"))
    await symlink("/etc/passwd", join(directory, "skills/alpha/leak"))
    const first = commit(directory)
    expect(await result(input(directory))).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_GIT_LINK_ABSOLUTE" },
    })
    git(directory, ["rm", "skills/alpha/leak"])
    git(directory, ["update-index", "--add", "--cacheinfo", `160000,${first},skills/alpha/vendor`])
    git(directory, ["commit", "--no-gpg-sign", "-m", "gitlink fixture"])
    expect(await result(input(directory))).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_GIT_LINK_SUBMODULE" },
    })
  })
})

test("Git snapshot rejects nested members and unsafe tracked paths", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("alpha"))
    await put(directory, "skills/alpha/nested/SKILL.md", skill("nested"))
    commit(directory)
    expect(await result(input(directory))).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_NESTED_MEMBER" },
    })
    git(directory, ["rm", "-r", "skills/alpha/nested"])
    await put(directory, "skills/alpha/bad\\path.bin", binary)
    commit(directory)
    expect(await result(input(directory))).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_UNSAFE_PATH" },
    })
  })
})

test("invalid refs and malformed marketplace URLs fail as modeled source errors", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("alpha"))
    commit(directory)
    expect(
      await result(
        input(directory, { source: { type: "git", url: directory, ref: "missing-ref" } }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_GIT_FAILED" } })
    expect(
      await result(
        input(directory, { source: { type: "git", url: directory, ref: "--upload-pack=evil" } }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_INVALID_REF" } })
    for (const url of [
      "https://other.test/owner/repo/skill",
      "https://skills.sh/owner/repo",
      "https://skills.sh/owner/repo/skill?override=x",
      "https://skills.sh/owner/repo/%2e%2e",
    ]) {
      expect(
        await result(input(directory, { source: { type: "github-market", url } })),
      ).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_INVALID_SOURCE" } })
    }
  })
})

test("Git source launches a configured host credential helper without exposing authentication output", async () => {
  await repository(async (directory) => {
    const marker = join(directory, "helper-calls")
    const helper = join(directory, "credential-helper")
    const config = join(directory, "host.gitconfig")
    await writeFile(
      helper,
      `#!/bin/sh\nprintf '%s\\n' "$1" >> '${marker}'\nwhile IFS= read -r line && [ -n "$line" ]; do :; done\nif [ "$1" = get ]; then printf 'username=fixture-user\\npassword=fixture-password\\n'; fi\n`,
      { mode: 0o700 },
    )
    await writeFile(config, `[credential]\n\thelper = ${helper}\n`)
    const server = createServer((request, response) => {
      response.writeHead(request.headers.authorization ? 403 : 401, {
        "WWW-Authenticate": 'Basic realm="source-fixture"',
      })
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address() as { port: number }
    try {
      const acquire = Effect.gen(function* () {
        const real = yield* ChildProcessSpawner.ChildProcessSpawner
        const configured = ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand") return real.spawn(command)
          expect(command.options.env).not.toHaveProperty("GIT_CONFIG_GLOBAL")
          expect(command.options.env).not.toHaveProperty("GIT_CONFIG_NOSYSTEM")
          return real.spawn(
            ChildProcess.make(command.command, command.args, {
              ...command.options,
              env: { ...command.options.env, GIT_CONFIG_GLOBAL: config },
            }),
          )
        })
        return yield* discoverSource(
          input(directory, {
            source: {
              type: "git",
              url: `http://127.0.0.1:${address.port}/private.git`,
              ref: "main",
            },
          }),
        ).pipe(
          Effect.result,
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, configured),
        )
      })
      const outcome = await Effect.runPromise(acquire.pipe(Effect.provide(services)))
      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: {
          code: "UPSTREAM_GIT_FAILED",
          details: { operation: "fetch", exit_code: 128 },
        },
      })
      expect(
        (await readFile(marker, "utf8")).split("\n").filter((operation) => operation === "get"),
      ).toHaveLength(1)
      expect(JSON.stringify(outcome)).not.toMatch(
        /fixture-user|fixture-password|Authorization|Basic /,
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})

test("Git source rejects embedded credentials and disallows host URL rewrites to external helpers", async () => {
  await repository(async (directory) => {
    for (const url of [
      "https://user:password@example.test/source.git",
      "https://user@example.test/source.git",
      "ext::untrusted-source",
    ]) {
      const outcome = await result(input(directory, { source: { type: "git", url, ref: "main" } }))
      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { code: "UPSTREAM_INVALID_SOURCE" },
      })
      expect(JSON.stringify(outcome)).not.toContain(url)
    }
    const config = join(directory, "host.gitconfig")
    const marker = join(directory, "external-helper-ran")
    await writeFile(
      config,
      `[url "ext::sh -c touch%20${marker}"]\n\tinsteadOf = https://rewrite.example.test/\n[protocol "ext"]\n\tallow = always\n`,
    )
    const acquire = Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      const configured = ChildProcessSpawner.make((command) =>
        command._tag === "StandardCommand"
          ? real.spawn(
              ChildProcess.make(command.command, command.args, {
                ...command.options,
                env: { ...command.options.env, GIT_CONFIG_GLOBAL: config },
              }),
            )
          : real.spawn(command),
      )
      return yield* discoverSource(
        input(directory, {
          source: {
            type: "git",
            url: "https://rewrite.example.test/source.git",
            ref: "main",
          },
        }),
      ).pipe(
        Effect.result,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, configured),
      )
    })
    expect(await Effect.runPromise(acquire.pipe(Effect.provide(services)))).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_GIT_FAILED" },
    })
    await expect(access(marker)).rejects.toThrow()
  })
})

test("skills.sh provenance resolves a unique directory through real Git object acquisition", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("alpha"))
    await put(directory, "skills/beta/SKILL.md", skill("beta"))
    const first = commit(directory)
    const acquire = Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      // Route only this fixture's GitHub fetch URL to a controlled real repository.
      const routed = ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") {
          const args = command.args.map((arg) =>
            arg === "https://github.com/fixture/catalog.git" ? directory : arg,
          )
          return real.spawn(ChildProcess.make(command.command, args, command.options))
        }
        return real.spawn(command)
      })
      return yield* discoverSource(
        input(directory, {
          source: {
            type: "github-market",
            url: "https://skills.sh/fixture/catalog/alpha",
            ref: "main",
          },
        }),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, routed))
    })
    const snapshot = await Effect.runPromise(acquire.pipe(Effect.provide(services)))
    expect(snapshot.revision).toBe(first)
    expect(snapshot.members.map((member) => member.member_key)).toEqual(["skills/alpha"])
    expect(snapshot.provenance).toMatchObject({
      provider: "skills.sh",
      source_url: "https://www.skills.sh/fixture/catalog/alpha",
      git_url: "https://github.com/fixture/catalog.git",
      catalog_slug: "alpha",
    })
    await put(directory, "other/alpha/SKILL.md", skill("another"))
    commit(directory)
    expect(
      await Effect.runPromise(acquire.pipe(Effect.result, Effect.provide(services))),
    ).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_MARKET_AMBIGUOUS" } })
  })
})

interface RegistryFile {
  path: string
  size?: number
  sha256?: string
  contentType?: string
}
async function registry(
  operation: (fixture: {
    source: Extract<DiscoverSourceInput["source"], { type: "registry" }>
    files: RegistryFile[]
    bodies: Map<string, Uint8Array>
    requests: URL[]
    setLatest: (version: string) => void
    setVersion: (version: string) => void
    setOwner: (owner: string) => void
  }) => Promise<void>,
) {
  const bodies = new Map([
    ["SKILL.md", utf8.encode(skill("getnote"))],
    ["assets/data.bin", binary],
  ])
  const files: RegistryFile[] = [...bodies].map(([path, bytes]) => ({
    path,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: path.endsWith(".md") ? "text/markdown" : "application/octet-stream",
  }))
  const requests: URL[] = []
  let latest = "1.8.8"
  let version = "1.8.8"
  let owner = "iswalle"
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture.test")
    requests.push(url)
    const send = (data: unknown) => {
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify(data))
    }
    if (url.pathname === "/api/v1/skills/getnote")
      return send({
        skill: { slug: "getnote", displayName: "Getnote" },
        owner: { handle: owner },
        latestVersion: { version: latest },
      })
    if (url.pathname.startsWith("/api/v1/skills/getnote/versions/"))
      return send({ version: { version, files, security: { status: "clean" } } })
    if (url.pathname === "/api/v1/skills/getnote/file") {
      const bytes = bodies.get(url.searchParams.get("path")!)
      if (bytes) {
        response.end(bytes)
        return
      }
    }
    response.statusCode = 404
    response.end("missing fixture")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture has no bound TCP port")
    await operation({
      source: {
        type: "registry",
        base_url: `http://127.0.0.1:${address.port}`,
        owner: "iswalle",
        slug: "getnote",
      },
      files,
      bodies,
      requests,
      setLatest: (value) => {
        latest = value
      },
      setVersion: (value) => {
        version = value
      },
      setOwner: (value) => {
        owner = value
      },
    })
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

test("registry follows ClawHub getnote version/file protocol and verifies binary and manifest hashes", async () => {
  await registry(async ({ source, files, requests }) => {
    const snapshot = await discover({ source, roots: ["."], include: [], exclude: [], mapping: {} })
    expect(snapshot.revision).toBe("1.8.8")
    expect(snapshot.members[0]!.member_key).toBe(".")
    expect(
      snapshot.members[0]!.portable.files.find((file) => file.path === "assets/data.bin")!.bytes,
    ).toEqual(binary)
    const normalized = files
      .map(
        (file) => `${file.path}:${file.sha256 ?? ""}:${file.size ?? ""}:${file.contentType ?? ""}`,
      )
      .sort()
      .join("\n")
    expect(snapshot.provenance).toMatchObject({
      provider: "clawhub",
      resolved_ref: "1.8.8",
      owner: "iswalle",
      slug: "getnote",
      security_status: "clean",
      manifest_hash: createHash("sha256").update(`1.8.8\n${normalized}`).digest("hex"),
    })
    expect(requests.map((url) => url.pathname)).toEqual([
      "/api/v1/skills/getnote",
      "/api/v1/skills/getnote/versions/1.8.8",
      "/api/v1/skills/getnote/file",
      "/api/v1/skills/getnote/file",
    ])
    expect(requests.every((url) => url.searchParams.get("ownerHandle") === "iswalle")).toBe(true)
    expect(
      requests
        .filter((url) => url.pathname.endsWith("/file"))
        .every((url) => url.searchParams.get("version") === "1.8.8"),
    ).toBe(true)
  })
})

test("registry accepted_ref pins version despite a newer latest and detects wrong version and owner", async () => {
  await registry(async ({ source, setLatest, setVersion, setOwner, requests }) => {
    setLatest("2.0.0")
    const options = {
      source,
      roots: ["."],
      include: [],
      exclude: [],
      mapping: {},
      accepted_ref: "1.8.8",
    }
    expect((await discover(options)).revision).toBe("1.8.8")
    expect(requests.some((url) => url.pathname.endsWith("/versions/1.8.8"))).toBe(true)
    setVersion("2.0.0")
    expect(await result(options)).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_REGISTRY_MISMATCH" },
    })
    setOwner("someone-else")
    expect(await result(options)).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_REGISTRY_MISMATCH" },
    })
  })
})

test("registry rejects hash drift, duplicate paths, traversal, incomplete Skills and manifest byte bounds", async () => {
  await registry(async ({ source, files, bodies }) => {
    const options = { source, roots: ["."], include: [], exclude: [], mapping: {} }
    bodies.set("assets/data.bin", new Uint8Array([7, 7, 7, 7, 7, 7, 7]))
    expect(await result(options)).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_HASH_MISMATCH" },
    })
    bodies.set("assets/data.bin", binary)
    files.push({ ...files[0]! })
    expect(await result(options)).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_INVALID_MANIFEST" },
    })
    files.pop()
    files.push({ path: "assets", size: 0 })
    expect(await result(options)).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_INVALID_MANIFEST" },
    })
    files.pop()
    files[1]!.path = "../escape"
    expect(await result(options)).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_UNSAFE_PATH" },
    })
    files[1]!.path = "assets/data.bin"
    files[1]!.size = 129 * 1024 * 1024
    expect(await result(options)).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_LIMIT" },
    })
    files.splice(0, files.length, { path: "README.md" })
    expect(await result(options)).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_EMPTY_SELECTION" },
    })
  })
})

test("subscription discovery can retire every member without treating absence as a successful new candidate", async () => {
  await repository(async (directory) => {
    await put(directory, "skills/alpha/SKILL.md", skill("alpha"))
    commit(directory)
    const first = await discover(input(directory, { allow_empty: true }))
    expect(first.members.map((m) => m.member_key)).toEqual(["skills/alpha"])
    git(directory, ["rm", "-r", "skills"])
    await put(directory, "README.txt", "source still exists")
    const revision = commit(directory)
    const missing = await discover(input(directory, { allow_empty: true }))
    expect(missing.revision).toBe(revision)
    expect(missing.members).toEqual([])
    const strict = await result(
      input(directory, {
        allow_empty: true,
        require_all_included: true,
        include: ["skills/alpha"],
      }),
    )
    expect(strict._tag).toBe("Failure")
  })
})

test("source discovery preserves digits Unicode and spaces without changing member identity", async () => {
  await repository(async (directory) => {
    const names = ["Tty7", "n8n-workflow", "React19", "中文", "Skill With Spaces"]
    for (const name of names) await put(directory, `skills/${name}/SKILL.md`, skill(name))
    commit(directory)
    const snapshot = await discover(input(directory))
    expect(snapshot.members.map((member) => member.portable.name).sort()).toEqual([...names].sort())
    for (const member of snapshot.members) {
      expect(member.member_key).toBe(`skills/${member.portable.name}`)
      expect(member.source_path).toBe(member.member_key)
      const main = member.portable.files.find((file) => file.path === member.portable.main)!
      expect(new TextDecoder().decode(main.bytes)).toContain(`name: ${member.portable.name}\n`)
    }
  })
})
