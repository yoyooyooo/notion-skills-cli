import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, Layer } from "effect"
import { Store, StoreLive } from "../src/store.ts"
import { authScope } from "../src/catalog.ts"
import { prepareSharedCreate, executeSharedCreate } from "../src/shared-create.ts"
import {
  reviewSharedCreateRestoration,
  applySharedCreateRestoration,
  reconcileSharedCreateRestoration,
  type SharedCreateRestorationReview,
} from "../src/shared-create-restoration.ts"
import type { SharedCreatePlan } from "../src/shared-create-model.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { normalizeObservedBody } from "../src/shared-file-state.ts"
import { mapMarkdownLinks } from "../src/typed-links.ts"
import { sharedCreateFixture } from "./shared-create-fixture.ts"
import { property } from "../src/model.ts"

const root = process.argv[2]
assert.ok(root)
const reopen = process.argv[3] === "cold"
const stateRoot = root + (reopen ? "/reader" : "/writer")
process.env.NTN_SKILLS_HOME = stateRoot + "/state"
process.env.NTN_SKILLS_CONFIG_HOME = stateRoot + "/config"
process.env.NTN_SKILLS_CACHE_HOME = stateRoot + "/cache"
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* Store
      const f = sharedCreateFixture({
        bodyPatch: true,
        readback: (wire) =>
          normalizeObservedBody(
            mapMarkdownLinks(wire.replace(/^<h1>([^\n]*)<\/h1>(?=\n|$)/u, "# $1"), (href) => {
              const at = href.indexOf("#")
              const projected =
                at < 0 ? href : href.slice(0, at) + new URL(href, "https://fixture.test/").hash
              return /^[^./:#?][^/:?#]*\.md$/u.test(projected) ? "https://" + projected : projected
            }),
          ),
      })
      // Only the fixture's allocation gate mirrors durable writes; every Store
      // read and ACK remains SQLite-backed in this child process.
      const durable: typeof store = {
        ...store,
        writeJson: (key, value) =>
          store
            .writeJson(key, value)
            .pipe(
              Effect.tap(() => Effect.sync(() => f.base.json.set(key, structuredClone(value)))),
            ),
      }
      yield* Effect.promise(() =>
        f.run(
          Effect.gen(function* () {
            let plan: SharedCreatePlan
            let review: SharedCreateRestorationReview
            let page: string
            if (reopen) {
              assert.equal((yield* store.listKeys("operations")).length, 0)
              const saved = JSON.parse(
                yield* Effect.promise(() => readFile(root + "/remote.json", "utf8")),
              )
              plan = saved.plan
              review = saved.review
              page = saved.page
              for (const [key, value] of saved.skills) f.skills.set(key, value)
              for (const [key, value] of saved.files) f.files.set(key, value)
              for (const [key, value] of saved.records) f.base.records.set(key, value)
              for (const [key, value] of saved.bodies) f.base.bodies.set(key, value)
              f.credential("independent-sqlite-fragment-reader")
              f.clear()
              const checked = yield* reconcileSharedCreateRestoration({
                entry: f.library.skills.database_id,
                plan,
                target: page,
              })
              assert.equal(checked.verified, true)
            } else {
              const encode = (value: string) => new TextEncoder().encode(value)
              plan = yield* prepareSharedCreate(f.library, {
                portable: {
                  kind: "skill",
                  name: "Durable fragment owner",
                  description: "Exact sole-main fragment recovery",
                  main: "SKILL.md",
                  files: [
                    {
                      path: "SKILL.md",
                      bytes: encode("# Root\n\nRead [Guide](references/guide.md#进程加载对账).\n"),
                    },
                    {
                      path: "references/guide.md",
                      bytes: encode("# Guide\n\nRead [Next](next.md).\n"),
                    },
                    {
                      path: "references/next.md",
                      bytes: encode("# Next\n\nRead [Root](../SKILL.md).\n"),
                    },
                    {
                      path: "scripts/run.py",
                      bytes: encode("print('retained')\n"),
                      mode: "100755",
                    },
                  ],
                },
                completeResources: true,
                markdownImport: true,
              })
              const failure = yield* Effect.flip(
                executeSharedCreate(f.library, { plan, mode: "create" }),
              )
              assert.equal(failure.code, "SHARED_CREATE_BODY_MISMATCH")
              page = String(property(failure.details).skill_page_id)
              review = yield* reviewSharedCreateRestoration({
                entry: f.library.skills.database_id,
                plan,
                target: page,
                repairLocalLinks: true,
              })
              assert.equal(review.version, 3)
              assert.equal(review.original_outcome_sha256, null)
              assert.equal(review.bootstrap.kind, "acknowledged_main_before_manifest")
              assert.equal(review.bindings.length, 1)
              f.clear()
              const input = {
                entry: f.library.skills.database_id,
                plan,
                review,
                reviewId: review.review_id,
              }
              const dry = yield* applySharedCreateRestoration({ ...input, dryRun: true })
              assert.equal(dry.status, "planned")
              assert.equal(f.writes().length, 0)
              const applied = yield* applySharedCreateRestoration(input)
              assert.equal(applied.verified, true)
              yield* Effect.promise(() =>
                writeFile(
                  root + "/remote.json",
                  JSON.stringify({
                    plan,
                    review,
                    page,
                    skills: [...f.skills],
                    files: [...f.files],
                    records: [...f.base.records],
                    bodies: [...f.base.bodies],
                  }),
                  { flag: "wx" },
                ),
              )
              f.clear()
            }
            const snapshot = yield* openSharedConsumer({
              library: f.library,
              target: page,
              scope: yield* authScope,
              startedAt: Date.now(),
              forceFull: true,
              readOnly: true,
            })
            assert.deepEqual(snapshot.files.map((file) => file.path).sort(), [
              "SKILL.md",
              "references/guide.md",
              "references/next.md",
              "scripts/run.py",
            ])
            const main = snapshot.files.find((file) => file.path === "SKILL.md")!
            const markdown = new TextDecoder().decode(
              yield* store.readBytes("objects/" + main.sha256),
            )
            assert.ok(
              markdown.includes("references/guide.md#" + encodeURIComponent("进程加载对账")),
            )
            const raw = snapshot.files.find((file) => file.path === "scripts/run.py")!
            assert.equal(raw.mode, "100755")
            assert.equal(
              new TextDecoder().decode(yield* store.readBytes("objects/" + raw.sha256)),
              "print('retained')\n",
            )
            assert.equal(f.writes().length, 0)
            console.log(
              JSON.stringify({
                reopen,
                review_id: review.review_id,
                page_id: page,
                sole_main_bootstrap: true,
                complete_files: snapshot.files.length,
                raw_mode: raw.mode,
                normal_read_writes: f.writes().length,
              }),
            )
          }).pipe(Effect.provideService(Store, durable)),
        ),
      )
    }),
  ).pipe(
    Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
  ),
)
