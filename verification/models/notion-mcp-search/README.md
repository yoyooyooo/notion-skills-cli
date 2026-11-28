# Hosted Notion MCP search admission

This suite preserves the reviewed SearchAdmission v4 design and binds selected
guards to the CLI/core implementation. It is a bounded model with concrete
regression obligations, not a production refinement proof.

## Run

Use the existing isolated build and run environment, the pinned statechart
checkout and TLC 1.7.4 jar, and the maintained Java runtime:

```sh
node scripts/verify-formal.mjs --suite notion-mcp-search --out /absolute/new-search-model-run
bun test packages/core/test/notion-mcp-search.test.ts packages/core/test/notion-mcp-client.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/sdk-mcp-search.node.test.ts
python3 scripts/check-formal-mutations.py --suite notion-mcp-search --out /absolute/new-search-mutation-run
```

All 23 configurations must run: seven candidates, fourteen intentional defects
and two reachability witnesses. The witnesses deliberately falsify
`NoNativeDisclosed` or `NoProjectionDisclosed` to demonstrate that the guarded
design can return a match. Preserve each configuration's full rule inventory,
expected broken set, temporal checks and NoDeadlock result.

Use a new output directory for each attempt. For paired sources without Git
metadata, clone the task-owned repository with
`git clone --no-checkout --no-hardlinks` into the private run, populate it with
the frozen source bytes and link the run's private dependencies. Compare all
source hashes before running. Do not point `GIT_DIR` at an editable checkout.
The recorded base commit and reviewed uncommitted source hashes mean different
things.

## Ownership and concrete guards

| Model obligation | Implementation owner | Concrete check |
| --- | --- | --- |
| REST and binding before dispatch | SDK `contentSearch` | REST preflight, verified MCP identity and fetch of the same physical library entry before query |
| Connection and epoch remain selected | SDK and auth core | Credential rereads; an OAuth refresh cannot silently switch grant/account |
| Authorized before disclosure | Core admission | Exact physical parent, one File owner, unique stable claims, Enabled/ready owner and current Source revision |
| Accepted denial survives later allow | Core admission | Claim observation participates in eligibility; a later enabled page cannot erase that denial |
| Late owner/File/Source changes retire candidates | Core admission | Fresh metadata at publication, including both the main Source and the matched File's Source |
| Workspace response and bounded presentation | MCP client | Observed standard `workspace_search.results` decoder, safe URL/ID equality and independent HTTP/SSE budgets |
| Empty does not prove absence | SDK and host | Non-exhaustive coverage and fixed notices for positive and empty results |
| Session ticket and pins | Broker | Separate consumer-state suite, actual host entry tests and installed Pi acceptance |

The eight mutations in `mutations.json` remove real guards from a private copy,
run the selected behavior test and restore the original bytes. They cover
retained disabled claims, the final Enabled read, the main Source of a supporting
match, final File binding, readiness at both boundaries, unique stable claims,
REST credential scope and workspace identity. The readiness case is explicitly
a compound mutation of both guards. A test failure must be a behavioral
assertion, not a syntax or setup error.

The [original design scope](SearchAdmission.scope.md) retains its finite bounds,
review corrections and assumptions. Source epochs represent accepted current
evidence; they cannot provide instantaneous knowledge of an external revocation.
The model abstracts all result batches to one result class and all physical
identity checks to predicates. It does not prove byte decoding, remote indexing
completeness or cross-repository refinement. Controlled HTTP, public SDK,
installed CLI/Broker and real browser/search evidence establish different parts
of the contract.
