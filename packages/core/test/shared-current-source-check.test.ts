import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Notion } from "../src/notion.ts"
import { trashPath } from "../src/local-locks.ts"
import { makeRequestBudget, RequestBudget } from "../src/request-budget.ts"
import { currentOwnedResourceCreateRequest } from "../src/shared-current-records.ts"
import { prepareCurrentSharedResource } from "../src/shared-current-resource.ts"
import {
  checkCurrentSource,
  currentSourceConfigurationFingerprint,
  makeCurrentSourceCheckBatch,
  observeCurrentSourceRef,
} from "../src/shared-current-source-check.ts"
import {
  prepareCurrentSource,
  validateCurrentSourceContributions,
  validateCurrentSourceInput,
  type CurrentSourceDeclaration,
} from "../src/shared-current-source-input.ts"
import type { CurrentSourceManagement } from "../src/shared-current-source-management.ts"
import type { CurrentSharedSourcePlanContent } from "../src/shared-current-source.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { currentWriteFixture, id, library } from "./shared-current-write-fixture.ts"

const url = "https://github.com/source-check-fixture/skills"
const otherUrl = "https://github.com/source-check-fixture/other"
const sourcePath = "skills/alpha/SKILL.md"
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const declaration: CurrentSourceDeclaration = {
  version: 1,
  definition: {
    version: 1,
    source_id: "source-check-fixture",
    name: "Source check fixture",
    description: "Read-only upstream observation",
    enabled: true,
    policy: "manual",
    adapter: { type: "git", url, ref: "main" },
    selection: { roots: ["skills"], include: [], exclude: [], mapping: {} },
    options: {},
  },
  contributions: [
    { member_key: "skills/alpha", skill_id: "alpha", mount_path: "", mapping: {}, exclude: [] },
  ],
}

function storedDeclaration(input: unknown): CurrentSourceManagement["declaration"] {
  const validated = validateCurrentSourceInput(input)
  return {
    ...validated,
    contributions: validateCurrentSourceContributions(validated.contributions),
  }
}

function git(directory: string, args: readonly string[]) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Source Check Fixture",
      GIT_AUTHOR_EMAIL: "source-check@example.test",
      GIT_COMMITTER_NAME: "Source Check Fixture",
      GIT_COMMITTER_EMAIL: "source-check@example.test",
    },
  }).trim()
}

async function commit(directory: string, body = "# First upstream version\n") {
  await mkdir(join(directory, "skills/alpha"), { recursive: true })
  await writeFile(
    join(directory, sourcePath),
    `---\nname: alpha\ndescription: Current source fixture\n---\n\n${body}`,
  )
  git(directory, ["add", "."])
  git(directory, ["commit", "--no-gpg-sign", "-m", "source check fixture"])
  return git(directory, ["rev-parse", "HEAD"])
}

async function fixture<A>(
  run: (input: {
    readonly directory: string
    readonly first: string
    readonly current: CurrentSourceManagement
    readonly f: ReturnType<typeof currentWriteFixture>
    readonly commands: string[][]
  }) => Promise<A>,
) {
  const root = await mkdtemp(join(tmpdir(), "ntn-source-check-test-"))
  try {
    const directory = join(root, "upstream")
    await mkdir(directory)
    git(directory, ["init", "-b", "main"])
    const first = await commit(directory)
    const bytes = await readFile(join(directory, sourcePath))
    const content: CurrentSharedSourcePlanContent = {
      version: 1,
      plan: {
        version: 1,
        kind: "composition",
        mounts: [],
        base: {
          kind: "git",
          source: {
            url,
            commit: first,
            tree: git(directory, ["rev-parse", "HEAD^{tree}"]),
            root: "",
            files: [
              {
                path: sourcePath,
                source_path: sourcePath,
                git_oid: git(directory, ["rev-parse", `HEAD:${sourcePath}`]),
                bytes: bytes.byteLength,
                mode: "100644",
                sha256: hash(bytes),
              },
            ],
          },
        },
      },
    }
    const current: CurrentSourceManagement = {
      page_id: id(20),
      declaration: storedDeclaration(declaration),
      content,
      revision: hash(canonicalSharedJson(content.plan)),
      state: { state: "ready" },
    }
    return await run({ directory, first, current, f: currentWriteFixture(root), commands: [] })
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}

/** Keep the real bounded subprocess and Git protocol. Only the fixture's declared
 * HTTPS repositories are routed to the test-owned local repository. */
function routed<A, E, R>(
  input: { readonly directory: string; readonly commands: string[][] },
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") return real.spawn(command)
      input.commands.push([...command.args])
      return real.spawn(
        ChildProcess.make(
          command.command,
          command.args.map((arg) =>
            [url, `${url}.git`, otherUrl, `${otherUrl}.git`].includes(arg) ? input.directory : arg,
          ),
          command.options,
        ),
      )
    })
    return yield* effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    )
  })
}

