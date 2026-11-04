import { chmod, cp, mkdir } from "node:fs/promises"
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
  // A fresh directory prevents overwriting prior evidence or deleting build products.
  await mkdir(target)
}
for (const [entry, name] of [
  ["main", "ntn-skills"],
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
if (args.length) await cp(new URL("package.json", import.meta.url), join(target, "package.json"))
console.log(`Built CLI, SDK and ${declarations} declaration files in ${target}`)
