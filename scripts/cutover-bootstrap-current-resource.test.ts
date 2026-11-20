import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit, Option } from "effect"
import { fail, property, SkillsError, text } from "../packages/core/src/model.ts"
import { Notion } from "../packages/core/src/notion.ts"
import { requireCurrentSkillReady } from "../packages/core/src/shared-current-file.ts"
import { queryCurrentSkillIndex } from "../packages/core/src/shared-current-index.ts"
import { inspectCurrentProjection } from "../packages/core/src/shared-current-projection.ts"
import { loadCurrentSharedResourceContent } from "../packages/core/src/shared-current-resource.ts"
import { prepareCurrentWriteFile } from "../packages/core/src/shared-current-write-input.ts"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"
import {
  currentWriteFixture,
  id,
  library,
} from "../packages/core/test/shared-current-write-fixture.ts"
import {
  bootstrapCurrentResource,
  inspectResourceBootstrap,
  prepareResourceBootstrapInput,
} from "./cutover-bootstrap-current-resource.ts"

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const rich = (content: string) => [{ type: "text", text: { content } }]
const root = mkdtempSync(join(tmpdir(), "ah513-resource-bootstrap-"))
const operation = "resource-bootstrap-one"
const props = (raw: unknown) => property(property(raw).properties)
const fieldText = (raw: unknown, name: string) => text(property(props(raw)[name]).rich_text)
function code(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) throw new Error("Expected a stopped finite operation")
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
  if (!(error instanceof SkillsError)) throw new Error(Cause.pretty(exit.cause))
  return error.code
}
function block(page: string, content: string, n = 900) {
  return {
    object: "block",
    id: id(n),
    type: "paragraph",
    parent: { type: "page_id", page_id: page },
    has_children: false,
    archived: false,
    in_trash: false,
    paragraph: { rich_text: rich(content) },
  }
}
async function fixture() {
  const f = currentWriteFixture(root),
    directory = mkdtempSync(join(root, "input-"))
  const original = Buffer.from(
    "---\nname: Resource bootstrap\ndescription: Exact selected original\n---\n\n# Resource original\n\nKeep `all original bytes`.\n",
  )
  const beforeBody = "# Resource original\n\nKeep `all original bytes`."
  const owner = String(
    property(
      await f.run(
        Effect.gen(function* () {
          return yield* (yield* Notion).request(
            "v1/pages",
            {
              parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
              properties: {
                title: { title: rich("Resource bootstrap") },
                description: { rich_text: rich("Exact selected original") },
                kind: { select: { name: "skill" } },
                enabled: { checkbox: true },
                "default-context": { checkbox: false },
                "skill-id": { rich_text: rich("resource-bootstrap") },
                "main-file-id": { rich_text: rich("resource-main") },
                content: { rich_text: [] },
                "current-state": { select: null },
                operation: { rich_text: [] },
                origin: { relation: [{ id: id(800) }] },
                "selected-version": { rich_text: rich("legacy-selected-bundle") },
              },
            },
            { method: "POST" },
          )
        }),
      ),
    ).id,
  )
  const carrier = String(
    property(
      await f.run(
        Effect.gen(function* () {
          return yield* (yield* Notion).request(
            "v1/pages",
            {
              parent: { type: "data_source_id", data_source_id: library.records.data_source_id },
              properties: {
                title: { title: rich("Selected carrier") },
                "record-id": { rich_text: rich("legacy-selected-bundle") },
                "entity-id": { rich_text: rich("legacy-selected-bundle") },
                kind: { select: { name: "source" } },
                hash: { rich_text: rich(digest(original)) },
                payload: { rich_text: rich("Opaque captured selection payload") },
                skill: { relation: [{ id: owner }] },
                origin: { relation: [{ id: id(800) }] },
                resource: { files: [] },
              },
            },
            { method: "POST" },
          )
        }),
      ),
    ).id,
  )
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Notion).request(
        `v1/pages/${owner}/markdown`,
        {
          markdown_version: "v2",
          type: "replace_content",
          replace_content: { new_str: beforeBody },
        },
        { method: "PATCH" },
      )
    }),
  )
  f.blocks.set(owner, [block(owner, beforeBody)])
  const originalPath = join(directory, "SKILL.md"),
    bodyPath = join(directory, "before.md")
  writeFileSync(originalPath, original)
  writeFileSync(bodyPath, beforeBody)
  const prepared = await f.run(
    prepareCurrentWriteFile({
      path: "SKILL.md",
      bytes: original,
      mode: "100644",
      file_id: "resource-main",
      authority: { kind: "resource" },
    }),
  )
  if (prepared.kind !== "resource") throw new Error("Expected resource preparation")
  const guard = (page: string, key: string) => ({
    id: key,
    sha256: digest(canonicalSharedJson(props(f.pages.get(page))[key])),
  })
  const document = {
    version: 1,
    kind: "ah513-existing-resource-bootstrap",
    library,
    owner: {
      page_id: owner,
      skill_id: "resource-bootstrap",
      main_file_id: "resource-main",
      name: "Resource bootstrap",
      description: "Exact selected original",
      kind: "skill",
      enabled: true,
      default_context: false,
      tags: [],
      before: {
        content: "",
        state: null,
        operation: "",
        origin: [id(800)],
        members: [],
        requires: [],
        body: {
          local_path: bodyPath,
          sha256: digest(beforeBody),
          bytes: Buffer.byteLength(beforeBody),
        },
      },
    },
    file: {
      path: "SKILL.md",
      local_bytes_path: originalPath,
      sha256: digest(original),
      bytes: original.length,
      mode: "100644",
      content: prepared.content,
    },
    origin_after: [],
    before_selection: {
      owner_properties: [guard(owner, "selected-version")],
      carrier: {
        page_id: carrier,
        properties: ["record-id", "entity-id", "kind", "hash", "payload", "skill", "origin"].map(
          (key) => guard(carrier, key),
        ),
      },
    },
  }
  const documentBytes = Buffer.from(JSON.stringify(document))
  const input = await f.run(
    prepareResourceBootstrapInput({ document: documentBytes, input_sha256: digest(documentBytes) }),
  )
  f.clearCalls()
  return {
    ...f,
    owner,
    carrier,
    input,
    document,
    documentBytes,
    original,
    beforeBody,
    originalPath,
  }
}
const resourceRows = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.table("records").filter((row) => property(property(props(row).kind).select).name === "resource")
const resourceCreates = (f: Awaited<ReturnType<typeof fixture>>) =>
  f
    .mutations()
    .filter(
      (call) =>
        call.path === "v1/pages" &&
        property(property(props(call.body).kind).select).name === "resource",
    )
