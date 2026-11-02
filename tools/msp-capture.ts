#!/usr/bin/env bun
// msp-capture.ts — reusable MSP wire-capture driver for `muse serve`.
//
// Speaks JSONL JSON-RPC 2.0 over stdio (mirrors src/msp/client.ts) and logs
// EVERY frame in both directions with ISO timestamps to a JSONL log:
//   {t, dir: "C>"|"S>"|"S!", frame?|text?}
// C> = client->server, S> = server->client, S! = server stderr.
//
// Subcommands:
//   session-probe  initialize + session/start + skill/list + model/list (no model calls)
//   skills-reread  session + skill/list, apply file mutations, skill/list again (S4 probe)
//   turn           full session + one turn; scripted approval/question policies
//   mcp-server     trivial stdio MCP server exposing ui_show_note(text) (B2 probe)
//
// Research-only: no dependency on src/ (self-contained, zero deps).

function uuid7(): string {
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

type Frame = Record<string, unknown>;

class Capture {
	private proc: ReturnType<typeof Bun.spawn>;
	private nextId = 1;
	private pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private log: { write(s: string): void; end(): void };
	private serverRequestHandler:
		| ((id: number, method: string, params: Frame) => void)
		| null = null;
	private notifyHandler: ((method: string, params: Frame) => void) | null =
		null;
	methodsSeen = new Set<string>();

	private constructor(proc: ReturnType<typeof Bun.spawn>, logPath: string) {
		this.proc = proc;
		const f = Bun.file(logPath);
		this.log = f.writer();
		void this.readLoop();
		void this.errLoop();
	}

	static async spawn(opts: {
		provider: string;
		extraServeArgs: string[];
		museHome?: string;
		logPath: string;
		env?: Record<string, string>;
	}): Promise<Capture> {
		const args = [
			"muse",
			"serve",
			"--provider",
			opts.provider,
			...opts.extraServeArgs,
		];
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(opts.env ?? process.env)) {
			if (v !== undefined) env[k] = v;
		}
		if (opts.museHome) env["XDG_DATA_HOME"] = opts.museHome;
		const proc = Bun.spawn(args, {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		return new Capture(proc, opts.logPath);
	}

	private writeLog(obj: unknown): void {
		this.log.write(`${JSON.stringify(obj)}\n`);
	}

	private get stdin(): { write(s: string): void; flush(): void; end(): void } {
		const s = this.proc.stdin;
		if (typeof s !== "object" || s === null) throw new Error("stdin not piped");
		return s as unknown as {
			write(s: string): void;
			flush(): void;
			end(): void;
		};
	}

	onServerRequest(
		h: (id: number, method: string, params: Frame) => void,
	): void {
		this.serverRequestHandler = h;
	}
	onNotification(h: (method: string, params: Frame) => void): void {
		this.notifyHandler = h;
	}

	async call(
		method: string,
		params: unknown,
		timeoutMs = 60_000,
	): Promise<unknown> {
		const id = this.nextId++;
		const frame = { jsonrpc: "2.0", id, method, params };
		this.writeLog({ t: new Date().toISOString(), dir: "C>", frame });
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
			this.stdin.write(`${JSON.stringify(frame)}\n`);
			this.stdin.flush();
		});
	}

	notify(method: string, params: unknown): void {
		const frame = { jsonrpc: "2.0", method, params };
		this.writeLog({ t: new Date().toISOString(), dir: "C>", frame });
		this.stdin.write(`${JSON.stringify(frame)}\n`);
		this.stdin.flush();
	}

	respond(id: number, result: unknown): void {
		const frame = { jsonrpc: "2.0", id, result };
		this.writeLog({ t: new Date().toISOString(), dir: "C>", frame });
		this.stdin.write(`${JSON.stringify(frame)}\n`);
		this.stdin.flush();
	}

	private onMessage(line: string): void {
		let msg: Frame;
		try {
			msg = JSON.parse(line) as Frame;
		} catch {
			return;
		}
		this.writeLog({ t: new Date().toISOString(), dir: "S>", frame: msg });
		if (typeof msg["id"] === "number" && typeof msg["method"] === "string") {
			const id = msg["id"] as number;
			const method = msg["method"] as string;
			this.methodsSeen.add(`SR:${method}`);
			if (this.serverRequestHandler) {
				try {
					this.serverRequestHandler(id, method, (msg["params"] as Frame) ?? {});
				} catch (e) {
					console.error(`serverRequest handler threw: ${e}`);
				}
			}
			return;
		}
		if (typeof msg["id"] === "number") {
			const id = msg["id"] as number;
			const pend = this.pending.get(id);
			if (!pend) return;
			this.pending.delete(id);
			if ("error" in msg && msg["error"]) {
				const err = msg["error"] as Frame;
				const data = (err["data"] as Frame) ?? {};
				pend.reject(
					new Error(
						`MSP ${String((msg as Frame)["id"])}: ${String(err["message"] ?? "error")} (code=${String(err["code"])} kind=${String(data["kind"] ?? "?")})`,
					),
				);
			} else {
				pend.resolve(msg["result"]);
			}
			return;
		}
		if (typeof msg["method"] === "string") {
			const method = msg["method"] as string;
			this.methodsSeen.add(`N:${method}`);
			if (this.notifyHandler) {
				try {
					this.notifyHandler(method, (msg["params"] as Frame) ?? {});
				} catch (e) {
					console.error(`notify handler threw: ${e}`);
				}
			}
		}
	}

	private async readLoop(): Promise<void> {
		const stream = this.proc.stdout;
		if (typeof stream !== "object" || stream === null) return;
		const reader = (stream as ReadableStream<Uint8Array>).getReader();
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
			// closed under us
		} finally {
			reader.releaseLock();
		}
	}

	private async errLoop(): Promise<void> {
		const stream = this.proc.stderr;
		if (typeof stream !== "object" || stream === null) return;
		const reader = (stream as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				const text = decoder.decode(value, { stream: true });
				for (const line of text.split("\n")) {
					if (line.trim())
						this.writeLog({
							t: new Date().toISOString(),
							dir: "S!",
							text: line,
						});
				}
			}
		} catch {
			// closed under us
		} finally {
			reader.releaseLock();
		}
	}

	async close(): Promise<void> {
		for (const [, p] of this.pending) p.reject(new Error("client closed"));
		this.pending.clear();
		try {
			this.stdin.end();
		} catch {
			// gone
		}
		await this.proc.exited;
		this.log.end();
	}
}

