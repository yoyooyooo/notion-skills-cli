import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { trashPath } from "../src/local-locks.ts"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { RequestBudget } from "../src/request-budget.ts"
import { BUDGETED_PROVIDER_RESPONSE_LIMIT } from "../src/request-budget-http.ts"
import {
  DEFAULT_CURRENT_INVOCATION_BUDGET,
  withCurrentInvocationBudget,
} from "../src/shared-current-invocation.ts"
import { prepareCurrentSkillWrite, writeCurrentSkill } from "../src/shared-current-write.ts"
import { json, localServer, recordedFixtureTransport, runtime } from "./notion-http-fixture.ts"
import { currentWriteFixture, id, library, testBytes } from "./shared-current-write-fixture.ts"

const root = mkdtempSync(join(tmpdir(), "ntn-current-invocation-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
})
const platform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeServices.layer))

test("defaults are mandatory, nested work shares identity and a later invocation gets fresh allowance", async () => {
  const inspect = Effect.gen(function* () {
    const outer = yield* RequestBudget
    const nested = yield* withCurrentInvocationBudget(
      Effect.gen(function* () {
        return (yield* RequestBudget).identity
      }),
    )
    return { outer: outer.identity, nested: nested.result }
  })
  const first = await Effect.runPromise(platform(withCurrentInvocationBudget(inspect)))
  const second = await Effect.runPromise(platform(withCurrentInvocationBudget(inspect)))
  expect(first.budget.limits).toEqual(DEFAULT_CURRENT_INVOCATION_BUDGET)
  expect(first.budget.attempts).toBe(0)
  expect(first.result.outer).toBe(first.result.nested)
  expect(second.result.outer).not.toBe(first.result.outer)
  const changed = await Effect.runPromise(
    platform(
      withCurrentInvocationBudget(withCurrentInvocationBudget(Effect.void, { requests: 2 }), {
        requests: 1,
      }).pipe(Effect.result),
    ),
  )
  expect(changed._tag).toBe("Failure")
  if (changed._tag === "Failure") {
    expect(changed.failure.code).toBe("REQUEST_BUDGET_RECONFIGURATION")
    expect(property(changed.failure.details).budget).toMatchObject({ attempts: 0 })
  }
})

test("actual Notion, provider and multipart requests share one allowance without nested double charging", async () => {
  const target = join(root, "original.txt")
  writeFileSync(target, "exact part\u0000\r\n")
  const sent: Array<{ path: string; bytes: number; part?: string }> = []
  let responseBytes = 0
  await localServer(
    (request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const bytes = Buffer.concat(chunks)
        let part: string | undefined
        if (request.url?.endsWith("/send")) {
          const form = await new Response(bytes, {
            headers: { "content-type": String(request.headers["content-type"]) },
          }).formData()
          part = String(form.get("part_number"))
        }
        sent.push({ path: request.url!, bytes: bytes.length, ...(part ? { part } : {}) })
        if (request.url === "/provider") {
          const body = "exact provider bytes"
          responseBytes += Buffer.byteLength(body)
          response.end(body)
        } else {
          const body = { object: "page", id: id(90) }
          responseBytes += Buffer.byteLength(JSON.stringify(body))
          json(response, 200, body)
        }
      })().catch((error) => response.destroy(error))
    },
    async (origin) => {
      const outcome = await Effect.runPromise(
        withCurrentInvocationBudget(
          Effect.gen(function* () {
            const api = yield* Notion
            yield* api.request(`v1/pages/${id(90)}`)
            yield* withCurrentInvocationBudget(
              Effect.gen(function* () {
                const client = yield* HttpClient.HttpClient
                yield* client.get(`${origin}/provider`).pipe(Effect.orDie)
              }),
            )
            for (const partNumber of [1, 2])
              yield* api.request(`v1/file_uploads/${id(91)}/send`, undefined, {
                method: "POST",
                file: target,
                partNumber,
              })
            yield* api.request(`v1/file_uploads/${id(91)}/complete`, {}, { method: "POST" })
          }),
          { requests: 4 },
        ).pipe(Effect.result, Effect.provide(runtime(origin, { intervalMs: 0 })), platform),
      )
      expect(outcome._tag).toBe("Failure")
      if (outcome._tag === "Failure") {
        expect(outcome.failure.code).toBe("REQUEST_BUDGET_EXHAUSTED")
        expect(property(outcome.failure.details).budget).toMatchObject({
          attempts: 4,
          request_bytes: sent.reduce((size, call) => size + call.bytes, 0),
          response_bytes: responseBytes,
          exhausted: "requests",
        })
      }
    },
  )
  expect(sent).toHaveLength(4)
  expect(sent.flatMap((call) => (call.part ? [call.part] : []))).toEqual(["1", "2"])
  expect(sent.some((call) => call.path.endsWith("/complete"))).toBe(false)
})

