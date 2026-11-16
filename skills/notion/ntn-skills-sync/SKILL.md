---
name: ntn-skills-sync
description: Manage active Git/GitLab/Linear sources, review complete Source candidates, run finite update policy, explicitly admit members, and select fixed Git/HTTP/local sources or shared Profile/View defaults. Keep exact identities and original plans; report each affected item and unresolved result.
compatibility: Requires ntn-skills, Node.js 22.22.3+ within 22.x or 24.20.0+, and an existing Notion token; reads need Read content and writes need Insert/Update content. Local replacement requires supported system Trash retention.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-sync
---

# Maintain sources and supply rules

Identify the selected library and record first. A `shared_skill` locator uses shared native Source/Profile rules. One-time content edits belong to `ntn-skills-maintain`; consuming a remote workflow needs no sync binding.

**GitHub upstream is the content data plane.** A fixed Git selection is consumed from the pinned GitHub commit/tree/blob and local verified cache. Notion owns Source/Skill identity, permission, custom takeover and necessary original-operation evidence. Never make copying all upstream Markdown, images, scripts or auxiliary files into Notion Files/Records a prerequisite for ordinary GitHub-backed read/use. Existing custom and immutable old receipts must still be preserved. For a large GitHub member, prefer `ctl library source inspect https://github.com/OWNER/REPO --commit EXACT_SHA --root MEMBER_ROOT` to obtain a complete tree manifest without downloading bodies; resolve the branch to an exact commit before this operation, and fetch only required pinned files through the fixed Git reader. Inspection alone does not publish or enable an unregistered member for normal `read/use`. Do not claim an incomplete historical native-import operation succeeded because Git bytes are accessible.

## Manage an active Source definition

Use `ctl library sources` to manage the four-table shared library. Sources owns provider/location/ref/selection and its Origin/member binding. `Selected Version` is the separate exact content pin; changing a definition alone does not advance it.

```bash
ntn-skills ctl library sources list --entry LIBRARY_ENTRY
ntn-skills ctl library sources show SOURCE_ID --entry LIBRARY_ENTRY
ntn-skills ctl library sources members SOURCE_ID --entry LIBRARY_ENTRY
ntn-skills ctl library sources check SOURCE_ID --entry LIBRARY_ENTRY
ntn-skills ctl library sources fetch SOURCE_ID --entry LIBRARY_ENTRY --member EXACT_MEMBER --output ./source-files
ntn-skills ctl library sources prepare SOURCE_ID --entry LIBRARY_ENTRY --target SKILL_PAGE_ID --output ./refresh.json
ntn-skills ctl library sources apply ./refresh.json --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library sources apply ./refresh.json --entry LIBRARY_ENTRY
```

`check/fetch` are read-only provider operations. `prepare` freezes the complete member plus current ownership and content expectations. Use `--all-bound` instead of `--target` to acquire a Source once and freeze every enabled bound Skill, including the complete membership observation. `apply` uses that exact candidate, preserves whole custom files and old pins, and verifies the resulting directory. Default `--storage auto` prefers the unchanged complete pinned GitHub tree. Transformed, materialized or unsupported members require an explicit storage decision instead of a silent ZIP upload. Retention requires `--storage retained` or a reviewed Source `options.storage="retained"`. Fixed retrieval transport failure is not retention consent. Use `sources reconcile ORIGINAL_PLAN --entry LIBRARY_ENTRY` to inspect the original selection without repeating it. Never re-create a frozen plan from current text to make an unknown result look complete.

