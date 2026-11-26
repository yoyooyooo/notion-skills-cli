# Hosted Notion MCP authorization and refresh

This suite preserves the reviewed AH-1268 AuthAcquisition v5 and RefreshRotation v7 design models and binds selected guards to the current core implementation. It is not a production refinement proof. The exact source bytes, complete case inventory and frozen tools are checked by the existing runner.

## Run

Use the same statechart commit and TLC 1.7.4 jar pinned by the other active suites. Set absolute `PSTACK_STATECHART_ROOT` and `TLA2TOOLS`; put the maintained Java runtime on PATH. Install dependencies only in the existing isolated build/run environment.

```sh
node --test scripts/formal-result-contract.test.mjs scripts/formal-runner-contract.test.mjs
node scripts/verify-formal.mjs --suite notion-mcp-auth --out /absolute/new-mcp-model-run
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/notion-mcp-auth.node.test.ts packages/core/test/notion-mcp-credential-store.node.test.ts
python3 scripts/check-formal-mutations.py --suite notion-mcp-auth --out /absolute/new-mcp-mutation-run
```

The model runner must execute all 31 configurations: AuthAcquisition has six candidates, twelve intentional defects and three reachability witnesses; RefreshRotation has two candidates, seven intentional defects and one reachability witness. Witnesses intentionally falsify `NoSuccessfulPair` or `NoLocalCancelSuccess` to prove a successful path is reachable. They are not product defects. `--model AuthAcquisition` or `--model RefreshRotation` selects that model's complete inventory.

Use a new external output directory on every attempt and retain failures. A paired run without Git metadata must obtain independent metadata with a task-owned `git clone --no-checkout --no-hardlinks`, then populate that private checkout with the frozen build source and its run-local dependency links. Verify equality with the frozen source hashes before running. Do not point `GIT_DIR` at the active editable pair. A baseline commit is not a claim that the uncommitted reviewed bytes are already committed.

## Model and implementation boundaries

| Model step | Production owner | Concrete evidence |
| --- | --- | --- |
| Credential selection and per-waiter ownership | `explicit`, `waitForFlight` | Explicit token priority/no fallback; cancelled waiter leaves the survivor and its presentation alive |
| Callback acceptance and code exchange | `callbackListener`, `authorize` | Real loopback HTTP state/issuer/resource/redirect checks; foreign-process logout before dispatch |
| Grant and caller publication | `authorize`, `credential.assertCurrent`, store `publish` | Foreign-process logout during identity resolution; current-time checks; late write cannot replace durable bytes |
| Acquire and reread | store `transaction`, `withLocalLocks` | Two real Node processes wait on one same-host fence and reuse the rotated winner; a normally retired fence requires a new acquisition before rereading its marker |
| Mark, send and commit | `refreshGrant`, store `publish` | Server observes a pending disk marker before consuming RT; new AT/RT and idle marker appear together |
| Timeout/crash takeover | `resolveMcpCredential`, `refreshGrant` | Independent successor deadline; SIGKILL after server consumption; no replay and explicit recovery |

The original [authorization scope](AuthAcquisition.scope.md) and [refresh scope](RefreshRotation.scope.md) are retained with their finite bounds, review corrections and assumptions. Callback validation is one abstract predicate, storage writes are abstract durable atomic events, and each finite actor has a bounded clock. Real crypto, parser, lock and fsync behavior comes from concrete tests and reviewed code, not TLC. The auth model's Enabled and session change inputs belong to Broker; this core suite does not prove that host admission or its ticket fence.

A normal owner can release its fence between a contender's failed `mkdir` and first `lstat`. That absence returns to the existing bounded contention loop. The controlled process regression retires the real fence at this boundary and verifies that the successor reacquires its own owner receipt before reading the retained refresh marker. The marker still prevents another refresh dispatch. This filesystem schedule does not add a finite-model property.

The implementation records each authorization waiter's signal and absolute deadline. Exchange, grant commit and the final atomic file publication recheck that at least one owner remains live; a timer that has not yet run is not evidence of eligibility. Controlled wall-clock advancement reproduces this boundary without waiting for the timer. An expired waiter still rejects at resume while a different live owner can finish the shared authorization. The lock-removal mutation separately detects failure to wait for and reuse a live winner; its pending-marker guard still prevents duplicate dispatch, so this test does not claim to observe overlapping HTTP.

Refresh `Reject` represents a terminal grant rejection. Production separately recognizes a pinned, parsed OAuth `invalid_scope` rejection as issuing no token; it may restore the unchanged grant without automatic retry. HTTP 403/429 or ambiguous transport failure keep the marker because status alone cannot establish that RT was unused. These HTTP classifications are concrete tests, not additional finite properties.

The views keep all actions and violation combinations. Their optional `forConfig` export binds labels to the checked configuration and expands the no-timeout temporal trace; a removed lock/reread must not be labelled as present.

## Maintenance

Use [the existing consumption verification Skill](../../../.cursor/skills/verify-notion-consumption/SKILL.md) and [formal maintenance](../../../docs/formal-verification-maintenance.md). Do not add another runner or weaken an expected rule list to obtain a green result. Every actual guard mutation must pass its baseline, fail a behavioral assertion with the guard removed, restore the exact original bytes and pass again. A syntax/import error is not a detected behavioral fault. The uncertainty and pre-exchange cases deliberately remove all corresponding defensive checks and must be labelled as compound mutations.