test("real Git observations read branch, HEAD and peeled tag identities without tree or blob acquisition", async () => {
  await fixture(async (input) => {
    git(input.directory, ["tag", "light"])
    git(input.directory, ["tag", "-a", "--no-sign", "annotated", "-m", "annotated fixture"])
    const observations = await input.f.run(
      routed(
        input,
        Effect.forEach(["main", "HEAD", "refs/tags/light", "refs/tags/annotated"], (ref) =>
          observeCurrentSourceRef({ url, ref, scope: "fixture" }),
        ),
      ),
    )
    expect(observations.map((value) => value.resolved_commit)).toEqual(Array(4).fill(input.first))
    expect(observations.map((value) => value.resolved_ref)).toEqual([
      "refs/heads/main",
      "refs/heads/main",
      "refs/tags/light",
      "refs/tags/annotated",
    ])
    expect(observations.every((value) => Number.isSafeInteger(value.observed_at))).toBe(true)
    expect(input.commands).toHaveLength(4)
    expect(input.commands.every((args) => args.includes("ls-remote"))).toBe(true)
    expect(input.commands.some((args) => args.includes("fetch") || args.includes("cat-file"))).toBe(
      false,
    )
    expect(input.f.calls).toEqual([])
  })
})

test("short branch-tag collisions require an exact namespace and missing refs cannot select another head", async () => {
  await fixture(async (input) => {
    git(input.directory, ["tag", "release"])
    const second = await commit(input.directory, "# Another upstream version\n")
    git(input.directory, ["branch", "release"])
    const observe = (ref: string) =>
      input.f.run(routed(input, observeCurrentSourceRef({ url, ref, scope: "fixture" })))
    await expect(observe("release")).rejects.toMatchObject({ code: "CURRENT_SOURCE_REF_AMBIGUOUS" })
    expect((await observe("refs/heads/release")).resolved_commit).toBe(second)
    expect((await observe("refs/tags/release")).resolved_commit).toBe(input.first)
    await expect(observe("refs/heads/missing")).rejects.toMatchObject({
      code: "CURRENT_SOURCE_REF_MISSING",
    })
  })
})

test("one batch coalesces equal in-flight and completed refs while preserving access, origin and budget scopes", async () => {
  await fixture(async (input) => {
    await input.f.run(
      routed(
        input,
        Effect.gen(function* () {
          const batch = yield* makeCurrentSourceCheckBatch()
          const request = { url, ref: "main", scope: "access-a", batch }
          const equal = yield* Effect.all(
            [
              observeCurrentSourceRef(request),
              observeCurrentSourceRef({ ...request, url: `${url}.git` }),
            ],
            { concurrency: "unbounded" },
          )
          expect(equal[0]).toEqual(equal[1])
          expect(yield* observeCurrentSourceRef(request)).toEqual(equal[0])
          expect(input.commands).toHaveLength(1)
          yield* observeCurrentSourceRef({ ...request, scope: "access-b" })
          yield* observeCurrentSourceRef({ ...request, url: otherUrl })
          yield* observeCurrentSourceRef({ ...request, ref: "refs/heads/main" })
          expect(input.commands).toHaveLength(4)
          for (const identity of ["budget-a", "budget-b"]) {
            const budget = yield* makeRequestBudget(identity, {
              requests: 5,
              bytes: 10000,
              duration_ms: 10000,
            })
            const observe = observeCurrentSourceRef(request).pipe(
              Effect.provideService(RequestBudget, budget),
            )
            yield* observe
            yield* observe
          }
          expect(input.commands).toHaveLength(6)
          const next = yield* makeCurrentSourceCheckBatch()
          yield* observeCurrentSourceRef({ ...request, batch: next })
          expect(input.commands).toHaveLength(7)
        }),
      ),
    )
    expect(input.f.calls).toEqual([])
  })
})

