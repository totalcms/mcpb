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
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

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
	const headers: Record<string, string> = {};
	if (apiKey !== "") {
		headers["X-API-Key"] = apiKey;
	}

	process.stderr.write(
		`[totalcms-mcpb] connecting to ${url.origin}${url.pathname} (api key ${apiKey ? "configured" : "not set"})\n`,
	);

	const remote = new StreamableHTTPClientTransport(url, {
		requestInit: { headers },
	});

	const local = new StdioServerTransport();

	// --- local (Claude Desktop) -> remote (Total CMS) ---
	local.onmessage = (message: JSONRPCMessage) => {
		remote.send(message).catch((err: unknown) => {
			const errorMessage = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[totalcms-mcpb] remote send failed: ${errorMessage}\n`);

			// If this was a request (has an id), the caller is waiting on a
			// response. Surface a clean JSON-RPC error instead of hanging.
			const asRecord = message as unknown as Record<string, unknown>;
			if ("id" in asRecord && asRecord.id !== undefined && asRecord.id !== null) {
				const errorResponse: JSONRPCMessage = {
					jsonrpc: "2.0",
					id: asRecord.id as string | number,
					error: {
						code: -32000,
						message: errorMessage,
					},
				} as JSONRPCMessage;
				local.send(errorResponse).catch(() => {
					/* local channel is gone; nothing more we can do */
				});
			}
		});
	};

	// --- remote (Total CMS) -> local (Claude Desktop) ---
	remote.onmessage = (message: JSONRPCMessage) => {
		local.send(message).catch((err: unknown) => {
			const errorMessage = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[totalcms-mcpb] local send failed: ${errorMessage}\n`);
		});
	};

	local.onerror = (err: Error) => {
		process.stderr.write(`[totalcms-mcpb] local transport error: ${err.message}\n`);
	};

	remote.onerror = (err: Error) => {
		process.stderr.write(`[totalcms-mcpb] remote transport error: ${err.message}\n`);
	};

	local.onclose = () => {
		remote.close().catch(() => {});
		process.exit(0);
	};

	remote.onclose = () => {
		// A closed SSE stream on the remote side does not necessarily mean the
		// session is over (streamable HTTP opens/closes streams per request).
		// Only the local stdio channel closing ends the process.
	};

	Promise.all([local.start(), remote.start()])
		.then(() => {
			process.stderr.write("[totalcms-mcpb] bridge ready\n");
		})
		.catch((err: unknown) => {
			const errorMessage = err instanceof Error ? err.message : String(err);
			fail(`failed to start bridge: ${errorMessage}`);
		});

	process.on("SIGINT", () => {
		remote.close().catch(() => {});
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		remote.close().catch(() => {});
		process.exit(0);
	});
}

main();
