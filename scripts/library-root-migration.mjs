/** AH-1300 one-time migration. This module is deliberately outside the SDK and
 * ordinary resolver: v1 identities are admitted only by an explicit cutover. */
import { createHash } from "node:crypto"

export const ROLES = ["skills", "files", "records", "sources"]
export const OLD_MARKER = "ntn-skills-library:v1 "
export const NEW_MARKER = "ntn-skills-library:v2 "
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const STABLE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u
const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,199}$/u
export function requireValue(value, code, details) {
  if (!value) throw Object.assign(new Error(code), { code, details })
}
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    )
  requireValue(
    value === null || ["string", "number", "boolean"].includes(typeof value),
    "INVALID_JSON",
  )
  if (typeof value === "number") requireValue(Number.isFinite(value), "INVALID_JSON")
  return JSON.stringify(value)
}
export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" || value instanceof Uint8Array ? value : canonical(value))
    .digest("hex")
export const richText = (value) =>
  (value ?? []).map((part) => part.plain_text ?? part.text?.content ?? "").join("")
export function rich(value) {
  const result = []
  let part = ""
  for (const char of value) {
    if (part.length + char.length > 1900) {
      result.push({ type: "text", text: { content: part } })
      part = ""
    }
    part += char
  }
  if (part) result.push({ type: "text", text: { content: part } })
  requireValue(result.length <= 100, "TEXT_TOO_LARGE")
  return result
}
export function writableRich(parts) {
  requireValue(Array.isArray(parts), "INCOMPLETE_RICH_TEXT")
  return parts.map((part) => {
    requireValue(["text", "mention", "equation"].includes(part.type), "UNSUPPORTED_RICH_TEXT")
    const value = { type: part.type, [part.type]: structuredClone(part[part.type]) }
    if (part.type === "text" && value.text.link == null) delete value.text.link
    const annotations = Object.fromEntries(
      Object.entries(part.annotations ?? {}).filter(([key, item]) =>
        key === "color" ? item !== "default" : item !== false,
      ),
    )
    if (Object.keys(annotations).length) value.annotations = annotations
    return value
  })
}
export function field(library, role, row, name) {
  const id = library[role].property_ids[name]
  requireValue(typeof id === "string", "MISSING_PROPERTY_BINDING", { role, name })
  const values = Object.entries(row.properties ?? {})
    .filter(([key, value]) => key === id || value.id === id)
    .map(([, value]) => value)
  requireValue(values.length === 1 && values[0].has_more !== true, "INCOMPLETE_PROPERTY", {
    page_id: row.id,
    name,
  })
  return values[0]
}
export const valueText = (library, role, row, name) =>
  richText(field(library, role, row, name).rich_text)
export function decodeLegacy(description) {
  const text = richText(description)
  requireValue(text.startsWith(OLD_MARKER), "LEGACY_DESCRIPTOR_REQUIRED")
  const value = JSON.parse(text.slice(OLD_MARKER.length))
  requireValue(
    value.version === 1 &&
      STABLE.test(value.library_id) &&
      typeof value.operation_id === "string" &&
      UUID.test(value.parent_page_id),
    "LEGACY_DESCRIPTOR_INVALID",
  )
  requireValue(
    Object.keys(value).sort().join(",") ===
      ["version", "library_id", "operation_id", "parent_page_id", ...ROLES].sort().join(","),
    "LEGACY_DESCRIPTOR_INVALID",
  )
  for (const role of ROLES) {
    const table = value[role]
    requireValue(
      table &&
        UUID.test(table.database_id) &&
        UUID.test(table.data_source_id) &&
        table.property_ids &&
        typeof table.property_ids === "object",
      "LEGACY_BINDING_INVALID",
      { role },
    )
    const ids = Object.values(table.property_ids)
    requireValue(
      ids.length > 0 &&
        ids.every((id) => typeof id === "string" && id.length > 0) &&
        new Set(ids).size === ids.length,
      "LEGACY_BINDING_INVALID",
      { role },
    )
  }
  requireValue(
    new Set(ROLES.flatMap((role) => [value[role].database_id, value[role].data_source_id])).size ===
      8,
    "REPEATED_TABLE_BINDING",
  )
  return value
}
export function rootDescriptor(legacy, rootId) {
  requireValue(UUID.test(rootId), "CANONICAL_ROOT_REQUIRED")
  return {
    version: 2,
    library_id: rootId,
    operation_id: legacy.operation_id,
    ...Object.fromEntries(ROLES.map((role) => [role, structuredClone(legacy[role])])),
  }
}
export const admissionId = (libraryId, sourcePageId, member) =>
  "skill-" + digest(["source-onboarding-v1", libraryId, sourcePageId, member])

