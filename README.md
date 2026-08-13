# Total CMS Desktop Extension (MCPB)

A [Claude Desktop extension](https://www.anthropic.com/engineering/desktop-extensions)
that connects Claude to any [Total CMS](https://totalcms.co) site's built-in
MCP server. Install once, and Claude can search docs, browse content, and
(with an API key) manage your Total CMS site directly.

This is a **local bridge**, not a hosted connector: it runs as a small Node
process on your machine and proxies MCP traffic to your site's `/mcp`
endpoint over HTTPS. That's what lets it attach a custom `X-API-Key` header
for authenticated access - something Claude Desktop's built-in remote
connectors can't do for servers that advertise optional auth.

## Privacy Policy

This extension does not collect, transmit, or store any data of its own. It
opens an HTTPS connection directly from your machine to the Total CMS MCP
endpoint you configure (default: `https://totalcms.co/mcp`, the official
Total CMS docs site) and relays MCP protocol messages between Claude Desktop
and that endpoint. Your optional API key is stored in your OS's secure
credential store (via Claude Desktop's `sensitive: true` config handling) and
is sent only as an `X-API-Key` request header to the site you configured -
never logged, never sent anywhere else.

For the privacy policy of the Total CMS product and totalcms.co itself, see
**https://totalcms.co/privacy**.

## Setup

### Zero-config: ask about Total CMS itself

Just install the extension. It defaults to `https://totalcms.co/mcp`, the
official Total CMS documentation server, so Claude can immediately answer
questions like "how do I set up webhooks in Total CMS?" or "what schema
fields does Total CMS support?" with no configuration.

### Connect to your own site

1. In your Total CMS admin, go to **Settings -> MCP** and copy your site's
   MCP endpoint URL (it will look like `https://yoursite.com/mcp`, or include
   a subpath if you installed Total CMS in one).
2. In Claude Desktop's extension settings for Total CMS, paste that URL into
   **Total CMS MCP endpoint**.
3. Reinstall/reconnect. Claude can now browse and search your site's public
   collections.

### Authenticated (admin) access

1. Generate a Total CMS API key for your site (Settings -> API Keys, or your
   preferred key-issuing flow).
2. Paste it into the **API key (optional)** field in the extension settings.
   It's stored in your OS keychain, not in plain text.
3. Claude now has admin-level access to your site's MCP tools (schema
   management, templates, site info, cache clearing, etc.) in addition to
   public content. Leave this field empty to keep Claude limited to public,
   anonymous access.

## How it works

`server/index.js` is a small stdio MCP server that Claude Desktop spawns
directly (no Node install required - MCPB bundles include their own
runtime handling). It opens a
[streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
connection to the `MCP_URL` you configured and forwards every JSON-RPC
message in both directions verbatim: `initialize`, `tools/list`,
`tools/call`, `resources/*`, `prompts/*`, and all notifications. When
`API_KEY` is set, every outbound HTTP request carries an `X-API-Key` header.

It refuses to start unless `MCP_URL` is `https://` - plaintext credentials on
the wire are not acceptable, even for local testing.

### Why not `mcp-remote`?

We spiked it first (see `BUILD-REPORT.md` for the full writeup). Short
version: `mcp-remote` unconditionally runs OAuth discovery on startup and,
on any HTTP 401 response, launches a browser-based OAuth authorization flow
with no flag to disable it. Total CMS uses a plain API-key header, not OAuth
- a bad key needs to surface as a clean 401 error to the MCP client, not
hang behind a browser popup trying to OAuth against a server that doesn't
implement it. So this bundle ships a small hand-rolled proxy built directly
on `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport` and
`StdioServerTransport` instead.

## Development

```bash
npm install
npm run build     # typecheck -> esbuild bundle -> mcpb validate -> mcpb pack
```

Produces `dist/totalcms.mcpb`. Install by dragging that file onto Claude
Desktop.

`npm run typecheck` and `npm run validate` are available standalone.

## Security notes

- Zero filesystem access, zero subprocess spawns, outbound HTTPS to exactly
  one host (whatever `MCP_URL` points at).
- The API key is read from the `API_KEY` environment variable (set by Claude
  Desktop from your keychain-stored config) and is never written to stdout,
  stderr, or any log.
- `MCP_URL` must be `https://` or the process refuses to start.

## Open items

See `BUILD-REPORT.md` for the full list (icon, signing, clean-machine
install test, submission form).
