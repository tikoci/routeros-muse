// Main-session owner binding (T81). The server's cached main session
// belongs to the worker owner (unlock token, else "bypass") that
// started it: a new owner re-inits on its own worker instead of
// reusing the previous worker's session ID.
//
// Hermetic: a stateful fake `muse` fronts PATH via toolBinDir (per-
// process session IDs; turn/start on an unknown session answers
// sessionNotLoaded, like the real host), and a stub centrs emulates
// an encrypted CDB for unlock tokens. The ambient `muse` binary is
// only probed for presence (the server's spawn gate), never run.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { have } from "../src/lib/run";
import { startServer } from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

const HAVE_MUSE = have("muse");
// Shell shims (POSIX) + the server's ambient-muse spawn gate.
const t81 = HAVE_MUSE && process.platform !== "win32" ? test : test.skip;

// Stub-CDB password. The stub centrs below accepts exactly this.
const T81_PASSWORD = "t81-fixture-password";

// Stateful fake `muse serve` (stdin/stdout JSONL). Plain JS in a .ts
// file: generated into the temp bin dir at runtime, never linted.
// Per-process sessions: session IDs embed the PID, and turn/start on
// an unknown session answers sessionNotLoaded. Stdin EOF exits
// immediately (abandoning a delayed response), which is what lets
// lock/takeover close a worker with a session start in flight.
const FAKE_MUSE = String.raw`
// T81 stateful fake muse host: JSONL over stdio, per-process sessions.
import * as fs from "node:fs";
import * as readline from "node:readline";

const log = process.env["T81_LOG"] ?? "";
const delayMs = Number(process.env["T81_SESSION_START_DELAY_MS"] ?? "0");

function logLine(line) {
	if (log) fs.appendFileSync(log, line + "\n");
}

const sessions = new Set();
let sessionN = 0;
let turnN = 0;
const pid = process.pid;

logLine("SPAWN pid=" + pid);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let dead = false;
function onEof() {
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
		logLine("RECV_SESSION_START pid=" + pid);
		const respond = () => {
			if (dead) return;
			sessionN += 1;
			const s = "t81-" + pid + "-" + sessionN;
			sessions.add(s);
			logLine("START pid=" + pid + " session=" + s);
			send({
				jsonrpc: "2.0",
				id: id,
				result: { session: { sessionId: s }, viewCursor: "" },
			});
		};
		if (delayMs > 0) setTimeout(respond, delayMs);
		else respond();
		return;
	}
	if (method === "turn/start") {
		const s = params.sessionId;
		if (typeof s === "string" && sessions.has(s)) {
			turnN += 1;
			logLine("TURN pid=" + pid + " session=" + s + " ok=1");
			send({
				jsonrpc: "2.0",
				id: id,
				result: { turnId: "t81-turn-" + pid + "-" + turnN, disposition: "started" },
			});
		} else {
			logLine("TURN pid=" + pid + " session=" + String(s) + " ok=0");
			send({
				jsonrpc: "2.0",
				id: id,
				error: {
					code: -32000,
					message: "session not loaded: " + String(s),
					data: { kind: "sessionNotLoaded", retryable: false },
				},
			});
		}
		return;
	}
	if (method === "view/page") {
		send({ jsonrpc: "2.0", id: id, result: { events: [], nextCursor: null } });
		return;
	}
	if (method === "session/list") {
		const known = [];
		for (const s of sessions) known.push({ sessionId: s });
		send({ jsonrpc: "2.0", id: id, result: { sessions: known } });
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

/** Fronted PATH dir: stateful fake muse + stub trilogy (all hermetic). */
function stubBin(): { bin: string; log: string } {
	const bin = mktmp("t81-bin-");
	const log = path.join(bin, "msp.log");
	nodeFs.writeFileSync(path.join(bin, "fake-muse.ts"), FAKE_MUSE);
	writeShim(
		bin,
		"muse",
		`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, "fake-muse.ts"))} "$@"`,
	);
	writeShim(
		bin,
		"centrs",
		`if [ "$1" = "devices" ]; then\n` +
			`if [ "$CENTRS_CDB_PASSWORD" = ${JSON.stringify(T81_PASSWORD)} ]; then\n` +
			`printf '%s\\n' '{"ok":true,"data":[],"warnings":[],"tips":[],"meta":{}}'\n` +
			`else\n` +
			`printf '%s\\n' '{"ok":false,"error":{"code":"cdb/password-required","summary":"password required"},"warnings":[],"tips":[],"meta":{}}'\n` +
			`fi\n` +
			`else\n` +
			`echo "stub-centrs 9.9.2-t81"\n` +
			`fi`,
	);
	writeShim(
		bin,
		"quickchr",
		`if [ "$1" = "list" ]; then echo "[]"; else echo "stub-quickchr 9.9.1-t81"; fi`,
	);
	writeShim(bin, "rosetta", `echo "stub-rosetta 9.9.3-t81"`);
	return { bin, log };
}

async function startT81Srv(bin: string): Promise<{
	url: string;
	stop: () => Promise<void>;
}> {
	const dir = mktmp("t81-cdb-");
	const cdb = path.join(dir, "device.cdb");
	nodeFs.writeFileSync(cdb, "t81 stub-backed CDB placeholder\n");
	return startServer({
		dataHome: mktmp("t81-dh-"),
		configHome: mktmp("t81-cfg-"),
		noWorkspace: true,
		provider: "echo",
		museHome: mktmp("t81-home-"),
		cdbFile: cdb,
		toolBinDir: bin,
	});
}

/**
 * Run fn with the fake-muse env set (restored after). The fake reads
 * its config from the spawn env, which the server snapshots from
 * process.env at startup — so the server must start inside fn.
 */
async function withFakeEnv<T>(
	log: string,
	delayMs: number,
	fn: () => Promise<T>,
): Promise<T> {
	const savedLog = process.env["T81_LOG"];
	const savedDelay = process.env["T81_SESSION_START_DELAY_MS"];
	process.env["T81_LOG"] = log;
	process.env["T81_SESSION_START_DELAY_MS"] = String(delayMs);
	try {
		return await fn();
	} finally {
		if (savedLog === undefined) delete process.env["T81_LOG"];
		else process.env["T81_LOG"] = savedLog;
		if (savedDelay === undefined) {
			delete process.env["T81_SESSION_START_DELAY_MS"];
		} else {
			process.env["T81_SESSION_START_DELAY_MS"] = savedDelay;
		}
	}
}

function cookieFrom(res: Response): string | null {
	const set = res.headers.get("set-cookie");
	if (!set) return null;
	const m = /rmsid=([^;]+)/.exec(set);
	return m?.[1] ? `rmsid=${m[1]}` : null;
}

type Posted = {
	status: number;
	json: Record<string, unknown>;
	res: Response;
};

async function postJson(
	url: string,
	body: unknown,
	cookie?: string,
): Promise<Posted> {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: new URL(url).origin,
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
		res,
	};
}

async function unlock(srvUrl: string): Promise<string> {
	const posted = await postJson(`${srvUrl}api/auth/unlock`, {
		password: T81_PASSWORD,
	});
	if (!posted.json["ok"]) {
		throw new Error(`t81 unlock failed: ${posted.status}`);
	}
	const cookie = cookieFrom(posted.res);
	if (!cookie) throw new Error("t81 unlock set no cookie");
	return cookie;
}

async function pollLog(
	file: string,
	re: RegExp,
	timeoutMs: number,
): Promise<void> {
	const start = Date.now();
	for (;;) {
		let text = "";
		try {
			text = nodeFs.readFileSync(file, "utf8");
		} catch {
			// no worker has logged yet
		}
		if (re.test(text)) return;
		if (Date.now() - start > timeoutMs) {
			throw new Error(`t81 log never matched ${re}: ${text.slice(-400)}`);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** Workers the fake spawned (one SPAWN line each); wedge detector. */
function spawnCount(file: string): number {
	let text = "";
	try {
		text = nodeFs.readFileSync(file, "utf8");
	} catch {
		return 0;
	}
	return text.split("\n").filter((l) => l.startsWith("SPAWN")).length;
}

describe("main-session owner binding (T81)", () => {
	t81(
		"sequential takeover: the new owner's first send succeeds on its own session",
		async () => {
			const { bin, log } = stubBin();
			await withFakeEnv(log, 0, async () => {
				const srv = await startT81Srv(bin);
				try {
					const cookieA = await unlock(srv.url);
					const first = await postJson(
						`${srv.url}api/chat/send`,
						{ text: "T81-A-FIRST" },
						cookieA,
					);
					expect(first.status).toBe(200);
					expect(first.json["ok"]).toBe(true);
					const sA = first.json["sessionId"];
					expect(typeof sA).toBe("string");
					const cookieB = await unlock(srv.url);
					const second = await postJson(
						`${srv.url}api/chat/send`,
						{ text: "T81-B-FIRST" },
						cookieB,
					);
					expect(second.status).toBe(200);
					expect(second.json["ok"]).toBe(true);
					expect(second.json["sessionId"]).not.toBe(sA);
					expect(nodeFs.readFileSync(log, "utf8")).not.toContain("ok=0");
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t81(
		"exact spawn-window overlap converges: both inits return promptly on bounded workers",
		async () => {
			// Both owners init concurrently with no session-start
			// delay, so the overlap lands in the spawn window: the
			// stale starter adopts the live generation instead of
			// re-stealing (always-recurse wedged here — hundreds of
			// workers, both inits timing out). Exactly one
			// contender's post-init read then loses its worker to
			// the other's takeover (route-level, deterministic) —
			// the pair settles 200+500 in arrival order, never
			// hangs. Afterwards each key sends sequentially,
			// first-try 200. Steady-state genuinely-concurrent
			// SENDS are out of scope per D31 — convergence +
			// bounded spawn + sequential first-try is the invariant
			// pinned here.
			const { bin, log } = stubBin();
			await withFakeEnv(log, 0, async () => {
				const srv = await startT81Srv(bin);
				try {
					const cookieA = await unlock(srv.url);
					const cookieB = await unlock(srv.url);
					const t0 = Date.now();
					const [resA, resB] = await Promise.all([
						fetch(`${srv.url}api/chat/history`, {
							headers: { cookie: cookieA },
							signal: AbortSignal.timeout(12_000),
						}),
						fetch(`${srv.url}api/chat/history`, {
							headers: { cookie: cookieB },
							signal: AbortSignal.timeout(12_000),
						}),
					]);
					expect(Date.now() - t0).toBeLessThan(10_000);
					// Contention outcome, arrival order aside: the
					// adopter's read lands, the publisher's read
					// loses its worker mid-flight.
					expect([resA.status, resB.status].sort()).toEqual([200, 500]);
					// One worker per contender, no recurse storm.
					expect(spawnCount(log)).toBeLessThanOrEqual(4);
					const sendA = await postJson(
						`${srv.url}api/chat/send`,
						{ text: "T81-2-A" },
						cookieA,
					);
					expect(sendA.status).toBe(200);
					const sendB = await postJson(
						`${srv.url}api/chat/send`,
						{ text: "T81-2-B" },
						cookieB,
					);
					expect(sendB.status).toBe(200);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t81(
		"lock racing an in-flight session start: the next waiter gets a live session on bounded workers",
		async () => {
			const { bin, log } = stubBin();
			await withFakeEnv(log, 1500, async () => {
				const srv = await startT81Srv(bin);
				try {
					const cookieA = await unlock(srv.url);
					const pendingA = fetch(`${srv.url}api/chat/history`, {
						headers: { cookie: cookieA },
					});
					await pollLog(log, /RECV_SESSION_START/, 15_000);
					const lock = await postJson(`${srv.url}api/auth/lock`, {}, cookieA);
					expect(lock.status).toBe(200);
					expect(lock.json["ok"]).toBe(true);
					// The in-flight waiter fails cleanly (rejected with
					// its worker) instead of hanging or going stale...
					const resA = await pendingA;
					expect(resA.status).toBe(500);
					// ...and the next waiter gets a live session: its
					// first send succeeds, which an orphaned sid could
					// not (turn/start would 400/sessionNotLoaded).
					const cookieC = await unlock(srv.url);
					const sendC = await postJson(
						`${srv.url}api/chat/send`,
						{ text: "T81-3-C" },
						cookieC,
					);
					expect(sendC.status).toBe(200);
					expect(sendC.json["ok"]).toBe(true);
					expect(typeof sendC.json["sessionId"]).toBe("string");
					// Original worker + post-lock fresh one, with slack.
					expect(spawnCount(log)).toBeLessThanOrEqual(3);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);
});
