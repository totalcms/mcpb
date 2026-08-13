# Build Report - Total CMS MCPB Desktop Extension

Built 2026-08-11/12 per `/Users/joeworkman/Developer/totalcms/docs/planning/mcpb-totalcms.md`.
Repo: `/Users/joeworkman/Developer/totalcms-mcpb`, git-initialized, **nothing committed** -
everything below is uncommitted working-tree state for your review.

## 1. Spike outcome: mcp-remote vs hand-rolled

**Decision: hand-rolled**, built directly on `@modelcontextprotocol/sdk`.

Installed `mcp-remote@0.1.38` and read its source (`dist/chunk-65X3S4HB.js`,
`dist/proxy.js`) rather than just the README, to check the actual trigger
conditions for its OAuth behavior:

- `runProxy()` unconditionally calls `discoverOAuthServerInfo()` on every
  startup ("Discovering OAuth server configuration...") - extra requests
  even when the target has no OAuth and doesn't need it.
- More importantly: `connectToRemoteServer()` / `StreamableHTTPClientTransport.send()`
  branch on `response.status === 401`, and whenever a 401 comes back it goes
  into `NodeOAuthClientProvider` -> `await open(sanitizeUrl(authorizationUrl))`
  (line ~21134 of the chunk) - it launches a real browser to a dynamically
  discovered authorization URL, and spins up a local HTTP callback server
  that waits `authTimeoutMs` (default 30s) for a code.
- I grepped `parseCommandLineArgs` for every flag mcp-remote supports
  (`--header`, `--transport`, `--allow-http`, `--debug`, `--silent`,
  `--static-oauth-client-metadata`, `--static-oauth-client-info`,
  `--resource`, `--ignore-tool`, `--auth-timeout`, `--enable-proxy`,
  `--host`) - there is no flag to suppress the 401-triggers-OAuth-popup
  behavior. `--header` only adds request headers; it doesn't change what
  happens when the server rejects them.

This is fatal for our use case. Total CMS's MCP endpoint uses a plain
`X-API-Key` header, not OAuth, and **does** answer a bad key with a real
HTTP 401 - live-verified below: `WWW-Authenticate: Bearer realm="MCP",
error="invalid_token", resource_metadata="https://totalcms.co/.well-known/oauth-protected-resource"`.
That `WWW-Authenticate` header is exactly the trigger mcp-remote watches for.
Wrapping it would mean a customer who fat-fingers their API key gets a
browser window popping open trying to OAuth against an endpoint that doesn't
implement OAuth for this purpose, instead of a clean "invalid key" error back
in Claude. Per the spec's own fallback criterion ("if mcp-remote insists on
OAuth flows or browser popups for non-OAuth servers, hand-roll the proxy"),
that's what this build does.

**The hand-rolled bridge** (`src/index.ts`, ~140 lines) is a raw
`Transport`-to-`Transport` message pump:

- `StdioServerTransport` (local side, talks to Claude Desktop over stdio)
- `StreamableHTTPClientTransport` (remote side, talks to the Total CMS `/mcp`
  endpoint), constructed with **no `authProvider`** and a `requestInit.headers`
  containing `X-API-Key` only when `API_KEY` is non-empty
- Every `JSONRPCMessage` from either side is forwarded to the other verbatim
  - this covers `initialize`, `tools/list`, `tools/call`, `resources/*`,
  `prompts/*`, and all notifications with no per-method special-casing,
  because both transports operate at the raw message level.
- Since no `authProvider` is passed, a 401 makes `remote.send()` reject with
  a `StreamableHTTPError` instead of trying to authenticate. The bridge
  catches that per-request and turns it into a proper JSON-RPC error
  response (code `-32000`) sent back over stdio, so the MCP client sees a
  clean error rather than a hang.

## 2. File inventory

```
totalcms-mcpb/
  manifest.json          MCPB manifest (v0.4), validated against the real schema
  package.json            build scripts (typecheck / build / pack / validate)
  package-lock.json
  tsconfig.json
  esbuild.config.js       bundles src/index.ts -> server/index.js (ESM, node18 target)
  .gitignore              node_modules/, dist/, server/*.js (build output)
  .mcpbignore              keeps the packed bundle to manifest+package.json+server/index.js
  src/
    index.ts              the hand-rolled bridge (source of truth)
  server/
    index.js               esbuild output, git-ignored, regenerate with `npm run build`
  dist/
    totalcms.mcpb          packed bundle, git-ignored, regenerate with `npm run build`
  README.md               setup docs + Privacy Policy section (links totalcms.co/privacy)
  BUILD-REPORT.md         this file
```

`server/index.js` is a single self-contained ESM bundle (279 KB) with the
entire `@modelcontextprotocol/sdk` dependency tree inlined - no
`node_modules` needed at runtime, confirmed by the packed bundle containing
only `manifest.json` + `package.json` + `README.md` + `server/index.js`
(59.9 KB packed, 287 KB unpacked, 4 files).

## 3. Manifest vs. spec sketch - what changed after real schema validation

Fetched the actual v0.4 schema from the installed `@anthropic-ai/mcpb@2.1.2`
package (`schemas/mcpb-manifest-v0.4.schema.json`) rather than trusting the
spec's hand-written sketch. Differences:

- `user_config.*` entries require `type`, `title`, **and `description`**
  (the spec sketch omitted `description`) - added descriptive text for both
  `mcpUrl` and `apiKey`.
