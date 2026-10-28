import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { ConfigProvider, Crypto, Effect, FileSystem, Layer, Path } from "effect"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, vi } from "vitest"
import { authScope } from "../src/catalog.ts"
import { portableIdentity } from "../src/export.ts"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { PortableSkill } from "../src/portable.ts"
import { canonical } from "../src/publication-effect-proof.ts"
import { preparePublicationIntegrity } from "../src/publication-integrity.ts"
import { type CommittedMarker } from "../src/publication-integrity-state.ts"
import { PublicationReceiptSchema, type Receipt } from "../src/publication-model.ts"
import { sha256, Store, StoreLive } from "../src/store.ts"
import { freezePortable, subscriptionConfigHash, targetKey } from "../src/upstream-content.ts"
import {
  applyMapCheckpointAdoption,
  planMapCheckpointAdoption,
} from "../src/upstream-map-checkpoint-adoption.ts"
import {
  mapCheckpointAdoptionPlanKey,
  mapCheckpointAdoptionReceiptKey,
  type MapCheckpointAdoptionInput,
} from "../src/upstream-map-checkpoint-adoption-model.ts"
import {
  strictDecode,
  UpstreamPlanSchema,
  UpstreamPublisher,
  type ManagedContent,
  type PublishedMembers,
  type UpstreamOperation,
  type UpstreamPlan,
} from "../src/upstream-model.ts"
import { decodeSubscription } from "../src/upstream-subscription.ts"

const sub = "11111111-1111-4111-8111-111111111111"
const db = "22222222-2222-4222-8222-222222222222"
const ds = "33333333-3333-4333-8333-333333333333"
const target = "44444444-4444-4444-8444-444444444444"
const targetDs = "55555555-5555-4555-8555-555555555555"
const names = ["alpha", "beta", "gamma", "delta"] as const
const pageIds = names.map(
  (_, index) => `66666666-6666-4666-8666-${String(index + 1).padStart(12, "0")}`,
)
const rich = (value: string, type = "rich_text") => ({
  ...(type === "title" ? { id: "title" } : {}),
  type,
  [type]: [{ plain_text: value }],
})
interface RawPage {
  id: string
  parent: { data_source_id: string }
  last_edited_time: string
  properties: Record<string, unknown>
}
interface Fixture {
  readonly input: MapCheckpointAdoptionInput
  readonly originalPlan: UpstreamPlan
  readonly originalOperation: UpstreamOperation
  readonly laterMap: PublishedMembers
  readonly subscriptionPage: RawPage
  readonly rawPages: Map<string, RawPage>
  readonly pages: Map<string, ManagedContent>
  readonly hooks: { onInspect?: (id: string) => void }
  readonly inspections: string[]
  readonly writeAttempts: string[]
}
type TestServices =
  | Store
  | Notion
  | UpstreamPublisher
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path

