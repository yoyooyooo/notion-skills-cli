# Resource lifecycle design and verification plan

Status: proposed extensions, with existing safeguards explicitly identified. The [protocol](protocol.md) continues to own implemented CLI semantics. This plan does not announce an implemented updater, audit command, server, background job or remote change.

## Intended user workflow

A library owns Skill metadata, fixed source selections and whole-file ownership. Most upstream Skills remain unchanged. Users read document projections in Notion, explicitly adopt or directly edit selected files, and consume the composed result through the same CLI/SDK. Non-document resources retain exact bytes rather than being forced into editable Markdown.

A source update checks one configured repository/ref, resolves one immutable revision, and prepares all affected bound Skills using that acquisition. Unchanged files reuse exact objects. Existing Notion-owned files remain authoritative. An update may expose a candidate, await approval, or apply under an explicit source policy. It does not import new upstream members into default discovery or rewrite Members/Requires implicitly.

An independent auditor observes what actually exists, including partially deleted and inaccessible objects. It reports defects and uncertainty without adopting content, selecting versions, repairing data or collecting garbage. It can pause at a budget boundary and resume without starting again. Dagu or another scheduler invokes these commands; the CLI does not require a daemon.

## Ownership and independent state

Keep the current four-table ownership: Sources owns editable acquisition configuration; Skills owns identity, the selected fixed version and relationships; Files owns logical file binding and the editable projection; Records retains immutable ownership facts, original operations and required historical references.

Do not collapse these facts into one `synced` flag:

| Fact | Meaning | Changes when |
| --- | --- | --- |
| Source candidate | Latest revision observed by a particular check | A successful source observation identifies it |
| Selected source version | Base tree actually selected for new consumption | A verified original selection operation finishes |
| Presented revision | Revision currently represented by a Notion reading page | That projection has been written and verified |
| Projection baseline | Exact normalized observed page content and conversion version | A corresponding projection is established |
| File ownership | Following, custom, tombstone, or unresolved facts | An explicit validated ownership transition is retained |
| Custom baseline | Presentation the author edited or deliberately adopted | Adoption records the observed version and bytes |
| Session pin | Complete content identities selected for an active consumer | A new selection or explicit refresh, never background source movement |
| Audit observation | Scope, rules, observed versions, coverage and findings | An audit completes a stated portion of its work |

Source revision identity, transport location and content owner are separate. Reading an equivalent cached object does not change its owner. A page URL or signed download location is not a fixed version. A reused hash does not grant present permission.

The effective tree combines the fixed source manifest, deterministic mounts, whole-file Notion overrides and tombstones. The consumer validates collisions and required references before presenting an applicable snapshot. Exact binary bytes, source projection bytes and generated consumer Markdown have distinct conversion contracts; formatting a Notion page must not silently redefine a script or image.

## High-risk boundaries to verify first

| Boundary | Property | Verification method |
| --- | --- | --- |
| Editable page versus source updater | A human edit cannot be lost through a read-check-write race | ProjectionRace TLA+ model, real helper mutation test, future actual-provider interleaving test |
| Candidate versus selected version | Selection cannot expose a tree lacking a required resource | UpdateCommit model; implementation tests for manifest, hash, acquisition and write ordering |
| Unknown mutation outcome | No blind second dispatch or invented success | UpdateCommit model; existing guarded operation and fault-injection tests |
| Background update versus active session | An old exact pin never silently reads the new version | UpdateCommit model; installed CLI/SDK/Broker tests |
| Audit versus content ownership | Observation produces findings without semantic remote writes | AuditRun model; read-only capability injection; existing observer negative test |
| Roots versus orphan resources | Complete coverage requires forward and reverse inventory | AuditRun model; full-pagination and deleted-root fixtures |
| Pause versus resume | Verified progress and exact object identity survive restart | AuditRun model with safety/liveness controls; checkpoint crash tests |
| Scope versus destructive cleanup | Inaccessible is not deleted; retained history is not garbage | Capability/identity tests first; a separate reachability model before any future remote GC |
| Request/context economy | Same work is not fetched or injected again unnecessarily | Actual CLI/SDK request ledgers, provider payloads and cache growth tests; not inferred from the small models |

These boundaries justify formal modeling because harmful outcomes depend on event order, interrupted writes and combinations of states. CLI text formatting, pagination response parsing, API conversion fidelity, actual network latency and memory/disk usage need direct tests and measurements, not another symbolic diagram.

## Projection update is the first design gate

