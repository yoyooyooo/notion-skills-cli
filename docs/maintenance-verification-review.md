# Progressive maintenance: implementation and model correspondence

AH-1024 extends the existing authorship, audit and original-operation owners. The prior baseline is `6c38e747a9e40186fdf9d4ecda033eb5b413561c`. This review records actual boundaries; execution results belong to a frozen run, not to this text or a refreshed source hash.

## Audit scope

`readReachableAudit` observes the selected page before relation-filtered Files and Records headers. Its callback retains already observed identity failures when the invocation exhausts its budget. A target run never marks an unfiltered table complete. `auditReachableReady` requires the owned observations; `auditReport` checks initial and final coverage. A full-library run still scans all tables independently and can find lost relations.

`AuditScope` abstracts four kinds of owner facts, a target/library choice, a bounded budget and one resumption. Scope immutability, read-only capability and checkpoint monotonicity map to the original scheduler, transport and stored run. Concrete HTTP counts, pagination, dependencies and permissions require implementation tests. Installed target checks compare zero and 120 unrelated rows from an independent actual-HTTP ledger; a three-request pause preserves an already observed root error.

V3 checkpoints cannot resume historical rules. Growth is descriptive: tombstones retain owner and File ID; operation and object headers use different denominators; equal header hashes do not prove equal bodies; private pins remain unobserved. No diagnostic grants cleanup or repair authority.

## Complete intent and ordered effects

`shared-skill-apply-tree.ts` classifies explicit moves/removes/revivals and exact reference spans. Omitted files remain in the final tree. The v2 parent retains its verified baseline, child candidates, ordered stages and full target manifest. `loadSharedApplyReferenceTree` reconstructs actual bytes from baseline objects and child candidates. A hash string is never a file body.

`authenticateApplyParent` requires the retained parent, exact child and every preceding applied child outcome. `continueSharedSkillApply` preserves verified effects and stops on unknown results. Explicit `resumeSharedSkillApply` requires the original local parent journal, verified prefix and genuinely undispatched suffix; remote query absence cannot create missing dispatch authority. A different Store may inspect shared historical completion but cannot invent a missing local journal.

`MaintenanceApply` models three ordered children. Dispatch, provider application, received acknowledgement, verified retained outcome and parent progress are separate. The acknowledgement variable records historical response receipt, not a claim that every child family writes a separate ACK row. Native allocation uses the durable source dispatcher. Body writes publish an applied outcome only after the exact response, body and ownership event verify. Parent recovery relies on original outcomes, never current equality.

The current-snapshot barrier rejects pending trees. Existing pins retain selected bytes and still obey current permission checks. Delete records a tombstone and retains the page/body. Explicit undelete restores the same File ID and exact retained bytes; it is not source-follow restoration.

These finite models do not promise atomic Notion transactions, compare-and-swap, arbitrary plan length, eventual unknown resolution or every native subrequest interleaving. Actual bytes, source changes, reference parsing, lost responses, row growth and package installation need separate concrete evidence.

## Same-execution lifecycle event verification

The correspondence review at `dafa00d5d781dcc44071a0092001e01ae829dfb6`
compares the protected source with `d5159127d0ca927a5f3540b79423ec9b11bc98ea`.
The only changed protected implementation and test are the file-management event
verification and its HTTP regression in `ff5f17a3f3b523afb4ebbe26a13d35a763ca3891`.
The remaining protected source bytes match the earlier correspondence.

For a move, `executeSharedFileManagement` still requires the original Path PATCH
response and exact page, body and ownership postcondition before appending the
lifecycle event. `appendSharedRecord` returns only an exact verified immutable
fact, obtained from an existing record or the original successful POST response.
The same execution now combines that returned fact with the fresh complete
event query before resolving file state. This supplies positive evidence for
one already verified event when the query index omits it. It does not infer any
other event or mutation from query absence.

| Boundary | Implementation and model correspondence |
| --- | --- |
| Exact immutable event | The returned fact has passed the original owner, Record ID, kind, entity, canonical envelope and Hash checks. A fresh query containing the same event ID with another payload fails. `resolveFileState` still checks the joined graph for missing parents, foreign identities and incompatible heads. Exact Record payloads and this query union are outside the finite models. |
| Original child outcome | `saveOutcome` remains after the exact native postcondition, verified event and graph checks. `MaintenanceApply` still separates `RetainAck`, `VerifyOutcome` and `CheckpointChild`; its acknowledgement is historical response receipt, not a new durable per-request ACK row. No parent child is verified merely because its event is present. |
| Interrupted execution | The returned event fact is retained in this execution only. Interruption, a query failure or a graph conflict before the original outcome can leave the child pending; an unknown outcome POST also remains fenced. The model permits interruption after acknowledgement and reconciliation only with the original outcome. It does not model every event/outcome subrequest or prove crash recovery for this in-memory fact. |
| Independent recovery | `reconcileSharedFileManagement` still requires the original exact outcome; `resumeSharedSkillApply` refuses a started child without one. Current path/body equality or a subsequently visible event cannot manufacture that outcome. The separate `AcknowledgedRecordPrefix` exact-ACK GET and complete-census requirement are unchanged; this union grants no native recovery suffix authority. |