/** Native completed receipts and committed markers here are synthetic test seeds. */
async function withFixture(
  work: (fixture: Fixture) => Effect.Effect<unknown, unknown, TestServices>,
) {
  const root = await mkdtemp(join(tmpdir(), "ntn-map-adoption-"))
  vi.stubEnv("NTN_SKILLS_HOME", join(root, "state"))
  vi.stubEnv("NTN_SKILLS_CONFIG_HOME", join(root, "config"))
  vi.stubEnv("NTN_SKILLS_CACHE_HOME", join(root, "cache"))
  const subscriptionPage: RawPage = {
    id: sub,
    parent: { data_source_id: ds },
    last_edited_time: "2026-10-21T18:14:00Z",
    properties: {
      Name: rich("Fixture source", "title"),
      Description: rich("Synthetic recovery fixture."),
      Source: rich(
        JSON.stringify({
          provider: { type: "git", url: join(root, "source"), ref: "main" },
          strip_prefix: "skills",
        }),
      ),
      Ref: rich("main"),
      Roots: rich('["skills"]'),
      Include: rich("[]"),
      Exclude: rich("[]"),
      Mapping: rich("{}"),
      "Target Database ID": rich(target),
      "Published Members": rich(""),
      Enabled: { type: "checkbox", checkbox: true },
      "Default Context": { type: "checkbox", checkbox: false },
      Status: { type: "select", select: { name: "partial" } },
    },
  }
  const rawPages = new Map<string, RawPage>(),
    pages = new Map<string, ManagedContent>()
  const hooks: Fixture["hooks"] = {},
    inspections: string[] = [],
    writeAttempts: string[] = []
  const notion = Notion.of({
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("map-adoption-fixture"),
    request: (path, body, options) =>
      Effect.sync(() => {
        if (body !== undefined || (options?.method !== undefined && options.method !== "GET")) {
          writeAttempts.push(`notion:${path}`)
          throw new Error("Map checkpoint adoption attempted a Notion write")
        }
        if (path === "v1/users/me") return { id: "map-adoption-fixture-user", object: "user" }
        if (path === `v1/databases/${db}` || path === `v1/databases/${target}`)
          return {
            id: path.endsWith(db) ? db : target,
            title: [],
            database_type: null,
            data_sources: [{ id: path.endsWith(db) ? ds : targetDs, name: "fixture" }],
          }
        if (path === `v1/pages/${sub}`) return structuredClone(subscriptionPage)
        const page = rawPages.get(path.replace(/^v1\/pages\//, ""))
        if (page) return structuredClone(page)
        throw new Error(`Unexpected read: ${path}`)
      }),
  })
  const forbidden = (name: string) =>
    Effect.gen(function* () {
      writeAttempts.push(`publisher:${name}`)
      return yield* Effect.fail(
        fail("TEST_UNEXPECTED_WRITE", "Adoption can only inspect the publisher."),
      )
    })
  const publisher = UpstreamPublisher.of({
    inspect: (id) =>
      Effect.sync(() => {
        inspections.push(id)
        hooks.onInspect?.(id)
        const page = pages.get(id)
        if (!page) throw new Error("Missing fixture member")
        return structuredClone(page)
      }),
    publish: () => forbidden("publish"),
    reconcile: () => forbidden("reconcile"),
    setMode: () => forbidden("setMode"),
    recoverableBaseline: () => forbidden("recoverableBaseline"),
    readBaseline: () => forbidden("readBaseline"),
  })
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* Store,
            fs = yield* FileSystem.FileSystem
          yield* store.writeJson("config.json", { upstream_database: db })
          const subscription = yield* decodeSubscription(subscriptionPage, db, ds)
          const scope = yield* authScope
          const revision = "a".repeat(40)
          const portables: PortableSkill[] = names.map((name) => ({
            kind: "skill",
            name,
            description: "Use for exact map recovery fixtures.",
            main: "SKILL.md",
            files: [
              {
                path: "SKILL.md",
                bytes: new TextEncoder().encode(
                  `---\nname: ${name}\ndescription: Use for exact map recovery fixtures.\n---\n\n# ${name}\n\nSee [guide](references/guide.md).\n`,
                ),
              },
              {
                path: "references/guide.md",
                bytes: new TextEncoder().encode(`Whole-skill fixture for ${name}.\n`),
              },
            ],
          }))
          const frozen = yield* Effect.forEach(portables, freezePortable)
          const hashes = yield* Effect.forEach(portables, portableIdentity)
          const draft: Omit<UpstreamPlan, "plan_id" | "plan_hash"> = {
            version: 1,
            created_at: 1,
            subscription_id: sub,
            subscription_version: subscription.version,
            scope,
            database_id: db,
            config_hash: yield* subscriptionConfigHash(subscription),
            revision,
            source_manifest: {
              version: 1,
              source_id: sub,
              revision,
              members: names.map((name, index) => ({
                member_key: `skills/${name}`,
                source_path: `skills/${name}`,
                main: "SKILL.md",
                upstream_hash: hashes[index]!,
                resources: frozen[index]!.files.map((file) => ({
                  path: file.path,
                  sha256: file.hash,
                })),
              })),
            },
            provenance: {},
            publisher_subscription_id: sub,
            target_database_id: target,
            items: names.map((name, index) => ({
              member_key: `skills/${name}`,
              target_key: targetKey(subscription, `skills/${name}`),
              action: "create",
              reason: "source-changed",
              generation: 0,
              content_hash: hashes[index]!,
              candidate: frozen[index]!,
              accepted: frozen[index]!,
              deltas: [],
            })),
          }
          // Production freezes schema order before hashing, including nested manifest members.
          const {
            plan_id: _pendingId,
            plan_hash: _pendingHash,
            ...body
          } = strictDecode(UpstreamPlanSchema, {
            ...draft,
            plan_id: "pending",
            plan_hash: "pending",
          })
          const planHash = yield* sha256(JSON.stringify(body))
          const originalPlan: UpstreamPlan = {
            ...body,
            plan_id: `up_${planHash}`,
            plan_hash: planHash,
          }
          const operationId = `uo_${yield* sha256(originalPlan.plan_id)}`
          const publicationIds = yield* Effect.forEach(names, (_, index) =>
            sha256(`${operationId}:${index}`).pipe(Effect.map((hash) => `p_${hash}`)),
          )
          const originalOperation: UpstreamOperation = {
            operation_id: operationId,
            plan_id: originalPlan.plan_id,
            subscription_id: sub,
            scope,
            database_id: db,
            target_database_id: target,
            state: "unknown",
            items: names.map((name, index) =>
              index < 3
                ? {
                    member_key: `skills/${name}`,
                    status: "verified",
                    page_id: pageIds[index]!,
                    publication_operation_id: publicationIds[index]!,
                  }
                : {
                    member_key: `skills/${name}`,
                    status: "unknown",
                    publication_operation_id: publicationIds[index]!,
                    error_code: "WRITE_OUTCOME_UNKNOWN",
                  },
            ),
          }
          const historical: UpstreamOperation = {
            ...originalOperation,
            items: originalOperation.items.map((item, index) =>
              index < 2
                ? item
                : {
                    member_key: item.member_key,
                    status: "unknown",
                    publication_operation_id: item.publication_operation_id,
                    error_code: "WRITE_OUTCOME_UNKNOWN",
                  },
            ),
          }
          const mapFor = (count: number): PublishedMembers => ({
            version: 1,
            revision,
            plan_hash: planHash,
            publisher_subscription_id: sub,
            source_manifest: originalPlan.source_manifest,
            members: names.slice(0, count).map((name, index) => ({
              member_key: `skills/${name}`,
              page_id: pageIds[index]!,
              content_hash: hashes[index]!,
              revision,
            })),
          })
          const baseline = mapFor(2),
            laterMap = mapFor(3)
          subscriptionPage.properties["Published Members"] = rich(JSON.stringify(baseline))
          yield* store.upstream.savePlan(originalPlan)
          for (let index = 0; index < 3; index++) {
            const pageId = pageIds[index]!,
              id = publicationIds[index]!,
              portable = portables[index]!
            const ownership = {
              subscription_id: sub,
              member_key: names[index]!,
              mode: "tracked" as const,
              published_hash: hashes[index]!,
              revision,
            }
            const writing = yield* preparePublicationIntegrity(id, portable)
            const marker: CommittedMarker = {
              ...writing,
              state: "committed",
              revision: yield* sha256(`revision:${index}`),
              manifest_hash: yield* sha256(`manifest:${index}`),
              ownership_hash: yield* sha256(canonical(ownership)),
            }
            yield* store.integrity.update({
              version: 1,
              operation_id: id,
              intended_hash: writing.intended_hash,
              marker,
              page_id: pageId,
            })
            const receipt: Receipt = {
              format: 1,
              operation_id: id,
              operation: "create",
              state: "completed",
              scope,
              database_id: target,
              data_source_id: targetDs,
              page_id: pageId,
              context: { ownership },
              portable: {
                ...frozen[index]!,
                files: frozen[index]!.files.map((file) => ({ path: file.path, sha256: file.hash })),
              },
              guards: {},
              intents: [],
              stages: [],
              result: { operation_id: id, verified: true },
            }
            yield* store.writeJson(`publications/${id}.json`, receipt)
            rawPages.set(pageId, {
              id: pageId,
              parent: { data_source_id: targetDs },
              last_edited_time: "2026-10-21T18:13:30Z",
              properties: {
                Name: rich(names[index]!, "title"),
                Publication: rich(JSON.stringify(marker)),
                Upstream: { type: "relation", relation: [{ id: sub }] },
                "Upstream Key": rich(names[index]!),
                "Sync Mode": { type: "select", select: { name: "tracked" } },
                "Published Hash": rich(hashes[index]!),
                Revision: rich(revision),
                "Fork Baseline": rich(""),
              },
            })
            pages.set(pageId, {
              page_id: pageId,
              version: `member-version-${index}`,
              content_hash: hashes[index]!,
              portable,
              ownership,
            })
            const item = originalPlan.items[index]!
            yield* store.upstream.advance(
              {
                subscription_id: sub,
                member_key: item.member_key,
                target_key: item.target_key,
                page_id: pageId,
                generation: 1,
                active: true,
                mode: "tracked",
                revision,
                published_hash: hashes[index]!,
                accepted: frozen[index]!,
                materialized: frozen[index]!,
              },
              0,
              sub,
              originalOperation,
            )
          }
          yield* store.upstream.saveCommand(`${originalPlan.plan_id}:subscription-map`, {
            unpublished: true,
          })
          yield* store.upstream.saveCommand(
            `${originalPlan.plan_id}:subscription-map:intended`,
            laterMap,
          )
          const input: MapCheckpointAdoptionInput = {
            original_plan_id: originalPlan.plan_id,
            success_capture: {
              command: join(root, "command.json"),
              stdout: join(root, "stdout.json"),
              exit_code: join(root, "exit_code"),
              finished_at: join(root, "finished_at"),
            },
          }
          yield* fs.writeFileString(
            input.success_capture.command,
            JSON.stringify({
              argv: [
                "node",
                "packages/cli/dist/ntn-skills.js",
                "sync",
                "upstream",
                "apply",
                originalPlan.plan_id,
                "--member",
                "skills/beta",
              ],
              started_at: "2026-10-21T18:13:00Z",
            }),
          )
          yield* fs.writeFileString(
            input.success_capture.stdout,
            JSON.stringify({ ok: true, ...historical }),
          )
          yield* fs.writeFileString(input.success_capture.exit_code, "0\n")
          yield* fs.writeFileString(input.success_capture.finished_at, "2026-10-21T18:15:00Z\n")
          return yield* work({
            input,
            originalPlan,
            originalOperation,
            laterMap,
            subscriptionPage,
            rawPages,
            pages,
            hooks,
            inspections,
            writeAttempts,
          })
        }).pipe(
          Effect.provideService(Notion, notion),
          Effect.provideService(UpstreamPublisher, publisher),
        ),
      ).pipe(
        Effect.provide(StoreLive),
        Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerFetch)),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ),
    )
  } finally {
    vi.unstubAllEnvs()
  }
}