// ---------- arg parsing ----------

function args(argv: string[]): {
	cmd: string;
	flags: Map<string, string>;
	rest: string[];
} {
	const cmd = argv[0] ?? "";
	const flags = new Map<string, string>();
	const rest: string[] = [];
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i] as string;
		if (a === "--") {
			rest.push(...argv.slice(i + 1));
			break;
		}
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq >= 0) {
				flags.set(a.slice(2, eq), a.slice(eq + 1));
			} else {
				const v = argv[i + 1];
				if (v !== undefined && !v.startsWith("--")) {
					flags.set(a.slice(2), v);
					i++;
				} else {
					flags.set(a.slice(2), "true");
				}
			}
		} else {
			rest.push(a);
		}
	}
	return { cmd, flags, rest };
}

function need(flags: Map<string, string>, name: string): string {
	const v = flags.get(name);
	if (!v) {
		console.error(`missing --${name}`);
		process.exit(2);
	}
	return v;
}

// ---------- session-probe ----------

async function sessionProbe(flags: Map<string, string>): Promise<void> {
	const provider = flags.get("provider") ?? "meta";
	const workspace = need(flags, "workspace");
	const out = need(flags, "out");
	const museHome = flags.get("muse-home");
	const museConfigHome = flags.get("muse-config-home");
	const homeOverride = flags.get("home");
	const approvalMode = flags.get("approval-mode") ?? "onRequest";
	const extraServeArgs = (flags.get("serve-args") ?? "")
		.split(" ")
		.filter(Boolean);
	const mcpConfigPath = flags.get("mcp-config");
	const dumpSkills = flags.get("dump-skills");
	const setActivation = flags.get("set-activation"); // selector,scope,state
	const importDryRun = flags.get("import-dry-run"); // claude|codex

	const caps = (flags.get("capabilities") ?? "").split(",").filter(Boolean);
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) env[k] = v;
	}
	if (museConfigHome) env["XDG_CONFIG_HOME"] = museConfigHome;
	if (homeOverride) env["HOME"] = homeOverride;
	const cap = await Capture.spawn({
		provider,
		extraServeArgs,
		museHome,
		logPath: out,
		env,
	});
	try {
		const init = (await cap.call("initialize", {
			clientInfo: { name: "msp_capture", version: "0.1" },
			...(caps.length ? { capabilities: { requestedCapabilities: caps } } : {}),
		})) as Frame;
		console.log(
			`initialize: server=${JSON.stringify((init["serverInfo"] as Frame) ?? null)} durability=${String(init["sessionDurability"] ?? "?")} granted=${JSON.stringify(init["grantedCapabilities"] ?? null)}`,
		);
		cap.notify("initialized", {});
		const startParams: Frame = {
			commandId: uuid7(),
			workspaceRoot: workspace,
			approvalMode,
		};
		if (mcpConfigPath) {
			const cfg = JSON.parse(await Bun.file(mcpConfigPath).text()) as Frame;
			startParams["config"] = { mcpServers: cfg };
		}
		const started = (await cap.call(
			"session/start",
			startParams,
			120_000,
		)) as Frame;
		const session = started["session"] as Frame;
		console.log(
			`session/start: sessionId=${String(session["sessionId"])} status=${String(session["status"] ?? "?")}`,
		);
		const skills = (await cap.call("skill/list", {
			sessionId: session["sessionId"],
		})) as Frame;
		const rows = (skills["skills"] as Frame[]) ?? [];
		console.log(`skill/list: ${rows.length} rows`);
		for (const r of rows) {
			console.log(
				`  - ${String(r["selector"])} [${String(r["source"])}] ${String(r["pluginId"] ?? "")} ${String(r["displayName"] ?? "")} :: ${String(r["description"] ?? "").slice(0, 90)}`,
			);
		}
		if (dumpSkills) {
			await Bun.write(Bun.file(dumpSkills), JSON.stringify(skills, null, 2));
			console.log(`skill/list dumped to ${dumpSkills}`);
		}
		try {
			const plugins = (await cap.call("plugin/list", {
				sessionId: session["sessionId"],
			})) as Frame;
			const prows = (plugins["plugins"] as Frame[]) ?? [];
			console.log(`plugin/list: ${prows.length} rows`);
			for (const r of prows.slice(0, 20)) {
				console.log(
					`  - ${String(r["id"] ?? r["pluginId"] ?? "?")} ${JSON.stringify(r).slice(0, 200)}`,
				);
			}
		} catch (e) {
			console.log(`plugin/list failed: ${e}`);
		}
		try {
			const hooks = (await cap.call("hook/list", {
				sessionId: session["sessionId"],
			})) as Frame;
			console.log(`hook/list: ${JSON.stringify(hooks).slice(0, 300)}`);
		} catch (e) {
			console.log(`hook/list failed: ${e}`);
		}
		if (setActivation) {
			const [selector, scope, activation] = setActivation.split(",");
			try {
				const res = (await cap.call("skill/setActivation", {
					commandId: uuid7(),
					sessionId: session["sessionId"],
					selector,
					scope,
					activation,
				})) as Frame;
				console.log(`skill/setActivation: ${JSON.stringify(res)}`);
				const relist = (await cap.call("skill/list", {
					sessionId: session["sessionId"],
				})) as Frame;
				const rrows = (relist["skills"] as Frame[]) ?? [];
				console.log(`skill/list after setActivation: ${rrows.length} rows`);
				const hit = rrows.filter((r) => String(r["selector"]) === selector);
				for (const r of hit)
					console.log(`  - ${JSON.stringify(r).slice(0, 300)}`);
			} catch (e) {
				console.log(`skill/setActivation failed: ${e}`);
			}
		}
		if (importDryRun) {
			try {
				const res = (await cap.call("skill/import", {
					commandId: uuid7(),
					sessionId: session["sessionId"],
					source: importDryRun,
					dryRun: true,
				})) as Frame;
				console.log(`skill/import dryRun: ${JSON.stringify(res)}`);
			} catch (e) {
				console.log(`skill/import dryRun failed: ${e}`);
			}
		}
		const models = (await cap.call("model/list", {})) as Frame;
		const ms = (models["models"] as Frame[]) ?? [];
		console.log(
			`model/list: ${ms.length} models provider=${String(models["providerId"] ?? "?")}`,
		);
		for (const m of ms.slice(0, 10)) {
			console.log(
				`  - ${String(m["modelId"])}${m["isDefault"] ? " (default)" : ""}`,
			);
		}
		const pending = (await cap.call("approval/listPending", {
			sessionId: session["sessionId"],
		})) as Frame;
		console.log(
			`approval/listPending: approvals=${JSON.stringify((pending["approvals"] as unknown[])?.length ?? "?")} userInputs=${JSON.stringify((pending["userInputs"] as unknown[])?.length ?? "?")}`,
		);
		console.log(`methods seen: ${[...cap.methodsSeen].sort().join(" ")}`);
	} finally {
		await cap.close();
	}
}