The actual HTTP regression hides the newly acknowledged event from the complete
query response and requires one Path PATCH, one event POST and one outcome POST.
Its second case returns a conflicting event with a valid recomputed Hash and
requires rejection with no outcome POST. Existing unknown-PATCH and
event-alone-without-outcome negatives remain required. These checks exercise
the concrete branch; they do not turn the lifecycle models, independent add
acceptance or restore feedback into a proof of all file-management subrequests.

No TLA transition, configuration, property, bound or view changes for this review.
The source bindings and explicit exclusions are updated; fresh complete suite
results belong to their own runner artifacts. Earlier failed operations retain
their original pending history, and no eventual-visibility or unconditional
completion claim is added.

## Native revival metadata and preview reconstruction

The follow-up source review is `2e5b3ac9e6fc16a35863657237257ea380e534b8`,
whose parent is `dafa00d5d781dcc44071a0092001e01ae829dfb6`. Tombstone
classification now carries the original retained mode into the revival and final
manifest. Known `100644` and `100755` values remain unchanged; a conflicting
submitted mode is rejected, while historical absence remains unknown even if
the caller submits a mode. No native mode update or default is inferred.

`loadSharedApplyReferenceTree` retains its strict original byte, hash, path and
mode comparison. Its existing v2 reconstruction now also runs before a dry-run
returns `planned`. In both preview and execution it precedes local parent
retention, the original parent Record and child dispatch. The original failed
revival therefore stopped before writes; this change does not create another
ACK/outcome recovery route or relax the final-tree check.

The subsequent `02cfbd2831e991d66d77ed95c41c2340c7523481` correction
forwards the supplied optional mode through the isolated one-file add route to
the existing file-management plan, as the complete-parent route already does.
This preserves new input metadata without changing retained historical plans or
adding mode-update authority. Three public `applySkill` regressions use actual
filesystem input: regular and executable directory entries retain their modes,
while a bare Markdown input remains unknown. The original one-pass/two-failure
run becomes three passes; these are controlled source tests, not installed or
live Notion results.

`MaintenanceApply` abstracts valid ordered children and their original outcomes,
not native modes, byte reconstruction or preview results. The changed constructor
and earlier preview validation remain concrete preflight obligations outside the
finite models. The new controlled regressions distinguish both known modes from
historical absence, reject a changed known mode and require unavailable baseline
bytes to fail before writes in both preview and execution. The original ten-case
run had three passes and seven assertion failures; the corrected ten cases and
the 38 affected source tests passed. Installation and live Notion require their
separate results.

The completed 40-case lifecycle and 34-case operation-recovery runs at `dafa00d`
predate this correction and include the original mode omission. They establish
their declared finite contracts, not mode preservation. Their original inputs
and results retain that source identity. The final source bindings include this
reviewed follow-up; no model, configuration, property, bound or view changed, and
those earlier runs are not relabeled as a new run of either follow-up commit.

## NXT native reference binding and source task continuation

AH-1052–1055 extends the original owners from baseline `4580b7d6d692013091d5c66e90d703d51fd5fb10`. The historical `e34b446` change was reviewed: final-path link projections and unchanged-body evidence added no dispatch, while reviewed partial settlement was already represented by the existing model. The NXT changes below alter modeled boundaries. Before changing the models, both selected runners stopped on the protected-source hash mismatch. Those failed artifacts are retained; they are not model passes.