The current `requireSafeBodyReplacement` helper refuses unconditional replacement of an existing editable page. `resolveFileState` rejects a source projection that silently releases customization or a deletion. The automatic observer compares complete content to the saved projection, not to a newer upstream revision. These safeguards remain in place.

The rejected proposal is: read unchanged page, authorize a later unconditional write, replace it, then read back success. A human can edit after the read or authorization. The later readback can see the system's successful replacement while the user's intervening bytes are already lost. ProjectionRace deliberately admits that sequence only in its broken configuration.

This model is not a claim that every current Markdown writer sends an unconditional replace. Existing authoring uses its own frozen intent, old-string matching, retained preimage, follow-up verification and unresolved outcomes. Those behaviors still require their own provider contract tests. A local preflight check alone is not service-side revision compare-and-swap.

Compare the alternatives before implementing automatic projection refresh:

1. **Unconditional replacement after a read.** Reject. Repeating the read or adding a periodic audit narrows a race window but does not remove it.
2. **An actual edit-exclusion or provider-conditional boundary.** Candidate for automation only after its guarantee is established end to end. A Notion checkbox, `Running` row, advisory UI lock, Dagu single writer or takeover-request field does not exclude the human editor by itself.
3. **Automatic checking/preparation with explicit guarded application.** Preserve as the honest first deployable behavior wherever strong automatic replacement protection is unavailable. Mark pending presentation versions rather than claiming automatic convergence.

Fresh immutable projection pages are another possible design, but are not selected here. Their old page may still receive edits; predecessor identity, late-edit preservation, navigation, history lifetime and a unique current body must be modeled before they can replace the current design.

The UI must distinguish a takeover request from completed takeover. Once custom, the file remains custom even if the author later types text identical to upstream. Editing an old presentation is legitimate: record the actual custom baseline and show the newer candidate separately. Restore-follow is explicit and targets the selected fixed version, retaining the custom bytes according to policy.

## Source update protocol

The proposed orchestration is `check -> prepare -> validate -> apply original operation -> reconcile if unknown -> publish result`. It applies to a selected Source or one exact bound Skill. A source-level run resolves one upstream revision and reuses that immutable acquisition for all affected members.

Before a mutation, freeze the source configuration fingerprint, member mapping, current selected identity, ownership facts and complete resulting resource manifest. Retain or establish retrievable exact identities required by the selected storage contract. This does not mean every public Git object must be copied into Notion Records. Custom bytes and recovery-critical data still need durable retention.

Original operation state must distinguish:

- Never dispatched or proven not sent.
- Dispatched with verified original outcome.
- Dispatched with unknown outcome.
- Current selection visible but no original outcome established.

Only the matching original facts can close unknown execution. A newer source ref, today's readable page or a successful HTTP response from a different operation cannot manufacture the missing outcome. Within its bounded model, UpdateCommit checks one original selection dispatch; it does not claim global exactly-once execution for all API writes.

Per-Skill commits and source-run summaries are separate. A partially successful repository update reports each member and does not claim the entire library changed atomically. Dependent Skills that must move together need a separate group-level contract. New members, removed members, source path moves and dependency changes enter explicit review rather than inferred identity replacement.

Notion presentation refresh and content selection may involve multiple requests. The implementation must define visible intermediate states and what consumers do while a projection operation is unresolved. No current consumer should mistake a system-authored intermediate projection for a spontaneous human edit. Source update success, presentation success and report-delivery success are independent outcomes.

## Read-only audit protocol

The auditor first fixes its library/schema and access scope, then inventories lightweight identities. It processes Skill roots sequentially and reuses already verified dependencies. A separate reverse scan covers Files, selected Records headers and retained operation references that surviving roots no longer reach.

Normal catalog parsing may reject corrupt rows; audit inventory must preserve their physical IDs and report malformed identity without dropping the whole table. Disabled Skills and objects excluded from a default View remain within an explicitly selected full-library audit. Metadata-only coverage cannot claim binary contents or all historical recovery verified.

The strict audit capability must expose queries and reads without semantic mutations. Notion query endpoints use HTTP POST, so method alone is not a safe read/write classifier. The current auto-adopting read path is unsuitable as an auditor. Its `readOnly` observer rejects unconfirmed content, but the new orchestration must also avoid incidental recovery writes and hidden helpers outside that narrow path. An unconfirmed body produces a finding; a separate authorized command may adopt it.

The report carries execution status, coverage and findings independently. `No findings in the inspected subset` is not `The library is healthy`. A 404 or a missing relation target is an unresolved availability result until evidence distinguishes permissions from deletion. An unlinked object can still be retained by a pin, prior custom version or unknown operation. No finding authorizes deletion.

