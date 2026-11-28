# Working on this repository

- Use `next` as the integration line. Develop on a task branch in a pair of
  independent CLI and Broker clones. Preserve other tasks' work and indexes.
- Start with the Broker's [isolated development guide](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md)
  and `node scripts/paired-environment.mjs --help` in that Broker checkout.
  Select an explicit private build for each run. The guide owns the command
  contract; do not maintain a second environment launcher here.
- Do not rebuild a checkout registered as the normal `ntn-skills` command or
  paired with the user's daily Pi. Keep dependency, build, state, cache, scheduler
  and temporary directories task-owned. Do not change global configuration,
  credentials or existing sessions to prepare a test.
- Follow `.cursor/skills/verify-ntn-skills/SKILL.md` and its domain routing.
  Isolated development does not relax formal guards, the clean current-`next`
  delivery gate or the normal-environment requirements of daily checks.
- Keep one current implementation and update affected docs with public changes.
  Stop only owned processes and use the established system-Trash cleanup policy.
