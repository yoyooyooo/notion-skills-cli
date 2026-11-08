import { Cause, Config, Crypto, Effect, Exit, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http"
import { fail, property, SkillsError } from "./model.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import { importDocument } from "./import.ts"
import { portableIdentity } from "./export.ts"
import { canonicalMain, type PortableSkill } from "./portable.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import { discoverSource, type DiscoverSourceInput, type SourceSnapshot } from "./upstream-source.ts"
import { SourcePatchSchema } from "./upstream-source-model.ts"
import { sourceChecked, sourceConfiguration } from "./shared-source-definitions.ts"
import type { SourceDefinitionInput } from "./shared-sources-model.ts"
import type { createRequestMetrics } from "./request-metrics.ts"

export const sourceAdapterCapabilities = [
  {
    type: "git",
    locations: ["GitHub", "GitLab", "self-hosted HTTPS/SSH Git"],
    discovery: true,
    exact_revision: "commit",
    executes_files: false,
  },
  {
    type: "registry",
    locations: ["versioned registry"],
    discovery: true,
    exact_revision: "registry version",
    executes_files: false,
  },
  {
    type: "github-market",
    locations: ["skills.sh"],
    discovery: true,
    exact_revision: "commit",
    executes_files: false,
  },
  {
    type: "linear",
    locations: ["issue", "document"],
    discovery: true,
    exact_revision: "captured content hash and updatedAt",
    credential: "LINEAR_API_KEY (machine only)",
    executes_files: false,
  },
] as const

export function sourceDiscoveryInput(input: SourceDefinitionInput): DiscoverSourceInput {
  const definition = sourceConfiguration(input)
  if (definition.adapter.type === "linear")
    throw fail("SOURCE_ADAPTER_INVALID", "Linear does not use Git selection.")
  const options = definition.options
  const permitted = new Set([
    "patch",
    "member_patches",
    "require_all_included",
    "accepted_ref",
    "target_mode",
    "strip_prefix",
    "target_prefix",
    "shared_target_set",
    "publisher_subscription_id",
    "external_assets",
    "external_markdown",
    "check_interval_ms",
  ])
  for (const key of Object.keys(options))
    if (!permitted.has(key))
      throw fail(
        "SOURCE_ADAPTER_OPTIONS_UNSUPPORTED",
        "An explicit source option has no implemented adapter behavior; it cannot be silently discarded.",
        { option: key },
      )
  if (options.external_assets !== undefined || options.external_markdown !== undefined) {
    if (
      options.external_assets !== true ||
      !Array.isArray(options.external_markdown) ||
      options.external_markdown.some((item) => typeof item !== "string" || !item.endsWith(".md")) ||
      definition.selection.roots.length !== 1 ||
      definition.selection.roots[0] !== "."
    )
      throw fail(
        "SOURCE_ADAPTER_OPTIONS_UNSUPPORTED",
        "External asset declarations require a complete repository-root selection and explicit Markdown paths; external network asset fetching is not implied.",
      )
  }
  const patch =
    options.patch === undefined
      ? undefined
      : Schema.decodeUnknownSync(SourcePatchSchema)(options.patch, { onExcessProperty: "error" })
  const memberPatches =
    options.member_patches === undefined
      ? undefined
      : Schema.decodeUnknownSync(Schema.Record(Schema.String, SourcePatchSchema))(
          options.member_patches,
          { onExcessProperty: "error" },
        )
  if (
    options.require_all_included !== undefined &&
    typeof options.require_all_included !== "boolean"
  )
    throw fail("SOURCE_DEFINITION_INVALID", "require_all_included must be boolean.")
  if (options.accepted_ref !== undefined && typeof options.accepted_ref !== "string")
    throw fail("SOURCE_DEFINITION_INVALID", "accepted_ref must be an exact revision string.")
  return {
    source: definition.adapter,
    ...definition.selection,
    allow_empty: false,
    require_all_included: options.require_all_included === true,
    ...(patch ? { patch } : {}),
    ...(memberPatches ? { member_patches: memberPatches } : {}),
    ...(typeof options.accepted_ref === "string" ? { accepted_ref: options.accepted_ref } : {}),
  }
}
export type LinearSourceTransport = (
  query: string,
  variables: { id: string },
) => Effect.Effect<unknown, SkillsError, Crypto.Crypto | HttpClient.HttpClient>
const linearTransport =
  (metrics?: ReturnType<typeof createRequestMetrics>): LinearSourceTransport =>
  (query, variables) =>
    Effect.gen(function* () {
      const token = yield* Config.String("LINEAR_API_KEY").pipe(
        Config.withDefault(""),
        Effect.mapError(() =>
          fail("SOURCE_AUTH_REQUIRED", "Linear source credential is unavailable."),
        ),
      )
      if (!token)
        return yield* Effect.fail(
          fail(
            "SOURCE_AUTH_REQUIRED",
            "Linear sources require this machine's LINEAR_API_KEY; credentials never enter shared configuration.",
          ),
        )
      const client = yield* HttpClient.HttpClient
      const request = yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post("https://api.linear.app/graphql").pipe(
          HttpClientRequest.setHeader("Authorization", token),
          HttpClientRequest.acceptJson,
        ),
        { query, variables },
      ).pipe(
        Effect.mapError(() =>
          fail("SOURCE_PROVIDER_INVALID", "Linear request could not be encoded."),
        ),
      )
      const key = yield* sha256(canonicalSharedJson(["linear", token, query, variables]))
      let finish: ReturnType<ReturnType<typeof createRequestMetrics>["begin"]> | undefined
      let received: number | undefined
      let status: number | undefined
      return yield* Effect.scoped(
        Effect.gen(function* () {
          finish = metrics?.begin({
            path: "/graphql",
            method: "POST",
            provider: "linear",
            key,
            ...(request.body._tag === "Uint8Array"
              ? { requestBytes: request.body.body.byteLength }
              : {}),
          })
          const response = yield* HttpClient.withScope(client).execute(request)
          status = response.status
          if (status < 200 || status >= 300)
            return yield* Effect.fail(
              fail("SOURCE_PROVIDER_FAILED", "Linear rejected the read-only request.", { status }),
            )
          let bytes = 0
          received = bytes
          const text = yield* response.stream.pipe(
            Stream.mapEffect((chunk) => {
              bytes += chunk.byteLength
              received = bytes
              return bytes > 8 * 1024 * 1024
                ? Effect.fail(fail("SOURCE_PROVIDER_LIMIT", "Linear response exceeds 8 MiB."))
                : Effect.succeed(chunk)
            }),
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          )
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text)
        }),
      ).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "error",
          credentials: "omit",
        }),
        Effect.timeout("45 seconds"),
        Effect.mapError((error) => {
          if (error instanceof SkillsError) return error
          if (Cause.isTimeoutError(error))
            return fail(
              "SOURCE_PROVIDER_TIMEOUT",
              "Linear source read exceeded its bounded deadline.",
            )
          if (HttpClientError.isHttpClientError(error) && error.reason._tag === "EmptyBodyError")
            return fail("SOURCE_PROVIDER_INVALID", "Linear returned no response body.")
          return fail(
            "SOURCE_PROVIDER_FAILED",
            "Linear read failed; no response, credential or request headers were retained.",
          )
        }),
        Effect.onExit((exit) =>
          Effect.sync(() =>
            finish?.({
              outcome: Exit.isSuccess(exit)
                ? "success"
                : Exit.hasInterrupts(exit)
                  ? "cancelled"
                  : "failure",
              ...(received === undefined ? {} : { responseBytes: received }),
              ...(status === undefined ? {} : { httpStatus: status }),
            }),
          ),
        ),
      )
    })

