import { join } from "node:path"
import type { SmokeContext } from "./context.ts"

export async function checkCommandContract(context: SmokeContext) {
  const {
    runtime,
    manifest,
    executable,
    consumerBin,
    operatorExecutable,
    operatorBin,
    run,
    check,
    cli,
    rejected,
    evidence,
  } = context
  check(
    (await run([consumerBin, "--version"])).trim() === `ntn-skills v${manifest.version}`,
    "Installed consumer bin cannot launch through its Node.js shebang.",
  )
  check(
    (await run([runtime, executable, "--version"])).trim() === `ntn-skills v${manifest.version}`,
    "CLI version differs from package.",
  )
  const helpCommands = [
    [],
    ["list"],
    ["ctl", "database"],
    ["ctl", "database", "list"],
    ["read"],
    ["files"],
    ["create"],
    ["apply"],
    ["replace"],
    ["export"],
    ["write"],
    ["operation"],
    ["ctl", "config"],
    ["ctl", "config", "show"],
    ["ctl", "config", "set"],
    ["ctl", "config", "unset"],
    ["ctl", "config", "set-token"],
    ["ctl", "config", "clear-token"],
    ["ctl", "builtin"],
    ["ctl", "builtin", "list"],
    ["ctl", "builtin", "read"],
    ["ctl", "builtin", "status"],
    ["ctl", "builtin", "install"],
    ["ctl", "builtin", "update"],
    ["ctl", "builtin", "export"],
    ["ctl", "builtin", "publish"],
    ["ctl", "database", "register"],
    ["ctl", "database", "unregister"],
    ["sync"],
    ["sync", "local", "connect"],
    ["sync", "local", "bind"],
    ["sync", "local", "status"],
    ["sync", "local", "run"],
    ["sync", "local", "plan"],
    ["sync", "local", "apply"],
    ["sync", "upstream", "connect"],
    ["sync", "upstream", "run"],
    ["sync", "upstream", "status"],
    ["sync", "upstream", "check"],
    ["operation", "resume"],
    ["operation", "reconcile"],
    ["sync", "local", "unbind"],
    ["ctl", "cache"],
    ["ctl", "cache", "status"],
    ["ctl", "cache", "clear"],
    ["resolve"],
    ["ctl", "doctor"],
    ["schema"],
  ]
  for (const command of helpCommands)
    check(
      (await run([runtime, executable, ...command, "--help"])).trim().length > 0,
      `Empty help for ${command.join(" ") || "root"}.`,
    )
  evidence.help_commands = helpCommands.map((command) => command.join(" ") || "root")
  const rootSchema = await cli(["schema"])
  check(
    rootSchema.format === "effect-cli-schema" && Array.isArray(rootSchema.schema?.commands),
    "Root schema omitted its command AST.",
  )
  for (const name of ["apply", "ctl", "operation", "replace", "schema", "sync"])
    check(
      rootSchema.schema.commands.some((command: { name: string }) => command.name === name),
      `Root schema omitted ${name}.`,
    )
  check(
    !rootSchema.schema.commands.some((command: { name: string }) => command.name === "upstream"),
    "Root schema retained the obsolete upstream alias.",
  )
  const upstreamCommands = (await cli(["schema", "sync", "upstream"])).schema.commands.map(
    (command: { name: string }) => command.name,
  )
  for (const historical of [
    "publish-files",
    "content-adopt-plan",
    "content-adopt-apply",
    "source-rich-text-repair-plan",
    "source-rich-text-repair-apply",
    "source-rich-text-repair-reconcile",
    "source-rich-text-repair-show",
    "source-root-fidelity-plan",
    "source-root-fidelity-apply",
    "source-root-fidelity-reconcile",
    "source-root-fidelity-show",
    "source-root-completion-plan",
    "source-root-completion-apply",
    "source-root-completion-reconcile",
    "source-root-completion-show",
    "map-checkpoint-adopt-plan",
    "map-checkpoint-adopt-apply",
    "adopt-plan",
    "adopt-apply",
    "prepare-plan",
    "prepare-apply",
    "rebuild",
    "restore-deleted",
  ])
    check(!upstreamCommands.includes(historical), `Daily upstream schema retained ${historical}.`)
  const operationCommands = (await cli(["schema", "operation"])).schema.commands.map(
    (command: { name: string }) => command.name,
  )
  check(
    operationCommands.sort().join(",") === "list,reconcile,resume,show",
    "Daily operation schema retained historical workflows or omitted normal recovery.",
  )
  check(
    (await run([operatorBin, "--version"])).trim() === `ntn-skills-operator v${manifest.version}`,
    "Installed historical operator cannot launch through its Node.js shebang.",
  )
  for (const command of [
    [],
    ["upstream"],
    ["upstream", "adopt-apply"],
    ["operation"],
    ["operation", "body-completion-reconcile"],
  ])
    check(
      (await run([runtime, operatorExecutable, ...command, "--help"])).trim().length > 0,
      `Independent operator omitted offline help for ${command.join(" ") || "root"}.`,
    )
  const operatorInvalid = JSON.parse(
    await run([runtime, operatorExecutable, "upstream", "unknown-command"], 2),
  )
  check(
    operatorInvalid.ok === false &&
      operatorInvalid.error?.code === "INVALID_ARGUMENT" &&
      JSON.stringify(operatorInvalid.next?.argv) ===
        JSON.stringify(["ntn-skills-operator", "upstream", "--help"]),
    "Independent operator did not return actionable parser help.",
  )
  evidence.historical_operator = {
    normal_operation_commands: operationCommands,
    invalid_command: operatorInvalid,
  }
  const upstreamSchema = await cli(["schema", "sync", "upstream", "run"])
  evidence.upstream_schema = upstreamSchema
  check(
    JSON.stringify(upstreamSchema.command) === JSON.stringify(["sync", "upstream", "run"]),
    "Installed upstream schema is not bound to the official sync subtree.",
  )
  for (const command of ["apply", "create", "replace", "update"]) {
    const schema = await cli(["schema", command])
    const names = schema.schema.parameters.map((parameter: { name: string }) => parameter.name)
    check(
      names.includes("member") && names.includes("clear-members"),
      `${command} omitted Members flags.`,
    )
    evidence[`${command}_schema`] = schema
  }
  const exportSchema = await cli(["schema", "export"])
  check(
    exportSchema.schema.parameters.some(
      (parameter: { name: string }) => parameter.name === "projection",
    ),
    "Export omitted its explicit projection contract.",
  )
  evidence.export_schema = exportSchema
  const resumeSchema = await cli(["schema", "operation", "resume"])
  check(
    resumeSchema.schema.parameters.some(
      (parameter: { name: string }) => parameter.name === "new-artifact",
    ),
    "Operation resume omitted explicit new-artifact authorization.",
  )
  evidence.operation_resume_schema = resumeSchema
  const readSchema = await cli(["schema", "read"])
  const parameters = readSchema.schema.parameters as Array<Record<string, unknown>>
  const targetParameter = parameters.find((parameter) => parameter.name === "target")
  check(
    targetParameter?.kind === "argument" &&
      targetParameter.type === "string" &&
      targetParameter.required === true &&
      targetParameter.min_occurrences === 1 &&
      targetParameter.max_occurrences === 1,
    "Read target schema lost its required singleton contract.",
  )
  const offlineParameter = parameters.find((parameter) => parameter.name === "offline")
  check(
    offlineParameter?.kind === "flag" &&
      offlineParameter.type === "boolean" &&
      offlineParameter.min_occurrences === 0 &&
      offlineParameter.max_occurrences === 1 &&
      offlineParameter.default === false,
    "Read offline schema lost its optional boolean contract.",
  )
  const rootHelp = await run([runtime, executable, "--help"])
  for (const name of ["ctl", "operation", "replace", "schema"])
    check(new RegExp(`\\b${name}\\b`).test(rootHelp), `Root help omitted ${name}.`)
  for (const obsolete of [
    "open",
    "import",
    "source",
    "config",
    "builtin",
    "cache",
    "resume",
    "migrate",
    "legacy",
    "v1",
    "upstream",
  ])
    await rejected([obsolete])
  for (const args of [
    ...[
      "set-default",
      "clear-default",
      "set-cache-policy",
      "clear-cache-policy",
      "set-builtin-database",
      "clear-builtin-database",
    ].map((name) => ["ctl", "config", name]),
    ...["add", "registered"].map((name) => ["ctl", "database", name]),
  ])
    await rejected(args)
  for (const args of [
    ["list", "--database=frontend", "--database=ops"],
    ["read", "sample", "--refresh", "--refresh"],
    ["files", "sample", "--offline", "--offline"],
    ["files", "sample", "--refresh", "--offline"],
    ["list", "--max-age", "1"],
    ["list", "--max-age", "9007199254740992d"],
    ["list", "--max-age", "0", "--max-age=1s"],
    ["replace", "missing.md", "--target", "a", "--target=b"],
    ["operation", "resume", "p_fixture", "--progress", "--progress"],
    ["create", "missing.md", "--progress", "--progress"],
    ["ctl", "builtin", "publish", "notion/ntn-skills-maintain", "--progress", "--progress"],
    ["sync", "local", "plan"],
    ["sync", "local", "plan", "binding", "--all"],
    ["sync", "local", "plan", "--all", "--from", "local"],
    ["sync", "local", "apply"],
    ["sync", "local", "apply", "--plan", "p_invalid", "--from", "local"],
    ["ctl", "cache", "clear"],
    ["ctl", "cache", "clear", "sample", "--all"],
    ["ctl", "cache", "clear", "--all", "--database", "smoke"],
    ["ctl", "cache", "clear", "--all", "--all"],
    ["ctl", "config", "set", "cache_policy.read_max_age_ms", "2h"],
    ["ctl", "config", "set", "cache_policy.catalog_max_age_ms", "9007199254740992"],
    ["ctl", "config", "set", "token", "forbidden"],
    ["ctl", "config", "unset", "unknown"],
  ])
    await rejected(args)
  const initialConfig = await cli(["ctl", "config", "show"])
  check(
    initialConfig.config.token_configured === false && !initialConfig.config.token,
    "Configuration is not sanitized.",
  )
}

