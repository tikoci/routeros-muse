// Round-3 server proofs: send-buffer immediacy (P2-C), pending-start
// stop/force (P2-D), and the live-run state on history (P1-A server half).
//
// Hermetic: the T50 scriptable fake fronts PATH; FAKE_TURN_ACK_DELAY_MS
// holds the turn/start ack while its notifications emit immediately.
import { afterAll, describe, expect, test } from "bun:test";
import { have } from "../src/lib/run";
import { cleanupTmpdirs } from "./helpers/tmp";
import { startT50Srv, stubT50Bin, withT50Env } from "./t50-fake";
import { pollT71Log } from "./t71-fake";

afterAll(cleanupTmpdirs);

const HAVE_MUSE = have("muse");
const t = HAVE_MUSE && process.platform !== "win32" ? test : test.skip;

type Posted = { status: number; json: Record<string, unknown> };

async function postJson(url: string, body: unknown): Promise<Posted> {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: new URL(url).origin,
		},
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
	at: number;
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
						events.push({ ...evt, at: Date.now() });
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

async function waitIdle(srvUrl: string): Promise<void> {
	const start = Date.now();
	for (;;) {
		const stopped = await postJson(`${srvUrl}api/chat/stop`, {});
		if (stopped.json["why"] === "no live run") return;
		if (Date.now() - start > 15_000) {
			throw new Error(`r3 never idled: ${JSON.stringify(stopped.json)}`);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe("round-3 server (P2-C buffer, P2-D pending stop, P1-A running)", () => {
	t(
		"P2-C: an approval emitted before the ack reaches SSE before the ack resolves",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(
				log,
				async () => {
					const srv = await startT50Srv(bin);
					const sse = await subscribeSse(srv.url);
					try {
						const sendAt = Date.now();
						const sending = postJson(`${srv.url}api/chat/send`, {
							text: "NEED-APPROVAL r3-buffer",
						});
						// The ack lands at ~1200ms; the approval must already be on SSE.
						let approvalAt = -1;
						const start = Date.now();
						for (;;) {
							const hit = sse.events.find(
								(e) => e.method === "approval/requested",
							);
							if (hit) {
								approvalAt = hit.at;
								break;
							}
							if (Date.now() - start > 1_000) break;
							await new Promise((r) => setTimeout(r, 25));
						}
						const sent = await sending;
						expect(sent.json["ok"]).toBe(true);
						expect(approvalAt).toBeGreaterThanOrEqual(sendAt);
						expect(approvalAt).toBeLessThan(sendAt + 1_000);
						// Settle the held turn, then stop cleanly.
						await postJson(`${srv.url}api/chat/stop`, {});
						await waitIdle(srv.url);
					} finally {
						await sse.close();
						await srv.stop();
					}
				},
				{ FAKE_TURN_ACK_DELAY_MS: "1200" },
			);
		},
		60_000,
	);

	t(
		"P1-A server: history carries the live-run state /api/chat/stop uses",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					const idle = await getJson(`${srv.url}api/chat/history`);
					expect(idle["running"]).toBe(false);
					expect(idle["turnId"] ?? null).toBeNull();
					const sent = await postJson(`${srv.url}api/chat/send`, {
						text: "HOLD-OPEN r3-running",
					});
					expect(sent.json["ok"]).toBe(true);
					const live = await getJson(`${srv.url}api/chat/history`);
					expect(live["running"]).toBe(true);
					expect(live["turnId"]).toBe(sent.json["turnId"]);
					const stopped = await postJson(`${srv.url}api/chat/stop`, {});
					expect(stopped.json["turnId"]).toBe(sent.json["turnId"]);
					await pollT71Log(log, /COMPLETE/, 15_000);
					await waitIdle(srv.url);
					const done = await getJson(`${srv.url}api/chat/history`);
					expect(done["running"]).toBe(false);
					// /new and /resume report the same idle state they publish under.
					const created = await postJson(`${srv.url}api/chat/new`, {});
					expect(created.json["running"]).toBe(false);
					const back = await postJson(`${srv.url}api/chat/resume`, {
						sessionId: sent.json["sessionId"],
					});
					expect(back.json["running"]).toBe(false);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t(
		"P2-D stop: queued during a pending start, interrupts on ack, /new opens after",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(
				log,
				async () => {
					const srv = await startT50Srv(bin);
					try {
						const sending = postJson(`${srv.url}api/chat/send`, {
							text: "HOLD-OPEN r3-queued-stop",
						});
						await pollT71Log(log, /RECV_TURN/, 15_000);
						const stopped = await postJson(`${srv.url}api/chat/stop`, {});
						expect(stopped.json["ok"]).toBe(true);
						expect(stopped.json["queued"]).toBe(true);
						const sent = await sending;
						expect(sent.json["ok"]).toBe(true);
						// The queued stop interrupted on ack: the turn cancels
						// and swaps open again with no turn-running.
						await pollT71Log(log, /COMPLETE/, 15_000);
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
		"P2-D force: never reports forced:true before the pending start resolves",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(
				log,
				async () => {
					const srv = await startT50Srv(bin);
					try {
						const sending = postJson(`${srv.url}api/chat/send`, {
							text: "HOLD-OPEN r3-force-wait",
						});
						await pollT71Log(log, /RECV_TURN/, 15_000);
						const hist = await getJson(`${srv.url}api/chat/history`);
						const t0 = Date.now();
						const forced = await postJson(`${srv.url}api/chat/stop-force`, {
							generation: hist["generation"],
						});
						const elapsed = Date.now() - t0;
						// The ack lands at ~1200ms; force must still be waiting then,
						// so it can never claim the pre-start worker as stopped.
						expect(elapsed).toBeGreaterThanOrEqual(1_000);
						expect(forced.json["forced"]).not.toBe(true);
						const sent = await sending;
						expect(sent.json["ok"]).toBe(true);
						// The wait retired the pin (the send bumped); settle
						// through a fresh Stop like the UI would.
						await postJson(`${srv.url}api/chat/stop`, {});
						await pollT71Log(log, /COMPLETE/, 15_000);
						await waitIdle(srv.url);
						const created = await postJson(`${srv.url}api/chat/new`, {});
						expect(created.status).toBe(200);
					} finally {
						await srv.stop();
					}
				},
				{ FAKE_TURN_ACK_DELAY_MS: "1200" },
			);
		},
		60_000,
	);
});
