# Skill reference contract

This is the implementation contract for the single-track reference redesign.
It supersedes the former `shared_skill:<library>:<skill>` identity encoding.

## Authoring and identity

- Use `skill://architect` for a Skill and its declared entrypoint when read.
- Use `skill://architect/references/design.md` for an exact file path.
- Add `?library=<logical-library-id>` for an independently scoped reference.
- The authority is a stable Skill ID, never a display name, alias or page ID.
- A document's contextual reference inherits that document's Library. Only a
  tool entry without a containing document can use the Library bound at entry.
- Missing, conflicting or duplicate identities fail. Do not search other
  Libraries, fall back to names, or infer identity from cache layout.
- A physical Notion page address remains an explicit adapter input. It is not
  another interpretation of a `skill://` authority.
- New Skill IDs use lowercase ASCII letters, digits, period, underscore and
  hyphen, start with a letter or digit, and have at most 200 characters. They
  remain stable. Authors must not reassign an ID to a different Skill after deletion;
  the current product does not provide a permanent global tombstone registry.
  Never lowercase existing
  identities without checking collisions and an explicit migration mapping.
- Library IDs retain their existing bounded identity grammar. A Library alias
  in local configuration is not a portable Library ID.

The complete Skill key is `{ libraryId, skillId }`. Public `ContentRecord.id`
is its canonical, current root URI, such as
`skill://architect?library=library-test`. `locator.type: "shared_skill"` remains
the Notion adapter discriminator; it is not an identity string prefix.

The descriptor's `library_id` is a logical identity for the four-table Library.
`ctl library init` creates it; `ctl library inspect --library LIBRARY_ID` returns it from the
exact Skills database ID. Consumption's `--library` may use a configured alias
to select a database. Neither an alias nor a database ID becomes the portable
Library ID. Test and production Libraries should
have different Library IDs, including when their stable Skill IDs overlap.

### Reference spelling

| Spelling | Resolution |
| --- | --- |
| `skill://architect` | Containing Library, stable ID, declared entrypoint |
| `skill://architect/references/design.md` | Containing Library and exact file path |
| `skill://architect?library=library-team` | Explicit owner and current entrypoint |
| `skill://architect/references/design.md?library=library-team&snapshot=s_<64-hex-digits>` | Explicit owner, immutable selected manifest and exact path |

The final row illustrates a tool-produced pin, not a literal runnable example.
Encode path segments and query values separately. Paths use POSIX separators;
encoded slashes cannot create a segment boundary. Unknown, repeated or empty
parameters and fragments fail. Only `library` and `snapshot` are accepted.
A short reference at a CLI entry needs `--library LIBRARY_ID` or a configured
`default_library`. A fully scoped reference does not inherit that default.
An explicitly supplied incompatible database is a `LIBRARY_SCOPE_MISMATCH` for
logical refs, including cached current reads, fixed selections and resource
batches. Cache availability does not change that error contract. Physical page
inputs retain their separate database-containment check.

For authored content, use ordinary relative paths within one Skill and
`skill://architect` between Skills. A selected Source may retain an existing cross-root
repository link when its original path/revision and contribution mapping prove
the target. Do not rely on that exception for portable native documents.

## Selected content

Tools emit complete refs with `library` and, for a fixed selection, `snapshot`.
There is no public `file_id` query parameter. A fixed path must exist uniquely
in the immutable selected manifest. A pathless fixed ref uses that manifest's
entrypoint, never current metadata. The manifest supplies either a native File
binding or a frozen Source acquisition route with the expected byte identity.
Source files need not have a projected Notion File row.

Missing manifests, paths or verifiable selected bytes fail without a current
fallback. A former path cannot be repaired using a URI File ID. Cross-Skill
references select the target's own snapshot. Selection does not grant access;
existing source, session, graph, request and delivery guards remain required.

## Relative paths and import

Owner-local paths resolve from the actual containing file. Source-relative
links use the selected Source revision and original repository path before
mounts or renames. Missing, excluded or ambiguous Source targets cannot fall
back to cache adjacency or coincidental owner-local paths.

Local batch import has an explicit input manifest: roots, stable Skill IDs and
one target Library. Build and freeze exact file-to-owner mappings before any
write. Do not discover siblings implicitly. Convert only proven links in a
derived copy. Support cyclic Members by separating object creation from final
relationship application. Preserve frozen input and intended relationship
selection across retries and unknown outcomes. Never replay an unknown CREATE
merely because a current lookup is empty.

Cross-Library copying preserves a portable document's declared origin. When its
validated `relations.library_id` differs from the destination, single import,
batch import and `members-plan` first qualify active short Skill refs with that
original Library. An external current ref and a fixed ref therefore keep their
original owner even when the destination has the same Skill ID. The importer
does not access that external Library to infer Members. Plain local input with
no declared origin keeps destination context for its short refs.