const bodyMutations = (f: Awaited<ReturnType<typeof fixture>>) =>
  f
    .mutations()
    .filter(
      (call) =>
        call.path.endsWith("/markdown") || call.path.startsWith(`v1/blocks/${f.owner}/children`),
    )
const contentMutations = (f: Awaited<ReturnType<typeof fixture>>) =>
  f
    .mutations()
    .filter((call) => call.path === `v1/pages/${f.owner}` && props(call.body).content !== undefined)
const setText = (
  f: Awaited<ReturnType<typeof fixture>>,
  page: string,
  key: string,
  value: string,
) => {
  const fields = props(f.pages.get(page))
  fields[key] = { ...property(fields[key]), rich_text: rich(value) }
}
async function expectPending(f: Awaited<ReturnType<typeof fixture>>) {
  const state = property(property(props(f.pages.get(f.owner))["current-state"]).select).name
  expect(state === "applying" || state === "attention").toBe(true)
  expect(fieldText(f.pages.get(f.owner), "operation")).toBe(operation)
  expect(
    f
      .table("records")
      .some((row) => property(property(props(row).kind).select).name === "operation"),
  ).toBe(true)
  if (fieldText(f.pages.get(f.owner), "content")) {
    const index = await f.run(queryCurrentSkillIndex(library, f.owner))
    expect(() => requireCurrentSkillReady(index.state, f.owner)).toThrow("unfinished current work")
  }
}

