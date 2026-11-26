import { expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { mkdtemp, mkdir, readFile, writeFile, chmod, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  decodeMcpStoredState,
  McpCredentialStore,
  type McpStoredState,
} from "../src/notion-mcp-credential-store.ts"
import { getMcpAuthStatus, logoutMcp, setMcpToken } from "../src/notion-mcp-auth.ts"
import { trashPath } from "../src/local-locks.ts"
import { fail } from "../src/model.ts"

async function isolated(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ntn-mcp-store-"))
  try {
    await run(root)
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}
const stored = (overrides: Partial<McpStoredState> = {}): McpStoredState => ({
  version: 1,
  profile: "default",
  serverUrl: "https://mcp.notion.com/mcp",
  connectionId: "connection-fixture",
  grantEpoch: "epoch-fixture",
  revision: 1,
  storedToken: null,
  registration: null,
  oauth: { kind: "absent" },
  ...overrides,
})
function store(root: string, deadline = Date.now() + 10_000, profile = "default") {
  return new McpCredentialStore({
    configHome: root,
    profile,
    serverUrl: "https://mcp.notion.com/mcp",
    deadline,
  })
}

test("MCP status is read-only and never opens the unrelated REST config", async () => {
  await isolated(async (root) => {
    await writeFile(join(root, "config.json"), "intentionally invalid REST configuration", {
      mode: 0o600,
    })
    const status = await getMcpAuthStatus({ configHome: root, env: {} })
    expect(status.tokenSource).toBe("none")
    expect(status.oauth).toBe("absent")
    await expect(stat(join(root, "notion-mcp"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(
      "intentionally invalid REST configuration",
    )
  })
})

test("token updates preserve OAuth and REST bytes while concurrent writers serialize state", async () => {
  await isolated(async (root) => {
    const rest = JSON.stringify({ token: "synthetic-rest-secret", sources: [{ alias: "fixture" }] })
    await writeFile(join(root, "config.json"), rest, { mode: 0o600 })
    const target = store(root)
    await target.transaction(async (initial, commit) => {
      await commit({
        ...initial,
        oauth: {
          kind: "ready",
          accessToken: "synthetic-access",
          refreshToken: "synthetic-refresh",
          expiresAt: Date.now() + 3_600_000,
          scope: "default",
          identity: { workspaceId: "workspace", principalId: "principal" },
          refresh: { kind: "idle" },
        },
      })
    })
    const before = await target.read()
    const statuses = await Promise.all([
      setMcpToken("first-explicit", { configHome: root, env: {} }),
      setMcpToken("second-explicit", { configHome: root, env: {} }),
    ])
    const result = await target.read()
    expect(result.revision).toBe(2)
    expect(new Set(statuses.map((status) => status.revision))).toEqual(new Set([1, 2]))
    expect(result.oauth).toEqual(before.oauth)
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(rest)
    for (const status of statuses) {
      expect(status.identity).toBeNull()
      expect(JSON.stringify(status)).not.toMatch(/synthetic-|first-explicit|second-explicit/)
    }
  })
})

test("logout advances epoch and clears only the OAuth grant", async () => {
  await isolated(async (root) => {
    const target = store(root)
    await target.transaction(async (initial, commit) => {
      await commit({
        ...initial,
        storedToken: "synthetic-explicit",
        oauth: { kind: "reauth_required", reason: "uncertain_refresh" },
      })
    })
    const before = await target.read()
    const result = await logoutMcp({ configHome: root, env: {} })
    expect(result.oauth).toBe("absent")
    expect(result.tokenSource).toBe("stored")
    const after = await target.read()
    expect(after.storedToken).toBe(before.storedToken)
    expect(after.connectionId).toBe(before.connectionId)
    expect(after.grantEpoch).not.toBe(before.grantEpoch)
  })
})

test("profile and issuer select separate files and independent locks under the config home", async () => {
  await isolated(async (root) => {
    const a = store(root),
      b = store(root, Date.now() + 10_000, "work")
    expect(a.file).not.toBe(b.file)
    await setMcpToken("synthetic-default", { configHome: root, env: {} })
    await setMcpToken("synthetic-work", { configHome: root, profile: "work", env: {} })
    expect((await a.read()).storedToken).toBe("synthetic-default")
    expect((await b.read()).storedToken).toBe("synthetic-work")
  })
})

test("insecure and corrupt credential files fail closed without echoing their contents", async () => {
  await isolated(async (root) => {
    const target = store(root)
    await mkdir(target.directory, { recursive: true, mode: 0o700 })
    const secret = "synthetic-secret-must-not-be-in-errors"
    await writeFile(target.file, secret, { mode: 0o600 })
    const corrupt = await target.read().then(
      () => null,
      (error: unknown) => error,
    )
    expect(corrupt).toMatchObject({ code: "MCP_STATE_CORRUPT" })
    expect(String(corrupt)).not.toContain(secret)
    await writeFile(target.file, JSON.stringify(stored()))
    await chmod(target.file, 0o644)
    await expect(target.read()).rejects.toMatchObject({ code: "MCP_STATE_UNSAFE" })
  })
})

test("decoding refresh state rejects partial transaction records and reconstructs a closed shape", () => {
  expect(() =>
    decodeMcpStoredState(
      stored({
        oauth: {
          kind: "ready",
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: 1,
          scope: "default",
          identity: { workspaceId: "w", principalId: "p" },
          refresh: {
            kind: "pending",
            requestId: "request",
            revision: 1,
            grantEpoch: "epoch",
            startedAt: 1,
            deadline: 2,
          },
        },
      }),
    ),
  ).not.toThrow()
  const invalid: unknown = {
    ...stored(),
    oauth: {
      kind: "ready",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1,
      scope: "default",
      identity: { workspaceId: "w", principalId: "p" },
      refresh: { kind: "pending", requestId: "request" },
    },
  }
  expect(() => decodeMcpStoredState(invalid)).toThrow()
  expect(decodeMcpStoredState({ ...stored(), untrusted_extra_secret: "not-propagated" })).toEqual(
    stored(),
  )
})

test("an already expired transaction cannot create a credential directory or publish state", async () => {
  await isolated(async (root) => {
    const target = store(root, Date.now() - 1)
    await expect(
      target.transaction(async (current, commit) => commit(current)),
    ).rejects.toMatchObject({ code: "MCP_AUTH_TIMEOUT" })
    await expect(stat(target.directory)).rejects.toMatchObject({ code: "ENOENT" })
  })
})

test("deadline reached inside a transaction prevents replacing the durable winner", async () => {
  await isolated(async (root) => {
    await setMcpToken("durable-winner", { configHome: root, env: {} })
    const before = await readFile(store(root).file, "utf8")
    const target = store(root, Date.now() + 100)
    const result = await target
      .transaction(async (current, commit) => {
        await new Promise((done) => setTimeout(done, 150))
        await commit({ ...current, storedToken: "late-loser", revision: current.revision + 1 })
      })
      .then(
        (value) => value,
        (error: unknown) => error,
      )
    expect(result).toMatchObject({ code: "MCP_AUTH_TIMEOUT" })
    expect(await readFile(store(root).file, "utf8")).toBe(before)
  })
})

test("a retired publication owner cannot replace durable state after staging bytes", async () => {
  await isolated(async (root) => {
    await setMcpToken("durable-winner", { configHome: root, env: {} })
    const target = store(root)
    const before = await readFile(target.file, "utf8")
    const guarded = new McpCredentialStore({
      ...target.options,
      beforePublish: () => {
        throw fail("MCP_AUTH_TIMEOUT", "The publication owner expired.")
      },
    })
    const result = await guarded
      .transaction(async (current, commit) => {
        await commit({ ...current, storedToken: "late-loser", revision: current.revision + 1 })
      })
      .then(
        (value) => value,
        (error: unknown) => error,
      )
    expect(result).toMatchObject({ code: "MCP_AUTH_TIMEOUT" })
    expect(await readFile(target.file, "utf8")).toBe(before)
  })
})
