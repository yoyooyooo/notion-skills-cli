# Current content operations

Use `ntn-skills schema ctl library import` for the installed parser. Current
content consumption is read-only. Import is a complete-tree replacement with
explicit library and stable Skill identity.

## Inspect the complete tree

```sh
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills read PAGE_ID --database ENTRY --refresh --json
ntn-skills files SNAPSHOT_ID
ntn-skills export SNAPSHOT_ID --output NEW_DIRECTORY
```

The first result is metadata-only. It includes main and supporting File IDs,
owners, paths, authority and current state. A successful export acquires all
selected bytes and preserves modes. For one file use
`read SNAPSHOT_ID --path PATH --output NEW_FILE`.
An arbitrary multiple-path export option is not available.

## Import a complete current tree

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --dry-run
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID
```

Inspect removals and authority changes before applying an authorized complete
input. Ordinary directory/ZIP input requires root SKILL.md. Portable v2 uses the
kind's canonical entrypoint and explicitly rejects unsupported relation,
projection and unknown fields. A single selected Markdown file is the only
automatic entrypoint rename.

Use real physical paths. The loader rejects symlinks, unsafe ZIP entries, input
changes during reading, more than 10,000 entries or more than 128 MiB of originals.
One original is limited to 64 MiB. Keep raw bytes and regular executable modes.
Local Markdown references are checked before Notion access. A deleted or moved
target needs matching changes to its inbound links in the complete input.

Default resource import provides full readable text and usable opaque originals.
Unsupported upload types use a deterministic single-original ZIP. Uploads larger
than the direct limit use bounded multipart transport. A source or native file
is not silently replaced merely by editing its generated page.

An import preserves existing Skill identity and stable File IDs for retained
paths. It trashes omitted supporting rows and unreferenced resources after checking
current content. Unspecified enablement, default context and authored relations
remain unchanged. A complete equal input is a zero-write no-op.

## Incomplete current work

Ready requires an empty Operation. Applying and attention identify one unfinished
current intent. Consumers refuse those states before body acquisition.

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --operation OPERATION_ID --resume
```

Resupply the same complete input. A prepared fingerprint does not store missing
input bytes. Unknown CREATE and append are not repeated from absence. Accepted
results continue after exact current observation; an observed partial append can
remain blocked. Do not clear the operation or change ready by hand.

Archive recovery uses the exact physical page even after it leaves active queries.
Completion checks the current tree, publishes ready, then retires the remote intent
and clears local pending. No old body versions, review chain or permanent proofs
are required. Local locks are not cross-machine CAS.

## Cleanup boundaries

Target inspection does not prove whole-library coverage. Whole-library cleanup
needs complete authorized ownership, reverse relations and all pages of inventory.
Transfer uniquely current bytes before retiring their old carrier.

Source refresh, portable relationship application, full census and production data
conversion are not supplied by this import. Report the exact missing capability
instead of invoking retired publication, history, sync or repair commands.