test("resource bootstrap verifies the owned original and full projection; completed resume is read-only", async () => {
  const f = await fixture()
  const dry = await f.run(inspectResourceBootstrap(f.input, operation))
  const dryRequests = f.calls.length
  expect(dry.resource_present).toBe(false)
  expect(f.mutations()).toHaveLength(0)
  f.clearCalls()
  const applied = await f.run(bootstrapCurrentResource(f.input, operation, "apply"))
  const applyRequests = f.calls.length,
    applyWrites = f.mutations().length
  expect(applied.state).toBe("ready")
  expect(resourceCreates(f)).toHaveLength(1)
  expect(resourceRows(f)).toHaveLength(1)
  expect(f.table("files")).toHaveLength(0)
  expect(f.table("sources")).toHaveLength(0)
  expect(f.pages.get(f.carrier)?.in_trash).toBe(false)
  const stored = await f.run(
    loadCurrentSharedResourceContent(library, {
      owner: { kind: "skill", page_id: f.owner },
      content: f.input.file.content,
    }),
  )
  expect(Buffer.from(stored.bytes)).toEqual(f.original)
  expect(
    (await f.run(inspectCurrentProjection({ pageId: f.owner, plan: f.input.projection }))).matches,
  ).toBe(true)
  const index = await f.run(queryCurrentSkillIndex(library, f.owner))
  expect(index.state).toEqual({ state: "ready" })
  expect(index.main.file_id).toBe("resource-main")
  expect(index.main.content).toEqual(f.input.file.content)
  expect(property(props(f.pages.get(f.owner)).origin).relation).toEqual([])
  setText(f, f.owner, "selected-version", "Retired old selection")
  f.pages.get(f.carrier)!.in_trash = true
  f.clearCalls()
  expect((await f.run(bootstrapCurrentResource(f.input, operation, "resume"))).state).toBe("ready")
  expect(f.mutations()).toHaveLength(0)
  expect(f.calls.some((call) => call.path === `v1/pages/${f.carrier}`)).toBe(false)
  console.info(
    JSON.stringify({
      controlled_resource_bootstrap: {
        dry_requests: dryRequests,
        apply_requests: applyRequests,
        apply_writes: applyWrites,
        completed_resume_requests: f.calls.length,
        completed_resume_writes: f.mutations().length,
      },
    }),
  )
})