test("a failed observation is not retained and the next invocation observes a newer head", async () => {
  await fixture(async (input) => {
    await input.f.run(
      routed(
        input,
        Effect.gen(function* () {
          const batch = yield* makeCurrentSourceCheckBatch()
          const request = { url, ref: "future", scope: "fixture", batch }
          expect((yield* observeCurrentSourceRef(request).pipe(Effect.flip)).code).toBe(
            "CURRENT_SOURCE_REF_MISSING",
          )
          git(input.directory, ["branch", "future"])
          expect((yield* observeCurrentSourceRef(request)).resolved_commit).toBe(input.first)
          expect(input.commands).toHaveLength(2)
        }),
      ),
    )
    const second = await commit(input.directory, "# Next scheduled upstream version\n")
    const next = await input.f.run(
      routed(
        input,
        Effect.gen(function* () {
          const batch = yield* makeCurrentSourceCheckBatch()
          return yield* observeCurrentSourceRef({ url, ref: "main", scope: "fixture", batch })
        }),
      ),
    )
    expect(next.resolved_commit).toBe(second)
    expect(next.resolved_commit).not.toBe(input.first)
  })
})

test("credentials, local origins, ref patterns and revision expressions are rejected before Git starts", async () => {
  await fixture(async (input) => {
    const requests = [
      { url: "https://user:password@example.test/repository", ref: "main" },
      { url: input.directory, ref: "main" },
      ...[
        "*",
        "main~1",
        "main^{commit}",
        "refs/heads/../main",
        "refs/remotes/origin/main",
        input.first,
      ].map((ref) => ({ url, ref })),
    ]
    for (const request of requests)
      await expect(
        input.f.run(routed(input, observeCurrentSourceRef({ ...request, scope: "fixture" }))),
      ).rejects.toThrow()
    expect(input.commands).toEqual([])
  })
})

test("an exhausted invocation cannot start an upstream ref observation", async () => {
  await fixture(async (input) => {
    await input.f.run(
      routed(
        input,
        Effect.gen(function* () {
          const budget = yield* makeRequestBudget("spent", {
            requests: 1,
            bytes: 1000,
            duration_ms: 10000,
          })
          yield* budget.admit(0)
          const error = yield* observeCurrentSourceRef({ url, ref: "main", scope: "fixture" }).pipe(
            Effect.provideService(RequestBudget, budget),
            Effect.flip,
          )
          expect(error.code).toBe("REQUEST_BUDGET_EXHAUSTED")
        }),
      ),
    )
    expect(input.commands).toEqual([])
  })
})

test("configuration fingerprints match preparation and include complete selection, options and contributions", async () => {
  await fixture(async (input) => {
    const prepared = await input.f.run(routed(input, prepareCurrentSource(declaration)))
    const fingerprint = await input.f.run(
      currentSourceConfigurationFingerprint(prepared.declaration),
    )
    expect(fingerprint).toBe(prepared.configuration_sha256)
    const changes: CurrentSourceDeclaration[] = [
      {
        ...declaration,
        definition: {
          ...declaration.definition,
          adapter: { type: "git", url, ref: "refs/heads/main" },
        },
      },
      {
        ...declaration,
        definition: {
          ...declaration.definition,
          selection: { ...declaration.definition.selection, include: ["skills/alpha"] },
        },
      },
      {
        ...declaration,
        definition: {
          ...declaration.definition,
          selection: { ...declaration.definition.selection, roots: ["skills/alpha"] },
        },
      },
      {
        ...declaration,
        definition: {
          ...declaration.definition,
          selection: {
            ...declaration.definition.selection,
            mapping: { "skills/alpha": "renamed" },
          },
        },
      },
      {
        ...declaration,
        definition: { ...declaration.definition, options: { accepted_ref: input.first } },
      },
      {
        ...declaration,
        definition: { ...declaration.definition, options: { require_all_included: true } },
      },
      ...[
        { skill_id: "renamed-target" },
        { mount_path: "vendor" },
        { mapping: { "SKILL.md": "mapped.md" } },
        { exclude: ["notes.md"] },
      ].map((change) => ({
        ...declaration,
        contributions: declaration.contributions.map((item) => ({ ...item, ...change })),
      })),
    ]
    for (const change of changes)
      expect(await input.f.run(currentSourceConfigurationFingerprint(change))).not.toBe(fingerprint)
    expect(input.f.mutations()).toEqual([])
  })
})

