# Search remote Notion content

Content search uses the hosted Notion MCP service and keeps the existing REST
consumer. It does not create a local full-text index. Start with the current
Skills database entry and keep the four library tables shared with your REST
integration.

## Connect search

REST and MCP use separate credentials:

| Credential | Used for |
| --- | --- |
| `NOTION_API_TOKEN` or the existing REST configuration | Verify the library, current Skill/File ownership and eligibility; read or consume selected content |
| `NOTION_MCP_TOKEN`, a saved MCP token, or an OAuth grant | Ask the hosted Notion service to search its remote index |

A REST integration token is not automatically sent to MCP. An MCP grant does not
replace the REST integration or widen its access.

Choose one MCP connection method.

### Use an explicit MCP bearer token

Provide a bearer token accepted by the hosted Notion MCP service through
`NOTION_MCP_TOKEN`, or pipe it from your secret source:

```sh
your-secret-command | ntn-skills auth mcp set-token --stdin
ntn-skills auth mcp status
```

The environment token has priority over a saved MCP token. Both have priority
over an OAuth grant. If the selected explicit token fails, the operation reports
that failure. It does not silently authorize or use another account.

`status` reports the selected credential source and saved connection state. It
does not print a token or validate a token by itself. Search performs the remote
identity and access checks.

### Authorize in a browser

When no explicit MCP token is selected:

```sh
ntn-skills auth mcp login
ntn-skills auth mcp status
```

The CLI opens the hosted consent page and waits for its local callback. Complete
authorization for the intended workspace and user. The CLI validates that
identity before saving the grant. Use `--no-browser` to print the authorization
URL on stderr and open it yourself. This explicit login still has a deadline.

Saved grants are reused. Refresh replaces the access and refresh tokens
together under a same-host lock. If a refresh may have reached the provider but
its outcome cannot be established, the old refresh token is not replayed.
Run an explicit login to recover that connection.

To remove the OAuth grant:

```sh
ntn-skills auth mcp logout
```

Logout does not remove a separately configured MCP token. Use
`ntn-skills auth mcp clear-token` to remove the saved token, and unset
`NOTION_MCP_TOKEN` to stop selecting an environment token. Auth commands support
`--profile`; CLI content search uses the default MCP profile. SDK callers can
select a profile explicitly.

## Search the library

```sh
ntn-skills list --database LIBRARY_ENTRY --search-in content --query "release checklist"
ntn-skills list --database LIBRARY_ENTRY --search-in content --query "中文关键词" --limit 10
```

Content search requires a nonempty query and one explicit library entry. It
always checks current remote eligibility. It does not use a cached directory or
View as an authority. An Enabled Skill can be discovered even when Default
Context is false or it is outside the default View.

The limit is 1–50, with a default of 20. It bounds the remote matches before local
eligibility filtering; fewer records may be returned. Each accepted match must
map to an exact current Skill, or to a supporting File with one exact current
owner. Disabled, unavailable, conflicting, unrelated-table and foreign-library
candidates cannot publish their titles or snippets. A Source-backed main file
and any matched supporting file also require a current enabled Source.

Search does not adopt instructions, change the active root or Requires graph,
or fetch Git/resource bytes. Use the returned Skill ref with the existing
`read` or `use` operation when you want those effects.

### Interpret results

Every result has `coverage: "remote_non_exhaustive"` and `exhaustive: false`.
A match carries `kind: "notion_remote_match"`, its physical Notion page and one
of these representations:

| Representation | Meaning |
| --- | --- |
| `native` | A match on the main Notion page of a native Skill |
| `projection` | A match on the Notion presentation of content whose authoritative bytes are elsewhere |
| `supporting_file` | A matched File page mapped to its current owner Skill |

The provider can match titles, text, nested content or display projections.
A match does not establish an exact substring in the bytes that a later
consumer will use. An empty result does not establish absence: remote indexing,
ranking, result limits and eligibility filtering can all affect it. In
particular, Git bytes and their Notion projection can differ.

`partial` records local filtering, remote notices or a filled remote result
limit. A false value still does not mean exhaustive coverage. Notices use fixed
local messages; raw provider diagnostics and unadmitted snippets do not pass
through to the caller.

The hosted search contract currently provides no continuation cursor. This
version returns `next_cursor: null` and rejects content cursors. It also rejects
View/Profile selection, offline/cache policies and REST-only metrics for
content search. Use the default metadata mode for paginated Name, alias and
Description filtering.

## Pi integration

A compatible Broker exposes `notion_list` with
`search_in: "metadata" | "content"`; metadata remains the default. When several
enabled Notion sources exist, content search requires an explicit source.

On an interactive Pi TUI, a first content request can open the browser and wait
for authorization. The pending request resumes with its original parameters.
Esc cancels that caller. Concurrent callers retain separate cancellation owners.
Leaving a session or changing its accepted qualification retires results from
the old request, including empty results and failures.

RPC, print and JSON execution do not open an authorization UI. They can use an
already valid credential; otherwise they return the explicit login action.
When the Notion feature is disabled, its dedicated tools are not registered and
it does not initiate Notion authentication or network work.

## SDK contract

`ntn-skills/sdk` exports `CONTENT_SEARCH_CONTRACT_VERSION = 1`,
`contentSearch`, `mcpAuthStatus`, `mcpLogin`, `mcpLogout` and `mcpSetToken`.
MCP auth functions do not acquire the REST service. The public API returns
connection metadata, never credentials.

`contentSearch({ query, limit }, { database, env, cwd, signal, deadline,
onAuthorize })` uses one captured environment and an absolute overall deadline.
The default overall budget is six minutes, with at most five minutes for
authorization and one minute for search and admission. REST preflight is
bounded separately. `onAuthorize` receives the URL, that caller's presentation
signal and deadline; resolving the presentation means that it was shown, not
that consent succeeded. Headless callers should omit it.

Credential selection, callback parsing and token rotation are covered by the
[auth model suite](../verification/models/notion-mcp-auth/README.md). Physical
admission and publication correspondence are documented in the
[search model suite](../verification/models/notion-mcp-search/README.md).
These are bounded models with concrete regression and guard-mutation checks,
not proofs of remote indexing completeness or atomic external permissions.
