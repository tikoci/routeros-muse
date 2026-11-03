// T106 follow-ups to T55 (D41): dedicated loopback relay listener,
// ui_open size bounds, no-workspace preallow visibility, remaining
// selector escapes, spawn initialize failure cleanup.
//
// Hermetic: the T50 fake fronts PATH via toolBinDir (bypass-mode
// servers, echo provider); relay tests speak plain HTTP on
// loopback; the spawn test fronts a stub `muse`. POSIX-only legs
// skip on win32 like the T55 suite.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { toolEnv } from "../src/lib/tools";
import { ARTIFACT_MAX_BYTES, readTomlSections } from "../src/lib/workspace";
import { SEED_TOOL_NAMES } from "../src/mcp/trilogy-tools";
import { RELAY_URL_ENV, resolveUiOpen } from "../src/mcp/ui-tools";
import { MspClient } from "../src/msp/client";
import { startServer } from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";
import {
	makeT50Workspace,
	startT50Srv,
	stubT50Bin,
	withT50Env,
} from "./t50-fake";

afterAll(cleanupTmpdirs);

const t106 = process.platform !== "win32" ? test : test.skip;

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

/** The /api/file viewer cap both doc and TOML viewers read through. */
const FILE_VIEWER_MAX = 512 * 1024;

function writeSized(file: string, size: number): void {
	nodeFs.mkdirSync(path.dirname(file), { recursive: true });
	nodeFs.writeFileSync(file, Buffer.alloc(size, 0x61));
}

function openFixture(): string {
	const ws = mktmp("t106-open-");
	nodeFs.writeFileSync(path.join(ws, "workspace.toml"), "canonical = true\n");
	return ws;
}

/** Read the MCPCFG line the fake logs at session start; the worker's relay URL. */
function relayUrlFromLog(log: string): string {
	const line = nodeFs
		.readFileSync(log, "utf8")
		.split("\n")
		.find((l) => l.startsWith("MCPCFG "));
	if (!line) throw new Error("fake never logged MCPCFG (no session start?)");
	const cfg = JSON.parse(line.slice("MCPCFG ".length)) as Record<
		string,
		Record<string, unknown>
	>;
	const env = cfg["routeros_muse"]?.["env"] as Record<string, string>;
	const url = env?.[RELAY_URL_ENV];
	if (!url) throw new Error("MCPCFG has no relay URL env");
	return url;
}

