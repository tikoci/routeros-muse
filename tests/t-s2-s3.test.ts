// S2/S3 stop-during-start fixes + run/state liveness broadcasts.
//
// S2: Stop with an older lastTurnId still tracked and a newer start
// pending must queue against the pending start (whatever lastTurnId
// says), not interrupt the stale turn and miss the new one.
// S3: a turn/start ack that never answers must not clear to idle.
// The server keeps a "start unresolved" state (history stays
// running) and Force escalates straight to worker teardown.
// run/state: every worker exit invalidates the cached worker/main
// and broadcasts one SSE run/state {running:false} event.
//
// Hermetic: the T50 scriptable fake fronts PATH; FAKE_TURN_ACK_DELAY_MS
// holds the turn/start ack; worker kills are local SIGKILLs.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import { have } from "../src/lib/run";
import { cleanupTmpdirs } from "./helpers/tmp";
import { startT50Srv, stubT50Bin, withT50Env } from "./t50-fake";
import { countT71Lines, pollT71Log } from "./t71-fake";

afterAll(cleanupTmpdirs);

const HAVE_MUSE = have("muse");
const t = HAVE_MUSE && process.platform !== "win32" ? test : test.skip;

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

async function getJson(url: string): Promise<Record<string, unknown>> {
	const res = await fetch(url);
	return (await res.json()) as Record<string, unknown>;
}

type SseEvent = {
	method: unknown;
	params: Record<string, unknown>;
};

async function subscribeSse(srvUrl: string): Promise<{
	events: SseEvent[];
	close: () => Promise<void>;
}> {
	const events: SseEvent[] = [];
	const stream = await fetch(`${srvUrl}api/chat/events`);
	if (!stream.body) throw new Error("no SSE body");
	const reader = stream.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let open = true;
	const pump = (async () => {
		while (open) {
			const { done, value } = await reader.read();
			if (done) return;
			buf += decoder.decode(value, { stream: true });
			for (;;) {
				const idx = buf.indexOf("\n\n");
				if (idx < 0) break;
				const frame = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				for (const line of frame.split("\n")) {
					if (!line.startsWith("data: ")) continue;
					try {
						const evt = JSON.parse(line.slice("data: ".length)) as {
							method: unknown;
							params: Record<string, unknown>;
						};
						events.push(evt);
					} catch {
						// ignore partial frames
					}
				}
			}
		}
	})();
	return {
		events,
		close: async () => {
			open = false;
			try {
				await reader.cancel();
			} catch {
				// already closed
			}
			await pump;
		},
	};
}