// ---------- skills-reread (S4: mid-session mutation visibility) ----------

type MutOp =
	| { op: "add"; name: string; description?: string; body?: string }
	| { op: "edit-desc"; name: string; description: string }
	| { op: "delete"; name: string };

async function skillsReread(flags: Map<string, string>): Promise<void> {
	const provider = flags.get("provider") ?? "meta";
	const workspace = need(flags, "workspace");
	const out = need(flags, "out");
	const museHome = flags.get("muse-home");
	const museConfigHome = flags.get("muse-config-home");
	const homeOverride = flags.get("home");
	const approvalMode = flags.get("approval-mode") ?? "onRequest";
	const extraServeArgs = (flags.get("serve-args") ?? "")
		.split(" ")
		.filter(Boolean);
	const mutatePath = flags.get("mutate-json");
	const settleMs = Number(flags.get("settle-ms") ?? "3000");

	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) env[k] = v;
	}
	if (museConfigHome) env["XDG_CONFIG_HOME"] = museConfigHome;
	if (homeOverride) env["HOME"] = homeOverride;
	const cap = await Capture.spawn({
		provider,
		extraServeArgs,
		museHome,
		logPath: out,
		env,
	});
	const changedNotifs: string[] = [];
	cap.onNotification((method, params) => {
		if (method === "skill/changed" || method === "session/todoListChanged") {
			changedNotifs.push(`${method} ${JSON.stringify(params).slice(0, 200)}`);
		}
	});
	const listSelectors = async (sessionId: string): Promise<Frame[]> => {
		const res = (await cap.call("skill/list", { sessionId })) as Frame;
		return (res["skills"] as Frame[]) ?? [];
	};
	try {
		await cap.call("initialize", {
			clientInfo: { name: "msp_capture", version: "0.1" },
		});
		cap.notify("initialized", {});
		const started = (await cap.call(
			"session/start",
			{ commandId: uuid7(), workspaceRoot: workspace, approvalMode },
			120_000,
		)) as Frame;
		const sessionId = String((started["session"] as Frame)["sessionId"]);
		console.log(`session: ${sessionId}`);
		const before = await listSelectors(sessionId);
		const projBefore = before.filter((r) => r["source"] === "project");
		console.log(
			`skill/list #1: ${before.length} rows (${projBefore.length} project): ${projBefore.map((r) => r["selector"]).join(",")}`,
		);
		if (mutatePath) {
			const ops = JSON.parse(await Bun.file(mutatePath).text()) as MutOp[];
			const { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } =
				await import("node:fs");
			const { join } = await import("node:path");
			for (const m of ops) {
				const dir = join(workspace, ".agents", "skills", m.name);
				if (m.op === "add") {
					mkdirSync(dir, { recursive: true });
					const desc = m.description ?? `probe skill ${m.name}`;
					writeFileSync(
						join(dir, "SKILL.md"),
						`---\nname: ${m.name}\ndescription: ${desc}\n---\n\n# ${m.name}\n\n${m.body ?? "Probe body."}\n`,
					);
					console.log(`[mutate] added ${m.name}`);
				} else if (m.op === "edit-desc") {
					const p = join(dir, "SKILL.md");
					if (existsSync(p)) {
						const cur = readFileSync(p, "utf8");
						writeFileSync(
							p,
							cur.replace(/^description: .*/m, `description: ${m.description}`),
						);
						console.log(`[mutate] edited ${m.name} description`);
					} else {
						console.log(`[mutate] edit skipped, missing ${m.name}`);
					}
				} else if (m.op === "delete") {
					rmSync(dir, { recursive: true, force: true });
					console.log(`[mutate] deleted ${m.name}`);
				}
			}
			console.log(`waiting ${settleMs}ms for skill/changed...`);
			await new Promise((r) => setTimeout(r, settleMs));
		}
		const after = await listSelectors(sessionId);
		const projAfter = after.filter((r) => r["source"] === "project");
		console.log(
			`skill/list #2 (same session): ${after.length} rows (${projAfter.length} project): ${projAfter.map((r) => r["selector"]).join(",")}`,
		);
		for (const r of projAfter) {
			console.log(
				`  - ${String(r["selector"])} :: ${String(r["description"] ?? "").slice(0, 80)}`,
			);
		}
		console.log(
			`skill/changed notifications during settle: ${changedNotifs.length}`,
		);
		for (const n of changedNotifs) console.log(`  - ${n}`);
		console.log(`methods seen: ${[...cap.methodsSeen].sort().join(" ")}`);
	} finally {
		await cap.close();
	}
}

