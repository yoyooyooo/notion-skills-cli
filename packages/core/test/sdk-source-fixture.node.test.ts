import { createHash } from "node:crypto"
import { mkdtemp, readFile } from "node:fs/promises"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, vi } from "vitest"

// The verification fixture is deliberately standalone JavaScript, shared by the
// installed SDK smoke and the actual Pi driver without importing product state.
const helperUrl = new URL("../../../scripts/sdk-source-fixture.mjs", import.meta.url)
const { startSdkSourceFixture } = await import(helperUrl.href)
type Source = Awaited<ReturnType<typeof startSdkSourceFixture>>

function sample() {
  const main = { id: "selected", properties: {}, revision: "initial" }
  const refreshed = { ...main, revision: "refreshed" }
  return {
    notion: {
      library: {
        skills: { database_id: "skills-db", data_source_id: "skills" },
        files: { data_source_id: "files" },
        records: { data_source_id: "records" },
      },
      main,
      skills: [main],
      refreshed_main: refreshed,
      refreshed_skills: [refreshed],
      database: { id: "skills-db" },
      files: [],
      records: [],
      bodies: { selected: "完整正文\n".repeat(20) },
    },
    view_dynamics: {
      view: { id: "default-view" },
      tags_property_id: "tags",
      observations: [
        {
          id: "initial",
          query_id: "initial-query",
          tags: [],
          filter: { property: "tags", multi_select: { contains: "Default Context" } },
          member_page_ids: ["selected"],
        },
      ],
    },
  }
}

async function withSource(use: (source: Source) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "sdk-source-fixture-"))
  const source = await startSdkSourceFixture(sample(), join(directory, "requests.jsonl"))
  try {
    await use(source)
  } finally {
    await source.close()
    // Retain the actual ledger before the caller's owned TMPDIR is retired by
    // the existing verification cleanup; a failed assertion keeps its evidence.
    console.info(JSON.stringify({ controlledSourceEvidence: directory }))
  }
}

async function settled(source: Source, count: number) {
  await vi.waitFor(() => {
    expect(source.requests).toHaveLength(count)
    for (const row of source.requests) expect(row.closed_monotonic_ns).not.toBeNull()
  })
}

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")

