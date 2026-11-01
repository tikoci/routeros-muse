// T71 scriptable fake `muse serve` (stdin/stdout JSONL) plus the hermetic
// harness around it. Shared by the suite (tests/t71-stop.test.ts) and
// the browser smoke (tools/ui-smoke.ts): one fake source, no drift.
//
// Modes via T71_MODE (worker env, snapshotted at server start):
// - interruptible: turns stay live until turn/interrupt, which acks and
//   emits turn/completed terminal=cancelled (mirrors real echo, whose
//   shapes were captured in the T71 wire probe: turnId on every
//   turn/* event, idle interrupt rejected commandRejected/missing_run
//   code -32030). Stdin EOF exits.
// - ignoring: acks turn/interrupt but never completes; ignores stdin
//   EOF (stays alive, like the t80-close-probe child); dies on signals
//   (SIGTERM is trapped to log DIED, then exits).
// - hang: never answers turn/interrupt (but missing_run when idle, like
//   a wedged transport on an otherwise live turn); EOF exits.
// - slow: interruptible plus auto-complete after T71_SLOW_MS.
//
// T71_INTERRUPT_DELAY_MS delays the post-interrupt completion (the ack
// stays immediate) so the smoke can screenshot the Stopping ticker.
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../src/serve/server";

// Plain JS in a .ts file: generated into the temp bin dir at runtime,
// never linted. Runs under the bun binary (process.execPath).
export const T71_FAKE_MUSE = String.raw`
// T71 scriptable fake muse host: JSONL over stdio.
import * as fs from "node:fs";
import * as readline from "node:readline";

const log = process.env["T71_LOG"] ?? "";
const mode = process.env["T71_MODE"] ?? "interruptible";
const slowMs = Number(process.env["T71_SLOW_MS"] ?? "30000");
const interruptDelayMs = Number(
	process.env["T71_INTERRUPT_DELAY_MS"] ?? "0",
);

function logLine(line) {
	if (log) fs.appendFileSync(log, line + "\n");
}

const SESSION = "t71-s1";
let turnN = 0;
let completedN = 0;
let liveTurn = null;
let slowTimer = null;
const pid = process.pid;
logLine("SPAWN pid=" + pid + " mode=" + mode);

process.on("SIGTERM", () => {
	logLine("DIED sig=SIGTERM");
	process.exit(0);
});

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let dead = false;
if (mode === "ignoring") {
	setInterval(() => {}, 1000);
}
function onEof() {
	logLine("EOF mode=" + mode);
	if (mode === "ignoring") {
		logLine("EOF_IGNORED");
		return;
	}
	if (dead) return;
	dead = true;
	process.exit(0);
}
rl.on("close", onEof);
process.stdin.on("end", onEof);
process.stdin.resume();

function send(obj) {
	if (dead) return;
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function notify(method, params) {
	send({ jsonrpc: "2.0", method: method, params: params });
}

function completeLive(terminal) {
	if (!liveTurn) return;
	const id = liveTurn;
	liveTurn = null;
	completedN += 1;
	if (slowTimer) {
		clearTimeout(slowTimer);
		slowTimer = null;
	}
	logLine("COMPLETE turnId=" + id + " terminal=" + terminal);
	notify("turn/completed", {
		sessionId: SESSION,
		turnId: id,
		terminal: terminal,
	});
}

rl.on("line", (text) => {
	if (dead) return;
	const trimmed = text.trim();
	if (!trimmed) return;
	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (typeof msg.id !== "number") return;
	const id = msg.id;
	const method = msg.method;
	const params = msg.params ?? {};
	if (method === "initialize") {
		send({ jsonrpc: "2.0", id: id, result: {} });
		return;
	}
	if (method === "session/start") {
		logLine("START session=" + SESSION);
		send({
			jsonrpc: "2.0",
			id: id,
			result: { session: { sessionId: SESSION }, viewCursor: "" },
		});
		return;
	}
	if (method === "turn/start") {
		if (params.sessionId !== SESSION) {
			send({
				jsonrpc: "2.0",
				id: id,
				error: {
					code: -32000,
					message: "session not loaded: " + String(params.sessionId),
					data: { kind: "sessionNotLoaded", retryable: false },
				},
			});
			return;
		}
		if (liveTurn) logLine("ORPHAN turnId=" + liveTurn);
		if (slowTimer) {
			clearTimeout(slowTimer);
			slowTimer = null;
		}
		turnN += 1;
		const t = "t71-t" + turnN;
		liveTurn = t;
		logLine("RECV_TURN turnId=" + t);
		send({
			jsonrpc: "2.0",
			id: id,
			result: { turnId: t, disposition: "started" },
		});
		notify("turn/started", { sessionId: SESSION, turnId: t });
		if (mode === "slow") {
			slowTimer = setTimeout(() => {
				if (liveTurn === t) completeLive("completed");
			}, slowMs);
		}
		return;
	}
	if (method === "turn/interrupt") {
		const want = params.turnId;
		logLine(
			"RECV_INTERRUPT turnId=" +
				String(want ?? "(unpinned)") +
				" live=" +
				String(liveTurn),
		);
		if (!liveTurn || (typeof want === "string" && want !== liveTurn)) {
			send({
				jsonrpc: "2.0",
				id: id,
				error: {
					code: -32030,
					message: "turn/interrupt command rejected: missing_run",
					data: {
						kind: "commandRejected",
						retryable: false,
						reason: "missing_run",
					},
				},
			});
			return;
		}
		if (mode === "hang") return;
		send({
			jsonrpc: "2.0",
			id: id,
			result: { status: "accepted", turnId: liveTurn },
		});
		if (mode === "ignoring") return;
		const t = liveTurn;
		const finish = () => {
			if (liveTurn === t) completeLive("cancelled");
		};
		if (interruptDelayMs > 0) setTimeout(finish, interruptDelayMs);
		else finish();
		return;
	}
	if (method === "view/page") {
		send({ jsonrpc: "2.0", id: id, result: { events: [], nextCursor: null } });
		return;
	}
	if (method === "session/list") {
		send({
			jsonrpc: "2.0",
			id: id,
			result: {
				sessions: [{ sessionId: SESSION, turnCount: completedN }],
			},
		});
		return;
	}
	if (method === "model/list") {
		send({
			jsonrpc: "2.0",
			id: id,
			result: {
				models: [
					{ modelId: "t71-fake", displayLabel: "t71-fake", isDefault: true },
				],
				providerId: "t71",
			},
		});
		return;
	}
	send({ jsonrpc: "2.0", id: id, result: {} });
});
`;