function originalHistory(fixture: Fixture) {
  return Effect.gen(function* () {
    const store = yield* Store
    const plan = fixture.originalPlan
    return {
      plan: yield* store.upstream.plan(plan.plan_id),
      operation: yield* store.upstream.operation(plan.plan_id),
      bindings: yield* store.upstream.bindings(sub),
      targets: yield* Effect.forEach(plan.items, (item) => store.upstream.target(item.target_key)),
      commands: yield* Effect.forEach(
        [
          `${plan.plan_id}:subscription-map`,
          `${plan.plan_id}:subscription-map:intended`,
          `${plan.plan_id}:accepted-config`,
          `${fixture.originalOperation.operation_id}:projections`,
        ],
        (key) => store.upstream.command(key),
      ),
      publications: yield* Effect.forEach(fixture.originalOperation.items, (item) =>
        store.readJson(
          `publications/${item.publication_operation_id}.json`,
          PublicationReceiptSchema,
        ),
      ),
      integrity: yield* Effect.forEach(fixture.originalOperation.items, (item) =>
        store.integrity.inspect(item.publication_operation_id!),
      ),
    }
  })
}
function noCommit(fixture: Fixture, planId: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    expect(yield* store.upstream.command(mapCheckpointAdoptionReceiptKey(planId))).toBeUndefined()
    expect(
      yield* store.upstream.command(`${fixture.originalPlan.plan_id}:subscription-map:checkpoint`),
    ).toBeUndefined()
    expect(fixture.writeAttempts).toEqual([])
  })
}