| Concrete boundary | Model change and scope |
| --- | --- |
| `shared-skill-apply-authoring` freezes logical body templates together with the complete final tree. `bindSharedApplyBody` derives a native body only from exact allocation identities; a capacity-only projection checks fixed-width UUID destination limits before any allocation. | `MaintenanceApply` still has three children, now two reference allocations and one body. Raw Markdown, modes, codec capacity and UUID strings remain concrete tests. No placeholder identity is persisted, returned or dispatched. |
| `executeSharedApplyBodyBinding` retains the original local binding intent and immutable binding record. Allocation plan/outcome/page ID are checked again when loading it. Its underlying original body request and outcome are separate. | New binding intent, dispatch, service application, durable ACK, exact verification and interruption states precede child three. `NativeBodyNeedsOriginalAllocationBinding` requires both original allocation outcomes and verified binding before body dispatch. Existing skip-prefix and replay-unknown negatives cover bypass and replay. |
| `resumeSharedSkillApply` checks every later child for original facts before continuing a pending binding. A binding with an existing body request only reconciles that original request. | Original prefix, unknown non-replay and whole-tree publication invariants remain. The model does not enumerate every Record subrequest or prove cross-machine absence. The public navigation test proves two original allocation ACKs yield only the unissued main body, with the exact same parent. |
| `guardedSourceMutation` records only `NOTION_REQUEST_FAILED` + `definitive_rejection` + HTTP400 + `validation_error` as not applied, bound to the original request hash. Saving that rejection is a separate fallible step. | `RestoreFeedback` now has up to two immutable feedback generations. `UnknownFeedbackNeverRedispatched` counts each generation; `NewFeedbackGenerationNeedsRejection` requires the retained negative receipt before the second. Receipt loss leaves unknown. The original body and request identity remain fixed. |
| `runSourceUpdate` / `resumeSourceUpdateRun` freeze selected version, per-following-file body/frontier/identity and submitted request ID. A failed checkpoint preserves the latest original body IDs. Completion checks the full final tree and each feedback result. | Task inventory, Source selection, fixed resource retrieval, checkpoint storage and result projection remain implementation obligations outside the finite restore model. Source fixtures cover A→B, custom preservation, body unknown, feedback-only continuation and interrupted checkpoint recovery. A selected version alone cannot complete a display task. |

The prior feedback rule used a single total-attempt count because no later feedback generation existed. Its new wording preserves at-most-once dispatch for each immutable request and admits only a separately authorized generation after a proven rejection. This is an intentional capability change, demonstrated by the exact-rejection and same-run feedback tests. Unknown 429/408/gateway/unrecognized/unclassified responses remain barriers; they are not retryable by this business protocol.

The existing inventory contains 35 configurations: AcknowledgedRecordPrefix 10, IndependentAcceptance 8, RestoreFeedback 10, MaintenanceApply 7. Earlier current-scope prose said 34 because it had not counted the later unreviewed-partial case. This change adds properties and states to those configurations, with the new exact expected-broken sets; it adds no configuration family or replacement guardian.

The isolated mutation harness now has six groups. The two added mutations remove original allocation-page verification and falsely classify uncertain source failures as definitive rejection. Baseline, real assertion failure, exact byte/mode restoration and restored pass are required. A syntax or type error is not a counterexample. Local model slices, the final full suite, installed commands and actual Notion/Pi results retain their own artifact identities.

The integration owner's bounded mismatch diagnostics and local full raw readback retention do not change comparators, dispatch, ACK or acceptance. The cache lane's freshness policy and explicit unresolved-binding barrier likewise provide no recovery authority. Their encoding and cost remain outside these finite models. Current exact source hashes bind the reviewed worktree; the integration owner records the final product commit after serialized submission.

### NXT verification run, 2026-11-15

The reviewed worktree at base `4580b7d6d692013091d5c66e90d703d51fd5fb10` passed the complete operation-recovery suite: 35 configurations and 376 property results, with all expected rule inventories and exact broken-rule sets matched. Every search completed without a cut. The runner verified all 39 covered source/test hashes and all 31 locked tool files; it used the locked TLC 1.7.4 jar. The coverage digest was `d0d0b8b61087f0590446d50543cccd1dcd7f97cfb2d40423d7ececb916e4e307`. The historical `source_commit` field remains the prior correspondence anchor; this run's exact reviewed inputs are its source hashes, not a claim that the uncommitted work was already published.

Artifacts, including both initial hash-mismatch failures and the subsequent model slices, are retained under `/Users/yoyo/Documents/code/personal/verification-evidence/nxt-20261115-jTFsQ9/evidence/nxt-operation-recovery/`. Original `/tmp` run directories also remain. The complete run is `nxt-operation-recovery-full-20261115-a/summary.json`, SHA-256 `54ebda8efd7f5454fe42f133d72d9deb96d60bb34c8f3e86bdb81f2db4aec0cf`.

The six real guard mutations ran in a separate linked worktree, `notion-skills-cli-d4c30c64`, with its own frozen-lockfile Bun dependencies. The product worktree `notion-skills-cli-62b72949` was protected. Each baseline and restored run passed; each mutant failed a real assertion. The exact per-group test counts were 1, 1, 2, 1, 1 and 5. Both `complete_source_and_modes_restored` and `protected_source_unchanged` were true. The mutation result is `nxt-operation-recovery-mutations-20261115-a/summary.json`, SHA-256 `4560e990150bfa89e272c7296257072b609d8eb67a22800aafb87b9507a5cd61`.

Actual entry commands were:

