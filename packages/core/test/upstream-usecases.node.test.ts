import { expect, test, vi } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { ConfigProvider, Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { tmpdir } from "node:os"
import { sha256, Store, StoreLive } from "../src/store.ts"
import { Notion } from "../src/notion.ts"
import { portableIdentity } from "../src/export.ts"
import { fail, property } from "../src/model.ts"
import {
  UpstreamPublisher,
  type ManagedContent,
  type PublishRequest,
} from "../src/upstream-model.ts"
import type { PortableSkill } from "../src/portable.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { applyUpstream } from "../src/upstream-apply.ts"
import { forkUpstream, trackUpstream } from "../src/upstream-conversion.ts"
import { getSubscription } from "../src/upstream-subscription.ts"
import {
  listUpstreamOperations,
  reconcileUpstreamOperation,
  resumeUpstreamOperation,
  showUpstreamOperation,
} from "../src/upstream-operations.ts"
import { planUpstream } from "../src/upstream-plan.ts"
import { connectGitUpstream, runUpstreams } from "../src/upstream.ts"
import {
  strictDecode,
  UpstreamPlanSchema,
  UpstreamPublicOperationSchema,
} from "../src/upstream-model.ts"

const sub = "11111111-1111-4111-8111-111111111111"
const db = "22222222-2222-4222-8222-222222222222"
const ds = "33333333-3333-4333-8333-333333333333"
const target = "44444444-4444-4444-8444-444444444444"
const targetDs = "55555555-5555-4555-8555-555555555555"
const rich = (value: string, type = "rich_text") => ({
  ...(type === "title" ? { id: "title" } : {}),
  type,
  [type]: [{ plain_text: value }],
})
const skill = (body: string) =>
  `---\nname: alpha\ndescription: Use for controlled upstream workflows\n---\n\n${body}\n`

const upstreamUseCases = [
  {
    scenario: "connect",
    name: "Git connect registers once, initializes with HEAD defaults, and reuses its accepted subscription",
  },
  {
    scenario: "normal",
    name: "real Git and SQLite run frozen plans, retain missing pages, protect edits and recover explicit fork/track",
    // Full lifecycle crosses five run boundaries plus fork/track and retention.
    timeout: 120_000,
  },
  {
    scenario: "metadata-loss",
    name: "explicit frozen apply resumes the original known-page metadata child after transport loss",
  },
  {
    scenario: "run-metadata-loss",
    name: "daily run resumes the original known-page publication before discovering a new source plan",
  },
  {
    scenario: "unknown-create",
    name: "explicit frozen apply never replays an unknown create child",
  },
  {
    scenario: "member-selection",
    name: "exact member selection publishes only the selected text member and rejects invalid keys before writes",
  },
  {
    scenario: "member-selection-unknown",
    name: "member selection preserves an unselected unknown create without reconciliation or replay",
  },
  {
    scenario: "member-selection-map-loss",
    name: "member selection does not activate an unselected advanced binding or prematurely accept the whole revision",
  },
  {
    scenario: "member-selection-map-patch-loss",
    name: "a later selected map PATCH loss preserves the exact acknowledged partial map for retry",
  },
  {
    scenario: "member-selection-map-response-loss",
    name: "a later selected map response loss accepts its intended readback without replaying children",
  },
  {
    scenario: "member-selection-retain",
    name: "member selection preserves an unselected retained member and its old effective revision",
  },
  {
    scenario: "member-selection-retain-map-loss",
    name: "member selection does not accept a retained binding until its old active mapping is explicitly removed",
  },
  {
    scenario: "shared-manifest",
    name: "shared target projection preserves the peer source manifest and never copies the contributor manifest",
  },
  {
    scenario: "legacy-plan",
    name: "legacy frozen plans publish without borrowing an existing source manifest",
  },
  {
    scenario: "mismatched-manifest",
    name: "a manifest from another revision is not attached to the published active map",
  },
  {
    scenario: "foreign-manifest",
    name: "a manifest from another subscribed source is not attached to the published active map",
  },
]
for (const { scenario, name, timeout = 60_000 } of upstreamUseCases)
  test(
    name,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ntn-upstream-usecases-"))
      const repo = join(root, "repo")
      await mkdir(join(repo, "skills/alpha"), { recursive: true })
      await mkdir(join(repo, "skills/alpha/references"), { recursive: true })
      await writeFile(join(repo, "skills/alpha/references/guide.md"), "Original guide\n")
      const binaryAttachment = new Uint8Array([0, 255, 1, 2])
      if (scenario === "member-selection")
        await writeFile(join(repo, "skills/alpha/references/attachment.bin"), binaryAttachment)
      const multipleMembers =
        scenario === "unknown-create" || scenario.startsWith("member-selection")
      if (multipleMembers) {
        await mkdir(join(repo, "skills/beta"), { recursive: true })
        await writeFile(
          join(repo, "skills/beta/SKILL.md"),
          skill("beta").replace("name: alpha", "name: beta"),
        )
      }
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.test",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.test",
          },
        }).trim()
      git("init", "-b", "main")
      const put = async (body: string) => {
        await writeFile(join(repo, "skills/alpha/SKILL.md"), skill(body))
        git("add", ".")
        git("commit", "--no-gpg-sign", "-m", body)
        return git("rev-parse", "HEAD")
      }
      const first = await put("first")
      vi.stubEnv("NTN_SKILLS_HOME", join(root, "state"))
      vi.stubEnv("NTN_SKILLS_CONFIG_HOME", join(root, "config"))
      vi.stubEnv("NTN_SKILLS_CACHE_HOME", join(root, "cache"))
      const pages = new Map<string, ManagedContent>(),
        baselines = new Map<string, PortableSkill>()
      const receipts = new Map<
        string,
        {
          page_id: string
          version: string
          content_hash: string
          publication_operation_id: string
          verified: true
        }
      >()
      let clock = 0,
        subscriptionClock = 0,
        writes = 0,
        modeWrites = 0
      let authUser = "fixture-user"
      let subscriptionExists = scenario !== "connect"
      let subscriptionCreates = 0
      let losePublication = ["unknown-create", "member-selection-unknown"].includes(scenario)
      let lostRequest: PublishRequest | undefined
      let publicationCalls = 0
      let resumeBeforeInspect = false
      const childEvents: string[] = []
      const inspections: string[] = []
      const peer = "77777777-7777-4777-8777-777777777777"
      let peerProps: Record<string, unknown> | undefined
      let peerClock = 0
      const props: Record<string, unknown> = {
        Name: rich("controlled", "title"),
        Description: rich("controlled source"),
        Source: rich(
          JSON.stringify({
            provider: { type: "git", url: repo, ref: "main" },
            ...(scenario === "shared-manifest" || scenario.startsWith("member-selection")
              ? {
                  shared_target_set: "manifest-shared-target",
                  publisher_subscription_id: sub,
                  accepted_ref: first,
                }
              : {}),
          }),
        ),
        Ref: rich("main"),
        Roots: rich('["skills"]'),
        Include: rich("[]"),
        Exclude: rich("[]"),
        Mapping: rich("{}"),
        "Published Members": rich(""),
        "Target Database ID": rich(target),
        "Source URL": { type: "url", url: null },
        Enabled: { type: "checkbox", checkbox: true },
        "Default Context": { type: "checkbox", checkbox: false },
        Status: { type: "select", select: { name: "pending" } },
        "Sync Status": { type: "select", select: null },
        "Last Sync Attempt": { type: "date", date: null },
        "Last Synced": { type: "date", date: null },
        "Sync Summary": rich(""),
      }
      const row = () => ({
        id: sub,
        parent: { data_source_id: ds },
        last_edited_time: String(subscriptionClock),
        properties: props,
      })
      const peerRow = () => ({
        id: peer,
        parent: { data_source_id: ds },
        last_edited_time: String(peerClock),
        properties: peerProps!,
      })
      const notion = Notion.of({
        version: Effect.succeed("fixture"),
        credentialIdentity: Effect.succeed("fixture"),
        request: (path, body, options) =>
          Effect.sync(() => {
            if (path === "v1/users/me") return { id: authUser, object: "user" }
            if (path === `v1/data_sources/${ds}/query`)
              return {
                results: [
                  ...(subscriptionExists ? [row()] : []),
                  ...(peerProps ? [peerRow()] : []),
                ],
                has_more: false,
                next_cursor: null,
              }
            if (path === `v1/blocks/${sub}/children?page_size=100`)
              return { results: [], has_more: false, next_cursor: null }
            if (path === `v1/databases/${db}` || path === `v1/databases/${target}`)
              return {
                id: path.endsWith(db) ? db : target,
                database_type: null,
                title: [],
                data_sources: [{ id: path.endsWith(db) ? ds : targetDs, name: "fixture" }],
              }
            if (path === `v1/data_sources/${ds}` || path === `v1/data_sources/${targetDs}`)
              return {
                id: path.endsWith(ds) ? ds : targetDs,
                parent: { database_id: path.endsWith(ds) ? db : target },
                title: [],
                properties: {
                  ...Object.fromEntries(
                    [...Object.keys(props), "Upstream", "Upstream Key"].map((name) => [
                      name,
                      {
                        id: name === "Name" ? "title" : name,
                        type:
                          property(props[name]).type ??
                          (name === "Upstream" ? "relation" : "rich_text"),
                      },
                    ]),
                  ),
                  ...(path.endsWith(targetDs)
                    ? { References: { id: "references", type: "rich_text" } }
                    : {}),
                },
              }
            if (path === `v1/data_sources/${targetDs}/query`)
              return { results: [], has_more: false, next_cursor: null }
            if (path === "v1/pages" && options?.method === "POST") {
              subscriptionCreates++
              subscriptionExists = true
              for (const [name, raw] of Object.entries(property(property(body).properties))) {
                const value = property(raw),
                  type = Object.keys(value)[0]!,
                  parts = value[type]
                props[name === "title" ? "Name" : name] = {
                  ...(name === "title" ? { id: "title" } : {}),
                  type,
                  ...value,
                  ...(Array.isArray(parts)
                    ? {
                        [type]: parts.map((part) => ({
                          plain_text: String(property(property(part).text).content ?? ""),
                        })),
                      }
                    : {}),
                }
              }
              subscriptionClock++
              return row()
            }
            if (path === `v1/pages/${sub}` || (peerProps && path === `v1/pages/${peer}`)) {
              const currentProps = path.endsWith(sub) ? props : peerProps!
              if (options?.method === "PATCH") {
                for (const [name, raw] of Object.entries(property(property(body).properties))) {
                  const p = property(raw),
                    type = Object.keys(p)[0]!
                  const values = p[type]
                  const propertyName = name === "title" ? "Name" : name
                  currentProps[propertyName] = {
                    ...(propertyName === "Name" ? { id: "title" } : {}),
                    type,
                    ...p,
                    ...(type === "date" && p.date
                      ? {
                          date: {
                            ...property(p.date),
                            start: new Date(
                              Math.floor(Date.parse(String(property(p.date).start)) / 60_000) *
                                60_000,
                            )
                              .toISOString()
                              .replace("Z", "+00:00"),
                          },
                        }
                      : {}),
                    ...(Array.isArray(values)
                      ? {
                          [type]: values.map((part: unknown) => ({
                            plain_text: String(property(property(part).text).content ?? ""),
                          })),
                        }
                      : {}),
                  }
                }
                if (path.endsWith(sub)) subscriptionClock++
                else peerClock++
              }
              return path.endsWith(sub) ? row() : peerRow()
            }
            const member = /^v1\/pages\/([^/]+)$/.exec(path)?.[1]
            if (member && pages.has(member)) return { id: member, in_trash: false, properties: {} }
            throw new Error(`Unexpected Notion metadata request: ${path}`)
          }),
      })
      const publisher = UpstreamPublisher.of({
        inspect: (id) =>
          Effect.sync(() => {
            inspections.push(id)
            if (resumeBeforeInspect)
              throw new Error("Complete inspection preceded retained-child resume")
            const page = pages.get(id)
            if (!page) throw new Error("Missing controlled page")
            return structuredClone(page)
          }),
        publish: (request) =>
          Effect.gen(function* () {
            publicationCalls++
            childEvents.push(`publish:${request.operation_id}`)
            if (losePublication) {
              losePublication = false
              lostRequest = structuredClone(request)
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Metadata PATCH transport lost before application"),
              )
            }
            if (lostRequest?.operation_id === request.operation_id) {
              expect(request.resume_only).toBe(true)
              const { portable: actualPortable, ...actualMetadata } = request
              const { portable: originalPortable, ...originalMetadata } = lostRequest
              expect(actualMetadata).toEqual({ ...originalMetadata, resume_only: true })
              expect({
                ...actualPortable,
                files: actualPortable.files.map((file) => ({
                  ...file,
                  bytes: Array.from(file.bytes),
                })),
              }).toEqual({
                ...originalPortable,
                files: originalPortable.files.map((file) => ({
                  ...file,
                  bytes: Array.from(file.bytes),
                })),
              })
              resumeBeforeInspect = false
            }
            if (receipts.has(request.operation_id)) return receipts.get(request.operation_id)!
            const old = request.expected && pages.get(request.expected.page_id)
            if (
              request.expected &&
              (!old ||
                old.version !== request.expected.version ||
                old.content_hash !== request.expected.hash)
            )
              return yield* Effect.fail(
                fail("WRITE_CONFLICT", "Controlled publisher version mismatch"),
              )
            const hash = yield* portableIdentity(request.portable)
            if (hash !== request.ownership.published_hash)
              return yield* Effect.fail(
                fail("UPSTREAM_UNVERIFIED", "Controlled publisher recomputed a different hash"),
              )
            if (
              old &&
              old.content_hash === hash &&
              isDeepStrictEqual(old.ownership, request.ownership)
            ) {
              const reused = [...receipts.values()].find(
                (receipt) => receipt.page_id === old.page_id && receipt.version === old.version,
              )
              if (!reused)
                throw new Error("Controlled publisher is missing its verified existing receipt")
              receipts.set(request.operation_id, reused)
              return reused
            }
            const id = old
              ? old.page_id
              : `66666666-6666-4666-8666-${String(pages.size + 1).padStart(12, "0")}`
            const version = String(++clock)
            pages.set(id, {
              page_id: id,
              version,
              content_hash: hash,
              portable: structuredClone(request.portable),
              ownership: structuredClone(request.ownership),
            })
            writes++
            const receipt = {
              page_id: id,
              version,
              content_hash: hash,
              publication_operation_id: request.operation_id,
              verified: true as const,
            }
            receipts.set(request.operation_id, receipt)
            return receipt
          }).pipe(Effect.provide(NodeServices.layer)),
        reconcile: (id) =>
          Effect.sync(() => {
            childEvents.push(`reconcile:${id}`)
            return receipts.get(id)
          }),
        setMode: (request) =>
          Effect.sync(() => {
            const current = pages.get(request.page_id)!
            if (current.version !== request.expected_version)
              throw new Error("Mode version mismatch")
            pages.set(request.page_id, {
              ...current,
              version: String(++clock),
              ownership: {
                ...current.ownership!,
                mode: request.mode,
                ...(request.fork_baseline ? { fork_baseline: request.fork_baseline } : {}),
                ...(request.published_hash ? { published_hash: request.published_hash } : {}),
                ...(request.revision ? { revision: request.revision } : {}),
              },
            })
            modeWrites++
          }),
        recoverableBaseline: (_id, _version, accepted) =>
          Effect.sync(() => {
            if (!accepted) throw new Error("Expected accepted baseline")
            const ref = `fixture-baseline:${accepted.content_hash}`
            baselines.set(ref, structuredClone(accepted.portable))
            return ref
          }),
        readBaseline: (ref) =>
          Effect.sync(() => {
            const value = baselines.get(ref)
            if (!value) throw new Error("Missing baseline")
            return structuredClone(value)
          }),
      })
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const store = yield* Store
              expect(store.root).toBe(join(root, "state"))
              yield* store.writeJson("config.json", { upstream_database: db })
              yield* Effect.gen(function* () {
                if (scenario === "connect") {
                  const connected = yield* connectGitUpstream(repo, {
                    database: target,
                    name: "Daily source",
                    description: "Preserve my display metadata.",
                  })
                  expect(connected.verified).toBe(true)
                  expect(connected.reused).toBe(false)
                  expect(connected.subscription.source.provider).toMatchObject({
                    type: "git",
                    ref: "HEAD",
                    url: repo,
                  })
                  expect(connected.subscription.roots).toEqual(["."])
                  expect(connected.subscription.include).toEqual([])
                  expect(connected.subscription.status).toBe("verified")
                  expect(connected.subscription.sync?.status).toBe("succeeded")
                  expect(connected.subscription.published?.members).toHaveLength(1)
                  expect(connected.subscription.published?.revision).toBe(first)
                  expect(connected.subscription.published?.source_manifest?.revision).toBe(first)
                  expect(subscriptionCreates).toBe(1)
                  expect(writes).toBe(1)
                  const repeated = yield* connectGitUpstream(repo, { database: target })
                  expect(repeated.verified).toBe(true)
                  expect(repeated.reused).toBe(true)
                  expect(repeated.subscription.subscription_id).toBe(
                    connected.subscription.subscription_id,
                  )
                  expect(repeated.subscription.name).toBe("Daily source")
                  expect(repeated.subscription.description).toBe("Preserve my display metadata.")
                  expect(subscriptionCreates).toBe(1)
                  expect(writes).toBe(1)
                  props.Roots = rich('["skills"]')
                  const changed = yield* connectGitUpstream(repo, { database: target }).pipe(
                    Effect.result,
                  )
                  expect(changed).toMatchObject({
                    _tag: "Failure",
                    failure: { code: "UPSTREAM_OPERATION_MISMATCH" },
                  })
                  expect(subscriptionCreates).toBe(1)
                  expect(writes).toBe(1)
                  return
                }
                const frozen = yield* planUpstream(sub)
                expect(frozen.revision).toBe(first)
                expect(frozen.items[0]?.action).toBe("create")
                const persisted = yield* store.upstream.plan(frozen.plan_id)
                expect(persisted).toEqual(frozen)
                const expectedManifestMembers = [
                  {
                    member_key: "skills/alpha",
                    source_path: "skills/alpha",
                    main: "SKILL.md",
                    resources: [
                      { path: "SKILL.md", sha256: yield* sha256(skill("first")) },
                      { path: "references/guide.md", sha256: yield* sha256("Original guide\n") },
                    ],
                  },
                ]
                if (scenario === "member-selection")
                  expectedManifestMembers[0]!.resources.splice(1, 0, {
                    path: "references/attachment.bin",
                    sha256: yield* sha256(binaryAttachment),
                  })
                if (multipleMembers)
                  expectedManifestMembers.push({
                    member_key: "skills/beta",
                    source_path: "skills/beta",
                    main: "SKILL.md",
                    resources: [
                      {
                        path: "SKILL.md",
                        sha256: yield* sha256(skill("beta").replace("name: alpha", "name: beta")),
                      },
                    ],
                  })
                expect(frozen.source_manifest).toEqual({
                  version: 1,
                  source_id: sub,
                  revision: first,
                  members: expectedManifestMembers,
                })
                const tampered = { ...persisted!, revision: "tampered-revision" }
                const rejectedTamper = yield* applyUpstream(frozen.plan_id).pipe(
                  Effect.provideService(UpstreamState, {
                    ...store.upstream,
                    plan: (id) =>
                      id === frozen.plan_id ? Effect.succeed(tampered) : store.upstream.plan(id),
                  }),
                  Effect.result,
                )
                expect(rejectedTamper._tag).toBe("Failure")
                if (rejectedTamper._tag === "Failure")
                  expect(rejectedTamper.failure.code).toBe("STATE_CORRUPT")
                expect(writes).toBe(0)
                expect(yield* store.upstream.operation(frozen.plan_id)).toBeUndefined()
                expect(yield* store.upstream.plan(frozen.plan_id)).toEqual(frozen)
                const originalSource = props.Source
                props.Source = rich(
                  JSON.stringify({
                    provider: { type: "git", url: `${repo}-changed`, ref: "main" },
                  }),
                )
                const rejectedDrift = yield* applyUpstream(frozen.plan_id).pipe(Effect.result)
                expect(rejectedDrift._tag).toBe("Failure")
                if (rejectedDrift._tag === "Failure")
                  expect(rejectedDrift.failure.code).toBe("UPSTREAM_PLAN_STALE")
                expect(writes).toBe(0)
                expect(yield* store.upstream.operation(frozen.plan_id)).toBeUndefined()
                props.Source = originalSource
                const second = yield* Effect.promise(() => put("second"))
                if (
                  [
                    "member-selection-map-patch-loss",
                    "member-selection-map-response-loss",
                  ].includes(scenario)
                ) {
                  const selectedPlan = yield* planUpstream(sub)
                  const firstPartial = yield* applyUpstream(selectedPlan.plan_id, ["skills/beta"])
                  expect(firstPartial.state).toBe("partial")
                  const acknowledged = yield* getSubscription(sub)
                  expect(
                    acknowledged.published?.members.map((member) => member.member_key),
                  ).toEqual(["skills/beta"])
                  const checkpointKey = `${selectedPlan.plan_id}:subscription-map:checkpoint`
                  const checkpoint = {
                    subscription_id: sub,
                    version: acknowledged.version,
                    published: acknowledged.published,
                  }
                  expect(yield* store.upstream.command(checkpointKey)).toEqual(checkpoint)
                  const responseLost = scenario === "member-selection-map-response-loss"
                  const lostMap = yield* applyUpstream(selectedPlan.plan_id, ["skills/alpha"]).pipe(
                    Effect.provideService(Notion, {
                      ...notion,
                      request: (path, body, options) => {
                        if (path !== `v1/pages/${sub}` || options?.method !== "PATCH")
                          return notion.request(path, body, options)
                        const lost = Effect.fail(
                          fail(
                            "WRITE_OUTCOME_UNKNOWN",
                            "Controlled subscription map transport loss",
                          ),
                        )
                        return responseLost
                          ? notion.request(path, body, options).pipe(Effect.andThen(lost))
                          : lost
                      },
                    }),
                    Effect.result,
                  )
                  expect(lostMap._tag).toBe("Failure")
                  if (lostMap._tag === "Failure")
                    expect(lostMap.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
                  expect(yield* store.upstream.command(checkpointKey)).toEqual(checkpoint)
                  expect((yield* getSubscription(sub)).published?.members).toHaveLength(
                    responseLost ? 2 : 1,
                  )
                  expect(
                    (yield* store.upstream.operation(selectedPlan.plan_id))?.items.map(
                      (item) => item.status,
                    ),
                  ).toEqual(["verified", "verified"])
                  expect(writes).toBe(2)
                  childEvents.length = 0
                  if (!responseLost) {
                    // Legacy receipts have no retained intermediate readback: a subset alone
                    // cannot authorize recovery of a map absent from saved/intended evidence.
                    const legacy = yield* applyUpstream(selectedPlan.plan_id, [
                      "skills/alpha",
                    ]).pipe(
                      Effect.provideService(UpstreamState, {
                        ...store.upstream,
                        command: (id) =>
                          id === checkpointKey
                            ? Effect.succeed(undefined)
                            : store.upstream.command(id),
                      }),
                      Effect.result,
                    )
                    expect(legacy._tag).toBe("Failure")
                    if (legacy._tag === "Failure")
                      expect(legacy.failure.code).toBe("UPSTREAM_PLAN_STALE")
                    // Identical content with a different subscription version is not the
                    // exact acknowledged before value retained by this checkpoint.
                    subscriptionClock++
                    const changedVersion = yield* applyUpstream(selectedPlan.plan_id, [
                      "skills/alpha",
                    ]).pipe(Effect.result)
                    expect(changedVersion._tag).toBe("Failure")
                    if (changedVersion._tag === "Failure")
                      expect(changedVersion.failure.code).toBe("UPSTREAM_PLAN_STALE")
                    subscriptionClock--
                    expect(childEvents).toEqual([])
                    expect(writes).toBe(2)
                  }
                  const beforeRetryClock = subscriptionClock
                  const completed = yield* applyUpstream(selectedPlan.plan_id, ["skills/alpha"])
                  expect(completed.operation_id).toBe(firstPartial.operation_id)
                  expect(completed.state).toBe("verified")
                  expect(childEvents).toEqual([])
                  expect(writes).toBe(2)
                  expect(subscriptionClock - beforeRetryClock).toBe(responseLost ? 1 : 2)
                  expect((yield* getSubscription(sub)).published?.members).toHaveLength(2)
                  expect((yield* getSubscription(sub)).source.accepted_ref).toBe(second)
                  expect(yield* store.upstream.plan(selectedPlan.plan_id)).toEqual(selectedPlan)
                  return
                }
                if (
                  [
                    "member-selection",
                    "member-selection-unknown",
                    "member-selection-map-loss",
                  ].includes(scenario)
                ) {
                  const selectedPlan = yield* planUpstream(sub)
                  expect(selectedPlan.revision).toBe(second)
                  for (const keys of [
                    [],
                    [""],
                    ["skills/missing"],
                    ["skills/beta", "skills/missing"],
                  ]) {
                    const beforeClock = subscriptionClock
                    const invalid = yield* applyUpstream(selectedPlan.plan_id, keys).pipe(
                      Effect.result,
                    )
                    expect(invalid._tag).toBe("Failure")
                    if (invalid._tag === "Failure")
                      expect(invalid.failure.code).toBe("INVALID_ARGUMENT")
                    expect(subscriptionClock).toBe(beforeClock)
                    expect(yield* store.upstream.operation(selectedPlan.plan_id)).toBeUndefined()
                    expect(writes).toBe(0)
                    expect(childEvents).toEqual([])
                  }
                  if (scenario === "member-selection-unknown") {
                    const firstAttempt = yield* applyUpstream(selectedPlan.plan_id, [
                      "skills/alpha",
                    ])
                    expect(firstAttempt.items.map((item) => item.status)).toEqual([
                      "unknown",
                      "pending",
                    ])
                    expect(writes).toBe(0)
                  }
                  if (scenario === "member-selection-map-loss") {
                    const lostMap = yield* applyUpstream(selectedPlan.plan_id, [
                      "skills/alpha",
                    ]).pipe(
                      Effect.provideService(UpstreamState, {
                        ...store.upstream,
                        saveCommand: (id, input) =>
                          id === `${selectedPlan.plan_id}:subscription-map:intended`
                            ? Effect.fail(
                                fail("WRITE_OUTCOME_UNKNOWN", "Controlled map checkpoint loss"),
                              )
                            : store.upstream.saveCommand(id, input),
                      }),
                      Effect.result,
                    )
                    expect(lostMap._tag).toBe("Failure")
                    expect(
                      (yield* store.upstream.bindings(sub)).map((binding) => binding.member_key),
                    ).toEqual(["skills/alpha"])
                    expect((yield* getSubscription(sub)).published).toBeNull()
                  }
                  const before = yield* store.upstream.operation(selectedPlan.plan_id)
                  childEvents.length = 0
                  inspections.length = 0
                  const selected = yield* applyUpstream(selectedPlan.plan_id, ["skills/beta"])
                  expect(selected.operation_id).toBe(`uo_${yield* sha256(selectedPlan.plan_id)}`)
                  expect(selected.items.map((item) => item.member_key)).toEqual([
                    "skills/alpha",
                    "skills/beta",
                  ])
                  expect(selected.items[0]).toEqual(
                    before?.items[0] ?? {
                      member_key: "skills/alpha",
                      status: "pending",
                    },
                  )
                  expect(selected.items[1]?.status).toBe("verified")
                  expect(selected.items[1]?.publication_operation_id).toBe(
                    `${selected.operation_id}:1`,
                  )
                  expect(selected.state).toBe(
                    scenario === "member-selection-unknown" ? "unknown" : "partial",
                  )
                  expect(childEvents).toEqual([`publish:${selected.operation_id}:1`])
                  expect(new Set(inspections)).toEqual(new Set([selected.items[1]!.page_id]))
                  const published = (yield* getSubscription(sub)).published!
                  expect(published.members.map((member) => member.member_key)).toEqual([
                    "skills/beta",
                  ])
                  expect(published.source_manifest).toEqual(selectedPlan.source_manifest)
                  expect((yield* getSubscription(sub)).source.accepted_ref).toBe(first)
                  expect(yield* store.upstream.plan(selectedPlan.plan_id)).toEqual(selectedPlan)
                  const writesBeforeRetry = writes
                  childEvents.length = 0
                  const repeated = yield* applyUpstream(selectedPlan.plan_id, [
                    "skills/beta",
                    "skills/beta",
                  ])
                  expect(repeated.operation_id).toBe(selected.operation_id)
                  expect(repeated.items).toEqual(selected.items)
                  expect(childEvents).toEqual([])
                  expect(writes).toBe(writesBeforeRetry)
                  const invalidOrder = yield* applyUpstream(selectedPlan.plan_id, [
                    "skills/beta",
                  ]).pipe(
                    Effect.provideService(UpstreamState, {
                      ...store.upstream,
                      operation: (id) =>
                        id === selectedPlan.plan_id
                          ? Effect.succeed({ ...repeated, items: [...repeated.items].reverse() })
                          : store.upstream.operation(id),
                    }),
                    Effect.result,
                  )
                  expect(invalidOrder._tag).toBe("Failure")
                  if (invalidOrder._tag === "Failure")
                    expect(invalidOrder.failure.code).toBe("STATE_CORRUPT")
                  expect(childEvents).toEqual([])
                  expect(writes).toBe(writesBeforeRetry)
                  if (scenario === "member-selection-map-loss") {
                    inspections.length = 0
                    const completed = yield* applyUpstream(selectedPlan.plan_id, ["skills/alpha"])
                    expect(completed.operation_id).toBe(selected.operation_id)
                    expect(completed.state).toBe("verified")
                    expect(new Set(inspections)).toEqual(new Set([selected.items[0]!.page_id]))
                    expect(childEvents).toEqual([])
                    expect((yield* getSubscription(sub)).source.accepted_ref).toBe(second)
                    expect((yield* getSubscription(sub)).published?.members).toHaveLength(2)
                  }
                  return
                }
                const created = yield* applyUpstream(frozen.plan_id)
                expect((yield* getSubscription(sub)).published?.source_manifest).toEqual(
                  frozen.source_manifest,
                )
                expect(
                  (yield* getSubscription(sub)).published?.members.every(
                    (member) => member.revision === first,
                  ),
                ).toBe(true)
                if (
                  ["member-selection-retain", "member-selection-retain-map-loss"].includes(scenario)
                ) {
                  expect(created.state).toBe("verified")
                  const before = (yield* getSubscription(sub)).published!
                  const alpha = before.members.find(
                    (member) => member.member_key === "skills/alpha",
                  )!
                  const retainedPage = structuredClone(pages.get(alpha.page_id)!)
                  const betaPage = before.members.find(
                    (member) => member.member_key === "skills/beta",
                  )!.page_id
                  const betaContent = structuredClone(pages.get(betaPage)!.portable)
                  props["Published Members"] = rich(
                    JSON.stringify({
                      ...before,
                      members: before.members.map((member) => {
                        if (member.member_key !== "skills/alpha") return member
                        const { revision: _revision, ...legacy } = member
                        return legacy
                      }),
                    }),
                  )
                  props.Exclude = rich('["skills/alpha"]')
                  subscriptionClock++
                  const retainedPlan = yield* planUpstream(sub)
                  expect(
                    retainedPlan.items.find((item) => item.member_key === "skills/alpha")?.action,
                  ).toBe("retain")
                  if (scenario === "member-selection-retain-map-loss") {
                    const lostMap = yield* applyUpstream(retainedPlan.plan_id, [
                      "skills/alpha",
                    ]).pipe(
                      Effect.provideService(UpstreamState, {
                        ...store.upstream,
                        saveCommand: (id, input) =>
                          id === `${retainedPlan.plan_id}:subscription-map:intended`
                            ? Effect.fail(
                                fail(
                                  "WRITE_OUTCOME_UNKNOWN",
                                  "Controlled retained map checkpoint loss",
                                ),
                              )
                            : store.upstream.saveCommand(id, input),
                      }),
                      Effect.result,
                    )
                    expect(lostMap._tag).toBe("Failure")
                  }
                  const alphaBinding = (yield* store.upstream.bindings(sub)).find(
                    (binding) => binding.member_key === "skills/alpha",
                  )
                  inspections.length = 0
                  childEvents.length = 0
                  const partial = yield* applyUpstream(retainedPlan.plan_id, ["skills/beta"])
                  expect(partial.state).toBe("partial")
                  expect(
                    partial.items.find((item) => item.member_key === "skills/alpha")?.status,
                  ).toBe(scenario === "member-selection-retain-map-loss" ? "retained" : "pending")
                  expect(
                    (yield* store.upstream.bindings(sub)).find(
                      (binding) => binding.member_key === "skills/alpha",
                    ),
                  ).toEqual(alphaBinding)
                  expect(
                    (yield* getSubscription(sub)).published?.members.find(
                      (member) => member.member_key === "skills/alpha",
                    ),
                  ).toEqual({ ...alpha, revision: first })
                  expect(inspections).not.toContain(alpha.page_id)
                  expect((yield* getSubscription(sub)).source.accepted_ref).toBe(first)
                  expect((yield* applyUpstream(retainedPlan.plan_id, ["skills/alpha"])).state).toBe(
                    "verified",
                  )
                  expect(
                    (yield* getSubscription(sub)).published?.members.map(
                      (member) => member.member_key,
                    ),
                  ).toEqual(["skills/beta"])
                  expect((yield* getSubscription(sub)).source.accepted_ref).toBe(second)
                  expect(pages.get(alpha.page_id)).toEqual(retainedPage)
                  expect(pages.get(betaPage)!.portable).toEqual(betaContent)
                  return
                }
                if (scenario === "unknown-create") {
                  expect(created.state).toBe("unknown")
                  expect(created.items[0]?.publication_operation_id).toBe(
                    `${created.operation_id}:0`,
                  )
                  expect(lostRequest?.expected).toBeUndefined()
                  const resumed = yield* applyUpstream(frozen.plan_id)
                  expect(resumed.operation_id).toBe(created.operation_id)
                  expect(resumed.items[0]?.status).toBe("unknown")
                  expect(publicationCalls).toBe(2)
                  expect(writes).toBe(1)
                  expect(pages.size).toBe(1)
                  const published = (yield* getSubscription(sub)).published!
                  expect(published.members.map((member) => member.member_key)).toEqual([
                    "skills/beta",
                  ])
                  expect(
                    published.source_manifest?.members.map((member) => member.member_key),
                  ).toEqual(["skills/alpha", "skills/beta"])
                  expect(childEvents).toEqual([
                    `publish:${created.operation_id}:0`,
                    `publish:${created.operation_id}:1`,
                    `reconcile:${created.operation_id}:0`,
                  ])
                  const retainedOperations = (yield* store.upstream.operations(sub)).length
                  const daily = yield* runUpstreams({ targets: [sub] })
                  expect(daily.verified).toBe(false)
                  expect(daily.results[0]?.operation?.operation_id).toBe(created.operation_id)
                  expect(daily.results[0]?.operation?.items[0]?.status).toBe("unknown")
                  expect((yield* store.upstream.operations(sub)).length).toBe(retainedOperations)
                  expect(publicationCalls).toBe(2)
                  expect(writes).toBe(1)
                  expect(pages.size).toBe(1)
                  return
                }
                expect(created.state).toBe("verified")
                const publishedPortable = [...pages.values()][0]!.portable
                expect(
                  new TextDecoder().decode(
                    publishedPortable.files.find((file) => file.path === publishedPortable.main)!
                      .bytes,
                  ),
                ).toContain("first")
                expect((yield* applyUpstream(frozen.plan_id)).operation_id).toBe(
                  created.operation_id,
                )
                expect(writes).toBe(1)
                if (scenario === "shared-manifest") {
                  const before = (yield* getSubscription(sub)).published!
                  const peerManifest = {
                    ...frozen.source_manifest!,
                    source_id: peer,
                    revision: "peer-revision",
                  }
                  peerProps = {
                    ...props,
                    Name: rich("peer", "title"),
                    "Published Members": rich(
                      JSON.stringify({
                        ...before,
                        revision: "peer-revision",
                        source_manifest: peerManifest,
                      }),
                    ),
                  }
                  const update = yield* planUpstream(sub)
                  expect(update.source_manifest?.revision).toBe(second)
                  expect((yield* applyUpstream(update.plan_id)).state).toBe("verified")
                  const projected = (yield* getSubscription(peer)).published!
                  expect(projected.members[0]?.content_hash).toBe(update.items[0]?.content_hash)
                  expect(projected.members[0]?.revision).toBe(before.members[0]?.revision)
                  expect(projected.source_manifest).toEqual(peerManifest)
                  expect(projected.source_manifest?.source_id).toBe(peer)
                  expect((yield* getSubscription(sub)).published?.source_manifest).toEqual(
                    update.source_manifest,
                  )
                  expect((yield* getSubscription(sub)).published?.members[0]?.revision).toBe(second)
                  return
                }
                if (["legacy-plan", "mismatched-manifest", "foreign-manifest"].includes(scenario)) {
                  const update = yield* planUpstream(sub)
                  const {
                    plan_id: _id,
                    plan_hash: _hash,
                    source_manifest: manifest,
                    ...body
                  } = update
                  const alteredBody = {
                    ...body,
                    ...(scenario === "legacy-plan"
                      ? {}
                      : {
                          source_manifest: {
                            ...manifest!,
                            ...(scenario === "mismatched-manifest"
                              ? { revision: first }
                              : { source_id: peer }),
                          },
                        }),
                  }
                  const decoded = strictDecode(UpstreamPlanSchema, {
                    ...alteredBody,
                    plan_id: "pending",
                    plan_hash: "pending",
                  })
                  const { plan_id: _pendingId, plan_hash: _pendingHash, ...frozenBody } = decoded
                  const hash = yield* sha256(JSON.stringify(frozenBody))
                  const altered = { ...frozenBody, plan_id: `up_${hash}`, plan_hash: hash }
                  yield* store.upstream.savePlan(altered)
                  expect((yield* applyUpstream(altered.plan_id)).state).toBe("verified")
                  expect((yield* getSubscription(sub)).published?.source_manifest).toBeUndefined()
                  return
                }
                if (scenario === "metadata-loss" || scenario === "run-metadata-loss") {
                  const update = yield* planUpstream(sub)
                  expect(update.items[0]?.action).toBe("update")
                  losePublication = true
                  const failed = yield* applyUpstream(update.plan_id, ["skills/alpha"])
                  expect(failed.items[0]?.status).toBe("unknown")
                  expect(writes).toBe(1)
                  const original = lostRequest!
                  expect(original.expected?.page_id).toBe(created.items[0]?.page_id)
                  expect(
                    new TextDecoder().decode(
                      original.portable.files.find((file) => file.path === original.portable.main)!
                        .bytes,
                    ),
                  ).toContain("second")
                  if (scenario === "metadata-loss") {
                    if (process.platform === "darwin") {
                      yield* Effect.sync(() => execFileSync("/usr/bin/trash", [repo]))
                    } else {
                      // The original source path must be unavailable to recovery;
                      // preserve its bytes inside this fixture on hosts without Trash.
                      yield* Effect.promise(() => rename(repo, join(root, "retained-source")))
                    }
                  }
                  const currentRevision =
                    scenario === "run-metadata-loss"
                      ? yield* Effect.promise(() => put("third"))
                      : second
                  childEvents.length = 0
                  resumeBeforeInspect = true
                  let dailyPublicationId: string | undefined
                  const resumed =
                    scenario === "metadata-loss"
                      ? yield* applyUpstream(update.plan_id, ["skills/alpha"])
                      : yield* Effect.gen(function* () {
                          const run = yield* runUpstreams({ targets: [sub] })
                          expect(run.verified).toBe(true)
                          expect(run.results[0]?.recovered_operation_ids).toEqual([
                            failed.operation_id,
                          ])
                          expect(run.results[0]?.operation?.operation_id).not.toBe(
                            failed.operation_id,
                          )
                          dailyPublicationId =
                            run.results[0]?.operation?.items[0]?.publication_operation_id
                          expect(dailyPublicationId).toBeDefined()
                          expect(dailyPublicationId).not.toBe(original.operation_id)
                          expect(
                            (yield* store.upstream.plan(run.results[0]!.plan_id!))?.revision,
                          ).toBe(currentRevision)
                          return (yield* store.upstream.operation(update.plan_id))!
                        })
                  expect(resumed.operation_id).toBe(failed.operation_id)
                  expect(resumed.state).toBe("verified")
                  expect(resumed.items[0]?.publication_operation_id).toBe(original.operation_id)
                  expect(childEvents).toEqual([
                    `reconcile:${original.operation_id}`,
                    `publish:${original.operation_id}`,
                    ...(dailyPublicationId ? [`publish:${dailyPublicationId}`] : []),
                  ])
                  expect(publicationCalls).toBe(scenario === "run-metadata-loss" ? 4 : 3)
                  expect(writes).toBe(scenario === "run-metadata-loss" ? 3 : 2)
                  const accepted = (yield* store.upstream.bindings(sub))[0]!
                  expect(accepted.generation).toBe(scenario === "run-metadata-loss" ? 3 : 2)
                  expect(accepted.revision).toBe(currentRevision)
                  if (scenario === "metadata-loss")
                    expect(accepted.published_hash).toBe(original.ownership.published_hash)
                  else expect(accepted.published_hash).not.toBe(original.ownership.published_hash)
                  const recoveredPortable = pages.get(accepted.page_id)!.portable
                  expect(
                    new TextDecoder().decode(
                      recoveredPortable.files.find((file) => file.path === recoveredPortable.main)!
                        .bytes,
                    ),
                  ).toContain(scenario === "run-metadata-loss" ? "third" : "second")
                  return
                }
                const shown = yield* showUpstreamOperation(created.operation_id)
                expect(shown?.domain).toBe("sync_upstream")
                expect(
                  shown?.result && "items" in shown.result
                    ? shown.result.items[0]?.publication_operation_id
                    : undefined,
                ).toBe(`${created.operation_id}:0`)
                strictDecode(UpstreamPublicOperationSchema, shown)
                expect(JSON.stringify(shown)).not.toContain("portable")
                expect(JSON.stringify(shown)).not.toContain(repo)
                const readsOnly = yield* reconcileUpstreamOperation(created.operation_id)
                expect(readsOnly?.verified).toBe(true)
                expect(writes).toBe(1)
                authUser = "another-user"
                expect(yield* showUpstreamOperation(created.operation_id)).toBeUndefined()
                expect(yield* listUpstreamOperations()).toEqual([])
                expect(yield* resumeUpstreamOperation(created.operation_id)).toBeUndefined()
                authUser = "fixture-user"
                const subscription = yield* getSubscription(sub)
                const input = {
                  name: subscription.name,
                  description: subscription.description,
                  target_database_id: subscription.target_database_id,
                  default_context: subscription.default_context,
                  enabled: subscription.enabled,
                  source: subscription.source,
                  roots: subscription.roots,
                  include: subscription.include,
                  exclude: subscription.exclude,
                  mapping: subscription.mapping,
                }
                const command = {
                  operation_id: "uu_readonly",
                  domain: "subscription_update",
                  scope: created.scope,
                  database_id: db,
                  page_id: sub,
                  state: "unknown",
                  expected_version: subscription.version,
                  input,
                }
                yield* store.upstream.saveCommand(command.operation_id, command)
                const clockBefore = subscriptionClock
                const settled = yield* reconcileUpstreamOperation(command.operation_id)
                expect(settled?.verified).toBe(true)
                expect((yield* resumeUpstreamOperation(command.operation_id))?.verified).toBe(true)
                expect(subscriptionClock).toBe(clockBefore)
                expect(writes).toBe(1)
                yield* store.upstream.saveCommand("ua_unknown", {
                  operation_id: "ua_unknown",
                  domain: "subscription_add",
                  scope: created.scope,
                  database_id: db,
                  state: "unknown",
                  input_hash: "a".repeat(64),
                  input,
                })
                const blockedResume = yield* resumeUpstreamOperation("ua_unknown").pipe(
                  Effect.result,
                )
                expect(blockedResume._tag).toBe("Failure")
                if (blockedResume._tag === "Failure") {
                  expect("code" in blockedResume.failure).toBe(true)
                  if ("code" in blockedResume.failure)
                    expect(blockedResume.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
                }
                const blocked = yield* showUpstreamOperation("ua_unknown")
                expect(blocked?.resume_supported).toBe(false)
                expect(blocked?.next.argv).toEqual([
                  "ntn-skills",
                  "operation",
                  "reconcile",
                  "ua_unknown",
                ])
                expect(subscriptionClock).toBe(clockBefore)
                const scheduled = yield* runUpstreams({ targets: [sub] })
                expect(scheduled.verified).toBe(true)
                expect(scheduled.summary).toEqual({ total: 1, succeeded: 1, partial: 0, failed: 0 })
                const lastSuccess = (yield* getSubscription(sub)).sync!
                expect(lastSuccess.status).toBe("succeeded")
                expect(lastSuccess.attempted_at?.slice(0, 16)).toBe(
                  scheduled.results[0]!.started_at?.slice(0, 16),
                )
                expect(lastSuccess.succeeded_at?.slice(0, 16)).toBe(
                  scheduled.results[0]!.finished_at?.slice(0, 16),
                )
                expect(writes).toBe(2)
                const pagesBeforeUnchanged = structuredClone([...pages])
                const repeated = yield* runUpstreams({ targets: [sub] })
                expect(repeated.verified).toBe(true)
                expect(repeated.results[0]?.members).toMatchObject({
                  unchanged: 1,
                  created: 0,
                  updated: 0,
                  restored: 0,
                })
                expect([...pages]).toEqual(pagesBeforeUnchanged)
                expect((yield* getSubscription(sub)).sync?.succeeded_at?.slice(0, 16)).toBe(
                  repeated.results[0]!.finished_at?.slice(0, 16),
                )
                const lastSuccessfulTime = (yield* getSubscription(sub)).sync!.succeeded_at
                const availableSource = props.Source
                props.Source = rich(
                  JSON.stringify({
                    provider: { type: "git", url: `${repo}-missing`, ref: "main" },
                  }),
                )
                const unavailable = yield* runUpstreams({ targets: [sub] })
                expect(unavailable.verified).toBe(false)
                expect(unavailable.summary.failed).toBe(1)
                expect((yield* getSubscription(sub)).sync).toMatchObject({
                  status: "failed",
                  succeeded_at: lastSuccessfulTime,
                })
                expect([...pages]).toEqual(pagesBeforeUnchanged)
                props.Source = availableSource
                const continuing = yield* runUpstreams({ targets: ["invalid-target", sub] })
                expect(continuing.verified).toBe(false)
                expect(continuing.summary).toEqual({
                  total: 2,
                  succeeded: 1,
                  partial: 0,
                  failed: 1,
                })
                expect((yield* getSubscription(sub)).sync?.status).toBe("succeeded")
                const binding = (yield* store.upstream.bindings(sub))[0]!
                expect(binding.revision).toBe(second)
                yield* forkUpstream(sub, binding.member_key)
                expect((yield* planUpstream(sub)).items[0]?.action).toBe("fork")
                yield* forkUpstream(sub, binding.member_key)
                expect(modeWrites).toBe(1)
                const forkOperation = (yield* listUpstreamOperations({
                  domain: "upstream_fork",
                }))[0]!
                expect(forkOperation.verified).toBe(false)
                expect(
                  forkOperation.domain === "upstream_fork"
                    ? forkOperation.result?.children[0]?.state
                    : undefined,
                ).toBe("not_recorded")
                expect((yield* resumeUpstreamOperation(forkOperation.operation_id))?.verified).toBe(
                  false,
                )
                expect(modeWrites).toBe(1)
                const page = pages.get(binding.page_id)!
                const modified = {
                  ...page.portable,
                  files: page.portable.files.map((file) =>
                    file.path === "SKILL.md"
                      ? { ...file, bytes: new TextEncoder().encode(skill("manual")) }
                      : file,
                  ),
                }
                pages.set(page.page_id, {
                  ...page,
                  portable: modified,
                  content_hash: yield* portableIdentity(modified),
                  version: String(++clock),
                })
                expect((yield* trackUpstream(sub, binding.member_key)).requires_resolution).toBe(
                  true,
                )
                expect(modeWrites).toBe(1)
                pages.set(page.page_id, {
                  ...pages.get(page.page_id)!,
                  portable: page.portable,
                  content_hash: page.content_hash,
                  version: String(++clock),
                })
                expect((yield* trackUpstream(sub, binding.member_key)).tracked).toBe(true)
                expect(modeWrites).toBe(2)
                const tracked = pages.get(page.page_id)!
                pages.set(page.page_id, {
                  ...tracked,
                  portable: modified,
                  content_hash: yield* portableIdentity(modified),
                  version: String(++clock),
                })
                const conflict = yield* planUpstream(sub)
                expect(conflict.items[0]?.reason).toBe("tracked-content-edited")
                const beforeConflict = (yield* getSubscription(sub)).sync!.succeeded_at
                const conflictedRun = yield* runUpstreams({ targets: [sub] })
                expect(conflictedRun.verified).toBe(false)
                expect(conflictedRun.summary.partial).toBe(1)
                expect((yield* getSubscription(sub)).sync).toMatchObject({
                  status: "partial",
                  succeeded_at: beforeConflict,
                })
                expect(writes).toBe(2)
                pages.set(page.page_id, { ...tracked, version: String(++clock) })
                props.Exclude = rich('["skills/**"]')
                subscriptionClock++
                const missing = yield* planUpstream(sub)
                expect(missing.items[0]?.action).toBe("retain")
                expect((yield* applyUpstream(missing.plan_id)).state).toBe("verified")
                expect(missing.source_manifest?.members).toEqual([])
                expect((yield* getSubscription(sub)).published?.source_manifest).toEqual(
                  missing.source_manifest,
                )
                expect((yield* store.upstream.bindings(sub))[0]!.active).toBe(false)
                expect(pages.size).toBe(1)
                expect(writes).toBe(2)
                expect(
                  JSON.parse(
                    String(
                      property((property(props["Published Members"]).rich_text as unknown[])[0])
                        .plain_text,
                    ),
                  ).members,
                ).toEqual([])
              }).pipe(
                Effect.provideService(UpstreamState, store.upstream),
                Effect.provideService(Notion, notion),
                Effect.provideService(UpstreamPublisher, publisher),
              )
            }),
          ).pipe(
            Effect.provide(StoreLive),
            Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerFetch)),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
          ),
        )
      } finally {
        vi.unstubAllEnvs()
        if (process.platform === "darwin") execFileSync("/usr/bin/trash", [root])
      }
    },
    timeout,
  )
