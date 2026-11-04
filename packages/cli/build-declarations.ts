import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import ts from "typescript"

/** Emit declarations from the actual schemas, then retain the SDK's declaration closure. */
export async function buildDeclarations(root: string, target: string) {
  const outDir = join(target, "dist/types")
  const program = ts.createProgram([join(root, "packages/cli/src/sdk.ts")], {
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
  })
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
  const pending = [join(outDir, "cli/src/sdk.d.ts")]
  const written = new Set<string>()
  while (pending.length) {
    const path = pending.pop()!
    if (written.has(path)) continue
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
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
    written.add(path)
  }
  return written.size
}
