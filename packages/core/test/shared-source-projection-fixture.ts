import { createHash } from "node:crypto"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { property, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  readSourceDefinition,
  sourceDefinitionPropertiesFor,
} from "../src/shared-source-definitions.ts"
import { prepareSharedSourceProjection } from "../src/shared-source-projection.ts"
import type { SharedCreatePlan } from "../src/shared-create-model.ts"
import { sourceDefinitionLayout, type SourceDefinitionInput } from "../src/shared-sources-model.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"
import { sharedCreateFixture, createLibrary } from "./shared-create-fixture.ts"
import { id, encode } from "./shared-snapshot-fixture.ts"

export const layout = sourceDefinitionLayout(
  createLibrary.skills.data_source_id,
  createLibrary.records.data_source_id,
)
export const ids = Object.fromEntries(
  Object.keys(layout).map((name, index) => [name, name === "Name" ? "title" : `source-${index}`]),
)
export const library = {
  ...createLibrary,
  skills: {
    ...createLibrary.skills,
    property_ids: {
      ...createLibrary.skills.property_ids,
      Origin: "origin",
      "Source Member": "source_member",
    },
  },
  records: {
    ...createLibrary.records,
    property_ids: { ...createLibrary.records.property_ids, Origin: "origin" },
  },
  sources: { database_id: id(80), data_source_id: id(81), property_ids: ids },
}
export const input: SourceDefinitionInput = {
  version: 1,
  source_id: "initial-source",
  name: "Initial source",
  description: "Initial complete member",
  enabled: true,
  policy: "manual",
  adapter: { type: "git", url: "https://github.com/example/initial-source", ref: "a".repeat(40) },
  selection: { roots: ["skills/demo"], include: [], exclude: [], mapping: {} },
  options: {},
}
export function fixedProjection(plan: SharedCreatePlan) {
  if (plan.source_projection?.version !== 1)
    throw new Error("Expected fixed Git projection in controlled fixture")
  return plan.source_projection
}
export function fixture(
  extraFiles: readonly {
    readonly path: string
    readonly bytes: Uint8Array
    readonly mode: "100644" | "100755"
  }[] = [],
  options: {
    readonly main?: string
    readonly readback?: (wire: string) => string
    readonly recovery?: boolean
  } = {},
) {
  const files = [
    {
      path: "SKILL.md",
      bytes: encode(
        options.main ??
          "---\nname: initial-source\ndescription: Initial complete member\nlicense: MIT\n---\n\n# Initial\n\n[Guide](references/a.md) [Script](scripts/run.js) ![Icon](assets/icon.png)\n",
      ),
      mode: "100644" as const,
    },
    {
      path: "assets/icon.png",
      bytes: new Uint8Array([137, 80, 78, 71, 0, 255]),
      mode: "100644" as const,
    },
    { path: "data/options.json", bytes: encode('{"complete":true}\n'), mode: "100644" as const },
    {
      path: "references/a.md",
      bytes: encode("# Guide\n\n[Options](../data/options.json)\n"),
      mode: "100644" as const,
    },
    {
      path: "scripts/run.js",
      bytes: encode("#!/usr/bin/env node\nconsole.log('original')\n"),
      mode: "100755" as const,
    },
    ...extraFiles,
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const revisions = new Map<string, SourceSnapshot["members"][number]["portable"]["files"]>()
  let providerReads = 0
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      providerReads++
      const commit = url.pathname.split("/").find((part) => /^[a-f0-9]{40}$/u.test(part))
      const file = (revisions.get(commit ?? "") ?? []).find((candidate) =>
        url.pathname.endsWith(`/${candidate.path}`),
      )
      return HttpClientResponse.fromWeb(
        request,
        file === undefined
          ? new Response(null, { status: 404 })
          : new Response(file.bytes.slice(), {
              headers: { "content-length": String(file.bytes.length) },
            }),
      )
    }),
  )
  const f = sharedCreateFixture({ httpClient: client, ...options })
  const props = sourceDefinitionPropertiesFor(library, input)
  const source: {
    object: string
    id: string
    parent: { data_source_id: string }
    properties: Record<string, unknown>
  } = {
    object: "page",
    id: id(82),
    parent: { data_source_id: library.sources.data_source_id },
    properties: Object.fromEntries(
      Object.entries(layout).map(([name, shape]) => {
        const key = ids[name]!,
          type = Object.keys(shape)[0]!
        return [
          key,
          {
            id: key,
            type,
            ...(props[key] ??
              (type === "rich_text"
                ? { rich_text: [] }
                : type === "select"
                  ? { select: null }
                  : type === "relation"
                    ? { relation: [], has_more: false }
                    : { date: null })),
          },
        ]
      }),
    ),
  }
  const snapshot: SourceSnapshot = {
    revision: "a".repeat(40),
    provenance: {
      provider: "git",
      git_url: input.adapter.type === "git" ? input.adapter.url : "",
      committed_at: "2026-11-08T00:00:00Z",
    },
    members: [
      {
        member_key: "skills/demo",
        source_path: "skills/demo",
        upstream_hash: "a".repeat(64),
        content_hash: "b".repeat(64),
        portable: {
          kind: "skill",
          name: "initial-source",
          description: "Initial complete member",
          main: "SKILL.md",
          files,
        },
        git_manifest: {
          commit: "a".repeat(40),
          tree: "b".repeat(40),
          root: "skills/demo",
          files: files.map((file) => ({
            path: file.path,
            source_path: `skills/demo/${file.path}`,
            bytes: file.bytes.length,
            mode: file.mode,
            git_oid: createHash("sha1")
              .update(Buffer.from(`blob ${file.bytes.length}\0`))
              .update(file.bytes)
              .digest("hex"),
          })),
        },
      },
    ],
  }
  revisions.set(snapshot.revision, snapshot.members[0]!.portable.files)
  const registerSnapshot = (next: SourceSnapshot) =>
    revisions.set(next.revision, next.members[0]!.portable.files)
  const run: typeof f.run = (effect) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const wrapper: Notion["Service"] = {
          ...api,
          request: (path, body, options) =>
            Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
              if (path === `v1/pages/${source.id}`) return Effect.succeed(structuredClone(source))
              if (path === `v1/databases/${library.skills.database_id}`)
                return api.request(path, body, options).pipe(
                  Effect.map((raw) => ({
                    ...property(raw),
                    description: [
                      { plain_text: "ntn-skills-library:v1 " + JSON.stringify(library) },
                    ],
                  })),
                )
              return api.request(path, body, options)
            }),
        }
        return yield* effect.pipe(Effect.provideService(Notion, wrapper))
      }),
    )
  const prepare = (enabled?: boolean) =>
    run(
      Effect.gen(function* () {
        const definition = yield* readSourceDefinition(library, source.id)
        const plan = yield* prepareSharedSourceProjection({
          library,
          definition,
          acquired: snapshot,
          member: "skills/demo",
          skillId: "fixed-initial-skill",
          ...(enabled === undefined ? {} : { enabled }),
        })
        return { ...plan, source_projection: fixedProjection(plan) }
      }),
    )
  return {
    ...f,
    run,
    source,
    snapshot,
    prepare,
    registerSnapshot,
    providerReads: () => providerReads,
  }
}
