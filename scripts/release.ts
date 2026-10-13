#!/usr/bin/env -S bun
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { spawnSync } from "node:child_process"

type Version = { major: bigint; minor: bigint; patch: bigint; prerelease: string[] }
type PackageFile = {
  relPath: string
  path: string
  value: Record<string, unknown> & { version: string }
}
type Config = {
  defaultBranch: string
  remote: string
  tagPrefix: string
  versionFiles: string[]
  lockfiles: string[]
  lockfileCommand: string[] | null
  checkCommand: string[] | null
  localCheckCommand?: string[] | null
  commitMessage: string
  publishMode: "none" | "npm"
  publishPackage: string | null
  publishRegistry: string
  allowPrerelease: boolean
  stableDistTag: string
  prereleaseDistTag: string
  failedTagPolicy: "immutable"
  releaseBranchPrefix: string
}
type Options = {
  allowBranch: boolean
  dryRun: boolean
  noPush: boolean
  precheck: boolean
  skipLocalCheck: boolean
  versionArg: string
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..")
const configPath = resolve(repoRoot, ".github/release.config.json")
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

main()

function main(): void {
  let originalBranch = ""
  let tempBranch = ""
  try {
    const config = readConfig()
    const options = parseArgs(process.argv.slice(2))
    if (options.skipLocalCheck && !options.noPush)
      fail("--skip-local-check is limited to local --no-push fixtures.")
    if (options.allowBranch && !options.noPush)
      fail("--allow-branch is limited to local --no-push fixtures.")
    ensureGitBase(config, options)
    run("git", ["fetch", config.remote, "--tags"], { quiet: true })

    const packages = readVersionFiles(config.versionFiles)
    const fileVersion = assertAlignedVersion(packages)
    const publishedVersions = readPublishedVersions(config)
    const tagVersions = readTagVersions(config.tagPrefix)
    const decision = chooseVersion(fileVersion, publishedVersions, tagVersions, options, config)
    const tag = `${config.tagPrefix}${decision.next}`

    if (options.dryRun || options.precheck) {
      if (
        options.precheck &&
        !options.skipLocalCheck &&
        Array.isArray(config.localCheckCommand) &&
        config.localCheckCommand.length > 0
      ) {
        run(config.localCheckCommand[0]!, config.localCheckCommand.slice(1))
      }
      printPlan(fileVersion, decision, tag, config, options, tagVersions)
      return
    }

    originalBranch = currentBranch()
    tempBranch = `${config.releaseBranchPrefix}${tag}-${shortSha()}-${Date.now()}`
    run("git", ["switch", "-c", tempBranch])

    for (const pkg of packages) {
      pkg.value.version = decision.next
      writeJson(pkg.path, pkg.value)
    }
    if (Array.isArray(config.lockfileCommand) && config.lockfileCommand.length > 0) {
      run(config.lockfileCommand[0]!, config.lockfileCommand.slice(1))
    }
    if (
      !options.skipLocalCheck &&
      Array.isArray(config.localCheckCommand) &&
      config.localCheckCommand.length > 0
    ) {
      run(config.localCheckCommand[0]!, config.localCheckCommand.slice(1))
    }

    const addPaths = unique([...config.versionFiles, ...config.lockfiles])
    assertReleaseChanges(config, packages)
    run("git", ["add", ...addPaths])
    run("git", ["commit", "--allow-empty", "-m", formatCommitMessage(config.commitMessage, tag)])

    if (
      execCommand("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], false).exitCode === 0
    )
      fail(`Tag already exists: ${tag}`)
    run("git", ["tag", "-a", tag, "-m", tag])

    if (!options.noPush) {
      run("git", ["push", config.remote, `refs/tags/${tag}`])
    }

    run("git", ["switch", originalBranch], { quiet: true })
    // The annotated tag keeps the release commit reachable; delete only its temporary branch ref.
    run(
      "git",
      [
        "update-ref",
        "-d",
        `refs/heads/${tempBranch}`,
        run("git", ["rev-parse", tag + "^{commit}"], { quiet: true }),
      ],
      { quiet: true },
    )
    console.log(
      options.noPush
        ? `${tag} created locally. No tag was pushed.`
        : `${tag} pushed. CI publish workflow should start.`,
    )
  } catch (error) {
    if (tempBranch)
      console.error(
        `Release failed; inspect preserved branch ${tempBranch}. No tag or files were deleted.`,
      )
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

function readConfig(): Config {
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Config>
  if (!Array.isArray(parsed.versionFiles) || parsed.versionFiles.length === 0) {
    fail("release config versionFiles must be a non-empty array")
  }
  if (parsed.failedTagPolicy !== "immutable") fail("Only immutable release tags are supported.")
  return {
    defaultBranch: "main",
    remote: "origin",
    tagPrefix: "v",
    lockfiles: [],
    lockfileCommand: null,
    checkCommand: null,
    localCheckCommand: null,
    commitMessage: "chore: release {tag}",
    publishMode: "npm",
    publishPackage: null,
    publishRegistry: "https://registry.npmjs.org",
    allowPrerelease: false,
    stableDistTag: "latest",
    prereleaseDistTag: "next",
    failedTagPolicy: "immutable",
    releaseBranchPrefix: "release/",
    ...parsed,
    versionFiles: parsed.versionFiles,
  }
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    allowBranch: false,
    dryRun: false,
    noPush: false,
    precheck: false,
    skipLocalCheck: false,
    versionArg: "",
  }
  const positional: string[] = []
  for (const arg of args) {
    if (arg === "--allow-branch") options.allowBranch = true
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--no-push") options.noPush = true
    else if (arg === "--precheck") options.precheck = true
    else if (arg === "--skip-local-check") options.skipLocalCheck = true
    else if (arg === "--help" || arg === "-h") {
      console.log(usage())
      process.exit(0)
    } else if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}\n\n${usage()}`)
    } else {
      positional.push(arg)
    }
  }
  if (positional.length !== 1) {
    fail(`Expected exactly one version argument.\n\n${usage()}`)
  }
  options.versionArg = positional[0]!
  return options
}

function usage(): string {
  return `Usage:
  release <patch|minor|major|x.y.z> [--dry-run] [--precheck] [--no-push] [--allow-branch]

Default model:
  Creates a temporary local release branch, writes version files, commits, tags that commit, pushes tag only.
  Pushed release tags are immutable. A failed unpublished tag requires a higher version.`
}

function ensureGitBase(config: Config, options: Options): void {
  run("git", ["rev-parse", "--is-inside-work-tree"], { quiet: true })
  const status = run("git", ["status", "--porcelain"], { quiet: true })
  if (status.length > 0) fail("Working tree is not clean. Commit or stash changes before release.")
  const branch = currentBranch()
  if (branch.length === 0) fail("Detached HEAD. Check out a branch before release.")
  if (branch !== config.defaultBranch && !options.allowBranch) {
    fail(
      `Release must run on ${config.defaultBranch}. Current branch: ${branch}. Use --allow-branch to override.`,
    )
  }
  const remote = execCommand("git", ["remote", "get-url", config.remote], false)
  if (remote.exitCode !== 0)
    fail(`Missing git remote: ${config.remote}. A local fixture may use a local bare origin.`)
  run("git", ["fetch", config.remote, config.defaultBranch, "--no-tags"])
  const head = run("git", ["rev-parse", "HEAD"], { quiet: true })
  const remoteHead = run("git", ["rev-parse", `${config.remote}/${config.defaultBranch}`], {
    quiet: true,
  })
  if (head !== remoteHead) {
    fail(
      `HEAD must equal ${config.remote}/${config.defaultBranch} before creating a release commit. head=${head} remote=${remoteHead}`,
    )
  }
}

function readVersionFiles(paths: string[]): PackageFile[] {
  return paths.map((relPath) => {
    const path = resolve(repoRoot, relPath)
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & {
      version?: unknown
    }
    if (typeof value.version !== "string") fail(`${relPath} must contain a string version`)
    parseVersion(value.version)
    return { relPath, path, value: value as Record<string, unknown> & { version: string } }
  })
}

function assertAlignedVersion(packages: PackageFile[]): string {
  const [first, ...rest] = packages
  if (!first) fail("No version files configured.")
  for (const pkg of rest) {
    if (pkg.value.version !== first.value.version) {
      fail(
        `Version mismatch: ${first.relPath} has ${first.value.version}, ${pkg.relPath} has ${pkg.value.version}`,
      )
    }
  }
  return first.value.version
}

function readPublishedVersions(config: Config): string[] {
  if (
    config.publishMode === "npm" &&
    (config.publishPackage === null || config.publishPackage.length === 0)
  ) {
    fail("release config publishPackage is required for npm publish mode.")
  }
  if (config.publishPackage === null || config.publishPackage.length === 0) return []
  const result = execCommand(
    "npm",
    ["view", config.publishPackage, "versions", "--json", "--registry", config.publishRegistry],
    false,
  )
  if (result.exitCode !== 0) {
    if (result.stderr.includes("E404") || result.stdout.includes("E404")) return []
    fail(
      `Unable to read npm versions for ${config.publishPackage}.\n${result.stderr || result.stdout}`,
    )
  }
  const parsed = JSON.parse(result.stdout || "[]") as unknown
  if (Array.isArray(parsed))
    return parsed.filter((value): value is string => typeof value === "string" && isVersion(value))
  return typeof parsed === "string" && isVersion(parsed) ? [parsed] : []
}

function readTagVersions(prefix: string): string[] {
  const output = run("git", ["tag", "--list", `${prefix}[0-9]*.[0-9]*.[0-9]*`], { quiet: true })
  return output
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith(prefix) ? tag.slice(prefix.length) : tag))
    .filter(isVersion)
}

function chooseVersion(
  fileVersion: string,
  publishedVersions: string[],
  tagVersions: string[],
  options: Options,
  config: Config,
): { next: string; base: string; reason: string; reusingFailedTag: boolean } {
  const latestPublished = maxVersion(publishedVersions)
  const latestTag = maxVersion(tagVersions)
  const latestKnown = maxVersion(
    [fileVersion, latestPublished, latestTag].filter((value): value is string => value !== null),
  )
  let requested: string
  if (isBumpKind(options.versionArg)) {
    const base = latestKnown ?? fileVersion
    const parsedBase = parseVersion(base)
    if (parsedBase.prerelease.length > 0) {
      fail(
        `Cannot infer a ${options.versionArg} bump from prerelease ${base}. Provide an exact version.`,
      )
    }
    requested = formatVersion(bumpVersion(parsedBase, options.versionArg))
  } else {
    requested = formatVersion(parseVersion(options.versionArg))
  }

  const parsedRequested = parseVersion(requested)
  if (parsedRequested.prerelease.length > 0 && !config.allowPrerelease) {
    fail(`Prerelease versions are disabled by release config. Got ${requested}.`)
  }
  if (publishedVersions.includes(requested)) {
    fail(
      `${config.publishPackage ?? "package"}@${requested} already exists on npm. Choose a higher version.`,
    )
  }
  const releaseFloor = maxVersion([latestPublished, latestTag])
  if (releaseFloor !== null && compareVersions(requested, releaseFloor) < 0) {
    fail(
      `Requested version ${requested} must be greater than published/tagged release ${releaseFloor}.`,
    )
  }
  if (tagVersions.includes(requested))
    fail(
      `Tag already exists: ${config.tagPrefix}${requested}. Tags are immutable; choose a higher version.`,
    )
  return {
    next: requested,
    base: latestPublished ?? fileVersion,
    reason: `new release from base ${latestPublished ?? fileVersion}`,
    reusingFailedTag: false,
  }
}

function assertReleaseChanges(config: Config, packages: PackageFile[]): void {
  const allowed = new Set([...config.versionFiles, ...config.lockfiles])
  const changed = run("git", ["diff", "--name-only", "HEAD"], { quiet: true })
    .split(/\r?\n/)
    .filter(Boolean)
  for (const path of changed)
    if (!allowed.has(path)) fail(`Release changed unauthorized path: ${path}`)
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"], { quiet: true })
  if (untracked) fail(`Release check created untracked files: ${untracked}`)
  for (const pkg of packages) {
    const before = JSON.parse(run("git", ["show", `HEAD:${pkg.relPath}`], { quiet: true }))
    const after = JSON.parse(readFileSync(pkg.path, "utf8"))
    delete before.version
    delete after.version
    if (!isDeepStrictEqual(before, after)) fail(`Release changed ${pkg.relPath} beyond its version`)
  }
}

function printPlan(
  fileVersion: string,
  decision: { next: string; base: string; reason: string; reusingFailedTag: boolean },
  tag: string,
  config: Config,
  options: Options,
  tagVersions: string[],
): void {
  const distTag =
    parseVersion(decision.next).prerelease.length > 0
      ? config.prereleaseDistTag
      : config.stableDistTag
  console.log(`Release ${options.precheck ? "precheck" : "dry-run"}:
  package: ${config.publishPackage ?? "unknown"}
  file version: ${fileVersion}
  next: ${decision.next}
  tag: ${tag}
  npm dist-tag: ${distTag}
  reason: ${decision.reason}
  replace failed tag: ${decision.reusingFailedTag ? "yes" : "no"}
  local branch: temporary ${config.releaseBranchPrefix}${tag}-<sha>
  pushes: ${options.noPush ? "none" : "tag only"}
  main commit: no
  known tags: ${tagVersions.length}
`)
}

function currentBranch(): string {
  return run("git", ["branch", "--show-current"], { quiet: true })
}

function shortSha(): string {
  return run("git", ["rev-parse", "--short", "HEAD"], { quiet: true })
}

function writeJson(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function run(command: string, args: string[], options: { quiet?: boolean } = {}): string {
  const result = execCommand(command, args, options.quiet !== true)
  if (result.exitCode !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n")
    fail(
      `Command failed: ${formatCommand([command, ...args])}${output.length > 0 ? `\n${output}` : ""}`,
    )
  }
  return result.stdout.trim()
}

function execCommand(
  command: string,
  args: string[],
  logCommand: boolean,
): { exitCode: number; stdout: string; stderr: string } {
  if (logCommand) console.log(`$ ${formatCommand([command, ...args])}`)
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function isBumpKind(value: string): value is "major" | "minor" | "patch" {
  return value === "major" || value === "minor" || value === "patch"
}

function isVersion(value: string): boolean {
  return versionPattern.test(value)
}

function parseVersion(value: string): Version {
  const match = value.match(versionPattern)
  if (match === null)
    fail(`Expected semver x.y.z or x.y.z-prerelease without build metadata. Got ${value}.`)
  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease: match[4]?.split(".") ?? [],
  }
}

function bumpVersion(version: Version, bump: "major" | "minor" | "patch"): Version {
  if (bump === "major") return { major: version.major + 1n, minor: 0n, patch: 0n, prerelease: [] }
  if (bump === "minor")
    return { major: version.major, minor: version.minor + 1n, patch: 0n, prerelease: [] }
  return { major: version.major, minor: version.minor, patch: version.patch + 1n, prerelease: [] }
}

function compareVersions(left: string, right: string): number {
  const l = parseVersion(left)
  const r = parseVersion(right)
  for (const key of ["major", "minor", "patch"] as const) {
    if (l[key] !== r[key]) return l[key] < r[key] ? -1 : 1
  }
  if (l.prerelease.length === 0) return r.prerelease.length === 0 ? 0 : 1
  if (r.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(l.prerelease.length, r.prerelease.length); index += 1) {
    const leftPart = l.prerelease[index]
    const rightPart = r.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      if (leftPart.length !== rightPart.length) return leftPart.length - rightPart.length
      return leftPart < rightPart ? -1 : 1
    }
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function maxVersion(values: (string | null)[]): string | null {
  const versions = values.filter(
    (value): value is string => typeof value === "string" && isVersion(value),
  )
  return versions.sort(compareVersions).at(-1) ?? null
}

function formatVersion(version: Version): string {
  const core = `${version.major}.${version.minor}.${version.patch}`
  return version.prerelease.length > 0 ? `${core}-${version.prerelease.join(".")}` : core
}

function formatCommitMessage(template: string, tag: string): string {
  return template.replaceAll("{tag}", tag)
}

function formatCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ")
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_/:=.,@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function fail(message: string): never {
  throw new Error(message)
}
