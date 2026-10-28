import { Context, Effect, Schema } from "effect"
import { fail, property, SkillsError, text, type Snapshot } from "./model.ts"
import { Notion } from "./notion.ts"
import type { PortableSkill } from "./portable.ts"
import { sha256, Store } from "./store.ts"
import type { ManagedContent } from "./upstream-model.ts"
import { canonicalMain } from "./portable.ts"
import { fromNotionMarkdown, stripNotionInlineBoundaries } from "./markdown.ts"
import { rewritePageLinks, withoutChildPages } from "./references.ts"
import { memberIds } from "./router-members.ts"
import { canonical as observationCanonical, metadata } from "./publication-observation.ts"
import { hasTypedLinks, materializeTypedLinks } from "./typed-links.ts"
import { decodeMarkdownFiles, readMarkdownFileBlocks } from "./markdown-files.ts"

export const PUBLICATION_PROPERTY = "Publication"
import { PublicationMarkerSchema } from "./publication-integrity-state.ts"
import type {
  PublicationMarker,
  WritingMarker,
  CommittedMarker,
} from "./publication-integrity-state.ts"
export { PublicationMarkerSchema } from "./publication-integrity-state.ts"
export type {
  PublicationMarker,
  WritingMarker,
  CommittedMarker,
} from "./publication-integrity-state.ts"

/** Only the operation's own internal verification can read its uncommitted projection. */
export const PublicationReadOperation = Context.Reference<string | undefined>(
  "ntn-skills/PublicationReadOperation",
  { defaultValue: () => undefined },
)
/** Explicit maintainer inspection is used for conflict planning and accepting a direct Notion edit. */
export const PublicationInspectDivergence = Context.Reference<boolean>(
  "ntn-skills/PublicationInspectDivergence",
  { defaultValue: () => false },
)
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}
const attempt = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("PUBLICATION_INVALID", "Publication metadata is invalid."),
  })

/** Empty/missing means a manually maintained, unenrolled Notion page. Malformed never means empty. */
export function publicationMarker(rawPage: unknown): PublicationMarker | undefined {
  const field = property(property(rawPage).properties)[PUBLICATION_PROPERTY]
  if (field === undefined) return undefined
  const value = property(field)
  if (value.type !== "rich_text" || !Array.isArray(value.rich_text))
    throw fail("PUBLICATION_INVALID", "Publication must be a rich-text property.")
  const source = text(value.rich_text)
  if (!source) return undefined
  let decoded: unknown
  try {
    decoded = JSON.parse(source)
  } catch {
    throw fail("PUBLICATION_INVALID", "Publication contains an invalid completion pointer.")
  }
  if (property(decoded).version === 1)
    throw fail(
      "PUBLICATION_UPGRADE_REQUIRED",
      "Publication proof version 1 requires the independent reviewed remote-proof converter before this page can be read or changed.",
      { page_id: property(rawPage).id, proof_version: 1, required_proof_version: 2 },
    )
  try {
    return Schema.decodeUnknownSync(PublicationMarkerSchema)(decoded, { onExcessProperty: "error" })
  } catch {
    throw fail("PUBLICATION_INVALID", "Publication contains an invalid completion pointer.")
  }
}
export function publicationProperties(marker: PublicationMarker) {
  return {
    [PUBLICATION_PROPERTY]: {
      rich_text: [{ type: "text", text: { content: JSON.stringify(marker) } }],
    },
  }
}
function requirePublicationProperty(rawPage: unknown) {
  const field = property(property(property(rawPage).properties)[PUBLICATION_PROPERTY])
  if (field.type !== "rich_text")
    throw fail(
      "PUBLICATION_SCHEMA_REQUIRED",
      "Managed publication requires the Publication rich-text property; run init on the exact content database.",
    )
}