test("plan/apply adopts the complete historical map without changing original identities or remote pages", {
  timeout: 120_000,
}, async () => {
  await withFixture((fixture) =>
    Effect.gen(function* () {
      const store = yield* Store
      const before = yield* originalHistory(fixture)
      const remote = structuredClone({
        subscription: fixture.subscriptionPage,
        pages: [...fixture.rawPages],
      })
      const frozen = yield* planMapCheckpointAdoption(fixture.input)
      expect(frozen.member_count).toBe(2)
      expect(frozen.plan.native_inputs.commands.intended.members).toHaveLength(3)
      expect(frozen.plan.native_inputs.original_operation.items.at(-1)?.status).toBe("unknown")
      expect(yield* originalHistory(fixture)).toEqual(before)
      const result = yield* applyMapCheckpointAdoption(frozen.plan_id, frozen.plan_hash)
      expect(result.reused).toBe(false)
      expect(result.receipt.original_plan_id).toBe(fixture.originalPlan.plan_id)
      expect(result.receipt.original_operation_id).toBe(fixture.originalOperation.operation_id)
      expect(result.receipt.notion_writes).toBe(0)
      expect(
        yield* store.upstream.command(
          `${fixture.originalPlan.plan_id}:subscription-map:checkpoint`,
        ),
      ).toEqual(frozen.plan.checkpoint)
      expect(yield* originalHistory(fixture)).toEqual(before)
      expect({ subscription: fixture.subscriptionPage, pages: [...fixture.rawPages] }).toEqual(
        remote,
      )
      const advanced = {
        ...frozen.plan.checkpoint,
        version: "later-normal-apply",
        published: fixture.laterMap,
      }
      yield* store.upstream.saveCommand(
        `${fixture.originalPlan.plan_id}:subscription-map:checkpoint`,
        advanced,
      )
      yield* store.upstream.saveOperation({ ...fixture.originalOperation, state: "partial" })
      const afterProgress = yield* originalHistory(fixture),
        inspections = fixture.inspections.length
      expect((yield* applyMapCheckpointAdoption(frozen.plan_id, frozen.plan_hash)).reused).toBe(
        true,
      )
      expect(
        yield* store.upstream.command(
          `${fixture.originalPlan.plan_id}:subscription-map:checkpoint`,
        ),
      ).toEqual(advanced)
      expect(yield* originalHistory(fixture)).toEqual(afterProgress)
      expect(fixture.inspections).toHaveLength(inspections)
      expect(fixture.writeAttempts).toEqual([])
    }),
  )
})

