import assert from "node:assert/strict"
import type { SmokeContext } from "./context.ts"

/** Installed-bin surface for the maintenance tree. Live Notion remains the caller's gate. */
export async function checkMaintenanceTree(context: SmokeContext) {
  const schema = await context.run([context.runtime, context.executable, "schema", "apply"])
  assert.match(schema, /"changes"/)
  const help = await context.run([
    context.runtime,
    context.executable,
    "ctl",
    "library",
    "file",
    "undelete",
    "--help",
  ])
  assert.match(help, /tombstone/i)
  assert.match(help, /--dry-run/)
  return {
    schema_apply_declares_changes: true,
    installed_undelete_help: true,
  }
}