~~~sh
env -u NTN_SKILLS_DEV_ROOT node scripts/verify-resource-lifecycle.mjs --suite operation-recovery --statechart "$PSTACK_STATECHART_ROOT" --jar "$TLA2TOOLS" --out /tmp/nxt-operation-recovery-full-20261115-a
env -u NTN_SKILLS_DEV_ROOT python3 scripts/check-operation-recovery-mutations.py --protected-worktree /Users/yoyo/.devspace/worktrees/notion-skills-cli-62b72949 --out /tmp/nxt-operation-recovery-mutations-20261115-a
bun run typecheck
bun test packages/core/test/shared-skill-apply.test.ts packages/core/test/shared-skill-apply-tree.test.ts packages/core/test/shared-maintenance-operations.test.ts packages/core/test/shared-source-run.test.ts packages/core/test/shared-source-refresh.test.ts packages/core/test/shared-source-definitions.test.ts packages/core/test/shared-file-request.test.ts packages/core/test/shared-file-restore.test.ts --timeout 60000
env -u NTN_SKILLS_DEV_ROOT bun test packages/cli/test/library-source-definitions.test.ts --timeout 60000
~~~

TypeScript checking exited 0. The eight-file Core run passed 158 tests with 1,073 assertions. The Node CLI offline-contract run passed eight tests with 161 assertions, including explicit following updates and original run continuation. Its fixture removes the inherited development launcher override. These are finite-model, source-regression, real mutation and offline CLI results. Actual Notion A→B updates, native custom preservation, visible file-request feedback and Pi consumption require their separate same-library evidence; none is inferred from these counts.

### Public apply result follow-up

The real maintenance run exposed an output-only gap: `mutation.ts::sharedApplyResult` repackaged the verified shared result without the common completion fields. The Core boundary now returns `complete` only after its existing full current-tree verification, `no_op` for an identical complete tree, and `needs_decision` for a preflight-only preview. It reports the corresponding effects and a read-only command for the exact retained ref; a successful operation is never offered resume. Dispatch, ordering and verification are unchanged. Four focused public-function cases passed 63 assertions, including no writes on repeated identical input, and the subsequent typecheck exited 0. The first added assertion referenced a nonexistent fixture property; it was corrected to the fixture's canonical library descriptor before these passing runs.

The mapping now includes the public result owner, for 40 protected source/test files. The full 35 configurations and 376 property results, followed by all six isolated guard mutations, passed again against coverage digest `f738fa59c2b3c349cb8f526f8f49371cf6cf0e652a7ee2b21a5f349ddd74f563`. No model transition or expected violation changed for this projection. Both new artifact directories sit beside the previous runs, which retain their original identities:

| Final projection artifact | Summary SHA-256 | Result |
| --- | --- | --- |
| `nxt-operation-recovery-full-20261115-public-projection` | `490b0df42181dae21efb1d6414014b74a23295792a8355365e074af4dd3cb035` | 35 complete configurations, exact inventories and violations, 40 source hashes |
| `nxt-operation-recovery-mutations-20261115-public-projection` | `b44d08345ce7486ba634a648a1b4a039e596186acae7347fb31fb69f434ed350` | Six real assertion failures; baseline/restored counts 1, 1, 2, 1, 1, 5; all source bytes/modes restored; protected product unchanged |

### NXT owned live Source evidence

The live NXT Source evidence uses the owned library entry `4195636c-236e-8104-aafa-f7366fe421ce` under the same retained run root. Fixed Git revisions are A `d6e546efe17c9ba48291a67356c4be6f7a7883a8` and B `657919af19c22951796b326af44032a63dec24f2`; both members use explicit retained storage. Source content was read and retained as data, never executed. The first admission continued the same original `skill-create-ad0059877fc1719a2450c3d16eeead073383fe031a5d7ec0de21f515493d1a56` after the local SQLite address fix. Its prior failure remains. The second admission and the complete Source update use the independently installed final-02 CLI, SHA-256 `3f4fb23cf2c6b4359257f5193d897c1ec2ec42e89f96bbcc38594c1803294528`.

`evidence/nxt-custom-sticky-proof.json` independently records following → custom → custom after a byte-exact native restoration of A. The original and restored raw-v2 SHA-256 is `4147e8fdc55667b968e3b94f67cdb7ae38cdd5872715cc99a5909f446134ae11`. This native equality does not mean the source-following and native-custom consumer serializations are byte-identical: the captured first difference is source Markdown bold versus Notion's `<b>` representation. Both are retained separately. The source Native probe is an explicitly labeled authoring simulation against owned Notion pages, executed by actual Node; the earlier unsupported Bun launch failed before any remote write and remains in the artifacts.

`evidence/nxt-source-b-proof.json` binds the successful task `source-run-c44dc695-ee6c-4dab-9581-320c15d5b32e` to its frozen two-member plan, exact body operation, complete independent raw readbacks and current ownership observations. The changed following member performed one attributed body PATCH; the custom member received no page PATCH and remained custom. Both full trees verified and Source feedback was acknowledged. The second provider member has identical content at A and B, so its retained bundle ID correctly remains unchanged; the proof does not claim its upstream bytes changed. Both original A pins were then read byte-for-byte unchanged with zero HTTP requests. The task's returned `run-status` action also executed entirely offline with zero HTTP requests. The full operation used 178 measured HTTP attempts and one separately measured Git acquisition; Git wire bytes remain unknown.

