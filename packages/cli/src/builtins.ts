import { defineBuiltin } from "@notion-skills-cli/core"
import packageManifest from "../package.json" with { type: "json" }
import bootstrap from "../../../skills/ntn-skills/SKILL.md" with { type: "text" }
import commands from "../../../skills/ntn-skills/references/commands.md" with { type: "text" }
import integration from "../../../skills/ntn-skills/references/integration.md" with { type: "text" }
import maintain from "../../../skills/notion/ntn-skills-maintain/SKILL.md" with { type: "text" }
import operations from "../../../skills/notion/ntn-skills-maintain/references/operations.md" with {
  type: "text",
}
import sync from "../../../skills/notion/ntn-skills-sync/SKILL.md" with { type: "text" }
import synchronization from "../../../skills/notion/ntn-skills-sync/references/synchronization.md" with {
  type: "text",
}

const { version } = packageManifest
const encoder = new TextEncoder()
export const builtins = [
  defineBuiltin("notion/ntn-skills", version, [
    { path: "SKILL.md", bytes: encoder.encode(bootstrap) },
    { path: "references/commands.md", bytes: encoder.encode(commands) },
    { path: "references/integration.md", bytes: encoder.encode(integration) },
  ]),
  defineBuiltin("notion/ntn-skills-maintain", version, [
    { path: "SKILL.md", bytes: encoder.encode(maintain) },
    { path: "references/operations.md", bytes: encoder.encode(operations) },
  ]),
  defineBuiltin("notion/ntn-skills-sync", version, [
    { path: "SKILL.md", bytes: encoder.encode(sync) },
    { path: "references/synchronization.md", bytes: encoder.encode(synchronization) },
  ]),
]
