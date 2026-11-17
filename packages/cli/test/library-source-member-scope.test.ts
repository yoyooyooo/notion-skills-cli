import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Stdio } from "effect"
import { Command } from "effect/cli"
import { HttpClient, HttpClientResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sourceAdmitCommand } from "../src/commands-library-source-members.ts"
import { discoverSourceDefinition } from "../../core/src/shared-source-adapters.ts"
import { sourceDefinitionPropertiesFor } from "../../core/src/shared-source-definitions.ts"
import { property } from "../../core/src/model.ts"
import { Store } from "../../core/src/store.ts"
import type { SourceDefinitionInput } from "../../core/src/shared-sources-model.ts"
import { fixture, library, input } from "../../core/test/shared-source-projection-fixture.ts"

const root = Command.make("scope-test").pipe(Command.withSubcommands([sourceAdmitCommand]))
const body = "---\nname: selected\ndescription: Exact selected member\n---\n\n# Selected\n"
const main = new TextEncoder().encode(body)
const gitUrl = "https://github.com/fixture/member-scope.git"

function configured(definition: SourceDefinitionInput) {
  const f = fixture()
  const outputs = new Map<string, Uint8Array>()
  for (const [key, value] of Object.entries(sourceDefinitionPropertiesFor(library, definition)))
    f.source.properties[key] = { ...property(f.source.properties[key]), ...property(value) }
  const admit = (member: string) =>
    Effect.gen(function* () {
      const store = yield* Store
      yield* Command.runWith(root, { version: "test", renderErrors: false })([
        "admit",
        f.source.id,
        "--entry",
        library.skills.database_id,
        "--member",
        member,
        "--skill-id",
        "exact-member-scope",
        "--storage",
        definition.adapter.type === "registry" ? "retained" : "fixed-git",
        "--output",
        "member-plan.json",
      ]).pipe(
        Effect.provideService(Store, {
          ...store,
          output: (path, bytes) =>
            Effect.sync(() => {
              const reused = outputs.has(path)
              outputs.set(path, bytes)
              return { output: path, reused }
            }),
        }),
      )
    })
  return { ...f, outputs, admit }
}

test("source admit isolates one Git member from unrelated malformed frontmatter and reports an absent member", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-member-scope-"))
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Source fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Source fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], {
      env: environment,
      encoding: "utf8",
      stdio: "pipe",
    }).trim()
  git("init", "-b", "main")
  for (const [member, text] of [
    ["selected", body],
    ["other", "---\nname: other\ndescription: Invalid YAML: unquoted colon\n---\n\n# Other\n"],
  ]) {
    await mkdir(join(directory, "skills", member!), { recursive: true })
    await writeFile(join(directory, "skills", member!, "SKILL.md"), text!)
  }
  git("add", ".")
  git("commit", "--no-gpg-sign", "-m", "Exact source member fixture")
  const revision = git("rev-parse", "HEAD")
  const definition = {
    ...input,
    adapter: { type: "git" as const, url: gitUrl, ref: revision },
    selection: { roots: ["skills"], include: [], exclude: [], mapping: {} },
  }
  const f = configured(definition)
  await f.run(
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      const routed = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return real.spawn(command)
        const args = command.args.map((arg) => (arg === gitUrl ? directory : arg))
        return real.spawn(ChildProcess.make(command.command, args, command.options))
      })
      yield* Effect.gen(function* () {
        const complete = yield* discoverSourceDefinition(definition).pipe(Effect.result)
        expect(complete).toMatchObject({ _tag: "Failure", failure: { code: "INVALID_INPUT" } })
        f.registerSnapshot(
          yield* discoverSourceDefinition(definition, { onlyMembers: ["skills/selected"] }),
        )
        yield* f.admit("skills/selected")
        const plan = JSON.parse(new TextDecoder().decode(f.outputs.get("member-plan.json")!))
        expect(plan.source_projection).toMatchObject({
          version: 1,
          definition: { member: "skills/selected" },
          binding: { commit: revision, root: "skills/selected" },
        })
        expect(plan.files.map((file: { path: string }) => file.path)).toEqual(["SKILL.md"])
        const absent = yield* f.admit("skills/missing").pipe(Effect.result)
        expect(absent).toMatchObject({
          _tag: "Failure",
          failure: { code: "UPSTREAM_MEMBER_UNAVAILABLE" },
        })
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, routed))
    }).pipe(Effect.provide(Stdio.layerTest({})), Effect.provide(NodeServices.layer)),
  )
  expect(f.writes()).toHaveLength(0)
}, 30_000)

test("source admit preserves the registry acquisition path without a Git member scope", async () => {
  const definition = {
    ...input,
    adapter: {
      type: "registry" as const,
      base_url: "https://registry.example.test",
      owner: "fixture",
      slug: "selected",
      version: "1.0.0",
    },
    selection: { roots: ["."], include: [], exclude: [], mapping: {} },
  }
  const paths: string[] = []
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      paths.push(url.pathname)
      const payload = url.pathname.endsWith("/file")
        ? main
        : JSON.stringify(
            url.pathname.includes("/versions/")
              ? {
                  version: {
                    version: "1.0.0",
                    files: [
                      {
                        path: "SKILL.md",
                        size: main.length,
                        sha256: createHash("sha256").update(main).digest("hex"),
                      },
                    ],
                  },
                }
              : {
                  skill: { slug: "selected" },
                  owner: { handle: "fixture" },
                  latestVersion: { version: "1.0.0" },
                },
          )
      return HttpClientResponse.fromWeb(request, new Response(payload))
    }),
  )
  const f = configured(definition)
  await f.run(
    f
      .admit(".")
      .pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(Stdio.layerTest({})),
        Effect.provide(NodeServices.layer),
      ),
  )
  const plan = JSON.parse(new TextDecoder().decode(f.outputs.get("member-plan.json")!))
  expect(plan.source_projection).toMatchObject({
    version: 2,
    provider_revision: "1.0.0",
    definition: { member: "." },
  })
  expect(paths).toEqual([
    "/api/v1/skills/selected",
    "/api/v1/skills/selected/versions/1.0.0",
    "/api/v1/skills/selected/file",
  ])
  expect(f.writes()).toHaveLength(0)
})
