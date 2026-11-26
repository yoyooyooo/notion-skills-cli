import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative as relativePath } from "node:path"
import { fileURLToPath } from "node:url"
import { SourceLexer } from "../packages/markdown/src/index.ts"

type Token = ReturnType<typeof SourceLexer.lex>[number]

function documentLinks(tokens: readonly Token[]): string[] {
  const links: string[] = []
  for (const token of tokens) {
    if (token.type === "code" || token.type === "codespan") continue
    if (token.type === "link" || token.type === "image") links.push(token.href)
    if (token.type === "html")
      links.push(...Array.from(token.raw.matchAll(/href=["']([^"']+)["']/g), (match) => match[1]!))
    if (token.type === "list") {
      if (Array.isArray(token.items)) links.push(...documentLinks(token.items))
    } else if (token.type === "table") {
      if (Array.isArray(token.header))
        for (const cell of token.header) links.push(...documentLinks(cell.tokens))
      if (Array.isArray(token.rows))
        for (const row of token.rows)
          for (const cell of row) links.push(...documentLinks(cell.tokens))
    } else if ("tokens" in token && Array.isArray(token.tokens))
      links.push(...documentLinks(token.tokens))
  }
  return links
}

const root = fileURLToPath(new URL("../", import.meta.url))
const evidenceRoot = process.env.NTN_SMOKE_EVIDENCE_ROOT
if (evidenceRoot) await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
const destination = await mkdtemp(join(evidenceRoot ?? tmpdir(), "ntn-skills-pack-"))
const target = join(destination, "package")
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
await run(["bun", join(root, "packages/cli/build.ts"), "--outdir", target])
const packed = await run(["bun", "pm", "pack", "--destination", destination, "--quiet"], target)
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
if (
  manifest.exports?.["./sdk"]?.import !== "./dist/sdk.js" ||
  manifest.exports?.["./sdk"]?.default !== "./dist/sdk.js" ||
  manifest.exports?.["./sdk"]?.types !== "./dist/types/cli/src/sdk.d.ts" ||
  !entries.includes("package/dist/sdk.js")
)
  throw new Error("Packed SDK export or generated declarations are missing.")
if (
  manifest.exports?.["./management"]?.import !== "./dist/management.js" ||
  manifest.exports?.["./management"]?.default !== "./dist/management.js" ||
  manifest.exports?.["./management"]?.types !== "./dist/types/cli/src/management.d.ts" ||
  !entries.includes("package/dist/management.js")
)
  throw new Error("Packed management export or generated declarations are missing.")
if (
  manifest.exports?.["./ref"]?.import !== "./dist/ref.js" ||
  manifest.exports?.["./ref"]?.require !== "./dist/ref.cjs" ||
  manifest.exports?.["./ref"]?.types !== "./dist/types/core/src/skill-ref.d.ts" ||
  !entries.includes("package/dist/ref.js") ||
  !entries.includes("package/dist/ref.cjs")
)
  throw new Error("Packed pure Skill reference protocol is missing.")
if (manifest.engines?.node !== "^22.23.5 || ^24.22.3 || ^26.13.1" || manifest.engines?.bun)
  throw new Error("Packed consumer runtime must be Node.js ^22.23.5, ^24.22.3, or ^26.13.1.")
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
  "docs/current-contract.md",
  "docs/library-roots.md",
  "docs/library-root-migration.md",
  "docs/usage.md",
  "docs/notion-mcp.md",
  "docs/source-sync.md",
  "docs/shared-authoring.md",
  "docs/protocol.md",
  "docs/skill-reference-redesign.md",
  "docs/maintenance-verification-review.md",
  "skills/ntn-skills/SKILL.md",
  "skills/ntn-skills/references/commands.md",
  "skills/ntn-skills/references/integration.md",
  "skills/notion/ntn-skills-maintain/SKILL.md",
  "skills/notion/ntn-skills-maintain/references/operations.md",
  "skills/notion/ntn-skills-maintain/references/setup.md",
  "skills/notion/ntn-skills-sync/SKILL.md",
  "skills/notion/ntn-skills-sync/references/synchronization.md",
]
const declarations = (await readdir(join(target, "dist/types"), { recursive: true }))
  .filter((file) => file.endsWith(".d.ts"))
  .map((file) => `dist/types/${file}`)
for (const entry of ["sdk", "management"])
  if (!declarations.includes(`dist/types/cli/src/${entry}.d.ts`))
    throw new Error(`Public ${entry} declaration entrypoint is missing.`)
for (const file of declarations) {
  const declaration = await readFile(join(target, file), "utf8")
  const packedDeclaration = await run(["tar", "-xOf", archive, `package/${file}`])
  if (
    declaration !== packedDeclaration ||
    /@notion-skills-cli\/|\/Users\/|\/home\/[^/\s]+\//u.test(declaration)
  )
    throw new Error(`SDK declaration is stale or refers to a private checkout: ${file}`)
}
const expected = new Set([
  "package/package.json",
  "package/dist/ntn-skills.js",
  "package/dist/sdk.js",
  "package/dist/management.js",
  "package/dist/ref.js",
  "package/dist/ref.cjs",
  ...declarations.map((file) => `package/${file}`),
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
  if (
    /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|https:\/\/(?:linear\.app|app\.notion\.com|(?:www\.)?notion\.so)\/)/u.test(
      bundled,
    )
  )
    throw new Error(
      `Public document contains a private workspace path or workspace-only link: ${file}`,
    )
  // Examples describe a Skill's own file tree. Only rendered document links,
  // including nested and reference links, must resolve inside this package.
  const links = documentLinks(SourceLexer.lex(bundled))
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
const smoke = JSON.parse(
  await run(["bun", join(root, "scripts/package-smoke.ts"), "--archive", archive]),
)
const sdkFixture = join(destination, "sdk-fixture")
const sdkConsumer = join(destination, "sdk-consumer")
await run(["node", join(root, "scripts/sdk-fixture.ts"), "--outdir", sdkFixture, "--catalog"])
let sdkFailure: unknown
try {
  await run([
    "node",
    join(root, "scripts/sdk-package-smoke.mjs"),
    "--archive",
    archive,
    "--fixture",
    join(sdkFixture, "fixture.json"),
    "--outdir",
    sdkConsumer,
  ])
} catch (error) {
  sdkFailure = error
}
const sdkReport = join(sdkConsumer, "report.json")
const sdk = await readFile(sdkReport, "utf8")
  .then((value) => JSON.parse(value))
  .catch(() => null)
console.log(
  JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    contract: "current-only",
    archive,
    integrity: `sha512-${createHash("sha512")
      .update(await readFile(archive))
      .digest("base64")}`,
    files: entries.map((file) => file.slice("package/".length)),
    smoke,
    sdk,
    sdk_report: sdkReport,
    sdk_error: sdkFailure === undefined ? undefined : String(sdkFailure),
    scratch: destination,
  }),
)
if (sdkFailure !== undefined) throw sdkFailure
if (
  sdk?.contract !== "current-only" ||
  sdk.selection !== "all" ||
  sdk.failed !== 0 ||
  sdk.passed !== 14 ||
  !sdk.cases.some(
    (entry: { name: string; status: string }) =>
      entry.name === "installed-pure-reference-module" && entry.status === "passed",
  ) ||
  !sdk.cases.some(
    (entry: { name: string; status: string }) =>
      entry.name === "installed-library-selection-is-local-and-fresh" && entry.status === "passed",
  )
)
  throw new Error("The installed current SDK gate did not complete its 14 current contract cases.")
