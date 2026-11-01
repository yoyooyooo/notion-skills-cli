import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { property, SkillsError } from "../src/model.ts"
import { registerSourceBinding } from "../src/shared-source-binding.ts"
import {
  configureSharedHttpLocations,
  configureSharedHttpOrigins,
} from "../src/shared-source-config.ts"
import { registerSourcePlanBinding } from "../src/shared-source-plan-binding.ts"
import { reconcileSharedSourceRegistration } from "../src/shared-source-registration-reconcile.ts"
import {
  resolveSelectedSharedSource,
  resolveSelectedSharedSourceReference,
} from "../src/shared-selected-source.ts"
import type { SharedSourcePlan, SharedSourcePlanOptions } from "../src/shared-source-plan.ts"
import {
  library,
  skillPage,
  sharedSnapshotFixture,
  digest,
  encode,
} from "./shared-snapshot-fixture.ts"
import { sourceRegistryFixture } from "./shared-source-registration-fixture.ts"

const origin = "https://resources.example.com"
const binary = new Uint8Array([0, 255, 13, 10, 128, 0])
const gitOid = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
const httpPlan = (path: string, bytes: Uint8Array, url = `${origin}/fixed`): SharedSourcePlan => ({
  version: 1,
  kind: "composition",
  base: {
    kind: "http",
    manifest: { version: 1, files: [{ path, sha256: digest(bytes), bytes: bytes.byteLength }] },
    locations: [{ sha256: digest(bytes), url }],
  },
  mounts: [],
})
function fixture() {
  const requests: string[] = [],
    bodies = new Map<string, Uint8Array>()
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      requests.push(url.toString())
      const bytes = bodies.get(url.toString())
      return HttpClientResponse.fromWeb(
        request,
        bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(bytes.slice(), {
              headers: { "content-length": String(bytes.byteLength) },
            }),
      )
    }),
  )
  const f = sharedSnapshotFixture({ httpClient: client })
  return { f, bodies, requests }
}
function failure(
  result: { _tag: "Failure"; failure: unknown } | { _tag: "Success"; success: unknown },
): SkillsError {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected a typed source failure")
  return result.failure
}

test("metadata-only selected source resolves exact effective paths with no provider, body, or object access", async () => {
  const p = fixture(),
    plan = httpPlan("assets/icon.bin", binary)
  const registered = await p.f.run(
    registerSourcePlanBinding(library, { skillPageId: skillPage, mode: "create", plan }),
  )
  p.f.clearCalls()
  const result = await p.f.run(
    resolveSelectedSharedSourceReference(library, {
      skillPageId: skillPage,
      sourceId: registered.binding.source_plan_id,
    }),
  )
  expect(result).toMatchObject({
    kind: "composition",
    source_id: registered.binding.source_plan_id,
    revision: registered.binding.source_plan_id,
    paths: ["assets/icon.bin"],
  })
  expect(p.f.calls).toHaveLength(1)
  expect(p.requests).toHaveLength(0)
  expect(p.f.readBodyCount()).toBe(0)
  expect(p.f.objects.size).toBe(0)
})

test("composition uses configured HTTP origins and a runtime address override without changing its fixed identity", async () => {
  const p = fixture(),
    plan = httpPlan("assets/icon.bin", binary),
    url = `${origin}/relocated?signature=private-runtime-value`
  const registered = await p.f.run(
    registerSourcePlanBinding(library, { skillPageId: skillPage, mode: "create", plan }),
  )
  await p.f.run(configureSharedHttpOrigins([origin]))
  if (plan.base?.kind !== "http") throw new Error("Expected HTTP fixture")
  await p.f.run(
    configureSharedHttpLocations({
      manifest: plan.base.manifest,
      locations: [{ sha256: digest(binary), url }],
    }),
  )
  p.bodies.set(url, binary)
  const result = await p.f.run(
    resolveSelectedSharedSource(library, skillPage, registered.binding.source_plan_id),
  )
  expect(result).toMatchObject({
    source_id: registered.binding.source_plan_id,
    revision: registered.binding.source_plan_id,
    paths: ["assets/icon.bin"],
    local_paths: [],
  })
  expect(result.files[0]?.bytes).toEqual(binary)
  expect(p.requests).toEqual([url])
  const warm = await p.f.run(
    resolveSelectedSharedSource(library, skillPage, registered.binding.source_plan_id),
  )
  expect(warm).toEqual(result)
  expect(p.requests).toEqual([url])
  expect(
    [...p.f.records.values()].some((record) =>
      JSON.stringify(record).includes("private-runtime-value"),
    ),
  ).toBe(false)
  expect(p.f.readBodyCount()).toBe(0)
})

