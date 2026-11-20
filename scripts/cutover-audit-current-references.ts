#!/usr/bin/env node
/** AH-513 only. Replay failed owner admission and propose exact reference repairs.
 * No author bytes, Source bytes, Notion state or frozen candidate are changed. */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { posix, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { fileRef } from "../packages/core/src/ref.ts"
import { property, SkillsError, text } from "../packages/core/src/model.ts"
import { sharedSkillId } from "../packages/core/src/shared-content.ts"
import {
  assertSelectedSharedFileReferences,
  sharedMarkdownReferences,
} from "../packages/core/src/shared-file-references.ts"

const SourceCoordinate = Schema.Struct({
  source_page_id: Schema.String,
  source_path: Schema.String,
  source_id: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
})
const File = Schema.Struct({
  path: Schema.String,
  authority: Schema.Literals(["native", "resource", "source"]),
  sha256: Schema.String,
  bytes: Schema.Number,
  local_bytes_path: Schema.String,
  main: Schema.Boolean,
  binding: Schema.Struct({ file_id: Schema.String }),
  source: Schema.optional(SourceCoordinate),
  replaces_selected_original: Schema.optional(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("git"), ...SourceCoordinate.fields }),
      Schema.Struct({ kind: Schema.Literal("bundle") }),
    ]),
  ),
})
const Owner = Schema.Struct({
  owner_page_id: Schema.String,
  skill_id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  files: Schema.Array(File),
})
const Tree = Schema.Struct({ library_id: Schema.String, owners: Schema.Array(Owner) })
const Baseline = Schema.Struct({
  inputs: Schema.Struct({ tree: Schema.Struct({ sha256: Schema.String }) }),
  owners: Schema.Array(
    Schema.Struct({ owner_page_id: Schema.String, status: Schema.Literals(["pass", "fail"]) }),
  ),
})
const Pages = Schema.Array(Schema.Struct({ id: Schema.String, properties: Schema.Unknown }))
type Owner = typeof Owner.Type
type File = typeof File.Type
type Coordinate = typeof SourceCoordinate.Type & {
  readonly evidence: "current_source_file" | "selected_original" | "captured_source_member"
}
type Target = { readonly owner: Owner; readonly file: File; readonly coordinate: Coordinate }

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const flags = new Map<string, string>()
for (let at = 2; at < process.argv.length; at += 2) {
  const key = process.argv[at]
  const value = process.argv[at + 1]
  if (!key?.startsWith("--") || !value || flags.has(key))
    throw new Error("Use --tree PATH --admission PATH --skills PATH --output NEW_REPORT_PATH")
  flags.set(key, resolve(value))
}
for (const key of flags.keys())
  if (!["--tree", "--admission", "--skills", "--output"].includes(key))
    throw new Error(`Unknown argument: ${key}`)
const required = (key: string) => {
  const value = flags.get(key)
  if (!value) throw new Error(`Missing ${key}`)
  return value
}
const treePath = required("--tree")
const baselinePath = required("--admission")
const skillsPath = required("--skills")
const outputPath = required("--output")
if ([treePath, baselinePath, skillsPath].includes(outputPath))
  throw new Error("The audit report cannot overwrite an input")
const rawTree = readFileSync(treePath)
const rawBaseline = readFileSync(baselinePath)
const rawSkills = readFileSync(skillsPath)
const tree = Schema.decodeUnknownSync(Tree)(JSON.parse(rawTree.toString("utf8")))
const baseline = Schema.decodeUnknownSync(Baseline)(JSON.parse(rawBaseline.toString("utf8")))
const pages = Schema.decodeUnknownSync(Pages)(JSON.parse(rawSkills.toString("utf8")))
if (sha256(rawTree) !== baseline.inputs.tree.sha256)
  throw new Error("The admission report names a different frozen tree")
const owners = new Map(tree.owners.map((owner) => [owner.owner_page_id, owner]))
if (
  owners.size !== tree.owners.length ||
  new Set(pages.map((page) => page.id)).size !== pages.length
)
  throw new Error("Current owner metadata repeats a physical identity")
if (new Set(tree.owners.map((owner) => owner.skill_id)).size !== tree.owners.length)
  throw new Error("Current owners repeat a logical Skill identity")
for (const owner of tree.owners)
  if (new Set(owner.files.map((file) => file.binding.file_id)).size !== owner.files.length)
    throw new Error("A current owner repeats a stable File identity")
