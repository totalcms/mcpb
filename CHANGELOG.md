# Total CMS Desktop Extension Changelog

All notable changes to the Total CMS desktop extension (MCPB) will be documented in this file.

## [Unreleased]

## [0.2.2] - 2026-10-23

### Changed

- **API key setup matches Total CMS 3.6.3**: Since 3.6.3 an API key is limited over MCP exactly as it is over REST: its paths decide which collections it reaches and its HTTP methods decide its tools. The README and the API key setting promised admin-level access from any key, so a key created with only `/mcp` in its paths connected and then found no content. They now explain that full admin access needs an All endpoints key with every method, and how to scope a limited key. No change to the bridge itself

## [0.2.1] - 2026-10-01

### Fixed

- **Every tool call failed with `-32000` until the extension was restarted, after an hour idle or after saving MCP settings on the site**: Total CMS ends an MCP session after an hour without use, and on purpose whenever its MCP configuration changes (a collection's MCP tools saved, an extension toggled), so clients pick up the new tool list. The server then answers the old session id with `404 Session not found or has expired`, and the spec requires the client to start a new session. Claude Desktop sees this bridge as a local stdio server whose session never ends, so it never re-initializes, and the bridge forwarded verbatim — so the dead session id was resent forever and every call failed. The bridge now keeps Desktop's `initialize` request; on a session `404` it opens a fresh connection, replays `initialize` and `notifications/initialized` itself, resends the call that failed, and tells Desktop the tool, prompt and resource lists may have changed. Concurrent failures share one new session, and a `404` before any session existed (a wrong URL) is still reported rather than retried

### Added

- **Setup for other MCP clients in the README**: the bridge is a plain stdio MCP server, so Cursor, VS Code, Windsurf and other clients that launch local servers can run `server/index.js` from the release bundle with Node 18 or later. The README now shows the configuration

### Changed

- **Releasing is automated**: pushing a version tag builds the bundle, publishes the GitHub release, and updates the [MCP Registry](https://registry.modelcontextprotocol.io) entry, which is a separate system that directory installs actually update from and which v0.2.0 had to be published to after the fact. See **Releasing** in the README

## [0.2.0] - 2026-08-26

### Fixed

- **On some shared hosts the extension could not connect at all, while the same URL worked as a custom connector**: The bridge sent no `User-Agent`, so Node's built-in `fetch` supplied its default — the bare string `node` — and shared-hosting WAF rulesets block that outright as a scripted-client signature. Every request was refused before it reached Total CMS. Nothing about the symptoms pointed at the User-Agent: the WAF's `403` is served as an `ErrorDocument`, which a Total CMS site's catch-all rewrite then routes back through `index.php` as a **GET**, so a `POST` to the MCP endpoint came back carrying the *GET* handler's response — SSE keepalives with the listening stream on, a `405` with it off. That reads as a transport bug, an auth bug, or a Total CMS routing bug, and it is none of them; `curl` and Claude Desktop's own custom connector both succeeded against the identical endpoint with the identical API key, which is the observation that eventually isolated it. The bridge now identifies itself as `totalcms-mcpb/<version>`, sent via `requestInit` so it covers the POSTs and the SSE GET alike. If the extension failed to connect to your site but the same URL worked as a custom connector, this release fixes it — and a named agent is better manners than `node` regardless

## [0.1.0] - 2026-08-13

### Added

- **Initial release.** A stdio-to-streamable-HTTP bridge that lets Claude Desktop connect to a self-hosted Total CMS site: search and read content anonymously, or supply an API key for admin access. Every JSON-RPC message is forwarded verbatim in both directions, so tools, resources and prompts are whatever the site exposes rather than anything this bridge declares. Zero filesystem access, zero subprocess spawns, and outbound HTTPS to exactly the one host `MCP_URL` names
- **Purpose-built rather than `mcp-remote`**: `mcp-remote` unconditionally runs OAuth discovery at startup and, on any `401`, launches a browser authorization flow with no flag to disable it. Total CMS uses a plain API-key header, and a bad key has to surface to the client as a clean `401` rather than hanging behind a browser popup

### Fixed

- **A blank optional API key looked like a configured credential**: Claude Desktop substitutes `${user_config.*}` in manifest env values, but passes the placeholder through literally when an optional field is left empty. The unsubstituted string was then sent upstream as a key and earned a `401`, surfacing to the user as "unable to connect to extension server" — on a connection they had deliberately left anonymous. Placeholders are now treated as unset
- **Signing produced a bundle Claude Desktop refused to install**: `mcpb` 2.1.x appends the signature *after* the zip's end-of-central-directory record. Lenient readers skip the trailing bytes and call the archive fine — the tool's own `verify` reports "not signed" on a file it just signed — but Claude Desktop's stricter parser rejects it with `Invalid comment length`. Signing is disabled, and the release script now fails if a signature trailer is ever present