test("complete responses bind actual bytes, phases, View metadata and fixed 401/403 routes", async () => {
  await withSource(async (source) => {
    const origin = source.origin
    const response = await fetch(origin + "/v1/views?database_id=skills-db")
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(JSON.parse(new TextDecoder().decode(bytes)).results).toEqual([
      { object: "view", id: "default-view" },
    ])
    await settled(source, 1)
    expect(source.requests[0]).toMatchObject({
      phase: "setup",
      status: 200,
      request_bytes: 0,
      request_bytes_complete: true,
      terminal: "finished",
      decoded_response_bytes: bytes.length,
      response_sha256: sha256(bytes),
      response_bytes_complete: true,
    })
    source.setPhase("refreshed", { current: "refreshed", denyCurrent: false })
    expect((await (await fetch(origin + "/v1/pages/selected")).json()).revision).toBe("refreshed")
    await settled(source, 2)
    source.setPhase("denied", { denyAuthentication: true, denyCurrent: true })
    for (const [path, status] of [
      ["/v1/users/me", 401],
      ["/v1/pages/selected", 403],
    ] as const) {
      const denied = await fetch(origin + path)
      expect(denied.status).toBe(status)
      await denied.arrayBuffer()
    }
    await settled(source, 4)
    expect(source.origin).toBe(origin)
    expect(source.unexpected).toEqual([])
    const rows = (await readFile(source.ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(rows.map((row) => row.phase)).toEqual(["setup", "refreshed", "denied", "denied"])
    expect(rows.every((row) => row.response_bytes_complete)).toBe(true)
  })
})

test("a held Default View request reaches the server before any response and completes only after release", async () => {
  await withSource(async (source) => {
    const hold = source.holdNext({ method: "GET", path: "/v1/views", afterHeaders: false })
    let received = false
    const pending = fetch(source.origin + "/v1/views?database_id=skills-db").then(
      async (response) => {
        received = true
        return response.json()
      },
    )
    const reached = await hold.reached
    expect(received).toBe(false)
    expect(reached).toMatchObject({ terminal: "pending", status: null, observed_response_bytes: 0 })
    expect(() => source.setPhase("too-early")).toThrow("all prior HTTP calls close")
    hold.release()
    expect((await pending).results).toHaveLength(1)
    expect(await hold.closed).toMatchObject({ terminal: "finished", response_bytes_complete: true })
    source.setPhase("next")
  })
})

test("client abort after response headers retains partial bytes but never claims a complete body", async () => {
  await withSource(async (source) => {
    const hold = source.holdNext({
      method: "GET",
      path: "/v1/pages/selected/markdown",
      afterHeaders: true,
    })
    const controller = new AbortController()
    const result = fetch(source.origin + "/v1/pages/selected/markdown", {
      signal: controller.signal,
    })
      .then((response) => response.text())
      .then(
        (body) => ({ body, error: null }),
        (error: unknown) => ({ body: null, error }),
      )
    const reached = await hold.reached
    expect(reached).toMatchObject({
      status: 200,
      observed_response_bytes: 32,
      response_bytes_complete: false,
    })
    controller.abort()
    expect((await result).error).not.toBeNull()
    const closed = await hold.closed
    expect(closed).toMatchObject({
      terminal: "aborted",
      decoded_response_bytes: null,
      response_sha256: null,
      response_bytes_complete: false,
      observed_response_bytes: 32,
    })
    expect(source.unexpected).toEqual([])
    const events = (await readFile(source.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(["start", "headers", "end", "close"]),
    )
  })
})

test("one 429 and one interrupted stream affect actual HTTP attempts only, then normal reads recover", async () => {
  await withSource(async (source) => {
    const limited = source.rejectNext({
      method: "GET",
      path: "/v1/users/me",
      status: 429,
      retryAfterSeconds: 0.1,
    })
    const response = await fetch(source.origin + "/v1/users/me")
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("0.1")
    await response.arrayBuffer()
    expect(await limited.closed).toMatchObject({ status: 429, terminal: "finished" })
    const recovered = await fetch(source.origin + "/v1/users/me")
    expect(recovered.status).toBe(200)
    await recovered.arrayBuffer()
    await settled(source, 2)
    const interrupted = source.interruptNext({ method: "GET", path: "/v1/pages/selected/markdown" })
    const failed = await fetch(source.origin + "/v1/pages/selected/markdown")
      .then((reply) => reply.text())
      .then(
        () => false,
        () => true,
      )
    expect(failed).toBe(true)
    expect(await interrupted.closed).toMatchObject({
      terminal: "aborted",
      decoded_response_bytes: null,
      response_bytes_complete: false,
      observed_response_bytes: 32,
    })
    const final = await fetch(source.origin + "/v1/pages/selected/markdown")
    expect((await final.json()).markdown).toBe(sample().notion.bodies.selected)
    await settled(source, 4)
    expect(source.unexpected).toEqual([])
  })
})

test("aborting an incomplete request cannot create fictional response bytes", async () => {
  await withSource(async (source) => {
    let received = false
    const client = request(
      source.origin + "/v1/data_sources/skills/query",
      {
        method: "POST",
        headers: { "content-length": "128", "content-type": "application/json" },
      },
      () => {
        received = true
      },
    )
    client.on("error", () => {})
    const closed = new Promise<void>((resolve) => client.once("close", resolve))
    client.write('{"page_size":')
    await vi.waitFor(() => expect(source.requests).toHaveLength(1))
    client.destroy()
    await closed
    await settled(source, 1)
    expect(received).toBe(false)
    expect(source.requests[0]).toMatchObject({
      terminal: "aborted",
      request_bytes: null,
      request_bytes_complete: false,
      decoded_response_bytes: null,
      response_bytes_complete: false,
      observed_response_bytes: 0,
    })
    expect(source.requests[0].observed_request_bytes).toBeGreaterThan(0)
    expect(source.unexpected).toEqual([])
  })
})

test("unknown routes and unselected bodies are rejected, and unused controls close without hanging", async () => {
  await withSource(async (source) => {
    expect(() => source.holdNext({ method: "GET", path: "/undeclared" })).toThrow(
      "exact declared route",
    )
    for (const path of ["/undeclared", "/v1/pages/unselected/markdown"]) {
      const response = await fetch(source.origin + path)
      expect(response.status).toBe(400)
      expect((await response.json()).code).toBe("validation_error")
    }
    await settled(source, 2)
    expect(source.unexpected).toHaveLength(2)
    const unused = source.holdNext({ method: "GET", path: "/v1/users/me" })
    source.setPhase("next")
    expect(await unused.reached).toBeNull()
    expect(await unused.closed).toBeNull()
    const closing = source.close()
    expect(source.close()).toBe(closing)
    await closing
  })
})
