# Prepare a registered Source member on first use

An explicitly selected `$skill` in Pi can prepare a registered Git member that
has never been initialized for current consumption. The Broker performs a
separate management request, validates its receipt, invalidates local discovery
and body facts, then calls the ordinary consumption SDK. Model tool calls,
prefetch, catalog discovery and ordinary list/read/use/files calls do not acquire
this authority and perform zero semantic remote writes.

## Discover and select an exact member

```bash
ntn-skills ctl library source members --library LIBRARY_ID --query exact-member
ntn-skills ctl library source members --library LIBRARY_ID --source-id SOURCE_ID
ntn-skills ctl library source members --library LIBRARY_ID --requires-of ROOT_SKILL_ID
```

A `source_member` candidate contains the Library and credential scope, stable
Source ID, member path, expected Skill ID, registration digest and, when known,
accepted Git commit and Source plan revision. A candidate without a physical
Skill page has no synthetic page, locator or consumable ref. Coverage must be
complete before an alias can authorize preparation. Ambiguous identities,
disabled members, changed registration and unavailable metadata fail closed.

The `requires-of` form reads the complete current Requires closure of one exact
physical root. It returns that root and a digest binding its stable identity,
physical page and relationships. A native Router can therefore authorize its
missing Source dependencies without itself pretending to be a Source member.
Members are not part of this closure.

## Materialize through the fixed manager

```bash
ntn-skills ctl library source materialize ./request.json --library LIBRARY_ID
```

The request uses version 1 and contains `library`, a bounded stable `request_id`,
`purpose` (`use` or `inspect`) and the exact discovery `target`. `use` prepares the
root and required dependencies. `inspect` prepares only its root. A request on
behalf of a native root also carries the returned `authorization_root`.
Reusing a request ID with a different input is rejected.

Clients read `source-manager.json` in the CLI configuration directory, or the
explicit `NTN_SKILLS_SOURCE_MANAGER_BINDING` path. A binding pins one Library,
one installation inventory digest and one fixed local executable or SSH
host/remote executable. Business values travel as bounded JSON on stdin, never
as remote shell arguments. A missing or unavailable manager cannot fall back to
local publication. The management SDK is `ntn-skills/management`; it is separate
from `ntn-skills/sdk`.

The designated Mini manager validates its hostname, installed generation,
maintained runtime, Git executable, credential digest, allowed Sources and
canonical recovery Store. It shares the Source writer guard with synchronization,
apply, refresh, lifecycle and file authority changes. The canonical Store is part
of the recovery contract. Replacing it cannot release unfinished remote work.
Existing standalone CLI installations without a manager binding retain their
explicit management commands; a configured client must use its designated writer.

## What Notion retains

Materialization uses the existing Skills, Files, Sources and Records contract.
It retains only current consumption data and unfinished operation state:

- The current Source manifest, accepted Git commit, normalized plan revision and
  exact contribution mappings.
- The exact Skill owner, Main File ID and source-backed main Content binding.
- Existing supporting native/resource bindings, plus any Source-owned resource
  needed to store the current manifest.
- Finite parent/child operation records until exact readback proves completion.

Existing legacy owners keep their stable Skill ID, physical page, Main File ID,
manual enablement and other human metadata. A declared owner that disappeared is
not silently recreated. Conflicting native/resource authority is not overwritten.
Old body projections and archive fields are not consumption authority.

A legacy Git registration with `Status=applied`, empty current Content and no
Operation has a separate initialization state. Its former Last Revision may be
an exact 40-character Git commit. The manager freezes that historical commit,
physical Source page and original field value, and rechecks them before entering
the journaled applying state. It does not interpret that commit as a current plan
hash or let an ordinary consumer treat the legacy row as ready. A changed field,
unsupported revision shape or a different owner blocks preparation.

A legacy Git Source with `Status=applied`, empty Content and empty Operation can
enter this path without a separate migration write. Its exact Source/page identity
and historical Last Revision are frozen into the materialization scope and finite
intent. The historical 40-character Last Revision pins the accepted Git commit;
it is never accepted as a current plan hash or proof of ready Content. Discovery
and preparation verify that commit even if repository HEAD has moved. Unknown
legacy revision formats are rejected. If the historical revision is empty, the
existing selected Skill commit evidence remains the fallback.

The operation kernel admits this legacy initial state only with the frozen
materialization evidence and a fresh exact metadata check. It then follows the
normal Record, applying, Content and ready transitions. Ordinary current parsers
and consumers continue to reject the old applied state.

Let D be discovered members, M the already materialized members and R this
request's selected closure. Preparation produces M' = M union R. It does not
initialize every member of D, retire an unrelated member or enable a disabled
legacy row. Unselected legacy contribution declarations may remain uninitialized.
The Source manifest can include more original files than the materialized set.

The Git commit and Source plan revision are different identities. Growing a
manifest at the same accepted commit changes its plan hash. Every already
materialized owner is rebound to that hash in the same guarded Source operation;
their original byte hashes and modes remain unchanged. The writer independently
rejects a requested scope that omits any already materialized owner.

Materialization always uses `projection: none`. No Source/Skill reading body or
supporting navigation page is generated for this path. Later ordinary consumption
renders the complete selected Skill for the provider from its exact originals.

## Completion, cancellation and retry

Only `ready` or `already_ready` receipts containing the exact physical selected
root can authorize ordinary consumption. Receipts also bind request ID, Library,
consumer credential scope, Source target and any Requires authorization root.
The management SDK authenticates the consumer independently and retains the
manager credential scope as `manager_scope`; different credentials do not become
interchangeable cache identities. The client
invalidates affected discovery, snapshot and body facts before consuming again.
A blocked preflight receipt also retires its exact candidate, even when no remote
write occurred and its affected set is empty. A later explicit selection can then
observe changed registration or commit metadata instead of repeating a stale target.
A new session and an independent empty client can reuse the persisted Notion
consumption facts without another materialization write.

A foreground cancellation detaches its wait; it does not cancel accepted
management work or release the writer guard. Late receipts cannot publish context
into a cancelled or different Pi turn.

An unknown PATCH is not replayed because a GET currently looks equal or because
the original process stopped. The original dispatch must have a terminal ACK or
its operation-specific unique completion witness. The original finite intent and
Store remain until that proof exists. A successor checks every unfinished child
before mutating its parent. Legacy pending records without the dispatch protocol
remain bound to their original implementation and recovery procedure.

## Verification

The source-materialization route in the existing verification Skills requires
controlled HTTP write ledgers, real Git originals, frozen packed CLI/Broker
artifacts and actual Pi processes. It covers legacy owners, a Source with no Skill
row, same-commit manifest growth, native Router Requires, a second process within
five minutes, and an independent empty client Store. Ordinary phases and the
projection path must have zero semantic writes; provider captures must contain
the complete selected main bodies. Formal models and guard mutations live in
the existing current-lifecycle suite. Their finite-state results do not by
themselves establish real HTTP, cancellation or daily installation behavior.
