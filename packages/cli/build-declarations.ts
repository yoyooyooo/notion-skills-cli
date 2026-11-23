import { mkdir, readdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import ts from "typescript"

/** Emit declarations from the actual schemas, then retain the public SDK, management and reference closures. */
export async function buildDeclarations(root: string, target: string) {
  const outDir = join(target, "dist/types")
  const entries = ["sdk", "management"]
  const program = ts.createProgram(
    entries.map((name) => join(root, `packages/cli/src/${name}.ts`)),
    {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      types: ["bun"],
      noUncheckedIndexedAccess: true,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: join(root, "packages"),
      outDir,
    },
  )
  const emitted = new Map<string, string>()
  const result = program.emit(undefined, (path, text) => emitted.set(path, text))
  const errors = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics]
  // Imported JSON has no declaration output; require the complete reachable closure below.
  if (errors.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: (path) => path,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }),
    )
  const pending = [...entries.map((name) => join(outDir, `cli/src/${name}.d.ts`)), join(outDir, "core/src/skill-ref.d.ts")]
  const declarations = new Map<string, string>()
  while (pending.length) {
    const path = pending.pop()!
    if (declarations.has(path)) continue
    const original = emitted.get(path)
    if (original === undefined) throw new Error(`Missing SDK declaration: ${path}`)
    let text = original
    const imports = ts.preProcessFile(original).importedFiles.toSorted((a, b) => b.pos - a.pos)
    for (const reference of imports) {
      const specifier = reference.fileName
      let replacement: string
      if (specifier === "@notion-skills-cli/core" || specifier === "@notion-skills-cli/markdown") {
        const workspace = specifier.slice("@notion-skills-cli/".length)
        const local = relative(dirname(path), join(outDir, workspace, "src/index.js"))
        replacement = local.startsWith(".") ? local : `./${local}`
      } else if (specifier.startsWith(".") && specifier.endsWith(".ts")) {
        replacement = `${specifier.slice(0, -3)}.js`
      } else continue
      const start = reference.pos + 1
      if (text.slice(start, start + specifier.length) !== specifier)
        throw new Error(`Cannot locate declaration import: ${specifier}`)
      text = text.slice(0, start) + replacement + text.slice(start + specifier.length)
    }
    if (text.includes("@notion-skills-cli/"))
      throw new Error(`Private workspace dependency escaped into SDK declarations: ${path}`)
    for (const dependency of ts.preProcessFile(text).importedFiles) {
      const specifier = dependency.fileName
      if (!specifier.startsWith(".")) continue
      const dependencyPath = resolve(dirname(path), specifier.replace(/\.js$/u, ".d.ts"))
      if (!dependencyPath.startsWith(`${outDir}/`))
        throw new Error(`SDK declaration escapes its package: ${specifier}`)
      pending.push(dependencyPath)
    }
    declarations.set(path, text)
  }
  const current = new Set<string>()
  for (const path of declarations.keys()) {
    let name = relative(outDir, path)
    while (name !== ".") {
      current.add(name)
      name = dirname(name)
    }
  }
  const projected = await readdir(outDir, { recursive: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  })
  const stale = projected.filter((name) => !current.has(name))
  if (stale.length)
    throw new Error(
      `Retired files remain in the generated SDK declarations. Move these paths to system Trash, or build into a fresh --outdir: ${stale.map((name) => join(outDir, name)).join(", ")}`,
    )
  for (const [path, text] of declarations) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
  }
  return declarations.size
}
