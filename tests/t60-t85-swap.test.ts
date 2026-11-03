// Main-session swap: start-new (T85) + make-current resume (T60).
//
// One change: both swap which MSP session is "main" for the single
// agent (D20). Send, New and Make-current share one server-side
// lifecycle lock: New/Resume are refused (409) while a turn runs or a
// stop is in flight; the swap itself is atomic under the T81
// owner/generation binding.
//
// Hermetic: the T50 scriptable fake (multi-session + session/resume +
// HOLD-OPEN, tests/t50-fake.ts) fronts PATH; the stop-in-progress leg
// uses the T71 ignoring-mode fake; the stale-generation leg uses an
// encrypted-stub-CDB unlock harness like T81. The ambient `muse`
// binary is only probed for presence, never run.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { have } from "../src/lib/run";
import { startServer } from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";
import { startT50Srv, stubT50Bin, T50_FAKE_MUSE, withT50Env } from "./t50-fake";
import { pollT71Log, startT71Srv, stubT71Bin, withT71Env } from "./t71-fake";

afterAll(cleanupTmpdirs);

const HAVE_MUSE = have("muse");
// Shell shims (POSIX) + the server's ambient-muse spawn gate.
const t = HAVE_MUSE && process.platform !== "win32" ? test : test.skip;

type Posted = { status: number; json: Record<string, unknown> };

async function postJson(
	url: string,
	body: unknown,
	cookie?: string,
): Promise<Posted> {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
	};
}

async function getJson(
	url: string,
	cookie?: string,
): Promise<Record<string, unknown>> {
	const res = await fetch(url, {
		...(cookie ? { headers: { cookie } } : {}),
	});
	return (await res.json()) as Record<string, unknown>;
}

function countLines(text: string, needle: string): number {
	return text.split("\n").filter((l) => l.includes(needle)).length;
}

/**
 * Wait until the server sees no live turn. Sends ack on the
 * turnStart response while turn/completed still travels the stdio
 * tap, so a swap immediately after a send would 409 (correctly).
 * The fake completes every plain turn synchronously, so one Stop
 * poll either observes the completion or syncs via missing_run —
 * both answer "no live run". Never use on a held-open turn.
 */
async function waitIdle(srvUrl: string, cookie?: string): Promise<void> {
	const start = Date.now();
	for (;;) {
		const stopped = await postJson(`${srvUrl}api/chat/stop`, {}, cookie);
		if (stopped.json["why"] === "no live run") return;
		if (Date.now() - start > 15_000) {
			throw new Error(`t60 never idled: ${JSON.stringify(stopped.json)}`);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

// Stub-CDB password for the unlock harness below.
const SWAP_PASSWORD = "t60-fixture-password";

function writeShim(dir: string, name: string, body: string): void {
	const file = path.join(dir, name);
	nodeFs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	nodeFs.chmodSync(file, 0o755);
}

/** T50 fake muse + encrypted-stub centrs (T81 shape) for unlock owners. */
function stubSwapBin(): { bin: string; log: string } {
	const bin = mktmp("t60-bin-");
	const log = path.join(bin, "msp.log");
	nodeFs.writeFileSync(path.join(bin, "fake-muse-t60.ts"), T50_FAKE_MUSE);
	writeShim(
		bin,
		"muse",
		`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, "fake-muse-t60.ts"))} "$@"`,
	);
	writeShim(
		bin,
		"centrs",
		`if [ "$1" = "devices" ]; then\n` +
			`if [ "$CENTRS_CDB_PASSWORD" = ${JSON.stringify(SWAP_PASSWORD)} ]; then\n` +
			`printf '%s\\n' '{"ok":true,"data":[],"warnings":[],"tips":[],"meta":{}}'\n` +
			`else\n` +
			`printf '%s\\n' '{"ok":false,"error":{"code":"cdb/password-required","summary":"password required"},"warnings":[],"tips":[],"meta":{}}'\n` +
			`fi\n` +
			`else\n` +
			`echo "stub-centrs 9.9.9-t60"\n` +
			`fi`,
	);
	writeShim(bin, "quickchr", `echo "stub-quickchr 9.9.9-t60"`);
	writeShim(bin, "rosetta", `echo "stub-rosetta 9.9.9-t60"`);
	return { bin, log };
}

async function startSwapSrv(bin: string): Promise<{
	url: string;
	stop: () => Promise<void>;
}> {
	const dir = mktmp("t60-cdb-");
	const cdb = path.join(dir, "device.cdb");
	nodeFs.writeFileSync(cdb, "t60 stub-backed CDB placeholder\n");
	return startServer({
		dataHome: mktmp("t60-dh-"),
		configHome: mktmp("t60-cfg-"),
		noWorkspace: true,
		provider: "echo",
		museHome: mktmp("t60-home-"),
		cdbFile: cdb,
		toolBinDir: bin,
	});
}

function cookieFrom(res: Response): string | null {
	const set = res.headers.get("set-cookie");
	if (!set) return null;
	const m = /rmsid=([^;]+)/.exec(set);
	return m?.[1] ? `rmsid=${m[1]}` : null;
}

async function unlock(srvUrl: string): Promise<string> {
	const res = await fetch(`${srvUrl}api/auth/unlock`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: SWAP_PASSWORD }),
	});
	const json = (await res.json()) as Record<string, unknown>;
	if (!json["ok"]) throw new Error(`t60 unlock failed: ${res.status}`);
	const cookie = cookieFrom(res);
	if (!cookie) throw new Error("t60 unlock set no cookie");
	return cookie;
}