function writeShim(dir: string, name: string, body: string): void {
	const file = path.join(dir, name);
	nodeFs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	nodeFs.chmodSync(file, 0o755);
}

/** Fronted PATH dir: T71 fake muse + shadow trilogy (all hermetic). */
export function stubT71Bin(): { bin: string; log: string } {
	const bin = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t71-bin-"));
	const log = path.join(bin, "msp.log");
	nodeFs.writeFileSync(path.join(bin, "fake-muse-t71.ts"), T71_FAKE_MUSE);
	writeShim(
		bin,
		"muse",
		`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, "fake-muse-t71.ts"))} "$@"`,
	);
	// Trilogy shadows: nothing under test spawns trilogy work, but the
	// server detects the CDB mode through `centrs devices list` at boot
	// (and versions on /api/status; quickchr version phones home), so
	// ambient binaries must never resolve through the fronted PATH. The
	// stub answers open vs cdb/not-found from the --cdb-file target.
	writeShim(
		bin,
		"centrs",
		`if [ "$1" = "devices" ]; then\n` +
			`file=""; prev=""; for a in "$@"; do if [ "$prev" = "--cdb-file" ]; then file="$a"; fi; prev="$a"; done\n` +
			`if [ -n "$file" ] && [ -f "$file" ]; then\n` +
			`printf '%s\\n' '{"ok":true,"data":[],"warnings":[],"tips":[],"meta":{}}'\n` +
			`else\n` +
			`printf '%s\\n' '{"ok":false,"error":{"code":"cdb/not-found","summary":"CDB file not found"},"warnings":[],"tips":[],"meta":{}}'\n` +
			`fi\n` +
			`else\n` +
			`echo "stub-centrs 9.9.9-t71"\n` +
			`fi`,
	);
	for (const tool of ["quickchr", "rosetta"]) {
		writeShim(bin, tool, `echo "stub-${tool} 9.9.9-t71"`);
	}
	return { bin, log };
}

