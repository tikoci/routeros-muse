// T50 approval/question surface: fail-first suite over the scriptable
// fake muse (tests/t50-fake.ts), which emits the captured wire shapes
// (docs/design/t50-t55-wire-shapes.md). Hermetic: the fake fronts PATH
// via toolBinDir; bypass-mode servers (no CDB, no centrs). The ambient
// `muse` binary is only probed for presence (the server's spawn gate),
// never run.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { have } from "../src/lib/run";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";
import { startT50Srv, stubT50Bin, withT50Env } from "./t50-fake";
import { pollT71Log } from "./t71-fake";

afterAll(cleanupTmpdirs);

const HAVE_MUSE = have("muse");
// Shell shims (POSIX) + the server's ambient-muse spawn gate.
const t50 = HAVE_MUSE && process.platform !== "win32" ? test : test.skip;

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

async function sendText(
	srvUrl: string,
	text: string,
): Promise<Record<string, unknown>> {
	return (await postJson(`${srvUrl}api/chat/send`, { text })).json;
}

/** Open SSE, run fn, and return every byte seen until all wants match. */
async function collectSse(
	srvUrl: string,
	want: string[],
	fn: () => Promise<void>,
	timeoutMs = 15_000,
): Promise<string> {
	const ctl = new AbortController();
	const r = await fetch(`${srvUrl}api/chat/events`, { signal: ctl.signal });
	if (!r.body) throw new Error("empty SSE body");
	const reader = r.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	const pump = (async () => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				buf += dec.decode(value, { stream: true });
				if (want.every((w) => buf.includes(w))) return;
				if (buf.length > 1_000_000) return;
			}
		} catch {
			// aborted below; buf keeps what arrived
		}
	})();
	try {
		await fn();
		await Promise.race([
			pump,
			new Promise((resolve) => setTimeout(resolve, timeoutMs)),
		]);
		return buf;
	} finally {
		ctl.abort();
	}
}