describe("main-session swap (T60 resume + T85 new)", () => {
	t(
		"new swaps main: next send goes to the new id, transcript resets, old main is past",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					const first = await postJson(`${srv.url}api/chat/send`, {
						text: "T60-FIRST-ON-S1",
					});
					expect(first.status).toBe(200);
					expect(first.json["ok"]).toBe(true);
					const s1 = first.json["sessionId"];
					expect(typeof s1).toBe("string");
					await waitIdle(srv.url);
					const created = await postJson(`${srv.url}api/chat/new`, {});
					expect(created.status).toBe(200);
					expect(created.json["ok"]).toBe(true);
					const s2 = created.json["sessionId"];
					expect(typeof s2).toBe("string");
					expect(s2).not.toBe(s1);
					// The next send lands on the new main.
					const second = await postJson(`${srv.url}api/chat/send`, {
						text: "T60-FIRST-ON-S2",
					});
					expect(second.status).toBe(200);
					expect(second.json["sessionId"]).toBe(s2);
					// Transcript is the new main's only.
					const hist = await getJson(`${srv.url}api/chat/history`);
					expect(hist["sessionId"]).toBe(s2);
					const texts = ((hist["messages"] as { text: string }[]) ?? []).map(
						(m) => m.text,
					);
					expect(texts.join("\n")).toContain("T60-FIRST-ON-S2");
					expect(texts.join("\n")).not.toContain("T60-FIRST-ON-S1");
					// The old main shows up in Past chats; stats reset.
					const past = await getJson(`${srv.url}api/past`);
					const ids = ((past["pasts"] as { id: string }[]) ?? []).map(
						(p) => p.id,
					);
					expect(ids).toContain(s1 as string);
					expect(ids).not.toContain(s2 as string);
					const stats = await getJson(`${srv.url}api/chat/stats`);
					expect(stats["turns"]).toBe(1);
					expect(stats["msgs"]).toBe(1);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t(
		"new and resume are refused (409) while a turn runs, and work after Stop",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					const sent = await postJson(`${srv.url}api/chat/send`, {
						text: "T60-HOLD-OPEN live turn",
					});
					expect(sent.json["ok"]).toBe(true);
					const s1 = sent.json["sessionId"];
					await pollT71Log(log, /RECV_TURN/, 15_000);
					const deniedNew = await postJson(`${srv.url}api/chat/new`, {});
					expect(deniedNew.status).toBe(409);
					expect(typeof deniedNew.json["error"]).toBe("string");
					expect(typeof deniedNew.json["why"]).toBe("string");
					expect(String(deniedNew.json["why"])).toMatch(/stop/i);
					const deniedResume = await postJson(`${srv.url}api/chat/resume`, {
						sessionId: s1,
					});
					expect(deniedResume.status).toBe(409);
					expect(typeof deniedResume.json["error"]).toBe("string");
					// Stop settles the turn; both routes open again.
					const stopped = await postJson(`${srv.url}api/chat/stop`, {});
					expect(stopped.json["stopped"]).toBe(true);
					await pollT71Log(log, /COMPLETE/, 15_000);
					// The completion still has to travel the SSE tap.
					for (let i = 0; i < 50; i++) {
						const probe = await postJson(`${srv.url}api/chat/new`, {});
						if (probe.status === 200) break;
						expect(probe.status).toBe(409);
						await new Promise((r) => setTimeout(r, 100));
					}
					const resumed = await postJson(`${srv.url}api/chat/resume`, {
						sessionId: s1,
					});
					// s1 is still main (the probe new above may have
					// swapped it — either outcome is a live main).
					expect(resumed.status).toBe(200);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t(
		"new is refused while a stop-force is in progress",
		async () => {
			const { bin, log } = stubT71Bin();
			await withT71Env(log, { mode: "ignoring" }, async () => {
				const srv = await startT71Srv(bin);
				try {
					const sent = await postJson(`${srv.url}api/chat/send`, {
						text: "T60-FORCE-WINDOW",
					});
					expect(sent.json["ok"]).toBe(true);
					const stopped = await postJson(`${srv.url}api/chat/stop`, {});
					expect(stopped.json["stopped"]).toBe(true);
					const gen = stopped.json["generation"];
					expect(typeof gen).toBe("number");
					const forcing = postJson(`${srv.url}api/chat/stop-force`, {
						generation: gen,
					});
					await pollT71Log(log, /RECV_INTERRUPT/, 15_000);
					const denied = await postJson(`${srv.url}api/chat/new`, {});
					expect(denied.status).toBe(409);
					expect(typeof denied.json["error"]).toBe("string");
					const forced = await forcing;
					expect(forced.json["ok"]).toBe(true);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t(
		"resume validates the id against session/list (400/404), then swaps",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					const first = await postJson(`${srv.url}api/chat/send`, {
						text: "T60-VALIDATE-S1",
					});
					const s1 = first.json["sessionId"];
					await waitIdle(srv.url);
					const created = await postJson(`${srv.url}api/chat/new`, {});
					const s2 = created.json["sessionId"];
					expect(s2).not.toBe(s1);
					const missing = await postJson(`${srv.url}api/chat/resume`, {});
					expect(missing.status).toBe(400);
					const badType = await postJson(`${srv.url}api/chat/resume`, {
						sessionId: 42,
					});
					expect(badType.status).toBe(400);
					const unknown = await postJson(`${srv.url}api/chat/resume`, {
						sessionId: "t50-no-such-session",
					});
					expect(unknown.status).toBe(404);
					// The failed resumes changed nothing: main is still s2.
					const hist = await getJson(`${srv.url}api/chat/history`);
					expect(hist["sessionId"]).toBe(s2);
					const back = await postJson(`${srv.url}api/chat/resume`, {
						sessionId: s1,
					});
					expect(back.status).toBe(200);
					expect(back.json["sessionId"]).toBe(s1);
					const next = await postJson(`${srv.url}api/chat/send`, {
						text: "T60-AFTER-RESUME",
					});
					expect(next.json["sessionId"]).toBe(s1);
					const hist2 = await getJson(`${srv.url}api/chat/history`);
					const texts = ((hist2["messages"] as { text: string }[]) ?? []).map(
						(m) => m.text,
					);
					expect(texts.join("\n")).toContain("T60-VALIDATE-S1");
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t(
		"resuming the current main is a no-op 200 (no resume on the wire)",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					const sent = await postJson(`${srv.url}api/chat/send`, {
						text: "T60-NOOP",
					});
					const s1 = sent.json["sessionId"];
					await waitIdle(srv.url);
					const again = await postJson(`${srv.url}api/chat/resume`, {
						sessionId: s1,
					});
					expect(again.status).toBe(200);
					expect(again.json["ok"]).toBe(true);
					expect(again.json["sessionId"]).toBe(s1);
					expect(nodeFs.readFileSync(log, "utf8")).not.toContain("RESUME ");
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t(
		"resume failure (abnormal end) leaves main unchanged",
		async () => {
			const { bin, log } = stubT50Bin();
			// With the abnormal-end knob the resume must fail
			// honestly and main must stay where it was.
			await withT50Env(
				log,
				async () => {
					const srv = await startT50Srv(bin);
					try {
						const first = await postJson(`${srv.url}api/chat/send`, {
							text: "T60-ABNORMAL-S1B",
						});
						const s1 = first.json["sessionId"];
						await waitIdle(srv.url);
						const created = await postJson(`${srv.url}api/chat/new`, {});
						const s2 = created.json["sessionId"];
						expect(s2).not.toBe(s1);
						const failed = await postJson(`${srv.url}api/chat/resume`, {
							sessionId: "t50-past1",
						});
						expect(failed.status).toBe(409);
						expect(typeof failed.json["error"]).toBe("string");
						const next = await postJson(`${srv.url}api/chat/send`, {
							text: "T60-ABNORMAL-AFTER",
						});
						expect(next.json["sessionId"]).toBe(s2);
					} finally {
						await srv.stop();
					}
				},
				{ FAKE_RESUME_ABNORMAL: "1" },
			);
		},
		60_000,
	);

	t(
		"resume failure (session in use) leaves main unchanged",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(
				log,
				async () => {
					const srv = await startT50Srv(bin);
					try {
						const first = await postJson(`${srv.url}api/chat/send`, {
							text: "T60-INUSE-S1",
						});
						const s1 = first.json["sessionId"];
						await waitIdle(srv.url);
						const created = await postJson(`${srv.url}api/chat/new`, {});
						const s2 = created.json["sessionId"];
						expect(s2).not.toBe(s1);
						const failed = await postJson(`${srv.url}api/chat/resume`, {
							sessionId: s1,
						});
						expect(failed.status).toBe(409);
						expect(typeof failed.json["error"]).toBe("string");
						const next = await postJson(`${srv.url}api/chat/send`, {
							text: "T60-INUSE-AFTER",
						});
						expect(next.json["sessionId"]).toBe(s2);
					} finally {
						await srv.stop();
					}
				},
				{ FAKE_RESUME_INUSE: "1" },
			);
		},
		60_000,
	);

	t(
		"new inherits live settings; resume re-applies them like the settings routes",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					const first = await postJson(`${srv.url}api/chat/send`, {
						text: "T60-SETTINGS",
					});
					const s1 = first.json["sessionId"];
					expect(
						(
							await postJson(`${srv.url}api/chat/model`, {
								modelId: "t50-fake",
							})
						).json["ok"],
					).toBe(true);
					expect(
						(
							await postJson(`${srv.url}api/chat/effort`, {
								effort: "high",
							})
						).json["ok"],
					).toBe(true);
					expect(
						(
							await postJson(`${srv.url}api/chat/access`, {
								mode: "allowAll",
							})
						).json["ok"],
					).toBe(true);
					await waitIdle(srv.url);
					const created = await postJson(`${srv.url}api/chat/new`, {});
					expect(created.status).toBe(200);
					expect(created.json["ok"]).toBe(true);
					const s2 = created.json["sessionId"] as string;
					expect(s2).not.toBe(s1);
					await pollT71Log(log, new RegExp(`START session=${s2} `), 15_000);
					let text = nodeFs.readFileSync(log, "utf8");
					// The fresh session starts with the live settings.
					expect(text).toContain(
						`START session=${s2} approvalMode=allowAll permissionProfile=:unrestricted modelId=t50-fake`,
					);
					expect(text).toContain(`SETEFFORT session=${s2} effort=high`);
					// The resume re-applies model + effort + access.
					const back = await postJson(`${srv.url}api/chat/resume`, {
						sessionId: s1,
					});
					expect(back.json["ok"]).toBe(true);
					text = nodeFs.readFileSync(log, "utf8");
					expect(
						countLines(text, `SETMODEL session=${s1} modelId=t50-fake`),
					).toBe(2);
					expect(countLines(text, `SETEFFORT session=${s1} effort=high`)).toBe(
						2,
					);
					expect(countLines(text, "MODE allowAll")).toBe(2);
					expect(countLines(text, "PROFILE :unrestricted")).toBe(2);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);

	t(
		"a stale swap continuation never adopts the old id (delay + lock)",
		async () => {
			const { bin, log } = stubSwapBin();
			await withT50Env(
				log,
				async () => {
					const srv = await startSwapSrv(bin);
					try {
						const cookieA = await unlock(srv.url);
						const first = await postJson(
							`${srv.url}api/chat/send`,
							{ text: "T60-STALE-A" },
							cookieA,
						);
						expect(first.json["ok"]).toBe(true);
						const sA = first.json["sessionId"];
						await waitIdle(srv.url, cookieA);
						// The swap reserves, then its session/start hangs
						// in the delay; the lock lands mid-flight.
						const swapping = postJson(`${srv.url}api/chat/new`, {}, cookieA);
						await pollT71Log(log, /RECV_START/, 15_000);
						const locked = await postJson(
							`${srv.url}api/auth/lock`,
							{},
							cookieA,
						);
						expect(locked.json["ok"]).toBe(true);
						// The stale continuation fails cleanly (its
						// worker is gone; T81 lock-race semantics).
						const stale = await swapping;
						expect(stale.status).toBe(500);
						// The next owner gets a live session first try:
						// the send is accepted, which a stale id on a
						// foreign worker could never be (turn/start
						// would 400/sessionNotLoaded). The fake mints
						// t50-s1 per worker process, so the log — not
						// the id — proves the stale start never
						// landed: three starts received, two answered.
						const cookieB = await unlock(srv.url);
						const second = await postJson(
							`${srv.url}api/chat/send`,
							{ text: "T60-STALE-B" },
							cookieB,
						);
						expect(second.status).toBe(200);
						expect(second.json["ok"]).toBe(true);
						expect(sA).toBe("t50-s1");
						const text = nodeFs.readFileSync(log, "utf8");
						expect(countLines(text, "RECV_START")).toBe(3);
						expect(countLines(text, "START session=")).toBe(2);
					} finally {
						await srv.stop();
					}
				},
				{ FAKE_START_DELAY_MS: "1500" },
			);
		},
		60_000,
	);

	t(
		"new and resume sit behind the auth gate like every chat route",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				// No CDB file and no bypass flag: the gate 401s before any
				// MSP contact, so the worker never spawns here.
				const ws = mktmp("t60-auth-ws-");
				nodeFs.writeFileSync(
					path.join(ws, "workspace.toml"),
					"canonical = true\n",
				);
				const srv = await startServer({
					dataHome: mktmp("t60-auth-dh-"),
					configHome: mktmp("t60-auth-cfg-"),
					workspace: ws,
					provider: "echo",
					museHome: mktmp("t60-auth-home-"),
					toolBinDir: bin,
				});
				try {
					const deniedNew = await postJson(`${srv.url}api/chat/new`, {});
					expect(deniedNew.status).toBe(401);
					const deniedResume = await postJson(`${srv.url}api/chat/resume`, {
						sessionId: "t50-s1",
					});
					expect(deniedResume.status).toBe(401);
					expect(nodeFs.existsSync(log)).toBe(false);
				} finally {
					await srv.stop();
				}
			});
		},
		60_000,
	);
});
