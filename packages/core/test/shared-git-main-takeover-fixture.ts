import { createHash } from "node:crypto"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { withSharedAuthoringRequest } from "../src/shared-authoring-context.ts"
import { gitOnlyProjectionForSource } from "../src/shared-git-only-marker.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { registerSourceBinding } from "../src/shared-source-binding.ts"
import { fixture, library } from "./shared-source-projection-fixture.ts"
import { id, rich } from "./shared-snapshot-fixture.ts"

export { library }
export const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

/** The real post-admission shape: same control/main page, exact fixed tree,
 * no native file events, and an empty native body (not a source baseline). */
export async function gitMainFixture() {
  const f = fixture([], {
    main: "---\nname: initial-source\ndescription: Initial complete member\nlicense: MIT\nargs:\n  - target\nuser-invokable: true\n---\n\n# Initial\n\nKeep all source documents.\n",
  })
  const target = id(56002),
    fileId = "file-git-only-main"
  const member = f.snapshot.members[0]!
  const originalIdentity = sha(
    canonicalSharedJson([
      "source-onboarding-v1",
      library.library_id,
      f.source.id,
      member.member_key,
    ]),
  )
  const row = f.seedSkill(target, `skill-${originalIdentity}`, "initial-source", "skill", true)
  const props = property(row.properties)
  props.description = rich("description", "Initial complete member")
  props.main_file_id = rich("main_file_id", fileId)
  props.projection = rich("projection", gitOnlyProjectionForSource(f.source.id))
  props.references = rich("references", "")
  props.source_member = rich("source_member", member.member_key)
  props.origin = {
    id: "origin",
    type: "relation",
    relation: [{ id: f.source.id }],
    has_more: false,
  }
  props.members = { id: "members", type: "relation", relation: [], has_more: false }
  const registered = await f.run(
    registerSourceBinding(library, {
      skillPageId: target,
      mode: "create",
      fixedSource: {
        url: "https://github.com/example/initial-source",
        commit: f.snapshot.revision,
        tree: member.git_manifest!.tree,
        root: member.member_key,
        files: member.git_manifest!.files.map((file) => ({
          ...file,
          sha256: sha(member.portable.files.find((entry) => entry.path === file.path)!.bytes),
        })),
      },
    }),
  )
  props.source = rich("source", registered.binding.source_id)
  let markdown = "",
    unknown: boolean | undefined,
    concurrent = ""
  let afterRecord: (() => void) | undefined
  let nativeReadback: ((wire: string) => string) | undefined
  const bodyWrites: unknown[] = []
  const run: typeof f.run = (task) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* task.pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              Effect.suspend(() => {
                if (path === `v1/pages/${target}/markdown?markdown_version=v2`)
                  return Effect.succeed({
                    id: target,
                    markdown,
                    truncated: false,
                    unknown_block_ids: [],
                  })
                if (path === `v1/pages/${target}/markdown` && options?.method === "PATCH") {
                  bodyWrites.push(structuredClone(body))
                  const request = property(body)
                  if (
                    request.type !== "insert_content" ||
                    property(request.insert_content).position !== undefined
                  )
                    return Effect.fail(
                      fail(
                        "TEST_DESTRUCTIVE_WRITE",
                        "Initialization must append without replacing a native preimage.",
                      ),
                    )
                  const candidate = property(request.insert_content).content
                  if (typeof candidate !== "string") throw new Error("Missing insert content")
                  if (unknown !== false)
                    markdown +=
                      concurrent +
                      (nativeReadback?.(candidate) ??
                        candidate.replace("<h1>Initial</h1>", "# Initial"))
                  if (unknown !== undefined) {
                    unknown = undefined
                    return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Controlled lost native ACK"))
                  }
                  return Effect.succeed({
                    id: target,
                    markdown,
                    truncated: false,
                    unknown_block_ids: [],
                  })
                }
                return api.request(path, body, options).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (
                        path === "v1/pages" &&
                        property(property(body).parent).data_source_id ===
                          library.records.data_source_id
                      ) {
                        const hook = afterRecord
                        afterRecord = undefined
                        hook?.()
                      }
                    }),
                  ),
                )
              }),
          }),
        )
      }),
    )
  const author = <A, E>(task: Parameters<typeof f.run<A, E>>[0]) =>
    run(withSharedAuthoringRequest(target, task))
  const read = (readOnly = true) =>
    author(
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly,
        })
      }),
    )
  return {
    f,
    target,
    fileId,
    row,
    member,
    run,
    author,
    read,
    bodyWrites,
    source: registered.binding,
    original: member.portable.files.find((file) => file.path === "SKILL.md")!,
    markdown: () => markdown,
    changeMarkdown: (value: string) => {
      markdown = value
    },
    loseAck: (visible: boolean) => {
      unknown = visible
    },
    appendConcurrently: (value: string) => {
      concurrent = value
    },
    afterFirstRecord: (hook: () => void) => {
      afterRecord = hook
    },
    renderNative: (render: (wire: string) => string) => {
      nativeReadback = render
    },
  }
}
