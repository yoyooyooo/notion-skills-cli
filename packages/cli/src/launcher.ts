#!/usr/bin/env node
import { spawn } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { isAbsolute, join } from "node:path"

// The npm bin stays the normal consumer entry. Development is an explicit,
// process-local choice; a bad choice must not silently run another version.
const root = process.env.NTN_SKILLS_DEV_ROOT
if (root === undefined) {
  await import("./main.ts")
} else {
  let runner: string | undefined
  try {
    if (!isAbsolute(root)) throw new Error("Expected an absolute checkout path")
    const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("name" in manifest) ||
      manifest.name !== "notion-skills-cli-monorepo"
    )
      throw new Error("Expected the notion-skills-cli checkout")
    const entry = join(root, "scripts/dev.ts")
    if (!statSync(entry).isFile()) throw new Error("Missing scripts/dev.ts")
    runner = entry
  } catch {
    console.error(
      JSON.stringify({
        ok: false,
        error: {
          code: "INVALID_DEV_ROOT",
          message:
            "NTN_SKILLS_DEV_ROOT must name an absolute notion-skills-cli checkout containing scripts/dev.ts. Unset it to use the npm package.",
        },
      }),
    )
    process.exitCode = 2
  }
  if (runner !== undefined) {
    const child = spawn("bun", ["run", runner, ...process.argv.slice(2)], { stdio: "inherit" })
    const interrupt = () => {
        child.kill("SIGINT")
      },
      terminate = () => {
        child.kill("SIGTERM")
      }
    process.on("SIGINT", interrupt)
    process.on("SIGTERM", terminate)
    child.once("error", () => {
      console.error(
        JSON.stringify({
          ok: false,
          error: {
            code: "DEV_RUNTIME_UNAVAILABLE",
            message: "Unable to start Bun for the explicitly selected checkout.",
          },
        }),
      )
      process.exitCode = 1
    })
    child.once("close", (code, signal) => {
      process.off("SIGINT", interrupt)
      process.off("SIGTERM", terminate)
      process.exitCode =
        code !== null && code >= 0
          ? code
          : signal === "SIGINT"
            ? 130
            : signal === "SIGTERM"
              ? 143
              : 1
    })
  }
}