test("any capture byte change invalidates the reviewed plan even when its parsed value is unchanged", {
  timeout: 120_000,
}, async () => {
  await withFixture((fixture) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const frozen = yield* planMapCheckpointAdoption(fixture.input)
      const before = yield* originalHistory(fixture)
      for (const path of Object.values(fixture.input.success_capture)) {
        const text = yield* fs.readFileString(path)
        yield* fs.writeFileString(path, text + " ")
        const rejected = yield* applyMapCheckpointAdoption(frozen.plan_id, frozen.plan_hash).pipe(
          Effect.result,
        )
        expect(rejected._tag).toBe("Failure")
        yield* noCommit(fixture, frozen.plan_id)
        yield* fs.writeFileString(path, text)
      }
      expect(yield* originalHistory(fixture)).toEqual(before)
    }),
  )
})

test("a retained recovery receipt cannot mask a corrupt current checkpoint", {
  timeout: 120_000,
}, async () => {
  await withFixture((fixture) =>
    Effect.gen(function* () {
      const store = yield* Store
      const frozen = yield* planMapCheckpointAdoption(fixture.input)
      yield* applyMapCheckpointAdoption(frozen.plan_id, frozen.plan_hash)
      const checkpointKey = `${fixture.originalPlan.plan_id}:subscription-map:checkpoint`
      const receiptKey = mapCheckpointAdoptionReceiptKey(frozen.plan_id)
      yield* store.upstream.saveCommand(checkpointKey, {})
      const before = yield* originalHistory(fixture)
      const receipt = yield* store.upstream.command(receiptKey)
      const inspections = fixture.inspections.length
      const rejected = yield* applyMapCheckpointAdoption(frozen.plan_id, frozen.plan_hash).pipe(
        Effect.result,
      )
      expect(rejected._tag).toBe("Failure")
      expect(yield* store.upstream.command(checkpointKey)).toEqual({})
      expect(yield* store.upstream.command(receiptKey)).toEqual(receipt)
      expect(yield* originalHistory(fixture)).toEqual(before)
      expect(fixture.inspections).toHaveLength(inspections)
      expect(fixture.writeAttempts).toEqual([])
    }),
  )
})

