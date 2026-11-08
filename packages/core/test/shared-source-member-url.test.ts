import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { readSourceDefinition } from "../src/shared-source-definitions.ts"
import { prepareSharedSourceProjection } from "../src/shared-source-projection.ts"
import { prepareSourceRefresh, validateSourceRefresh } from "../src/shared-source-refresh.ts"
import { validateFixedGithubSource } from "../src/shared-github-source.ts"
import {
  fixture as projectionFixture,
  fixedProjection,
  ids,
  library as projectionLibrary,
} from "./shared-source-projection-fixture.ts"
import {
  sourceRefreshFixture,
  definition as refreshDefinition,
  library as refreshLibrary,
} from "./shared-source-refresh-fixture.ts"
import { id, rich, skillPage } from "./shared-snapshot-fixture.ts"

const cloneUrl = "https://github.com/example/initial-source.git"
const canonicalUrl = "https://github.com/example/initial-source"

test("Git clone URL admission keeps the original Source and exact fixed byte identities", async () => {
  const control = projectionFixture(),
    canonical = fixedProjection(await control.prepare()).binding
  const f = projectionFixture()
  f.source.properties[ids.Location!] = rich(ids.Location!, cloneUrl)
  const definition = await f.run(readSourceDefinition(projectionLibrary, f.source.id))
  const acquired = {
    ...f.snapshot,
    provenance: { ...f.snapshot.provenance, git_url: cloneUrl },
  }
  const plan = await f.run(
    prepareSharedSourceProjection({
      library: projectionLibrary,
      definition,
      acquired,
      member: "skills/demo",
      skillId: "clone-url-admission",
    }),
  )
  const binding = fixedProjection(plan).binding
  expect(binding).toEqual(canonical)
  expect(binding.url).toBe(canonicalUrl)
  expect(binding.commit).toBe(acquired.revision)
  expect(binding.tree).toBe(acquired.members[0]!.git_manifest!.tree)
  expect(binding.files).toEqual(
    acquired.members[0]!.git_manifest!.files.map((file) => ({
      ...file,
      sha256: createHash("sha256")
        .update(
          acquired.members[0]!.portable.files.find((entry) => entry.path === file.path)!.bytes,
        )
        .digest("hex"),
    })),
  )
  expect(binding.files.find((file) => file.path === "scripts/run.js")?.mode).toBe("100755")
  expect((await f.run(readSourceDefinition(projectionLibrary, f.source.id))).adapter).toEqual({
    type: "git",
    url: cloneUrl,
    ref: acquired.revision,
  })
  expect(acquired.provenance.git_url).toBe(cloneUrl)
  expect(f.providerReads()).toBe(1)
  expect(f.writes()).toHaveLength(0)
  expect(f.pending()).toHaveLength(0)
  expect(() => validateFixedGithubSource({ ...binding, url: cloneUrl })).toThrow(
    "Stored GitHub descriptors require canonical URLs",
  )
})

test("Git clone URL refresh shares admission's canonical binding without changing the frozen Source", async () => {
  const control = projectionFixture(),
    canonical = fixedProjection(await control.prepare()).binding,
    acquired = {
      ...control.snapshot,
      provenance: { ...control.snapshot.provenance, git_url: cloneUrl },
    }
  const requests: string[] = []
  const httpClient = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(url.toString())
      const file = acquired.members[0]!.portable.files.find(
        (file) =>
          url.toString() ===
          `https://raw.githubusercontent.com/example/initial-source/${acquired.revision}/skills/demo/${file.path}`,
      )
      return HttpClientResponse.fromWeb(
        request,
        file === undefined
          ? new Response(null, { status: 404 })
          : new Response(file.bytes.slice(), {
              headers: { "content-length": String(file.bytes.length) },
            }),
      )
    }),
  )
  const f = await sourceRefreshFixture({
    httpClient,
    definition: {
      ...refreshDefinition,
      adapter: { type: "git", url: cloneUrl, ref: acquired.revision },
    },
  })
  f.replaceSnapshot(acquired)
  f.clearCalls()
  const definition = await f.run(readSourceDefinition(refreshLibrary, id(82)))
  const plan = await f.run(prepareSourceRefresh(refreshLibrary, id(82), skillPage, f.acquire))
  if (plan.version !== 4) throw new Error("Expected a fixed Git candidate")
  expect(plan.fixed_source).toEqual(canonical)
  expect(plan.provider_revision).toBe(acquired.revision)
  expect(
    plan.source_files.map(({ path, sha256, bytes, mode }) => ({ path, sha256, bytes, mode })),
  ).toEqual(
    acquired.members[0]!.portable.files.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
      bytes: file.bytes.length,
      mode: file.mode,
    })),
  )
  expect(await f.run(readSourceDefinition(refreshLibrary, id(82)))).toEqual(definition)
  expect((await f.run(validateSourceRefresh(refreshLibrary, plan))).kind).toBe("git")
  expect(f.acquisitions()).toBe(1)
  expect(requests).toEqual([
    `https://raw.githubusercontent.com/example/initial-source/${acquired.revision}/skills/demo/SKILL.md`,
  ])
  expect(f.writeCount()).toBe(0)
})
