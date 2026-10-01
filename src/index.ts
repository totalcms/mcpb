#!/usr/bin/env node
/**
 * Total CMS MCPB bridge.
 *
 * A hand-rolled stdio <-> streamable-HTTP proxy. Claude Desktop spawns this
 * process and speaks MCP over stdio to it; this process forwards every
 * JSON-RPC message (requests, responses, notifications - initialize,
 * tools/*, resources/*, prompts/*, everything) verbatim to a remote Total
 * CMS MCP endpoint over streamable HTTP, and forwards the remote's messages
 * back over stdio.
 *
 * Why not mcp-remote? See BUILD-REPORT.md - mcp-remote unconditionally runs
 * OAuth discovery on startup and, on any HTTP 401 from the remote, launches
 * a browser-based OAuth authorization flow with no flag to disable it. Total
 * CMS uses a plain API-key header, not OAuth; a bad key must surface as a
 * clean 401 to the MCP client, not hang behind a browser popup. So this is a
 * small hand-rolled proxy built directly on `@modelcontextprotocol/sdk`.
 */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./bridge.ts";

/**
 * User-Agent this bridge sends upstream. Keep the version in step with
 * package.json / manifest.json on release.
 */
const USER_AGENT = "totalcms-mcpb/0.2.1";

function fail(message: string): never {
	// stdout is reserved for JSON-RPC framing - all diagnostics go to stderr.
	process.stderr.write(`[totalcms-mcpb] ${message}\n`);
	process.exit(1);
}

/**
 * Read an install-time config value, treating an unsubstituted manifest
 * placeholder as absent.
 *
 * Claude Desktop substitutes `${user_config.<key>}` in manifest env values,
 * but when an OPTIONAL field is left blank it passes the placeholder through
 * literally rather than an empty string. Without this guard a blank API key
 * arrives as the string "${user_config.apiKey}", looks like a configured
 * credential, gets sent upstream, and earns a 401 that surfaces to the user
 * as "unable to connect to extension server".
 */
function readConfig(name: string): string {
	const raw = process.env[name]?.trim() ?? "";
	if (/^\$\{.*\}$/.test(raw)) {
		process.stderr.write(
			`[totalcms-mcpb] ${name} was left blank at install (received an unsubstituted placeholder) - treating as unset\n`,
		);
		return "";
	}

	return raw;
}

/**
 * Zero-config target: the official Total CMS docs connector.
 *
 * The manifest declares the same value as the field's default, but that is a
 * UI hint only - Claude Desktop omits untouched fields from the saved config
 * and then passes the raw placeholder through. Defaulting here means a user
 * who installs and changes nothing still gets a working bundle, whatever the
 * host does with unset fields.
 */
const DEFAULT_MCP_URL = "https://totalcms.co/mcp";

function main(): void {
	const configuredUrl = readConfig("MCP_URL");
	const rawUrl = configuredUrl === "" ? DEFAULT_MCP_URL : configuredUrl;
	if (configuredUrl === "") {
		process.stderr.write(
			`[totalcms-mcpb] no endpoint configured - using the official docs connector (${DEFAULT_MCP_URL})\n`,
		);
	}

	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		fail(`MCP_URL is not a valid URL: "${rawUrl}". Refusing to start.`);
	}

	// HTTPS everywhere except loopback.
	//
	// A Total CMS install on localhost is a first-class target for this bridge —
	// a developer running the site locally, or a self-hosted install reached
	// through an SSH tunnel — and it is the case the MCPB format exists for.
	// Requiring https there would refuse the most common local setup, since
	// nobody terminates TLS on a dev site.
	//
	// The rule this relaxes protects credentials in transit, and loopback
	// traffic never reaches a wire, so the risk it guards against is absent.
	// The same reasoning is why browsers treat http://localhost as a secure
	// context and OAuth permits loopback redirects over http. Every other host
	// still requires https: an API key crossing a network in clear text is not
	// a trade worth offering.
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");

	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
		fail(
			`MCP_URL must use https:// (got "${url.protocol}//" for "${url.hostname}"). Plain http is allowed only for localhost. Refusing to start.`,
		);
	}

	// API_KEY is optional. When present, never log its value.
	const apiKey = readConfig("API_KEY");

	// Identify ourselves. Undici - node's built-in fetch, which the SDK's
	// streamable-HTTP transport uses - defaults User-Agent to the bare string
	// "node", and shared-hosting WAF rulesets block that outright as a
	// scripted-client signature. Observed live on a cPanel host 2026-08-25:
	// every request from this bridge was refused while curl and Claude
	// Desktop's own connector, hitting the identical endpoint with the
	// identical API key, both passed. The bridge looked broken; only its
	// User-Agent was.
	//
	// Sent via requestInit so the SDK merges it into the POSTs and the SSE
	// GET alike (see _commonHeaders in streamableHttp.js).
	const headers: Record<string, string> = {
		"User-Agent": USER_AGENT,
	};
	if (apiKey !== "") {
		headers["X-API-Key"] = apiKey;
	}

	process.stderr.write(
		`[totalcms-mcpb] connecting to ${url.origin}${url.pathname} (api key ${apiKey ? "configured" : "not set"})\n`,
	);

	const log = (message: string): void => {
		process.stderr.write(`[totalcms-mcpb] ${message}\n`);
	};

	const local = new StdioServerTransport();
	const bridge = new Bridge({
		local,
		createRemote: () => new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
		log,
	});

	// Only the local stdio channel closing ends the process.
	const shutdown = (): void => {
		bridge.close().finally(() => process.exit(0));
	};

	bridge
		.start()
		.then(() => log("bridge ready"))
		.catch((err: unknown) => {
			const errorMessage = err instanceof Error ? err.message : String(err);
			fail(`failed to start bridge: ${errorMessage}`);
		});

	local.onclose = shutdown;
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main();