test.each(["missing-unknown-outcome", "incomplete-live-map", "later-live-map"])(
  "planning refuses %s instead of inferring a historical subset",
  async (changed) => {
    await withFixture((fixture) =>
      Effect.gen(function* () {
        const store = yield* Store,
          fs = yield* FileSystem.FileSystem
        if (changed === "missing-unknown-outcome") {
          const captured = property(
            JSON.parse(yield* fs.readFileString(fixture.input.success_capture.stdout)),
          )
          if (!Array.isArray(captured.items)) throw new Error("Invalid synthetic capture")
          yield* fs.writeFileString(
            fixture.input.success_capture.stdout,
            JSON.stringify({ ...captured, items: captured.items.slice(0, -1) }),
          )
        } else {
          const published = {
            ...fixture.laterMap,
            members: fixture.laterMap.members.slice(0, changed === "incomplete-live-map" ? 1 : 3),
          }
          fixture.subscriptionPage.properties["Published Members"] = rich(JSON.stringify(published))
        }
        const before = yield* originalHistory(fixture)
        const rejected = yield* planMapCheckpointAdoption(fixture.input).pipe(Effect.result)
        expect(rejected._tag).toBe("Failure")
        expect(
          yield* store.upstream.command(
            `${fixture.originalPlan.plan_id}:subscription-map:checkpoint`,
          ),
        ).toBeUndefined()
        expect(yield* originalHistory(fixture)).toEqual(before)
        expect(fixture.writeAttempts).toEqual([])
      }),
    )
  },
)

