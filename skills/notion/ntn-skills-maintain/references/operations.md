# Current content inspection and operations

The current public content surface is `list/read/use/files/export`.
`ctl library` provides `init`, `inspect`, `files` and `profile`.
Use `ntn-skills schema COMMAND...` for a specific parser question.
Content import, replacement, file mutation, Source refresh and cleanup await
the current writer; this reference does not define substitute commands.

## Inspect the exact tree

```sh
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills read PAGE_ID --database ENTRY --refresh --json
ntn-skills files SNAPSHOT_ID
ntn-skills export SNAPSHOT_ID --output NEW_DIRECTORY
```

The index includes the main descriptor, stable File IDs, owner, path, authority,
current state and last-edit observations. It follows complete pagination but
does not read bodies. A successful export acquires every selected byte and
preserves modes. For one file use `read SNAPSHOT_ID --path PATH --output NEW_FILE`.
An arbitrary multiple-path export option is not available.

Name/Description can change without changing content identity. A renamed File
keeps its stable identity but changes its current path. Deleted current rows must
not be resurrected by cache. Missing bytes, inaccessible owners or partial
pagination remain errors; they are not an empty or complete tree.

## Prepare complete input

Retain the main entrypoint and all intended supporting files with safe relative
paths. Keep original text encoding, binary bytes and executable modes where
the selected representation supports them. Identify explicit add/move/delete
and relationship changes; omissions alone are not deletion instructions.

For every file, choose native, Source or resource authority. A native page owns
its current body and exact frontmatter prefix. A Source declaration owns the
exact source revision/path and expected bytes. A resource declaration owns one
current original stored in Records. Generated reading pages are not alternate
authoritative copies.

Main content stays on Skills. Each supporting document has a Files row and
complete reading body; images and binary resources expose originals. A
metadata-only inspection cannot establish that this human reading requirement
has been fulfilled in the actual library.

## Incomplete current work

Skills.Current State is `ready`, `applying` or `attention`. Operation is empty
only for ready. Ordinary readers reject the other states before fetching bodies;
management may inspect them to understand the unfinished scope.

Use a current operation's stable identity, intended content and observed effects
to reconcile only its unfinished work. An unknown CREATE must be located and
deduplicated before another create is considered. Current equality does not
establish an acknowledgement of the original request. Permission failure,
partial pagination and a partial tree cannot be marked complete.

The public general content-recovery command is not available yet. Keep the
specific result and required current action; do not mark a Skill ready by hand,
clear state or fabricate an operation command. No previous page versions,
review chain or content proof records are required.

## Cleanup boundaries

Cleanup needs complete authorized ownership and relationship coverage, including
reverse references. Transfer any unique current bytes before retiring their
carrier. Target inspection does not prove whole-library coverage. An inaccessible
row is not a deletion candidate, and hiding a column is not cleanup.

The public cleanup/census writer is not available yet. Report exactly what was
inspected and what remains. A successful read does not certify that obsolete
tables, fields, pages, attachments or navigation are absent.