// ---------- turn ----------

type ApprovalPolicy = "once" | "session" | "deny" | "never";
type UserInputPolicy = "first" | "cancel" | "never";

async function turnCmd(flags: Map<string, string>): Promise<void> {
	const provider = flags.get("provider") ?? "meta";
	const workspace = need(flags, "workspace");
	const out = need(flags, "out");
	const prompt = need(flags, "prompt");
	const museHome = flags.get("muse-home");
	const approvalMode = flags.get("approval-mode") ?? "onRequest";
	const approvalPolicy = (flags.get("approve") ?? "never") as ApprovalPolicy;
	const userInputPolicy = (flags.get("answer") ?? "never") as UserInputPolicy;
	const decideDelayMs = Number(flags.get("decide-delay-ms") ?? "1500");
	const settleWaitMs = Number(flags.get("settle-wait-ms") ?? "90000");
	const turnTimeoutMs = Number(flags.get("timeout-ms") ?? "420000");
	const extraServeArgs = (flags.get("serve-args") ?? "")
		.split(" ")
		.filter(Boolean);
	const mcpConfigPath = flags.get("mcp-config");
	const caps = (flags.get("capabilities") ?? "").split(",").filter(Boolean);

	const cap = await Capture.spawn({
		provider,
		extraServeArgs,
		museHome,
		logPath: out,
	});
	const agentTexts: string[] = [];
	let turnId = "";
	let sessionId = "";
	let completed: Frame | null = null;
	let sawApproval = 0;
	let sawUserInput = 0;
	let turnDone!: (v: Frame) => void;
	const turnGate = new Promise<Frame>((res) => {
		turnDone = res;
	});

	cap.onServerRequest((id, method, params) => {
		if (method === "approval/request") {
			sawApproval++;
			console.log(
				`[S->C req #${id}] approval/request approvalId=${String(params["approvalId"])} tool=${String(params["toolName"])} subject.kind=${String((params["subject"] as Frame)?.["kind"] ?? "?")}`,
			);
			const choices = (params["availableChoices"] as Frame[]) ?? [];
			for (const c of choices) {
				console.log(
					`    choice: id=${String(c["choiceId"])} decision=${String(c["decision"])} scope=${String(c["scope"])} label=${String(c["label"])}`,
				);
			}
			cap.respond(id, {}); // presentation receipt (schema: ack only)
			void (async () => {
				await new Promise((r) => setTimeout(r, decideDelayMs));
				if (completed) return;
				if (approvalPolicy === "never") {
					console.log(
						`[policy] never deciding approval ${String(params["approvalId"])}`,
					);
					return;
				}
				let pick: Frame | undefined;
				if (approvalPolicy === "deny") {
					pick =
						choices.find(
							(c) =>
								String(c["decision"]) === "denied" &&
								String(c["scope"]) === "once",
						) ??
						choices.find((c) => String(c["decision"]) === "denied") ??
						choices.find((c) => String(c["decision"]) === "abort");
				} else {
					const scope = approvalPolicy === "session" ? "session" : "once";
					pick =
						choices.find(
							(c) =>
								String(c["decision"]).startsWith("approv") &&
								String(c["scope"]) === scope,
						) ??
						choices.find((c) => String(c["decision"]).startsWith("approv"));
				}
				if (!pick) {
					console.log("[policy] no matching choice; not deciding");
					return;
				}
				console.log(
					`[policy] approval/decide choiceId=${String(pick["choiceId"])}`,
				);
				try {
					const res = await cap.call("approval/decide", {
						commandId: uuid7(),
						sessionId,
						approvalId: params["approvalId"],
						requirementId: params["currentRequirementId"],
						choiceId: pick["choiceId"],
					});
					console.log(`[policy] decide result: ${JSON.stringify(res)}`);
				} catch (e) {
					console.log(`[policy] decide failed: ${e}`);
				}
			})();
			return;
		}
		if (method === "userInput/request") {
			sawUserInput++;
			const qs = (params["questions"] as Frame[]) ?? [];
			console.log(
				`[S->C req #${id}] userInput/request userInputId=${String(params["userInputId"])} autoResolutionMs=${String(params["autoResolutionMs"] ?? "?")} questions=${qs.length}`,
			);
			for (const q of qs) {
				console.log(
					`    q: id=${String(q["id"])} header=${String(q["header"])} selection=${JSON.stringify(q["selection"])}`,
				);
				console.log(`       question=${String(q["question"])}`);
				for (const o of (q["options"] as Frame[]) ?? []) {
					console.log(
						`       option: label=${String(o["label"])} desc=${String(o["description"] ?? "").slice(0, 120)}`,
					);
				}
			}
			cap.respond(id, {}); // presentation receipt
			void (async () => {
				await new Promise((r) => setTimeout(r, decideDelayMs));
				if (completed) return;
				if (userInputPolicy === "never") {
					console.log(
						`[policy] never answering userInput ${String(params["userInputId"])}`,
					);
					return;
				}
				if (userInputPolicy === "cancel") {
					console.log(`[policy] userInput/cancel`);
					try {
						const res = await cap.call("userInput/cancel", {
							commandId: uuid7(),
							sessionId,
							userInputId: params["userInputId"],
							reason: "capture probe cancel",
						});
						console.log(`[policy] cancel result: ${JSON.stringify(res)}`);
					} catch (e) {
						console.log(`[policy] cancel failed: ${e}`);
					}
					return;
				}
				const answers = qs.map((q) => {
					const opts = (q["options"] as Frame[]) ?? [];
					const mode = (q["selection"] as Frame | undefined)?.["mode"];
					if (mode === "multiple") {
						return {
							questionId: q["id"],
							selectedLabels: [opts[0]?.["label"]],
						};
					}
					return { questionId: q["id"], selectedLabel: opts[0]?.["label"] };
				});
				console.log(`[policy] userInput/answer ${JSON.stringify(answers)}`);
				try {
					const res = await cap.call("userInput/answer", {
						commandId: uuid7(),
						sessionId,
						userInputId: params["userInputId"],
						answers,
					});
					console.log(`[policy] answer result: ${JSON.stringify(res)}`);
				} catch (e) {
					console.log(`[policy] answer failed: ${e}`);
				}
			})();
			return;
		}
		console.log(`[S->C req #${id}] UNKNOWN method ${method}; answering {}`);
		cap.respond(id, {});
	});

	cap.onNotification((method, params) => {
		if (method === "item/completed" || method === "item/updated") {
			const item = params["item"] as Frame | undefined;
			if (
				item?.["kind"] === "agentMessage" &&
				typeof item["text"] === "string" &&
				item["text"]
			) {
				if (!agentTexts.includes(item["text"])) agentTexts.push(item["text"]);
			}
		}
		if (method === "turn/completed" && String(params["turnId"]) === turnId) {
			completed = params;
			turnDone(params);
		}
	});

	try {
		const initRes = (await cap.call("initialize", {
			clientInfo: { name: "msp_capture", version: "0.1" },
			...(caps.length ? { capabilities: { requestedCapabilities: caps } } : {}),
		})) as Frame;
		if (caps.length)
			console.log(
				`grantedCapabilities: ${JSON.stringify(initRes["grantedCapabilities"] ?? null)}`,
			);
		cap.notify("initialized", {});
		const startParams: Frame = {
			commandId: uuid7(),
			workspaceRoot: workspace,
			approvalMode,
		};
		if (mcpConfigPath) {
			const cfg = JSON.parse(await Bun.file(mcpConfigPath).text()) as Frame;
			startParams["config"] = { mcpServers: cfg };
		}
		const started = (await cap.call(
			"session/start",
			startParams,
			120_000,
		)) as Frame;
		sessionId = String((started["session"] as Frame)["sessionId"]);
		console.log(`session: ${sessionId}`);
		const t = (await cap.call("turn/start", {
			commandId: uuid7(),
			sessionId,
			input: [{ type: "text", text: prompt }],
		})) as Frame;
		turnId = String(t["turnId"]);
		console.log(
			`turn: ${turnId} disposition=${String(t["disposition"] ?? "?")}`,
		);
		const winner = await Promise.race([
			turnGate,
			new Promise<null>((res) => setTimeout(() => res(null), turnTimeoutMs)),
		]);
		if (winner === null) {
			console.log(
				`TURN TIMEOUT after ${turnTimeoutMs}ms (approvals=${sawApproval} userInputs=${sawUserInput})`,
			);
			if (sawApproval > 0 || sawUserInput > 0) {
				try {
					const pending = (await cap.call("approval/listPending", {
						sessionId,
					})) as Frame;
					console.log(
						`listPending while stuck: approvals=${(pending["approvals"] as unknown[])?.length} userInputs=${(pending["userInputs"] as unknown[])?.length}`,
					);
				} catch (e) {
					console.log(`listPending failed: ${e}`);
				}
				console.log(
					`waiting ${settleWaitMs}ms more to observe settle behavior...`,
				);
				const w2 = await Promise.race([
					turnGate,
					new Promise<null>((res) => setTimeout(() => res(null), settleWaitMs)),
				]);
				if (w2 === null) {
					console.log("still stuck; sending turn/interrupt");
					try {
						const r = await cap.call("turn/interrupt", {
							commandId: uuid7(),
							sessionId,
						});
						console.log(`interrupt result: ${JSON.stringify(r)}`);
					} catch (e) {
						console.log(`interrupt failed: ${e}`);
					}
					const w3 = await Promise.race([
						turnGate,
						new Promise<null>((res) => setTimeout(() => res(null), 60_000)),
					]);
					console.log(
						`after interrupt: ${w3 === null ? "no turn/completed within 60s" : `completed terminal=${String((w3 as Frame)["terminal"])}`}`,
					);
				} else {
					console.log(
						`settled during settle-wait: terminal=${String((w2 as Frame)["terminal"])}`,
					);
				}
			}
		} else {
			console.log(
				`turn/completed terminal=${String(winner["terminal"])} error=${JSON.stringify(winner["error"] ?? null)}`,
			);
		}
		console.log(`--- agent texts (${agentTexts.length}) ---`);
		for (const a of agentTexts) console.log(a.slice(0, 2000));
		console.log(`methods seen: ${[...cap.methodsSeen].sort().join(" ")}`);
	} finally {
		await cap.close();
	}
}