- Added `long_description`, `homepage`, `documentation`, `support`,
  `keywords`, `compatibility.runtimes.node` - all valid optional v0.4 fields
  that strengthen the eventual directory listing.
- Did **not** include a top-level `icon` field or `license` field (see Open
  Items - both are Joe's call, not fabricated here).
- `privacy_policies` (array of URIs) and `author.url` kept as the spec
  specified.

`npx @anthropic-ai/mcpb validate manifest.json` -> **"Manifest schema
validation passes!"**

## 4. Live verification transcript (against https://totalcms.co/mcp)

All four required checks pass. Full JSON transcripts are in the scratchpad
test harness output; key excerpts below.

**1. Zero-config, no API key** - `MCP_URL=https://totalcms.co/mcp`
- `initialize` -> `result.serverInfo = {"name":"Total CMS","version":"3.5.0-rc.17",...}` ✅
- `tools/list` -> includes `docs_search` (full list: describe_collection,
  describe_view, docs_get, docs_lookup, **docs_search**, fetch,
  find_comparison, get_object, get_resource, get_view, latest_release,
  list_collections, list_views, needs_review, query_collection, query_view,
  search, search_collection, search_collections) ✅
- `tools/call docs_search {"query":"webhook"}` -> real results, top hit
  `automations/webhooks` "Webhooks" doc ✅

**2. Bad API key** - `MCP_URL=https://totalcms.co/mcp`, `API_KEY=bogus-mcpb-test`
- Direct curl confirms the server's real behavior:
  `HTTP/2 401` with `www-authenticate: Bearer realm="MCP", error="invalid_token", ...`
- Bridge surfaces this as a clean JSON-RPC error to the client:
  ```json
  {"jsonrpc":"2.0","id":1,"error":{"code":-32000,
    "message":"Streamable HTTP error: Error POSTing to endpoint: {\"error\":{\"message\":\"Invalid API key or insufficient permissions for MCP access.\"}}"}}
  ```
  Proves the `X-API-Key` header is actually transmitted (server-side
  key validation ran and rejected it) rather than being dropped and served
  anonymously. ✅ No API key value appears anywhere in stderr output at any
  point (checked explicitly).

**3. Insecure URL** - `MCP_URL=http://insecure.example`
- stderr: `[totalcms-mcpb] MCP_URL must use https:// (got "http://"). Plain-text credentials on the wire are not allowed. Refusing to start.`
- exit code 1, no network activity. ✅

**4. Validate + pack**
- `npx @anthropic-ai/mcpb validate manifest.json` -> passes ✅
- `npx @anthropic-ai/mcpb pack . dist/totalcms.mcpb` -> `dist/totalcms.mcpb`,
  59.9 KB, 4 files ✅
- `npx @anthropic-ai/mcpb info dist/totalcms.mcpb` -> reads back fine,
  correctly reports `WARNING: Not signed` (expected - signing is Joe's step)

`npm run build` runs typecheck -> esbuild -> validate -> pack end-to-end
cleanly from a `rm -rf server dist` state.

## 5. Open items for Joe

1. **Icon.** No current Total CMS 3 brand icon.png found anywhere in the
   repo or `~/Websites/totalcms.co`. The only candidate I found is
   `~/Websites/totalcms.co/t1/resources/icon.png` (256x256) - but that's
   under a `t1/` (Total CMS **1**, legacy) directory, so I did not assume
   it's current branding and did not use it. `manifest.json` has no `icon`
   field right now (it's optional in the v0.4 schema). Drop a real
   `icon.png` (square, ideally 256x256+) in the repo root and add
   `"icon": "icon.png"` to the manifest, then re-run `npm run build`.
2. **License.** Left `package.json`'s `license` as `"UNLICENSED"` and
   omitted `manifest.json`'s optional `license` field entirely rather than
   assume MIT or any other license on your behalf.
3. **Signing.** Not run (per instructions - `mcpb sign dist/totalcms.mcpb` is
   your step, needs your signing identity/cert).
4. **Drag-install test on a clean machine.** I could not test the actual
   Claude Desktop drag-and-drop install UX, the `user_config` form
   rendering, or the OS-keychain storage of the API key from this
   environment - only the underlying bridge process via direct stdio
   JSON-RPC. Worth doing before submission, especially on a machine with no
   Node toolchain (MCPB bundles are supposed to need none - `server/index.js`
   is fully self-contained, but this hasn't been verified via the real
   Claude Desktop launch path).
5. **Submission form.** Not started -
   https://clau.de/desktop-extention-submission per the spec. Repo is not
   yet pushed anywhere (task said git-init only, nothing committed).
6. **docs.totalcms.co page.** Spec task 6 ("Connect Claude Desktop" doc page
   + link from the MCP settings panel) is out of scope for this build task
   and not started.
7. **New public repo `totalcms/mcpb`.** Spec mentions this as the eventual
   home; current repo is local-only at
   `/Users/joeworkman/Developer/totalcms-mcpb`, git-initialized, no remote
   configured, nothing committed - all yours to review before any commit,
   push, or repo creation.
8. **Version pin.** `manifest.json` and `package.json` both start at
   `0.1.0` per the spec sketch; bump when you're ready to treat this as a
   real release.

## Commands to reproduce

```bash
cd /Users/joeworkman/Developer/totalcms-mcpb
npm install
npm run build      # tsc --noEmit && esbuild && mcpb validate && mcpb pack
# -> dist/totalcms.mcpb
```
