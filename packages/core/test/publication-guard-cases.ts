import { expect, test } from "vitest"
import { Effect } from "effect"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createSkill, replaceSkill } from "../src/mutation.ts"
import { portableIdentity } from "../src/export.ts"
import { MANIFEST, readPortable } from "../src/portable.ts"
import { Store } from "../src/store.ts"
import { property } from "../src/model.ts"
import { PublicationReceiptSchema } from "../src/publication-model.ts"
import { publicationMarker } from "../src/publication-integrity.ts"
import { UpstreamPublisher } from "../src/upstream-model.ts"
import type { RouterFixture } from "./router-authoring.node.test.ts"

const database = "11111111-1111-4111-8111-111111111111"
const router = "33333333-3333-4333-8333-333333333333"
const alpha = "44444444-4444-4444-8444-444444444444"
const subscription = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const rich = (content: string) => ({
  type: "rich_text",
  rich_text: [{ plain_text: content, text: { content } }],
})

export function registerPublicationGuardTests(
  fixture: (upstream?: boolean) => Promise<RouterFixture>,
) {
  async function withRouter(use: (fixture: RouterFixture) => Promise<void>) {
    const f = await fixture()
    try {
      await use(f)
    } finally {
      await f.close()
    }
  }
  const guardEvidencePhase = process.env.PUBLICATION_GUARD_EVIDENCE
  const guardCounts = (requests: RouterFixture["requests"]) => ({
    methods: Object.fromEntries(
      ["GET", "POST", "PATCH"].map((method) => [
        method,
        requests.filter((request) => request.method === method).length,
      ]),
    ),
    paths: Object.fromEntries(
      [...new Set(requests.map(({ method, path }) => `${method} ${path}`))]
        .sort()
        .map((key) => [
          key,
          requests.filter(({ method, path }) => `${method} ${path}` === key).length,
        ]),
    ),
  })

  // Retain content, mutation order and outcomes; only ephemeral identities and clocks
  // are removed from the before/after semantic comparison.
  const guardSemantic = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(guardSemantic)
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key]) =>
              ![
                "operation_id",
                "publication_operation_id",
                "snapshot_id",
                "version_id",
                "previous_version_id",
                "created_time",
                "updated_time",
                "last_edited_time",
                "validated_at",
              ].includes(key),
          )
          .map(([key, item]) => [key, guardSemantic(item)]),
      )
    if (typeof value === "string") {
      try {
        return JSON.stringify(guardSemantic(JSON.parse(value)))
      } catch {}
      return value
        .replace(/(?:pub|op|p)_[a-zA-Z0-9_-]+/g, "<operation>")
        .replace(/snapshot=s_[a-zA-Z0-9_-]+/g, "snapshot=<snapshot>")
        .replace(/http:\/\/127\.0\.0\.1:\d+/g, "http://fixture")
    }
    return value
  }

  test("publication guard controlled one-member replacement and mode evidence", async () => {
    const scenarios: unknown[] = []
    await withRouter(async (f) => {
      await f.run(
        createSkill(f.input, {
          database,
          members: [alpha],
          operationId: "p_guard-replacement-initial",
        }),
      )
      await f.put("ROUTER.md", "# Replacement route\n\nRead [guide](references/guide.md).\n")
      await f.put("references/guide.md", "# Replacement guide\n")
      const start = f.requests.length,
        writeStart = f.writes.length
      let stage = "prepare"
      const stages: Record<string, RouterFixture["requests"]> = {}
      f.beforeRequest((request) => {
        ;(stages[stage] ??= []).push(request)
      })
      const result = await f.run(
        replaceSkill(f.input, {
          target: router,
          operationId: "p_guard-replacement-change",
          onProgress: (event) =>
            Effect.sync(() => {
              stage = `${event.stage}:${event.status}`
            }),
        }),
      )
      expect(result).toMatchObject({ action: "update", verified: true })
      expect(f.memberIds()).toEqual([alpha])
      expect(f.body()).toContain("# Replacement route")
      expect(f.children[0]!.body).toContain("# Replacement guide")
      const receipt = await f.run(
        Effect.flatMap(Store, (store) =>
          store.readJson(`publications/${result.operation_id}.json`, PublicationReceiptSchema),
        ),
      )
      expect(receipt).toMatchObject({ state: "completed" })
      expect(publicationMarker({ properties: f.properties })).toMatchObject({ state: "committed" })
      scenarios.push({
        scenario: "one-member-replacement",
        counts: guardCounts(f.requests.slice(start)),
        stages: Object.fromEntries(
          Object.entries(stages).map(([key, requests]) => [key, guardCounts(requests)]),
        ),
        semantic: guardSemantic({
          writes: f.writes.slice(writeStart),
          intents: receipt!.intents.map(({ path, method, body, status }) => ({
            path,
            method,
            body,
            status,
          })),
          result,
          body: f.body(),
          children: f.children,
          members: f.memberIds(),
        }),
      })
    })
    const f = await fixture(true)
    try {
      const portable = readPortable(
        await Promise.all(
          [MANIFEST, "SKILL.md", "references/guide.md", "assets/data.bin"].map(async (path) => ({
            path,
            bytes: new Uint8Array(await readFile(join(f.input, path))),
          })),
        ),
      )!
      const initialHash = await f.run(portableIdentity(portable))
      await f.run(
        Effect.flatMap(UpstreamPublisher, (publisher) =>
          publisher.publish({
            operation_id: "guard-mode-initial",
            portable,
            target_database_id: database,
            ownership: {
              subscription_id: subscription,
              member_key: "fixture/guard",
              mode: "tracked",
              published_hash: initialHash,
              revision: "accepted-v1",
            },
          }),
        ),
      )
      const current = await f.run(
        Effect.flatMap(UpstreamPublisher, (publisher) => publisher.inspect(router)),
      )
      const baselineRef = await f.run(
        Effect.flatMap(UpstreamPublisher, (publisher) =>
          publisher.recoverableBaseline(router, current.version),
        ),
      )
      const start = f.requests.length,
        writeStart = f.writes.length
      await f.run(
        Effect.flatMap(UpstreamPublisher, (publisher) =>
          publisher.setMode({
            operation_id: "guard-mode-change",
            page_id: router,
            expected_version: current.version,
            mode: "fork",
            published_hash: current.content_hash,
            revision: "accepted-v1",
            fork_baseline: {
              version: 1,
              original_ref: "fixture/guard",
              revision: "accepted-v1",
              content_hash: current.content_hash,
              portable_ref: baselineRef,
            },
          }),
        ),
      )
      const requests = f.requests.slice(start)
      const marker = publicationMarker({ properties: f.properties })!
      const receipt = await f.run(
        Effect.flatMap(Store, (store) =>
          store.readJson(`publications/${marker.operation_id}.json`, PublicationReceiptSchema),
        ),
      )
      expect(receipt).toMatchObject({ state: "completed" })
      expect(marker).toMatchObject({ state: "committed" })
      expect(property(property(f.properties["Sync Mode"]).select).name).toBe("fork")
      scenarios.push({
        scenario: "one-member-mode",
        counts: guardCounts(requests),
        semantic: guardSemantic({
          writes: f.writes.slice(writeStart),
          intents: receipt!.intents.map(({ path, method, body, status }) => ({
            path,
            method,
            body,
            status,
          })),
          result: receipt!.result,
          body: f.body(),
          children: f.children,
        }),
      })
    } finally {
      await f.close()
    }
    if (guardEvidencePhase) {
      expect(["before", "after"]).toContain(guardEvidencePhase)
      const directory =
        process.env.PUBLICATION_GUARD_EVIDENCE_DIR ?? join(process.cwd(), "control/perf")
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, `publication-guard-${guardEvidencePhase}.json`),
        JSON.stringify(
          {
            scope:
              "Real core StoreLive + UpstreamPublisherLive; controlled Notion.request boundary; loopback artifact downloads; counts are fixture API calls, not HTTP latency.",
            scenarios,
          },
          null,
          2,
        ) + "\n",
      )
      if (guardEvidencePhase === "after") {
        const baseline = JSON.parse(
          await readFile(join(directory, "publication-guard-before.json"), "utf8"),
        )
        expect(
          JSON.parse(JSON.stringify(scenarios.map((scenario) => property(scenario).semantic))),
        ).toEqual(
          (property(baseline).scenarios as unknown[]).map((scenario) =>
            guardSemantic(property(scenario).semantic),
          ),
        )
      }
    }
  }, 30000)

  for (const external of ["dependency", "target"] as const) {
    test(
      `publication guard mutation-stage ${external} edit never commits`,
      async () =>
        withRouter(async (f) => {
          await f.run(createSkill(f.input, { database, members: [alpha] }))
          await f.put("ROUTER.md", "# Later target write\n")
          await f.put("references/guide.md", "# Earlier child write\n")
          let injected = false
          const start = f.writes.length
          f.beforeRequest(({ method, path }) => {
            if (injected || method !== "PATCH" || !path.endsWith("/markdown")) return
            injected = true
            expect(path).toBe(`v1/pages/${f.children[0]!.id}/markdown`)
            expect(
              f.requests.some(
                (request) =>
                  request.method === "GET" &&
                  request.path === `v1/pages/${external === "dependency" ? alpha : router}`,
              ),
            ).toBe(true)
            if (external === "target") f.editBody()
            else {
              const member = f.members.get(alpha)!
              member.properties.Description = {
                id: "description",
                ...rich("Concurrent dependency edit"),
              }
              member.last_edited_time = "2026-10-17T00:04:00.000Z"
            }
          })
          const result = await f.run(replaceSkill(f.input, { target: router }).pipe(Effect.result))
          expect(injected).toBe(true)
          expect(result._tag).toBe("Failure")
          if (result._tag !== "Failure") throw new Error("Expected concurrent edit refusal")
          expect(["WRITE_CONFLICT", "WRITE_PARTIAL"]).toContain(result.failure.code)
          if (result.failure.code === "WRITE_PARTIAL")
            expect(property(result.failure.details).cause_code).toBe("WRITE_CONFLICT")
          expect(publicationMarker({ properties: f.properties })?.state).not.toBe("committed")
          expect(
            f.writes
              .slice(start)
              .some(({ body }) => JSON.stringify(body).includes('"state":"committed"')),
          ).toBe(false)
          if (external === "target") expect(f.body()).toBe("External author body.\n")
        }),
      30000,
    )
  }
}