// ---------- mcp-server (trivial host tool for B2) ----------

async function mcpServer(): Promise<void> {
	const logPath = process.env["CAPTURE_MCP_LOG"] ?? "";
	// Sync append per line: FileSink writers can lose the tail at exit.
	const { appendFileSync } = await import("node:fs");
	if (logPath) await Bun.write(Bun.file(logPath), "");
	const log = (obj: unknown): void => {
		const line = `${JSON.stringify({ t: new Date().toISOString(), ...((obj as Frame) ?? {}) })}\n`;
		if (logPath) appendFileSync(logPath, line);
		console.error(`[mcp] ${line.trim()}`);
	};
	const reader = Bun.stdin.stream().getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buf = "";
	async function writeFrame(
		obj: unknown,
		contentLength: boolean,
	): Promise<void> {
		const body = JSON.stringify(obj);
		const out = contentLength
			? `Content-Length: ${encoder.encode(body).length}\r\n\r\n${body}`
			: `${body}\n`;
		await Bun.write(Bun.stdout, out);
	}
	function handle(msg: Frame, contentLength: boolean): void {
		const id = msg["id"];
		const method = msg["method"];
		log({ dir: "H>", msg });
		const respond = (result: unknown): void => {
			const frame = { jsonrpc: "2.0", id, result };
			log({ dir: ">H", frame });
			void writeFrame(frame, contentLength);
		};
		if (method === "initialize") {
			respond({
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "wire-probe", version: "0.1" },
			});
			return;
		}
		if (typeof method === "string" && method.startsWith("notifications/"))
			return;
		if (method === "tools/list") {
			respond({
				tools: [
					{
						name: "ui_show_note",
						description:
							"Show a short note in the host UI. USE THIS when the user asks to display a note.",
						inputSchema: {
							type: "object",
							properties: {
								text: { type: "string", description: "Note text" },
							},
							required: ["text"],
						},
					},
				],
			});
			return;
		}
		if (method === "tools/call") {
			const params = (msg["params"] as Frame) ?? {};
			const args = (params["arguments"] as Frame) ?? {};
			respond({
				content: [
					{ type: "text", text: `noted: ${String(args["text"] ?? "")}` },
				],
			});
			return;
		}
		if (id !== undefined) {
			const frame = {
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: `unknown method ${String(method)}` },
			};
			log({ dir: ">H", frame });
			void writeFrame(frame, contentLength);
		}
	}
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			for (;;) {
				if (buf.startsWith("Content-Length:")) {
					const sep = buf.indexOf("\r\n\r\n");
					if (sep < 0) break;
					const m = /^Content-Length:\s*(\d+)/i.exec(buf);
					if (!m) break;
					const len = Number(m[1]);
					const body = buf.slice(sep + 4);
					if (encoder.encode(body).length < len && body.length < len) break;
					const text = body.slice(0, len);
					buf = body.slice(len);
					try {
						handle(JSON.parse(text) as Frame, true);
					} catch {
						// ignore
					}
					continue;
				}
				const nl = buf.indexOf("\n");
				if (nl < 0) break;
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				try {
					handle(JSON.parse(line) as Frame, false);
				} catch {
					// ignore
				}
			}
		}
	} catch {
		// stdin closed
	}
}

// ---------- main ----------

const { cmd, flags } = args(process.argv.slice(2));
if (cmd === "session-probe") await sessionProbe(flags);
else if (cmd === "skills-reread") await skillsReread(flags);
else if (cmd === "turn") await turnCmd(flags);
else if (cmd === "mcp-server") await mcpServer();
else {
	console.error(
		"usage: msp-capture.ts <session-probe|skills-reread|turn|mcp-server> [flags]",
	);
	process.exit(2);
}
