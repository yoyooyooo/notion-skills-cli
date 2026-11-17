import { basename, dirname, isAbsolute, resolve, relative, sep } from "node:path"
import { decode, property } from "./model.ts"
import { pageId, parseRef } from "./ref.ts"
import { sharedSkillId } from "./shared-content.ts"
import {
  emptyLocalIdentity,
  LocalInventoryIdentitySchema,
  type InventoryFinding,
  type LocalInventoryIdentity,
} from "./shared-inventory-model.ts"

export type ProvenanceDocument = {
  readonly path: string
  readonly observed_path?: string
  readonly value: unknown
}
export type LocalIdentityEntry = {
  readonly path: string
  readonly identity: LocalInventoryIdentity
}
export type InventoryModeRoot = {
  readonly repository: string
  readonly name: string
  readonly path: string
  readonly config_file: string
}
const string = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null)
const fixedCommit = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) ? value : null
const unsupportedInstallClaim = (candidate: unknown) => {
  const row = property(candidate),
    installed = string(row.installedName)
  return installed === null || /[\0\r\n]/u.test(installed) || row.type !== "git"
}

/** Preserve every opaque row and its registry key without exposing its values. */
export function unresolvedInstallClaims(value: unknown) {
  const raw = property(value)
  if (
    raw.version !== 1 ||
    raw.skills === null ||
    typeof raw.skills !== "object" ||
    Array.isArray(raw.skills)
  )
    return undefined
  return Object.entries(property(raw.skills))
    .filter(([, candidate]) => unsupportedInstallClaim(candidate))
    .sort(([left], [right]) => left.localeCompare(right))
}

/** Full shared parser input, including fields not currently interpreted as mode roots. */
export function inventoryAssetsSkills(value: unknown): unknown {
  return property(property(value).assets).skills
}
const within = (root: string, path: string) => {
  const part = relative(root, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}
function repository(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname.replace(/\.git$/u, "")}`
  } catch {
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)
      ? `https://github.com/${value}`
      : /^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+(?:\.git)?$/u.test(value)
        ? value.replace(/^git@([^:]+):/u, "https://$1/").replace(/\.git$/u, "")
        : null
  }
}

function handoffIdentity(ref: string | null) {
  if (ref === null) return undefined
  try {
    const parsed = parseRef(ref)
    if (
      !["SKILL.md", "ROUTER.md", "PROMPT.md"].includes(parsed.path) ||
      parsed.snapshot !== undefined ||
      parsed.file_id !== undefined
    )
      return undefined
    const page = pageId(parsed.selector)
    if (page !== undefined) return { page_id: page, library_id: null, skill_id: null }
    const shared = /^shared_skill:([^:]+):([^:]+)$/u.exec(parsed.selector)
    if (shared === null) return undefined
    const library = decodeURIComponent(shared[1]!),
      skill = decodeURIComponent(shared[2]!)
    return sharedSkillId(library, skill) === parsed.selector
      ? { page_id: null, library_id: library, skill_id: skill }
      : undefined
  } catch {
    return undefined
  }
}

