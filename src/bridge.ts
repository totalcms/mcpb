/**
 * The stdio <-> remote forwarding loop, with session recovery.
 *
 * A Total CMS server ends every MCP session on purpose when its MCP config
 * changes (a collection's MCP tools saved, an extension toggled) so clients
 * pick up the new tool list, and sessions also end on expiry or restart. The
 * server then answers the old session id with HTTP 404, and the spec says the
 * client MUST start a new session. Claude Desktop believes it is talking to a
 * local stdio server whose session never ends, so it never re-initializes on
 * its own — before this, every call after a config save failed with -32000
 * until the user restarted the extension.
 *
 * So the bridge does it: it keeps Desktop's `initialize` request, and on a
 * 404 it opens a fresh remote transport, replays `initialize` and
 * `notifications/initialized` (swallowing the replayed response — Desktop
 * already has one), resends the message that failed, and tells Desktop the
 * tool, prompt and resource lists may have changed.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

type Log = (message: string) => void;

type Fields = Record<string, unknown>;

/** Prefix for ids of requests the bridge sends itself; their responses never reach Desktop. */
const REPLAY_ID_PREFIX = "totalcms-mcpb-reinit-";

/** Notifications sent to Desktop after a new session, so it re-lists what may have changed. */
const LIST_CHANGED = ["notifications/tools/list_changed", "notifications/prompts/list_changed", "notifications/resources/list_changed"];

function asRecord(message: JSONRPCMessage): Fields {
	return message as unknown as Fields;
}

function requestId(message: JSONRPCMessage): string | number | undefined {
	const id = asRecord(message).id;
	return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function isInitialize(message: JSONRPCMessage): boolean {
	return asRecord(message).method === "initialize";
}

/** The SDK's StreamableHTTPError carries the HTTP status as `code`. */
function isSessionGone(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as Fields).code === 404;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export interface BridgeOptions {
	local: Transport;
	createRemote: () => Transport;
	log: Log;
	/** How long to wait for the replayed `initialize` to be answered. */
	replayTimeoutMs?: number;
}

export class Bridge {
	private readonly local: Transport;
	private readonly createRemote: () => Transport;
	private readonly log: Log;
	private readonly replayTimeoutMs: number;
	private remote: Transport;
	private initializeRequest: JSONRPCMessage | undefined;
	private recovery: Promise<void> | undefined;
	private replayCount = 0;
	private pendingReplay: { id: string; resolve: () => void; reject: (err: Error) => void } | undefined;

	constructor(options: BridgeOptions) {
		this.local = options.local;
		this.createRemote = options.createRemote;
		this.log = options.log;
		this.replayTimeoutMs = options.replayTimeoutMs ?? 15_000;
		this.remote = this.wireRemote(options.createRemote());

		this.local.onmessage = (message) => {
			void this.forward(message);
		};
		this.local.onerror = (err) => this.log(`local transport error: ${err.message}`);
	}

	async start(): Promise<void> {
		await Promise.all([this.local.start(), this.remote.start()]);
	}

	async close(): Promise<void> {
		await this.remote.close().catch(() => {});
	}

	/** Forward one message from Desktop to the remote, recovering once from an ended session. */
	async forward(message: JSONRPCMessage): Promise<void> {
		if (isInitialize(message)) {
			this.initializeRequest = message;
		}

		try {
			await this.sendRemote(message);
		} catch (err) {
			// Only a request on an established session can be recovered: a 404
			// on `initialize` itself, or before any session existed, is a wrong
			// URL, and retrying would loop.
			if (isSessionGone(err) && !isInitialize(message) && this.initializeRequest !== undefined) {
				try {
					await this.recover();
					await this.sendRemote(message);
					return;
				} catch (retryErr) {
					err = retryErr;
				}
			}
			this.failRequest(message, err);
		}
	}

	private async sendRemote(message: JSONRPCMessage): Promise<void> {
		// A send that raced a recovery must wait for the new session.
		if (this.recovery !== undefined) {
			await this.recovery;
		}
		await this.remote.send(message);
	}

	/** Open a new remote session. Concurrent failures share one recovery. */
	private recover(): Promise<void> {
		if (this.recovery === undefined) {
			this.recovery = this.reinitialize().finally(() => {
				this.recovery = undefined;
			});
		}

		return this.recovery;
	}

	private async reinitialize(): Promise<void> {
		this.log("remote session ended (HTTP 404) - starting a new one");

		const old = this.remote;
		old.onmessage = undefined;
		old.onerror = undefined;
		old.onclose = undefined;
		await old.close().catch(() => {});

		this.remote = this.wireRemote(this.createRemote());
		await this.remote.start();

		const id = `${REPLAY_ID_PREFIX}${++this.replayCount}`;
		const replay = { ...asRecord(this.initializeRequest as JSONRPCMessage), id } as unknown as JSONRPCMessage;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const answered = new Promise<void>((resolve, reject) => {
			this.pendingReplay = { id, resolve, reject };
			timer = setTimeout(() => reject(new Error("re-initialize timed out")), this.replayTimeoutMs);
		});

		try {
			await this.remote.send(replay);
			await answered;
		} finally {
			clearTimeout(timer);
			this.pendingReplay = undefined;
		}
		await this.remote.send({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);

		this.log("new remote session ready");
		for (const method of LIST_CHANGED) {
			this.local.send({ jsonrpc: "2.0", method } as JSONRPCMessage).catch(() => {});
		}
	}

	private wireRemote(remote: Transport): Transport {
		remote.onmessage = (message) => {
			const pending = this.pendingReplay;
			if (pending !== undefined && requestId(message) === pending.id) {
				this.pendingReplay = undefined;
				const error = asRecord(message).error as Fields | undefined;
				if (error !== undefined) {
					pending.reject(new Error(`re-initialize failed: ${String(error.message ?? "unknown error")}`));
				} else {
					pending.resolve();
				}
				return;
			}
			this.local.send(message).catch((err: unknown) => this.log(`local send failed: ${errorMessage(err)}`));
		};
		remote.onerror = (err) => this.log(`remote transport error: ${err.message}`);
		// A closed SSE stream does not end the session (streamable HTTP opens
		// and closes streams per request); only stdio closing ends the process.
		remote.onclose = () => {};

		return remote;
	}

	/** Answer a failed request with a JSON-RPC error so Desktop isn't left waiting. */
	private failRequest(message: JSONRPCMessage, err: unknown): void {
		const text = errorMessage(err);
		this.log(`remote send failed: ${text}`);

		const id = requestId(message);
		if (id === undefined) {
			return;
		}
		this.local
			.send({ jsonrpc: "2.0", id, error: { code: -32000, message: text } } as JSONRPCMessage)
			.catch(() => {
				/* local channel is gone; nothing more we can do */
			});
	}
}
