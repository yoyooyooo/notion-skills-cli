import { createHash } from "node:crypto"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative as relativePath } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const destination = await mkdtemp(join(tmpdir(), "ntn-skills-pack-"))
async function run(command: string[], cwd = root) {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit) throw new Error(`${command[0]} failed: ${stderr || stdout}`)
  return stdout
}
const packed = await run(
  ["bun", "pm", "pack", "--destination", destination, "--quiet"],
  join(root, "packages/cli"),
)
const name = packed.trim().split("\n").at(-1)!
const archive = name.startsWith("/") ? name : join(destination, name)
const entries = (await run(["tar", "-tzf", archive]))
  .trim()
  .split("\n")
  .filter((entry) => !entry.endsWith("/"))
const source = JSON.parse(await readFile(join(root, "packages/cli/package.json"), "utf8"))
const manifest = JSON.parse(await run(["tar", "-xOf", archive, "package/package.json"]))
if (manifest.name !== "ntn-skills" || manifest.version !== source.version || manifest.private)
  throw new Error("Packed package identity differs from the public CLI manifest.")
if (
  manifest.bin?.["ntn-skills"] !== "dist/ntn-skills.js" ||
  Object.keys(manifest.bin ?? {}).join(",") !== "ntn-skills" ||
  !entries.includes("package/dist/ntn-skills.js")
)
  throw new Error("Packed CLI entrypoint is missing.")
if (manifest.engines?.node !== "^22.22.3 || >=24.20.0" || manifest.engines?.bun)
  throw new Error(
    "Packed consumer runtime must be Node.js 22.22.3+ within 22.x, or Node.js 24.20.0+.",
  )
for (const section of ["dependencies", "optionalDependencies", "peerDependencies"])
  for (const [dependency, value] of Object.entries(manifest[section] ?? {}))
    if (typeof value !== "string" || /^(?:catalog|workspace|file|link):/.test(value))
      throw new Error(`Packed ${section} contains a non-public dependency: ${dependency}`)
if (manifest.repository?.url !== "git+https://github.com/yoyooyooo/notion-skills-cli.git")
  throw new Error("Packed repository identity differs.")
const publicFiles = [
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/README.md",
  "docs/usage.md",
  "docs/protocol.md",
  "docs/shared-ssot-architecture.md",
  "docs/historical-operations.md",
  "docs/host-integration.md",
  "docs/releasing.md",
  "docs/portable-converter.md",
  "docs/remote-proof-converter.md",
  "skills/ntn-skills/SKILL.md",
  "skills/ntn-skills/references/commands.md",
  "skills/ntn-skills/references/integration.md",
  "skills/notion/ntn-skills-maintain/SKILL.md",
  "skills/notion/ntn-skills-maintain/references/operations.md",
  "skills/notion/ntn-skills-sync/SKILL.md",
  "skills/notion/ntn-skills-sync/references/synchronization.md",
]
const expected = new Set([
  "package/package.json",
  "package/dist/ntn-skills.js",
  ...publicFiles.map((file) => `package/${file}`),
])
if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry)))
  throw new Error(
    `Unexpected tarball files: ${entries.filter((entry) => !expected.has(entry)).join(", ")}`,
  )
