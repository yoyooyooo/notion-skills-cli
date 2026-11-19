---
name: ntn-skills-sync
description: Apply or refresh declared Git Source contributions while preserving native content, and manage current Profiles, View defaults and freshness. Use for Source onboarding, refresh, mapping/exclusion changes and library discovery policy.
compatibility: Requires ntn-skills, Node.js 22.22.3+ within 22.x or 24.20.0+, and exact library access. Source management requires Notion Insert and Update; Profiles require Records access.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-sync
---

# Manage current Sources and Profiles

Use one exact library entry and stable Profile ID. Profile rules live on one
current Records page; a local binding stores only that library/Profile selection.
A Profile fingerprint detects an observed conflict. It is not distributed CAS or
a content revision.

```bash
ntn-skills ctl library profile list --entry ENTRY
ntn-skills ctl library profile show PROFILE_ID --entry ENTRY
ntn-skills ctl views --database ENTRY
```

For an authorized new Profile:

```bash
ntn-skills ctl library profile set PROFILE_ID --entry ENTRY --name NAME --enabled true --expect new
```

For replacement, use the exact fingerprint returned by `show` as `--expect`.
Supply the complete desired rule. `--name`, `--enabled` and `--expect` are
required; omitting `--default-view` or `--freshness-json` removes the previous
value. Unchanged rules make no write.

After a response is lost, repeat the same complete intent with `--reconcile`
to inspect current rules without another POST or PATCH. Report current equality,
an unresolved intent and the original request result separately. Do not claim
an unknown request was acknowledged.

## Discovery and freshness

`list --profile PROFILE_ID --database ENTRY` uses a Profile for one invocation.
`profile bind PROFILE_ID --entry ENTRY` changes this machine's default binding;
`profile unbind` removes only that binding. Use `list --default-view` to consult
it. An explicit View takes precedence; bare `list` remains explicit discovery.
Profiles and Views do not grant access or activate Skill bodies.

Inspect inherited freshness with `profile freshness PROFILE_ID --entry ENTRY
--skill STABLE_SKILL_ID`. Explicit read policy wins, followed by the Skill rule,
Profile default and product default. A long read TTL exposes a longer current-edit
visibility delay and does not extend the independent native-body deadline.
[Profile rules](references/synchronization.md#profile-rules) gives the full input.

## Current Source content

Sources owns stable source identity and its current normalized plan. Each
source-backed file declares Source ID, revision, source path, hash, size and mode.
A single Skill can use several Sources alongside native and resource files.
The selected revision is exact; ordinary consumption never advances a branch.

Every supporting file belongs in Files, including Git-only content. Generated
reading bodies and original resources make the current tree readable in Notion;
their existence is separate from successful byte acquisition. An edit to a
generated body does not automatically transfer authority. Native ownership is
explicit and cannot be inferred from whether its bytes match upstream.

Use the complete {version:1,definition,contributions} declaration in
[Source input](references/synchronization.md#a-source-management-request):

```bash
ntn-skills ctl library source apply INPUT_JSON --entry ENTRY --dry-run
ntn-skills ctl library source apply INPUT_JSON --entry ENTRY --operation OPERATION_ID
ntn-skills ctl library source refresh SOURCE_ID --entry ENTRY
```

Supported input is regular Git content from GitHub HTTPS, manual or pinned.
Assign every selected member to explicit stable Skill IDs. Contribution mapping
and exclude select exact member-relative file paths; Selection excludes members.
Mappings preserve retained File identity. Collisions and removal of the sole main
are refused. Native bodies, resources, other Sources and existing Skill metadata
are preserved. Source binaries expose a current original without changing authority.

Resume original INPUT_JSON with --operation OPERATION_ID --resume. The parent
intent freezes the commit and tracks only unfinished target progress. Use original
apply input when pending configuration differs from Notion; refresh cannot infer
it. Completion clears parent/child intents. Equal input is zero semantic writes.
HTTP limits share one invocation; Git subprocess HTTP/wire bytes are unmetered,
though its deadline and file bounds apply. Takeover, restore-follow and Source
disable/removal remain separate work; do not invoke retired routes.

Content inspection and complete local import belong to
`notion/ntn-skills-maintain`. That import selects resource or native authority
and refuses Source-owned targets. Consuming a current workflow needs no local sync
binding. Reading or downloading a script does not authorize executing it.