test.each([
  "subscription-version",
  "member-version",
  "member-ownership",
  "member-bytes",
  "extra-binding",
  "intended-map",
])("apply refuses %s drift before committing a baseline", async (changed) => {
  await withFixture((fixture) =>
    Effect.gen(function* () {
      const store = yield* Store
      const frozen = yield* planMapCheckpointAdoption(fixture.input)
      const page = fixture.pages.get(pageIds[0]!)!
      if (changed === "subscription-version")
        fixture.subscriptionPage.last_edited_time = "2026-10-21T18:14:30Z"
      else if (changed === "member-version")
        fixture.pages.set(page.page_id, { ...page, version: "changed-member-version" })
      else if (changed === "member-ownership")
        fixture.pages.set(page.page_id, {
          ...page,
          ownership: { ...page.ownership!, revision: "changed-revision" },
        })
      else if (changed === "member-bytes")
        fixture.pages.set(page.page_id, {
          ...page,
          portable: {
            ...page.portable,
            files: page.portable.files.map((file) =>
              file.path === "references/guide.md"
                ? { ...file, bytes: new TextEncoder().encode("External edit to a reference.\n") }
                : file,
            ),
          },
        })
      else if (changed === "extra-binding") {
        const binding = (yield* store.upstream.bindings(sub))[0]!
        yield* store.upstream.setMode(
          {
            ...binding,
            member_key: "skills/unplanned",
            target_key: "fixture:extra",
            page_id: pageIds[3]!,
          },
          0,
        )
      } else
        yield* store.upstream.saveCommand(
          `${fixture.originalPlan.plan_id}:subscription-map:intended`,
          { ...fixture.laterMap, revision: "changed-intended-revision" },
        )
      const before = yield* originalHistory(fixture)
      const rejected = yield* applyMapCheckpointAdoption(frozen.plan_id, frozen.plan_hash).pipe(
        Effect.result,
      )
      expect(rejected._tag).toBe("Failure")
      yield* noCommit(fixture, frozen.plan_id)
      expect(yield* originalHistory(fixture)).toEqual(before)
    }),
  )
})

test("a first member changed while reading the second member fails the final complete-set reread", async () => {
  await withFixture((fixture) =>
    Effect.gen(function* () {
      const frozen = yield* planMapCheckpointAdoption(fixture.input)
      const before = yield* originalHistory(fixture)
      fixture.hooks.onInspect = (id) => {
        if (id === pageIds[1])
          fixture.rawPages.get(pageIds[0]!)!.last_edited_time = "2026-10-21T18:14:20Z"
      }
      const rejected = yield* applyMapCheckpointAdoption(frozen.plan_id, frozen.plan_hash).pipe(
        Effect.result,
      )
      expect(rejected._tag).toBe("Failure")
      yield* noCommit(fixture, frozen.plan_id)
      expect(yield* originalHistory(fixture)).toEqual(before)
    }),
  )
})

test("a recomputed plan hash cannot authorize a checkpoint different from its proved live baseline", async () => {
  await withFixture((fixture) =>
    Effect.gen(function* () {
      const store = yield* Store
      const frozen = yield* planMapCheckpointAdoption(fixture.input)
      const { plan_id: _id, plan_hash: _hash, ...body } = frozen.plan
      const changed = {
        ...body,
        checkpoint: {
          ...body.checkpoint,
          published: {
            ...body.checkpoint.published,
            members: body.checkpoint.published.members.map((member) => ({
              ...member,
              content_hash: "f".repeat(64),
            })),
          },
        },
      }
      const hash = yield* sha256(canonical(changed))
      const plan = { ...changed, plan_id: `mca_${hash}`, plan_hash: hash }
      yield* store.upstream.saveCommand(mapCheckpointAdoptionPlanKey(plan.plan_id), plan)
      const before = yield* originalHistory(fixture)
      const rejected = yield* applyMapCheckpointAdoption(plan.plan_id, plan.plan_hash).pipe(
        Effect.result,
      )
      expect(rejected._tag).toBe("Failure")
      yield* noCommit(fixture, plan.plan_id)
      expect(yield* originalHistory(fixture)).toEqual(before)
    }),
  )
})
