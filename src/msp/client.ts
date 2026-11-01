// MSP client: JSONL stdio driver for `muse serve` (D22).
//
// Slice 1 of T31: session + turn + history + rename over the echo- or
// meta-provider host. The Bun server (slice 2) builds chat on this.

import type { FileSink } from "bun";

export type ApprovalMode =
	| "allowAll"
	| "promptUnmatched"
	| "onRequest"
	| "denyUnmatched";

export type ReasoningEffort =
	| "none"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max"
	| "ultra";

export type ModelCatalogEntry = {
	modelId: string;
	displayLabel?: string;
	contextLimit?: number;
	isDefault?: boolean;
	providerId?: string;
};

export type TextPart = { type: "text"; text: string };
export type ImagePart = {
	type: "image";
	base64Data: string;
	mediaType: string;
	width?: number;
	height?: number;
};
export type TurnInput = TextPart | ImagePart;

export type MspSession = {
	sessionId: string;
	name?: string | null;
	providerId?: string;
	workspaceRoot?: string;
	status?: string;
	turnCount?: number;
	[k: string]: unknown;
};

export type ViewEvent = {
	method: string;
	params: Record<string, unknown>;
	viewCursor?: string;
};

export type TurnOutcome = {
	turnId: string;
	terminal: string;
	agentTexts: string[];
	/** turn/completed error member, when the host attached one. */
	error?: { kind?: string; message?: string };
};

/** Typed MSP wire error (error.data.kind drives branches). */
export class MspError extends Error {
	code: number;
	kind: string;
	retryable: boolean;
	reason?: string;

	constructor(
		code: number,
		kind: string,
		message: string,
		retryable: boolean,
		reason?: string,
	) {
		super(message);
		this.name = "MspError";
		this.code = code;
		this.kind = kind;
		this.retryable = retryable;
		this.reason = reason;
	}
}