### NXT original file request and visible feedback

After the B task preserved the custom member, a new owned native edit replaced that member's body with a 166-byte request note. The public request-schema preview sent no writes; its explicit application registered the ordinary request, result and receipt columns. The public request preview also sent no writes. Submission froze the complete note, original custom frontier, exact file identity and fixed B Source definition as `file-request-9c7936fd6779629452167c84028efb67dba8dada44c394c6ad7e2649bc6743e7`.

The single task `source-run-f18974dc-5fc4-42ee-84d8-7fc6e73efe4b` completed with the exact submitted request. Its earlier Source-display phase preserved custom ownership; only the submitted request authorized the later restore. The request result was `verified_applied`, both member selections were unchanged, and Source feedback verified. Independent public request inspection, complete raw-v2 GET and state observation confirmed the original file and page, the 3972-byte selected body, following ownership and the retained user-owned `restore-follow` intent. These observations sent no remote writes.

`evidence/nxt-file-request-proof.json` binds the frozen request and run to the full original restore operation. It also records the original 166-byte custom body retained by the `following_restored` event. Generic operation show reported only original intent and did not claim completion. Executing its returned read-only reconcile action then verified that exact original operation with zero writes. No current-body equality was promoted into an original acknowledgement.

The task made 224 measured HTTP attempts and seven Notion writes. Five writes belonged to the original restore protocol, including its retained facts and native metadata; two later writes recorded file feedback and Source feedback. The nested feedback helper's `body_writes: 0` describes that metadata-feedback step, not the complete task. The proof retains the full trace and separates this field from the actual restore. One Git acquisition also occurred; its wire bytes remain unknown. The real run used ordinary successful feedback. Feedback-only repair after a definite rejection remains covered by focused regression and guard mutations, not by a claimed real Notion failure.

### NXT independent historical export and version refusal

The final installed CLI restored the explicitly shared old graph into the independent `old-pin-independent` config/state/cache/data roots. A public `export` of that pinned snapshot with `--projection snapshot --offline` then made zero HTTP requests. `evidence/nxt-old-pin-independent-proof.json` verifies all six exported file hashes, lengths and logical modes. Main is 5536 bytes; the script is 52 bytes with mode `100755`; the binary is nine bytes. The old alpha path remains, and the two new reference paths are absent. No author Store was copied and no script was executed. The established directory exporter uses private filesystem permissions `0600` and executable `0700`; the report preserves that distinction from logical `100644` and `100755` source modes.

Two later apply attempts returned `WRITE_CONFLICT` with 22 requests and zero writes each. The first used the pre-maintenance six-file pin. The second used the successful eight-file apply pin, whose acquisition library descriptor predated request-schema installation. `evidence/nxt-single-apply-version-diagnostic.json` records the six added Skills/Files property IDs and verifies that all eight file hashes, lengths, modes, native references, relations and ownership frontiers stayed the same. One independently observed ownership set reconstructs both exact version digests. Changing only the acquisition library descriptor reconstructs the earlier digest, because the existing snapshot identity includes that descriptor. This was a schema-bound stale write baseline, not a Profile or body change. Both refused commands remain original evidence; a fresh public read supplies a separate current intent rather than changing either old pin.

The full-unit failure in `shared-resource-state.test.ts` had the same kind of inconsistent fixture preimage. Its candidate reused an upstream archive and changed the selected C1 pin while retaining the other fixture's display baseline. The test now freezes the actual following main file's identity, body hash and frontier and preserves the custom reference. No product guard changed. `evidence/nxt-gates/unit-resource-state-before.*` retains the original failure; the focused whole-file run in `unit-resource-state-after.*` passed eight tests and 54 assertions. The file format check passed without changes. This test file is outside the formal coverage inventories.

### NXT Source correspondence in the lifecycle suite

The Source/Following/Request review keeps the existing lifecycle transitions and property inventories. It does not reuse the operation-recovery run as a lifecycle result. `ProjectionRace` still describes refusal of automatic read-check-unconditional-replace: ordinary `runSourceUpdate` retains every `automaticSourceStops` result. Only an explicit `updateFollowing` decision removes `BODY_REPLACEMENT_UNSAFE`; `INITIAL_PROJECTION_REQUIRED` remains a stop. The new orchestration then calls the existing complete-old-body-match restore protocol. That explicit writer is already outside `ProjectionRace`, as are page CAS and edits after a separate observation. Giving that path the model's rejected `UnsafeOverwrite` switch would misrepresent the implementation.

