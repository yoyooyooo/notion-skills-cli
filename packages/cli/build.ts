import { chmod, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildDeclarations } from "./build-declarations.ts"
const root = fileURLToPath(new URL("../../", import.meta.url))
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== "--outdir" || !isAbsolute(args[1]!)))
  throw new Error("Usage: bun packages/cli/build.ts [--outdir /new/absolute/package-directory]")
const target =
  args[1] === undefined ? fileURLToPath(new URL("./", import.meta.url)) : resolve(args[1])
if (args.length) {
  if (target === resolve(root) || target.startsWith(root))
    throw new Error("An explicit package output must be outside the checkout.")
  // A fresh directory prevents overwriting existing artifacts or deleting build products.
  await mkdir(target)
}
// A copied projection must not keep files retired from its source tree. Report
// them before building; cleanup belongs to the operator's system Trash policy.
for (const relative of ["docs", "skills/ntn-skills", "skills/notion"]) {
  const current = new Set(await readdir(join(root, relative), { recursive: true }))
  const projected = await readdir(join(target, relative), { recursive: true }).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
      throw error
    },
  )
  const stale = projected.filter((name) => !current.has(name))
  if (stale.length)
    throw new Error(
      `Retired files remain in the generated ${relative} projection. Move these paths to system Trash, or build into a fresh --outdir: ${stale.map((name) => join(target, relative, name)).join(", ")}`,
    )
}
for (const [entry, name] of [
  ["launcher", "ntn-skills"],
  ["sdk", "sdk"],
]) {
  const result = await Bun.build({
    entrypoints: [new URL(`src/${entry}.ts`, import.meta.url).pathname],
    outdir: join(target, "dist"),
    naming: `${name}.js`,
    target: "node",
    format: "esm",
    external: [
      "effect",
      "effect/*",
      "@effect/platform-node",
      "@effect/platform-node/*",
      "@effect/platform-node-shared",
      "@effect/platform-node-shared/*",
      "@effect/sql-sqlite-node",
      "@effect/sql-sqlite-node/*",
    ],
  })
  if (!result.success) throw new AggregateError(result.logs, `Build failed: ${entry}`)
}
const declarations = await buildDeclarations(root, target)
await chmod(join(target, "dist/ntn-skills.js"), 0o755)
await mkdir(join(target, "skills"), { recursive: true })
await cp(join(root, "skills/ntn-skills"), join(target, "skills/ntn-skills"), { recursive: true })
await cp(join(root, "skills/notion"), join(target, "skills/notion"), { recursive: true })
for (const file of [
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
])
  await cp(join(root, file), join(target, file))
await cp(join(root, "docs"), join(target, "docs"), { recursive: true })
if (args.length) {
  const manifest = JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8"))
  delete manifest.devDependencies
  await writeFile(join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
}
console.log(`Built CLI, SDK and ${declarations} declaration files in ${target}`)
