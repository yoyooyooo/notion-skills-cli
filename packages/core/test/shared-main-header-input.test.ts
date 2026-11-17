import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { withSharedAuthoringRequest } from "../src/shared-authoring-context.ts"
import {
  prepareSharedFileTakeover,
  executeSharedFileTakeover,
} from "../src/shared-file-takeover.ts"
import { writeSharedSkillFile } from "../src/shared-authoring.ts"
import { openSkill } from "../src/snapshot.ts"
import { parseTarget } from "../src/ref.ts"
import { parseYaml } from "../src/yaml.ts"
import { Store } from "../src/store.ts"
import {
  sharedSnapshotFixture,
  library,
  skillPage,
  digest,
  rich,
} from "./shared-snapshot-fixture.ts"
import {
  coldClient,
  pendingSingleBody,
  withRequestHook,
} from "./shared-single-body-apply-acceptance-fixture.ts"
import { gitMainFixture } from "./shared-git-main-takeover-fixture.ts"

const input =
  "---\nname: Managed Name\ndescription: Managed description\nmetadata:\n  version: 3\nrole: reviewer\nlicense: MIT\nargs:\n  - name: target\n    required: false\nuser-invokable: true\n---\n\n# Native main\n"
function fixture() {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  const body = f.bodies.get(skillPage)!
  f.seedFact(
    {
      event_id: "original-native-main",
      file_id: "file-main",
      parents: [],
      kind: "adopted",
      content: {
        object_id: `body-${digest(body)}`,
        sha256: digest(body),
        bytes: Buffer.byteLength(body),
        mode: "100755",
      },
    },
    "file_event",
    "file-main",
    "original-native-main",
  )
  f.seedFact(
    { version: 1, kind: "normalized_markdown", normalization_version: 1, markdown: body },
    "object",
    `body-${digest(body)}`,
    `body-${digest(body)}`,
    `retain-${digest(body)}`,
  )
  const author = <A, E>(effect: Parameters<typeof f.run<A, E>>[0]) =>
    f.run(withSharedAuthoringRequest(skillPage, effect))
  const prepare = (headerInput = input) =>
    author(
      prepareSharedFileTakeover({ library, skillPageId: skillPage, path: "SKILL.md", headerInput }),
    )
  return { f, author, prepare }
}

test("explicit complete header changes only header ownership and cold snapshot identity while native body and mode stay exact", async () => {
  const { f, author, prepare } = fixture()
  const before = await author(
    prepareSharedFileTakeover({ library, skillPageId: skillPage, path: "SKILL.md" }),
  )
  const prepared = await prepare()
  expect(prepared.plan.plan_id).not.toBe(before.plan.plan_id)
  expect(prepared.plan.observation.event.event_id).not.toBe(before.plan.observation.event.event_id)
  expect(property(prepared.plan).main_header_input).toMatchObject({
    input_sha256: digest(input),
    before_metadata: { mode: "100755" },
  })
  expect(f.writeCount()).toBe(0)
  const oldBody = f.bodies.get(skillPage)
  const result = await author(
    executeSharedFileTakeover({ library, plan: prepared.plan, mode: "create" }),
  )
  expect(result.status).toBe("verified_applied")
  expect(f.bodies.get(skillPage)).toBe(oldBody)
  expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
  const cold = coldClient(f)
  await cold.target(parseTarget(skillPage), { database: library.skills.database_id })
  const snapshot = await cold.run(
    openSkill(skillPage, {
      database: library.skills.database_id,
      refresh: true,
      sharedReadOnly: true,
    }),
  )
  const main = snapshot.files.find((file) => file.path === "SKILL.md")!
  expect(main.mode).toBe("100755")
  const bytes = await cold.run(
    Effect.flatMap(Store, (store) => store.readBytes(`objects/${main.sha256}`)),
  )
  const complete = new TextDecoder().decode(bytes)
  expect(parseYaml(/^---\n([\s\S]*?)\n---\n/u.exec(complete)![1]!)).toEqual({
    name: "Managed Name",
    description: "Managed description",
    metadata: { version: 3 },
    role: "reviewer",
    license: "MIT",
    args: [{ name: "target", required: false }],
    "user-invokable": true,
  })
  expect(complete.endsWith("# Native main\n")).toBe(true)
  f.clearCalls()
  expect(
    (await author(executeSharedFileTakeover({ library, plan: prepared.plan, mode: "reconcile" })))
      .status,
  ).toBe("verified_applied")
  expect(f.writeCount()).toBe(0)
})

test("the exact disabled authoring target can edit its header without enabling the Skill", async () => {
  const { f, author, prepare } = fixture()
  property(property(f.main.properties).enabled).checkbox = false
  const { plan } = await prepare()
  expect((await author(executeSharedFileTakeover({ library, plan, mode: "create" }))).status).toBe(
    "verified_applied",
  )
  expect(property(property(f.main.properties).enabled).checkbox).toBe(false)
  expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
})

test("a Git-only main cannot use header-only input to invent a native baseline", async () => {
  const f = await gitMainFixture()
  await expect(
    f.author(
      prepareSharedFileTakeover({
        library,
        skillPageId: f.target,
        path: "SKILL.md",
        headerInput: new TextDecoder().decode(f.original.bytes),
      }),
    ),
  ).rejects.toMatchObject({ code: "SHARED_MAIN_HEADER_SCOPE" })
  expect(f.bodyWrites).toHaveLength(0)
})