export function preparePublicationIntegrity(operationId: string, portable: PortableSkill) {
  return Effect.gen(function* () {
    const store = yield* Store
    const files: Array<readonly [string, number, string]> = []
    for (const file of [...portable.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ))
      files.push([file.path, file.bytes.length, yield* sha256(file.bytes)])
    const intended_hash = yield* sha256(
      canonical([portable.kind, portable.name, portable.description, portable.main, files]),
    )
    const previous = yield* store.integrity.inspect(operationId)
    if (previous) {
      if (previous.intended_hash !== intended_hash)
        return yield* Effect.fail(
          fail(
            "PUBLICATION_INTENT_CONFLICT",
            "An operation identity cannot publish different content.",
          ),
        )
      return {
        version: 2,
        operation_id: operationId,
        intended_hash,
        state: "writing",
      } satisfies WritingMarker
    }
    const marker: WritingMarker = {
      version: 2,
      operation_id: operationId,
      intended_hash,
      state: "writing",
    }
    yield* store.integrity.prepare({ version: 1, operation_id: operationId, intended_hash, marker })
    return marker
  })
}

export function preparedPublicationMarker(operationId: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    const intent = yield* store.integrity.inspect(operationId)
    if (!intent)
      return yield* Effect.fail(
        fail("PUBLICATION_UNRESOLVED", "Publication has no persisted intended revision."),
      )
    return {
      version: 2,
      state: "writing",
      operation_id: operationId,
      intended_hash: intent.intended_hash,
    } satisfies WritingMarker
  })
}
/** Call through the journalled Notion service, after its existing-page baseline check. */
export function startPublicationIntegrity(operationId: string, pageId: string) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const store = yield* Store
    const intent = yield* store.integrity.inspect(operationId)
    if (!intent)
      return yield* Effect.fail(
        fail("PUBLICATION_UNRESOLVED", "Publication has no persisted intended content revision."),
      )
    const raw = yield* api.request(`v1/pages/${pageId}`)
    yield* attempt(() => requirePublicationProperty(raw))
    const current = yield* attempt(() => publicationMarker(raw))
    if (current?.state === "writing" && current.operation_id !== operationId)
      return yield* Effect.fail(
        fail("PUBLICATION_INCOMPLETE", "Another publication has not committed this content item.", {
          operation_id: current.operation_id,
          page_id: pageId,
        }),
      )
    const marker: WritingMarker = {
      version: 2,
      operation_id: operationId,
      intended_hash: intent.intended_hash,
      state: "writing",
      ...(current?.state === "committed"
        ? { base_revision: current.revision }
        : current?.state === "writing" && current.base_revision
          ? { base_revision: current.base_revision }
          : {}),
    }
    // Bind the exact page durably before the marker request can have an unknown outcome.
    yield* store.integrity.update({ ...intent, page_id: pageId, marker })
    if (canonical(current) !== canonical(marker))
      yield* api.request(
        `v1/pages/${pageId}`,
        { properties: publicationProperties(marker) },
        { method: "PATCH" },
      )
    return marker
  })
}