`UpdateCommit` still abstracts one already-authorized selection. `applySourceRefresh` retains every fixed resource, source descriptor and provenance fact, rechecks the Source definition and complete current target, saves the original selection plan, and delegates to `applySharedSourceSelection`. Selection continues to use `executeSharedMetadataWriteWithJournal`; its complete-source `beforeDispatch` check, original outcome and unknown barrier are unchanged. The two `guardedSourceMutation(...repeat: "never")` calls inside refresh instead own Records Origin links and Source status. They are not the selection ledger. A new rejection receipt in the Source mutation owner therefore does not create a second selection dispatch. Complete selection, stable existing pins and no invented original outcome remain the same modeled claims.

`display_baseline` freezes the original selected version, native file identity, body hash and event frontier. `updateSourceDisplay` checks this authority through `expectedFollowing`, retains each actual restore ID before body dispatch, and uses reconciliation for an existing ID. Its later complete-tree read is forced and read-only. The task checkpoints, per-file custom/unchanged/display results, same-run request scope and final result projection are orchestration outside the lifecycle finite domains. The narrower original-request and per-generation feedback boundaries are reviewed in `RestoreFeedback`; that model does not expand `UpdateCommit` or prove the entire Source task.

Custom ownership continues to come from the event frontier, including after native bytes are restored to their original value. No byte equality releases customization. `ProjectionRace` has no separate human-revert step, so the actual same-byte sticky-custom run is concrete Notion evidence, not a newly enumerated lifecycle behavior. File-request submission still freezes body/frontier/identity/Source; the native dropdown alone supplies no overwrite authority. Allowing the Source runner to reconcile the exact recorded request does not create a fresh submission or replace a pending original. Only a durable, exact HTTP 400 `validation_error` rejection may permit a separately identified feedback generation; uncertain errors remain barriers. The immutable selection journal and every `repeat: "never"` mutation keep their original single-dispatch rule.

### NXT complete lifecycle correspondence run

The lifecycle review covered 22 changed protected inputs and 16 newly relevant concrete boundaries. The seven existing models and all 40 configurations retain their original transitions, views, property inventories and expected broken-rule sets. Complete old-body replacement remains outside the automatic projection race; maintenance allocation bindings and feedback generations belong to operation recovery; detached immutable producers belong to request-engine. Freshness, capacity, diagnostic retention and growth metadata are concrete implementation boundaries, not newly enumerated lifecycle properties.

`evidence/nxt-lifecycle-final/summary.json` completed all 40 configurations against 119 exact source/test hashes. Its SHA-256 is `30c9a0050fbed3106d077fade33b4dcbc44ba76f5e6241b6e789545e7693e7cd`; coverage SHA-256 is `7238af886862eb0dc80ac1e6c17a1656bc051806a4cb30194bf03684dbffc6df`. The original failed source-correspondence check remains in `evidence/nxt-lifecycle-before`; it did not run TLC or produce a passing model result.

The four existing real guard mutations (`editable-overwrite`, `custom-takeover`, `audit-readonly`, `readonly-capability`) ran in a separate worktree. Each baseline and restored case passed; each mutation failed its designated business assertion. All protected main-worktree files remained unchanged and all isolated inputs were restored byte-for-byte. `evidence/nxt-lifecycle-mutations/summary.json` has SHA-256 `833a6abb5ae1c3039484ad51daed0434783ee471d51c663fde9bc350daa84c6d`; `evidence/nxt-lifecycle-protected.json` records the exact protected input set. These results establish the existing finite claims and their concrete guards; they do not establish page CAS, all possible native human edits, or the complete same-library acceptance journey by themselves.

## Original-page repair

Historical-main repair and managed-file adoption freeze one exact owner, native page, complete body, editable-property preimage, relationship and original-operation frontier. `sharedCreateDispatch` permits only the nominated blank-identity PATCH; ordinary creation does not acquire a general metadata-edit capability. Original body, plan and outcome are retained separately. Credential-scoped SQLite locators and POST markers are barriers, not a second remote authority.

Completion readers validate the full original plan, expected outcome and retained body. A matching current File ID, outcome header or another credential's ACK cannot manufacture completion. `assertSharedRepairPending` checks this exact owner before current consumption. Unknown requests are preserved rather than replaced. Ordinary child-page placement explicitly remains unsupported when its original page cannot safely become a managed database row.

Existing acknowledgement and creation models retain their bounds. Repair's metadata parsing and new entry authorization are unmodeled concrete guards; source tests and actual owned Notion readback prove those boundaries separately.

## Commands and host

Canonical `ctl audit/file/resource` spellings share their handlers with retained historical spellings. `ctl operation` delegates each exact original family. Show is not completion; reconcile is read-only; only explicit original apply resume has its narrow suffix authority. The Pi fixture validates that a proposed next.argv is the same owner's read-only original reconcile before it executes it.

