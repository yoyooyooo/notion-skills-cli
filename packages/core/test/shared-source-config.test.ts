import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { property, SkillsError } from "../src/model.ts"
import {
  bindSharedLocalResource,
  clearSharedHttpLocations,
  configureSharedHttpLocations,
  configureSharedHttpOrigins,
  loadSharedSourceOptions,
  sharedSourceResourceConfiguration,
  unbindSharedLocalResource,
} from "../src/shared-source-config.ts"
import { Store } from "../src/store.ts"
import { registrationStore } from "./shared-source-registration-fixture.ts"

const hash = createHash("sha256").update("resource").digest("hex")
const manifest = { version: 1 as const, files: [{ path: "resource.txt", sha256: hash, bytes: 8 }] }
const origin = "https://resources.example.com"
function fixture() {
  const local = registrationStore()
  const store: Store["Service"] = {
    ...local.store,
    writeJson: (key, value) =>
      Effect.sync(() => {
        local.records.set(key, structuredClone(value))
      }),
  }
  const run = <A, E>(
    value: Effect.Effect<A, E, Store | Crypto.Crypto | FileSystem.FileSystem | Path.Path>,
  ) =>
    Effect.runPromise(
      value.pipe(Effect.provideService(Store, store), Effect.provide(NodeServices.layer)),
    )
  return { run, json: local.records }
}
async function withDirectory(action: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ntn-source-config-"))
  // Retain controlled temporary fixtures; repository policy forbids permanent deletion.
  await action(root)
}
function code(
  value: { _tag: "Failure"; failure: unknown } | { _tag: "Success"; success: unknown },
) {
  if (value._tag !== "Failure" || !(value.failure instanceof SkillsError))
    throw new Error("Expected a typed config failure")
  return value.failure.code
}

test("absent machine config permits only the default public origin, with no inferred local scope", async () => {
  const f = fixture()
  expect(await f.run(loadSharedSourceOptions())).toEqual({
    http: { allowedOrigins: ["https://raw.githubusercontent.com"], locationsByManifest: {} },
  })
  expect(
    code(await f.run(loadSharedSourceOptions({ localRequired: true }).pipe(Effect.result))),
  ).toBe("LOCAL_RESOURCE_BINDING_MISSING")
  expect(f.json.size).toBe(0)
})

test("explicit local registration uses the actual scoped workspace and never serializes roots in public output", async () =>
  withDirectory(async (root) => {
    const f = fixture(),
      nested = join(root, "nested")
    mkdirSync(nested)
    f.json.set("config.json", {
      sources: [],
      token: "fixture-secret",
      default_database: "keep-this-entry",
    })
    expect(
      await f.run(
        bindSharedLocalResource({
          bindingKey: "assets",
          machineScope: "machine-a",
          workspaceScope: "project-a",
          workspaceRoot: root,
          root,
        }),
      ),
    ).toEqual({
      machine_scope: "machine-a",
      workspace_scope: "project-a",
      binding_key: "assets",
      configured: true,
    })
    const options = await f.run(loadSharedSourceOptions({ localRequired: true, cwd: nested }))
    expect(options.local).toEqual({
      scope: { machine_scope: "machine-a", workspace_scope: "project-a" },
      bindings: [
        {
          machine_scope: "machine-a",
          workspace_scope: "project-a",
          binding_key: "assets",
          absolute_root: root,
        },
      ],
    })
    const output = JSON.stringify(await f.run(sharedSourceResourceConfiguration()))
    expect(output).not.toContain(root)
    expect(output).not.toContain("fixture-secret")
    expect(property(f.json.get("config.json"))).toMatchObject({
      token: "fixture-secret",
      default_database: "keep-this-entry",
    })
  }))

test("an unrelated workspace cannot borrow a same-named binding or alter the registered machine", async () =>
  withDirectory(async (root) => {
    const f = fixture(),
      other = join(root, "other"),
      workspace = join(root, "workspace")
    mkdirSync(other)
    mkdirSync(workspace)
    await f.run(
      bindSharedLocalResource({
        bindingKey: "assets",
        machineScope: "machine-a",
        workspaceScope: "project",
        workspaceRoot: workspace,
        root: workspace,
      }),
    )
    expect(
      code(
        await f.run(
          loadSharedSourceOptions({ localRequired: true, cwd: other }).pipe(Effect.result),
        ),
      ),
    ).toBe("LOCAL_RESOURCE_WORKSPACE_UNBOUND")
    expect(
      code(
        await f.run(
          bindSharedLocalResource({
            bindingKey: "assets",
            machineScope: "machine-b",
            workspaceScope: "project",
            workspaceRoot: workspace,
            root: workspace,
          }).pipe(Effect.result),
        ),
      ),
    ).toBe("LOCAL_RESOURCE_SCOPE_MISMATCH")
  }))

test("nested explicitly configured workspaces select the most specific boundary", async () =>
  withDirectory(async (root) => {
    const f = fixture(),
      nested = join(root, "inner")
    mkdirSync(nested)
    await f.run(
      bindSharedLocalResource({
        bindingKey: "assets",
        workspaceScope: "outer",
        workspaceRoot: root,
        root,
      }),
    )
    await f.run(
      bindSharedLocalResource({
        bindingKey: "assets",
        workspaceScope: "inner",
        workspaceRoot: nested,
        root: nested,
      }),
    )
    expect(
      (await f.run(loadSharedSourceOptions({ localRequired: true, cwd: nested }))).local?.scope
        .workspace_scope,
    ).toBe("inner")
    expect(
      (await f.run(loadSharedSourceOptions({ localRequired: true, cwd: root }))).local?.scope
        .workspace_scope,
    ).toBe("outer")
  }))

