import { chmod, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
const destination = process.argv[2]
if (!destination) throw new Error("Pass an external proof-converter package directory.")
const output = resolve(destination)
await mkdir(output, { recursive: false, mode: 0o700 })
const result = await Bun.build({
  entrypoints: [new URL("../packages/proof-converter/src/main.ts", import.meta.url).pathname],
  outdir: output,
  naming: "ntn-skills-proof-convert.js",
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
if (!result.success) throw new AggregateError(result.logs, "Proof converter artifact build failed")
await chmod(resolve(output, "ntn-skills-proof-convert.js"), 0o755)
await writeFile(
  resolve(output, "package.json"),
  JSON.stringify(
    {
      name: "ntn-skills-remote-proof-converter",
      version: "1.0.0",
      private: true,
      type: "module",
      bin: { "ntn-skills-proof-convert": "ntn-skills-proof-convert.js" },
      files: ["ntn-skills-proof-convert.js"],
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