/** Scan code as well as prose: inline code often carries real routing identity.
 * A bare scheme or the exact ellipsis placeholder has no target to migrate. */
export function referenceTokens(text) {
  return [...new Set(text.match(/skill:\/\/[^\s<>"'`\])}]+/gu) ?? [])].filter(
    (value) => value !== "skill://...",
  )
}

/** Exact current identities only. A pin is never rebound or weakened to latest. */
export function rewriteReference(input, mapping, contextLibrary) {
  const match = /^skill:\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/u.exec(input)
  requireValue(match, "REFERENCE_INVALID")
  let id = decodeURIComponent(match[1])
  const query = new Map()
  for (const pair of match[3] === undefined ? [] : match[3].split("&")) {
    const at = pair.indexOf("=")
    requireValue(at > 0, "REFERENCE_INVALID")
    const key = decodeURIComponent(pair.slice(0, at).replaceAll("+", " "))
    const value = decodeURIComponent(pair.slice(at + 1).replaceAll("+", " "))
    requireValue(
      ["library", "snapshot"].includes(key) && !query.has(key) && value,
      "REFERENCE_INVALID",
    )
    query.set(key, value)
  }
  const legacyIdentity = id.startsWith("shared_skill:")
  if (legacyIdentity) {
    const prefix = "shared_skill:" + mapping.old_library_id + ":"
    requireValue(id.startsWith(prefix), "LEGACY_REFERENCE_OWNER_UNMAPPED")
    requireValue(
      !query.has("library") || query.get("library") === mapping.old_library_id,
      "REFERENCE_OWNER_CONFLICT",
    )
    id = id.slice(prefix.length)
  }
  requireValue(SKILL_ID.test(id), "REFERENCE_INVALID")
  requireValue(
    !query.has("snapshot") || /^s_[a-f0-9]{64}$/u.test(query.get("snapshot")),
    "REFERENCE_INVALID",
  )
  // Validate before interpreting ownership; URL normalization must not hide escape.
  const path = (match[2] ?? "").split("/").map((part) => decodeURIComponent(part))
  requireValue(
    path.every((part) => part !== ".." && !/[\\/\p{Cc}\p{Cf}\p{Cs}]/u.test(part)) &&
      !path[0]?.includes(":"),
    "REFERENCE_INVALID",
  )
  const owner = legacyIdentity ? mapping.old_library_id : (query.get("library") ?? contextLibrary)
  requireValue(owner === mapping.old_library_id || UUID.test(owner), "REFERENCE_OWNER_UNMAPPED")
  if (owner !== mapping.old_library_id) return input
  const target =
    mapping.skills.find((item) => item.before === id) ??
    (UUID.test(id) ? mapping.skills.find((item) => item.page_id === id) : undefined)
  requireValue(target, "UNRESOLVED_REFERENCE_TARGET", { skill_id: id })
  if (!legacyIdentity && mapping.old_library_id === mapping.root_id && target.after === id)
    return input
  requireValue(!query.has("snapshot"), "PINNED_OWNER_REQUIRES_EXPLICIT_REACQUISITION", {
    skill_id: id,
  })
  const suffix = match[2] === undefined ? "" : "/" + match[2]
  return (
    "skill://" +
    target.after +
    suffix +
    (legacyIdentity || query.has("library") ? "?library=" + mapping.root_id : "")
  )
}

/** The legacy References property contains a structured file-link index. Only
 * its destination identity changes; source paths and author spelling do not. */
export function migrateFileLinks(value, mapping) {
  requireValue(
    value?.version === 1 &&
      value.kind === "file_links" &&
      Array.isArray(value.links) &&
      Object.keys(value).sort().join(",") === "kind,links,version",
    "FILE_LINKS_INVALID",
  )
  const seen = new Set()
  return {
    ...value,
    links: value.links.map((link) => {
      requireValue(
        link &&
          Object.keys(link).sort().join(",") === "from,href,target" &&
          typeof link.from === "string" &&
          link.from &&
          !link.from.startsWith("/") &&
          link.from.split("/").every((part) => part && part !== "." && part !== "..") &&
          !/[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(link.from) &&
          typeof link.href === "string" &&
          link.href &&
          typeof link.target === "string" &&
          /^(?:skill|https):\/\//u.test(link.target),
        "FILE_LINKS_INVALID",
      )
      const key = canonical([link.from, link.href])
      requireValue(!seen.has(key), "FILE_LINKS_AMBIGUOUS")
      seen.add(key)
      return {
        ...link,
        target: link.target.startsWith("skill://")
          ? rewriteReference(link.target, mapping, mapping.old_library_id)
          : link.target,
      }
    }),
  }
}

export function migratePortableManifest(manifest, mapping) {
  requireValue(
    manifest?.format === "ntn-skills" && manifest.version === 2,
    "PORTABLE_FORMAT_REQUIRED",
  )
  if (manifest.relations === undefined || manifest.relations.library_id !== mapping.old_library_id)
    return structuredClone(manifest)
  const out = structuredClone(manifest)
  requireValue(
    out.relations.version === 1 && out.relations.ownership === "notion",
    "PORTABLE_RELATIONS_INVALID",
  )
  for (const key of ["members", "requires"]) {
    if (out.relations[key] === undefined) continue
    requireValue(Array.isArray(out.relations[key]), "PORTABLE_RELATIONS_INVALID")
    out.relations[key] = out.relations[key].map((ref) => {
      const identity = /^skill:\/\/([^/?#]+)(?:\?library=([^&#]+))?$/u.exec(ref)
      requireValue(
        identity &&
          (identity[2] === undefined || decodeURIComponent(identity[2]) === mapping.old_library_id),
        "PORTABLE_RELATIONS_INVALID",
      )
      return rewriteReference(ref, mapping, mapping.old_library_id)
    })
  }
  out.relations.library_id = mapping.root_id
  return out
}

/** Preserve secret values in memory; callers write a new private candidate, never stdout. */
export function migrateConfig(config, mapping, descriptor) {
  const out = structuredClone(config)
  requireValue(Array.isArray(out.sources), "CONFIG_SOURCES_REQUIRED")
  for (const source of out.sources) {
    if (source.database_id !== descriptor.skills.database_id) continue
    requireValue(
      source.shared_library?.library_id === mapping.old_library_id &&
        source.shared_library.skills.database_id === descriptor.skills.database_id,
      "CONFIG_MAPPING_UNPROVEN",
    )
    for (const role of ROLES) {
      const before = source.shared_library[role]
      const after = descriptor[role]
      requireValue(
        before.database_id === after.database_id &&
          before.data_source_id === after.data_source_id &&
          Object.entries(before.property_ids).every(
            ([name, id]) => after.property_ids[name] === id,
          ),
        "CONFIG_BINDING_DRIFT",
      )
    }
    // Use the observed remote descriptor, including additive registrations.
    source.shared_library = structuredClone(descriptor)
  }
  if (out.default_database !== undefined) {
    requireValue(
      out.default_database === descriptor.skills.database_id && out.default_library === undefined,
      "CONFIG_DEFAULT_MAPPING_UNPROVEN",
    )
    out.default_library = mapping.root_id
    delete out.default_database
  }
  if (out.shared_profile?.library_entry !== undefined) {
    requireValue(
      out.shared_profile.library_entry === descriptor.skills.database_id,
      "PROFILE_BINDING_MAPPING_UNPROVEN",
    )
    out.shared_profile = { library_id: mapping.root_id, profile_id: out.shared_profile.profile_id }
  }
  return out
}

function assertTopology(inventory, legacy) {
  requireValue(
    inventory.version === 1 && inventory.kind === "library-root-migration-inventory",
    "INVENTORY_INVALID",
  )
  requireValue(
    inventory.root?.object === "page" &&
      UUID.test(inventory.root.id) &&
      !inventory.root.in_trash &&
      !inventory.root.archived,
    "ROOT_UNAVAILABLE",
  )
  requireValue(
    inventory.root_children_complete === true && Array.isArray(inventory.root_database_ids),
    "ROOT_ENUMERATION_INCOMPLETE",
  )
  requireValue(inventory.other_descriptors?.length === 0, "SHARED_PARENT_REQUIRES_SEPARATE_ROOT")
  for (const role of ROLES) {
    const table = inventory.tables[role]
    const binding = legacy[role]
    requireValue(
      table?.complete === true && Array.isArray(table.rows),
      "TABLE_ENUMERATION_INCOMPLETE",
      { role },
    )
    requireValue(
      table.database.id === binding.database_id &&
        !table.database.in_trash &&
        !table.database.archived &&
        table.database.parent?.type === "page_id" &&
        table.database.parent.page_id === inventory.root.id &&
        inventory.root_database_ids.includes(binding.database_id),
      "TABLE_REPARENT_REQUIRED",
      { role },
    )
    requireValue(
      table.data_source.id === binding.data_source_id &&
        !table.data_source.in_trash &&
        !table.data_source.archived &&
        table.data_source.parent?.database_id === binding.database_id &&
        table.database.data_sources.some((source) => source.id === binding.data_source_id),
      "DATA_SOURCE_OWNER_MISMATCH",
      { role },
    )
    const properties = Object.values(table.data_source.properties ?? {})
    for (const [name, id] of Object.entries(binding.property_ids))
      requireValue(
        properties.filter((property) => property.id === id).length === 1,
        "PROPERTY_BINDING_MISMATCH",
        { role, name },
      )
    const seen = new Set()
    for (const row of table.rows) {
      requireValue(
        row.object === "page" &&
          UUID.test(row.id) &&
          !row.in_trash &&
          !row.archived &&
          row.parent?.data_source_id === binding.data_source_id &&
          !seen.has(row.id),
        "ROW_OWNER_MISMATCH",
        { role },
      )
      seen.add(row.id)
    }
  }
}

export function preparePlan(inventory) {
  const legacy = decodeLegacy(inventory.tables.skills.database.description)
  assertTopology(inventory, legacy)
  const descriptor = rootDescriptor(legacy, inventory.root.id)
  const blockers = []
  const addBlocker = (code, details = {}) => blockers.push({ code, ...details })
  const skills = inventory.tables.skills.rows
  const mapping = {
    old_library_id: legacy.library_id,
    old_entry: legacy.skills.database_id,
    root_id: descriptor.library_id,
    skills: [],
  }
  const mutations = new Map()
  const stage = (kind, id, before, after, reason) => {
    if (canonical(before) === canonical(after)) return
    const key = kind + ":" + id
    const existing = mutations.get(key)
    if (existing) {
      for (const name of Object.keys(before.properties ?? {}))
        requireValue(
          !existing.before.properties[name] ||
            canonical(existing.before.properties[name]) === canonical(before.properties[name]),
          "OVERLAPPING_PATCH",
        )
      existing.before.properties = { ...existing.before.properties, ...before.properties }
      existing.after.properties = { ...existing.after.properties, ...after.properties }
      existing.reasons.push(reason)
    } else mutations.set(key, { kind, id, before, after, reasons: [reason] })
  }
  const setText = (role, row, name, value, reason) => {
    const original = field(legacy, role, row, name)
    requireValue(original.type === "rich_text", "PROPERTY_TYPE_MISMATCH")
    const id = legacy[role].property_ids[name]
    stage(
      "page",
      row.id,
      { properties: { [id]: { rich_text: writableRich(original.rich_text) } } },
      { properties: { [id]: { rich_text: rich(value) } } },
      reason,
    )
  }
  for (const row of skills) {
    const id = valueText(legacy, "skills", row, "Skill ID")
    requireValue(
      SKILL_ID.test(id) && !mapping.skills.some((item) => item.before === id),
      "SKILL_ID_AMBIGUOUS",
      { page_id: row.id },
    )
    const projection = valueText(legacy, "skills", row, "Projection")
    let next = id
    if (projection === "git-only/v1" || projection.startsWith("git-only/v1:")) {
      const origin = field(legacy, "skills", row, "Origin").relation
      const member = valueText(legacy, "skills", row, "Source Member")
      requireValue(
        Array.isArray(origin) &&
          origin.length === 1 &&
          UUID.test(origin[0].id) &&
          member &&
          (projection === "git-only/v1" || projection === "git-only/v1:" + origin[0].id) &&
          id === admissionId(legacy.library_id, origin[0].id, member),
        "GIT_ONLY_ADMISSION_UNPROVEN",
        { page_id: row.id },
      )
      requireValue(
        inventory.tables.sources.rows.some((source) => source.id === origin[0].id),
        "GIT_ONLY_SOURCE_MISSING",
        { page_id: row.id },
      )
      next = admissionId(descriptor.library_id, origin[0].id, member)
      setText("skills", row, "Skill ID", next, "git_only_admission")
      if (projection === "git-only/v1")
        setText(
          "skills",
          row,
          "Projection",
          "git-only/v1:" + origin[0].id,
          "source_qualified_admission",
        )
    }
    mapping.skills.push({ page_id: row.id, before: id, after: next })
    if (legacy.skills.property_ids.Operation && valueText(legacy, "skills", row, "Operation"))
      addBlocker("SKILL_OPERATION_PENDING", { page_id: row.id })
  }
  requireValue(
    new Set(mapping.skills.map((item) => item.after)).size === mapping.skills.length,
    "MAPPED_SKILL_ID_COLLISION",
  )
  for (const row of inventory.tables.sources.rows) {
    if (legacy.sources.property_ids.Operation && valueText(legacy, "sources", row, "Operation"))
      addBlocker("SOURCE_OPERATION_PENDING", { page_id: row.id })
    const encoded = valueText(legacy, "sources", row, "Contributions")
    if (!encoded) continue
    const current = JSON.parse(encoded)
    requireValue(Array.isArray(current), "CONTRIBUTIONS_INVALID")
    let changed = false
    const after = current
      .map((item) => {
        requireValue(item && typeof item.skill_id === "string", "CONTRIBUTIONS_INVALID")
        const target = mapping.skills.find((skill) => skill.before === item.skill_id)
        if (!target) {
          addBlocker("CONTRIBUTION_TARGET_UNRESOLVED", { page_id: row.id, skill_id: item.skill_id })
          return item
        }
        changed ||= item.skill_id !== target.after
        return { ...item, skill_id: target.after }
      })
      .sort((a, b) =>
        a.skill_id < b.skill_id
          ? -1
          : a.skill_id > b.skill_id
            ? 1
            : a.member_key < b.member_key
              ? -1
              : a.member_key > b.member_key
                ? 1
                : 0,
      )
    if (changed) setText("sources", row, "Contributions", canonical(after), "current_contribution")
  }
  for (const row of inventory.tables.records.rows) {
    const kind = field(legacy, "records", row, "Kind").select?.name
    const recordId = valueText(legacy, "records", row, "Record ID")
    if (kind === "operation" && recordId.startsWith("operation-current-")) {
      addBlocker("REMOTE_OPERATION_PENDING", { page_id: row.id, record_id: recordId })
      continue
    }
    if (kind !== "profile") continue
    const encoded = valueText(legacy, "records", row, "Payload")
    const envelope = JSON.parse(encoded)
    const payload = envelope.payload
    requireValue(
      envelope.version === 1 &&
        payload?.version === 2 &&
        payload.library_id === legacy.library_id &&
        STABLE.test(payload.profile_id) &&
        recordId === "profile-current-" + digest([legacy.library_id, payload.profile_id]) &&
        digest(canonical(envelope)) === valueText(legacy, "records", row, "Hash") &&
        valueText(legacy, "records", row, "Entity ID") === payload.profile_id &&
        field(legacy, "records", row, "Skill").relation.length === 0,
      "PROFILE_MAPPING_UNPROVEN",
      { page_id: row.id },
    )
    const nextPayload = { ...payload, library_id: descriptor.library_id }
    const nextId = "profile-current-" + digest([descriptor.library_id, payload.profile_id])
    const operation = "set-profile-" + digest([nextId, digest(payload), digest(nextPayload)])
    const nextEnvelope = { version: 1, operation_id: operation, payload: nextPayload }
    setText("records", row, "Record ID", nextId, "current_profile")
    setText("records", row, "Payload", canonical(nextEnvelope), "current_profile")
    setText("records", row, "Hash", digest(nextEnvelope), "current_profile")
  }
  for (const store of inventory.stores ?? [])
    for (const pending of store.dispatch ?? [])
      addBlocker("LOCAL_OPERATION_PENDING", { store: store.path, key: pending.key })
  requireValue(Array.isArray(inventory.stores), "STORE_INVENTORY_REQUIRED")
  if (inventory.stores.length === 0) addBlocker("ORIGINAL_STORE_REQUIRED")
  for (const role of ["skills", "files"])
    for (const row of inventory.tables[role].rows) {
      const encoded = valueText(legacy, role, row, "Content")
      if (!encoded) continue
      const content = JSON.parse(encoded)
      if (content.kind === "native" && content.frontmatter?.includes("skill://"))
        addBlocker("FRONTMATTER_REFERENCES_REQUIRE_REVIEW", { page_id: row.id })
    }
  const mapRich = (parts, location, literal = false) =>
    writableRich(parts).map((part) => {
      if (part.type !== "text") return part
      const url = part.text.link?.url
      const map = (original, write) => {
        try {
          const mapped = rewriteReference(original, mapping, legacy.library_id)
          if (mapped === original) return
          if (write && !literal) write(mapped)
          else
            addBlocker(
              literal ? "CODE_REFERENCE_REQUIRES_REVIEW" : "EMBEDDED_REFERENCE_REQUIRES_REVIEW",
              { ...location, reference: original },
            )
        } catch (error) {
          addBlocker(error.code ?? "REFERENCE_INVALID", { ...location, reference: original })
        }
      }
      if (typeof url === "string" && url.startsWith("skill://"))
        map(url, (mapped) => {
          part.text.link.url = mapped
        })
      for (const reference of referenceTokens(part.text.content))
        map(
          reference,
          reference === part.text.content
            ? (mapped) => {
                part.text.content = mapped
              }
            : undefined,
        )
      return part
    })
  // Structured identity fields above have separate validators. Only rich text
  // links and whole reference text are automatically rewritten here.
  for (const role of ["skills", "files", "sources"])
    for (const row of inventory.tables[role].rows)
      for (const [name, id] of Object.entries(legacy[role].property_ids)) {
        if (["Skill ID", "Projection", "Contributions", "Content", "Operation"].includes(name))
          continue
        const original = Object.values(row.properties ?? {}).find((property) => property.id === id)
        requireValue(original, "INCOMPLETE_PROPERTY", { page_id: row.id, name })
        if (original.type !== "rich_text" && original.type !== "title") continue
        requireValue(original.has_more !== true, "INCOMPLETE_PROPERTY", { page_id: row.id, name })
        const type = original.type
        if (role === "skills" && name === "References" && type === "rich_text") {
          let index
          try {
            index = JSON.parse(richText(original.rich_text))
          } catch {
            /* Prose is checked below. */
          }
          if (index?.kind === "file_links") {
            try {
              const mapped = migrateFileLinks(index, mapping)
              if (canonical(index) !== canonical(mapped))
                setText(role, row, name, canonical(mapped), "legacy_file_links")
            } catch (error) {
              addBlocker(error.code ?? "FILE_LINKS_INVALID", { page_id: row.id, property: name })
            }
            continue
          }
        }
        const before = writableRich(original[type])
        const after = mapRich(original[type], { page_id: row.id, property: name })
        stage(
          "page",
          row.id,
          { properties: { [id]: { [type]: before } } },
          { properties: { [id]: { [type]: after } } },
          "current_reference",
        )
      }
  requireValue(Array.isArray(inventory.native_blocks), "NATIVE_BODY_COVERAGE_REQUIRED")
  if (inventory.native_bodies_complete !== true) addBlocker("NATIVE_BODY_COVERAGE_REQUIRED")
  for (const block of inventory.native_blocks) {
    const before = {},
      after = {}
    for (const key of ["rich_text", "caption"])
      if (Array.isArray(block[block.type]?.[key])) {
        before[key] = writableRich(block[block.type][key])
        after[key] = mapRich(
          block[block.type][key],
          { block_id: block.id, field: key },
          block.type === "code" && key === "rich_text",
        )
      }
    if (block.type === "table_row") {
      requireValue(Array.isArray(block.table_row?.cells), "INCOMPLETE_TABLE_ROW")
      before.cells = block.table_row.cells.map(writableRich)
      after.cells = block.table_row.cells.map((cell, index) =>
        mapRich(cell, { block_id: block.id, field: "cells", cell: index }),
      )
    }
    if (Object.keys(before).length)
      stage(
        "block",
        block.id,
        { [block.type]: before },
        { [block.type]: after },
        "native_reference",
      )
  }
  const audits = new Map((inventory.content_audit ?? []).map((item) => [item.sha256, item]))
  for (const item of inventory.required_content ?? []) {
    const audit = audits.get(item.sha256)
    if (!audit || audit.bytes !== item.bytes) {
      addBlocker("CONTENT_COVERAGE_MISSING", { page_id: item.page_id, sha256: item.sha256 })
      continue
    }
    for (const reference of audit.references)
      try {
        if (rewriteReference(reference, mapping, legacy.library_id) !== reference)
          addBlocker("IMMUTABLE_CONTENT_REFERENCE_REQUIRES_AUTHOR_UPDATE", {
            page_id: item.page_id,
            sha256: item.sha256,
          })
      } catch (error) {
        addBlocker(error.code ?? "REFERENCE_INVALID", {
          page_id: item.page_id,
          sha256: item.sha256,
        })
      }
  }
  stage(
    "database",
    legacy.skills.database_id,
    { description: writableRich(inventory.tables.skills.database.description) },
    { description: rich(NEW_MARKER + canonical(descriptor)) },
    "descriptor_commit",
  )
  const patches = [...mutations.values()]
    .sort(
      (a, b) =>
        Number(a.kind === "database") - Number(b.kind === "database") || a.id.localeCompare(b.id),
    )
    .map((patch, index) => ({
      ...patch,
      sequence: index,
      before_sha256: digest(patch.before),
      after_sha256: digest(patch.after),
    }))
  const uniqueBlockers = [...new Map(blockers.map((item) => [canonical(item), item])).values()]
  const plan = {
    version: 1,
    kind: "library-root-migration-plan",
    inventory_sha256: digest(inventory),
    mapping,
    descriptor,
    status: uniqueBlockers.length ? "blocked" : "ready",
    blockers: uniqueBlockers,
    stores: inventory.stores.map((store) => store.path),
    patches,
    counts: {
      skills: skills.length,
      renamed_skills: mapping.skills.filter((item) => item.before !== item.after).length,
      writes: patches.length,
      pages: patches.filter((patch) => patch.kind === "page").length,
      blocks: patches.filter((patch) => patch.kind === "block").length,
      databases: patches.filter((patch) => patch.kind === "database").length,
    },
  }
  return { ...plan, plan_sha256: digest(plan) }
}

export function verifyPlan(plan) {
  const { plan_sha256, ...value } = plan
  requireValue(
    plan.version === 1 &&
      plan.kind === "library-root-migration-plan" &&
      digest(value) === plan_sha256,
    "PLAN_CHANGED",
  )
  requireValue(plan.status === "ready" && plan.blockers.length === 0, "MIGRATION_BLOCKED")
  for (const patch of plan.patches)
    requireValue(
      ["page", "block", "database"].includes(patch.kind) &&
        UUID.test(patch.id) &&
        digest(patch.before) === patch.before_sha256 &&
        digest(patch.after) === patch.after_sha256,
      "PATCH_CHANGED",
    )
  requireValue(
    plan.patches.at(-1)?.kind === "database" &&
      plan.patches.at(-1).id === plan.descriptor.skills.database_id,
    "DESCRIPTOR_MUST_COMMIT_LAST",
  )
  return plan
}

export function selectPatchValue(patch, raw) {
  if (patch.kind === "database") return { description: writableRich(raw.description) }
  if (patch.kind === "page") {
    const properties = {}
    for (const [id, wanted] of Object.entries(patch.before.properties)) {
      const values = Object.values(raw.properties).filter((value) => value.id === id)
      requireValue(values.length === 1 && !values[0].has_more, "PATCH_PROPERTY_INCOMPLETE")
      const type = Object.keys(wanted)[0]
      requireValue(values[0].type === type, "PATCH_PROPERTY_TYPE_CHANGED")
      properties[id] = { [type]: writableRich(values[0][type]) }
    }
    return { properties }
  }
  const type = Object.keys(patch.before)[0]
  requireValue(raw.type === type, "BLOCK_TYPE_CHANGED")
  return {
    [type]: Object.fromEntries(
      Object.keys(patch.before[type]).map((key) => [
        key,
        key === "cells" ? raw[type][key].map(writableRich) : writableRich(raw[type][key]),
      ]),
    ),
  }
}

const automaticEntityFields = new Set([
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
  "request_id",
  "url",
  "public_url",
])
const automaticPropertyTypes = new Set([
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
])
function inputValue(value) {
  if (Array.isArray(value)) return value.map(inputValue)
  if (!value || typeof value !== "object") return value
  if (!value.id && !value.object && ["text", "mention", "equation"].includes(value.type))
    return writableRich([value])[0]
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) => !(value.id && automaticPropertyTypes.has(value.type) && key === value.type),
      )
      .map(([key, item]) => [key, inputValue(item)]),
  )
}
const entityInput = (value) =>
  inputValue(
    Object.fromEntries(Object.entries(value).filter(([key]) => !automaticEntityFields.has(key))),
  )
function inventoryInput(inventory) {
  const byId = (rows) => rows.map(entityInput).sort((a, b) => a.id.localeCompare(b.id))
  const nativeOrder = {}
  for (const block of inventory.native_blocks) {
    const parent = canonical(block.parent ?? null)
    ;(nativeOrder[parent] ??= []).push(block.id)
  }
  return {
    root: entityInput(inventory.root),
    root_children_complete: inventory.root_children_complete,
    root_database_ids: [...inventory.root_database_ids].sort(),
    other_descriptors: [...inventory.other_descriptors].sort(),
    tables: Object.fromEntries(
      ROLES.map((role) => {
        const table = inventory.tables[role]
        return [
          role,
          {
            complete: table.complete,
            database: entityInput(table.database),
            data_source: entityInput(table.data_source),
            rows: byId(table.rows),
          },
        ]
      }),
    ),
    stores: inventory.stores.map((store) => store.path).sort(),
    native_bodies_complete: inventory.native_bodies_complete,
    native_body_failures: inventory.native_body_failures ?? [],
    native_page_ids: [...(inventory.native_page_ids ?? [])].sort(),
    native_blocks: byId(inventory.native_blocks),
    native_order: nativeOrder,
    required_content: [...inventory.required_content].sort((a, b) =>
      canonical(a).localeCompare(canonical(b)),
    ),
    content_audit: inventory.content_audit
      .map(({ sha256, bytes, references }) => ({ sha256, bytes, references }))
      .sort((a, b) => a.sha256.localeCompare(b.sha256)),
  }
}

/** Rebind only the reviewed before/after values, then compare every input.
 * This observes a quiesced library; it is not a remote compare-and-swap. */
export function verifyInventoryClosure(original, observed, plan, stage = "start") {
  const legacy = decodeLegacy(original.tables.skills.database.description)
  assertTopology(observed, legacy)
  const restored = structuredClone(observed)
  const states = []
  for (const patch of plan.patches) {
    const candidates =
      patch.kind === "block"
        ? restored.native_blocks
        : patch.kind === "database"
          ? ROLES.map((role) => restored.tables[role].database)
          : ROLES.flatMap((role) => restored.tables[role].rows)
    const matches = candidates.filter((value) => value.id === patch.id)
    requireValue(matches.length === 1, "INVENTORY_DRIFT", { kind: patch.kind, id: patch.id })
    const target = matches[0]
    const hash = digest(selectPatchValue(patch, target))
    requireValue([patch.before_sha256, patch.after_sha256].includes(hash), "REMOTE_DRIFT", {
      kind: patch.kind,
      id: patch.id,
    })
    states.push(hash === patch.after_sha256)
    if (patch.kind === "database") {
      // Notion reflects the Skills database description into its registered
      // data source. Only the originally observed, exact paired mirror is derived.
      const originalMirror = original.tables.skills.data_source.description
      const mirror = restored.tables.skills.data_source
      if (
        patch.id === plan.descriptor.skills.database_id &&
        Array.isArray(originalMirror) &&
        Array.isArray(mirror.description) &&
        digest({ description: writableRich(originalMirror) }) === patch.before_sha256 &&
        digest({ description: writableRich(mirror.description) }) === hash
      )
        mirror.description = structuredClone(patch.before.description)
      target.description = structuredClone(patch.before.description)
    } else if (patch.kind === "block")
      Object.assign(target[target.type], structuredClone(patch.before[target.type]))
    else
      for (const [id, value] of Object.entries(patch.before.properties))
        Object.assign(
          Object.values(target.properties).find((property) => property.id === id),
          structuredClone(value),
        )
  }
  const expected = digest(inventoryInput(original)),
    actual = digest(inventoryInput(restored))
  requireValue(actual === expected, "INVENTORY_DRIFT", {
    expected_sha256: expected,
    actual_sha256: actual,
  })
  if (stage === "descriptor_commit")
    requireValue(states.slice(0, -1).every(Boolean), "MIGRATION_PATCH_INCOMPLETE")
  if (states.at(-1)) requireValue(states.every(Boolean), "DESCRIPTOR_COMMIT_INCOMPLETE")
}

/** Resume always observes actual bytes. All writes are idempotent PATCHes to
 * existing identities; no CREATE, owner reassignment or history rewrite exists. */
export async function applyPlan(plan, io) {
  verifyPlan(plan)
  await io.preflight(plan, "start")
  const results = []
  for (const patch of plan.patches) {
    let actual = await io.read(patch)
    if (patch.kind === "database" && digest(actual) !== patch.after_sha256) {
      await io.preflight(plan, "descriptor_commit")
      actual = await io.read(patch)
    }
    if (digest(actual) === patch.after_sha256) {
      results.push({ sequence: patch.sequence, status: "observed_applied" })
      continue
    }
    requireValue(digest(actual) === patch.before_sha256, "REMOTE_DRIFT", {
      kind: patch.kind,
      id: patch.id,
    })
    await io.record({
      sequence: patch.sequence,
      status: "dispatching",
      before_sha256: patch.before_sha256,
      after_sha256: patch.after_sha256,
    })
    try {
      await io.patch(patch)
    } catch {
      throw Object.assign(new Error("WRITE_OUTCOME_UNKNOWN"), {
        code: "WRITE_OUTCOME_UNKNOWN",
        details: { sequence: patch.sequence, id: patch.id },
      })
    }
    requireValue(digest(await io.read(patch)) === patch.after_sha256, "WRITE_OUTCOME_UNKNOWN", {
      sequence: patch.sequence,
      id: patch.id,
    })
    await io.record({ sequence: patch.sequence, status: "verified" })
    results.push({ sequence: patch.sequence, status: "verified" })
  }
  return { status: "complete", plan_sha256: plan.plan_sha256, results }
}
