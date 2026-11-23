import { parseTarget } from "../src/ref.ts"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { property, type Snapshot } from "../src/model.ts"
import type { CurrentFileContent } from "../src/shared-current-file.ts"
import {
  validateCurrentSourceContributions,
  type CurrentSourceContribution,
} from "../src/shared-current-source-input.ts"
import {
  currentSharedSourceRevision,
  validateCurrentSharedSourceContent,
} from "../src/shared-current-source.ts"
import { configureSharedHttpOrigins } from "../src/shared-source-config.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import type { SharedSourcePlan } from "../src/shared-source-plan.ts"
import { targetSnapshot } from "../src/snapshot.ts"
import {
  currentDigest as digest,
  currentId as id,
  currentLibrary,
  currentRich as rich,
  currentSkillPage,
  currentSnapshotFixture,
} from "./shared-current-fixture.ts"

export type SourceFile = {
  readonly path: string
  readonly bytes: Uint8Array
  readonly mode: "100644" | "100755"
}
export const sourceOrigin = "https://resources.example.com"
export const sourceId = "current-provider"
export const sourceLibrary = currentLibrary
const sourceFields = sourceLibrary.sources.property_ids

/** Explicit current rows only. Provider bytes never create a File implicitly. */
export async function currentSourceConsumerFixture() {
  const provider = new Map<string, Uint8Array>()
  const requests: string[] = []
  let response: ((url: string, bytes: Uint8Array | undefined) => Response) | undefined
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(url.href)
      const bytes = provider.get(url.href)
      return HttpClientResponse.fromWeb(
        request,
        response?.(url.href, bytes) ??
          (bytes === undefined
            ? new Response(null, { status: 404 })
            : new Response(bytes.slice(), { headers: { "content-length": String(bytes.length) } })),
      )
    }),
  )
  const base = currentSnapshotFixture({ fileCount: 0, httpClient: client })
  const source: Record<string, unknown> = {
    object: "page",
    id: id(22),
    parent: {
      type: "data_source_id",
      data_source_id: sourceLibrary.sources.data_source_id,
      database_id: sourceLibrary.sources.database_id,
    },
    properties: {},
  }
  base.sources.set(sourceId, source)
  let sourceFiles: readonly SourceFile[] = []
  let revision = ""
  let nextFile = 100
  let contributions: readonly CurrentSourceContribution[] = [
    { member_key: ".", skill_id: "demo", mount_path: "", mapping: {}, exclude: [] },
  ]
  const sourceText = (name: string, value: string) => ({
    ...rich(sourceFields[name]!, value),
    rich_text: sourceRich(value).map((part) => ({ ...part, plain_text: part.text.content })),
  })
  const run = base.run
  await run(configureSharedHttpOrigins([sourceOrigin]))
  const install = async (plan: SharedSourcePlan, files: readonly SourceFile[]) => {
    const content = validateCurrentSharedSourceContent({ version: 1, plan })
    revision = await run(currentSharedSourceRevision(content))
    sourceFiles = files
    source.properties = {
      Name: { id: "title", type: "title", title: [{ plain_text: "Current source" }] },
      "Source ID": rich(sourceFields["Source ID"]!, sourceId),
      Description: sourceText("Description", "Complete selected source"),
      Provider: { id: sourceFields.Provider, type: "select", select: { name: "git" } },
      Location: sourceText("Location", "https://github.com/example/skills"),
      Ref: sourceText("Ref", "main"),
      Policy: { id: sourceFields.Policy, type: "select", select: { name: "manual" } },
      Selection: sourceText(
        "Selection",
        JSON.stringify({ roots: ["."], include: [], exclude: [], mapping: {} }),
      ),
      Options: sourceText("Options", "{}"),
      Contributions: sourceText("Contributions", JSON.stringify(contributions)),
      Content: sourceText("Content", JSON.stringify(content)),
      "Last Revision": rich(sourceFields["Last Revision"]!, revision),
      Enabled: { id: sourceFields.Enabled, type: "checkbox", checkbox: true },
      Status: { id: sourceFields.Status, type: "select", select: { name: "ready" } },
      Operation: rich(sourceFields.Operation!, ""),
    }
    return revision
  }
  const select = async (
    files: readonly SourceFile[],
    kind: "http" | "git" = "http",
    commit = "a".repeat(40),
  ) => {
    if (kind === "git") {
      for (const file of files)
        provider.set(
          `https://raw.githubusercontent.com/example/skills/${commit}/${file.path}`,
          file.bytes,
        )
      return install(
        {
          version: 1,
          kind: "composition",
          mounts: [],
          base: {
            kind: "git",
            source: {
              url: "https://github.com/example/skills",
              commit,
              tree: "b".repeat(40),
              root: "",
              files: files.map((file) => ({
                path: file.path,
                source_path: file.path,
                bytes: file.bytes.length,
                mode: file.mode,
                sha256: digest(file.bytes),
                git_oid: createHash("sha1")
                  .update(`blob ${file.bytes.length}\0`)
                  .update(file.bytes)
                  .digest("hex"),
              })),
            },
          },
        },
        files,
      )
    }
    const locations = new Map(
      files.map((file) => [digest(file.bytes), `${sourceOrigin}/objects/${digest(file.bytes)}`]),
    )
    for (const file of files) provider.set(locations.get(digest(file.bytes))!, file.bytes)
    return install(
      {
        version: 1,
        kind: "composition",
        mounts: [],
        base: {
          kind: "http",
          manifest: {
            version: 1,
            files: files.map((file) => ({
              path: file.path,
              bytes: file.bytes.length,
              sha256: digest(file.bytes),
              mode: file.mode,
            })),
          },
          locations: [...locations].map(([sha256, url]) => ({ sha256, url })),
        },
      },
      files,
    )
  }
  const setFile = (
    path: string,
    content: CurrentFileContent,
    body = "Human reading projection.\n",
  ) => {
    if (path === "SKILL.md") {
      base.main.properties.Content = rich("content", JSON.stringify(content))
      base.bodies.set(currentSkillPage, body)
      return currentSkillPage
    }
    let row = base.files.find(
      (file) => property(file.properties.Path.rich_text[0]).plain_text === path,
    )
    if (row === undefined) {
      row = {
        object: "page",
        id: id(nextFile++),
        last_edited_time: base.main.last_edited_time,
        parent: {
          type: "data_source_id",
          database_id: sourceLibrary.files.database_id,
          data_source_id: sourceLibrary.files.data_source_id,
        },
        properties: {
          Name: { id: "title", type: "title", title: [{ plain_text: path }] },
          "File ID": rich("file-id", `current-file-${nextFile}`),
          Path: rich("path", path),
          Skill: {
            id: "skill",
            type: "relation",
            has_more: false,
            relation: [{ id: currentSkillPage }],
          },
          Content: rich("content", JSON.stringify(content)),
          Origin: {
            id: "origin",
            type: "rollup",
            rollup: { type: "array", array: [], function: "show_unique" },
          },
        },
      }
      base.files.push(row)
    }
    row.properties.Content = rich("content", JSON.stringify(content))
    base.bodies.set(row.id, body)
    return row.id
  }
  return {
    ...base,
    run,
    source,
    provider,
    requests,
    install,
    select,
    contribute: (entries: readonly CurrentSourceContribution[]) => {
      contributions = validateCurrentSourceContributions(entries)
      source.properties = {
        ...property(source.properties),
        Contributions: sourceText("Contributions", JSON.stringify(contributions)),
      }
    },
    get revision() {
      return revision
    },
    visible: (value: boolean) => {
      if (value) base.sources.set(sourceId, source)
      else base.sources.delete(sourceId)
    },
    response: (value: typeof response) => {
      response = value
    },
    bind: (path: string, sourcePath = path) => {
      const file = sourceFiles.find((file) => file.path === sourcePath)
      if (file === undefined) throw new Error("Bind an explicit current source path.")
      return setFile(path, {
        kind: "source",
        source_id: sourceId,
        revision,
        source_path: sourcePath,
        sha256: digest(file.bytes),
        bytes: file.bytes.length,
        mode: file.mode,
      })
    },
    native: (path: string, body: string, frontmatter = "") =>
      setFile(path, { kind: "native", mode: "100644", frontmatter }, body),
    target: (
      options: Parameters<typeof targetSnapshot>[1] = {},
      access: Parameters<typeof targetSnapshot>[2] = "all",
      path = "",
    ) =>
      run(
        targetSnapshot(
          parseTarget(currentSkillPage, path),
          { database: sourceLibrary.skills.database_id, ...options },
          access,
        ),
      ),
    bytes: (snapshot: Snapshot, path: string) => {
      const file = snapshot.files.find((file) => file.path === path)
      const bytes = file === undefined ? undefined : base.objects.get(`objects/${file.sha256}`)
      if (bytes === undefined) throw new Error("The selected file was not materialized.")
      return bytes
    },
  }
}