`put --input DEFINITION --expect FINGERPRINT` changes one full configuration; use the fingerprint from `show` or `absent` for a new stable ID. `bind SOURCE_ID --target SKILL_PAGE_ID --member EXACT_MEMBER --expect-origin CURRENT_SOURCE_PAGE_OR_none --entry LIBRARY_ENTRY` changes only association. Providers include generic Git, registry and explicitly mapped Linear issue/document content. Auth stays on the machine. Shared contributor sets require explicit composition, not a single-source overwrite. See [source decisions](references/synchronization.md#active-sources-definitions) before authoring configurations.

A new Source with zero bound members is a normal first-use state. `run --all-bound` reports `empty_scope`; it never silently imports or enables discovered Skills. To take over a manually added Source or fill missing members, use the handoff below. Fixed-version selection and an editable Notion page update remain separate effects; follow the [synchronization reference](references/synchronization.md#the-first-member-of-a-new-source).

## Take over a Source and fill member gaps

```bash
ntn-skills ctl library sources review --source SOURCE_ID --entry LIBRARY_ENTRY
ntn-skills ctl library sources onboard --source SOURCE_ID --entry LIBRARY_ENTRY --output ./onboarding.json
ntn-skills ctl library sources onboard-apply ./onboarding.json --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library sources onboard-apply ./onboarding.json --entry LIBRARY_ENTRY
ntn-skills ctl library sources onboard-reconcile ./onboarding.json --entry LIBRARY_ENTRY
```

Use `--all` instead of `--source` only for an explicitly requested library-wide review or onboarding. For a bounded multi-Source pass, repeat `--source EXACT_SOURCE_ID` (2–100 distinct IDs), set a finite per-Source and total timeout, and keep the resulting `scope.kind=sources` distinct from a complete all-Sources inventory. A slow Source's timeout is not an absent member; review remaining Sources in explicit later batches instead of restarting the same long prefix. Review includes disabled Skills and complete forward identities, not a filtered View or the first 25 reverse relations. `registered` proves a current association, not full content health or a past write acknowledgement. A Source's `ready` label does not mean all its members exist.

For a selected member subset, repeat `--member EXACT_KEY` with exactly one `--source`; it cannot accompany a multi-Source selection. The saved scope limits actions without editing shared Selection. Combine it with explicit `--bind` decisions when only existing relationships should change. Provider discovery still checks the configured source, and an absent requested key fails explicitly. Source-directory Routers appear separately in `source_routers`; preserve their authored Members instead of assigning them fictitious upstream Skill keys.

For Git discovery, `--member` is pushed below the content acquisition step: the full configured commit/tree and exact member boundary are validated first, then only that member's resources and necessary source-level prerequisites are fetched. The behavior does not modify the Source definition or the user's current pin. It does not reduce the number of blobs *inside* one large member; use the pinned GitHub tree inspector and per-file access instead of reviving a 123-file Notion native import just to inspect source content. GitHub HTTPS Git discovery uses HTTP/1.1 only inside the operation's disposable bare repository to avoid observed HTTP/2 proxy framing failures; machine and other-provider configuration remain untouched.

`onboard` freezes the configured provider revision and full child creation plans. It generates stable Skill IDs; do not invent IDs, pre-create pages or patch relations by hand. New Skills remain disabled. A missing binding can reuse an existing page only when its selected immutable Git source proves the repository/member identity. Same-name native or retained content remains `existing_identity_needs_review`, not a new duplicate or automatic rebind. Preserve the returned blocked members and original operation IDs.

Follow the exact saved plan and returned `next.argv`. Apply delegates to the original create/bind journals; it never updates existing bodies, user Members/Requires or selected versions. Reconcile is read-only and current equality never supplies a lost ACK. A partial result can contain verified actions and unresolved members; keep both. Do not regenerate a plan to evade an unknown operation. After applying, use a fresh review for current coverage and an explicit authoring read for disabled content. The existing `sources run` workflow takes over subsequent authorized updates.

A CLI failure is not necessarily a persisted terminal rejection. Main creation can have its original ACK while the first readback fails before manifest retention. For an exact missing manifest/completion, reconciliation may return the same saved plan's read-only `onboard-apply --dry-run`. Follow that preview without changing the plan. An explicitly authorized apply still checks the original journal, native ACKs and current content before continuing unissued steps; preview alone grants no continuation authority. Unknown writes, missing ACKs and recorded `needs_review` remain blocked. Never invent a replacement operation or patch the original page by hand.

For a reviewed `existing_identity_needs_review` candidate, a single-Source onboarding can receive `--bind MEMBER=PAGE_ID` (repeat for exact candidates). This is an explicit **new association decision**, not historical provenance inferred from a name. Only the reviewed same-library, uniquely identified, currently unbound target qualifies; unknown operations and foreign owners remain blocked. The plan labels this proof `explicit_binding_decision` and preserves existing custom content and Selected Version. Never use a copied page or new duplicate to evade the decision.

## Source names and repository-level management

A Source is a provider location plus its chosen ref/policy/options, not one row per discovered Skill. A compatible repository can select multiple exact roots; each Skill retains its own Source Member and selected immutable version. Separate configurations for different branches, filters, credentials policies or transformation options must not be merged merely because the URL matches.

The Source title is an editable display label. Stable Source ID and native page relations own identity; repository paths remain in Location. Renaming in Notion or through the CLI preserves members and selected content. Because the full configuration fingerprint includes the title, an older prepared configuration change may require a fresh preview.

```bash
ntn-skills ctl library sources rename SOURCE_ID nowledge --entry LIBRARY
ntn-skills ctl library sources consolidate --source KEEP_SOURCE_ID --name nowledge --entry LIBRARY --dry-run
ntn-skills ctl library sources remove --source SOURCE_ID --entry LIBRARY --dry-run
```

Inspect the returned exact plan and use its `next.argv` to execute. Consolidation unions compatible roots on the retained Source, preserves member keys and selected versions, rebinds Skills/Records Origin, then moves now-empty duplicate Source pages to Trash. No body, fixed source payload or upstream repository is edited. Removal operates on an exact Source's member closure, not a title substring; outside Requires and ambiguous shared ownership refuse or preserve rows. Saved `--operation` continues only the original scope. Neither operation claims cross-machine atomicity or permanent deletion of private historical copies.

## Run finite policy and review member changes

```bash
ntn-skills ctl library sources run SOURCE_ID --entry LIBRARY_ENTRY --all-bound --mode check
ntn-skills ctl library sources run SOURCE_ID --entry LIBRARY_ENTRY --all-bound --mode prepare --output ./candidate.json
ntn-skills ctl library sources run SOURCE_ID --entry LIBRARY_ENTRY --all-bound --mode policy --due
ntn-skills ctl library sources run SOURCE_ID --entry LIBRARY_ENTRY --all-bound --update-following
ntn-skills ctl library sources run-list
ntn-skills ctl library sources run-status SOURCE_RUN_ID --output ./original-candidate.json
ntn-skills ctl library sources run-resume SOURCE_RUN_ID --update-following
```

Check and prepare modes are remotely read-only. Policy skips disabled Sources, skips provider rediscovery for pinned Sources, prepares manual candidates and applies auto candidates only where verified protection allows. Auto requires an explicit `options.check_interval_ms` of one minute through 366 days. Registered file requests are still processed for enabled Sources when pinned, not due or unchanged. This command performs one bounded invocation; it installs no scheduler or daemon.

Use `--max-requests`, `--max-bytes` and `--duration-ms` to set the invocation budget. Actual HTTP attempts include retries; waits count toward time, and admitted response overshoot is reported. Git subprocess deadlines are separate from HTTP byte counts. Exit 75 pauses, 4 preserves unknown/incomplete outcomes, and 3 identifies review-required results. A completed check or prepared manual candidate is not a content application. Offline run status may show an interrupted running checkpoint; do not infer that its last write was never sent.

For a basic explicitly authorized update, use one `sources run ... --update-following` in policy mode. The task freezes the exact candidate and original following bodies, selects the version, and updates existing still-following native files through their original full-body matching operations. Whole custom files remain preserved, including custom content whose bytes happen to equal upstream. A missing native projection still needs its separately diagnosed initial projection; the task does not invent a File identity. For an explicit single-file ownership decision, `ctl file restore-follow TARGET PATH --entry ENTRY` remains available.

When a prepared task needs a decision or was interrupted, inspect its original `run-status` and follow its exact `next.argv` or decision argv. `run-resume` uses that authenticated local run receipt, frozen candidate and original request scope; it does not fetch a new upstream candidate. Completed body operations are reconciled before repairing request feedback. Unknown body requests are never replayed, and a successful feedback repair does not claim the old response was received. A complete check, selected version, displayed body and accepted request feedback remain separate facts in `outcome` and the per-item results.

Unattended automatic editable-body replacement remains blocked when no atomic content precondition is available. `--update-following` is a bounded explicit author decision and does not change automatic policy or claim atomic page compare-and-swap. Report `BODY_REPLACEMENT_UNSAFE` or a missing initial projection as pending work; selecting a revision alone does not prove the Notion page displays it. Source check status, selected revision, displayed revision, custom ancestry and session pin remain distinct. Same-state-root invocations share a local fence; coordinate one management writer per library across machines.

Explicitly admit an exact new member with `sources admit SOURCE_ID --entry LIBRARY_ENTRY --member EXACT_MEMBER --skill-id NEW_ID --output PLAN`, then `admit-apply PLAN` or `admit-reconcile PLAN`, both with the same `--entry`. New entries remain disabled unless preparation includes `--enable`. Optional `--storage retained` explicitly retains all acquired fixed files and modes. `auto` and `fixed-git` verify exact external content; HTTP or trusted machine Git transports do not change the shared source identity. Existing enabled or disabled Source/member bindings prevent duplicate admission. Default Views and user Members/Requires are not expanded by new upstream candidates.

### Align existing storage without changing content

Use `sources storage review --all --entry LIBRARY_ENTRY` for the complete forward bound-member roster. It reads metadata only and does not prove original completion or current custom content. For one original retained Skill, use `sources storage prepare --source SOURCE --target EXACT_PAGE --entry LIBRARY_ENTRY --output STORAGE_PLAN`, then follow its exact preview/apply/reconcile argv. The plan proves the old revision and every path/hash/length/mode equal to fixed Git. It does not follow current HEAD, rewrite native bodies or enable the Skill.

Original unknown/incomplete creates, missing original revision, transformed bytes and explicit Source retention stay blocked for a separate decision. Old pins, archives, manual whole-file overrides and relations remain unchanged. This is not a garbage-collection command. Do not manually alter Files/Records or replace a frozen old creation plan to make storage alignment appear complete. Cold verification must read the resulting fixed files through the same SDK and keep source originals distinct from Notion reading projections.

`NTN_SKILLS_FIXED_GIT_TRANSPORT=auto|http|git` is trusted machine configuration for the standard CLI/SDK; it is not stored in Source content. Git fetches exact pinned objects into existing local caches without checkout or execution. A new machine needs its own access; a Notion link alone does not provide offline bytes. Report Git wire bytes as unknown when not measured, never as free traffic.

For a read-only GitHub API broker, set machine-local `NTN_SKILLS_GITHUB_API_URL` to its complete REST prefix. Both metadata and fixed blob reads use it; standard JSON/base64 blobs are checked against original OID/length/hash, never followed to a download URL. Custom gateways receive only an explicit `NTN_SKILLS_GITHUB_TOKEN`, or no client credential. Never copy the official gh/GH_TOKEN credential to a gateway or put these settings in Notion.

Without a custom API, authentication precedence is the dedicated token, GH_TOKEN, GITHUB_TOKEN, then the existing `gh` active session for github.com. The lookup is lazy, bounded, noninteractive and cached within an operation. Do not run login/refresh/setup-git to make verification pass. `NTN_SKILLS_GITHUB_AUTH=anonymous` opts out; an explicitly isolated SDK env cannot borrow another HOME or host token. `source inspect` reports only API and authentication-source metadata.

Auto transport prefers configured/authenticated API; an explicitly chosen API failure does not silently switch hosts. Rate limits and permission/integrity failures stop with safe diagnostics, not credential rotation or anonymous retries. No setting here enables sources, completes an old partial import, or changes a fixed version. Existing user-owned public brokers remain opt-in and obey their own shared budgets.

Use `member-prepare SOURCE_ID --entry LIBRARY_ENTRY --target PAGE_ID --member EXACT_NEW_MEMBER --output PLAN` for an explicit path rebind, or replace `--member` with `--retain-removed` to detach a confirmed removed member while preserving its selected bytes and custom content. Execute with `member-apply`; inspect with `member-reconcile`. These decisions preserve user relations and old pins, do not infer renames, and do not automatically select a new revision.

## Select a fixed shared source

Use an exact authorized commit and repository-relative root:

```bash
ntn-skills ctl library source inspect https://github.com/OWNER/REPOSITORY --commit FULL_COMMIT --root skills/example
ntn-skills ctl library source register SKILL_PAGE_ID --entry LIBRARY_ENTRY \
  --url https://github.com/OWNER/REPOSITORY --commit FULL_COMMIT --root skills/example
ntn-skills ctl library source select prepare SKILL_PAGE_ID --entry LIBRARY_ENTRY \
  --source SOURCE_ID_FROM_REGISTER --output ./source-selection.json
ntn-skills ctl library source select apply ./source-selection.json --entry LIBRARY_ENTRY
```

`FULL_COMMIT` is the complete immutable 40-character Git commit. Register creates the fixed source identity; selection changes only the native Source property. The CLI generates the selection plan. Preserve it unchanged for execution or reconciliation. Use `--native` instead of `--source` when deliberately clearing Source. Use `--dry-run` on selection apply when a preview is needed.

Current consumption uses the selected revision. Updating to a later commit requires that explicit new selection. Customized Notion files retain their whole bodies; delegate an intentional `restore-follow` to content maintenance. Name, Description, Default Context and Router Members stay native Notion metadata.

Advanced HTTP/local composition accepts a fixed plan through `ctl library source composition inspect PLAN_JSON --verify` and `composition register SKILL_PAGE_ID --entry LIBRARY_ENTRY --manifest PLAN_JSON`. Consult its actual help and [source and synchronization decisions](references/synchronization.md). Local Provider bindings are explicit machine/workspace read permissions, separate from old two-way sync bindings. Machine roots and signed HTTP retrieval addresses remain machine-only. Never copy credentials or silently upload local resource bytes.

To share an exact complete local snapshot containing restricted local bytes, use `ctl library snapshot save SNAPSHOT_ID --entry LIBRARY_ENTRY --allow-local-archive` only within that archive's explicit scope. This authorizes the selected bytes once and preserves durable restrictions; restore-follow's same-named flag covers only its selected body.

## Choose shared Profile and View defaults

```bash
ntn-skills ctl views --database LIBRARY_ENTRY
ntn-skills ctl library profile show PROFILE_ID --entry LIBRARY_ENTRY
ntn-skills list --profile PROFILE_ID --database LIBRARY_ENTRY
ntn-skills ctl library profile bind PROFILE_ID --entry LIBRARY_ENTRY
ntn-skills list --default-view
```

Use `profile list` to discover IDs. When changing rules, `profile set` requires the full `--name`, `--enabled true|false` and exact `--base` revision from `show`; `--base new` is for a new Profile. Supply `--default-view VIEW_ID` intentionally: omitting it clears the old default. The machine stores only entry and Profile ID. `profile unbind` leaves shared rules intact.

Shared freshness rules use `profile set ... --freshness-json JSON` with `default` and optional `skills` entries keyed by stable `skill_id`. `read_max_age_ms` governs current-content revalidation and `source_check_max_age_ms` governs source checks; neither is a storage-retention age. Use `profile freshness PROFILE_ID --entry ENTRY --skill STABLE_SKILL_ID` to inspect the resolved rule. Explicit request policy takes precedence, then the Skill rule, then the shared default, then the product default. A current cache hit retains its original validation time; TTL expiry requests revalidation and does not erase a fixed pin or silently advance an active Pi workflow.

Explicit `list --view VIEW_ID --database LIBRARY_ENTRY` takes precedence. Without a default View, use the first View in API order. Bare `list` discovers the accessible source scope; follow `next_cursor` while `has_more` is true for the complete observation. Profile/View choices do not grant access or activate workflow bodies; hosts own session selection and first-submission timing.

## Resolve the original operation

Shared source registration uses `ctl library source reconcile SKILL_PAGE_ID --entry LIBRARY_ENTRY --source ORIGINAL_SOURCE_ID`; source selection uses `source select reconcile ORIGINAL_PLAN --entry LIBRARY_ENTRY`. For a Profile revision, repeat its complete original `profile set` arguments with `--reconcile`. These paths inspect retained original facts without replaying unknown mutations. Current property equality is insufficient proof.

If an original result belongs to a different operation family, retain its returned IDs and recovery action. Do not convert it into a Source plan, reconnect the content or infer ownership from a display name.

Report verified changed/unchanged results, conflicts and unresolved items separately. Use [source and synchronization decisions](references/synchronization.md) for scoped recovery details; keep the selected Source, actual page content and independently verified consumption separate.


### Review a known retained import failure

For a verified known semantic readback failure, use the existing `sources recovery review ORIGINAL_PLAN --operation ORIGINAL_CREATE_ID --target ORIGINAL_MAIN_PAGE --entry ENTRY --output REVIEW_FILE`. A saved onboarding parent needs the exact child operation; do not extract or edit it yourself. Follow the returned read-only preview with the saved `--review` and exact `--review-id`, then explicitly apply that reviewed original operation and reconcile it. Unknown requests and missing original ACKs remain blocked.

This retained path preserves policy14, original input/source, native pages, failed outcome and disabled state. It requires no published ownership events yet, a complete original journal/ACK prefix and current complete semantically equal bodies. It retains independent review/completion proofs and creates only unissued original files through the same producer; existing bodies are never replaced. A changed body or Source invalidates the approval. Cross-machine cold readers require the complete shared proof, not author caches or a success label.

### Repair a known original-main table literal

Only for the acknowledged retained-import main before its first manifest, `sources recovery repair review ORIGINAL_PLAN --operation ORIGINAL_CREATE_ID --target ORIGINAL_MAIN_PAGE --entry ENTRY --output REPAIR_FILE` can review a known ordinary-table `+` to bullet corruption. It rejects other text, code, link or human changes. Follow its returned dry-run, then explicitly apply the same `--review` and `--review-id`. This separately authorized full-preimage update preserves the original page, input/policy and disabled state; it is not a new Skill or an automatic retry.

Reconcile the independent repair before previewing and continuing the original onboarding plan. Repair completion is not import completion. An unknown repair blocks the original import even when current text looks correct; do not use another command or new review to bypass it. A rejected file POST or a persisted import terminal is a different operation state. The complete private review contains the preimage and ACK; use the bounded summary in context and retain the file unchanged.

A v17 repair uses a presentation span for ordinary table plus characters. A prior frozen v16 escape attempt is not rewritten: only its complete durable response proving the exact unchanged body can support a new separately reviewed v17 request. The new private review commits the previous full review and body ACK. Unknown prior writes, changed text, a successful prior repair and rejected file POSTs do not qualify. Preserve both reviews and never edit the old plan or journal.

### Repair exact physical supporting-file table content

For a retained known import failure in an already allocated supporting file, use `sources recovery repair-file review ORIGINAL_PLAN --operation ORIGINAL_CREATE_ID --target ORIGINAL_MAIN_PAGE --path EXACT_FILE --entry ENTRY --output FILE_REPAIR`. It supports one physically verified native table-code padding defect, not general whitespace normalization. Follow its saved review, dry-run and explicit apply. The core retains the complete preimage and original allocation ACKs, updates one original table row, and verifies the complete file. It does not reimport the page or create replacements.

The same command can produce a v2 review for ordinary table hyphens changed into bullets, only when the exact correction proves the entire original text, code and destinations. It binds up to 32 original physical rows; code-bearing or linked changed rows and authored bullets are not normalized. A partial real ACK prefix yields `repair_pending` and an exact read-only preview. Resume only its unsent suffix; unknown rows never authorize repetition. Completion requires every original row ACK and the complete before/after bodies. Historical v1 code-marker reviews remain unchanged.

Reconcile the independent repair before inspecting the original `sources recovery review`. An existing authorized review stays unchanged; the command verifies later allocations as the original contiguous ACK prefix. Additional independently authorized, complete file repairs are bound in the extended final completion, not written into the old review. Cold clients require every original allocation, row ACK and before/after body. Unknown responses remain pending even when current content looks correct. Preserve the original failure and file identity. New validation errors expose only bounded structural hints and safe request IDs; diagnostics absent from an earlier receipt remain unknown, not permission to repeat a native request.

### Review a new request after a definitive file rejection

For a supporting-file POST with a complete original `400 validation_error` negative receipt and no allocation ACK, use `sources recovery resubmit-file review ORIGINAL_PLAN --operation ORIGINAL_CREATE_ID --target ORIGINAL_MAIN_PAGE --path EXACT_FILE --entry ENTRY --output FILE_RESUBMISSION`. Preserve the complete private review, original dispatch and rejection. Keep only the returned identity, hashes and change counts in context. Follow its exact dry-run, explicit apply and read-only reconcile.

The supported `native_image_blocks_v1` candidate separates adjacent image-only content into independent paragraphs while retaining every original image and outer link. It leaves mixed text, lists, code, tables, HTML and old projection policies unchanged. The new request needs its own identity, actual ACK and complete semantic readback; it never replays the rejected POST or supplies that old operation with a new ACK. Missing evidence, changed original input/Source/owner/prefix and unknown requests remain blocked. A completed file is not a completed Skill: reconcile the unchanged original creation and its saved recovery review before continuing its remaining work. Do not require a replacement for an existing original recovery review.

If that first independent image request also has a complete definitive rejection and no ACK, an explicit `--wire-policy native_linked_images_v2` review can retain its entire earlier proof and separate a standalone linked image into the original image plus an explicit text link. Both image and destination remain; original source bytes do not change. The old review, request, failure and slot are immutable. This is a scoped presentation policy, never permission to ignore general text/link differences or retry an unknown POST. Dry-run checks eligibility, not provider parser acceptance.

For a new failure, check the latest operation/request receipts, not only an older checkpoint. Distinguish transport/403, definitive validation/400, acknowledged readback mismatch and unknown writes. Reproduce the exact frozen offending fragment and a one-change positive control in the existing isolated verification library before changing the core; retain failures and clean up only proved owned test pages. A successful fragment is not proof of whole-document import. Preserve finite diagnostics such as `standalone_image` without provider text, credentials or source-body dumps; record the confirmed cause and remaining boundary in the original Issue and verification entry.
