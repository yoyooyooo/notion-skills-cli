import { expect, test } from "vitest"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { portableIdentity } from "../src/export.ts"
import { withLocalLocks } from "../src/local-locks.ts"
import { fail } from "../src/model.ts"
import type { PortableSkill } from "../src/portable.ts"
import { beginPublication } from "../src/publication.ts"
import { PublicationReceiptSchema } from "../src/publication-model.ts"
import { sha256, Store } from "../src/store.ts"
import {
  freezePortable,
  publicationMemberKey,
  subscriptionConfigHash,
  targetKey,
} from "../src/upstream-content.ts"
import {
  strictDecode,
  UpstreamPlanSchema,
  UpstreamPublisher,
  type UpstreamOperation,
  type UpstreamPlan,
} from "../src/upstream-model.ts"
import { recoverPrepublicationCreate } from "../src/upstream-prepublication-recovery.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { getSubscription } from "../src/upstream-subscription.ts"
import type { RouterFixture } from "./router-authoring.node.test.ts"

const database = "11111111-1111-4111-8111-111111111111"
const dataSource = "22222222-2222-4222-8222-222222222222"
const page = "33333333-3333-4333-8333-333333333333"
const subscriptionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const peerSubscriptionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const memberKey = "fixture/frozen"
const rich = (content: string) => ({
  type: "rich_text",
  rich_text: [{ plain_text: content, text: { content } }],
})

