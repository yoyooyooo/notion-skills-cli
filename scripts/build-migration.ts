import { chmod, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
const destination = process.argv[2]
if (!destination) throw new Error("Pass an external migration package directory.")
const output = resolve(destination)
await mkdir(output, { recursive: false, mode: 0o700 })
const entries = [
  { source: "migrate.ts", name: "ntn-skills-migrate.js" },
  { source: "operator.ts", name: "ntn-skills-operator.js" },
]
for (const { source, name } of entries) {
  const result = await Bun.build({
    entrypoints: [new URL(`../packages/cli/src/${source}`, import.meta.url).pathname],
    outdir: output,
    naming: name,
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
  if (!result.success) throw new AggregateError(result.logs, "Migration artifact build failed")
  await chmod(resolve(output, name), 0o755)
}
await writeFile(
  resolve(output, "package.json"),
  JSON.stringify(
    {
      name: "ntn-skills-state-migration",
      version: "1.0.0",
      private: true,
      type: "module",
      bin: {
        "ntn-skills-migrate": "ntn-skills-migrate.js",
        "ntn-skills-operator": "ntn-skills-operator.js",
      },
      files: entries.map(({ name }) => name),
      engines: { node: "^22.22.3 || >=24.20.0" },
      dependencies: {
        effect: "4.0.5",
        "@effect/platform-node": "4.0.5",
        "@effect/sql-sqlite-node": "4.0.5",
      },
      license: "MIT",
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
)
console.log(
  JSON.stringify({
    directory: output,
    command: ["npm", "pack", "--json", "--pack-destination", output],
    cwd: output,
  }),
)
