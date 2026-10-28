import { chmod, cp, mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
const root = fileURLToPath(new URL("../../", import.meta.url))
const target = fileURLToPath(new URL("./", import.meta.url))
const result = await Bun.build({
  entrypoints: [new URL("src/main.ts", import.meta.url).pathname],
  outdir: new URL("dist", import.meta.url).pathname,
  naming: "ntn-skills.js",
  target: "node",
  format: "esm",
  external: [
    "effect",
    "effect/*",
    "@effect/platform-node",
    "@effect/platform-node/*",
    "@effect/sql-sqlite-node",
    "@effect/sql-sqlite-node/*",
  ],
})
if (!result.success) throw new AggregateError(result.logs, "Build failed")
await chmod(target + "dist/ntn-skills.js", 0o755)
await mkdir(target + "skills", { recursive: true })
await cp(root + "skills/ntn-skills", target + "skills/ntn-skills", { recursive: true })
await cp(root + "skills/notion", target + "skills/notion", { recursive: true })
await cp(root + "README.md", target + "README.md")
await cp(root + "README.zh-CN.md", target + "README.zh-CN.md")
await cp(root + "LICENSE", target + "LICENSE")
await cp(root + "docs", target + "docs", { recursive: true })
await cp(root + "CONTRIBUTING.md", target + "CONTRIBUTING.md")
await cp(root + "SECURITY.md", target + "SECURITY.md")
await cp(root + "CHANGELOG.md", target + "CHANGELOG.md")
await cp(root + "THIRD_PARTY_NOTICES.md", target + "THIRD_PARTY_NOTICES.md")
console.log(
  "Built packages/cli/dist/ntn-skills.js and packaged bootstrap and optional official Skills.",
)
