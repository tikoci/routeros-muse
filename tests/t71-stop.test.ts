// T71 stop lifecycle: Stopping state plus run-pinned Force stop.
//
// Hermetic: the scriptable fake `muse` (tests/t71-fake.ts) fronts PATH
// via toolBinDir; bypass-mode servers (no CDB, no centrs). The ambient
// `muse` binary is only probed for presence (the server's spawn gate),
// never run.
import { describe, expect, test } from "bun:test";
import { have } from "../src/lib/run";
import {
	countT71Lines,
	pollT71Log,
	pollT71PidGone,
	startT71Srv,
	stubT71Bin,
	t71SpawnedPids,
	withT71Env,
} from "./t71-fake";

const HAVE_MUSE = have("muse");
// Shell shims (POSIX) + the server's ambient-muse spawn gate.
const t71 = HAVE_MUSE && process.platform !== "win32" ? test : test.skip;

type Posted = { status: number; json: Record<string, unknown> };

async function postJson(url: string, body: unknown): Promise<Posted> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
	};
}

async function sendText(
	srvUrl: string,
	text: string,
): Promise<Record<string, unknown>> {
	return (await postJson(`${srvUrl}api/chat/send`, { text })).json;
}

describe("stop lifecycle (T71)", () => {
	t71(
		"(a) graceful stop pins the interrupt; completion clears the live turn",
		async () => {
			const { bin, log } = stubT71Bin();
			await withT71Env(log, { mode: "interruptible" }, async () => {
				const srv = await startT71Srv(bin);
				try {
					const sent = await sendText(srv.url, "T71-A");
					expect(sent["ok"]).toBe(true);
					const turnId = sent["turnId"];
					expect(typeof turnId).toBe("string");
					const stopped = await postJson(`${srv.url}api/chat/stop`, {});
					expect(stopped.json["ok"]).toBe(true);
					expect(stopped.json["stopped"]).toBe(true);
					expect(stopped.json["turnId"]).toBe(turnId);
					expect(typeof stopped.json["generation"]).toBe("number");
					const generation = stopped.json["generation"];
					// The interrupt carried the live turn's ID, not an unpinned blast.
					await pollT71Log(
						log,
						new RegExp(`RECV_INTERRUPT turnId=${turnId} live=${turnId}`),
						15_000,
					);
					// The fake's completion settles the server's tracking: the
					// next stop reports no live turn WITHOUT sending another
					// interrupt (a stale lastTurnId would re-interrupt and the
					// fake would log it).
					await pollT71Log(
						log,
						new RegExp(`COMPLETE turnId=${turnId} terminal=cancelled`),
						15_000,
					);
					await pollT71Log(log, /COMPLETE/, 15_000);
					// Give the server's notification handler a beat to clear.
					let again: Posted | null = null;
					for (let i = 0; i < 40; i++) {
						again = await postJson(`${srv.url}api/chat/stop`, {});
						if (again.json["stopped"] === false) break;
						await new Promise((r) => setTimeout(r, 100));
					}
					expect(again?.json["ok"]).toBe(true);
					expect(again?.json["stopped"]).toBe(false);
					expect(again?.json["turnId"]).toBeNull();
					expect(again?.json["generation"]).toBe(generation);
					expect(countT71Lines(log, "RECV_INTERRUPT")).toBe(1);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t71(
		"(b) force stop kills an EOF-resistant worker; the next send re-inits",
		async () => {
			const { bin, log } = stubT71Bin();
			await withT71Env(log, { mode: "ignoring" }, async () => {
				const srv = await startT71Srv(bin);
				try {
					const sent = await sendText(srv.url, "T71-B");
					expect(sent["ok"]).toBe(true);
					const stopped = await postJson(`${srv.url}api/chat/stop`, {});
					expect(stopped.json["stopped"]).toBe(true);
					const generation = stopped.json["generation"];
					const t0 = Date.now();
					const forced = await postJson(`${srv.url}api/chat/stop-force`, {
						generation,
					});
					const elapsed = Date.now() - t0;
					expect(forced.status).toBe(200);
					expect(forced.json["ok"]).toBe(true);
					expect(forced.json["forced"]).toBe(true);
					expect(["term", "kill"]).toContain(String(forced.json["step"]));
					// Bounded escalation: 5s interrupt wait + 5s EOF wait +
					// signals, worst case ~20s + overhead. Lower bound guards
					// a fake pass that skips the waits (wide slack, no flake).
					expect(elapsed).toBeLessThan(25_000);
					expect(elapsed).toBeGreaterThanOrEqual(7_000);
					// The worker actually died (logged death, PID gone).
					await pollT71Log(log, /DIED sig=SIGTERM/, 15_000);
					const pids = t71SpawnedPids(log);
					expect(pids.length).toBe(1);
					await pollT71PidGone(pids[0] as number, 10_000);
					// The next send re-inits on a fresh worker and 200s.
					const resent = await sendText(srv.url, "T71-B-AGAIN");
					expect(resent["ok"]).toBe(true);
					expect(t71SpawnedPids(log).length).toBe(2);
					// The re-init worker inherits the EOF-resistant mode, so a
					// graceful server stop would hang on it: force-stop it too
					// (second escalation, same bounds), leaving teardown prompt.
					const restop = await postJson(`${srv.url}api/chat/stop`, {});
					expect(restop.json["stopped"]).toBe(true);
					const reforced = await postJson(`${srv.url}api/chat/stop-force`, {
						generation: restop.json["generation"],
					});
					expect(reforced.json["ok"]).toBe(true);
					expect(["term", "kill"]).toContain(String(reforced.json["step"]));
					expect(countT71Lines(log, "DIED")).toBe(2);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t71(
		"(c) stale generation refuses without touching the worker",
		async () => {
			const { bin, log } = stubT71Bin();
			await withT71Env(log, { mode: "interruptible" }, async () => {
				const srv = await startT71Srv(bin);
				try {
					const first = await sendText(srv.url, "T71-C1");
					expect(first["ok"]).toBe(true);
					const stopped = await postJson(`${srv.url}api/chat/stop`, {});
					expect(stopped.json["stopped"]).toBe(true);
					const staleGen = stopped.json["generation"];
					await pollT71Log(log, /COMPLETE/, 15_000);
					// A newer send moves the run generation forward.
					const second = await sendText(srv.url, "T71-C2");
					expect(second["ok"]).toBe(true);
					const forced = await postJson(`${srv.url}api/chat/stop-force`, {
						generation: staleGen,
					});
					expect(forced.status).toBe(200);
					expect(forced.json["ok"]).toBe(false);
					expect(forced.json["code"]).toBe("stale-generation");
					expect(String(forced.json["why"])).toContain("run changed");
					// Refusal touched nothing: no EOF, no signal, one worker.
					expect(countT71Lines(log, "EOF")).toBe(0);
					expect(countT71Lines(log, "DIED")).toBe(0);
					expect(t71SpawnedPids(log).length).toBe(1);
					// The live turn still interrupts cleanly afterwards.
					const restop = await postJson(`${srv.url}api/chat/stop`, {});
					expect(restop.json["stopped"]).toBe(true);
					expect(restop.json["turnId"]).toBe(second["turnId"]);
					await pollT71Log(
						log,
						new RegExp(`RECV_INTERRUPT turnId=${second["turnId"]}`),
						15_000,
					);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t71(
		"(d) stop with no live turn leaves the worker alone",
		async () => {
			const { bin, log } = stubT71Bin();
			await withT71Env(log, { mode: "interruptible" }, async () => {
				const srv = await startT71Srv(bin);
				try {
					const sent = await sendText(srv.url, "T71-D");
					expect(sent["ok"]).toBe(true);
					const stopped = await postJson(`${srv.url}api/chat/stop`, {});
					expect(stopped.json["stopped"]).toBe(true);
					await pollT71Log(log, /COMPLETE/, 15_000);
					let idle: Posted | null = null;
					for (let i = 0; i < 40; i++) {
						idle = await postJson(`${srv.url}api/chat/stop`, {});
						if (idle.json["stopped"] === false) break;
						await new Promise((r) => setTimeout(r, 100));
					}
					expect(idle?.json["ok"]).toBe(true);
					expect(idle?.json["stopped"]).toBe(false);
					expect(idle?.json["turnId"]).toBeNull();
					// No second interrupt, no respawn: the worker is unharmed
					// and the next send reuses it.
					expect(countT71Lines(log, "RECV_INTERRUPT")).toBe(1);
					expect(t71SpawnedPids(log).length).toBe(1);
					const again = await sendText(srv.url, "T71-D2");
					expect(again["ok"]).toBe(true);
					expect(t71SpawnedPids(log).length).toBe(1);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t71(
		"(e) hung interrupt maps to stopped:false; force then exits via EOF",
		async () => {
			const { bin, log } = stubT71Bin();
			await withT71Env(log, { mode: "hang" }, async () => {
				const srv = await startT71Srv(bin);
				try {
					const sent = await sendText(srv.url, "T71-E");
					expect(sent["ok"]).toBe(true);
					const t0 = Date.now();
					const stopped = await postJson(`${srv.url}api/chat/stop`, {});
					const elapsed = Date.now() - t0;
					// Not a 500: the UI must be able to offer Force stop.
					expect(stopped.status).toBe(200);
					expect(stopped.json["ok"]).toBe(true);
					expect(stopped.json["stopped"]).toBe(false);
					expect(stopped.json["why"]).toBe("interrupt timed out");
					expect(stopped.json["turnId"]).toBe(sent["turnId"]);
					expect(typeof stopped.json["generation"]).toBe("number");
					expect(elapsed).toBeGreaterThanOrEqual(9_000);
					expect(elapsed).toBeLessThan(20_000);
					// The turn is still live (nothing completed it).
					await pollT71Log(log, /RECV_INTERRUPT/, 15_000);
					// Force escalates: the interrupt wait finds nothing, EOF
					// exits this worker (no signal needed).
					const forced = await postJson(`${srv.url}api/chat/stop-force`, {
						generation: stopped.json["generation"],
					});
					expect(forced.json["ok"]).toBe(true);
					expect(forced.json["forced"]).toBe(true);
					expect(forced.json["step"]).toBe("exit");
					expect(countT71Lines(log, "DIED")).toBe(0);
					const resent = await sendText(srv.url, "T71-E-AGAIN");
					expect(resent["ok"]).toBe(true);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t71(
		"(f) natural completion clears the live turn without any stop",
		async () => {
			const { bin, log } = stubT71Bin();
			await withT71Env(log, { mode: "slow", slowMs: 300 }, async () => {
				const srv = await startT71Srv(bin);
				try {
					const sent = await sendText(srv.url, "T71-F");
					expect(sent["ok"]).toBe(true);
					await pollT71Log(
						log,
						new RegExp(`COMPLETE turnId=${sent["turnId"]} terminal=completed`),
						15_000,
					);
					let idle: Posted | null = null;
					for (let i = 0; i < 40; i++) {
						idle = await postJson(`${srv.url}api/chat/stop`, {});
						if (idle.json["stopped"] === false) break;
						await new Promise((r) => setTimeout(r, 100));
					}
					expect(idle?.json["stopped"]).toBe(false);
					expect(idle?.json["turnId"]).toBeNull();
					expect(countT71Lines(log, "RECV_INTERRUPT")).toBe(0);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);
});
