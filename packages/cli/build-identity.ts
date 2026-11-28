import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
export const cliBuildInputs = [
  "packages/portable-converter/src",
  "packages/portable-converter/package.json",
  "packages/markdown/src",
  "packages/markdown/package.json",
  "packages/core/src",
  "packages/core/package.json",
  "packages/cli/src",
  "packages/cli/package.json",
  "packages/cli/build.ts",
  "packages/cli/build-declarations.ts",
  "packages/cli/build-identity.ts",
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "docs",
  "skills",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
]
export async function buildInventory(root: string, names: readonly string[]) {
  const files: Array<{ path: string; sha256: string }> = []
  async function walk(name: string): Promise<void> {
    const path = join(root, name)
    const entry = await stat(path)
    if (entry.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await walk(`${name}/${child}`)
    } else {
      if (!entry.isFile()) throw new Error(`Build inputs must be ordinary files: ${name}`)
      files.push({ path: name, sha256: hash(await readFile(path)) })
    }
  }
  for (const name of names) await walk(name)
  files.sort((a, b) => a.path.localeCompare(b.path, "en"))
  return { sha256: hash(JSON.stringify(files)), files }
}