export function registerPrepublicationRecoveryTests(
  fixture: (upstream: boolean) => Promise<RouterFixture>,
) {
  async function interruptedCreate(
    f: RouterFixture,
    options: { error?: string; differentContent?: boolean } = {},
  ) {
    const portable: PortableSkill = {
      kind: "skill",
      name: "Frozen Mode Skill",
      description: "Use for mode recovery.",
      main: "SKILL.md",
      files: [
        {
          path: "SKILL.md",
          bytes: new TextEncoder().encode("# Frozen text\n\nRead [guide](references/guide.md).\n"),
        },
        {
          path: "references/guide.md",
          bytes: new TextEncoder().encode("# Own guide\n\nKeep these exact original bytes.\n"),
        },
      ],
    }
    const seeded = await f.run(
      Effect.gen(function* () {
        const state = yield* UpstreamState
        const subscription = yield* getSubscription(subscriptionId)
        const frozen = yield* freezePortable(portable)
        const hash = yield* portableIdentity(portable)
        const {
          plan_id: _id,
          plan_hash: _hash,
          ...body
        } = strictDecode(UpstreamPlanSchema, {
          version: 1,
          plan_id: "pending",
          plan_hash: "pending",
          created_at: 1,
          subscription_id: subscriptionId,
          subscription_version: subscription.version,
          scope: yield* authScope,
          database_id: subscription.database_id,
          config_hash: yield* subscriptionConfigHash(subscription),
          revision: "v1",
          source_manifest: {
            version: 1,
            source_id: subscriptionId,
            revision: "v1",
            members: [
              {
                member_key: memberKey,
                source_path: memberKey,
                main: portable.main,
                resources: frozen.files.map((file) => ({ path: file.path, sha256: file.hash })),
              },
            ],
          },
          provenance: { fixture: "retained-create" },
          publisher_subscription_id: subscriptionId,
          target_database_id: database,
          items: [
            {
              member_key: "fixture/earlier",
              target_key: targetKey(subscription, "fixture/earlier"),
              action: "conflict",
              reason: "Unselected earlier original index",
              generation: 0,
              deltas: [],
            },
            {
              member_key: memberKey,
              target_key: targetKey(subscription, memberKey),
              action: "create",
              reason: "source-changed",
              generation: 0,
              content_hash: hash,
              candidate: frozen,
              accepted: frozen,
              deltas: [],
            },
          ],
        })
        const planHash = yield* sha256(JSON.stringify(body))
        const plan: UpstreamPlan = { ...body, plan_id: `up_${planHash}`, plan_hash: planHash }
        const operationId = `uo_${yield* sha256(plan.plan_id)}`
        const alias = `${operationId}:1`
        const publicationId = `p_${yield* sha256(alias)}`
        const operation: UpstreamOperation = {
          operation_id: operationId,
          plan_id: plan.plan_id,
          subscription_id: subscriptionId,
          scope: plan.scope,
          database_id: plan.database_id,
          target_database_id: database,
          state: "running",
          items: [
            { member_key: "fixture/earlier", status: "conflict" },
            { member_key: memberKey, status: "running", publication_operation_id: alias },
          ],
        }
        yield* state.savePlan(plan)
        yield* state.saveOperation(operation)
        yield* state.saveCommand(`${plan.plan_id}:subscription-map`, { unpublished: true })
        return {
          plan,
          operation,
          alias,
          publicationId,
          request: {
            operation_id: alias,
            portable,
            target_database_id: database,
            ownership: {
              subscription_id: subscriptionId,
              member_key: publicationMemberKey(subscription, memberKey),
              mode: "tracked" as const,
              published_hash: hash,
              revision: "v1",
            },
          },
        }
      }),
    )
    let rejected = false
    f.beforeRequest(({ path, method }) => {
      if (!rejected && method === "GET" && path === `v1/data_sources/${dataSource}`) {
        rejected = true
        throw fail(options.error ?? "RATE_LIMITED", "Controlled read rejection before bind.")
      }
    })
    // The original live publisher prepares integrity and frozen objects itself.
    // No receipt, guard, creation proof or completed intent is fabricated.
    const initial = await f.run(
      Effect.gen(function* () {
        const actualPortable = options.differentContent
          ? {
              ...portable,
              files: portable.files.map((file) => ({
                ...file,
                bytes: new Uint8Array([...file.bytes, 32]),
              })),
            }
          : portable
        return yield* (yield* UpstreamPublisher).publish({
          ...seeded.request,
          portable: actualPortable,
          ownership: {
            ...seeded.request.ownership,
            published_hash: yield* portableIdentity(actualPortable),
          },
        })
      }).pipe(Effect.result),
    )
    expect(rejected).toBe(true)
    expect(initial).toMatchObject({
      _tag: "Failure",
      failure: { code: options.error ?? "RATE_LIMITED" },
    })
    if (initial._tag !== "Failure") throw new Error("Expected the controlled pre-bind failure")
    f.beforeRequest(() => {})
    const retained: UpstreamOperation = {
      ...seeded.operation,
      state: "unknown",
      items: seeded.operation.items.map((item, index) =>
        index === 1 ? { ...item, status: "unknown", error_code: initial.failure.code } : item,
      ),
    }
    await f.run(Effect.flatMap(UpstreamState, (state) => state.saveOperation(retained)))
    const evidence = await f.run(
      Effect.gen(function* () {
        const store = yield* Store
        return {
          receipt: yield* store.readJson(
            `publications/${seeded.publicationId}.json`,
            PublicationReceiptSchema,
          ),
          integrity: yield* store.integrity.inspect(seeded.publicationId),
        }
      }),
    )
    expect(f.writes).toEqual([])
    expect(evidence.receipt).toBeUndefined()
    expect(evidence.integrity).toMatchObject({
      operation_id: seeded.publicationId,
      marker: { state: "writing", operation_id: seeded.publicationId },
    })
    expect(evidence.integrity!.page_id).toBeUndefined()
    expect(evidence.integrity!.marker).not.toHaveProperty("creation")
    expect(evidence.integrity!.marker).not.toHaveProperty("base_revision")
    return { ...seeded, retained, integrity: evidence.integrity! }
  }

  const recover = (f: RouterFixture, plan: UpstreamPlan) =>
    f.run(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* withLocalLocks(
          store.root,
          [
            `upstream-plan:${plan.plan_id}`,
            `upstream-subscription:${plan.subscription_id}`,
            ...plan.items.map((item) => `upstream-target:${item.target_key}`),
          ],
          recoverPrepublicationCreate(plan.plan_id, 1),
        )
      }),
    )

  test("pre-bind RATE_LIMITED resumes the original frozen create at its original nonzero index", async () => {
    const f = await fixture(true)
    try {
      const original = await interruptedCreate(f)
      expect(await recover(f, original.plan)).toMatchObject({
        verified: true,
        page_id: page,
        content_hash: original.request.ownership.published_hash,
        publication_operation_id: original.publicationId,
      })
      const after = await f.run(
        Effect.gen(function* () {
          const store = yield* Store
          return {
            operation: yield* (yield* UpstreamState).operation(original.plan.plan_id),
            receipt: yield* store.readJson(
              `publications/${original.publicationId}.json`,
              PublicationReceiptSchema,
            ),
            integrity: yield* store.integrity.inspect(original.publicationId),
          }
        }),
      )
      expect(after.operation).toEqual(original.retained)
      expect(after.receipt).toMatchObject({
        operation_id: original.publicationId,
        operation: "create",
        state: "completed",
        context: { ownership: original.request.ownership },
      })
      expect(after.receipt!.portable.files).toEqual(
        original.plan.items[1]!.candidate!.files.map((file) => ({
          path: file.path,
          sha256: file.hash,
        })),
      )
      expect(after.integrity).toMatchObject({
        intended_hash: original.integrity.intended_hash,
        marker: { state: "committed", intended_hash: original.integrity.intended_hash },
      })
      const writes = f.writes.length
      expect(await recover(f, original.plan)).toBeUndefined()
      expect(f.writes).toHaveLength(writes)
      expect(f.sourceRequests).toEqual([])
    } finally {
      await f.close()
    }
  }, 30000)

  test.each([
    "different-error",
    "different-content",
    "different-alias",
    "changed-config",
    "changed-config-under-lock",
    "claimed-target",
    "published-member",
    "bound-receipt",
    "started-integrity",
  ])(
    "pre-bind recovery preserves the unknown create for %s",
    async (scenario) => {
      const f = await fixture(true)
      try {
        const original = await interruptedCreate(f, {
          ...(scenario === "different-error" ? { error: "NOTION_REQUEST_FAILED" } : {}),
          differentContent: scenario === "different-content",
        })
        if (scenario === "different-alias")
          await f.run(
            Effect.flatMap(UpstreamState, (state) =>
              state.saveOperation({
                ...original.retained,
                items: original.retained.items.map((item, index) =>
                  index === 1
                    ? { ...item, publication_operation_id: `${original.alias}:other` }
                    : item,
                ),
              }),
            ),
          )
        if (scenario === "changed-config")
          f.subscriptionProperties.Include = rich(JSON.stringify(["different/**"]))
        if (scenario === "changed-config-under-lock") {
          let scopeReads = 0
          f.beforeRequest(({ path }) => {
            if (path === "v1/users/me" && ++scopeReads === 2)
              f.subscriptionProperties.Include = rich(JSON.stringify(["different/**"]))
          })
        }
        if (scenario === "claimed-target")
          await f.run(
            Effect.gen(function* () {
              const state = yield* UpstreamState
              const peerMember = "another/contributor"
              const { plan_id: _id, plan_hash: _hash, ...originalBody } = original.plan
              const body = {
                ...originalBody,
                subscription_id: peerSubscriptionId,
                source_manifest: {
                  ...original.plan.source_manifest!,
                  source_id: peerSubscriptionId,
                  members: original.plan.source_manifest!.members.map((member) => ({
                    ...member,
                    member_key: peerMember,
                  })),
                },
                items: [{ ...original.plan.items[1]!, member_key: peerMember }],
              }
              const planHash = yield* sha256(JSON.stringify(body))
              const plan: UpstreamPlan = { ...body, plan_id: `up_${planHash}`, plan_hash: planHash }
              const operationId = `uo_${yield* sha256(plan.plan_id)}`
              const alias = `${operationId}:0`
              const pending: UpstreamOperation = {
                operation_id: operationId,
                plan_id: plan.plan_id,
                subscription_id: peerSubscriptionId,
                scope: plan.scope,
                database_id: plan.database_id,
                target_database_id: database,
                state: "running",
                items: [
                  { member_key: peerMember, status: "running", publication_operation_id: alias },
                ],
              }
              yield* state.savePlan(plan)
              yield* state.saveOperation(pending)
              // A separate contributor really publishes the shared target before
              // its verified outcome is allowed to advance a binding.
              const published = yield* (yield* UpstreamPublisher).publish({
                ...original.request,
                operation_id: alias,
              })
              expect(published).toMatchObject({ verified: true, page_id: page })
              yield* state.advance(
                {
                  subscription_id: peerSubscriptionId,
                  member_key: peerMember,
                  target_key: original.plan.items[1]!.target_key,
                  page_id: published.page_id,
                  generation: 1,
                  mode: "tracked",
                  active: true,
                  revision: plan.revision,
                  published_hash: published.content_hash,
                  accepted: original.plan.items[1]!.accepted!,
                  materialized: original.plan.items[1]!.candidate!,
                },
                0,
                subscriptionId,
                {
                  ...pending,
                  state: "verified",
                  items: [
                    {
                      member_key: peerMember,
                      status: "verified",
                      page_id: published.page_id,
                      publication_operation_id: published.publication_operation_id,
                    },
                  ],
                },
              )
              expect(yield* state.bindings(subscriptionId)).toEqual([])
              expect(yield* state.operation(original.plan.plan_id)).toEqual(original.retained)
              expect(yield* state.target(original.plan.items[1]!.target_key)).toMatchObject({
                page_id: published.page_id,
                publisher_subscription_id: subscriptionId,
              })
            }),
          )
        if (scenario === "published-member")
          f.subscriptionProperties["Published Members"] = rich(
            JSON.stringify({
              version: 1,
              revision: "v1",
              plan_hash: original.plan.plan_hash,
              publisher_subscription_id: subscriptionId,
              members: [
                {
                  member_key: memberKey,
                  page_id: page,
                  content_hash: original.request.ownership.published_hash,
                },
              ],
            }),
          )
        if (scenario === "bound-receipt")
          await f.run(
            Effect.gen(function* () {
              const session = yield* beginPublication(original.request.portable, "create", {
                operationId: original.publicationId,
                ownership: original.request.ownership,
              })
              yield* session.bind(
                { database_id: database, data_source_id: dataSource },
                yield* authScope,
              )
            }),
          )
        if (scenario === "started-integrity")
          await f.run(
            Effect.flatMap(Store, (store) =>
              store.integrity.update({
                ...original.integrity,
                marker: {
                  version: 2,
                  state: "writing",
                  operation_id: original.publicationId,
                  intended_hash: original.integrity.intended_hash,
                  base_revision: "a".repeat(64),
                },
              }),
            ),
          )
        const readEvidence = Effect.gen(function* () {
          const store = yield* Store
          return {
            operation: yield* (yield* UpstreamState).operation(original.plan.plan_id),
            receipt: yield* store.readJson(
              `publications/${original.publicationId}.json`,
              PublicationReceiptSchema,
            ),
            integrity: yield* store.integrity.inspect(original.publicationId),
            bindings: yield* (yield* UpstreamState).bindings(subscriptionId),
            peerBindings: yield* (yield* UpstreamState).bindings(peerSubscriptionId),
            target: yield* (yield* UpstreamState).target(original.plan.items[1]!.target_key),
          }
        })
        const before = await f.run(readEvidence)
        const writes = f.writes.length
        if (scenario === "claimed-target") expect(writes).toBeGreaterThan(0)
        else expect(writes).toBe(0)
        expect(await recover(f, original.plan)).toBeUndefined()
        expect(await f.run(readEvidence)).toEqual(before)
        expect(f.writes).toHaveLength(writes)
        expect(f.sourceRequests).toEqual([])
      } finally {
        await f.close()
      }
    },
    30000,
  )
}