describe("approval/question surface (T50)", () => {
	t50(
		"session starts in promptUnmatched by default (D38: promptUnmatched IS Ask first)",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					const sent = await sendText(srv.url, "T50-DEFAULT-MODE");
					expect(sent["ok"]).toBe(true);
					await pollT71Log(
						log,
						/START session=t50-s1 approvalMode=(\S+)/,
						15_000,
					);
					const text = nodeFs.readFileSync(log, "utf8");
					expect(text).toContain(
						"START session=t50-s1 approvalMode=promptUnmatched",
					);
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t50(
		"chat stats access is truthful before and after session start",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					const pre = await getJson(`${srv.url}api/chat/stats`);
					expect(pre["ok"]).toBe(true);
					expect(pre["access"]).toBe("promptUnmatched");
					const sent = await sendText(srv.url, "T50-STATS");
					expect(sent["ok"]).toBe(true);
					const post = await getJson(`${srv.url}api/chat/stats`);
					expect(post["ok"]).toBe(true);
					expect(post["access"]).toBe("promptUnmatched");
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t50(
		"approval decide roundtrip sends the captured params; pending clears",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					const sent = await sendText(srv.url, "NEED-APPROVAL list the files");
					expect(sent["ok"]).toBe(true);
					await pollT71Log(log, /EMIT-APPROVAL/, 15_000);
					const pending = await getJson(`${srv.url}api/chat/pending`);
					expect(pending["ok"]).toBe(true);
					const approvals = pending["approvals"] as Record<string, unknown>[];
					expect(approvals).toHaveLength(1);
					const first = approvals[0] as Record<string, unknown>;
					expect(typeof first["approvalId"]).toBe("string");
					const choices = first["availableChoices"] as Record<
						string,
						unknown
					>[];
					expect(choices.map((c) => c["label"])).toEqual([
						"Allow once",
						"Always allow in this workspace: ls ...",
						"Reject",
					]);
					const req = first["currentRequirementId"] as Record<string, unknown>;
					expect(req["sourceIndex"]).toBe(0);
					const decided = await postJson(`${srv.url}api/chat/approval/decide`, {
						approvalId: first["approvalId"],
						choiceId: "allow_once",
						requirementId: req,
					});
					expect(decided.json["ok"]).toBe(true);
					expect(decided.json["terminal"]).toBe(true);
					await pollT71Log(
						log,
						/DECIDE approvalId=t50-a1 choiceId=allow_once/,
						15_000,
					);
					const text = nodeFs.readFileSync(log, "utf8");
					expect(text).toContain(
						'requirementId={"approvalId":"t50-a1","sourceIndex":0}',
					);
					const again = await getJson(`${srv.url}api/chat/pending`);
					expect(again["approvals"]).toHaveLength(0);
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t50(
		"stale requirementId is rejected without deciding",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					await sendText(srv.url, "NEED-APPROVAL stale guard");
					await pollT71Log(log, /EMIT-APPROVAL/, 15_000);
					const pending = await getJson(`${srv.url}api/chat/pending`);
					const first = (
						pending["approvals"] as Record<string, unknown>[]
					)[0] as Record<string, unknown>;
					const decided = await postJson(`${srv.url}api/chat/approval/decide`, {
						approvalId: first["approvalId"],
						choiceId: "allow_once",
						requirementId: { approvalId: first["approvalId"], sourceIndex: 99 },
					});
					expect(decided.json["ok"]).toBe(false);
					const still = await getJson(`${srv.url}api/chat/pending`);
					expect(still["approvals"]).toHaveLength(1);
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t50(
		"question answer and cancel roundtrips",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					await sendText(srv.url, "NEED-QUESTION tabs or spaces");
					await pollT71Log(log, /EMIT-QUESTION/, 15_000);
					const pending = await getJson(`${srv.url}api/chat/pending`);
					const inputs = pending["userInputs"] as Record<string, unknown>[];
					expect(inputs).toHaveLength(1);
					const first = inputs[0] as Record<string, unknown>;
					const questions = first["questions"] as Record<string, unknown>[];
					expect(questions).toHaveLength(1);
					expect(questions[0]?.["id"]).toBe("indent_pref");
					const answered = await postJson(
						`${srv.url}api/chat/question/answer`,
						{
							userInputId: first["userInputId"],
							answers: [{ questionId: "indent_pref", selectedLabel: "Tabs" }],
						},
					);
					expect(answered.json["ok"]).toBe(true);
					await pollT71Log(log, /ANSWER userInputId=t50-q1/, 15_000);
					const text = nodeFs.readFileSync(log, "utf8");
					expect(text).toContain(
						'answers=[{"questionId":"indent_pref","selectedLabel":"Tabs"}]',
					);
					const cleared = await getJson(`${srv.url}api/chat/pending`);
					expect(cleared["userInputs"]).toHaveLength(0);
					// A second question takes the decline path instead.
					await sendText(srv.url, "NEED-QUESTION again");
					await pollT71Log(log, /EMIT-QUESTION userInputId=t50-q2/, 15_000);
					const pending2 = await getJson(`${srv.url}api/chat/pending`);
					const second = (
						pending2["userInputs"] as Record<string, unknown>[]
					)[0] as Record<string, unknown>;
					const cancelled = await postJson(
						`${srv.url}api/chat/question/cancel`,
						{
							userInputId: second["userInputId"],
						},
					);
					expect(cancelled.json["ok"]).toBe(true);
					await pollT71Log(log, /CANCEL userInputId=t50-q2/, 15_000);
					const cleared2 = await getJson(`${srv.url}api/chat/pending`);
					expect(cleared2["userInputs"]).toHaveLength(0);
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t50(
		"interrupt resolves pending approval and question as abort/aborted",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					await sendText(srv.url, "NEED-BOTH hold the turn");
					await pollT71Log(log, /EMIT-APPROVAL/, 15_000);
					await pollT71Log(log, /EMIT-QUESTION/, 15_000);
					const before = await getJson(`${srv.url}api/chat/pending`);
					expect(before["approvals"]).toHaveLength(1);
					expect(before["userInputs"]).toHaveLength(1);
					const stopped = await postJson(`${srv.url}api/chat/stop`, {});
					expect(stopped.json["ok"]).toBe(true);
					expect(stopped.json["stopped"]).toBe(true);
					await pollT71Log(log, /INTERRUPT-RESOLVED approvalId=t50-a1/, 15_000);
					await pollT71Log(log, /INTERRUPT-SETTLED userInputId=t50-q1/, 15_000);
					const after = await getJson(`${srv.url}api/chat/pending`);
					expect(after["approvals"]).toHaveLength(0);
					expect(after["userInputs"]).toHaveLength(0);
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t50(
		"SSE relays approval and question frames to the browser",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					const buf = await collectSse(
						srv.url,
						[
							'"method":"approval/requested"',
							'"method":"userInput/requested"',
							'"method":"approval/resolved"',
							'"decision":"abort"',
							'"decidedByCommandId":null',
							'"method":"userInput/settled"',
							'"outcome":"aborted"',
						],
						async () => {
							await sendText(srv.url, "NEED-BOTH for the stream");
							await pollT71Log(log, /EMIT-QUESTION/, 15_000);
							await postJson(`${srv.url}api/chat/stop`, {});
						},
					);
					expect(buf).toContain('"method":"approval/requested"');
					expect(buf).toContain('"method":"userInput/requested"');
					expect(buf).toContain('"method":"approval/resolved"');
					expect(buf).toContain('"outcome":"aborted"');
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t50(
		"settings.toml default_access drives session start",
		async () => {
			const { bin, log } = stubT50Bin();
			const dataHome = mktmp("t50-dh-settings-");
			nodeFs.mkdirSync(path.join(dataHome, "routeros-muse"), {
				recursive: true,
			});
			nodeFs.writeFileSync(
				path.join(dataHome, "routeros-muse", "settings.toml"),
				'[agent]\ndefault_access = "allowAll"\n',
			);
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, { dataHome });
				try {
					await sendText(srv.url, "T50-SETTINGS-DRIVE");
					await pollT71Log(log, /START session=/, 15_000);
					expect(nodeFs.readFileSync(log, "utf8")).toContain(
						"START session=t50-s1 approvalMode=allowAll",
					);
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t50(
		"defaultApprovalMode (--yolo) overrides settings.toml",
		async () => {
			const { bin, log } = stubT50Bin();
			const dataHome = mktmp("t50-dh-yolo-");
			nodeFs.mkdirSync(path.join(dataHome, "routeros-muse"), {
				recursive: true,
			});
			nodeFs.writeFileSync(
				path.join(dataHome, "routeros-muse", "settings.toml"),
				'[agent]\ndefault_access = "promptUnmatched"\n',
			);
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, {
					dataHome,
					defaultApprovalMode: "allowAll",
				});
				try {
					await sendText(srv.url, "T50-YOLO-OVERRIDE");
					await pollT71Log(log, /START session=/, 15_000);
					expect(nodeFs.readFileSync(log, "utf8")).toContain(
						"START session=t50-s1 approvalMode=allowAll",
					);
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t50(
		"settings route roundtrips and preserves other content",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					const before = await getJson(`${srv.url}api/settings`);
					expect(before["ok"]).toBe(true);
					expect(before["defaultAccess"]).toBe("promptUnmatched");
					// Seed unrelated content the write must not disturb.
					const file = path.join(
						srv.dataHome,
						"routeros-muse",
						"settings.toml",
					);
					nodeFs.mkdirSync(path.join(srv.dataHome, "routeros-muse"), {
						recursive: true,
					});
					nodeFs.writeFileSync(file, "# operator note\n[other]\nkeep = true\n");
					const written = await postJson(`${srv.url}api/settings`, {
						defaultAccess: "allowAll",
					});
					expect(written.json["ok"]).toBe(true);
					const text = nodeFs.readFileSync(file, "utf8");
					expect(text).toContain("# operator note");
					expect(text).toContain("[other]");
					expect(text).toContain('[agent]\ndefault_access = "allowAll"');
					const after = await getJson(`${srv.url}api/settings`);
					expect(after["defaultAccess"]).toBe("allowAll");
					const bogus = await postJson(`${srv.url}api/settings`, {
						defaultAccess: "denyUnmatched",
					});
					expect(bogus.json["ok"]).toBe(false);
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t50(
		"corrupt settings falls back to promptUnmatched",
		async () => {
			const { bin, log } = stubT50Bin();
			const dataHome = mktmp("t50-dh-corrupt-");
			nodeFs.mkdirSync(path.join(dataHome, "routeros-muse"), {
				recursive: true,
			});
			nodeFs.writeFileSync(
				path.join(dataHome, "routeros-muse", "settings.toml"),
				"[agent\ndefault_access = oops\n",
			);
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, { dataHome });
				try {
					await sendText(srv.url, "T50-CORRUPT");
					await pollT71Log(log, /START session=/, 15_000);
					expect(nodeFs.readFileSync(log, "utf8")).toContain(
						"START session=t50-s1 approvalMode=promptUnmatched",
					);
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t50(
		"access route still accepts onRequest and denyUnmatched",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					for (const mode of ["onRequest", "denyUnmatched"]) {
						const res = await postJson(`${srv.url}api/chat/access`, { mode });
						expect(res.json["ok"]).toBe(true);
					}
					const text = await pollT71Log(log, /MODE denyUnmatched/, 15_000);
					expect(text).toContain("MODE onRequest");
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t50(
		"settings write through a symlink is refused with why",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					const victim = path.join(srv.dataHome, "victim.txt");
					nodeFs.writeFileSync(victim, "victim-bytes\n");
					const file = path.join(
						srv.dataHome,
						"routeros-muse",
						"settings.toml",
					);
					nodeFs.mkdirSync(path.join(srv.dataHome, "routeros-muse"), {
						recursive: true,
					});
					nodeFs.symlinkSync(victim, file);
					const refused = await postJson(`${srv.url}api/settings`, {
						defaultAccess: "allowAll",
					});
					expect(refused.json["ok"]).toBe(false);
					expect(String(refused.json["why"] ?? "")).toMatch(/symlink/i);
					expect([409, 500]).toContain(refused.status);
					expect(nodeFs.readFileSync(victim, "utf8")).toBe("victim-bytes\n");
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t50(
		"pending is empty without a session and spawns nothing",
		async () => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin);
				try {
					const pending = await getJson(`${srv.url}api/chat/pending`);
					expect(pending["ok"]).toBe(true);
					expect(pending["approvals"]).toHaveLength(0);
					expect(pending["userInputs"]).toHaveLength(0);
					let text = "";
					try {
						text = nodeFs.readFileSync(log, "utf8");
					} catch {
						// no worker ever spawned: no log at all
					}
					expect(text).not.toContain("START session=");
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);
});
