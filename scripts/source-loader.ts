import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"

// Node executes the actual TS sources and official SQLite driver. Only the
// existing explicit text assets need a loader; there is no build or disk cache.
registerHooks({
  load(url, context, nextLoad) {
    if (
      url.startsWith("file:") &&
      context.importAttributes?.type === "text" &&
      fileURLToPath(url).endsWith(".md")
    ) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), "utf8"))};`,
      }
    }
    return nextLoad(url, context)
  },
})