const metadata = new Map(
  pages.map((page) => {
    const fields = property(page.properties)
    const origin = property(fields.Origin)
    const member = property(fields["Source Member"])
    if (origin.type !== "relation" || !Array.isArray(origin.relation) || origin.has_more === true)
      throw new Error(`Incomplete Origin for ${page.id}`)
    const origins = origin.relation.map((value) => {
      const id = property(value).id
      if (typeof id !== "string") throw new Error("Origin lacks an exact page identity")
      return id
    })
    return [page.id, { origins, member: text(member.rich_text) }] as const
  }),
)
const coordinates = (owner: Owner, file: File): Coordinate | undefined => {
  if (file.source) return { ...file.source, evidence: "current_source_file" }
  if (file.replaces_selected_original?.kind === "git")
    return { ...file.replaces_selected_original, evidence: "selected_original" }
  const current = metadata.get(owner.owner_page_id)
  if (!current || current.origins.length !== 1 || !current.member) return undefined
  if (
    posix.normalize(current.member) !== current.member ||
    current.member.startsWith("../") ||
    current.member.startsWith("/")
  )
    throw new Error("A captured Source Member is not a canonical repository path")
  return {
    source_page_id: current.origins[0]!,
    source_path: posix.join(current.member, file.path),
    evidence: "captured_source_member",
  }
}
const bySourcePath = new Map<string, Target[]>()
const coordinateKey = (source: string, path: string) => JSON.stringify([source, path])
for (const owner of tree.owners)
  for (const file of owner.files) {
    const coordinate = coordinates(owner, file)
    if (!coordinate) continue
    const key = coordinateKey(coordinate.source_page_id, coordinate.source_path)
    bySourcePath.set(key, [...(bySourcePath.get(key) ?? []), { owner, file, coordinate }])
  }
const errorDetails = (error: unknown) =>
  error instanceof SkillsError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: "REFERENCE_AUDIT_ERROR", message: String(error) }
const directorySet = (paths: readonly string[]) => {
  const result = new Set([""])
  for (const path of paths) {
    const parts = path.split("/").slice(0, -1)
    while (parts.length) {
      result.add(parts.join("/"))
      parts.pop()
    }
  }
  return result
}
const targetReference = (target: Target) =>
  fileRef(
    sharedSkillId(tree.library_id, target.owner.skill_id),
    target.file.path,
    undefined,
    target.file.main ? undefined : target.file.binding.file_id,
  )

