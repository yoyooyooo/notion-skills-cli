import { createHash } from "node:crypto"
import { Effect } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { importDocument, readImportZip } from "./import.ts"
import { BUNDLE, bodyIdentity, portableZip, readPortable, type PortableSkill } from "./portable.ts"
import { canonical } from "./publication-effect-proof.ts"
import { Store } from "./store.ts"
import type { Receipt } from "./publication-model.ts"
import type {
  ContentAdoptionJournal,
  ContentAdoptionPlan,
  ContentAdoptionSourceInstallation,
} from "./publication-content-adoption-authority.ts"

const refused = (message: string) => fail("CONTENT_ADOPTION_REFUSED", message)
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right)
const uploadId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value)

/** Bound every original file and the whole source before compression.
 * The fresh proof must bind every reference source to its existing page. */
function sourceFiles(portable: PortableSkill) {
  if (
    portable.kind !== "skill" ||
    portable.files.length < 1 ||
    portable.files.length > 100 ||
    portable.files.reduce((total, file) => total + file.bytes.length, 0) > 5 * 1024 * 1024 ||
    portable.files.some((file) => file.bytes.length > 1024 * 1024)
  )
    throw refused(
      "Source installation requires a pure-text skill of at most 100 files, 1 MiB per file and 5 MiB total.",
    )
  for (const file of portable.files) {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    if (decoded.includes("\0")) throw refused("Source installation accepts pure UTF-8 text only.")
  }
  return portable.files
    .map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function referenceSources(portable: {
  readonly main: string
  readonly files: readonly { readonly path: string }[]
}) {
  return portable.files.filter((file) => file.path !== portable.main && /\.md$/i.test(file.path))
}

function sourceProjection(portable: PortableSkill) {
  const main = portable.files.find((file) => file.path === portable.main)
  if (!main) throw refused("The complete original main source is unavailable.")
  const paths = new Set(referenceSources(portable).map((file) => file.path))
  const references = Object.fromEntries(
    portable.files
      .filter((file) => paths.has(file.path))
      .map((file) => [
        file.path,
        bodyIdentity(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)),
      ]),
  )
  return {
    name: portable.name,
    description: portable.description,
    body: bodyIdentity(importDocument(main, portable).body),
    ...(paths.size ? { references } : {}),
  }
}

/** Keep the entire property definition; only its explicit empty value may change. */
export function contentAdoptionSourceField(
  raw: unknown,
  installation?: ContentAdoptionSourceInstallation,
) {
  const properties = property(property(raw).properties)
  const entries = Object.entries(properties).filter(
    ([name, value]) => name === "Files" || property(value).type === "files",
  )
  const field = property(entries[0]?.[1])
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== "Files" ||
    field.type !== "files" ||
    typeof field.id !== "string" ||
    !field.id ||
    !Array.isArray(field.files) ||
    !same(Object.keys(field).sort(), ["files", "id", "type"]) ||
    (installation &&
      (installation.property_name !== "Files" || installation.property_id !== field.id))
  )
    throw refused("Source installation requires the one complete, unchanged Files property.")
  return { id: field.id, files: field.files as readonly unknown[] }
}

export function contentAdoptionSourceAttachmentBody(
  installation: ContentAdoptionSourceInstallation,
  id: string,
) {
  if (!uploadId(id)) throw refused("The acknowledged source upload identity is invalid.")
  return {
    properties: {
      [installation.property_id]: {
        files: [{ name: BUNDLE, type: "file_upload", file_upload: { id } }],
      },
    },
  }
}

export function prepareContentAdoptionSourceInstallation(portable: PortableSkill, raw: unknown) {
  return Effect.try({
    try: () => {
      sourceFiles(portable)
      const field = contentAdoptionSourceField(raw)
      if (field.files.length)
        throw refused("Source installation cannot replace an existing Files resource.")
      const bytes = portableZip({ ...portable, projection: sourceProjection(portable) }, true)
      const installation: ContentAdoptionSourceInstallation = {
        version: 1,
        property_name: "Files",
        property_id: field.id,
        filename: BUNDLE,
        sha256: digest(bytes),
        byte_length: bytes.length,
      }
      return { installation, bytes }
    },
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : refused("The original source could not be frozen as a bounded pure-text archive."),
  })
}

