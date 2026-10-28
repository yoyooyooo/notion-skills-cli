---
name: ntn-skills-maintain
description: Create and edit Notion Skills, Prompts and Routers through ntn-skills. Use for a new page, one complete edit of body/resources/properties, an exact replacement, or a portable import/export. Read a pinned baseline, apply the requested changes once, and resume the original operation if interrupted. Use ntn-skills-sync for ongoing upstream or local-directory synchronization.
compatibility: Requires ntn-skills, Node.js 22.22.3+ within 22.x or 24.20.0+, official Notion CLI ntn with api --notion-version support, and an existing Notion connection with Read, Insert and Update content access.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-maintain
---

# Maintain content in Notion

Use the installed `ntn-skills` CLI within the user's requested scope. Resolve the exact page and database from the task, existing configuration or discovery. Keep human titles and file paths intact. Use `ntn-skills schema COMMAND` or `COMMAND --help` when the installed interface is unclear.

## Create a new item

Prepare `SKILL.md` and its supporting files, then create the authorized page:

```bash
ntn-skills create ./release-review --database library --progress
```

A name collision returns `CREATE_CONFLICT`; select the existing page only if the task calls for editing it. For Prompt/Router portable manifests or storage choices, read [content formats](references/operations.md#content-formats).

## Edit one existing item

Read its current content and keep the returned pinned main ref:

```bash
ntn-skills read CURRENT_PAGE_ID --database library --refresh
```

Use that snapshot for the body and related files. A stable direct Notion edit is current readable content. Old pinned refs keep their original bytes; `--refresh` applies to the current page, not a pinned ref. Follow a supporting relative link from its containing pinned file:

```bash
ntn-skills read guide.md --from PINNED_CONTAINING_FILE_REF
```

Prepare a changes directory containing only added or changed files at their intended relative paths. Include the main file when changing the body. Apply the complete requested edit once:

```bash
ntn-skills apply PINNED_MAIN_REF --input ./changes --remove references/obsolete.md --description 'Updated workflow description' --progress
```

Unspecified files and properties stay unchanged. Deletion requires `--remove`; a full portable export is also accepted as input, without treating omitted files as deletions. Explicit `--name`, `--description`, `--default-context` and Router `--member`/`--clear-members` change the corresponding allowed properties. Frontmatter in an edited file remains authored file content and does not independently rename the Notion page.

Use an existing pinned read rather than selecting a new target by display name. A stale baseline fails before overwrite; reread and merge the intended change. Use `--dry-run` only when a preview is useful for a remaining decision.

## Respect content ownership

Personal/manual and forked content can be edited locally. Tracked body, resources, Name and Description belong to the upstream source. Change that source, or explicitly fork the selected member when the task calls for a personal version. Default Context is an independent organization checkbox. Reading current content does not accept it as an upstream revision or authorize changing ownership.

Use `ntn-skills-sync` for recurring source updates, bindings or conflicts. If unavailable locally, load `ntn-skills ctl builtin read notion/ntn-skills-sync`.

## Finish from the operation result

A completed mutation must report success and `verified: true`, without `dry_run: true`. Report the exact page, changed paths/properties and returned pinned ref. The CLI verifies saved content; routine success does not need a second read/export/hash checklist.

For a partial or unknown result, retain `operation_id` and resume that operation:

```bash
ntn-skills operation resume OPERATION_ID --progress
```

If it remains unresolved, report the affected item and original operation. Preserve receipts and current content. A timeout never justifies a new create. For conflict, storage or deliberate full replacement, consult [operations and recovery](references/operations.md).