test("an oversized request permanently exhausts this invocation before a smaller cleanup request", async () => {
  let requests = 0
  await localServer(
    (_request, response) => {
      requests++
      json(response, 200, { object: "page", id: id(92) })
    },
    async (origin) => {
      const result = await Effect.runPromise(
        withCurrentInvocationBudget(
          Effect.gen(function* () {
            const api = yield* Notion
            const first = yield* api
              .request(`v1/pages/${id(92)}`, { too: "large" })
              .pipe(Effect.result)
            const second = yield* api.request(`v1/pages/${id(92)}`).pipe(Effect.result)
            return [first, second]
          }),
          { bytes: 1 },
        ).pipe(Effect.provide(runtime(origin, { intervalMs: 0 })), platform),
      )
      expect(result.result.map((outcome) => outcome._tag)).toEqual(["Failure", "Failure"])
      expect(result.budget).toMatchObject({ attempts: 0, exhausted: "bytes" })
    },
  )
  expect(requests).toBe(0)
})

test("the invocation deadline retains actual uncertain-write semantics and usage", async () => {
  let requests = 0
  await localServer(
    (_request, _response) => {
      requests++
      // Keep the actual connection open until the client's deadline aborts it.
    },
    async (origin) => {
      const result = await Effect.runPromise(
        withCurrentInvocationBudget(
          Effect.gen(function* () {
            yield* (yield* Notion).request(
              `v1/pages/${id(93)}`,
              { in_trash: true },
              { method: "PATCH" },
            )
          }),
          { duration_ms: 100 },
        ).pipe(Effect.result, Effect.provide(runtime(origin, { intervalMs: 0 })), platform),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
        expect(result.failure.details).toMatchObject({
          cause_code: "REQUEST_BUDGET_EXHAUSTED",
          phase: "outcome_unknown",
          budget: { attempts: 1, exhausted: "duration" },
        })
      }
    },
  )
  expect(requests).toBe(1)
})

test("budgeted provider transport accepts the current ZIP wire bound and refuses a larger response", async () => {
  for (const size of [BUDGETED_PROVIDER_RESPONSE_LIMIT, BUDGETED_PROVIDER_RESPONSE_LIMIT + 1]) {
    await localServer(
      (_request, response) => {
        response.end(Buffer.alloc(size))
      },
      async (origin) => {
        const result = await Effect.runPromise(
          platform(
            withCurrentInvocationBudget(
              Effect.gen(function* () {
                const client = yield* HttpClient.HttpClient
                const received = yield* client.get(origin).pipe(
                  Effect.mapError((error) => property(property(error.reason).cause)),
                  Effect.result,
                )
                if (received._tag === "Failure") return received.failure
                return (yield* received.success.arrayBuffer.pipe(Effect.orDie)).byteLength
              }),
            ),
          ),
        )
        expect(result.budget.attempts).toBe(1)
        if (size === BUDGETED_PROVIDER_RESPONSE_LIMIT) expect(result.result).toBe(size)
        else expect(result.result).toMatchObject({ code: "REQUEST_RESPONSE_LIMIT" })
      },
    )
  }
}, 20_000)

const input = (support: boolean) => ({
  skill_id: "budget-current",
  kind: "skill" as const,
  name: "Budget current",
  description: "Complete bounded current tree",
  files: [
    {
      path: "SKILL.md",
      bytes: testBytes(support ? "# Current\n[Guide](guide.md)\n" : "# Current\n"),
    },
    ...(support ? [{ path: "guide.md", bytes: testBytes("# Complete guide\n") }] : []),
  ],
})