export function discoverLinearSource(
  input: SourceDefinitionInput,
  transport: LinearSourceTransport = linearTransport(),
) {
  return Effect.gen(function* () {
    const definition = yield* sourceChecked(() => sourceConfiguration(input))
    if (definition.adapter.type !== "linear")
      return yield* Effect.fail(fail("SOURCE_ADAPTER_INVALID", "Expected a Linear definition."))
    if (
      Object.keys(definition.options).some((key) => key !== "check_interval_ms") ||
      canonicalSharedJson(definition.selection) !==
        canonicalSharedJson({ roots: ["."], include: [], exclude: [], mapping: {} })
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_ADAPTER_OPTIONS_UNSUPPORTED",
          "Linear uses exact resource-to-file mappings; Git selectors or transformations are not accepted.",
        ),
      )
    const observed = yield* Effect.forEach(
      definition.adapter.resources,
      (resource) =>
        Effect.gen(function* () {
          const field = resource.kind
          const raw = property(
            yield* transport(
              `query SourceResource($id: String!) { ${field}(id: $id) { id ${field === "issue" ? "identifier" : ""} title ${field === "issue" ? "description" : "content"} updatedAt } }`,
              { id: resource.id },
            ),
          )
          return yield* sourceChecked(() => {
            if (raw.errors !== undefined && (!Array.isArray(raw.errors) || raw.errors.length > 0))
              throw fail(
                "SOURCE_PROVIDER_PARTIAL",
                "Linear returned GraphQL errors; partial content is not a source snapshot.",
              )
            const value = property(property(raw.data)[field]),
              body = value[field === "issue" ? "description" : "content"]
            if (
              typeof value.id !== "string" ||
              !value.id ||
              typeof value.title !== "string" ||
              typeof body !== "string" ||
              typeof value.updatedAt !== "string" ||
              !Number.isFinite(Date.parse(value.updatedAt))
            )
              throw fail(
                "SOURCE_PROVIDER_INCOMPLETE",
                "Selected Linear resource is missing complete identity, content or revision metadata.",
              )
            if (/^[a-f0-9-]{36}$/u.test(resource.id) && value.id !== resource.id)
              throw fail("SOURCE_PROVIDER_SCOPE", "Linear returned a different selected identity.")
            if (
              field === "issue" &&
              !/^[a-f0-9-]{36}$/u.test(resource.id) &&
              (typeof value.identifier !== "string" ||
                value.identifier.toUpperCase() !== resource.id.toUpperCase())
            )
              throw fail(
                "SOURCE_PROVIDER_SCOPE",
                "Linear returned a different selected issue identifier.",
              )
            return {
              path: resource.path,
              bytes: new TextEncoder().encode(body),
              id: value.id,
              kind: field,
              updated_at: value.updatedAt,
              title: value.title,
            }
          })
        }),
      { concurrency: 4 },
    )
    const main = observed.find((file) => file.path === "SKILL.md")!
    const document = yield* sourceChecked(() =>
      importDocument(main, { name: definition.name, description: definition.description }),
    )
    const files = observed
      .map((file) =>
        file.path === "SKILL.md"
          ? canonicalMain(definition.name, definition.description, document.body, file)
          : { path: file.path, bytes: file.bytes },
      )
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const portable = {
      kind: "skill" as const,
      name: definition.name,
      description: definition.description,
      main: "SKILL.md",
      files,
    } satisfies PortableSkill
    const hash = yield* portableIdentity(portable)
    const resourceVersions = yield* Effect.forEach(observed, (resource) =>
      Effect.gen(function* () {
        return {
          kind: resource.kind,
          id: resource.id,
          path: resource.path,
          updated_at: resource.updated_at,
          sha256: yield* sha256(resource.bytes),
        }
      }),
    )
    const revision = `linear-${yield* sha256(canonicalSharedJson(resourceVersions))}`
    const snapshot: SourceSnapshot = {
      revision,
      provenance: {
        provider: "linear",
        endpoint: "https://api.linear.app/graphql",
        observation: "exact selected resource bodies; not a provider historical revision",
        resources: canonicalSharedJson(resourceVersions),
      },
      members: [
        { member_key: ".", source_path: ".", portable, upstream_hash: hash, content_hash: hash },
      ],
    }
    return snapshot
  })
}
export function discoverSourceDefinition(
  input: SourceDefinitionInput,
  options: { readonly metrics?: ReturnType<typeof createRequestMetrics> } = {},
) {
  return Effect.gen(function* () {
    const definition = yield* sourceChecked(() => sourceConfiguration(input))
    if (!definition.enabled)
      return yield* Effect.fail(
        fail(
          "SOURCE_DISABLED",
          "This source is disabled; current fixed content remains available.",
        ),
      )
    if (definition.adapter.type === "linear")
      return yield* discoverLinearSource(definition, linearTransport(options.metrics))
    const snapshot = yield* discoverSource(
      yield* sourceChecked(() => sourceDiscoveryInput(definition)),
      options,
    )
    if (definition.options.external_assets === true) {
      yield* sourceChecked(() => {
        if (snapshot.unavailable?.length || snapshot.external_resources?.length)
          throw fail(
            "SOURCE_EXTERNAL_ASSETS_INCOMPLETE",
            "Declared assets escape the fully captured source member; no external location is substituted.",
          )
        const root = snapshot.members.find((member) => member.member_key === ".")
        if (!root)
          throw fail(
            "SOURCE_EXTERNAL_ASSETS_INCOMPLETE",
            "The declared complete root member is missing.",
          )
        for (const path of definition.options.external_markdown as string[])
          if (!root.portable.files.some((file) => file.path === path))
            throw fail(
              "SOURCE_EXTERNAL_ASSETS_INCOMPLETE",
              "An explicitly required Markdown asset is missing.",
              { path },
            )
        assertSharedFileReferences(root.portable.files)
      })
    }
    return snapshot
  })
}