for (const visible of [false, true])
  test(`an unknown header event (${visible ? "visible" : "absent"}) can only reconcile the original facts without replay`, async () => {
    const { f, author, prepare } = fixture()
    const { plan } = await prepare()
    f.unknownRecord("file_event", visible)
    await expect(
      author(executeSharedFileTakeover({ library, plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    await expect(prepare()).rejects.toMatchObject({ code: "SHARED_FILE_INTENT_PENDING" })
    f.clearCalls()
    const reconcile = author(executeSharedFileTakeover({ library, plan, mode: "reconcile" }))
    if (visible) expect((await reconcile).status).toBe("verified_applied")
    else await expect(reconcile).rejects.toMatchObject({ code: "SHARED_RECORD_UNRESOLVED" })
    expect(f.writeCount()).toBe(0)
    expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
  })

for (const change of ["body", "name", "description", "foreign-owner"] as const)
  test(`header input refuses ${change} instead of silently altering the body or owner`, async () => {
    const { f, prepare } = fixture()
    const changed =
      change === "body"
        ? input.replace("# Native main", "# Different main")
        : change === "name"
          ? input.replace("name: Managed Name", "name: Other name")
          : change === "description"
            ? input.replace("description: Managed description", "description: Other description")
            : input.replace(
                "role: reviewer",
                "role: reviewer\nnotion_page_id: 00000000-0000-4000-8000-000000000099",
              )
    await expect(prepare(changed)).rejects.toMatchObject({ _tag: "SkillsError" })
    expect(f.writeCount()).toBe(0)
  })

for (const change of ["body", "name", "source", "head"] as const)
  test(`a fresh ${change} drift rejects a prepared header event without writes`, async () => {
    const { f, author, prepare } = fixture()
    const { plan } = await prepare()
    if (change === "body") f.bodies.set(skillPage, "# A concurrent body\n")
    if (change === "name")
      property(f.main.properties).title = {
        id: "title",
        type: "title",
        title: [{ plain_text: "Changed name" }],
      }
    if (change === "source") property(f.main.properties).source = rich("source", "changed-source")
    if (change === "head")
      f.seedFact(
        {
          ...plan.observation.event,
          event_id: "concurrent-head",
          parents: ["original-native-main"],
        },
        "file_event",
        "file-main",
        "concurrent-head",
      )
    f.clearCalls()
    await expect(
      author(executeSharedFileTakeover({ library, plan, mode: "create" })),
    ).rejects.toMatchObject({ _tag: "SkillsError" })
    expect(f.writeCount()).toBe(0)
  })

test("a late metadata change after retaining the header intent cannot publish the header event", async () => {
  const { f, author, prepare } = fixture()
  const { plan } = await prepare()
  let changed = false
  const action = withRequestHook(
    executeSharedFileTakeover({ library, plan, mode: "create" }),
    (path, body, method, next) =>
      next().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (
              !changed &&
              path === "v1/pages" &&
              method === "POST" &&
              property(property(property(property(body).properties).kind).select).name ===
                "operation"
            ) {
              changed = true
              property(f.main.properties).description = rich(
                "description",
                "Changed during retention",
              )
            }
          }),
        ),
      ),
  )
  await expect(author(action)).rejects.toMatchObject({ _tag: "SkillsError" })
  expect(changed).toBe(true)
  expect(
    [...f.records.values()].some(
      (row) =>
        JSON.stringify(row).includes(plan.observation.event.event_id) &&
        property(property(property(row.properties).kind).select).name === "file_event",
    ),
  ).toBe(false)
  expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
})

test("a current accepted unknown parent remains a header barrier even in a cold Store", async () => {
  const original = await pendingSingleBody()
  await original.f.run(original.accept())
  property(property(original.f.main.properties).enabled).checkbox = true
  const cold = coldClient(original.f)
  const body = original.f.bodies.get(skillPage)!
  await expect(
    cold.run(
      withSharedAuthoringRequest(
        skillPage,
        prepareSharedFileTakeover({
          library,
          skillPageId: skillPage,
          path: "SKILL.md",
          headerInput: input.replace("# Native main\n", body),
        }),
      ),
    ),
  ).rejects.toMatchObject({ code: "SHARED_FILE_INTENT_PENDING" })
  expect(cold.writeCount()).toBe(0)
})

test("ordinary body-only write and ordinary takeover never gain the explicit complete-header permission", async () => {
  const { f, author, prepare } = fixture()
  await f.target(parseTarget(skillPage), { database: library.skills.database_id })
  const snapshot = await author(
    openSkill(skillPage, {
      database: library.skills.database_id,
      refresh: true,
      sharedReadOnly: true,
    }),
  )
  await expect(
    author(
      writeSharedSkillFile({
        snapshot,
        path: "SKILL.md",
        bytes: new TextEncoder().encode(input),
        dryRun: true,
      }),
    ),
  ).rejects.toMatchObject({ code: "SHARED_METADATA_CONFLICT" })
  const plain = await author(
    prepareSharedFileTakeover({ library, skillPageId: skillPage, path: "SKILL.md" }),
  )
  expect(property(plain.plan.observation.event.content).frontmatter).toBeUndefined()
  expect(
    (await author(executeSharedFileTakeover({ library, plan: plain.plan, mode: "create" }))).status,
  ).toBe("unchanged")
  expect(f.writeCount()).toBe(0)
})
