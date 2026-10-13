import { createHash } from "node:crypto"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
if (
  manifest.name !== "notion-skills-cli" ||
  manifest.version !== source.version ||
  manifest.private
)
  throw new Error("Packed package identity differs from the public CLI manifest.")
if (
  manifest.bin?.["ntn-skills"] !== "dist/ntn-skills.js" ||
  !entries.includes("package/dist/ntn-skills.js")
)
  throw new Error("Packed CLI entrypoint is missing.")
for (const section of ["dependencies", "optionalDependencies", "peerDependencies"])
  for (const [dependency, value] of Object.entries(manifest[section] ?? {}))
    if (typeof value !== "string" || /^(?:catalog|workspace|file|link):/.test(value))
      throw new Error(`Packed ${section} contains a non-public dependency: ${dependency}`)
if (manifest.repository?.url !== "git+https://github.com/yoyooyooo/notion-skills-cli.git")
  throw new Error("Packed repository identity differs.")
const publicFiles = [
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/README.md",
  "docs/protocol.md",
  "docs/host-integration.md",
  "docs/releasing.md",
  "skills/ntn-skills/SKILL.md",
  "skills/ntn-skills/references/commands.md",
  "skills/ntn-skills/references/integration.md",
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
  for (const match of bundled.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1]!
    if (/^(?:[a-z]+:|#)/i.test(href)) continue
    const [relative] = href.split("#")
    const linked = join(dirname(join(root, file)), relative!)
    if (!(await Bun.file(linked).exists()))
      throw new Error(`Broken public document link: ${file} -> ${href}`)
  }
}
const compiled = await run(["tar", "-xOf", archive, "package/dist/ntn-skills.js"])
if (/\/Users\/|\/home\/[^/\s]+\/|\/private\/var\/|[A-Z]:\\Users\\/.test(compiled))
  throw new Error("Compiled package contains a machine-specific home path.")
const smoke = JSON.parse(
  await run(["bun", join(root, "scripts/package-smoke.ts"), "--archive", archive]),
)
console.log(
  JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    archive,
    integrity: `sha512-${createHash("sha512")
      .update(await readFile(archive))
      .digest("base64")}`,
    files: entries.map((entry) => entry.slice("package/".length)),
    smoke,
    scratch: dirname(archive),
  }),
)