for (const file of publicFiles) {
  const bytes = await readFile(join(root, file))
  const bundled = await run(["tar", "-xOf", archive, `package/${file}`])
  if (bundled !== bytes.toString("utf8")) throw new Error(`Bundled document is stale: ${file}`)
  const links = [
    ...Array.from(bundled.matchAll(/\[[^\]]*\]\(([^)]+)\)/g), (match) => match[1]!),
    ...Array.from(bundled.matchAll(/href=["']([^"']+)["']/g), (match) => match[1]!),
  ]
  for (const href of links) {
    if (/^(?:[a-z]+:|#)/i.test(href)) continue
    const [relative] = href.split("#")
    const linked = join(dirname(join(root, file)), relative!)
    if (!(await Bun.file(linked).exists()))
      throw new Error(`Broken public document link: ${file} -> ${href}`)
    const packagedLink = `package/${relativePath(root, linked)}`
    if (!expected.has(packagedLink))
      throw new Error(`Public document link is not packaged: ${file} -> ${href}`)
  }
}
const compiled = await run(["tar", "-xOf", archive, "package/dist/ntn-skills.js"])
if (!compiled.startsWith("#!/usr/bin/env node\n"))
  throw new Error("Packed CLI must launch with Node.js.")
if (/\/Users\/|\/home\/[^/\s]+\/|\/private\/var\/|[A-Z]:\\Users\\/.test(compiled))
  throw new Error("Compiled package contains a machine-specific home path.")
if (
  /MIGRATION_WRITERS_ACTIVE|MIGRATION_ROOT_MISMATCH|legacy-state-directory|ntn-skills-state-migration|old-writers-stopped/.test(
    compiled,
  )
)
  throw new Error(
    "Normal CLI artifact includes the independent legacy-state migration implementation.",
  )
if (
  /remote-proof-v1-to-v2|original-provenance-v1|extended-guard-v1|remote-proof-conversion-attempt/.test(
    compiled,
  )
)
  throw new Error(
    "Normal CLI artifact includes independent historical remote-proof conversion implementation.",
  )
for (const section of ["dependencies", "optionalDependencies", "peerDependencies"])
  for (const dependency of Object.keys(manifest[section] ?? {})) {
    if (/migration|legacy/.test(dependency))
      throw new Error(`Normal package depends on obsolete or migration runtime: ${dependency}`)
    if (
      (dependency === "effect" || dependency.startsWith("@effect/")) &&
      manifest[section][dependency] !== "4.0.5"
    )
      throw new Error(`Packed Effect runtime must use official 4.0.5: ${dependency}`)
  }
const migrationSource = join(destination, "migration-package")
await run(["bun", join(root, "scripts/build-migration.ts"), migrationSource])
const migrationPacked = JSON.parse(
  await run(["npm", "pack", migrationSource, "--pack-destination", destination, "--json"]),
)
const migrationArchive = join(destination, migrationPacked[0].filename)
const migrationEntries = (await run(["tar", "-tzf", migrationArchive]))
  .trim()
  .split("\n")
  .filter((entry) => !entry.endsWith("/"))
const migrationFiles = ["package.json", "ntn-skills-migrate.js", "ntn-skills-operator.js"]
const expectedMigration = new Set(migrationFiles.map((file) => `package/${file}`))
if (
  migrationEntries.length !== expectedMigration.size ||
  migrationEntries.some((entry) => !expectedMigration.has(entry))
)
  throw new Error(
    `Independent migration archive has unexpected or missing files: ${migrationEntries.join(", ")}`,
  )
const migrationManifest = JSON.parse(
  await run(["tar", "-xOf", migrationArchive, "package/package.json"]),
)
if (
  migrationManifest.name !== "ntn-skills-state-migration" ||
  migrationManifest.private !== true ||
  Object.keys(migrationManifest.bin ?? {})
    .sort()
    .join(",") !== "ntn-skills-migrate,ntn-skills-operator" ||
  migrationManifest.bin["ntn-skills-migrate"] !== "ntn-skills-migrate.js" ||
  migrationManifest.bin["ntn-skills-operator"] !== "ntn-skills-operator.js" ||
  migrationManifest.engines?.node !== manifest.engines.node
)
  throw new Error(
    "Independent migration archive identity, executables or runtime contract differs.",
  )
for (const file of migrationFiles.slice(1)) {
  const compiled = await run(["tar", "-xOf", migrationArchive, `package/${file}`])
  if (!compiled.startsWith("#!/usr/bin/env node\n"))
    throw new Error(`Independent ${file} must launch with Node.js.`)
}
const smoke = JSON.parse(
  await run([
    "bun",
    join(root, "scripts/package-smoke.ts"),
    "--archive",
    archive,
    "--migration-archive",
    migrationArchive,
  ]),
)
console.log(
  JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    archive,
    migration_archive: migrationArchive,
    migration_files: migrationFiles,
    migration_integrity: `sha512-${createHash("sha512")
      .update(await readFile(migrationArchive))
      .digest("base64")}`,
    integrity: `sha512-${createHash("sha512")
      .update(await readFile(archive))
      .digest("base64")}`,
    files: entries.map((entry) => entry.slice("package/".length)),
    smoke,
    scratch: dirname(archive),
  }),
)