/** Mint a UUIDv7 (time-ordered) for commandId handles. */
export function uuid7(): string {
	const ms = BigInt(Date.now());
	const rand = new Uint8Array(10);
	crypto.getRandomValues(rand);
	const b = new Uint8Array(16);
	const msBytes = new Uint8Array(8);
	new DataView(msBytes.buffer).setBigUint64(0, ms);
	b.set(msBytes.slice(2), 0);
	b.set(rand, 6);
	b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
	b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Pending = {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
};

export type MspSpawnOpts = {
	provider?: string;
	museHome?: string;
	/** Isolate the config home too (auth.json lives there, not in museHome). */
	museConfigHome?: string;
	extraArgs?: string[];
	timeoutMs?: number;
	/**
	 * Base environment for the child (T51: the server passes its
	 * package-fronted env so agent shells resolve the pinned builds).
	 * Defaults to the current process env.
	 */
	env?: Record<string, string>;
};

export class MspClient {
	private proc: ReturnType<typeof Bun.spawn>;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private notifyHandlers = new Set<(ev: ViewEvent) => void>();
	private closed = false;

	private constructor(proc: ReturnType<typeof Bun.spawn>) {
		this.proc = proc;
		void this.readLoop();
	}

	/**
	 * Piped stdio, narrowed from Bun's spawn union. We spawn with
	 * stdin/stdout "pipe", so anything else is a broken spawn: fail
	 * fast instead of writing into a number.
	 */
	private get stdin(): FileSink {
		const s = this.proc.stdin;
		if (typeof s !== "object" || s === null)
			throw new Error("muse stdio unavailable (stdin not piped)");
		return s;
	}

	private get stdout(): ReadableStream<Uint8Array> {
		const s = this.proc.stdout;
		if (typeof s !== "object" || s === null)
			throw new Error("muse stdio unavailable (stdout not piped)");
		return s;
	}

	/** Spawn `muse serve`, run initialize + initialized (required). */
	static async spawn(opts?: MspSpawnOpts): Promise<MspClient> {
		const args = ["muse", "serve", "--provider", opts?.provider ?? "meta"];
		if (opts?.extraArgs) args.push(...opts.extraArgs);
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(opts?.env ?? process.env)) {
			if (v !== undefined) env[k] = v;
		}
		if (opts?.museHome) {
			// museHome derives from XDG_DATA_HOME; isolate tests here.
			env["XDG_DATA_HOME"] = opts.museHome;
		}
		if (opts?.museConfigHome) {
			env["XDG_CONFIG_HOME"] = opts.museConfigHome;
		}
		const proc = Bun.spawn(args, {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		const client = new MspClient(proc);
		const timeoutMs = opts?.timeoutMs ?? 30_000;
		await client.call(
			"initialize",
			{ clientInfo: { name: "routeros_muse", version: "0.1" } },
			timeoutMs,
		);
		client.notify("initialized", {});
		return client;
	}

	onNotification(handler: (ev: ViewEvent) => void): () => void {
		this.notifyHandlers.add(handler);
		return () => {
			this.notifyHandlers.delete(handler);
		};
	}

	async sessionStart(opts: {
		workspaceRoot: string;
		workspaceRoots?: string[];
		approvalMode?: ApprovalMode;
	}): Promise<{ session: MspSession; viewCursor: string }> {
		return (await this.call("session/start", {
			commandId: uuid7(),
			workspaceRoot: opts.workspaceRoot,
			...(opts.workspaceRoots ? { workspaceRoots: opts.workspaceRoots } : {}),
			...(opts.approvalMode ? { approvalMode: opts.approvalMode } : {}),
		})) as { session: MspSession; viewCursor: string };
	}

	async turnStart(opts: {
		sessionId: string;
		input: TurnInput[];
		displayText?: string;
	}): Promise<{ turnId: string; disposition: string }> {
		const res = (await this.call("turn/start", {
			commandId: uuid7(),
			sessionId: opts.sessionId,
			input: opts.input,
			...(opts.displayText ? { displayText: opts.displayText } : {}),
		})) as { turnId: string; disposition: string };
		return res;
	}

	async turnSteer(opts: {
		sessionId: string;
		expectedTurnId: string;
		input: TurnInput[];
	}): Promise<unknown> {
		return this.call("turn/steer", {
			commandId: uuid7(),
			sessionId: opts.sessionId,
			expectedTurnId: opts.expectedTurnId,
			input: opts.input,
		});
	}

	async turnInterrupt(opts: {
		sessionId: string;
		turnId?: string;
	}): Promise<unknown> {
		return this.call("turn/interrupt", {
			commandId: uuid7(),
			sessionId: opts.sessionId,
			...(opts.turnId ? { turnId: opts.turnId } : {}),
		});
	}

	async sessionList(): Promise<{ sessions: MspSession[] }> {
		return (await this.call("session/list", {})) as { sessions: MspSession[] };
	}

	async sessionRead(sessionId: string): Promise<Record<string, unknown>> {
		return (await this.call("session/read", { sessionId })) as Record<
			string,
			unknown
		>;
	}

	async sessionRename(
		sessionId: string,
		name: string,
	): Promise<Record<string, unknown>> {
		return (await this.call("session/rename", {
			commandId: uuid7(),
			sessionId,
			name,
		})) as Record<string, unknown>;
	}

	async viewPage(opts: {
		sessionId: string;
		limit: number;
		direction?: "forward" | "backward";
		cursor?: string;
	}): Promise<{ events: ViewEvent[]; nextCursor: string | null }> {
		return (await this.call("view/page", {
			sessionId: opts.sessionId,
			limit: opts.limit,
			...(opts.direction ? { direction: opts.direction } : {}),
			...(opts.cursor ? { cursor: opts.cursor } : {}),
		})) as { events: ViewEvent[]; nextCursor: string | null };
	}

	async skillList(sessionId: string): Promise<Record<string, unknown>> {
		return (await this.call("skill/list", { sessionId })) as Record<
			string,
			unknown
		>;
	}

	async itemReadOutput(opts: {
		sessionId: string;
		itemId: string;
		outputRef: string;
		offsetBytes?: number;
		lengthBytes?: number;
	}): Promise<{
		byteLen: number;
		content: string;
		encoding: string;
		eof: boolean;
		mediaType: string;
	}> {
		return (await this.call("item/readOutput", {
			sessionId: opts.sessionId,
			itemId: opts.itemId,
			outputRef: opts.outputRef,
			...(opts.offsetBytes !== undefined
				? { offsetBytes: opts.offsetBytes }
				: {}),
			...(opts.lengthBytes !== undefined
				? { lengthBytes: opts.lengthBytes }
				: {}),
		})) as {
			byteLen: number;
			content: string;
			encoding: string;
			eof: boolean;
			mediaType: string;
		};
	}

	async modelList(): Promise<{
		models: ModelCatalogEntry[];
		providerId?: string;
	}> {
		return (await this.call("model/list", {})) as {
			models: ModelCatalogEntry[];
			providerId?: string;
		};
	}

	async sessionSetModel(sessionId: string, modelId: string): Promise<unknown> {
		return this.call("session/setModel", {
			commandId: uuid7(),
			model: { modelId },
			sessionId,
		});
	}

	async sessionSetReasoningEffort(
		sessionId: string,
		effort: ReasoningEffort,
	): Promise<unknown> {
		return this.call("session/setReasoningEffort", {
			commandId: uuid7(),
			reasoningEffort: effort,
			sessionId,
		});
	}

	async sessionSetApprovalMode(
		sessionId: string,
		mode: ApprovalMode,
	): Promise<unknown> {
		return this.call("session/setApprovalMode", {
			commandId: uuid7(),
			mode,
			sessionId,
		});
	}

	/** Submit one turn and collect agent texts until its turn/completed. */
	async runTurn(opts: {
		sessionId: string;
		input: TurnInput[];
		timeoutMs?: number;
	}): Promise<TurnOutcome> {
		const { turnId } = await this.turnStart({
			sessionId: opts.sessionId,
			input: opts.input,
		});
		return this.waitForTurn(opts.sessionId, turnId, opts.timeoutMs ?? 60_000);
	}

	/** Wait for a turn's terminal event, gathering agentMessage texts. */
	waitForTurn(
		sessionId: string,
		turnId: string,
		timeoutMs = 60_000,
	): Promise<TurnOutcome> {
		return new Promise((resolve, reject) => {
			const agentTexts: string[] = [];
			const timer = setTimeout(() => {
				off();
				reject(new Error(`turn ${turnId} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const off = this.onNotification((ev) => {
				const sid = ev.params["sessionId"];
				if (sid !== undefined && sid !== sessionId) return;
				if (ev.method === "item/completed" || ev.method === "item/updated") {
					const item = ev.params["item"] as Record<string, unknown> | undefined;
					if (
						item?.["kind"] === "agentMessage" &&
						typeof item["text"] === "string" &&
						item["text"]
					) {
						if (!agentTexts.includes(item["text"]))
							agentTexts.push(item["text"]);
					}
				}
				if (ev.method === "turn/completed") {
					const doneId = ev.params["turnId"];
					if (doneId === turnId) {
						clearTimeout(timer);
						off();
						const err = ev.params["error"] as
							| Record<string, unknown>
							| undefined;
						resolve({
							turnId,
							terminal: String(ev.params["terminal"] ?? "unknown"),
							agentTexts,
							...(err
								? {
										error: {
											...(typeof err["kind"] === "string"
												? { kind: err["kind"] }
												: {}),
											...(typeof err["message"] === "string"
												? { message: err["message"] }
												: {}),
										},
									}
								: {}),
						});
					}
				}
			});
		});
	}

	/** Close stdin and wait for the host to exit. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const [, p] of this.pending) p.reject(new Error("client closed"));
		this.pending.clear();
		try {
			this.stdin.end();
		} catch {
			// already gone
		}
		await this.proc.exited;
	}

	/**
	 * End stdin (EOF) without waiting for exit; the caller bounds the
	 * wait via waitForExit. Safe to call before close() (close keeps
	 * its graceful EOF + unbounded wait for lock/takeover). T71.
	 */
	stdinEof(): void {
		try {
			this.stdin.end();
		} catch {
			// already gone
		}
	}

	/** Deliver a signal to the worker process (T71 force-stop escalation). */
	kill(signal: "SIGTERM" | "SIGKILL"): void {
		try {
			this.proc.kill(signal);
		} catch {
			// already gone
		}
	}

	/**
	 * True when the worker exits within timeoutMs (0 polls the current
	 * state: an already-settled exit wins the race as a microtask).
	 * A spawn failure counts as gone, same as an exit.
	 */
	async waitForExit(timeoutMs: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const gate = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
		});
		const exited = this.proc.exited.then(
			() => true,
			() => true,
		);
		try {
			return await Promise.race([exited, gate]);
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}

	async call(
		method: string,
		params: unknown,
		timeoutMs = 30_000,
	): Promise<unknown> {
		const id = this.nextId++;
		const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.stdin.write(line);
			this.stdin.flush();
		});
	}

	private notify(method: string, params: unknown): void {
		this.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
		this.stdin.flush();
	}

	private async readLoop(): Promise<void> {
		const reader = this.stdout.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl = buf.indexOf("\n");
				while (nl >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (line) this.onMessage(line);
					nl = buf.indexOf("\n");
				}
			}
		} catch {
			// stream closed under us; pending calls fail via close()
		} finally {
			reader.releaseLock();
		}
	}

	private onMessage(line: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		// Server-initiated request (id + method): answer the receipt.
		if (typeof msg["id"] === "number" && typeof msg["method"] === "string") {
			const id = msg["id"] as number;
			this.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`,
			);
			this.stdin.flush();
			return;
		}
		// Response to our call.
		if (typeof msg["id"] === "number") {
			const id = msg["id"] as number;
			const pend = this.pending.get(id);
			if (!pend) return;
			this.pending.delete(id);
			if ("error" in msg && msg["error"]) {
				const err = msg["error"] as Record<string, unknown>;
				const data = (err["data"] as Record<string, unknown>) ?? {};
				pend.reject(
					new MspError(
						Number(err["code"] ?? -1),
						String(data["kind"] ?? "unknown"),
						String(err["message"] ?? "MSP error"),
						Boolean(data["retryable"] ?? false),
						typeof data["reason"] === "string" ? data["reason"] : undefined,
					),
				);
			} else {
				pend.resolve(msg["result"]);
			}
			return;
		}
		// Notification (method, no id).
		if (typeof msg["method"] === "string") {
			const ev: ViewEvent = {
				method: msg["method"] as string,
				params: (msg["params"] as Record<string, unknown>) ?? {},
			};
			for (const h of this.notifyHandlers) {
				try {
					h(ev);
				} catch {
					// handler bugs must not kill the read loop
				}
			}
		}
	}
}