describe("dedicated relay listener (item 1)", () => {
	const TOKEN = "t106-relay-token";

	t106(
		"a 127.0.0.2 UI bind still serves the bridge over the relay",
		async () => {
			const bin = stubT50Bin();
			await withT50Env(bin.log, async () => {
				const srv = await startServer({
					dataHome: mktmp("t106-host-dh-"),
					allowOpenCdb: true,
					workspace: makeT50Workspace(),
					provider: "echo",
					museHome: mktmp("t106-host-home-"),
					toolBinDir: bin.bin,
					mcpToken: TOKEN,
					host: "127.0.0.2",
				});
				try {
					expect(new URL(srv.url).hostname).toBe("127.0.0.2");
					const res = await postJson(`${srv.relayUrl}api/mcp/relay`, {
						token: TOKEN,
						tool: "ui_notify",
						arguments: { text: "lan-bound hello" },
					});
					expect(res.status).toBe(200);
					expect(res.json["ok"]).toBe(true);
				} finally {
					await srv.stop();
				}
			});
		},
	);

	t106(
		"UI-port relay POST 404s (relay no longer shares the UI listener)",
		async () => {
			const bin = stubT50Bin();
			await withT50Env(bin.log, async () => {
				const srv = await startT50Srv(bin.bin, { mcpToken: TOKEN });
				try {
					const res = await postJson(`${srv.url}api/mcp/relay`, {
						token: TOKEN,
						tool: "ui_notify",
						arguments: { text: "should not land" },
					});
					expect(res.status).toBe(404);
				} finally {
					await srv.stop();
				}
			});
		},
	);

	t106(
		"worker config points at a dedicated loopback relay that answers",
		async () => {
			const bin = stubT50Bin();
			await withT50Env(bin.log, async () => {
				const srv = await startT50Srv(bin.bin, { mcpToken: TOKEN });
				try {
					const sent = await postJson(`${srv.url}api/chat/send`, {
						text: "hello relay",
					});
					expect(sent.json["ok"]).toBe(true);
					const relayUrl = relayUrlFromLog(bin.log);
					const relayPort = new URL(relayUrl).port;
					const uiPort = new URL(srv.url).port;
					expect(relayPort).not.toBe(uiPort);
					expect(new URL(relayUrl).hostname).toBe("127.0.0.1");
					// The relay answers with the same semantics as before.
					const ok = await postJson(`${relayUrl}api/mcp/relay`, {
						token: TOKEN,
						tool: "ui_notify",
						arguments: { text: "dedicated hello" },
					});
					expect(ok.status).toBe(200);
					expect(ok.json["ok"]).toBe(true);
					// Token and body-cap semantics survive the move.
					const bad = await postJson(`${relayUrl}api/mcp/relay`, {
						token: "wrong",
						tool: "ui_notify",
						arguments: { text: "x" },
					});
					expect(bad.status).toBe(401);
					const big = await postJson(`${relayUrl}api/mcp/relay`, {
						token: TOKEN,
						tool: "ui_notify",
						arguments: { text: "x".repeat(70 * 1024) },
					});
					expect(big.status).toBe(413);
					// The relay listener serves that one route only.
					expect((await fetch(relayUrl)).status).toBe(404);
					expect((await fetch(`${relayUrl}api/mcp/relay`)).status).toBe(404);
					expect((await fetch(`${relayUrl}api/status`)).status).toBe(404);
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);
});

describe("ui_open size bounds (item 2)", () => {
	t106("doc files over the /api/file cap are refused at preflight", () => {
		const ws = openFixture();
		writeSized(path.join(ws, "notes-ok.md"), FILE_VIEWER_MAX);
		writeSized(path.join(ws, "notes-big.md"), FILE_VIEWER_MAX + 1);
		nodeFs.mkdirSync(path.join(ws, "n"), { recursive: true });
		expect(resolveUiOpen(ws, "notes-ok.md")).toEqual({
			ok: true,
			kind: "doc",
		});
		const big = resolveUiOpen(ws, "notes-big.md");
		expect(big.ok).toBe(false);
		if (!big.ok) expect(big.why).toMatch(/limit/);
	});

	t106("toml files over the viewer cap are refused at preflight", () => {
		const ws = openFixture();
		const head = '[device]\nid = "t106-gw"\n# pad\n';
		const pad = `# ${"x".repeat(1024)}\n`;
		const over = head + pad.repeat(FILE_VIEWER_MAX / 1024 + 2);
		nodeFs.writeFileSync(path.join(ws, "big.toml"), over);
		const small = `${head}name = "small"\n`;
		nodeFs.writeFileSync(path.join(ws, "small.toml"), small);
		expect(resolveUiOpen(ws, "small.toml")).toEqual({
			ok: true,
			kind: "toml",
		});
		const big = resolveUiOpen(ws, "big.toml");
		expect(big.ok).toBe(false);
		if (!big.ok) expect(big.why).toMatch(/limit/);
	});

	t106("artifacts over ARTIFACT_MAX_BYTES are refused at preflight", () => {
		const ws = openFixture();
		expect(ARTIFACT_MAX_BYTES).toBe(8 * 1024 * 1024);
		writeSized(path.join(ws, "ok.html"), ARTIFACT_MAX_BYTES);
		writeSized(path.join(ws, "big.html"), ARTIFACT_MAX_BYTES + 1);
		expect(resolveUiOpen(ws, "ok.html")).toEqual({
			ok: true,
			kind: "artifact",
		});
		const big = resolveUiOpen(ws, "big.html");
		expect(big.ok).toBe(false);
		if (!big.ok) expect(big.why).toMatch(/limit/);
	});

	t106("over-limit ui_open through the relay is a tool refusal", async () => {
		const bin = stubT50Bin();
		await withT50Env(bin.log, async () => {
			const ws = openFixture();
			writeSized(path.join(ws, "huge.md"), FILE_VIEWER_MAX + 1);
			const srv = await startT50Srv(bin.bin, {
				mcpToken: "t106-big-token",
				workspace: ws,
			});
			try {
				const sent = await postJson(`${srv.url}api/chat/send`, {
					text: "hello big",
				});
				expect(sent.json["ok"]).toBe(true);
				const relayUrl = relayUrlFromLog(bin.log);
				const res = await postJson(`${relayUrl}api/mcp/relay`, {
					token: "t106-big-token",
					tool: "ui_open",
					arguments: { path: "huge.md" },
				});
				expect(res.status).toBe(200);
				expect(res.json["ok"]).toBe(false);
				expect(String(res.json["why"])).toMatch(/limit/);
			} finally {
				await srv.stop();
			}
		});
	});
});

describe("no-workspace preallow visibility (item 3)", () => {
	const TOKEN = "t106-nows-token";

	async function startNoWs(): Promise<{
		url: string;
		stop: () => Promise<void>;
	}> {
		const bin = stubT50Bin();
		const srv = await startServer({
			dataHome: mktmp("t106-nows-dh-"),
			configHome: mktmp("t106-nows-cfg-"),
			allowOpenCdb: true,
			noWorkspace: true,
			provider: "echo",
			museHome: mktmp("t106-nows-home-"),
			toolBinDir: bin.bin,
			mcpToken: TOKEN,
		});
		return srv;
	}

	t106("status reports the seeded ui tools instead of null", async () => {
		const srv = await startNoWs();
		try {
			const st = (await (await fetch(`${srv.url}api/status`)).json()) as Record<
				string,
				unknown
			>;
			expect(st["mode"]).toBe("no-workspace");
			const pre = st["preallow"] as Record<string, unknown> | null;
			expect(pre).not.toBeNull();
			expect(pre?.["enabled"]).toBe(true);
			expect(pre?.["tools"]).toEqual(SEED_TOOL_NAMES);
			expect(pre?.["commands"]).toEqual([]);
			expect(pre?.["hosts"]).toEqual([]);
		} finally {
			await srv.stop();
		}
	});

	t106("settings toggle revokes and restores the seeded tools", async () => {
		const srv = await startNoWs();
		try {
			const off = await postJson(`${srv.url}api/settings`, {
				preallowReads: false,
			});
			expect(off.json["ok"]).toBe(true);
			let st = (await (await fetch(`${srv.url}api/status`)).json()) as Record<
				string,
				unknown
			>;
			let pre = st["preallow"] as Record<string, unknown>;
			expect(pre["enabled"]).toBe(false);
			expect(pre["tools"]).toEqual([]);
			const on = await postJson(`${srv.url}api/settings`, {
				preallowReads: true,
			});
			expect(on.json["ok"]).toBe(true);
			st = (await (await fetch(`${srv.url}api/status`)).json()) as Record<
				string,
				unknown
			>;
			pre = st["preallow"] as Record<string, unknown>;
			expect(pre["enabled"]).toBe(true);
			expect(pre["tools"]).toEqual(SEED_TOOL_NAMES);
		} finally {
			await srv.stop();
		}
	});
});

describe("codex re-review fixes", () => {
	// Linux-only: the listener snapshot shells out to `ss`.
	const tbind =
		process.platform === "linux" && Bun.which("ss") !== null ? test : test.skip;
	tbind("a failed main bind leaves no relay listener behind", async () => {
		const listening = (): Set<string> => {
			const out = new TextDecoder().decode(
				Bun.spawnSync(["ss", "-tlnH"]).stdout,
			);
			return new Set(out.trim().split("\n").filter(Boolean));
		};
		const before = listening();
		await expect(
			startServer({
				dataHome: mktmp("t106-bindfail-dh-"),
				allowOpenCdb: true,
				noWorkspace: true,
				provider: "echo",
				museHome: mktmp("t106-bindfail-home-"),
				mcpToken: "t106-bindfail-token",
				port: -1,
			}),
		).rejects.toThrow();
		const leaked = [...listening()].filter((l) => !before.has(l));
		expect(leaked).toEqual([]);
	});

	t106("UI-port relay POST 404s even when locked (no bypass)", async () => {
		const bin = stubT50Bin();
		const srv = await startServer({
			dataHome: mktmp("t106-locked-dh-"),
			noWorkspace: true,
			provider: "echo",
			museHome: mktmp("t106-locked-home-"),
			toolBinDir: bin.bin,
			mcpToken: "t106-locked-token",
		});
		try {
			const res = await postJson(`${srv.url}api/mcp/relay`, {
				token: "t106-locked-token",
				tool: "ui_notify",
				arguments: { text: "x" },
			});
			expect(res.status).toBe(404);
		} finally {
			await srv.stop();
		}
	});

	t106(
		"a relay handler throw answers the JSON envelope, not HTML",
		async () => {
			const bin = stubT50Bin();
			await withT50Env(bin.log, async () => {
				const srv = await startT50Srv(bin.bin, { mcpToken: TOKEN2 });
				try {
					const sent = await postJson(`${srv.url}api/chat/send`, {
						text: "hello throw",
					});
					expect(sent.json["ok"]).toBe(true);
					const relayUrl = relayUrlFromLog(bin.log);
					const res = await fetch(`${relayUrl}api/mcp/relay`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							token: TOKEN2,
							tool: "ui_notify",
							arguments: {
								text: "x",
								level: { toString: null, valueOf: null },
							},
						}),
					});
					expect(res.status).toBe(500);
					const body = (await res.json()) as Record<string, unknown>;
					expect(body["ok"]).toBe(false);
				} finally {
					await srv.stop();
				}
			});
		},
	);

	t106("the TOML read path refuses files over the viewer cap", () => {
		const ws = openFixture();
		const head = '[device]\nid = "t106-gw"\n# pad\n';
		const pad = `# ${"x".repeat(1024)}\n`;
		nodeFs.writeFileSync(
			path.join(ws, "big.toml"),
			head + pad.repeat(FILE_VIEWER_MAX / 1024 + 2),
		);
		const res = readTomlSections(ws, "big.toml");
		expect(res.status).toBe(400);
		expect(JSON.stringify(res.body)).toMatch(/too large/);
	});
});
const TOKEN2 = "t106-throw-token";

describe("selector escaping audit (item 4)", () => {
	test("every concatenated querySelector value goes through CSS.escape", () => {
		// Scan whole call arguments (multi-line aware, quote aware):
		// every non-literal operand of a `+` concatenation, and every
		// ${} interpolation in a template literal, must be a
		// CSS.escape(...) call. A partially escaped selector fails.
		function auditSelectors(src: string): string[] {
			const bad: string[] = [];
			const re = /querySelector(?:All)?\s*\(/g;
			for (let m = re.exec(src); m !== null; m = re.exec(src)) {
				let i = m.index + m[0].length;
				let depth = 1;
				let quote: string | null = null;
				const start = i;
				for (; i < src.length; i++) {
					const c = src[i] as string;
					if (quote !== null) {
						if (c === "\\") i++;
						else if (c === quote) quote = null;
						continue;
					}
					if (c === '"' || c === "'" || c === "`") quote = c;
					else if (c === "(") depth++;
					else if (c === ")" && --depth === 0) break;
				}
				const arg = src.slice(start, i);
				// Remove balanced CSS.escape(...) calls first: their
				// inner concatenations ('dev-' + id) are escaped as a
				// whole and must not count as bare operands.
				let scrubbed = "";
				for (let j = 0; j < arg.length; ) {
					if (arg.startsWith("CSS.escape(", j)) {
						let d = 0;
						let k = j + "CSS.escape".length;
						for (; k < arg.length; k++) {
							if (arg[k] === "(") d++;
							else if (arg[k] === ")" && --d === 0) break;
						}
						scrubbed += "CSS.escape(X)";
						j = k + 1;
					} else {
						scrubbed += arg[j];
						j++;
					}
				}
				// Strip quoted literals, then check each operand.
				const bare = scrubbed.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "``");
				if (arg.includes("`")) {
					// The whole interpolation must be one CSS.escape(...)
					// call — CSS.escape(a) + b is only partially escaped.
					const fullyEscaped = (expr: string): boolean => {
						const t = expr.trim();
						if (!t.startsWith("CSS.escape(")) return false;
						let d = 0;
						let q: string | null = null;
						for (let k = "CSS.escape".length; k < t.length; k++) {
							const c = t[k] as string;
							if (q !== null) {
								if (c === "\\") k++;
								else if (c === q) q = null;
								continue;
							}
							if (c === '"' || c === "'" || c === "`") q = c;
							else if (c === "(") d++;
							else if (c === ")" && --d === 0) return k === t.length - 1;
						}
						return false;
					};
					for (const interp of arg.matchAll(/\$\{([^}]*)\}/g)) {
						if (!fullyEscaped(interp[1] ?? ""))
							bad.push(`template: ${interp[0]}`);
					}
				}
				if (bare.includes("+")) {
					for (const operand of bare.split("+")) {
						const t = operand.trim().replace(/^[(`]+|[)`]+$/g, "");
						if (!t) continue;
						if (!t.startsWith("CSS.escape("))
							bad.push(`operand: ${t.slice(0, 60)}`);
					}
				}
			}
			return bad;
		}
		const html = nodeFs.readFileSync(
			path.join(path.resolve(import.meta.dir, ".."), "src", "serve", "ui.html"),
			"utf8",
		);
		expect(auditSelectors(html)).toEqual([]);
		// The audit is not vacuous: partially escaped and template
		// forms are caught.
		expect(
			auditSelectors(
				`document.querySelector('.x[data-a="' + CSS.escape(a) + '"][data-b="' + b + '"]')`,
			).length,
		).toBeGreaterThan(0);
		const tpl = (inner: string) =>
			['document.querySelector(`.x[data-a="', "$", "{", inner, '}"]`)'].join(
				"",
			);
		expect(auditSelectors(tpl("b")).length).toBeGreaterThan(0);
		expect(auditSelectors(tpl("CSS.escape(a) + b")).length).toBeGreaterThan(0);
		// Parens inside string literals do not balance the call.
		expect(
			auditSelectors(tpl('CSS.escape("(") + b.concat(")")')).length,
		).toBeGreaterThan(0);
		expect(auditSelectors(tpl('CSS.escape(")")'))).toEqual([]);
	});

	t106("a quoted workspace name still opens through the relay", async () => {
		const bin = stubT50Bin();
		await withT50Env(bin.log, async () => {
			const ws = openFixture();
			const name = `we"ird 'q'.md`;
			nodeFs.writeFileSync(path.join(ws, name), "# quoted\n");
			const srv = await startT50Srv(bin.bin, {
				mcpToken: "t106-quote-token",
				workspace: ws,
			});
			try {
				const sent = await postJson(`${srv.url}api/chat/send`, {
					text: "hello quote",
				});
				expect(sent.json["ok"]).toBe(true);
				const relayUrl = relayUrlFromLog(bin.log);
				const res = await postJson(`${relayUrl}api/mcp/relay`, {
					token: "t106-quote-token",
					tool: "ui_open",
					arguments: { path: name },
				});
				expect(res.status).toBe(200);
				expect(res.json["ok"]).toBe(true);
			} finally {
				await srv.stop();
			}
		});
	});
});

describe("spawn initialize failure cleanup (item 5)", () => {
	const tstub = process.platform === "win32" ? test.skip : test;

	function pidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	async function waitForDead(pid: number, ms: number): Promise<boolean> {
		const end = Date.now() + ms;
		for (;;) {
			if (!pidAlive(pid)) return true;
			if (Date.now() > end) return false;
			await Bun.sleep(100);
		}
	}

	tstub(
		"a hung initialize kills the child on failure",
		async () => {
			const dir = mktmp("t106-hang-");
			const pidFile = path.join(dir, "child.pid");
			const stub = path.join(dir, "muse");
			// Records its pid, then never answers initialize.
			nodeFs.writeFileSync(
				stub,
				`#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
await new Promise(() => {});
`,
			);
			nodeFs.chmodSync(stub, 0o755);
			const env = toolEnv(dir);
			const err = await MspClient.spawn({
				provider: "echo",
				env,
				timeoutMs: 800,
			}).then(
				() => null,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toMatch(/timed out/);
			const pid = Number(nodeFs.readFileSync(pidFile, "utf8").trim());
			expect(Number.isInteger(pid) && pid > 0).toBe(true);
			try {
				expect(await waitForDead(pid, 5_000)).toBe(true);
			} finally {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already gone: the fix worked
				}
			}
		},
		30_000,
	);

	tstub(
		"an instantly-exiting child rejects promptly, not at the timeout",
		async () => {
			const dir = mktmp("t106-exit-");
			const stub = path.join(dir, "muse");
			nodeFs.writeFileSync(stub, `#!/bin/sh\nexit 1\n`);
			nodeFs.chmodSync(stub, 0o755);
			const env = toolEnv(dir);
			const t0 = Date.now();
			const err = await MspClient.spawn({
				provider: "echo",
				env,
				timeoutMs: 800,
			}).then(
				() => null,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).not.toMatch(/timed out/);
			expect(Date.now() - t0).toBeLessThan(700);
		},
		15_000,
	);

	tstub(
		"a SIGTERM-ignoring child is SIGKILLed after the grace wait",
		async () => {
			const dir = mktmp("t106-stubborn-");
			const pidFile = path.join(dir, "child.pid");
			const stub = path.join(dir, "muse");
			nodeFs.writeFileSync(
				stub,
				`#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
await new Promise(() => {});
`,
			);
			nodeFs.chmodSync(stub, 0o755);
			const env = toolEnv(dir);
			const err = await MspClient.spawn({
				provider: "echo",
				env,
				timeoutMs: 800,
			}).then(
				() => null,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toMatch(/timed out/);
			const pid = Number(nodeFs.readFileSync(pidFile, "utf8").trim());
			try {
				expect(await waitForDead(pid, 5_000)).toBe(true);
			} finally {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already gone: the fix worked
				}
			}
		},
		30_000,
	);
});