Mock supplies model decisions only. Actual CLI, SDK, Pi tools, serializer, source writes and session recording run normally. The independent oracle checks native calls, exact source bodies, whole generated directory objects, each operation's effects and actual HTTP. Repeated paths in author commands or audit reports are not duplicate directories. Duplicate native call IDs remain visible to the verifier.

Independent installation, real Notion, real Pi with a loopback model and real-model usability are separate evidence scopes. A successful one does not stand in for another. No result authorizes a global installation change, production inventory repair, main merge or publication.

The installed consumer resolves the selected Node launcher's actual `process.execPath` before changing HOME. The same concrete runtime drives CLI commands and the Pi source adapter. The launcher regression exercises a real child process whose launcher only works in its original home, then verifies the resolved Node in an isolated home. It does not inherit version-manager configuration or relax the installed Pi acceptance conditions. The original Volta launch failure remains a failed run.

## Independent review corrections after `9e4cefb`

The cold review reproduced two bugs on the frozen product, without mutating its
guards. Original failure artifacts remain alongside the corrected runs.

The same-model [maintenance atlas](statecharts/2026-11-13-maintenance/README.md)
shows scope and parent/child recovery without introducing a second state model.
Its presentation-only child-label aggregation is checked against all six original
configurations; model states, rules and broken-rule sets remain unchanged.

**Repair query visibility.** An applied identity PATCH with a lost outcome stayed
blocked while the original plan was query-visible, but a temporary query omission
let the same Store consume and add observation Records. The corrected gate joins
the credential-scoped locator and original pre-POST marker with remote headers.
Only an exact complete original shared proof releases that barrier. Another owner
does not inherit it. An empty local repair inventory does not add an identity
request to ordinary audit or consumer paths. The local marker does not create ACK
authority or repair knowledge for a fresh Store.

**Permission evidence at a budget boundary.** A Files denial was held in a local
variable until Records completed, so the next exhausted request erased the known
denial from the paused report. Each observed group now reaches the in-memory run
before the next request, and the audit transport durably retains the confirmed
reachable failure. This applies to the initial and final observations. Resume
replays the original task's denial; later final observations may improve current
coverage without rewriting its historical evidence. Report-only next actions do
not expand a healthy target into a full census.

These changes restore the existing promises; they do not add a model variable for
real query visibility or each permission error. `AuditScope` still proves only its
declared finite facts and progress contract. Repair metadata, local marker lookup
and exact HTTP response retention remain concrete implementation checks. The
independent review reproducers are rerun by changing only their checkout path;
their assertions and old failures stay intact. Model source hashes are updated
only after this correspondence review and the affected real-code checks.

## 真实集合维护：源码对应补充

2026-11 的真实目录上传、整组移除和 Source 归并复用了已有 complete-resource create、原 ACK dispatcher、元数据修改守卫与 SQLite Store。普通 `create` 不再要求 Agent 为脚本/JSON/二进制另走迁移入口。仅生成资源说明标题的同名 HTTP 自动链接按表现差异核对；作者 Markdown、真实脚本字节、hash/mode 与原未知请求仍保留精确检查。历史资源说明误判通过同一创建的原 ACK 前缀续办，并独立保存完成结果，不覆盖原失败。

集合移除、来源归并/改名、对当前观察的失效处理、Notion Trash 属性端点差异及新 Store 地址均不在旧有限域中。这些由真实授权对象、公开 CLI、源码回归和真实 Node SQLite 断言承担；不要把同步 hash 说成新形式化证明。ImportCreate 的抽象顺序与性质未变，只选择原完整模型组复验，其他模型与历史图不重复生成。

## SRC 来源接手：SDK 与原操作对应审阅

2026-11-15 的 `4be7add` 在现有 Promise SDK 上增加四个来源管理入口。
逐段比较确认 `runOperation`、`consume`、`readSkill`、`readResources` 的行为未变；
新增入口直接进入 Core，沿用凭据作用域、取消、请求预算和同库本地写锁。
`review` 与计划准备受 `withReadOnlyNotion` 限制，正式应用由明确的 `onboard-apply` 授权。
来源已登记、成员已关联、内容已验证和原操作已确认仍是不同事实。

创建动作持有原 `SharedCreatePlan` 并调用 `executeSharedCreate`，不建立另一套派发器。
缺关系的固定 Git 旧页使用不可变来源证明；没有历史来源证明的同名原生/保留型内容
只能由单来源的显式 `--bind MEMBER=PAGE_ID` 决定新的发现关联。该决定冻结原页面、
业务身份、原关系与 Selected Version，不能清除另一个来源、绕过原 unknown 或覆写正文。
绑定使用 `guardedSourceMutation` 的 `repeat: never`，当前关系相等仍不能补造丢失的 ACK。
原创建、绑定和独立接管决定各自保留，不以主任务完成标签代替逐项结果。