test.each(["accepted", "absent"] as const)(
  "unknown resource CREATE %s is never duplicated",
  async (outcome) => {
    const f = await fixture()
    f.failNext({ kind: "resource-create", outcome })
    expect(
      code(await f.run(bootstrapCurrentResource(f.input, operation, "apply").pipe(Effect.exit))),
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(resourceCreates(f)).toHaveLength(1)
    await expectPending(f)
    f.clearCalls()
    const resumed = await f.run(
      bootstrapCurrentResource(f.input, operation, "resume").pipe(Effect.exit),
    )
    if (outcome === "accepted") expect(Exit.isSuccess(resumed)).toBe(true)
    else {
      expect(code(resumed)).toBe("CURRENT_OPERATION_UNRESOLVED")
      await expectPending(f)
    }
    expect(resourceCreates(f)).toHaveLength(0)
    expect(resourceRows(f)).toHaveLength(outcome === "accepted" ? 1 : 0)
  },
)

test.each(["accepted", "absent"] as const)(
  "unknown projection clear %s reconciles only the approved baseline or cleared target",
  async (outcome) => {
    const f = await fixture()
    f.failNext({ kind: "native-body", outcome })
    expect(
      code(await f.run(bootstrapCurrentResource(f.input, operation, "apply").pipe(Effect.exit))),
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    await expectPending(f)
    expect(bodyMutations(f)).toHaveLength(1)
    f.clearCalls()
    expect((await f.run(bootstrapCurrentResource(f.input, operation, "resume"))).state).toBe(
      "ready",
    )
    expect(f.mutations().filter((call) => call.path.endsWith("/markdown"))).toHaveLength(
      outcome === "accepted" ? 0 : 1,
    )
    expect(resourceCreates(f)).toHaveLength(0)
  },
)

test.each(["accepted", "absent"] as const)(
  "unknown Content and Origin PATCH %s reconciles the exact pair",
  async (outcome) => {
    const f = await fixture(),
      api = await f.run(Notion)
    let attempted = false
    const fault: Notion["Service"] = {
      ...api,
      request: (path, body, options) => {
        if (
          !attempted &&
          path === `v1/pages/${f.owner}` &&
          options?.method === "PATCH" &&
          props(body).content !== undefined
        ) {
          attempted = true
          const unknown = Effect.fail(
            fail("WRITE_OUTCOME_UNKNOWN", "The exact metadata replacement response was lost."),
          )
          return outcome === "accepted"
            ? api.request(path, body, options).pipe(Effect.andThen(unknown))
            : unknown
        }
        return api.request(path, body, options)
      },
    }
    expect(
      code(
        await f.run(
          bootstrapCurrentResource(f.input, operation, "apply").pipe(
            Effect.provideService(Notion, fault),
            Effect.exit,
          ),
        ),
      ),
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(attempted).toBe(true)
    await expectPending(f)
    f.clearCalls()
    expect((await f.run(bootstrapCurrentResource(f.input, operation, "resume"))).state).toBe(
      "ready",
    )
    expect(contentMutations(f)).toHaveLength(outcome === "accepted" ? 0 : 1)
    expect(resourceCreates(f)).toHaveLength(0)
  },
)

test.each(["accepted", "absent", "partial"] as const)(
  "unknown complete projection append %s is not blindly replayed",
  async (outcome) => {
    const f = await fixture()
    expect(f.input.projection.blocks.length).toBeGreaterThan(1)
    f.failNext({ kind: "append", outcome })
    expect(
      code(await f.run(bootstrapCurrentResource(f.input, operation, "apply").pipe(Effect.exit))),
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    await expectPending(f)
    f.clearCalls()
    const resumed = await f.run(
      bootstrapCurrentResource(f.input, operation, "resume").pipe(Effect.exit),
    )
    if (outcome === "accepted") expect(Exit.isSuccess(resumed)).toBe(true)
    else {
      expect(Exit.isFailure(resumed)).toBe(true)
      await expectPending(f)
    }
    expect(bodyMutations(f)).toHaveLength(0)
    expect(resourceCreates(f)).toHaveLength(0)
  },
)

test("dry-run rejects nested child content before any operation or projection mutation", async () => {
  const f = await fixture()
  f.blocks.set(f.owner, [
    { ...block(f.owner, "Child", 901), type: "child_page", child_page: { title: "Keep me" } },
  ])
  expect(code(await f.run(inspectResourceBootstrap(f.input, operation).pipe(Effect.exit)))).toBe(
    "CURRENT_PROJECTION_CHILD_CONTENT",
  )
  expect(
    code(await f.run(bootstrapCurrentResource(f.input, operation, "apply").pipe(Effect.exit))),
  ).toBe("CURRENT_PROJECTION_CHILD_CONTENT")
  expect(f.mutations()).toHaveLength(0)
})

test("a child added after descriptor selection is protected before projection clear", async () => {
  const f = await fixture()
  let added = false
  f.rewrite((path, raw) => {
    if (
      !added &&
      path === `v1/pages/${f.owner}` &&
      fieldText(raw, "content") === canonicalSharedJson(f.input.file.content)
    ) {
      added = true
      f.blocks.set(f.owner, [
        {
          ...block(f.owner, "Keep child", 904),
          type: "child_page",
          child_page: { title: "Keep child" },
        },
      ])
    }
    return raw
  })
  expect(
    code(await f.run(bootstrapCurrentResource(f.input, operation, "apply").pipe(Effect.exit))),
  ).toBe("CURRENT_PROJECTION_CHILD_CONTENT")
  expect(added).toBe(true)
  expect(bodyMutations(f)).toHaveLength(0)
  await expectPending(f)
})

test.each(["empty", "third body"] as const)(
  "blank Content rejects %s rather than treating it as a generated prefix",
  async (body) => {
    const f = await fixture()
    f.rewrite((path, raw) =>
      path.startsWith(`v1/pages/${f.owner}/markdown`)
        ? { ...raw, markdown: body === "empty" ? "" : "Human replacement" }
        : raw,
    )
    expect(
      code(await f.run(bootstrapCurrentResource(f.input, operation, "apply").pipe(Effect.exit))),
    ).toBe("CUTOVER_RESOURCE_BODY_CHANGED")
    expect(f.mutations()).toHaveLength(0)
  },
)

test.each(["payload", "ownership"] as const)(
  "carrier %s drift in content-origin's last body read stops descriptor publication",
  async (change) => {
    const f = await fixture()
    let bodyReads = 0
    f.rewrite((path, raw) => {
      // First body read is CREATE acknowledgement verification; the second is
      // the content-origin action's final body read before its metadata guard.
      if (
        resourceRows(f).length === 1 &&
        path.startsWith(`v1/pages/${f.owner}/markdown`) &&
        ++bodyReads === 2
      ) {
        if (change === "payload")
          setText(f, f.carrier, "payload", "Changed current selected header")
        else {
          const fields = props(f.pages.get(f.carrier))
          fields.skill = { ...property(fields.skill), relation: [{ id: id(999) }] }
        }
      }
      return raw
    })
    expect(
      Exit.isFailure(
        await f.run(bootstrapCurrentResource(f.input, operation, "apply").pipe(Effect.exit)),
      ),
    ).toBe(true)
    expect(bodyReads).toBe(2)
    expect(contentMutations(f)).toHaveLength(0)
    expect(bodyMutations(f)).toHaveLength(0)
    if (change === "payload")
      expect(fieldText(f.pages.get(f.carrier), "payload")).toBe("Changed current selected header")
    else expect(property(props(f.pages.get(f.carrier)).skill).relation).toEqual([{ id: id(999) }])
    await expectPending(f)
  },
)

test("owner selection changed during carrier GET is observed before descriptor publication", async () => {
  const f = await fixture()
  let changed = false
  f.rewrite((path, raw) => {
    if (!changed && resourceRows(f).length === 1 && path === `v1/pages/${f.carrier}`) {
      changed = true
      setText(f, f.owner, "selected-version", "Different selected carrier")
    }
    return raw
  })
  expect(
    Exit.isFailure(
      await f.run(bootstrapCurrentResource(f.input, operation, "apply").pipe(Effect.exit)),
    ),
  ).toBe(true)
  expect(changed).toBe(true)
  expect(contentMutations(f)).toHaveLength(0)
  expect(bodyMutations(f)).toHaveLength(0)
  expect(fieldText(f.pages.get(f.owner), "selected-version")).toBe("Different selected carrier")
  await expectPending(f)
})

test("carrier ownership drift with identical payload is rejected before any write", async () => {
  const f = await fixture()
  const fields = props(f.pages.get(f.carrier))
  fields.skill = { ...property(fields.skill), relation: [{ id: id(999) }] }
  expect(
    code(await f.run(bootstrapCurrentResource(f.input, operation, "apply").pipe(Effect.exit))),
  ).toBe("CUTOVER_RESOURCE_SELECTION_CHANGED")
  expect(f.mutations()).toHaveLength(0)
})

test("Description changed in the last Files query is preserved and never overwritten", async () => {
  const f = await fixture()
  let checks = 0
  f.rewrite((path, raw) => {
    if (
      resourceRows(f).length === 1 &&
      path === `v1/data_sources/${library.files.data_source_id}/query` &&
      ++checks === 4
    )
      setText(f, f.owner, "description", "Human description")
    return raw
  })
  expect(
    Exit.isFailure(
      await f.run(bootstrapCurrentResource(f.input, operation, "apply").pipe(Effect.exit)),
    ),
  ).toBe(true)
  expect(checks).toBe(4)
  expect(contentMutations(f)).toHaveLength(0)
  expect(bodyMutations(f)).toHaveLength(0)
  expect(fieldText(f.pages.get(f.owner), "description")).toBe("Human description")
  await expectPending(f)
})

test("third-party nonempty generated-body drift after descriptor selection is never cleared", async () => {
  const f = await fixture()
  let changed = false
  f.rewrite((path, raw) => {
    if (
      !changed &&
      path === `v1/pages/${f.owner}` &&
      fieldText(raw, "content") === canonicalSharedJson(f.input.file.content)
    ) {
      changed = true
      f.blocks.set(f.owner, [block(f.owner, "Human projection edit", 902)])
    }
    return changed && path.startsWith(`v1/pages/${f.owner}/markdown`)
      ? { ...raw, markdown: "Human projection edit" }
      : raw
  })
  expect(
    Exit.isFailure(
      await f.run(bootstrapCurrentResource(f.input, operation, "apply").pipe(Effect.exit)),
    ),
  ).toBe(true)
  expect(changed).toBe(true)
  expect(bodyMutations(f)).toHaveLength(0)
  await expectPending(f)
})

test("completed resume rejects missing current resource or changed full projection with zero writes", async () => {
  const f = await fixture()
  await f.run(bootstrapCurrentResource(f.input, operation, "apply"))
  const resource = resourceRows(f)[0]!
  resource.in_trash = true
  f.clearCalls()
  expect(
    Exit.isFailure(
      await f.run(bootstrapCurrentResource(f.input, operation, "resume").pipe(Effect.exit)),
    ),
  ).toBe(true)
  expect(f.mutations()).toHaveLength(0)
  resource.in_trash = false
  f.blocks.set(f.owner, [block(f.owner, "Human changed projection", 903)])
  f.clearCalls()
  expect(
    Exit.isFailure(
      await f.run(bootstrapCurrentResource(f.input, operation, "resume").pipe(Effect.exit)),
    ),
  ).toBe(true)
  expect(f.mutations()).toHaveLength(0)
})

test("input SHA and original bytes are validated before service use", async () => {
  const f = await fixture()
  expect(
    code(
      await f.run(
        prepareResourceBootstrapInput({
          document: f.documentBytes,
          input_sha256: "0".repeat(64),
        }).pipe(Effect.exit),
      ),
    ),
  ).toBe("CUTOVER_RESOURCE_INVALID")
  writeFileSync(f.originalPath, "Changed original")
  expect(
    code(
      await f.run(
        prepareResourceBootstrapInput({
          document: f.documentBytes,
          input_sha256: digest(f.documentBytes),
        }).pipe(Effect.exit),
      ),
    ),
  ).toBe("CUTOVER_RESOURCE_INVALID")
  expect(f.calls).toHaveLength(0)
})
