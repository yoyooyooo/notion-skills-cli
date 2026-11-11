# Resource state and editable-page protection

Use this map for AH-686, AH-687 and AH-688 before changing their implementation. Start from the actual product commit and package identity; the formal planning branch is an input, not the product baseline. Keep raw evidence outside the checkout.

| Feature | Public observation | Positive case | Failure or counterexample | Evidence |
| --- | --- | --- | --- | --- |
| NR01-state | `ctl library state TARGET --entry ENTRY` | Candidate C2, selected C1, recorded display C1, custom N1 with C1 ancestry, and an independently supplied session pin remain distinct | Missing observations, permission unknown, pending operations, renamed properties, duplicate IDs and incompatible owners never become synced | Pure reconstruction, current CLI, isolated real Notion fixture, installed Node CLI |
| NR02-protection | `ctl library inspect ENTRY` capabilities, `automaticSourceStops` and the isolated `requireSafeBodyReplacement` helper | Automatic projection refuses unsupported replacement before writes; explicit restore exposes its separate complete-body-match capability | Read, human edit, unconditional replace; edits after authorization or dispatch; partial string matching; lost response; guard removal | Official provider contract, controlled interleavings, owned-page HTTP and fresh readback; ProjectionRace covers refusal, not the explicit restore protocol |
| NR03-readonly | State inspection under the read-only Notion capability and semantic request ledger | Observations can read metadata, Records and exact bodies without changing owner or advancing selection | Adoption, repair, creation, update and archive writes are unavailable even through downstream calls; POST query and original-outcome inspection remain allowed | Capability boundary and HTTP ledger; ordinary current reads retain their separate adoption behavior; a complete audit SDK remains a separate task |

## Run and interpret

Read the current command help/schema before driving it. Use the existing `control.ts` source/installed entry and owned run isolation. Select exact fixture identities from creation receipts. Never edit the production four-table library to manufacture an example.

For NR01, retain every source revision and file-event identity. A persisted projection is a recorded baseline, not proof of the current page body. Read-only inspection must report whether that body was observed, whether its fingerprint still matches, and whether the result is incomplete. A custom baseline comes from its exact event ancestry, never the newest selected source or a page timestamp. A session pin identifies the caller's explicit fixed snapshot and does not alter current selection.

For NR02, a UI lock, confirmation, timestamp, shared Running field or a single local writer does not create a provider conditional write. Keep complete and partial string-match behavior separate from revision CAS. Retain before/after bodies and unknown outcomes. A supported preparation path plus an unsupported overwrite result may satisfy the capability task; it does not satisfy automatic projection.

An explicit changed-body restore has separate authority: retain the complete nonempty old body, revalidate the frozen input, use one full old-string match and require exact complete candidate readback. An equal-body restore writes no body. Neither path may replay an unknown write or imply atomic page revision protection. The [SS14 restore and request cases](shared-ssot.md#ss14--n07-native-file-lifecycle-and-restore-follow) cover this implementation; the original helper mutation does not prove it.

For NR03, record semantic writes separately from HTTP methods because Notion queries use POST. The read-only capability must reach all downstream observers; merely suppressing the last write does not pass. Verify ordinary current-read adoption through its existing tests.

Use `state --observe` as the public phase-one observation entry. For a real changed-body comparison, retain the owned fixture's body and complete Records before the call: it must report `requires_observation_commit` with zero writes and unchanged facts. Then run ordinary `read` on that same unchanged edited body and verify its established adoption behavior. Keep selected source and projection ancestry unchanged throughout. This comparison does not establish the later single-Skill audit's reference findings or library-wide coverage.

### Executable entry points

- `ctl library state TARGET --entry ENTRY --observe` reads current bodies and supported original pending outcomes. Use default mode first to preserve the distinction between recorded and observed facts.
- `ctl library sources prepare SOURCE_ID --entry ENTRY --target TARGET --output PLAN` freezes the optional candidate. Pass that complete JSON with `state --candidate PLAN`; state does not poll the provider or run apply preflight.
- Run an ordinary read to obtain `snapshot_id`, then `ctl library snapshot save SNAPSHOT_ID --entry ENTRY`. Pass its returned shared pin to `state --session-pin PIN`. This checks the selected historical manifest, not byte availability or a host's implicit active session.
- `node .cursor/skills/verify-ntn-skills/scripts/projection-race-probe.ts --help` describes the offline plan. An explicit `--live --entry OWNED_TEST_LIBRARY --run NEW_ABSOLUTE_DIRECTORY` creates new owned pages only; `--case NAME` selects one scenario. Inspect original pages with `--inspect --run EXISTING_DIRECTORY`, which performs zero remote writes and never replays a run.
- `node .cursor/skills/verify-ntn-skills/scripts/native-state-readonly-probe.ts --live --fixture RECEIPT_JSON --cli FROZEN_CLI_MJS --run NEW_ABSOLUTE_DIRECTORY` inspects an existing owned main-plus-files receipt from `shared-library-probe.ts`. It compares metadata, complete bodies and paginated Records before and after default/observed/default CLI calls. This native-only case proves no implicit adoption; it does not cover the C2/C1/N1 source sample or independently installed package.
- Run `notion-readonly`, `notion-readonly-observation`, `notion-body-capability`, `shared-file-observer-readonly` and `shared-resource-state` tests under `packages/core/test`. The [formal verification Skill](../../verify-notion-resource-lifecycle/SKILL.md) owns the model, exact source hashes and real-guard mutations.

Probe editor actions are authenticated API simulations, not evidence of a human using the Notion UI. Overlapping HTTP request windows do not prove server commit order. Response-loss injection observes an actual successful request before failing the client result; its read-only diagnostic recovery does not establish product-journal recovery.

## Work ownership for this implementation

The state implementation owns a new `shared-resource-state` module, its focused tests, and the `state` command in `commands-library.ts`. The protection implementation owns `shared-file-state.ts` capability/guard changes and the owned-page probe. Formal integration owns `verification/models/resource-lifecycle`, its existing check scripts and the formal verification Skill. Coordinate shared imports, package scripts and this map through the main implementer. Do not rewrite another work stream's files or clear user state.

Formal checks must trace the exact current symbols and hashes before advancing `coverage.json`. UpdateCommit and AuditRun now have the bounded implementation correspondence recorded there; neither proves all source dispatches, SQLite durability or real audit coverage. A model result, controlled service result, live Notion result, installed package result and actual Pi result are separate claims. Record missing gates explicitly.