test("real Git preparation honors required members at the configured tag and refuses their removal on a branch", async () => {
  await fixture(async (input) => {
    git(input.directory, ["tag", "-a", "--no-sign", "required", "-m", "required member fixture"])
    const strict: CurrentSourceDeclaration = {
      ...declaration,
      definition: {
        ...declaration.definition,
        adapter: { type: "git", url, ref: "refs/tags/required" },
        selection: { ...declaration.definition.selection, include: ["skills/alpha"] },
        options: { require_all_included: true },
      },
    }
    const observed = await input.f.run(
      routed(
        input,
        checkCurrentSource(library, {
          current: { ...input.current, declaration: storedDeclaration(strict) },
          scope: "fixture",
        }),
      ),
    )
    expect(observed).toMatchObject({
      status: "upstream_unchanged",
      observation: { resolved_ref: "refs/tags/required", resolved_commit: input.first },
    })
    const first = await input.f.run(routed(input, prepareCurrentSource(strict)))
    expect(first.resolved_commit).toBe(input.first)
    expect(first.targets).toHaveLength(1)
    expect(first.declaration.definition.options).toEqual({ require_all_included: true })

    // Commit an empty upstream tree without deleting the retained fixture file.
    git(input.directory, ["update-index", "--force-remove", sourcePath])
    git(input.directory, ["commit", "--no-gpg-sign", "-m", "remove required member from upstream"])
    const removed = git(input.directory, ["rev-parse", "HEAD"])
    expect(removed).not.toBe(input.first)
    expect(await readFile(join(input.directory, sourcePath), "utf8")).toContain("name: alpha")
    const tagged = await input.f.run(routed(input, prepareCurrentSource(strict)))
    expect(tagged.resolved_commit).toBe(input.first)
    const branch: CurrentSourceDeclaration = {
      ...strict,
      definition: { ...strict.definition, adapter: { type: "git", url, ref: "main" } },
    }
    await expect(input.f.run(routed(input, prepareCurrentSource(branch)))).rejects.toThrow(
      "An explicitly included source member is missing SKILL.md",
    )
    const optional: CurrentSourceDeclaration = {
      ...branch,
      definition: { ...branch.definition, options: { require_all_included: false } },
    }
    const empty = await input.f.run(routed(input, prepareCurrentSource(optional)))
    expect(empty.resolved_commit).toBe(removed)
    expect(empty.targets).toEqual([])
    expect(input.f.calls).toEqual([])
  })
})

test("an equal advertised SHA reports only upstream_unchanged, without requiring or certifying any targets", async () => {
  await fixture(async (input) => {
    expect(input.f.table("skills")).toEqual([])
    const observed = await input.f.run(
      routed(input, checkCurrentSource(library, { current: input.current, scope: "fixture" })),
    )
    expect(observed).toMatchObject({
      status: "upstream_unchanged",
      selected_commit: input.first,
      observation: { resolved_commit: input.first },
    })
    expect(observed.configuration_sha256).toBe(observed.current_configuration_sha256)
    expect(input.commands).toHaveLength(1)
    expect(input.f.calls).toEqual([])
  })
})

test("same-commit configuration and selected-origin changes cannot be reported as upstream_unchanged", async () => {
  await fixture(async (input) => {
    const changed = {
      ...declaration,
      contributions: declaration.contributions.map((item) => ({ ...item, exclude: ["notes.md"] })),
    }
    const config = await input.f.run(
      routed(
        input,
        checkCurrentSource(library, {
          current: input.current,
          declaration: changed,
          scope: "fixture",
        }),
      ),
    )
    expect(config).toMatchObject({
      status: "update_available",
      reason: "configuration_changed",
      selected_commit: input.first,
    })
    if (!("plan" in input.current.content) || input.current.content.plan.base?.kind !== "git")
      throw new Error("Expected fixture Git plan")
    const content: CurrentSharedSourcePlanContent = {
      version: 1,
      plan: {
        ...input.current.content.plan,
        base: { kind: "git", source: { ...input.current.content.plan.base.source, url: otherUrl } },
      },
    }
    const origin = await input.f.run(
      routed(
        input,
        checkCurrentSource(library, {
          current: { ...input.current, content, revision: hash(canonicalSharedJson(content.plan)) },
          scope: "fixture",
        }),
      ),
    )
    expect(origin).toMatchObject({
      status: "update_available",
      reason: "origin_changed",
      selected_commit: input.first,
    })
    expect(input.f.calls).toEqual([])
  })
})

