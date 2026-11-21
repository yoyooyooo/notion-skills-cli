---
name: ntn-skills-maintain
description: Create, edit, register and delete Notion-native Skills and supporting files. Also import complete trees, generate reading pages, restore Trash and recover unfinished management work.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-maintain
---

# Maintain the current library

Use the task's executable and library. Reads need Read access; management also
needs Insert and Update. Discover an existing target, then use its exact page ID,
page URL or stable Skill ID. Never write by a fuzzy display title.

## Create or edit a native Skill

Supply the authored content and the intended metadata. The CLI owns registration,
file identities, authority descriptors, relationships and finite operation state;
do not construct those Notion fields or clear pending by hand.

```sh
ntn-skills ctl library skill create INPUT --entry ENTRY --skill-id SKILL_ID
ntn-skills ctl library skill update TARGET --entry ENTRY --input LOCAL_FILE
```

Create accepts a complete local input. Markdown files use editable native bodies;
other files use exact resources. No per-file --native list is needed. Update
without --path selects the main. To change supporting files, supply only the
intended changes; the CLI preserves everything else:

```sh
ntn-skills ctl library skill update TARGET --entry ENTRY --file references/guide.md=./guide.md --remove-file references/old.md
ntn-skills ctl library skill update TARGET --entry ENTRY --name 'New name' --enabled true --default-context false
```

Use --description for discovery text. Repeated --members TARGET or --requires
TARGET replaces that relation set; a single empty string clears it. Omitted
metadata and relationships stay unchanged. Fix links in authored files when
removing their targets. Source-owned changes use notion/ntn-skills-sync.

Native writes verify the complete Notion body for equivalent text, code, links
and structure. Supported formatting normalization is reported; native does not
promise the original Markdown bytes. Resource originals remain byte-exact. After
creation, edit a native body directly in Notion or use update; no projection is
needed for native edits. See [native management](references/operations.md#manage-native-skills).

## Register or remove an existing page

Register an authored page in the current Skills table without replacing its body:

```sh
ntn-skills ctl library skill register PAGE_ID --entry ENTRY
```

Use --skill-id for an explicit identity; provide --name or --description when
valid business metadata is missing. An already valid native registration is unchanged.
Do not move a foreign page into the library or repair conflicting ownership by hand.

```sh
ntn-skills ctl library skill remove TARGET --entry ENTRY --dry-run
ntn-skills ctl library skill remove TARGET --entry ENTRY
```

Removal moves the Skill, its Files and unused owned resources to Trash and clears
typed incoming Members/Requires links in the same library. It preserves the other
Skills and their remaining relationships. Read the actual affected scope;
a preview is not a completed edit. See [removal boundaries](references/operations.md#remove-a-skill).

## Verify and continue

A successful `ready` result or `removed` with `cleanup_verified: true` includes
complete CLI verification. Use the reads below only for requested review or
consumption; they are not routine cleanup.

```sh
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills read PAGE_ID --database ENTRY --refresh --json
```

Use the returned PAGE_ID. Files reads metadata only; export when every supporting
byte is needed. Native reads make zero semantic Notion writes.
CURRENT_SCHEMA_REQUIRED or CURRENT_OPERATION_PENDING never authorizes manual
field repair or bypassing unfinished management.

All four skill actions support --dry-run and invocation budgets. Repeat the same
command with the same intent after interruption. Preserve input, local state and
credential scope; conflicting edits and unresolved writes must remain visible.
See [unfinished work](references/operations.md#incomplete-current-work) for
operation inspection and complete-import resume or supersede.

## Other management

Use complete import only for an intentional full-tree replacement. Omitted
Notion-owned files are removed, including later edits absent from that input:

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --dry-run
```

Import defaults to resource originals; repeated --native PATH selects editable
Markdown. See [complete import](references/operations.md#import-a-complete-current-tree).
Generate Source/resource reading pages, or restore a completed trashed Skill:

```sh
ntn-skills ctl library projection PAGE_ID --entry ENTRY
ntn-skills ctl library projection PAGE_ID --restore --entry ENTRY
```

See [projection and recovery](references/operations.md#generate-notion-text) for
filters and exact-page restore limits. Generated bodies never transfer authority.
Use [setup](references/setup.md) for a library and notion/ntn-skills-sync for
Source apply/refresh, takeover, lifecycle or Profile/View rules.
Read a package reference with `ctl builtin read notion/ntn-skills-maintain --path
RELATIVE_PATH`; do not search private cache directories for instructions.