export async function checkStorageRoots(context: SmokeContext) {
  const { env, cli, check, evidence } = context
  evidence.empty_cache_status = await cli(["ctl", "cache", "status"])
  const roots = (output: unknown, config: string, state: string, cache: string) => {
    check(
      typeof output === "object" &&
        output !== null &&
        "config_directory" in output &&
        output.config_directory === config &&
        "state_directory" in output &&
        output.state_directory === state &&
        "cache_directory" in output &&
        output.cache_directory === cache,
      "CLI selected incorrect config/state/cache roots.",
    )
  }
  roots(
    evidence.empty_cache_status,
    env.NTN_SKILLS_CONFIG_HOME,
    env.NTN_SKILLS_HOME,
    env.NTN_SKILLS_CACHE_HOME,
  )
  const xdgRoots = [
    join(env.XDG_CONFIG_HOME, "ntn-skills"),
    join(env.XDG_STATE_HOME, "ntn-skills"),
    join(env.XDG_CACHE_HOME, "ntn-skills"),
  ] as const
  for (const [key, expected] of [
    ["NTN_SKILLS_CONFIG_HOME", [xdgRoots[0], env.NTN_SKILLS_HOME, env.NTN_SKILLS_CACHE_HOME]],
    ["NTN_SKILLS_HOME", [env.NTN_SKILLS_CONFIG_HOME, xdgRoots[1], env.NTN_SKILLS_CACHE_HOME]],
    ["NTN_SKILLS_CACHE_HOME", [env.NTN_SKILLS_CONFIG_HOME, env.NTN_SKILLS_HOME, xdgRoots[2]]],
  ] as const)
    roots(await cli(["ctl", "cache", "status"], 0, { [key]: undefined }), ...expected)
  evidence.xdg_cache_status = await cli(["ctl", "cache", "status"], 0, {
    NTN_SKILLS_CONFIG_HOME: undefined,
    NTN_SKILLS_HOME: undefined,
    NTN_SKILLS_CACHE_HOME: undefined,
  })
  roots(evidence.xdg_cache_status, ...xdgRoots)
}
