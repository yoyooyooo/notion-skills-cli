# Brand marks
Use a brand mark only when a real product, provider, model family, channel, or<br>service identity helps the reader. Semantic `type` still explains what the node<br>does; `brand` explains whose product it is.
## Agent decision path
1. Search the built-in catalogue when the request names a recognizable brand:
	```bash
node bin/archify.mjs brands "Claude" --json
	```
2. Put the returned canonical ID in the node, participant, or state:
	```json
{
  "id": "planner",
  "type": "backend",
  "label": "Claude",
  "brand": "claude"
}
	```
3. If there is no catalogue match and the user supplied the official website,<br>capture its icon explicitly:
	```bash
node bin/archify.mjs brands capture "https://partner.example.com" --json
	```
	Put the command's digest-pinned `brand` value in the authored node:
	```json
{
  "id": "partner",
  "type": "external",
  "label": "Partner portal",
  "brand": {
    "url": "https://partner.example.com",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
	```
4. If there is no match and no user-provided URL, omit `brand`. Do not invent a<br>URL or silently assign a visually similar company.
Known-brand URLs resolve to the bundled vector instead of using the network.<br>For discovered icon `href` attributes, capture decodes the basic named references<br>`amp`, `quot`, `apos`, `lt`, `gt` (and their defined uppercase aliases), plus<br>decimal and hexadecimal numeric references, once before URL resolution. Thus<br>`/icon.png?v=1&amp;size=32` requests `/icon.png?v=1&size=32`. URL percent escapes<br>remain intact; nested escapes are not decoded recursively. This bounded decoder<br>does not add a general HTML parser or support every named HTML entity.<br>HTML reads stop at an explicit head ending outside comments, raw-text elements<br>and quoted attributes, including when those tokens span network chunks. The<br>256 KiB head limit and capture deadline still apply; a larger body after the<br>head is not read for icon discovery.<br>Icon candidates come from complete `link` tags outside comments, raw text and<br>template contents. Attribute values and lookalike names such as `data-href`<br>cannot supply icon declarations; quoted `>` characters stay within their tags.<br>For `text/html`, discovery treats `noscript` contents as raw text, matching<br>scripting-enabled HTML parsing; capture does not execute scripts. This exclusion<br>does not apply to `application/xhtml+xml`, where `noscript` links remain<br>discoverable. XHTML empty elements such as `<script />` and `<template />` do not<br>hide following links; the same trailing slash does not close those elements in<br>`text/html`.<br>Unknown URL capture accepts only bounded raster image formats, blocks<br>credentials, nonstandard public ports, and private or link-local destinations,<br>uses bounded concurrency and one total deadline, and returns the captured<br>content digest. Later render and validate operations require that exact digest;<br>blocked, unavailable, changed, oversized, or unsafe content fails closed instead<br>of silently changing the artifact.
Remote-brand provenance in capture receipts, node metadata and SVG/HTML keeps<br>the source URL's HTTP(S) scheme, host, port and path, but omits userinfo, query<br>strings and fragments. The authored `brand.url` and all download/redirect URLs<br>remain unchanged so existing pins still reproduce the same bytes and digest.<br>Credential-bearing download URLs remain rejected. Built-in marks retain their<br>recorded catalogue provenance.
The public source link identifies the original site/path, not necessarily a<br>downloadable asset: removing a signed query or a query-based page selector can<br>make that link unusable or less specific. Prefer capturing a stable public<br>landing page that exposes the intended icon when one is available; do not edit<br>an existing pin's URL without capturing and verifying that source again. Paths<br>are retained, so this normalization is not a general URL-secret scrubber.
After upgrading from a version that captured inactive HTML markup (including<br>`noscript`), an existing URL pin may fail with `brand/digest-mismatch` because<br>discovery now selects a different icon. Inspect the intended icon, rerun the<br>capture command above for the same URL, and explicitly replace the authored<br>`brand` value with the returned pin. Existing pins are not rewritten<br>automatically, and digest verification remains enforced.
For ICO captures, every directory entry must reference a non-empty image range<br>after the complete directory and within the downloaded file. This bounds check<br>also applies when reproducing a pinned capture. PNG/DIB payloads, multiple<br>images, shared or out-of-order ranges, and trailing bytes remain supported;<br>the check does not decode pixels or guarantee that an otherwise bounded payload<br>is decodable. A rejected ICO candidate does not prevent trying later icons.
Page, icon and redirect requests send `Accept-Encoding: identity`. Capture does<br>not decompress response bodies: a successful response declaring another content<br>coding is closed and rejected explicitly. This keeps the existing byte limits<br>and pinned digest tied to the unencoded representation. A later usable icon may<br>still succeed; otherwise an encoding error is retained instead of being hidden<br>by an unrelated favicon 404.
The final artifact never fetches a brand asset when opened. Preset vectors and<br>digest-verified captured site icons remain embedded in SVG, PNG, WebP, JPEG,<br>Share Card, and WebM exports.
Use `node bin/archify.mjs brands --json` to inspect all canonical IDs, aliases,<br>categories, domains, and provenance. Current categories cover AI, cloud,<br>engineering, data, collaboration, business systems, channels, languages, and<br>frameworks.