/** Only publisher-owned fields participate; Default Context, Members and arbitrary organization fields do not. */
export function publicationOwnership(rawPage: unknown) {
  const fields = property(property(rawPage).properties)
  const rich = (name: string) => {
    const field = fields[name]
    if (field === undefined) return ""
    const value = property(field)
    if (value.type !== "rich_text" || !Array.isArray(value.rich_text))
      throw fail("INVALID_UPSTREAM", `${name} must be a rich-text property.`)
    return text(value.rich_text)
  }
  const relation = property(fields.Upstream)
  const mode = property(fields["Sync Mode"])
  if (
    fields.Upstream !== undefined &&
    (relation.type !== "relation" ||
      !Array.isArray(relation.relation) ||
      relation.has_more === true ||
      relation.relation.length > 1)
  )
    throw fail("INVALID_UPSTREAM", "Upstream must contain at most one complete relation.")
  if (
    fields["Sync Mode"] !== undefined &&
    (mode.type !== "select" ||
      (mode.select !== null && !["tracked", "fork"].includes(String(property(mode.select).name))))
  )
    throw fail("INVALID_UPSTREAM", "Sync Mode must be tracked, fork or empty.")
  return {
    upstream: Array.isArray(relation.relation)
      ? relation.relation.map((entry) => String(property(entry).id))
      : [],
    mode:
      mode.select === null || mode.select === undefined ? "" : String(property(mode.select).name),
    key: rich("Upstream Key"),
    revision: rich("Upstream Revision"),
    hash: rich("Published Hash"),
    baseline: rich("Fork Baseline"),
  }
}
export function publicationGuard(rawPage: unknown) {
  const fields = property(property(rawPage).properties)
  const context = property(fields["Default Context"])
  if (
    fields["Default Context"] !== undefined &&
    (context.type !== "checkbox" || typeof context.checkbox !== "boolean")
  )
    throw fail("INVALID_RESPONSE", "Default Context must be a checkbox property.")
  return {
    ownership: publicationOwnership(rawPage),
    default_context: context.checkbox === true,
    members: fields.Members === undefined ? [] : memberIds(rawPage),
  }
}
export function verifyPublicationOwnership(
  rawPage: unknown,
  expected: NonNullable<ManagedContent["ownership"]>,
) {
  return attempt(() => {
    const actual = publicationOwnership(rawPage)
    if (
      canonical(actual) !==
      canonical({
        upstream: [expected.subscription_id],
        mode: expected.mode,
        key: expected.member_key,
        revision: expected.revision,
        hash: expected.published_hash,
        baseline: expected.fork_baseline ? JSON.stringify(expected.fork_baseline) : "",
      })
    )
      throw fail(
        "WRITE_VERIFICATION_FAILED",
        "Managed upstream properties differ from the requested publication ownership.",
      )
  })
}
/** Match the immutable creation request against normalized Notion properties, not its display name alone. */
export function verifyCreatedPublicationPage(rawPage: unknown, request: unknown) {
  return attempt(() => {
    const fields = property(property(rawPage).properties)
    for (const [key, raw] of Object.entries(property(property(request).properties))) {
      const expected = property(raw)
      const actual = property(
        fields[key] ?? Object.values(fields).find((field) => property(field).id === key),
      )
      if (Array.isArray(expected.title)) {
        if (text(actual.title) !== text(expected.title))
          throw fail("WRITE_CONFLICT", "Created page title changed before reconciliation.")
      } else if (Array.isArray(expected.rich_text)) {
        if (text(actual.rich_text) !== text(expected.rich_text))
          throw fail("WRITE_CONFLICT", "Created page metadata changed before reconciliation.")
      } else if (
        expected.select !== undefined &&
        property(actual.select).name !== property(expected.select).name
      ) {
        throw fail("WRITE_CONFLICT", "Created page Kind changed before reconciliation.")
      } else if (typeof expected.checkbox === "boolean" && actual.checkbox !== expected.checkbox) {
        throw fail("WRITE_CONFLICT", "Created page Default Context changed before reconciliation.")
      }
    }
  })
}
export function publicationManifest(snapshot: Snapshot) {
  return Effect.gen(function* () {
    const files = [...snapshot.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((file) => [file.path, file.bytes, file.sha256])
    if (snapshot.record.kind === "router") {
      const root = snapshot.references?.find((page) => page.path === snapshot.entrypoint)
      if (!root)
        return yield* Effect.fail(
          fail("INVALID_CONTENT", "Router publication has no authored root projection."),
        )
      const authored = fromNotionMarkdown(
        rewritePageLinks(
          withoutChildPages(root.markdown),
          snapshot.entrypoint,
          snapshot.references!,
          "local",
          snapshot.router_members,
        ),
        root.blocks,
      )
      const main = canonicalMain(snapshot.record.name, snapshot.record.description, authored, {
        path: snapshot.entrypoint,
        bytes: new Uint8Array(),
      })
      const index = files.findIndex(([path]) => path === snapshot.entrypoint)
      if (index < 0)
        return yield* Effect.fail(fail("INVALID_CONTENT", "Router publication has no entrypoint."))
      files[index] = [snapshot.entrypoint, main.bytes.length, yield* sha256(main.bytes)]
    }
    return {
      kind: snapshot.record.kind,
      name: snapshot.record.name,
      description: snapshot.record.description,
      entrypoint: snapshot.entrypoint,
      files,
    }
  })
}
function snapshotPageId(snapshot: Snapshot) {
  if (snapshot.record.locator.type !== "notion_page")
    throw fail("INVALID_TARGET", "Publication integrity requires an exact Notion content page.")
  return snapshot.record.locator.page_id
}
function pageReadIdentity(rawPage: unknown) {
  const page = property(rawPage)
  return {
    id: page.id,
    parent: page.parent,
    archived: page.archived ?? false,
    in_trash: page.in_trash ?? false,
    last_edited_time: page.last_edited_time,
  }
}

/** Current consumption may observe later edits; commit verification must match the published intent. */
export function verifyPublicationRead(
  beforePage: unknown,
  snapshot: Snapshot,
  mode: "committed" | "current" = "committed",
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const operationId = yield* PublicationReadOperation
    const inspectDivergence = yield* PublicationInspectDivergence
    const id = yield* attempt(() => snapshotPageId(snapshot))
    const before = yield* attempt(() => publicationMarker(beforePage))
    if (before?.state === "writing" && before.operation_id !== operationId)
      return yield* Effect.fail(
        fail("PUBLICATION_INCOMPLETE", "This content item has an uncommitted publication.", {
          page_id: id,
          operation_id: before.operation_id,
        }),
      )
    if (snapshot.markdown_files) {
      const blocks = yield* readMarkdownFileBlocks(id, api)
      const editable = yield* attempt(() => decodeMarkdownFiles(blocks))
      if (
        !editable ||
        editable.main !== snapshot.markdown_files.main ||
        editable.files.length !== snapshot.files.length
      )
        return yield* Effect.fail(
          fail("PUBLICATION_CHANGED", "Editable file inventory changed during consumption."),
        )
      for (const file of editable.files) {
        const expected = snapshot.files.find((entry) => entry.path === file.path)
        if (
          !expected ||
          expected.bytes !== file.bytes.length ||
          expected.sha256 !== (yield* sha256(file.bytes))
        )
          return yield* Effect.fail(
            fail("PUBLICATION_CHANGED", "Editable file content changed during consumption.", {
              path: file.path,
            }),
          )
      }
    }
    for (const member of snapshot.router_members ?? []) {
      const raw = yield* api.request(`v1/pages/${member.id.replace(/^notion_page:/, "")}`)
      if (observationCanonical(metadata(raw)) !== observationCanonical(member.metadata))
        return yield* Effect.fail(
          fail("PUBLICATION_CHANGED", "Router member metadata changed while it was being read.", {
            page_id: member.id,
          }),
        )
    }
    for (const reference of snapshot.references?.slice(1) ?? []) {
      const raw = property(yield* api.request(`v1/pages/${reference.id}/markdown`))
      const markdown =
        typeof raw.markdown !== "string"
          ? undefined
          : !hasTypedLinks(reference.markdown) ||
              stripNotionInlineBoundaries(raw.markdown) ===
                stripNotionInlineBoundaries(reference.markdown)
            ? raw.markdown
            : yield* materializeTypedLinks(reference.id, raw.markdown, api)
      if (
        raw.truncated !== false ||
        !Array.isArray(raw.unknown_block_ids) ||
        raw.unknown_block_ids.length ||
        typeof markdown !== "string" ||
        stripNotionInlineBoundaries(markdown) !== stripNotionInlineBoundaries(reference.markdown)
      )
        return yield* Effect.fail(
          fail(
            "PUBLICATION_CHANGED",
            "A reference page changed while its content was being read.",
            { page_id: reference.id },
          ),
        )
    }
    const afterPage = yield* api.request(`v1/pages/${id}`)
    const after = yield* attempt(() => publicationMarker(afterPage))
    if (
      canonical(before) !== canonical(after) ||
      canonical(pageReadIdentity(beforePage)) !== canonical(pageReadIdentity(afterPage))
    )
      return yield* Effect.fail(
        fail("PUBLICATION_CHANGED", "The content page changed while it was being read.", {
          page_id: id,
        }),
      )
    const ownershipBefore = yield* attempt(() => publicationGuard(beforePage))
    const ownershipAfter = yield* attempt(() => publicationGuard(afterPage))
    if (canonical(ownershipBefore) !== canonical(ownershipAfter))
      return yield* Effect.fail(
        fail(
          "PUBLICATION_CHANGED",
          "Managed content properties changed while content was being read.",
          { page_id: id },
        ),
      )
    if (!before) return "unmanaged" as const
    if (before.state === "writing") return "writing" as const
    if (inspectDivergence) return "writing" as const
    const committedRevision = yield* sha256(
      canonical([
        before.operation_id,
        before.intended_hash,
        before.manifest_hash,
        before.ownership_hash,
      ]),
    )
    if (committedRevision !== before.revision)
      return yield* Effect.fail(
        fail("PUBLICATION_INVALID", "The committed publication pointer is invalid."),
      )
    const manifest_hash = yield* sha256(canonical(yield* publicationManifest(snapshot)))
    const ownership_hash = yield* sha256(canonical(ownershipAfter))
    if (before.manifest_hash !== manifest_hash || before.ownership_hash !== ownership_hash) {
      // Reading a stable edit does not accept it as the original operation's result
      // or transfer its upstream/local write ownership.
      if (mode === "current") return "current" as const
      return yield* Effect.fail(
        fail(
          "PUBLICATION_DIVERGED",
          "Current Notion content or ownership differs from this operation's committed publication. Read the current content before deciding how to continue the original operation.",
          {
            page_id: id,
            operation_id: before.operation_id,
            expected_manifest: before.manifest_hash,
            actual_manifest: manifest_hash,
          },
        ),
      )
    }
    return "committed" as const
  })
}

