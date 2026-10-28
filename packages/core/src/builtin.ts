import { Effect } from "effect"
import { explicitSource } from "./catalog.ts"
import { exportPortable, portableIdentity } from "./export.ts"
import { aliasFor, fail } from "./model.ts"
import type { SkillsError } from "./model.ts"
import { createPortable, replaceSkill } from "./mutation.ts"
import type { CreateOptions, ReplaceOptions } from "./mutation.ts"
import { normalizePath } from "./ref.ts"
import { importDocument } from "./import.ts"
import type { ImportFile } from "./import.ts"
import type { PortableSkill } from "./portable.ts"
import { configuration, publicConfiguration, Store } from "./store.ts"

export interface BuiltinSkill {
  readonly id: string
  readonly version: string
  readonly portable: PortableSkill
}
export interface BuiltinInfo {
  readonly id: string
  readonly origin: "builtin"
  readonly publisher: "ntn-skills"
  readonly package_version: string
  readonly name: string
  readonly notion_name: string
  readonly description: string
  readonly content_id: string
}

export function defineBuiltin(
  id: string,
  version: string,
  files: readonly ImportFile[],
): BuiltinSkill {
  const main = files.find((file) => file.path === "SKILL.md")
  if (!main) throw fail("INVALID_SKILL", "Built-in Skill requires SKILL.md.")
  const document = importDocument(main)
  if (id !== `notion/${aliasFor(document.name)}`)
    throw fail("INVALID_SKILL", "Built-in ID must match notion/<frontmatter-name>.")
  return {
    id,
    version,
    portable: {
      kind: "skill",
      name: document.name,
      description: document.description,
      main: "SKILL.md",
      files,
    },
  }
}

export function selectBuiltin(skills: readonly BuiltinSkill[], id: string): BuiltinSkill {
  const skill = skills.find((skill) => skill.id === id)
  if (!skill)
    throw fail("BUILTIN_NOT_FOUND", "Use an exact built-in ID returned by builtin list.", {
      id,
      candidates: skills.map((skill) => skill.id),
    })
  return skill
}

export function builtinInfo(skill: BuiltinSkill) {
  return Effect.gen(function* () {
    return {
      id: skill.id,
      origin: "builtin" as const,
      publisher: "ntn-skills" as const,
      package_version: skill.version,
      name: skill.id.split("/").at(-1)!,
      notion_name: skill.portable.name,
      description: skill.portable.description,
      content_id: yield* portableIdentity(skill.portable),
    } satisfies BuiltinInfo
  })
}

export function readBuiltin(skill: BuiltinSkill, inputPath = "SKILL.md") {
  return Effect.gen(function* () {
    const path = yield* Effect.try({
      try: () => normalizePath(inputPath),
      catch: (e) => e as SkillsError,
    })
    const file = skill.portable.files.find((file) => file.path === path)
    if (!file)
      return yield* Effect.fail(fail("FILE_NOT_FOUND", "No built-in file matched.", { path }))
    return {
      source: "builtin" as const,
      builtin: yield* builtinInfo(skill),
      path,
      content: new TextDecoder().decode(file.bytes),
      files: skill.portable.files.map((file) => ({ path: file.path, bytes: file.bytes.length })),
    }
  })
}

export function exportBuiltin(skill: BuiltinSkill, output: string) {
  return Effect.gen(function* () {
    return {
      ...(yield* exportPortable(skill.portable, { output })),
      source: "builtin",
      builtin: yield* builtinInfo(skill),
    }
  })
}

export function configureBuiltinDatabase(database?: string) {
  return Effect.gen(function* () {
    const config = yield* configuration
    const source = database === undefined ? undefined : yield* explicitSource(database)
    const { builtin_database: _previous, ...rest } = config
    const next = { ...rest, ...(source ? { builtin_database: source.database_id } : {}) }
    const store = yield* Store
    yield* store.writeJson("config.json", next)
    return publicConfiguration(next)
  })
}

export function publishBuiltin(
  skill: BuiltinSkill,
  options: CreateOptions & { readonly target?: ReplaceOptions["target"] } = {},
) {
  return Effect.gen(function* () {
    const config = yield* configuration
    const database =
      options.database ?? (options.target === undefined ? config.builtin_database : undefined)
    const selected = {
      database,
      dryRun: options.dryRun,
      onProgress: options.onProgress,
      source: { type: "builtin" as const, builtinId: skill.id },
    }
    const result =
      options.target === undefined
        ? yield* createPortable(skill.portable, selected)
        : yield* replaceSkill(skill.portable, { ...selected, target: options.target })
    return { ...result, builtin: yield* builtinInfo(skill) }
  })
}