/** Registry paths establish identity candidates; registry names alone never do. */
export function localInventoryProvenance(documents: readonly ProvenanceDocument[]) {
  const entries: LocalIdentityEntry[] = []
  const findings: InventoryFinding[] = []
  const roots: InventoryModeRoot[] = []
  const installedModes = new Map<string, unknown>()
  const observedPaths = new Map(
    documents.map((document) => [document.path, document.observed_path ?? document.path]),
  )
  const blocked = (path: string, code: string) =>
    findings.push({
      path: observedPaths.get(path) ?? path,
      code,
      severity: "review",
      details: { content: "redacted" },
    })
  for (const document of documents)
    if (basename(document.path) === "assets.yaml") {
      const repo = dirname(dirname(document.path)),
        skills = property(inventoryAssetsSkills(document.value))
      const configured = [
        skills,
        ...(Array.isArray(skills.roots) ? skills.roots.map(property) : []),
      ]
      const names = new Set<string>()
      for (const entry of configured) {
        const name = string(entry.name),
          path = string(entry.path)
        if (
          name === null ||
          path === null ||
          isAbsolute(path) ||
          !within(repo, resolve(repo, path)) ||
          entry.layout !== "skill-dir" ||
          names.has(name)
        ) {
          blocked(document.path, "ASSET_MODE_ROOT_INVALID")
          continue
        }
        names.add(name)
        roots.push({
          repository: repo,
          name,
          path: resolve(repo, path),
          config_file: document.path,
        })
      }
    }
  const installTarget = (
    repo: string,
    key: string,
    mode: unknown,
    evidence: string,
  ): string | undefined => {
    const configured = roots.filter((root) => root.repository === repo)
    const selected = mode == null ? configured[0] : configured.find((root) => root.name === mode)
    if (selected === undefined) {
      blocked(evidence, "INSTALL_MODE_ROOT_UNESTABLISHED")
      return undefined
    }
    const target = resolve(selected.path, key)
    if (!key || isAbsolute(key) || !within(selected.path, target)) {
      blocked(evidence, "INSTALL_PROVENANCE_OUTSIDE_MODE_ROOT")
      return undefined
    }
    return target
  }
  for (const document of documents) {
    const raw = property(document.value)
    const repo = dirname(dirname(document.path))
    if (basename(document.path) === "assets.yaml") continue
    if (raw.version !== 1) {
      blocked(document.path, "PROVENANCE_VERSION_UNSUPPORTED")
      continue
    }
    if (raw.kind === "ntn_skill_inventory_identity" && Array.isArray(raw.entries)) {
      for (const candidate of raw.entries) {
        const row = property(candidate)
        if (typeof row.path !== "string" || !isAbsolute(row.path)) {
          blocked(document.path, "PROVENANCE_PATH_INVALID")
          continue
        }
        try {
          entries.push({
            path: resolve(row.path),
            identity: decode(LocalInventoryIdentitySchema, {
              ...emptyLocalIdentity(),
              ...property(row.identity),
              authority: "explicit_identity",
              evidence_file: document.path,
            }),
          })
        } catch {
          blocked(document.path, "PROVENANCE_IDENTITY_INVALID")
        }
      }
    } else if (basename(document.path) === "notion-handoffs.json" && Array.isArray(raw.skills)) {
      for (const candidate of raw.skills) {
        const row = property(candidate),
          path = string(row.path),
          name = string(row.name),
          ref = string(row.ref)
        const identity = handoffIdentity(ref)
        if (
          path === null ||
          name === null ||
          identity === undefined ||
          isAbsolute(path) ||
          !within(repo, resolve(repo, path))
        ) {
          blocked(document.path, "HANDOFF_IDENTITY_INVALID")
          continue
        }
        const target = resolve(repo, path)
        entries.push({
          path: target,
          identity: {
            ...emptyLocalIdentity(),
            ...identity,
            authority: "notion_handoff",
            evidence_file: document.path,
          },
        })
      }
    } else if (
      basename(document.path) === "install-sources.json" &&
      raw.skills !== null &&
      typeof raw.skills === "object" &&
      !Array.isArray(raw.skills)
    ) {
      for (const [key, candidate] of Object.entries(property(raw.skills))) {
        const row = property(candidate)
        if (unsupportedInstallClaim(candidate)) {
          blocked(document.path, "INSTALL_PROVENANCE_UNSUPPORTED")
          continue
        }
        installedModes.set(`${repo}\0${key}`, row.mode)
        // Agent Kit install.ts joins modeRoot + registry key. The key already
        // includes `into`; installedName is display metadata, never a path.
        const target = installTarget(repo, key, row.mode, document.path)
        if (target === undefined) continue
        entries.push({
          path: target,
          identity: {
            ...emptyLocalIdentity(),
            repository: repository(row.cloneUrl ?? row.source),
            commit: fixedCommit(row.resolvedRef),
            source_path: string(row.sourcePath),
            member: string(row.sourcePath),
            authority:
              fixedCommit(row.resolvedRef) === null ? "unverified" : "fixed_install_provenance",
            evidence_file: document.path,
          },
        })
      }
    } else if (
      basename(document.path) !== "upstreams.json" ||
      raw.skills === null ||
      typeof raw.skills !== "object" ||
      Array.isArray(raw.skills)
    )
      blocked(document.path, "PROVENANCE_FORMAT_UNSUPPORTED")
  }
  for (const document of documents)
    if (basename(document.path) === "upstreams.json") {
      const raw = property(document.value)
      const repo = dirname(dirname(document.path))
      if (raw.version !== 1 || Array.isArray(raw.skills)) continue
      for (const [name, candidate] of Object.entries(property(raw.skills))) {
        const row = property(candidate)
        const target = installTarget(
          repo,
          name,
          row.targetMode ?? installedModes.get(`${repo}\0${name}`),
          document.path,
        )
        if (target === undefined) continue
        const commit = fixedCommit(row.baseRef) ?? fixedCommit(row.ref)
        entries.push({
          path: target,
          identity: {
            ...emptyLocalIdentity(),
            repository: repository(row.cloneUrl ?? row.repo),
            commit,
            source_path: string(row.sourcePath),
            member: string(row.sourcePath),
            authority: commit === null ? "unverified" : "fixed_install_provenance",
            evidence_file: document.path,
          },
        })
      }
    }
  return { entries, findings, roots }
}

/** Agent Kit's exact skillshare codec; round-trip rejects ambiguous old IDs. */
export function inventoryCanonicalAssetId(id: string): string | undefined {
  const encode = (value: string) => {
    const legacy = value.replaceAll("/", "__")
    return !value.includes("__") &&
      !value.includes("_/") &&
      !value.includes("/_") &&
      !value.includes("//") &&
      !legacy.startsWith("_ak1_")
      ? legacy
      : `_ak1_${Buffer.from(value, "utf8").toString("base64url")}`
  }
  try {
    const value = id.startsWith("_ak1_")
      ? /^[A-Za-z0-9_-]+$/u.test(id.slice(5))
        ? new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(id.slice(5), "base64url"))
        : undefined
      : id.replaceAll("__", "/")
    return value !== undefined &&
      Buffer.from(value, "utf8").toString("utf8") === value &&
      encode(value) === id
      ? value
      : undefined
  } catch {
    return undefined
  }
}