export type T71Mode = "interruptible" | "ignoring" | "hang" | "slow";

/**
 * Run fn with the fake-muse env set (restored after). The fake reads
 * its config from the spawn env, which the server snapshots from
 * process.env at startup — so the server must start inside fn.
 */
export async function withT71Env<T>(
	log: string,
	opts: { mode: T71Mode; slowMs?: number; interruptDelayMs?: number },
	fn: () => Promise<T>,
): Promise<T> {
	const keys = [
		"T71_LOG",
		"T71_MODE",
		"T71_SLOW_MS",
		"T71_INTERRUPT_DELAY_MS",
	] as const;
	const saved = new Map<string, string | undefined>();
	for (const k of keys) saved.set(k, process.env[k]);
	process.env["T71_LOG"] = log;
	process.env["T71_MODE"] = opts.mode;
	if (opts.slowMs !== undefined)
		process.env["T71_SLOW_MS"] = String(opts.slowMs);
	if (opts.interruptDelayMs !== undefined)
		process.env["T71_INTERRUPT_DELAY_MS"] = String(opts.interruptDelayMs);
	try {
		return await fn();
	} finally {
		for (const k of keys) {
			const v = saved.get(k);
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** Minimal workspace (workspace.toml only; chat routes need no files). */
export function makeT71Workspace(): string {
	const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t71-ws-"));
	nodeFs.writeFileSync(path.join(dir, "workspace.toml"), "canonical = true\n");
	return dir;
}

/** Bypass-mode server on the fake worker (no CDB file, no centrs). */
export async function startT71Srv(bin: string): Promise<{
	url: string;
	stop: () => Promise<void>;
}> {
	return startServer({
		dataHome: nodeFs.mkdtempSync(path.join(os.tmpdir(), "t71-dh-")),
		allowOpenCdb: true,
		workspace: makeT71Workspace(),
		provider: "echo",
		museHome: nodeFs.mkdtempSync(path.join(os.tmpdir(), "t71-home-")),
		toolBinDir: bin,
	});
}

/** Poll a fake log until re matches (throws with the tail on timeout). */
export async function pollT71Log(
	file: string,
	re: RegExp,
	timeoutMs: number,
): Promise<string> {
	const start = Date.now();
	for (;;) {
		let text = "";
		try {
			text = nodeFs.readFileSync(file, "utf8");
		} catch {
			// no worker has logged yet
		}
		if (re.test(text)) return text;
		if (Date.now() - start > timeoutMs) {
			throw new Error(`t71 log never matched ${re}: ${text.slice(-400)}`);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

function readT71Log(file: string): string {
	try {
		return nodeFs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** Count fake-log lines starting with the given prefix. */
export function countT71Lines(file: string, prefix: string): number {
	return readT71Log(file)
		.split("\n")
		.filter((l) => l.startsWith(prefix)).length;
}

/** PIDs the fake logged at spawn (one SPAWN line per worker). */
export function t71SpawnedPids(file: string): number[] {
	return readT71Log(file)
		.split("\n")
		.map((l) => /^SPAWN pid=(\d+)/.exec(l)?.[1])
		.filter((p): p is string => p !== undefined)
		.map(Number);
}

/** Resolve when kill(pid, 0) says the process is gone. */
export async function pollT71PidGone(
	pid: number,
	timeoutMs: number,
): Promise<void> {
	const start = Date.now();
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		if (Date.now() - start > timeoutMs) {
			throw new Error(`t71 pid ${pid} still alive after ${timeoutMs}ms`);
		}
		await new Promise((r) => setTimeout(r, 50));
	}
}