test("complete Git base, HTTP mount, and scoped local mount retain exact bytes and sticky local paths", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ntn-selected-source-"))
  {
    const p = fixture(),
      script = encode("#!/bin/sh\r\nexit 91\r\n"),
      local = encode("private workspace content\n")
    writeFileSync(join(root, "private.txt"), local)
    const commit = "1".repeat(40)
    const plan: SharedSourcePlan = {
      version: 1,
      kind: "composition",
      base: {
        kind: "git",
        source: {
          url: "https://github.com/example/resources",
          commit,
          tree: "2".repeat(40),
          root: "scope",
          files: [
            {
              path: "scripts/check.sh",
              source_path: "scope/scripts/check.sh",
              git_oid: gitOid(script),
              bytes: script.byteLength,
            },
          ],
        },
      },
      mounts: [
        {
          mount_path: "assets",
          resource: {
            kind: "http",
            manifest: {
              version: 1,
              files: [{ path: "icon.bin", sha256: digest(binary), bytes: binary.byteLength }],
            },
            locations: [{ sha256: digest(binary), url: `${origin}/binary` }],
          },
        },
        {
          mount_path: "private",
          resource: {
            kind: "local",
            binding_key: "workspace-files",
            machine_scope: "machine-a",
            workspace_scope: "workspace-a",
            manifest: {
              version: 1,
              files: [{ path: "private.txt", sha256: digest(local), bytes: local.byteLength }],
            },
          },
        },
      ],
    }
    const options: SharedSourcePlanOptions = {
      http: { allowedOrigins: [origin] },
      local: {
        scope: { machine_scope: "machine-a", workspace_scope: "workspace-a" },
        bindings: [
          {
            machine_scope: "machine-a",
            workspace_scope: "workspace-a",
            binding_key: "workspace-files",
            absolute_root: root,
          },
        ],
      },
    }
    p.bodies.set(
      `https://raw.githubusercontent.com/example/resources/${commit}/scope/scripts/check.sh`,
      script,
    )
    p.bodies.set(`${origin}/binary`, binary)
    const registered = await p.f.run(
      registerSourcePlanBinding(library, { skillPageId: skillPage, mode: "create", plan }),
    )
    const selected = await p.f.run(
      resolveSelectedSharedSource(library, skillPage, registered.binding.source_plan_id, options),
    )
    expect(selected.paths).toEqual(["assets/icon.bin", "private/private.txt", "scripts/check.sh"])
    expect(selected.local_paths).toEqual(["private/private.txt"])
    expect(selected.files.find((file) => file.path === "assets/icon.bin")?.bytes).toEqual(binary)
    expect(selected.files.find((file) => file.path === "scripts/check.sh")?.bytes).toEqual(script)
    expect(selected.files.find((file) => file.path === "private/private.txt")?.bytes).toEqual(local)
    expect(p.requests).toHaveLength(2)
    await p.f.run(
      resolveSelectedSharedSource(library, skillPage, registered.binding.source_plan_id, options),
    )
    expect(p.requests).toHaveLength(2)
    expect(p.f.json.has(`content-restrictions/local/${digest(local)}.json`)).toBe(true)
    const wrong = await p.f.run(
      resolveSelectedSharedSource(library, skillPage, registered.binding.source_plan_id, {
        ...options,
        local: {
          scope: { machine_scope: "different", workspace_scope: "workspace-a" },
          bindings: options.local?.bindings ?? [],
        },
      }).pipe(Effect.result),
    )
    expect(failure(wrong).code).toBe("LOCAL_RESOURCE_SCOPE_MISMATCH")
    const unbound = await p.f.run(
      resolveSelectedSharedSource(library, skillPage, registered.binding.source_plan_id).pipe(
        Effect.result,
      ),
    )
    expect(failure(unbound).code).toBe("LOCAL_RESOURCE_BINDING_MISSING")
    expect(p.requests).toHaveLength(2)
    expect(JSON.stringify([...p.f.records.values()])).not.toContain(root)
  }
})