Each durable checkpoint binds scope, rule version, inventory progress, exact object identities, versions observed, completed tasks, findings and remaining work. It cannot be just an offset in a changing list. Resuming reuses valid work and requeues changed objects; one defective root must not starve later roots. Global authentication/schema failure may pause the run. Interrupted single-large-Skill work needs a subtask checkpoint as well as the outer queue.

AuditRun abstracts a reverse inventory as one step and budgets Skill slices, not HTTP requests. Production implementation must account for physical attempts, payload bytes, retries, queue time and wall time, including a single large object. Periodic metadata censuses remain necessary even when incremental checks prioritize changed files. A run reports an observation interval, not an atomic global database snapshot.

Repeated findings have stable keys and update their status. Keep a current summary and a bounded run history, not an ever-growing evidence object per successful check. Notifications and optional Notion summary publication consume the report through a separate write operation, preventing a report from triggering its own content-audit loop.

## Consumption and storage constraints

The ordinary consumer keeps one public identity/ref contract regardless of Git, HTTP, Notion or retained bytes. Prefer validated local immutable objects, fetch only necessary missing resources and reuse source discovery across siblings. Do not choose Git over Notion solely because it is assumed faster. Compare cold/warm/expired reads at equal versions and completeness; include metadata, body transfer, retries and actual provider context.

Automatic content updates do not advance an existing graph/session pin. Source config, permissions, object identity, conversion policy and current freshness remain explicit. A missing old object does not authorize fetching latest. A cache hit does not prove remote recoverability. Binary resource acquisition does not authorize script execution, dependency installation or filesystem access outside the declared scope.

Before extending arbitrary URL adapters, define a fixed output manifest, transform version, origin/credential policy, archive expansion limits, path/symlink rules and content identity. URL pattern matching alone is insufficient. Remote garbage collection and multi-writer leader failover are deferred until their invariants have dedicated models.

## Delivery order and acceptance gates

| Step | Deliverable | Gate before proceeding |
| --- | --- | --- |
| 1 | Domain states and capability boundaries: selected/presented/custom/session versions, readonly audit provider, update outcome variants | Existing safeguards stay tested; no derived status field grants write authority; projection protection choice is documented |
| 2 | Unified audit core: single target, full reverse inventory, structured findings and honest coverage | Missing/permission/corrupt/duplicate/history fixtures; no semantic Notion mutations; failures isolated per object |
| 3 | Budgeted audit run/resume and stable report reader | Restart after each checkpoint boundary; no progress reset, skipped identity or false full completion; bounded report history |
| 4 | Source-level candidate/update orchestration and visible projection status | One source acquisition reused; exact selected commit; custom preservation; original unknown-outcome recovery; partial member results |
| 5 | Fixed-source consumption and install/host integration | Old pins stable; Git/direct/Notion mixed resources identical to declared manifest; cache and minimum-complete context measured across CLI/SDK/normal Pi |
| 6 | Dagu adapter and optional report publication | Scheduler only triggers CLI; no cross-machine lock fiction; explicit writer assignment, overlap policy and summarized failure notification |

Steps 2 and 4 can share completed core work but should not duplicate ownership or discovery algorithms. Automatic projection writes remain gated by step 1 even when scheduling and source acquisition are ready. Actual recovery/deletion commands remain separate from readonly audit. No daemon manager is required for these steps.

## Formal results and their limits

Use the [model README](../verification/models/resource-lifecycle/README.md), [coverage record](../verification/models/resource-lifecycle/coverage.json) and [project verification Skill](../.cursor/skills/verify-notion-resource-lifecycle/SKILL.md). Source hashes must match the recorded reviewed commit or be re-reviewed before the checks run.

The checker explores finite state spaces and independently falsifies broken guards. ProjectionRace includes one user edit and one update attempt. UpdateCommit includes two resources, two source revisions, one write and one old session. AuditRun includes two roots, an orphan, one changed body, a one-Skill slice and up to two resumptions. Its fairness property says the supplied resumptions suffice for the healthy bounded worklist; reset-on-resume consumes both without finishing. It is not an unbounded fairness or scheduler-uptime proof.

The real source mutation exercise proves three specific tests detect removed guards and pass again after restoring exact original bytes. It is not a live Notion data-loss reproduction. Planned auditor/updater states must later be mapped to actual implementation transitions before claims are expanded.

Raw TLC logs, failed first attempts, temporary binaries, private IDs, measured timings and actual run counts remain outside the repository. Keep this durable design, the executable models and their maintained verification recipe in the source tree.