test("a changed branch returns a frozen candidate while preserving the selected manifest and declaration", async () => {
  await fixture(async (input) => {
    const before = structuredClone(input.current)
    const second = await commit(input.directory, "# Candidate upstream version\n")
    const result = await input.f.run(
      routed(input, checkCurrentSource(library, { current: input.current, scope: "fixture" })),
    )
    expect(result).toMatchObject({
      status: "update_available",
      reason: "upstream_changed",
      selected_commit: input.first,
      observation: { resolved_commit: second },
    })
    expect(input.current).toEqual(before)
    expect(input.f.calls).toEqual([])
  })
})

test("disabled, pinned and fixed-ref declarations explicitly skip moving-ref checks without remote reads", async () => {
  await fixture(async (input) => {
    const cases: ReadonlyArray<{
      readonly reason: string
      readonly declaration: CurrentSourceDeclaration
    }> = [
      {
        reason: "disabled",
        declaration: { ...declaration, definition: { ...declaration.definition, enabled: false } },
      },
      {
        reason: "pinned",
        declaration: {
          ...declaration,
          definition: {
            ...declaration.definition,
            policy: "pinned",
            adapter: { type: "git", url, ref: input.first },
          },
        },
      },
      {
        reason: "fixed_ref",
        declaration: {
          ...declaration,
          definition: { ...declaration.definition, options: { accepted_ref: input.first } },
        },
      },
      {
        reason: "fixed_ref",
        declaration: {
          ...declaration,
          definition: {
            ...declaration.definition,
            adapter: { type: "git", url, ref: input.first },
          },
        },
      },
    ]
    for (const item of cases) {
      const result = await input.f.run(
        routed(
          input,
          checkCurrentSource(library, {
            current: { ...input.current, declaration: storedDeclaration(item.declaration) },
            scope: "fixture",
          }),
        ),
      )
      expect(result).toMatchObject({ status: "skipped", reason: item.reason })
    }
    expect(input.commands).toEqual([])
    expect(input.f.calls).toEqual([])
  })
})

test("a pending Source or mismatched selected manifest fails before any Git observation", async () => {
  await fixture(async (input) => {
    await expect(
      input.f.run(
        routed(
          input,
          checkCurrentSource(library, {
            current: {
              ...input.current,
              state: { state: "applying", operation_id: "source-in-progress" },
            },
            scope: "fixture",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_SOURCE_CHECK_PENDING" })
    await expect(
      input.f.run(
        routed(
          input,
          checkCurrentSource(library, {
            current: { ...input.current, revision: "f".repeat(64) },
            scope: "fixture",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "SHARED_SOURCE_CONFLICT" })
    expect(input.commands).toEqual([])
    expect(input.f.calls).toEqual([])
  })
})

test("resource-backed selected plans use their exact owner and hash without acquiring Git content", async () => {
  await fixture(async (input) => {
    if (!("plan" in input.current.content)) throw new Error("Expected inline fixture plan")
    const bytes = new TextEncoder().encode(canonicalSharedJson(input.current.content.plan))
    const resource = await input.f.run(prepareCurrentSharedResource(bytes, "100644"))
    const request = await input.f.run(
      currentOwnedResourceCreateRequest(library, {
        owner: { kind: "source", page_id: input.current.page_id },
        objectId: resource.content.object_id,
        payload: resource.manifest,
      }),
    )
    await input.f.run(
      Effect.flatMap(Notion, (api) => api.request(request.path, request.body, request.options)),
    )
    input.f.clearCalls()
    const result = await input.f.run(
      routed(
        input,
        checkCurrentSource(library, {
          current: { ...input.current, content: { version: 1, resource: resource.content } },
          scope: "fixture",
        }),
      ),
    )
    expect(result).toMatchObject({ status: "upstream_unchanged", selected_commit: input.first })
    expect(input.f.calls.length).toBeGreaterThan(0)
    expect(input.f.mutations()).toEqual([])
    expect(input.f.downloads).toEqual([])
    expect(input.commands).toHaveLength(1)
    await expect(
      input.f.run(
        routed(
          input,
          checkCurrentSource(library, {
            current: {
              ...input.current,
              page_id: id(21),
              content: { version: 1, resource: resource.content },
            },
            scope: "fixture",
          }),
        ),
      ),
    ).rejects.toThrow()
    expect(input.commands).toHaveLength(1)
  })
})