`--rebind-from ORIGIN_LIBRARY_ID` on `import-batch` opts into exact rewriting for
the batch's declared identities and admitted paths. It rewrites current body
refs and relation refs only when the old owner has an exact destination mapping.
Unmatched external body refs remain external. Fixed body refs keep both the old
owner and pin; a destination current tree cannot impersonate that old selection.
Without this option, explicit external owners are preserved. Foreign relations
still fail because Members and Requires belong to one Library.
The same rule applies to short refs qualified from a portable origin: only the
authorized exact batch mapping can rebind their current owner. Missing target
paths and fixed selections stay in the origin. Omitted fields and explicit empty
sets keep their meaning; a Library marker without foreign relation targets does
not forbid copying. Dry-run and the frozen import plan report the derived body
rewrites. Original files stay unchanged. If an active short link cannot safely
be rewritten, such as a reference definition also used by an image, import
rejects it before writing. Qualify that link explicitly in the source first.
Code, comments and image-only mentions remain inert.

Batch import is not an atomic transaction across Skills. A ready body can become
visible before the final relation phase. Only a complete batch result establishes
that all final sets were applied. Retry with the same operation and unchanged
manifest, files and author options. The plan stores exact frozen input bytes;
request/byte/time budgets may be adjusted for a retry without changing intent.
If a started write has no verifiable completion or pending record, report
`CURRENT_IMPORT_PHASE_UNRESOLVED`; do not retry creation under a new operation ID.
See [the batch procedure](shared-authoring.md#import-an-explicit-local-batch).

## Members and Requires

Relations use current root Skill refs and bind to complete identities before
deduplication. They have neither a file path nor a snapshot. Relations remain
within the target Library. Explicit foreign relations fail before writes.

Members are discoverable optional members, not execution authorization. On
first creation only, omitted Members can be inferred from exact active links.
Explicit empty/set selections win; omission on update preserves authored
Members. Requires are always explicit. Code, comments, images, templates and
name mentions do not authorize inferred relationships. Exact links establish
target identity, not arbitrary natural-language author intent.

## Shared implementation

One pure protocol module in CLI Core owns parsing, encoding, key equality and
path normalization. Publish it through `ntn-skills/ref` with
`SKILL_REF_VERSION = 2`. Both SDK and the pure module expose that version.
Broker copies the exact selected package's CJS artifact beside its bundled SDK,
records its hash, and loads that module synchronously. There is no fallback to a
global package or a second parser. Source tests prepare the actual selected
artifact in their own run directories. The installed-package and formal lanes
select the same paired CLI package.

The pure module exposes `SkillKey`, `ParsedSkillRef`, `BoundSkillRef`,
`createSkillKey`, `parseSkillRef`, `bindSkillRef`, `formatSkillRef`,
`formatSkillIdentity`, `parseSkillIdentity`, `sameSkillKey`,
`normalizeSkillPath`, `skillRefPath` and `skillRefSnapshot`. Parsed refs model
contextual/exact scope and current/fixed selection explicitly. Core's existing
error boundary can translate protocol errors without reimplementing parsing.

## Cutover from the old protocol

Update the CLI and paired Broker together. The runtime accepts this one protocol;
it does not retry old `shared_skill:` strings, encoded legacy authorities,
name/alias refs or `file_id` queries. Translate old authored refs only from a
verified Library/Skill/path mapping and check collisions before writing. Do not
replace strings by matching display names or assume that a File ID's former hint
is its selected path. `members-plan` and `import-batch` handle explicitly admitted
current inputs, not a blanket migration of old persisted sessions.

Old selected manifests and Broker sessions need an explicit cutover. Preserve
unfinished authoring state and original content. Do not erase the application
state to make a reader pass. Resume/reconcile old pending management operations
with their matching version before switching, and acquire fresh selections in a
private current-format state root. Disposable observations are distinct from
durable authoring plans and content. This change does not automatically rewrite
the user's existing Notion libraries or running sessions.

## Verification ownership

Extend the current verification routes and formal runner. Model reference
binding/selection separately from import relations/recovery. Include overlapping
Libraries, ambient-default changes, name distractors, foreign or missing
manifests, live entrypoint changes, missing Source mappings, explicit empty
Members, manual edits and accepted-but-response-lost writes.

Every negative model has an exact expected broken rule. Replay relevant paths
against actual Core/CLI/Broker guards, with baseline/mutant/restored outcomes.
Do not count parser errors, missing fixtures or timeouts as killed mutations.
Record finite bounds and concrete obligations. Preserve first failures.

Ordinary source tests, controlled HTTP, packed CLI/SDK/Broker, live Notion and
real-model/daily checks remain separate evidence. Do not weaken the current
`next` gate. Update affected README, public commands, bundled Skills, authoring
guides and protocol docs together. Remove legacy runtime branches after callers
are migrated; old input conversion belongs in a separate migration operation.