test("a legacy Git source cannot drop a sticky local restriction on an already verified object", async () => {
  const p = fixture(),
    commit = "3".repeat(40),
    hash = digest(binary)
  const source = {
    url: "https://github.com/example/resources",
    commit,
    tree: "2".repeat(40),
    root: "",
    files: [
      {
        path: "private.bin",
        source_path: "private.bin",
        git_oid: gitOid(binary),
        bytes: binary.byteLength,
      },
    ],
  }
  const registered = await p.f.run(
    registerSourceBinding(library, { skillPageId: skillPage, mode: "create", fixedSource: source }),
  )
  p.bodies.set(`https://raw.githubusercontent.com/example/resources/${commit}/private.bin`, binary)
  p.f.json.set(`content-restrictions/local/${hash}.json`, {
    version: 1,
    sha256: hash,
    reason: "local_resource",
  })
  const selected = await p.f.run(
    resolveSelectedSharedSource(library, skillPage, registered.binding.source_id),
  )
  expect(selected.revision).toBe(commit)
  expect(selected.local_paths).toEqual(["private.bin"])
})

test("newly registered plans do not implicitly advance a selected source", async () => {
  const p = fixture(),
    first = httpPlan("file.bin", binary),
    newer = httpPlan("file.bin", encode("new bytes"), `${origin}/newer`)
  const a = await p.f.run(
    registerSourcePlanBinding(library, { skillPageId: skillPage, mode: "create", plan: first }),
  )
  const b = await p.f.run(
    registerSourcePlanBinding(library, { skillPageId: skillPage, mode: "create", plan: newer }),
  )
  p.bodies.set(`${origin}/fixed`, binary)
  const selected = await p.f.run(
    resolveSelectedSharedSource(library, skillPage, a.binding.source_plan_id, {
      http: { allowedOrigins: [origin] },
    }),
  )
  expect(selected.source_id).not.toBe(b.binding.source_plan_id)
  expect(selected.files[0]?.bytes).toEqual(binary)
  expect(p.requests).toEqual([`${origin}/fixed`])
})

test("missing IDs and aliases fail before any provider request or current-source fallback", async () => {
  const p = fixture()
  for (const sourceId of [
    `source-plan-${"0".repeat(64)}`,
    `source-${"0".repeat(64)}`,
    "latest",
    "",
    "source-plan-latest",
  ]) {
    const result = await p.f.run(
      resolveSelectedSharedSource(library, skillPage, sourceId).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
  }
  expect(p.requests).toHaveLength(0)
  expect(p.f.objects.size).toBe(0)
  expect(p.f.readBodyCount()).toBe(0)
})

test.each(["retained", "absent"] as const)(
  "reconciles the original frozen %s registration by ID without provider or manifest reread",
  async (unknownCreate) => {
    const f = sourceRegistryFixture(library, { unknownCreate }),
      plan = httpPlan("file.bin", binary)
    const initial = await f.run(
      registerSourcePlanBinding(library, { skillPageId: skillPage, mode: "create", plan }).pipe(
        Effect.result,
      ),
    )
    expect(initial._tag).toBe("Failure")
    const receipt = property([...f.local.records.values()][0])
    if (typeof receipt.source_id !== "string")
      throw new Error("Expected frozen original registration")
    const result = await f.run(
      reconcileSharedSourceRegistration(library, {
        skillPageId: skillPage,
        sourceId: receipt.source_id,
      }).pipe(Effect.result),
    )
    expect(result._tag).toBe(unknownCreate === "retained" ? "Success" : "Failure")
    expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(1)
  },
)