async function waitSse(
	events: SseEvent[],
	method: string,
	timeoutMs: number,
	count = 1,
): Promise<SseEvent> {
	const start = Date.now();
	for (;;) {
		const hits = events.filter((e) => e.method === method);
		if (hits.length >= count) return hits[hits.length - 1] as SseEvent;
		if (Date.now() - start > timeoutMs) {
			throw new Error(
				`no ${count}x SSE ${method} in ${events.map((e) => String(e.method)).join(",")}`,
			);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

async function waitIdle(srvUrl: string): Promise<void> {
	const start = Date.now();
	for (;;) {
		const stopped = await postJson(`${srvUrl}api/chat/stop`, {});
		if (stopped.json["why"] === "no live run") return;
		if (Date.now() - start > 15_000) {
			throw new Error(`s2s3 never idled: ${JSON.stringify(stopped.json)}`);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

function lastSpawnedPid(log: string): number {
	const pids = [
		...nodeFs.readFileSync(log, "utf8").matchAll(/SPAWN pid=(\d+)/g),
	];
	const last = pids.at(-1)?.[1];
	if (!last) throw new Error("no SPAWN pid in log");
	return Number(last);
}

describe("stop during start (S2 queue-first, S3 unresolved, run/state)", () => {
	t(
		"S2: stop during a pending start queues against it despite an older tracked turn",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(
				log,
				async () => {
					const srv = await startT50Srv(bin);
					try {
						const first = await postJson(`${srv.url}api/chat/send`, {
							text: "HOLD-OPEN s2-first",
						});
						expect(first.json["ok"]).toBe(true);
						expect(first.json["turnId"]).toBe("t50-t1");
						const sending = postJson(`${srv.url}api/chat/send`, {
							text: "HOLD-OPEN s2-second",
						});
						await pollT71Log(log, /RECV_TURN turnId=t50-t2/, 15_000);
						// t50-t1 is still the tracked turn while t2's
						// start pends: the stop must queue against the
						// pending start, not interrupt the stale t1.
						const stopped = await postJson(`${srv.url}api/chat/stop`, {});
						expect(stopped.json["ok"]).toBe(true);
						expect(stopped.json["queued"]).toBe(true);
						const second = await sending;
						expect(second.json["ok"]).toBe(true);
						// The queued stop interrupted t2 on ack: t2
						// completes and swaps open again with no
						// turn-running.
						await pollT71Log(log, /COMPLETE turnId=t50-t2/, 15_000);
						expect(nodeFs.readFileSync(log, "utf8")).toContain(
							"RECV_INTERRUPT turnId=t50-t2",
						);
						await waitIdle(srv.url);
						const created = await postJson(`${srv.url}api/chat/new`, {});
						expect(created.status).toBe(200);
						expect(created.json["ok"]).toBe(true);
					} finally {
						await srv.stop();
					}
				},
				{ FAKE_TURN_ACK_DELAY_MS: "1200" },
			);
		},
		60_000,
	);

	t(
		"S3: force during a still-pending start tears the worker down (history running until then)",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(
				log,
				async () => {
					const srv = await startT50Srv(bin);
					const sse = await subscribeSse(srv.url);
					try {
						const sending = postJson(`${srv.url}api/chat/send`, {
							text: "HOLD-OPEN s3-pending",
						});
						await pollT71Log(log, /RECV_TURN/, 15_000);
						const hist = await getJson(`${srv.url}api/chat/history`);
						expect(hist["running"]).toBe(true);
						const forcing = postJson(`${srv.url}api/chat/stop-force`, {
							generation: hist["generation"],
						});
						// History keeps reporting running while the
						// start is still pending (never a false idle
						// window): sample mid-wait, well before the
						// 10s force wait expires into teardown.
						await new Promise((r) => setTimeout(r, 5_000));
						const mid = await getJson(`${srv.url}api/chat/history`);
						expect(mid["running"]).toBe(true);
						const forced = await forcing;
						expect(forced.json["ok"]).toBe(true);
						expect(forced.json["forced"]).toBe(true);
						expect(["exit", "term", "kill"]).toContain(
							String(forced.json["step"]),
						);
						// The send's turnStart died with the worker.
						const sent = await sending;
						expect(sent.json["ok"]).toBe(false);
						// The teardown broadcast; the worker is gone.
						const evt = await waitSse(sse.events, "run/state", 15_000);
						expect(evt.params["running"]).toBe(false);
						expect(countT71Lines(log, "SPAWN pid=")).toBe(1);
						// The next send respawns cleanly on a fresh worker
						// (its ack lands inside the 30s turn/start budget).
						const again = await postJson(`${srv.url}api/chat/send`, {
							text: "s3-after-teardown",
						});
						expect(again.json["ok"]).toBe(true);
						expect(countT71Lines(log, "SPAWN pid=")).toBe(2);
					} finally {
						await sse.close();
						await srv.stop();
					}
				},
				{ FAKE_TURN_ACK_DELAY_MS: "20000" },
			);
		},
		90_000,
	);

	t(
		"S3: an ack timeout keeps the run unresolved until force tears down",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(
				log,
				async () => {
					const srv = await startT50Srv(bin);
					const sse = await subscribeSse(srv.url);
					try {
						const sending = postJson(`${srv.url}api/chat/send`, {
							text: "HOLD-OPEN s3-timeout",
						});
						await pollT71Log(log, /RECV_TURN/, 15_000);
						// The 30s turn/start timeout fails the send — but
						// the turn may be live on the worker, so the run
						// stays unresolved (never a false idle).
						const sent = await sending;
						expect(sent.status).toBe(500);
						expect(sent.json["ok"]).toBe(false);
						const hist = await getJson(`${srv.url}api/chat/history`);
						expect(hist["running"]).toBe(true);
						expect(hist["turnId"] ?? null).toBeNull();
						// Round 4 review: every tab is told the run is
						// unresolved, so Stop/Force stay reachable even
						// after a completion hid them.
						const announced = await waitSse(sse.events, "run/state", 5_000);
						expect(announced.params["running"]).toBe(true);
						expect(announced.params["reason"]).toBe("unresolved-start");
						// The only honest stop with an unknown turn id is
						// worker teardown — never the trivially-stopped
						// idle lie (forced:true step:interrupt).
						const forced = await postJson(`${srv.url}api/chat/stop-force`, {
							generation: hist["generation"],
						});
						expect(forced.json["ok"]).toBe(true);
						expect(forced.json["forced"]).toBe(true);
						expect(["exit", "term", "kill"]).toContain(
							String(forced.json["step"]),
						);
						const after = await getJson(`${srv.url}api/chat/history`);
						expect(after["running"]).toBe(false);
						// The teardown reaped the worker: history respawned
						// it (a working send after teardown is proven by
						// the S3 pending leg, whose ack fits the budget).
						expect(countT71Lines(log, "SPAWN pid=")).toBe(2);
					} finally {
						await sse.close();
						await srv.stop();
					}
				},
				{ FAKE_TURN_ACK_DELAY_MS: "60000" },
			);
		},
		120_000,
	);

	t(
		"S3: an ack timeout after the turn already completed is idle, not unresolved",
		async () => {
			// Round 4 review (P2): the start's turn/started and turn/completed
			// arrive normally but the ack misses its 30s budget. The turn is
			// over, so the run must not stay unresolved (that left New 409ing
			// with no Stop to press).
			const { bin, log } = stubT50Bin();
			await withT50Env(
				log,
				async () => {
					const srv = await startT50Srv(bin);
					try {
						const sent = await postJson(`${srv.url}api/chat/send`, {
							text: "s3-completes-before-timeout",
						});
						expect(sent.status).toBe(500);
						const hist = await getJson(`${srv.url}api/chat/history`);
						expect(hist["running"]).toBe(false);
						const created = await postJson(`${srv.url}api/chat/new`, {});
						expect(created.status).toBe(200);
					} finally {
						await srv.stop();
					}
				},
				{ FAKE_TURN_ACK_DELAY_MS: "60000" },
			);
		},
		120_000,
	);

	t(
		"run/state: killing the worker broadcasts running:false; history and send recover",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				const sse = await subscribeSse(srv.url);
				try {
					// Idle kill.
					const first = await postJson(`${srv.url}api/chat/send`, {
						text: "RS-IDLE",
					});
					expect(first.json["ok"]).toBe(true);
					await waitIdle(srv.url);
					process.kill(lastSpawnedPid(log), "SIGKILL");
					const idleEvt = await waitSse(sse.events, "run/state", 15_000);
					expect(idleEvt.params["running"]).toBe(false);
					// The next history answers honestly (respawned, idle)
					// — no dead-client view/page timeout.
					const t0 = Date.now();
					const hist = await getJson(`${srv.url}api/chat/history`);
					expect(Date.now() - t0).toBeLessThan(20_000);
					expect(hist["running"]).toBe(false);
					const second = await postJson(`${srv.url}api/chat/send`, {
						text: "RS-AFTER-IDLE-KILL",
					});
					expect(second.json["ok"]).toBe(true);
					// Running kill.
					const live = postJson(`${srv.url}api/chat/send`, {
						text: "HOLD-OPEN rs-live",
					});
					await pollT71Log(log, /RECV_TURN turnId=t50-t/, 15_000);
					const liveAck = await live;
					expect(liveAck.json["ok"]).toBe(true);
					const running = await getJson(`${srv.url}api/chat/history`);
					expect(running["running"]).toBe(true);
					process.kill(lastSpawnedPid(log), "SIGKILL");
					// The second run/state (the first was the idle kill):
					// waiting for it also gives the exit watcher its beat,
					// so the stop below is past the race window.
					const runEvt = await waitSse(sse.events, "run/state", 15_000, 2);
					expect(runEvt.params["running"]).toBe(false);
					const stopped = await postJson(`${srv.url}api/chat/stop`, {});
					expect(stopped.json["why"]).toBe("no live run");
					const third = await postJson(`${srv.url}api/chat/send`, {
						text: "RS-AFTER-RUNNING-KILL",
					});
					expect(third.json["ok"]).toBe(true);
					expect(countT71Lines(log, "SPAWN pid=")).toBe(3);
				} finally {
					await sse.close();
					await srv.stop();
				}
			});
		},
		90_000,
	);
});