test("registration resolves an explicitly supplied directory symlink but rejects a file root", async () =>
  withDirectory(async (root) => {
    const f = fixture(),
      alias = join(root, "alias"),
      real = join(root, "real"),
      file = join(root, "file")
    mkdirSync(real)
    symlinkSync(real, alias)
    writeFileSync(file, "bytes")
    await f.run(
      bindSharedLocalResource({
        bindingKey: "assets",
        workspaceScope: "project",
        workspaceRoot: alias,
        root: alias,
      }),
    )
    expect(
      (await f.run(loadSharedSourceOptions({ localRequired: true, cwd: real }))).local?.bindings[0]
        ?.absolute_root,
    ).toBe(real)
    expect(
      code(
        await f.run(
          bindSharedLocalResource({
            bindingKey: "file",
            workspaceScope: "project",
            workspaceRoot: real,
            root: file,
          }).pipe(Effect.result),
        ),
      ),
    ).toBe("SOURCE_RESOURCE_ROOT_UNAVAILABLE")
  }))

test("local unbind removes only its exact key and keeps content/archive restrictions independent", async () =>
  withDirectory(async (root) => {
    const f = fixture()
    await f.run(
      bindSharedLocalResource({
        bindingKey: "assets",
        workspaceScope: "project",
        workspaceRoot: root,
        root,
      }),
    )
    f.json.set(`content-restrictions/local/${hash}.json`, {
      version: 1,
      sha256: hash,
      reason: "local_resource",
    })
    await f.run(unbindSharedLocalResource({ workspaceScope: "project", bindingKey: "assets" }))
    expect(
      (await f.run(loadSharedSourceOptions({ localRequired: true, cwd: root }))).local?.bindings,
    ).toEqual([])
    expect(f.json.has(`content-restrictions/local/${hash}.json`)).toBe(true)
  }))

test("HTTP runtime addresses require explicit origin authorization and are redacted from config output", async () => {
  const f = fixture(),
    url = `${origin}/fixed/resource?access=machine-secret`
  expect(
    code(
      await f.run(
        configureSharedHttpLocations({ manifest, locations: [{ sha256: hash, url }] }).pipe(
          Effect.result,
        ),
      ),
    ),
  ).toBe("HTTP_RESOURCE_ORIGIN_NOT_ALLOWED")
  expect(f.json.size).toBe(0)
  await f.run(configureSharedHttpOrigins([origin]))
  const saved = await f.run(
    configureSharedHttpLocations({ manifest, locations: [{ sha256: hash, url }] }),
  )
  expect(saved.manifest_id).toMatch(/^files-[a-f0-9]{64}$/)
  const options = await f.run(loadSharedSourceOptions())
  expect(options.http.locationsByManifest?.[saved.manifest_id]).toEqual([{ sha256: hash, url }])
  const summary = JSON.stringify(await f.run(sharedSourceResourceConfiguration()))
  expect(summary).not.toContain("machine-secret")
  expect(summary).not.toContain("/fixed/resource")
  await f.run(clearSharedHttpLocations(saved.manifest_id))
  expect((await f.run(loadSharedSourceOptions())).http.locationsByManifest).toEqual({})
})

test.each([
  "http://resources.example.com",
  "https://127.0.0.1",
  "https://localhost",
  "https://a.internal",
  "https://user:pass@resources.example.com",
  "https://resources.example.com:8443",
  "https://resources.example.com/path",
])("rejects unauthorized origin syntax %s without a config write", async (origin) => {
  const f = fixture()
  await expect(f.run(configureSharedHttpOrigins([origin]))).rejects.toThrow()
  expect(f.json.size).toBe(0)
})

test("revoking all origins removes overrides without clearing fixed objects or sticky restrictions", async () => {
  const f = fixture()
  await f.run(configureSharedHttpOrigins([origin]))
  await f.run(
    configureSharedHttpLocations({
      manifest,
      locations: [{ sha256: hash, url: `${origin}/fixed` }],
    }),
  )
  f.json.set(`content-restrictions/local/${hash}.json`, {
    version: 1,
    sha256: hash,
    reason: "local_resource",
  })
  await f.run(configureSharedHttpOrigins([]))
  expect((await f.run(loadSharedSourceOptions())).http).toEqual({
    allowedOrigins: [],
    locationsByManifest: {},
  })
  expect(f.json.has(`content-restrictions/local/${hash}.json`)).toBe(true)
})

test("malformed scopes and duplicate workspace identity fail closed instead of selecting by basename", async () => {
  const f = fixture()
  await f.run(configureSharedHttpOrigins([]))
  const raw = property(f.json.get("config.json")),
    config = property(raw.source_resources)
  f.json.set("config.json", {
    ...raw,
    source_resources: {
      ...config,
      workspaces: [
        { workspace_scope: "same", absolute_root: "/one", bindings: [] },
        { workspace_scope: "same", absolute_root: "/two", bindings: [] },
      ],
    },
  })
  expect(code(await f.run(loadSharedSourceOptions().pipe(Effect.result)))).toBe(
    "SOURCE_RESOURCE_CONFIG_INVALID",
  )
})
