---
name: ntn-skills-sync
description: Connect a Git source to Notion or an existing Notion item to a local directory, then keep it current with ntn-skills sync run. Use for first synchronization, recurring updates, multiple local copies, tracked/fork ownership, conflicts or interrupted synchronization. Preserve original operations and report each affected item.
compatibility: Requires ntn-skills, Node.js 22.22.3+ within 22.x or 24.20.0+, official ntn and an existing Notion connection; reads need Read content and pushes need Insert/Update content. Local replacement requires supported system Trash retention.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-sync
---

# Synchronize sources, Notion and local directories

Choose the relationship requested by the user. Use exact current page/subscription identities and existing registrations. One-time creation or editing belongs to `ntn-skills-maintain`; reading a remote workflow needs no sync binding.

## Connect a Git source once

```bash
ntn-skills sync upstream connect SOURCE --database library --root skills --name 'Team Skills'
```

The command registers the source and performs its first run. Core defaults and supported source/ref forms are described by `sync upstream connect --help`; use explicit `--ref`, `--root`, `--include` or `--exclude` for a narrower requested scope. Retain the returned subscription ID. Repeating the same connection reuses the relationship and original registration operation.

For recurring updates:

```bash
ntn-skills sync upstream run --target SUBSCRIPTION_ID
```

Repeat `--target` for a selected batch. Use `--all` only when every enabled subscription is in scope. Run resumes original pending work before preparing a new source update. It also restores an owned tracked member whose page is explicitly in Notion Trash, preserving other members and organization metadata. A permission error is not deletion evidence. Forked or source-excluded members are not automatically recreated from the source.

Tracked body/resources/Name/Description follow the source. For personal editing, explicitly fork the selected member through `sync upstream fork`; later source changes must preserve that fork. Direct human edits remain readable and become a synchronization conflict instead of being silently overwritten.

## Connect a local directory once

```bash
ntn-skills sync local connect CURRENT_PAGE_ID --path /absolute/skill-directory --as release-review
```

A missing directory initializes from Notion. Equal contents establish the common baseline. If an existing directory and Notion contain different work, use the user's chosen source with `--from notion` or `--from local`; do not choose from timestamps. The command binds and synchronizes in one operation flow. Repeating the same edge reuses its binding.

For normal ongoing work:

```bash
ntn-skills sync local run release-review
```

Run uses the common baseline to choose a one-sided push or pull, checks pending operations first, and stops on conflicting edits. For several registered directories in scope, use `sync local run --all`. Preserve each copy's independent baseline. Existing local content and unrelated files must not be removed to clear a conflict.

## Inspect only what the task needs

`sync upstream status` and `sync local status` show existing state; `check` obtains a current observation. Neither establishes successful synchronization by itself. Use the returned per-item results and exact refs rather than reading every member automatically.

A verified run is the completion signal. Report created, updated, unchanged, restored, forked, conflicted or unresolved members/bindings. Keep returned operation IDs on interruption. Repeat the ordinary run to use its safe recovery path; if the original result remains unknown, inspect that operation and report the specific blocker. Do not start a second create or remove receipts.

For deliberate direction choices, saved-plan review, batch outcomes or recovery details, read [synchronization decisions](references/synchronization.md). Advanced plan/apply remains available when the task needs to review a frozen change before applying it.