test("real HTTP writer stops at its limit without attention or cleanup and resumes with a fresh budget", async () => {
  let fileCreateBoundary = 0,
    retirementBoundary = 0
  const baseline = currentWriteFixture(root)
  await recordedFixtureTransport(await baseline.run(Notion), async (api, requests) => {
    const original = await baseline.run(prepareCurrentSkillWrite(input(true)))
    const replacement = await baseline.run(prepareCurrentSkillWrite(input(false)))
    await baseline.run(
      withCurrentInvocationBudget(
        writeCurrentSkill(library, {
          plan: original,
          operation_id: "budget-initial",
        }),
      ).pipe(Effect.provideService(Notion, api)),
    )
    fileCreateBoundary = requests.findIndex(
      (call) =>
        call.method === "POST" &&
        call.path === "v1/pages" &&
        property(property(call.body).parent).data_source_id === library.files.data_source_id,
    )
    const previousFile = String(baseline.table("files")[0]!.id)
    const start = requests.length
    await baseline.run(
      withCurrentInvocationBudget(
        writeCurrentSkill(library, {
          plan: replacement,
          operation_id: "budget-replacement",
        }),
      ).pipe(Effect.provideService(Notion, api)),
    )
    retirementBoundary = requests
      .slice(start)
      .findIndex(
        (call) =>
          call.method === "PATCH" &&
          call.path === `v1/pages/${previousFile}` &&
          property(call.body).in_trash === true,
      )
  })
  expect(fileCreateBoundary).toBeGreaterThan(0)
  expect(retirementBoundary).toBeGreaterThan(0)
  for (const stage of ["file-create", "retirement"] as const) {
    const f = currentWriteFixture(root)
    await recordedFixtureTransport(await f.run(Notion), async (api, requests) => {
      const original = await f.run(prepareCurrentSkillWrite(input(true)))
      const plan =
        stage === "file-create" ? original : await f.run(prepareCurrentSkillWrite(input(false)))
      if (stage === "retirement")
        await f.run(
          withCurrentInvocationBudget(
            writeCurrentSkill(library, {
              plan: original,
              operation_id: "budget-initial",
            }),
          ).pipe(Effect.provideService(Notion, api)),
        )
      const start = requests.length,
        limit = stage === "file-create" ? fileCreateBoundary : retirementBoundary,
        operation = stage === "file-create" ? "budget-initial" : "budget-replacement"
      const outcome = await f.run(
        withCurrentInvocationBudget(
          writeCurrentSkill(library, {
            plan,
            operation_id: operation,
          }),
          { requests: limit },
        ).pipe(Effect.result, Effect.provideService(Notion, api)),
      )
      expect(outcome._tag).toBe("Failure")
      if (outcome._tag === "Failure") {
        expect(outcome.failure.code).toBe("REQUEST_BUDGET_EXHAUSTED")
        expect(outcome.failure.details).toMatchObject({
          operation_id: operation,
          next: "reconcile_current",
          budget: { attempts: limit, exhausted: "requests" },
        })
      }
      expect(requests.length - start).toBe(limit)
      expect(property(property(f.table("skills")[0]!.properties)["current-state"]).select).toEqual({
        name: "applying",
      })
      expect(
        f
          .mutations()
          .some(
            (call) =>
              property(property(property(property(call.body).properties)["current-state"]).select)
                .name === "attention",
          ),
      ).toBe(false)
      expect(
        [...f.json.keys()].filter((key) => key.includes("current-write-pending")),
      ).toHaveLength(1)
      if (stage === "retirement") expect(f.table("files")).toHaveLength(1)
      const resumeStart = requests.length
      const resumed = await f.run(
        withCurrentInvocationBudget(
          writeCurrentSkill(library, {
            plan,
            operation_id: operation,
            mode: "resume",
          }),
        ).pipe(Effect.provideService(Notion, api)),
      )
      expect(resumed.result.state).toBe("ready")
      expect(resumed.budget.attempts).toBe(requests.length - resumeStart)
      expect(resumed.budget.exhausted).toBeNull()
      expect(
        [...f.json.keys()].filter((key) => key.includes("current-write-pending")),
      ).toHaveLength(0)
      expect(f.table("files")).toHaveLength(stage === "file-create" ? 1 : 0)
    })
  }
}, 30_000)