// Diagnostic parsing uses a virtual enclosing directory so the actual core parser
// can reveal later destinations after an owner escape. Strict owner admission above
// is never replaced by this view; every escape remains a finding requiring repair.
const frame = Array.from({ length: 64 }, () => "__reference_audit__").join("/")
const results = []
const counts: Record<string, number> = {}
const count = (kind: string) => {
  counts[kind] = (counts[kind] ?? 0) + 1
}
for (const previous of baseline.owners.filter((owner) => owner.status === "fail")) {
  const owner = owners.get(previous.owner_page_id)
  if (!owner) throw new Error("A failed admission owner disappeared from the frozen tree")
  const completePaths = owner.files.map((file) => file.path)
  const paths = new Set(completePaths)
  const directories = directorySet(completePaths)
  const markdownFiles = owner.files.filter((file) => /\.(?:md|markdown)$/iu.test(file.path))
  const selected = markdownFiles.map((file) => {
    const bytes = readFileSync(file.local_bytes_path)
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
      throw new Error(`Frozen bytes changed: ${owner.owner_page_id}/${file.path}`)
    return { path: file.path, bytes }
  })
  let admission
  try {
    admission = { status: "pass", ...assertSelectedSharedFileReferences(selected, completePaths) }
  } catch (error) {
    admission = { status: "fail", ...errorDetails(error) }
  }
  const findings = []
  const resolvedDirectories = []
  for (const [index, file] of markdownFiles.entries()) {
    const markdown = new TextDecoder("utf-8", { fatal: true }).decode(selected[index]!.bytes)
    const lines = markdown.split("\n")
    const fromCoordinate = coordinates(owner, file)
    let references
    try {
      references = sharedMarkdownReferences(`${frame}/${file.path}`, markdown)
    } catch (error) {
      count("invalid_destination")
      findings.push({
        path: file.path,
        authority: file.authority,
        kind: "invalid_destination",
        ...errorDetails(error),
      })
      continue
    }
    for (const reference of references) {
      const context = lines[reference.line - 1]?.slice(0, 350) ?? ""
      const common = {
        path: file.path,
        authority: file.authority,
        href: reference.href,
        line: reference.line,
        reference_kind: reference.kind,
        context,
      }
      const withinOwner = reference.target === frame || reference.target.startsWith(frame + "/")
      if (withinOwner) {
        const target = reference.target === frame ? "" : reference.target.slice(frame.length + 1)
        if (paths.has(target)) continue
        if (reference.kind === "link" && directories.has(target)) {
          resolvedDirectories.push({
            ...common,
            target,
            descendant_examples: completePaths
              .filter((path) => !target || path.startsWith(target + "/"))
              .slice(0, 3),
          })
          count("existing_directory")
          continue
        }
        const placeholderPossible =
          reference.kind === "link" && /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(reference.href)
        count("missing_local_target")
        findings.push({
          ...common,
          kind: "missing_local_target",
          target,
          placeholder_possible: placeholderPossible,
          action: placeholderPossible
            ? "Review the authored example; literal templates can be marked as code in an explicit edit."
            : "Recover the exact current file or propose an explicit current content edit.",
        })
        continue
      }
      if (!fromCoordinate) {
        count("outside_owner_without_source_coordinates")
        findings.push({ ...common, kind: "outside_owner_without_source_coordinates" })
        continue
      }
      const relative = posix.relative(posix.dirname(`${frame}/${file.path}`), reference.target)
      const repositoryPath = posix.normalize(
        posix.join(posix.dirname(fromCoordinate.source_path), relative),
      )
      const matches = repositoryPath.startsWith("../")
        ? []
        : (bySourcePath.get(coordinateKey(fromCoordinate.source_page_id, repositoryPath)) ?? [])
      if (matches.length !== 1) {
        const kind = matches.length ? "ambiguous_cross_owner_target" : "missing_cross_owner_target"
        count(kind)
        findings.push({
          ...common,
          kind,
          source_coordinates: fromCoordinate,
          repository_target: repositoryPath,
          matching_owner_page_ids: matches.map((match) => match.owner.owner_page_id),
        })
        continue
      }
      const target = matches[0]!
      const suffix = reference.href.match(/[?#].*$/u)?.[0] ?? ""
      count("exact_cross_owner_target")
      findings.push({
        ...common,
        kind: "exact_cross_owner_target",
        source_coordinates: fromCoordinate,
        repository_target: repositoryPath,
        target: {
          owner_page_id: target.owner.owner_page_id,
          skill_id: target.owner.skill_id,
          name: target.owner.name,
          enabled: target.owner.enabled,
          path: target.file.path,
          file_id: target.file.binding.file_id,
          authority: target.file.authority,
          coordinate_evidence: target.coordinate.evidence,
        },
        repair_candidate: {
          target_ref: targetReference(target),
          original_suffix: suffix,
          replacement_href:
            suffix === "" && reference.kind === "link" ? targetReference(target) : null,
          suffix_or_image_policy_required: suffix !== "" || reference.kind !== "link",
          content_change_boundary:
            file.authority === "native"
              ? "explicit_native_body_edit"
              : file.authority === "source"
                ? "explicit_source_takeover_or_upstream_edit"
                : "explicit_resource_replacement",
          immutable_original_bytes: file.authority !== "native",
          author_bytes_changed: false,
        },
      })
    }
  }
  results.push({
    owner_page_id: owner.owner_page_id,
    name: owner.name,
    admission,
    resolved_directories: resolvedDirectories,
    findings,
  })
}
const summary = {
  original_failed_owners: results.length,
  now_pass: results.filter((owner) => owner.admission.status === "pass").length,
  still_fail: results.filter((owner) => owner.admission.status === "fail").length,
  findings: counts,
}
const report = {
  version: 1,
  scope: "AH-513 frozen failed-owner reference replay and explicit repair candidates",
  inputs: {
    tree: { path: treePath, sha256: sha256(rawTree) },
    admission: { path: baselinePath, sha256: sha256(rawBaseline) },
    skills: { path: skillsPath, sha256: sha256(rawSkills) },
  },
  implementation_sha256: sha256(
    readFileSync(
      fileURLToPath(new URL("../packages/core/src/shared-file-references.ts", import.meta.url)),
    ),
  ),
  audit_script_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  boundaries: {
    network_calls: 0,
    author_bytes_modified: false,
    source_bytes_modified: false,
    frozen_candidate_modified: false,
    strict_owner_admission_preserved: true,
    diagnostic_virtual_parent_depth: 64,
    cross_owner_mapping:
      "Exact captured Source coordinate plus current owner/File identity; never display-name matching. Mapping proposes an edit and does not authorize an escaping local link.",
    template_policy:
      "Bare identifier destinations are review hints only; no placeholder is admitted by name.",
  },
  summary,
  owners: results,
}
writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 })
console.log(JSON.stringify({ output: outputPath, ...summary }))
