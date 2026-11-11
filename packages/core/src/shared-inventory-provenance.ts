import { basename, dirname, isAbsolute, resolve, relative, sep } from "node:path"
import { decode, property } from "./model.ts"
import { pageId } from "./ref.ts"
import {
  emptyLocalIdentity,
  LocalInventoryIdentitySchema,
  type InventoryFinding,
  type LocalInventoryIdentity,
} from "./shared-inventory-model.ts"

export type ProvenanceDocument = { readonly path: string; readonly value: unknown }
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

/** Registry paths establish identity candidates; registry names alone never do. */
export function localInventoryProvenance(documents: readonly ProvenanceDocument[]) {
  const entries: LocalIdentityEntry[] = []
  const findings: InventoryFinding[] = []
  const roots: InventoryModeRoot[] = []
  const installedModes = new Map<string, unknown>()
  const blocked = (path: string, code: string) =>
    findings.push({ path, code, severity: "review", details: { content: "redacted" } })
  for (const document of documents)
    if (basename(document.path) === "assets.yaml") {
      const repo = dirname(dirname(document.path)),
        skills = property(property(property(document.value).assets).skills)
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
        const selected = ref === null ? undefined : /^skill:\/\/([^/]+)\/SKILL\.md$/u.exec(ref)?.[1]
        const page = selected === undefined ? undefined : pageId(selected)
        if (
          path === null ||
          name === null ||
          page === undefined ||
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
            page_id: page,
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
        const row = property(candidate),
          installed = string(row.installedName)
        if (installed === null || /[\0\r\n]/u.test(installed) || row.type !== "git") {
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
    } else if (basename(document.path) !== "upstreams.json")
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
