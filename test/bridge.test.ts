import assert from "node:assert/strict";
import { test } from "node:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Bridge } from "../src/bridge.ts";

type Message = Record<string, unknown>;

/** Stand-in for Claude Desktop's stdio channel: records what the bridge sends it. */
class FakeLocal implements Transport {
	sent: Message[] = [];
	onmessage?: (message: JSONRPCMessage) => void;
	onerror?: (error: Error) => void;
	onclose?: () => void;
	async start(): Promise<void> {}
	async close(): Promise<void> {}
	async send(message: JSONRPCMessage): Promise<void> {
		this.sent.push(message as unknown as Message);
	}
}

/**
 * Stand-in for a Total CMS endpoint, one instance per session. Answers
 * requests with a result echoing the method; once `expired`, every send
 * fails the way the SDK reports a 404 (StreamableHTTPError, code 404).
 */
class FakeRemote implements Transport {
	sent: Message[] = [];
	expired = false;
	failInitialize = false;
	closed = false;
	onmessage?: (message: JSONRPCMessage) => void;
	onerror?: (error: Error) => void;
	onclose?: () => void;
	async start(): Promise<void> {}
	async close(): Promise<void> {
		this.closed = true;
	}
	async send(message: JSONRPCMessage): Promise<void> {
		const m = message as unknown as Message;
		if (this.expired) {
			throw Object.assign(new Error("Streamable HTTP error: Session not found or has expired."), { code: 404 });
		}
		this.sent.push(m);
		if (m.id === undefined) {
			return;
		}
		const reply =
			m.method === "initialize" && this.failInitialize
				? { jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "nope" } }
				: { jsonrpc: "2.0", id: m.id, result: { echo: m.method } };
		this.onmessage?.(reply as unknown as JSONRPCMessage);
	}
}

function setup(options: { failReinit?: boolean } = {}) {
	const local = new FakeLocal();
	const remotes: FakeRemote[] = [];
	const bridge = new Bridge({
		local,
		createRemote: () => {
			const remote = new FakeRemote();
			remote.failInitialize = remotes.length > 0 && options.failReinit === true;
			remotes.push(remote);
			return remote;
		},
		log: () => {},
		replayTimeoutMs: 200,
	});

	return { local, remotes, bridge };
}

const initialize = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } } };
const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "patch_object", arguments: {} } });

async function handshake(bridge: Bridge): Promise<void> {
	await bridge.start();
	await bridge.forward(initialize as unknown as JSONRPCMessage);
	await bridge.forward({ jsonrpc: "2.0", method: "notifications/initialized" } as unknown as JSONRPCMessage);
}

test("an ended session is replaced and the failed call is resent, not reported as -32000", async () => {
	const { local, remotes, bridge } = setup();
	await handshake(bridge);
	remotes[0].expired = true;

	await bridge.forward(call(7) as unknown as JSONRPCMessage);

	assert.equal(remotes.length, 2, "a new remote session was opened");
	assert.ok(remotes[0].closed, "the dead session was closed");

	const replayed = remotes[1].sent.map((m) => m.method);
	assert.deepEqual(replayed, ["initialize", "notifications/initialized", "tools/call"]);
	assert.deepEqual(remotes[1].sent[0].params, initialize.params, "Desktop's own initialize params are replayed");

	const toDesktop = local.sent;
	assert.ok(!toDesktop.some((m) => m.error !== undefined), "no error reached Desktop");
	assert.ok(!toDesktop.some((m) => String(m.id).startsWith("totalcms-mcpb-reinit-")), "the replayed initialize response is swallowed");
	assert.ok(toDesktop.some((m) => m.id === 7 && (m.result as Message).echo === "tools/call"), "the call's result reached Desktop");
	assert.ok(toDesktop.some((m) => m.method === "notifications/tools/list_changed"), "Desktop is told to re-list tools");
});

test("concurrent failures share one new session", async () => {
	const { local, remotes, bridge } = setup();
	await handshake(bridge);
	remotes[0].expired = true;

	await Promise.all([bridge.forward(call(1) as unknown as JSONRPCMessage), bridge.forward(call(2) as unknown as JSONRPCMessage)]);

	assert.equal(remotes.length, 2);
	assert.equal(remotes[1].sent.filter((m) => m.method === "initialize").length, 1);
	assert.deepEqual(local.sent.filter((m) => m.id === 1 || m.id === 2).map((m) => m.error), [undefined, undefined]);
});

test("a 404 before any session existed is reported, not retried (wrong URL)", async () => {
	const { local, remotes, bridge } = setup();
	await bridge.start();
	remotes[0].expired = true;

	await bridge.forward(initialize as unknown as JSONRPCMessage);

	assert.equal(remotes.length, 1, "no recovery attempted");
	assert.equal((local.sent[0].error as Message).code, -32000);
});

test("a failed re-initialize surfaces as an error on the original call", async () => {
	const { local, remotes, bridge } = setup({ failReinit: true });
	await handshake(bridge);
	remotes[0].expired = true;

	await bridge.forward(call(9) as unknown as JSONRPCMessage);

	const reply = local.sent.find((m) => m.id === 9);
	assert.ok(reply !== undefined);
	assert.match(String((reply.error as Message).message), /re-initialize failed/);
});