来源成员分类、多成员协调、派生 Skill ID、Provider 超时、参数和错误投影均不在既有
七个生命周期模型的有限域中。对应记录将这些文件作为明确未建模的实现上下文，
保持全部 TLA 模型、配置、视图与 expected_rules 不变。原 CI 的源码对应失败保留；
更新 hash 本身不代表新模型性质或实库全量成功。源码回归与独立安装 CLI→SDK→CLI
真实 Git/受控 Notion 入口分别覆盖新协调行为，实库仍由原始运行回执和独立读取验证。

真实全库试用另揭示 Git 部分克隆的分支批取缺陷：仅用 commit 的测试未覆盖已有远端
分支引用时的协商行为。相同受控 HTTP 仓库改用 main 可复现失败。精确缺失 blob 的
批取关闭 commit negotiation，初始 ref 获取保持原行为。新增 commit、branch、tag
三组分别检查固定 revision、完整选中文件、一次批取及未选大对象不下载；这属于提供方
传输实现回归，不扩展生命周期或请求引擎的形式化结论。

### SRC 实库反例的追加对应审阅

原生 Selection 只增加已知 v1 封装的读取规范化，四个过滤字段和语义指纹保持一致；
未知版本/额外字段仍在边界拒绝，不增加来源写入。来源目录 Router 与 Skill 成员分别
投影，`--member` 只收窄已完整发现的当前动作范围，保存到原计划并在应用时再次约束。
错误投影省略重复的子计划正文，但保留原操作身份和父计划中的完整输入。这些分类与
展示行为仍在来源接手的未建模范围，不由更新源码 hash 证明模型性质。

创建文本保留新增有界分块：小对象保留 v1 原字节和原 identity；只有不能放入普通
64 KiB 事实的完整输入/基线才使用现有 exact_bytes 对象。根记录仍绑定整文 SHA-256
与长度，块布局复用现有32 KiB读取校验。所有确定性字节/清单验证在原创建派发前完成；
之后仍由同一创建 journal 先记录派发，按原页面与事件继续，未引入第二个上传/重试器。
原生提交的 Markdown 与内容接纳规则不变，跨页链接不一致仍拒绝。既有正文观察和编辑
计划的内容大小边界不因此放宽。

retained_bundle 与其 source_projection v2 创建清单使用既有1 MiB逻辑/180 KiB编码清单
上限；对象、事件和普通操作仍64 KiB。该编码和文本块布局不在有限 TLA 字节域中，
记录为显式未建模对应；原 ImportCreate/恢复顺序保持，所有模型与expected_rules未改。
新增407文件清单、100 KiB完整Markdown、冷重建、缺块拒绝及真实Node/SQLite HTTP入口
分别承担这部分证据。曾要求65,536字节文本被拒绝的旧用例改为验证分块和8 MiB上界，
保留普通记录拒绝测试；不能把这个边界调整解释为取消一般大小保护。


## AH-1068：验证分域与原生完整URL误判

管理、消费与来源接手有不同的主要状态和验收边界。继续把三者追加到原总入口会增加
上下文与误选全量矩阵的成本；为每个Issue新建guardian则会复制同一原操作和证据协议。
本轮选择三个执行Skill加一个管理侧原生导入子模块：原总入口缩为路由，旧23份feature
规程/脚本与用例ID原地保留；模型和Pi证明仍归原负责人。`verification/skill-domains.json`
只登记唯一主要feature归属、实际回归文件和安装规程，不作为新的执行或证明平台。

常规测试拒绝缺owner、双owner、断测试/安装链接和不可发现入口。Broker反向交接由
其原三个Skill及常规test:verification检查。本轮作者实际运行了管理/消费/来源/原恢复
切片，安装和实际Notion证据另外记录；结构测试不证明冷Agent能正确选择，独立指令评估
仍为not_run。旧合同和共用隔离设施移至references，未删除历史失败或改变其通过范围。

Guizang原失败回执指向的完整main已通过只读公开CLI重新取得。原文字与代码完全相同；
Notion把保留的注释转为转义字面量，并把其中完整URL加成同地址标签链接。旧校验器
只识别不含scheme的自标签链接，因而把该第二处自动链接误记为额外明确目标。修复只
增加完整href恰好等于可见label的自动链接识别；原输入的authored目标仍逐一要求，
图片、不同href、文本/代码变化、表格加号变圆点均保留拒绝。原生wire和冻结projection
policy、原journal/ACK/恢复权威没有变化。

最小复现保留修复前失败，安装HTTP旅程添加相同注释转义与自动链接；完整实际main
单独通过新比较器。此语义解析不在ImportCreate有限状态域中，作为显式未建模源码
对应。旧needs_review事实没有被改写；retained Source v2原失败的正式恢复入口仍是
另一个明确产品缺口，不能套用仅支持普通native或旧fixed-Git的恢复命令。各原计划和
页面继续保留，实际库存完成数未因校验器修复而增加。
