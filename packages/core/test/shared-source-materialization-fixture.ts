import { createHash } from "node:crypto"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Notion } from "../src/notion.ts"
import { property } from "../src/model.ts"
import { currentSourceWriteProperties } from "../src/shared-current-source-management.ts"
import {
  prepareCurrentSource,
  prepareCurrentSourceFromDiscovery,
  type CurrentSourceDeclaration,
} from "../src/shared-current-source-input.ts"
import { SourceManagerExecution } from "../src/shared-current-source-writer.ts"
import {
  CurrentSourceMaterializationProvider,
  materializeRegisteredSource,
} from "../src/shared-source-materialization-management.ts"
import {
  readMaterializationRegistration,
  sourceRegistrationDigest,
} from "../src/shared-source-materialization-registration.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import type { SourceMaterializationRequest } from "../src/shared-source-materialization-model.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"
import { currentWriteFixture, library, testBytes } from "./shared-current-write-fixture.ts"

export { library }
export const sourceId = "materialization-source"
export const commit = "a".repeat(40),
  tree = "b".repeat(40)
export const declaration: CurrentSourceDeclaration = {
  version: 1,
  definition: {
    version: 1,
    source_id: sourceId,
    name: "Materialization source",
    description: "Original Git members",
    enabled: true,
    policy: "manual",
    adapter: { type: "git", url: "https://github.com/example/materialization.git", ref: "main" },
    selection: { roots: ["skills"], include: [], exclude: [], mapping: {} },
    options: {},
  },
  contributions: [],
}
export function observation(
  names: readonly string[] = ["root", "required", "sibling"],
): SourceSnapshot {
  return {
    revision: commit,
    provenance: {
      provider: "git",
      git_url: "https://github.com/example/materialization.git",
      resolved_ref: commit,
      tree_hash: tree,
    },
    members: names.map((name) => {
      const root = `skills/${name}`,
        files = [
          {
            path: "SKILL.md",
            mode: "100644" as const,
            bytes: testBytes(
              `---\nname: ${name}\ndescription: Complete ${name} skill\n---\n\n# ${name}\n\nEntire original skill body.\n`,
            ),
          },
          { path: "run.sh", mode: "100755" as const, bytes: testBytes("#!/bin/sh\nexit 0\n") },
        ]
      return {
        member_key: root,
        source_path: root,
        portable: {
          kind: "skill" as const,
          name,
          description: `Complete ${name} skill`,
          main: "SKILL.md",
          files,
        },
        upstream_hash: "c".repeat(64),
        content_hash: "d".repeat(64),
        git_manifest: {
          commit,
          tree,
          root,
          files: files.map((file) => ({
            path: file.path,
            source_path: `${root}/${file.path}`,
            git_oid: createHash("sha1")
              .update(`blob ${file.bytes.length}\0`)
              .update(file.bytes)
              .digest("hex"),
            bytes: file.bytes.length,
            mode: file.mode,
          })),
        },
      }
    }),
  }
}
export async function materializationFixture(
  parent: string,
  mode: "legacy-source" | "legacy-members" | "source-only" = "legacy-source",
) {
  const f = currentWriteFixture(parent)
  let preparationCount = 0
  const observed = observation()
  const assigned = ["root", "required", "sibling"].map((name) => ({
    member_key: `skills/${name}`,
    skill_id: `legacy-${name}`,
    mount_path: "",
    mapping: {},
    exclude: [],
  }))
  const full = await f.run(
    prepareCurrentSourceFromDiscovery({ ...declaration, contributions: assigned }, observed),
  )
  const source = await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library.sources.data_source_id },
          properties: {
            ...currentSourceWriteProperties(library, {
              declaration: {
                ...declaration,
                contributions: mode === "legacy-members" ? assigned : [],
              },
              content: full.prepared_source.content,
              revision: full.prepared_source.revision,
            }),
            [library.sources.property_ids.Status!]: { select: { name: "ready" } },
            [library.sources.property_ids.Operation!]: { rich_text: [] },
            ...(mode === "legacy-source"
              ? {
                  [library.sources.property_ids.Content!]: { rich_text: [] },
                  [library.sources.property_ids["Last Revision"]!]: { rich_text: [] },
                }
              : {}),
          },
        },
        { method: "POST" },
      ),
    ),
  )
  const sourcePage = String(property(source).id)
  const owners = new Map<string, string>()
  if (mode !== "source-only")
    for (const name of ["root", "required", "sibling"]) {
      const p = library.skills.property_ids
      const raw = await f.run(
        Effect.flatMap(Notion, (api) =>
          api.request(
            "v1/pages",
            {
              parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
              properties: {
                [p.Name!]: { title: sourceRich(name) },
                [p.Description!]: { rich_text: sourceRich(`Complete ${name} skill`) },
                [p.Kind!]: { select: { name: "skill" } },
                [p.Enabled!]: { checkbox: name !== "sibling" },
                [p["Default Context"]!]: { checkbox: false },
                [p["Skill ID"]!]: { rich_text: sourceRich(`legacy-${name}`) },
                [p["Main File ID"]!]: { rich_text: sourceRich(`legacy-main-${name}`) },
                [p.Content!]: { rich_text: [] },
                [p["Current State"]!]: { select: null },
                [p.Operation!]: { rich_text: [] },
                [p.Origin!]: { relation: [{ id: sourcePage }] },
                [p.Requires!]: { relation: [] },
                [p.Members!]: { relation: [] },
                "Source Member": { rich_text: sourceRich(`skills/${name}`) },
                "Upstream Revision": { rich_text: sourceRich(commit) },
                日用: { checkbox: false },
                期望删除: { checkbox: false },
              },
            },
            { method: "POST" },
          ),
        ),
      )
      owners.set(name, String(property(raw).id))
    }
  if (owners.size)
    await f.run(
      Effect.flatMap(Notion, (api) =>
        api.request(
          `v1/pages/${owners.get("root")}`,
          {
            properties: {
              [library.skills.property_ids.Requires!]: {
                relation: [{ id: owners.get("required") }],
              },
              [library.skills.property_ids.Members!]: { relation: [{ id: owners.get("sibling") }] },
            },
          },
          { method: "PATCH" },
        ),
      ),
    )
  const provider = {
    prepare: (input: unknown, options: Parameters<typeof prepareCurrentSource>[1] = {}) => {
      preparationCount++
      const selected =
        options.memberKeys === undefined
          ? observed
          : {
              ...observed,
              members: observed.members.filter((member) =>
                options.memberKeys!.includes(member.member_key),
              ),
            }
      return prepareCurrentSourceFromDiscovery(input, selected, options)
    },
  }
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Parameters<typeof f.run>[0] extends Effect.Effect<unknown, unknown, infer R> ? R : never
    >,
  ) =>
    f.run(
      Effect.gen(function* () {
        const original = yield* HttpClient.HttpClient
        const client = HttpClient.make((request) => {
          const member = observed.members.find((member) =>
            request.url.includes(`/${member.member_key}/`),
          )
          const file = member?.portable.files.find((file) => request.url.endsWith(`/${file.path}`))
          return file === undefined
            ? original.execute(request)
            : Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(new Uint8Array(file.bytes))),
              )
        })
        return yield* effect.pipe(
          Effect.provideService(CurrentSourceMaterializationProvider, provider),
          Effect.provideService(SourceManagerExecution, {
            library_id: library.library_id,
            store_root: f.root,
            source_ids: [sourceId],
          }),
          Effect.provideService(HttpClient.HttpClient, client),
        )
      }),
    )
  const request = async (
    purpose: "use" | "inspect" = "use",
    skillId?: string,
  ): Promise<SourceMaterializationRequest> => {
    const registered = await f.run(readMaterializationRegistration(library, sourceId))
    const expected =
      skillId ??
      (mode === "source-only"
        ? full.declaration.contributions.find((entry) => entry.member_key === "skills/root")!
            .skill_id
        : "legacy-root")
    return {
      version: 1,
      library: library.library_id,
      request_id: `request-${purpose}`,
      purpose,
      target: {
        source_id: sourceId,
        member_key: "skills/root",
        expected_skill_id: expected,
        registration_digest: await f.run(sourceRegistrationDigest(registered)),
        expected_source_commit: commit,
        ...(registered.current === undefined
          ? {}
          : { expected_source_revision: registered.current.revision }),
      },
    }
  }
  f.clearCalls()
  return {
    ...f,
    runManaged: run,
    materialize: (input: SourceMaterializationRequest) =>
      run(materializeRegisteredSource(library, input)),
    request,
    sourcePage,
    owners,
    observed,
    full,
    preparedCount: () => preparationCount,
  }
}