export function loadContentAdoptionSourceInstallation(
  plan: ContentAdoptionPlan,
  portable: PortableSkill,
) {
  return Effect.gen(function* () {
    const installation = plan.source_installation
    if (!installation)
      return yield* Effect.fail(refused("The typed source installation is missing."))
    const store = yield* Store
    const bytes = yield* store.readBytes(`objects/${installation.sha256}`)
    return yield* Effect.try({
      try: () => {
        const expected = sourceFiles(portable)
        if (bytes.length !== installation.byte_length || digest(bytes) !== installation.sha256)
          throw refused("The frozen source installation archive changed.")
        const source = readPortable(readImportZip(bytes))
        if (
          !source ||
          source.kind !== portable.kind ||
          source.name !== portable.name ||
          source.description !== portable.description ||
          source.main !== portable.main ||
          !same(sourceFiles(source), expected) ||
          !same(source.projection, sourceProjection(portable))
        )
          throw refused(
            "The installation archive differs from the complete original frozen source.",
          )
        return bytes
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : refused("The frozen source installation archive is invalid."),
    })
  })
}

/** Called only after the common adoption identity/portable/context checks. */
export function contentAdoptionSourceJournal(
  receipt: Receipt,
  plan: ContentAdoptionPlan,
  propertyBodies: readonly unknown[],
): ContentAdoptionJournal | undefined {
  const installation = plan.source_installation
  if (
    !installation ||
    plan.evidence.source_proof !== "not_installed" ||
    plan.evidence.files.length ||
    plan.evidence.attachments.length ||
    plan.evidence.page_ids.length !== referenceSources(plan.frozen).length + 1 ||
    plan.evidence.page_ids.length > 100 ||
    !plan.evidence.page_ids.includes(plan.page_id) ||
    new Set(plan.evidence.page_ids).size !== plan.evidence.page_ids.length ||
    !same(plan.evidence.page_ids, [...plan.evidence.page_ids].sort())
  )
    return undefined
  const pages = plan.evidence.page_ids.map((id) => ({ id, path: `v1/pages/${id}` }))
  if (
    pages.some(
      ({ id, path }) =>
        property(plan.evidence.raw[path]).id !== id ||
        typeof property(plan.evidence.raw[path + "/markdown"]).markdown !== "string",
    )
  )
    return undefined
  const hasPageGuards = (guards: Readonly<Record<string, unknown>> | undefined) =>
    !!guards &&
    pages.every(
      ({ id, path }) =>
        property(guards[path]).id === id &&
        guards[path + "/markdown"] === property(plan.evidence.raw[path + "/markdown"]).markdown,
    )
  if (receipt.intents.length && !hasPageGuards(receipt.guards)) return undefined
  const root = `v1/pages/${plan.page_id}`
  let completed = 0,
    allocated: string | undefined
  const phases = ["property", "allocation", "send", "attachment", "property", "property"] as const
  for (let index = 0; index < receipt.intents.length; index++) {
    const intent = receipt.intents[index]!,
      phase = phases[completed]
    if (
      !phase ||
      intent.recovery ||
      intent.list_start_repair ||
      intent.zero_list_repair ||
      intent.typed_links ||
      !hasPageGuards(intent.guards) ||
      pages.some(
        ({ id, path }) => id !== plan.page_id && !same(intent.guards![path], receipt.guards[path]),
      ) ||
      (completed !== 1 && intent.artifact !== undefined)
    )
      return undefined
    if (completed === 1) {
      if (
        intent.path !== "v1/file_uploads" ||
        intent.method !== "POST" ||
        !same(intent.body, { filename: installation.filename, mode: "single_part" }) ||
        !same(intent.artifact, {
          suboperation_id: `${receipt.operation_id}:upload:${index}`,
          filename: installation.filename,
          sha256: installation.sha256,
          byte_length: installation.byte_length,
        })
      )
        return undefined
    } else if (completed === 2) {
      if (
        !allocated ||
        intent.path !== `v1/file_uploads/${allocated}/send` ||
        intent.method !== "POST" ||
        intent.body !== undefined
      )
        return undefined
    } else {
      const expected =
        completed === 0
          ? propertyBodies[0]
          : completed === 3 && allocated
            ? contentAdoptionSourceAttachmentBody(installation, allocated)
            : completed === 4
              ? propertyBodies[1]
              : propertyBodies[2]
      if (
        !expected ||
        intent.path !== root ||
        intent.method !== "PATCH" ||
        !same(intent.body, expected)
      )
        return undefined
    }
    const response = property(intent.response)
    if (intent.status === "completed") {
      if (response.superseded_by !== undefined || response.replayed_by_intent !== undefined)
        return undefined
      if (completed === 1) {
        if (!uploadId(response.id) || response.recovery !== undefined) return undefined
        allocated = response.id
      } else if (completed === 2) {
        if (
          response.status !== "uploaded" ||
          (response.id !== undefined && response.id !== allocated) ||
          (response.recovery !== undefined &&
            (response.recovery !== "observed_uploaded" ||
              response.id !== allocated ||
              !["pending", "unknown"].includes(String(response.prior_status))))
        )
          return undefined
      } else if (
        response.id !== plan.page_id ||
        (response.recovery !== undefined && response.recovery !== "observed_applied")
      )
        return undefined
      completed++
      continue
    }
    if (intent.status === "failed") {
      if (
        ["allocation", "send"].includes(phase) ||
        response.recovery !== "known_not_applied" ||
        !["unknown", "pending"].includes(String(response.prior_status)) ||
        response.replayed_by_intent !== index + 1 ||
        own(response, "id")
      )
        return undefined
      if (index === receipt.intents.length - 1) return { completed, retry_index: index }
      continue
    }
    if (
      !["pending", "unknown"].includes(intent.status) ||
      index !== receipt.intents.length - 1 ||
      intent.response !== undefined
    )
      return undefined
    return { completed, pending_index: index, pending_effect: completed, pending_kind: phase }
  }
  return { completed }
}

export const contentAdoptionCommittedCount = (plan: ContentAdoptionPlan) =>
  plan.source_installation ? 6 : 3
export const contentAdoptionOwnershipCount = (plan: ContentAdoptionPlan) =>
  plan.source_installation ? 5 : 2
export const contentAdoptionSourceInstalled = (plan: ContentAdoptionPlan, completed: number) =>
  !!plan.source_installation && completed >= 4
