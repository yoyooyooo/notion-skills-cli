---
name: ntn-skills-maintain
description: Create, adopt and edit native Notion Skills, references and metadata; audit complete owned imports and repair exact identities. Preserve original operations and whole-file custom ownership. Source policy, revisions and Profiles use ntn-skills-sync.
compatibility: Requires the installed ntn-skills CLI and Notion access authorized for the requested operation.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-maintain
---

# Maintain Notion content

Use the exact installed CLI and target library supplied by the user or the host. Loading these instructions does not authorize any write or script execution. Names are not unique identities.

## Existing Skill: one complete edit

When the task supplies PAGE, ENTRY and an INPUT directory, use this path directly. Do not search the catalog for the page UUID, inspect package directories, enumerate every command schema, or run a whole-library audit. The CLI reads and validates the complete input directory itself. Read known input files with the host's read tool only when their content is needed.

```bash
ntn-skills read PAGE --database ENTRY --authoring --read-only
ntn-skills apply RETURNED_PIN --database ENTRY --input INPUT --compact
```

Copy RETURNED_PIN from the first result's top-level `ref`. Keep the installed executable prefix and `--database` unchanged. The pin is a whole-Skill authoring baseline; `sr:` handles are session references, not CLI targets. Main and new references go in the **same** input directory and the same apply. Omitted files/properties stay unchanged. Never guess native page IDs, split an ordinary main/reference edit into separate creates, run uploaded scripts or modify other Skills.

Use the two-command path only when the user already authorized submitting this complete input to the exact target. The actual apply validates the whole proposed tree before dispatch; a separate dry-run need not repeat that validation. If the user requests a preview, authorization is missing, or the intended changes remain unclear, run `ntn-skills apply RETURNED_PIN --database ENTRY --input INPUT --dry-run --compact` instead and stop without writing. A preview is not authorization. Do not reread an unchanged baseline. Use the selected command's `--help` only for an actual syntax uncertainty or error, not as a prerequisite.

`--compact` retains status, verified result, operation ID, fixed version, complete file manifest and aggregate costs while omitting the verbose HTTP trace. Exact per-request audits require full output unless the installed integration separately verifies the original ledger with command-output proof v1 and closed stdout hash/length/process evidence. Compact totals alone are not that proof.

## Finish, or preserve the original failure

For ordinary success require exit 0, `ok:true`, `verified:true`, an applied/already-unchanged result and no dry-run. Report the changed paths, preserved files, fixed ref and original operation ID to the user. The CLI already checked the current result: do not perform another export, hash checklist or read solely to repeat its verification. A successful apply still needs your final answer.

The batch is not atomic: a later failure may leave earlier children applied. `partial`, `not_applied`, unknown or an interrupted response are **not** a completed edit. Keep the original operation/input and follow its exact `next.argv`; never repeat a possibly applied write, create a replacement, clear pending state or relabel current equality as an ACK. Read [recovery](references/operations.md#original-operation-recovery) only when a real result requires it. A stale baseline needs a fresh authoring read. `read_again` and observation-required errors retain their original scope; no Git fallback may hide a Notion edit.

## Ownership and other intents

A Notion edit takes over that entire document only; unchanged sibling files continue using the selected fixed Git source. `restore-follow` explicitly releases that file back to the selected source; it never advances upstream. Preserve stable Skill/File IDs and native pages. Main files cannot be moved/deleted. Editing a disabled draft does not enable it. Missing/inaccessible content is not deletion intent.

For a **different** requested task, read only its route before acting:

| Task | Route |
| --- | --- |
| Connect an existing library or set up a new one | [Setup](references/setup.md); configuration changes and creating tables each need authorization |
| Create/adopt, file add/move/delete/undelete, properties, enablement, binary resources or explicit replacement | [Operations](references/operations.md#operation-choices); use the exact target and complete input |
| Reviewed local inventory/import or identity repair | [Inventory and repair](references/operations.md#reviewed-inventory-and-repair); no name-only identity guessing |
| Source admission/selection/policy, Profiles or collection removal | Read `notion/ntn-skills-sync` with the same installed CLI; retain per-document custom ownership |

Do not read these references for a normal successful main-plus-reference edit. Builtin resources are available through `ctl builtin read notion/ntn-skills-maintain --path RELATIVE_PATH`; no repository/cache search is needed.