/** The caller has already verified submitted content through the formal content use case. */
export function commitPublicationIntegrity(operationId: string, snapshot: Snapshot) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const store = yield* Store
    const intent = yield* store.integrity.inspect(operationId)
    if (!intent)
      return yield* Effect.fail(
        fail("PUBLICATION_UNRESOLVED", "Publication has no persisted intended revision."),
      )
    const id = yield* attempt(() => snapshotPageId(snapshot))
    const raw = yield* api.request(`v1/pages/${id}`)
    const before = yield* attempt(() => publicationMarker(raw))
    if (
      !before ||
      before.operation_id !== operationId ||
      before.intended_hash !== intent.intended_hash
    )
      return yield* Effect.fail(
        fail(
          "WRITE_CONFLICT",
          "The remote publication marker no longer belongs to this operation.",
          { page_id: id },
        ),
      )
    yield* verifyPublicationRead(raw, snapshot).pipe(
      Effect.provideService(PublicationReadOperation, operationId),
    )
    const manifest_hash = yield* sha256(canonical(yield* publicationManifest(snapshot)))
    const ownership_hash = yield* sha256(canonical(yield* attempt(() => publicationGuard(raw))))
    const revision = yield* sha256(
      canonical([operationId, intent.intended_hash, manifest_hash, ownership_hash]),
    )
    const marker: CommittedMarker = {
      version: 2,
      state: "committed",
      operation_id: operationId,
      intended_hash: intent.intended_hash,
      revision,
      manifest_hash,
      ownership_hash,
      ...(before.creation ? { creation: before.creation } : {}),
    }
    // Persist the exact intended commit before sending it. Unknown commit is reconciled by readback.
    yield* store.integrity.update({ ...intent, page_id: id, marker })
    if (canonical(before) !== canonical(marker))
      yield* api.request(
        `v1/pages/${id}`,
        { properties: publicationProperties(marker) },
        { method: "PATCH" },
      )
    const committed = yield* api.request(`v1/pages/${id}`)
    yield* verifyPublicationRead(committed, snapshot)
    return marker
  })
}

/** Read-only reconciliation never repeats a create or an unobserved content write. */
export function reconcilePublicationIntegrity(operationId: string, snapshot: Snapshot) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const store = yield* Store
    const intent = yield* store.integrity.inspect(operationId)
    if (!intent || intent.marker.state !== "committed") return undefined
    const id = yield* attempt(() => snapshotPageId(snapshot))
    if (intent.page_id !== id)
      return yield* Effect.fail(
        fail(
          "PUBLICATION_INTENT_CONFLICT",
          "The reconciled page differs from the persisted commit target.",
        ),
      )
    const raw = yield* api.request(`v1/pages/${id}`)
    const marker = yield* attempt(() => publicationMarker(raw))
    if (canonical(marker) !== canonical(intent.marker)) return undefined
    yield* verifyPublicationRead(raw, snapshot)
    return marker as CommittedMarker
  })
}
