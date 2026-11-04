// T55 (D41): per-session MCP server with ui_* tools — fail-first suite.
//
// The worker negotiates sessionMcp at initialize and passes
// config.mcpServers at session/start; a stdio bridge
// (src/mcp/ui-bridge.ts) relays tools/call to the running server
// over loopback HTTP with a per-session token, and the server fans
// the ui_* calls out as ui/* SSE events the UI renders with its
// existing viewers. The three tools are pre-seeded as tagged
// tool_action allow rules under the existing preallow toggle.
//
// Hermetic: the T50 fake fronts PATH via toolBinDir (bypass-mode
// servers, no CDB, no centrs); the bridge under test is the real
// file spawned with the test server's URL and token override. The
// ambient `muse` binary is never run. POSIX-only legs (shell-shim
// bin dirs) skip on win32 like the T50 suite.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	ensurePreallowReads,
	PREALLOW_TAG,
	policyFile,
	toolRuleForMcp,
} from "../src/lib/preallow";
import { ROSETTA_MCP_SERVER, SEED_TOOL_NAMES } from "../src/mcp/trilogy-tools";
import {
	mcpToolName,
	mintMcpToken,
	NOTIFY_TEXT_MAX,
	RELAY_TOKEN_ENV,
	RELAY_URL_ENV,
	resolveUiOpen,
	stripMcpPrefix,
	tokensEqual,
	UI_MCP_SERVER,
	UI_TOOL_NAMES,
	uiMcpServers,
} from "../src/mcp/ui-tools";
import { isLoopbackPeer, startServer } from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";
import {
	makeT50Workspace,
	startT50Srv,
	stubT50Bin,
	stubT50CdbRows,
	withT50Env,
} from "./t50-fake";

afterAll(cleanupTmpdirs);

const t55 = process.platform !== "win32" ? test : test.skip;

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
		try {
			await pump;
		} catch {
			// settle only
		}
	}
}

describe("ui tool identity", () => {
	test("server name and tool set are exactly the four ui tools", () => {
		expect(UI_MCP_SERVER).toBe("routeros_muse");
		expect([...UI_TOOL_NAMES]).toEqual([
			"ui_notify",
			"ui_open",
			"ui_select_device",
			"ui_add_device",
		]);
	});

	test("namespaced names match the mcp__<server>__<tool> wire shape", () => {
		expect(mcpToolName("ui_notify")).toBe("mcp__routeros_muse__ui_notify");
		expect(mcpToolName("ui_open")).toBe("mcp__routeros_muse__ui_open");
		expect(mcpToolName("ui_select_device")).toBe(
			"mcp__routeros_muse__ui_select_device",
		);
	});

	test("prefix strip accepts the namespaced form and passes the rest through", () => {
		expect(stripMcpPrefix("mcp__routeros_muse__ui_notify")).toBe("ui_notify");
		expect(stripMcpPrefix("ui_open")).toBe("ui_open");
		expect(stripMcpPrefix("mcp__other__ui_notify")).toBe(
			"mcp__other__ui_notify",
		);
		expect(stripMcpPrefix("")).toBe("");
	});
});

describe("relay token", () => {
	test("mint is 32 hex chars and unique per call", () => {
		const a = mintMcpToken();
		const b = mintMcpToken();
		expect(a).toMatch(/^[0-9a-f]{32}$/);
		expect(b).toMatch(/^[0-9a-f]{32}$/);
		expect(a).not.toBe(b);
	});

	test("compare is exact, length-sensitive, and never true on empty", () => {
		expect(tokensEqual("abc", "abc")).toBe(true);
		expect(tokensEqual("abc", "abd")).toBe(false);
		expect(tokensEqual("abc", "abcd")).toBe(false);
		expect(tokensEqual("", "")).toBe(false);
		expect(tokensEqual("", "abc")).toBe(false);
		expect(tokensEqual("abc", "")).toBe(false);
	});
});

describe("mcpServers config", () => {
	test("builder emits the grounded stdio shape", () => {
		expect(
			uiMcpServers({
				bridge: "/pkg/src/mcp/ui-bridge.ts",
				bun: "/bin/bun",
				url: "http://127.0.0.1:9999/",
				token: "tok",
			}),
		).toEqual({
			routeros_muse: {
				transport: "stdio",
				command: "/bin/bun",
				args: ["/pkg/src/mcp/ui-bridge.ts"],
				env: {
					[RELAY_URL_ENV]: "http://127.0.0.1:9999/",
					[RELAY_TOKEN_ENV]: "tok",
				},
			},
		});
	});

	test("relay env keys are the documented names", () => {
		expect(RELAY_URL_ENV).toBe("ROUTEROS_MUSE_URL");
		expect(RELAY_TOKEN_ENV).toBe("ROUTEROS_MUSE_MCP_TOKEN");
	});
});

describe("resolveUiOpen", () => {
	function fixture(): string {
		const ws = mktmp("t55-open-");
		nodeFs.writeFileSync(path.join(ws, "workspace.toml"), "canonical = true\n");
		nodeFs.writeFileSync(
			path.join(ws, "router.toml"),
			'[device]\nid = "t55-gw"\n',
		);
		nodeFs.mkdirSync(path.join(ws, "notes"));
		nodeFs.writeFileSync(path.join(ws, "notes", "hello.md"), "# hello\n");
		nodeFs.writeFileSync(path.join(ws, "pic.svg"), "<svg></svg>");
		return ws;
	}

	t55("kinds route to the existing viewers", () => {
		const ws = fixture();
		expect(resolveUiOpen(ws, "notes/hello.md")).toEqual({
			ok: true,
			kind: "doc",
		});
		expect(resolveUiOpen(ws, "router.toml")).toEqual({
			ok: true,
			kind: "toml",
		});
		expect(resolveUiOpen(ws, "pic.svg")).toEqual({
			ok: true,
			kind: "artifact",
		});
	});

	t55("dot-dot and absolute escapes are refused", () => {
		const ws = fixture();
		for (const rel of [
			"../outside.md",
			"notes/../../outside.md",
			"/etc/hostname",
			`${ws}/../outside.md`,
		]) {
			const r = resolveUiOpen(ws, rel);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.why).toMatch(/escapes the workspace/);
		}
	});

	t55("symlinks in the path are refused, in or out", () => {
		const ws = fixture();
		const outside = mktmp("t55-outside-");
		nodeFs.writeFileSync(path.join(outside, "secret.md"), "shh\n");
		nodeFs.symlinkSync(
			path.join(outside, "secret.md"),
			path.join(ws, "link-out.md"),
		);
		nodeFs.symlinkSync(
			path.join(ws, "notes", "hello.md"),
			path.join(ws, "link-in.md"),
		);
		nodeFs.mkdirSync(path.join(ws, "realdir"));
		nodeFs.writeFileSync(path.join(ws, "realdir", "f.md"), "f\n");
		nodeFs.symlinkSync(path.join(ws, "realdir"), path.join(ws, "linkdir"));
		for (const rel of ["link-out.md", "link-in.md", "linkdir/f.md"]) {
			const r = resolveUiOpen(ws, rel);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.why).toMatch(/symlink/);
		}
		// The targets themselves stay openable by their real paths.
		expect(resolveUiOpen(ws, "notes/hello.md")).toEqual({
			ok: true,
			kind: "doc",
		});
	});

	t55("credential stores are refused (T109)", () => {
		const ws = fixture();
		nodeFs.writeFileSync(path.join(ws, "device.cdb"), "secret\n");
		nodeFs.writeFileSync(path.join(ws, "other.cdb"), "secret\n");
		nodeFs.writeFileSync(path.join(ws, "device.md"), "notes\n");
		for (const rel of ["device.cdb", "other.cdb"]) {
			const r = resolveUiOpen(ws, rel);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.why).toMatch(/credential stores are not displayed/);
		}
		expect(resolveUiOpen(ws, "device.md")).toEqual({
			ok: true,
			kind: "doc",
		});
	});

	t55(
		"credential store check uses the normalized basename, case-insensitively (T109 P2b)",
		() => {
			const ws = fixture();
			nodeFs.writeFileSync(path.join(ws, "device.cdb"), "secret\n");
			nodeFs.mkdirSync(path.join(ws, "sub"));
			nodeFs.writeFileSync(path.join(ws, "sub", "DEVICE.CDB"), "secret\n");
			nodeFs.writeFileSync(path.join(ws, "x.cdb"), "secret\n");
			for (const rel of ["device.cdb/.", "sub/DEVICE.CDB", "x.cdb"]) {
				const r = resolveUiOpen(ws, rel);
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.why).toMatch(/credential stores are not displayed/);
			}
			// A directory merely named *.cdb is not a credential store file:
			// the gate is the basename of the file itself, so a doc inside
			// such a directory stays openable.
			nodeFs.mkdirSync(path.join(ws, "foo.cdb"));
			nodeFs.writeFileSync(path.join(ws, "foo.cdb", "bar.md"), "inside\n");
			expect(resolveUiOpen(ws, "foo.cdb/bar.md")).toEqual({
				ok: true,
				kind: "doc",
			});
		},
	);

	t55("missing, directory, and empty paths are refused", () => {
		const ws = fixture();
		const missing = resolveUiOpen(ws, "notes/nope.md");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.why).toMatch(/no such file/);
		const dir = resolveUiOpen(ws, "notes");
		expect(dir.ok).toBe(false);
		if (!dir.ok) expect(dir.why).toMatch(/not a file/);
		const empty = resolveUiOpen(ws, "");
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.why).toMatch(/need \{path\}/);
	});
});

describe("seeded ui tool rules", () => {
	function readRules(cfg: string): unknown[] {
		const raw = nodeFs.readFileSync(policyFile(cfg), "utf8");
		return (JSON.parse(raw) as { rules: unknown[] }).rules;
	}

	test("tool rule builder is exactly the captured shape", () => {
		expect(toolRuleForMcp("mcp__routeros_muse__ui_notify")).toEqual({
			kind: "tool_action",
			tool_name: "mcp__routeros_muse__ui_notify",
		});
	});

	test("enabled seeds the full namespaced tool set, key order like muse", () => {
		const cfg = mktmp("t55-seed-");
		const res = ensurePreallowReads({
			configHome: cfg,
			workspaceRoot: mktmp("t55-seed-ws-"),
			hosts: [],
			enabled: true,
		});
		expect(res.warnings).toEqual([]);
		const rules = readRules(cfg) as Record<string, unknown>[];
		const tools = rules.filter(
			(e) => (e["rule"] as Record<string, unknown>)?.["kind"] === "tool_action",
		);
		// T105/T112: the four ui tools first, then the read-only
		// rosetta tools — seed order pinned, no centrs tools at
		// all, no mixed/write tools.
		expect(tools).toEqual(
			SEED_TOOL_NAMES.map((tool_name) => ({
				effect: "allow",
				durability: "local_persistent",
				rule: {
					kind: "tool_action",
					tool_name,
				},
				reason: PREALLOW_TAG,
			})),
		);
		expect(SEED_TOOL_NAMES).not.toContain("mcp__centrs__centrs_explain");
		expect(SEED_TOOL_NAMES).not.toContain("mcp__centrs__centrs_validate");
		expect(SEED_TOOL_NAMES).not.toContain("mcp__centrs__centrs_retrieve");
		expect(SEED_TOOL_NAMES).not.toContain("mcp__centrs__centrs_execute");
		expect(SEED_TOOL_NAMES).not.toContain("mcp__centrs__centrs_devices");
		expect(SEED_TOOL_NAMES).not.toContain("mcp__centrs__centrs_discover");
		// Key order matches muse's own writer (P7 capture).
		const flat = nodeFs
			.readFileSync(policyFile(cfg), "utf8")
			.replace(/\s+/g, "");
		for (const tool_name of SEED_TOOL_NAMES) {
			expect(flat).toContain(
				`"rule":{"kind":"tool_action","tool_name":"${tool_name}"}`,
			);
		}
	});

	test("disabled prunes the tagged tool rules", () => {
		const cfg = mktmp("t55-prune-");
		const ws = mktmp("t55-prune-ws-");
		ensurePreallowReads({
			configHome: cfg,
			workspaceRoot: ws,
			hosts: [],
			enabled: true,
		});
		expect(readRules(cfg).length).toBeGreaterThan(0);
		const res = ensurePreallowReads({
			configHome: cfg,
			workspaceRoot: ws,
			hosts: [],
			enabled: false,
		});
		expect(res.warnings).toEqual([]);
		const rules = readRules(cfg) as Record<string, unknown>[];
		expect(rules.filter((e) => e["reason"] === PREALLOW_TAG)).toEqual([]);
	});

	test("foreign tool rules survive both directions; tagged strangers are replaced", () => {
		const cfg = mktmp("t55-foreign-");
		const ws = mktmp("t55-foreign-ws-");
		const foreign = {
			effect: "allow",
			durability: "local_persistent",
			rule: { kind: "tool_action", tool_name: "mcp__other__thing" },
			reason: null,
		};
		const stranger = {
			effect: "allow",
			durability: "local_persistent",
			rule: { kind: "tool_action", tool_name: "mcp__routeros_muse__retired" },
			reason: PREALLOW_TAG,
		};
		nodeFs.mkdirSync(path.join(cfg, "muse"), { recursive: true });
		nodeFs.writeFileSync(
			policyFile(cfg),
			`${JSON.stringify({ schema_version: 2, rules: [foreign, stranger] }, null, 2)}\n`,
		);
		ensurePreallowReads({
			configHome: cfg,
			workspaceRoot: ws,
			hosts: [],
			enabled: true,
		});
		const rules = readRules(cfg) as Record<string, unknown>[];
		// The owner's own rule is untouched; the stale tagged name is
		// replaced by the current seed set (per-workspace ownership).
		expect(rules).toContainEqual(foreign);
		expect(rules).not.toContainEqual(stranger);
		expect(
			rules.filter(
				(e) =>
					(e["rule"] as Record<string, unknown>)?.["kind"] === "tool_action",
			).length,
		).toBe(1 + SEED_TOOL_NAMES.length);
		ensurePreallowReads({
			configHome: cfg,
			workspaceRoot: ws,
			hosts: [],
			enabled: false,
		});
		expect(readRules(cfg)).toEqual([foreign]);
	});
});

describe("worker spawn negotiation", () => {
	t55("every worker spawn sends sessionMcp plus both mcpServers", async () => {
		const bin = stubT50Bin();
		await withT50Env(bin.log, async () => {
			const srv = await startT50Srv(bin.bin, {
				mcpToken: "t55-fixed-token",
			});
			try {
				const sent = await postJson(`${srv.url}api/chat/send`, {
					text: "hello negotiation",
				});
				expect(sent.json["ok"]).toBe(true);
				const log = nodeFs.readFileSync(bin.log, "utf8");
				const caps = log
					.split("\n")
					.find((l) => l.startsWith("CAPS requestedCapabilities="));
				expect(caps).toBeDefined();
				expect(
					JSON.parse(caps?.slice("CAPS requestedCapabilities=".length) ?? "[]"),
				).toContain("sessionMcp");
				const cfgLine = log.split("\n").find((l) => l.startsWith("MCPCFG "));
				expect(cfgLine).toBeDefined();
				const cfg = JSON.parse(
					cfgLine?.slice("MCPCFG ".length) ?? "{}",
				) as Record<string, Record<string, unknown>>;
				// T105/T112: the ui bridge plus the rosetta bundle
				// server, in config-key order. No centrs server.
				expect(Object.keys(cfg).sort()).toEqual(
					[UI_MCP_SERVER, ROSETTA_MCP_SERVER].sort(),
				);
				expect("centrs" in cfg).toBe(false);
				const one = cfg[UI_MCP_SERVER] as Record<string, unknown>;
				expect(one["transport"]).toBe("stdio");
				expect(one["command"]).toBe(process.execPath);
				const args = one["args"] as string[];
				expect(args.length).toBe(1);
				expect(args[0]?.endsWith("src/mcp/ui-bridge.ts")).toBe(true);
				expect(nodeFs.existsSync(args[0] as string)).toBe(true);
				expect(one["env"]).toEqual({
					[RELAY_URL_ENV]: expect.stringMatching(
						/^http:\/\/127\.0\.0\.1:\d+\/$/,
					),
					[RELAY_TOKEN_ENV]: "t55-fixed-token",
				});
				// The rosetta entry rides an absolute bundle path
				// (D26).
				const entry = cfg[ROSETTA_MCP_SERVER] as Record<string, unknown>;
				expect(entry["transport"]).toBe("stdio");
				expect(entry["command"]).toBe(process.execPath);
				const eargs = entry["args"] as string[];
				expect(path.isAbsolute(eargs[0] as string)).toBe(true);
				expect(nodeFs.existsSync(eargs[0] as string)).toBe(true);
			} finally {
				await srv.stop();
			}
		});
	});

	t55(
		"session/start with mcpServers but no sessionMcp is capabilityRequired",
		async () => {
			// Raw JSON-RPC against the fake: pins the fake's fidelity to
			// the grounded B2 refusal, which is what makes the negotiation
			// test above meaningful (a server that forgot sessionMcp would
			// break every session start loudly).
			const bin = stubT50Bin();
			const child = Bun.spawn(
				[process.execPath, path.join(bin.bin, "fake-muse-t50.ts")],
				{
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
					env: process.env as Record<string, string>,
				},
			);
			try {
				const stdin = child.stdin;
				if (typeof stdin !== "object" || stdin === null) {
					throw new Error("fake stdin not piped");
				}
				const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
				const dec = new TextDecoder();
				let buf = "";
				async function nextFrame(): Promise<Record<string, unknown>> {
					for (;;) {
						const nl = buf.indexOf("\n");
						if (nl >= 0) {
							const line = buf.slice(0, nl);
							buf = buf.slice(nl + 1);
							if (line.trim())
								return JSON.parse(line) as Record<string, unknown>;
							continue;
						}
						const { done, value } = await reader.read();
						if (done) throw new Error("fake exited mid-test");
						buf += dec.decode(value, { stream: true });
					}
				}
				stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "t", version: "0" } } })}\n`,
				);
				stdin.flush();
				await nextFrame();
				stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/start", params: { commandId: "c", workspaceRoot: makeT50Workspace(), config: { mcpServers: { x: {} } } } })}\n`,
				);
				stdin.flush();
				const res = await nextFrame();
				expect(res["id"]).toBe(2);
				const err = res["error"] as Record<string, unknown>;
				expect(err["code"]).toBe(-32010);
				expect(err["message"]).toContain("sessionMcp");
				expect((err["data"] as Record<string, unknown>)["kind"]).toBe(
					"capabilityRequired",
				);
			} finally {
				child.kill();
				await child.exited;
			}
		},
	);
});

describe("probe sessions carry no ui tools", () => {
	t55(
		"boot probe and oauth recheck send no mcpServers; the worker does",
		async () => {
			const ws = mktmp("t55-probe-ws-");
			nodeFs.writeFileSync(
				path.join(ws, "workspace.toml"),
				"canonical = true\n",
			);
			const real = mktmp("t55-probe-real-");
			nodeFs.mkdirSync(path.join(real, "muse"), { recursive: true });
			nodeFs.writeFileSync(
				path.join(real, "muse", "auth.json"),
				'{"fake":true}\n',
			);
			const saved = process.env["XDG_CONFIG_HOME"];
			process.env["XDG_CONFIG_HOME"] = real;
			try {
				const bin = stubT50Bin();
				await withT50Env(bin.log, async () => {
					const srv = await startT50Srv(bin.bin, {
						provider: "meta",
						workspace: ws,
						mcpToken: "t55-probe-token",
					});
					try {
						const recheck = await fetch(`${srv.url}api/auth/oauth-recheck`, {
							method: "POST",
							headers: { origin: new URL(srv.url).origin },
						});
						expect(recheck.status).toBe(200);
						const sent = await postJson(`${srv.url}api/chat/send`, {
							text: "hello",
						});
						expect(sent.status).toBe(200);
						const deadline = Date.now() + 20_000;
						let log = "";
						for (;;) {
							log = nodeFs.existsSync(bin.log)
								? nodeFs.readFileSync(bin.log, "utf8")
								: "";
							const starts = log
								.split("\n")
								.filter((l) => l.startsWith("CAPS ")).length;
							if (starts >= 3 || Date.now() > deadline) break;
							await Bun.sleep(100);
						}
						const lines = log.split("\n");
						expect(
							lines.filter((l) => l.startsWith("CAPS ")).length,
						).toBeGreaterThanOrEqual(3);
						expect(lines.filter((l) => l.startsWith("MCPCFG ")).length).toBe(1);
					} finally {
						await srv.stop();
					}
				});
			} finally {
				if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
				else process.env["XDG_CONFIG_HOME"] = saved;
			}
		},
		60_000,
	);
});

describe("relay route", () => {
	const TOKEN = "t55-relay-token";

	function relayWs(): string {
		const ws = mktmp("t55-relay-");
		nodeFs.writeFileSync(path.join(ws, "workspace.toml"), "canonical = true\n");
		// D53: devices live in the CDB; the stub answers its rows.
		nodeFs.writeFileSync(path.join(ws, "device.cdb"), "t55 stub CDB\n");
		nodeFs.mkdirSync(path.join(ws, "notes"));
		nodeFs.writeFileSync(path.join(ws, "notes", "hello.md"), "# hello\n");
		const outside = mktmp("t55-relay-out-");
		nodeFs.writeFileSync(path.join(outside, "secret.md"), "shh\n");
		nodeFs.symlinkSync(
			path.join(outside, "secret.md"),
			path.join(ws, "link-out.md"),
		);
		return ws;
	}

	function relayCall(url: string, body: unknown): Promise<Posted> {
		return postJson(`${url}api/mcp/relay`, body);
	}

	t55("wrong or missing token is 401", async () => {
		const bin = stubT50Bin();
		await withT50Env(bin.log, async () => {
			const srv = await startT50Srv(bin.bin, { mcpToken: TOKEN });
			try {
				const wrong = await relayCall(srv.relayUrl, {
					token: "nope",
					tool: "ui_notify",
					arguments: { text: "x" },
				});
				expect(wrong.status).toBe(401);
				expect(String(wrong.json["why"])).toMatch(/token/);
				const missing = await relayCall(srv.relayUrl, {
					tool: "ui_notify",
					arguments: { text: "x" },
				});
				expect(missing.status).toBe(401);
				const empty = await relayCall(srv.relayUrl, {
					token: "",
					tool: "ui_notify",
					arguments: { text: "x" },
				});
				expect(empty.status).toBe(401);
			} finally {
				await srv.stop();
			}
		});
	});

	t55("only loopback peers count as the bridge", () => {
		for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
			expect(isLoopbackPeer(a)).toBe(true);
		}
		for (const a of [
			undefined,
			"",
			"192.168.74.157",
			"10.0.0.1",
			"::ffff:192.168.1.2",
			"fe80::1",
			"127.0.0.1.evil",
			"1127.0.0.1",
		]) {
			expect(isLoopbackPeer(a)).toBe(false);
		}
	});

	t55(
		"an oversized body is refused before parsing or the token check",
		async () => {
			const bin = stubT50Bin();
			await withT50Env(bin.log, async () => {
				const srv = await startT50Srv(bin.bin, { mcpToken: TOKEN });
				try {
					const big = await relayCall(srv.relayUrl, {
						token: TOKEN,
						tool: "ui_notify",
						arguments: { text: "x".repeat(70 * 1024) },
					});
					expect(big.status).toBe(413);
					const notJson = await fetch(`${srv.relayUrl}api/mcp/relay`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{not json",
					});
					expect(notJson.status).toBe(400);
				} finally {
					await srv.stop();
				}
			});
		},
	);

	t55("unknown tool is a tool error, not an HTTP error", async () => {
		const bin = stubT50Bin();
		await withT50Env(bin.log, async () => {
			const srv = await startT50Srv(bin.bin, { mcpToken: TOKEN });
			try {
				const res = await relayCall(srv.relayUrl, {
					token: TOKEN,
					tool: "ui_nope",
					arguments: {},
				});
				expect(res.status).toBe(200);
				expect(res.json["ok"]).toBe(false);
				expect(String(res.json["why"])).toMatch(/unknown ui tool/);
			} finally {
				await srv.stop();
			}
		});
	});

	t55("ui_notify emits its SSE event and reports back", async () => {
		const bin = stubT50Bin();
		await withT50Env(bin.log, async () => {
			const srv = await startT50Srv(bin.bin, { mcpToken: TOKEN });
			try {
				const buf = await collectSse(
					srv.url,
					['"method":"ui/notify"'],
					async () => {
						const res = await relayCall(srv.relayUrl, {
							token: TOKEN,
							tool: "ui_notify",
							arguments: { text: "relay hello", level: "warn" },
						});
						expect(res.status).toBe(200);
						expect(res.json["ok"]).toBe(true);
						expect(String(res.json["result"])).toMatch(/notified \(warn\)/);
					},
				);
				const frame = JSON.parse(
					buf
						.split("\n")
						.find((l) => l.includes('"method":"ui/notify"'))
						?.slice("data: ".length) ?? "{}",
				) as Record<string, unknown>;
				expect((frame["params"] as Record<string, unknown>)["text"]).toBe(
					"relay hello",
				);
				expect((frame["params"] as Record<string, unknown>)["level"]).toBe(
					"warn",
				);
			} finally {
				await srv.stop();
			}
		});
	});

	t55("ui_notify defaults to info and validates its args", async () => {
		const bin = stubT50Bin();
		await withT50Env(bin.log, async () => {
			const srv = await startT50Srv(bin.bin, { mcpToken: TOKEN });
			try {
				const buf = await collectSse(
					srv.url,
					['"method":"ui/notify"'],
					async () => {
						const res = await relayCall(srv.relayUrl, {
							token: TOKEN,
							tool: "ui_notify",
							arguments: { text: "plain" },
						});
						expect(res.json["ok"]).toBe(true);
					},
				);
				expect(buf).toContain('"level":"info"');
				const noText = await relayCall(srv.relayUrl, {
					token: TOKEN,
					tool: "ui_notify",
					arguments: {},
				});
				expect(noText.json["ok"]).toBe(false);
				expect(String(noText.json["why"])).toMatch(/need \{text\}/);
				const badLevel = await relayCall(srv.relayUrl, {
					token: TOKEN,
					tool: "ui_notify",
					arguments: { text: "x", level: "loud" },
				});
				expect(badLevel.json["ok"]).toBe(false);
				expect(String(badLevel.json["why"])).toMatch(/info\|warn\|alert/);
				const long = await relayCall(srv.relayUrl, {
					token: TOKEN,
					tool: "ui_notify",
					arguments: { text: "y".repeat(NOTIFY_TEXT_MAX + 100) },
				});
				expect(long.json["ok"]).toBe(true);
				expect(String(long.json["result"])).toMatch(/truncated/);
			} finally {
				await srv.stop();
			}
		});
	});

	t55("ui_open emits its SSE event with the viewer kind", async () => {
		const bin = stubT50Bin();
		await withT50Env(bin.log, async () => {
			const srv = await startT50Srv(bin.bin, {
				mcpToken: TOKEN,
				workspace: relayWs(),
			});
			try {
				const buf = await collectSse(
					srv.url,
					['"method":"ui/open"'],
					async () => {
						const res = await relayCall(srv.relayUrl, {
							token: TOKEN,
							tool: "ui_open",
							arguments: { path: "notes/hello.md" },
						});
						expect(res.json["ok"]).toBe(true);
						expect(String(res.json["result"])).toMatch(
							/opened notes\/hello\.md/,
						);
					},
				);
				expect(buf).toContain('"path":"notes/hello.md"');
				expect(buf).toContain('"kind":"doc"');
			} finally {
				await srv.stop();
			}
		});
	});

	t55("ui_open refuses escapes, symlinks, and missing files", async () => {
		const bin = stubT50Bin();
		await withT50Env(bin.log, async () => {
			const srv = await startT50Srv(bin.bin, {
				mcpToken: TOKEN,
				workspace: relayWs(),
			});
			try {
				for (const [rel, want] of [
					["../x.md", /escapes the workspace/],
					["/etc/hostname", /escapes the workspace/],
					["link-out.md", /symlink/],
					["notes/nope.md", /no such file/],
					["notes", /not a file/],
				] as [string, RegExp][]) {
					const res = await relayCall(srv.relayUrl, {
						token: TOKEN,
						tool: "ui_open",
						arguments: { path: rel },
					});
					expect(res.status).toBe(200);
					expect(res.json["ok"]).toBe(false);
					expect(String(res.json["why"])).toMatch(want);
				}
				// None of the refusals emitted anything.
				const buf = await collectSse(
					srv.url,
					['"method":"ui/open"'],
					async () => {},
					500,
				);
				expect(buf).not.toContain('"method":"ui/open"');
			} finally {
				await srv.stop();
			}
		});
	});

	t55("ui_select_device emits its SSE event; unknown ids error", async () => {
		const bin = stubT50Bin();
		stubT50CdbRows(bin.bin, [{ target: "t55-gw" }]);
		await withT50Env(bin.log, async () => {
			const srv = await startT50Srv(bin.bin, {
				mcpToken: TOKEN,
				workspace: relayWs(),
			});
			try {
				// D53: ids are checked against the last /api/devices list,
				// so a CDB device is unknown until the UI has listed it.
				const early = await relayCall(srv.relayUrl, {
					token: TOKEN,
					tool: "ui_select_device",
					arguments: { id: "t55-gw" },
				});
				expect(early.json["ok"]).toBe(false);
				expect(String(early.json["why"])).toMatch(/unknown device/);
				await getJson(`${srv.url}api/devices`);
				const buf = await collectSse(
					srv.url,
					['"method":"ui/select-device"'],
					async () => {
						const res = await relayCall(srv.relayUrl, {
							token: TOKEN,
							tool: "ui_select_device",
							arguments: { id: "t55-gw" },
						});
						expect(res.json["ok"]).toBe(true);
						expect(String(res.json["result"])).toMatch(/selected t55-gw/);
					},
				);
				expect(buf).toContain('"id":"t55-gw"');
				const unknown = await relayCall(srv.relayUrl, {
					token: TOKEN,
					tool: "ui_select_device",
					arguments: { id: "nope" },
				});
				expect(unknown.json["ok"]).toBe(false);
				expect(String(unknown.json["why"])).toMatch(/unknown device/);
			} finally {
				await srv.stop();
			}
		});
	});

	t55(
		"no-workspace mode: notify works, open refuses, select checks the CDB list",
		async () => {
			const bin = stubT50Bin();
			stubT50CdbRows(bin.bin, [{ target: "192.0.2.7" }]);
			await withT50Env(bin.log, async () => {
				const srv = await startServer({
					dataHome: mktmp("t55-nows-dh-"),
					allowOpenCdb: true,
					noWorkspace: true,
					provider: "echo",
					museHome: mktmp("t55-nows-home-"),
					toolBinDir: bin.bin,
					mcpToken: TOKEN,
				});
				try {
					const buf = await collectSse(
						srv.url,
						['"method":"ui/notify"'],
						async () => {
							const ok = await relayCall(srv.relayUrl, {
								token: TOKEN,
								tool: "ui_notify",
								arguments: { text: "nows" },
							});
							expect(ok.json["ok"]).toBe(true);
						},
					);
					expect(buf).toContain('"text":"nows"');
					const open = await relayCall(srv.relayUrl, {
						token: TOKEN,
						tool: "ui_open",
						arguments: { path: "x.md" },
					});
					expect(open.json["ok"]).toBe(false);
					expect(String(open.json["why"])).toMatch(/no workspace/);
					// D53: select works without a workspace; ids are the
					// CDB targets from the last device list.
					const listed = await getJson(`${srv.url}api/devices`);
					expect(listed["source"]).toBe("cdb");
					const sel = await relayCall(srv.relayUrl, {
						token: TOKEN,
						tool: "ui_select_device",
						arguments: { id: "192.0.2.7" },
					});
					expect(sel.json["ok"]).toBe(true);
					const unknown = await relayCall(srv.relayUrl, {
						token: TOKEN,
						tool: "ui_select_device",
						arguments: { id: "x" },
					});
					expect(unknown.json["ok"]).toBe(false);
					expect(String(unknown.json["why"])).toMatch(/unknown device/);
				} finally {
					await srv.stop();
				}
			});
		},
	);
});

const BRIDGE = path.join(
	path.resolve(import.meta.dir, ".."),
	"src",
	"mcp",
	"ui-bridge.ts",
);

type BridgeProc = {
	call: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
	notify: (method: string, params?: unknown) => void;
	close: () => Promise<void>;
};

/** Minimal MCP client over a bridge child: strict id matching, 10s calls. */
async function withBridge(
	env: Record<string, string>,
	fn: (b: BridgeProc) => Promise<void>,
): Promise<void> {
	const child = Bun.spawn([process.execPath, BRIDGE], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const stdin = child.stdin;
	if (typeof stdin !== "object" || stdin === null) {
		throw new Error("bridge stdin not piped");
	}
	const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
	const dec = new TextDecoder();
	let buf = "";
	let nextId = 1;
	async function nextFrame(): Promise<Record<string, unknown>> {
		for (;;) {
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.trim()) return JSON.parse(line) as Record<string, unknown>;
				continue;
			}
			const { done, value } = await reader.read();
			if (done) throw new Error("bridge exited mid-test");
			buf += dec.decode(value, { stream: true });
		}
	}
	function write(obj: unknown): void {
		stdin.write(`${JSON.stringify(obj)}\n`);
		stdin.flush();
	}
	let closed = false;
	const proc: BridgeProc = {
		call: async (method, params) => {
			const id = nextId++;
			write({ jsonrpc: "2.0", id, method, params: params ?? {} });
			const res = (await Promise.race([
				(async () => {
					for (;;) {
						const frame = await nextFrame();
						if (frame["id"] === id) return frame;
					}
				})(),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error(`${method} timed out`)), 10_000),
				),
			])) as Record<string, unknown>;
			return res;
		},
		notify: (method, params) => {
			write({ jsonrpc: "2.0", method, params: params ?? {} });
		},
		close: async () => {
			if (closed) return;
			closed = true;
			try {
				stdin.end();
			} catch {
				// already gone
			}
			reader.releaseLock();
			await child.exited;
		},
	};
	try {
		await fn(proc);
	} finally {
		await proc.close();
	}
}

async function initBridge(b: BridgeProc): Promise<Record<string, unknown>> {
	const res = await b.call("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "t55", version: "0" },
	});
	if (res["error"])
		throw new Error(`initialize failed: ${JSON.stringify(res["error"])}`);
	b.notify("notifications/initialized");
	return res["result"] as Record<string, unknown>;
}

describe("bridge MCP surface", () => {
	const TOKEN = "t55-bridge-token";

	function bridgeWs(): string {
		const ws = mktmp("t55-bridge-");
		nodeFs.writeFileSync(path.join(ws, "workspace.toml"), "canonical = true\n");
		// D53: devices live in the CDB; the stub answers its rows.
		nodeFs.writeFileSync(path.join(ws, "device.cdb"), "t55 stub CDB\n");
		nodeFs.mkdirSync(path.join(ws, "notes"));
		nodeFs.writeFileSync(path.join(ws, "notes", "hello.md"), "# hello\n");
		const outside = mktmp("t55-bridge-out-");
		nodeFs.writeFileSync(path.join(outside, "secret.md"), "shh\n");
		nodeFs.symlinkSync(
			path.join(outside, "secret.md"),
			path.join(ws, "link-out.md"),
		);
		return ws;
	}

	function bridgeEnv(url: string): Record<string, string> {
		return {
			...(process.env as Record<string, string>),
			[RELAY_URL_ENV]: url,
			[RELAY_TOKEN_ENV]: TOKEN,
		};
	}

	t55(
		"initialize answers the grounded shape; tools/list pins the set",
		async () => {
			const bin = stubT50Bin();
			await withT50Env(bin.log, async () => {
				const srv = await startT50Srv(bin.bin, { mcpToken: TOKEN });
				try {
					await withBridge(bridgeEnv(srv.relayUrl), async (b) => {
						const init = await initBridge(b);
						expect(typeof init["protocolVersion"]).toBe("string");
						expect(init["capabilities"]).toEqual({ tools: {} });
						expect(
							(init["serverInfo"] as Record<string, unknown>)["name"],
						).toBe(UI_MCP_SERVER);
						const listed = await b.call("tools/list", {});
						const tools = (listed["result"] as Record<string, unknown>)[
							"tools"
						] as Record<string, unknown>[];
						expect(tools.map((t) => t["name"])).toEqual([...UI_TOOL_NAMES]);
						const byName = new Map(tools.map((t) => [t["name"], t]));
						const notify = byName.get("ui_notify") as Record<string, unknown>;
						expect(
							(notify["inputSchema"] as Record<string, unknown>)["required"],
						).toEqual(["text"]);
						expect(
							(
								(
									(notify["inputSchema"] as Record<string, unknown>)[
										"properties"
									] as Record<string, unknown>
								)["level"] as Record<string, unknown>
							)["enum"],
						).toEqual(["info", "warn", "alert"]);
						expect(
							(
								(byName.get("ui_open") as Record<string, unknown>)[
									"inputSchema"
								] as Record<string, unknown>
							)["required"],
						).toEqual(["path"]);
						expect(
							(
								(byName.get("ui_select_device") as Record<string, unknown>)[
									"inputSchema"
								] as Record<string, unknown>
							)["required"],
						).toEqual(["id"]);
						// T110 pins the duplicated bridge schema: host
						// required, user/id optional.
						expect(
							(
								(byName.get("ui_add_device") as Record<string, unknown>)[
									"inputSchema"
								] as Record<string, unknown>
							)["required"],
						).toEqual(["host"]);
					});
				} finally {
					await srv.stop();
				}
			});
		},
	);

	t55(
		"tools/call relays each tool; refusals come back isError",
		async () => {
			const bin = stubT50Bin();
			stubT50CdbRows(bin.bin, [{ target: "t55-gw" }]);
			await withT50Env(bin.log, async () => {
				const srv = await startT50Srv(bin.bin, {
					mcpToken: TOKEN,
					workspace: bridgeWs(),
				});
				try {
					await getJson(`${srv.url}api/devices`);
					await withBridge(bridgeEnv(srv.relayUrl), async (b) => {
						await initBridge(b);
						const buf = await collectSse(
							srv.url,
							[
								'"method":"ui/notify"',
								'"method":"ui/open"',
								'"method":"ui/select-device"',
							],
							async () => {
								const n = await b.call("tools/call", {
									name: "ui_notify",
									arguments: { text: "bridge hello" },
								});
								const nRes = n["result"] as Record<string, unknown>;
								expect(nRes["isError"]).toBeUndefined();
								expect(
									(
										(nRes["content"] as Record<string, unknown>[])[0] as Record<
											string,
											unknown
										>
									)["text"],
								).toMatch(/notified \(info\)/);
								const o = await b.call("tools/call", {
									name: "ui_open",
									arguments: { path: "notes/hello.md" },
								});
								expect(
									(
										(
											(o["result"] as Record<string, unknown>)[
												"content"
											] as Record<string, unknown>[]
										)[0] as Record<string, unknown>
									)["text"],
								).toMatch(/opened notes\/hello\.md/);
								const s = await b.call("tools/call", {
									name: "ui_select_device",
									arguments: { id: "t55-gw" },
								});
								expect(
									(
										(
											(s["result"] as Record<string, unknown>)[
												"content"
											] as Record<string, unknown>[]
										)[0] as Record<string, unknown>
									)["text"],
								).toMatch(/selected t55-gw/);
							},
						);
						expect(buf).toContain('"text":"bridge hello"');
						expect(buf).toContain('"path":"notes/hello.md"');
						expect(buf).toContain('"id":"t55-gw"');
						// Refusals: isError results carrying the tool why.
						for (const [name, args, want] of [
							["ui_open", { path: "../x.md" }, /escapes the workspace/],
							["ui_open", { path: "/etc/hostname" }, /escapes the workspace/],
							["ui_open", { path: "link-out.md" }, /symlink/],
							["ui_select_device", { id: "nope" }, /unknown device/],
							["ui_notify", {}, /need \{text\}/],
							["ui_nope", {}, /unknown ui tool/],
						] as [string, Record<string, string>, RegExp][]) {
							const r = await b.call("tools/call", { name, arguments: args });
							expect(r["error"]).toBeUndefined();
							const res = r["result"] as Record<string, unknown>;
							expect(res["isError"]).toBe(true);
							expect(
								(
									(res["content"] as Record<string, unknown>[])[0] as Record<
										string,
										unknown
									>
								)["text"],
							).toMatch(want);
						}
					});
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);

	t55("wrong token is a JSON-RPC error, not a result", async () => {
		const bin = stubT50Bin();
		await withT50Env(bin.log, async () => {
			const srv = await startT50Srv(bin.bin, { mcpToken: TOKEN });
			try {
				const env = bridgeEnv(srv.relayUrl);
				env[RELAY_TOKEN_ENV] = "wrong";
				await withBridge(env, async (b) => {
					await initBridge(b);
					const r = await b.call("tools/call", {
						name: "ui_notify",
						arguments: { text: "x" },
					});
					expect(r["result"]).toBeUndefined();
					const err = r["error"] as Record<string, unknown>;
					expect(err["code"]).toBe(-32000);
					expect(String(err["message"])).toMatch(/token/);
				});
			} finally {
				await srv.stop();
			}
		});
	});

	t55("missing relay env fails calls with the key names", async () => {
		await withBridge(
			{ ...(process.env as Record<string, string>) },
			async (b) => {
				await initBridge(b);
				const r = await b.call("tools/call", {
					name: "ui_notify",
					arguments: { text: "x" },
				});
				expect(r["result"]).toBeUndefined();
				const msg = String((r["error"] as Record<string, unknown>)["message"]);
				expect(msg).toContain(RELAY_URL_ENV);
				expect(msg).toContain(RELAY_TOKEN_ENV);
			},
		);
	});

	t55("unknown method is -32601", async () => {
		const bin = stubT50Bin();
		await withT50Env(bin.log, async () => {
			const srv = await startT50Srv(bin.bin, { mcpToken: TOKEN });
			try {
				await withBridge(bridgeEnv(srv.relayUrl), async (b) => {
					await initBridge(b);
					const r = await b.call("resources/list", {});
					expect(r["result"]).toBeUndefined();
					expect((r["error"] as Record<string, unknown>)["code"]).toBe(-32601);
				});
			} finally {
				await srv.stop();
			}
		});
	});
});

describe("fake-driven end to end", () => {
	t55(
		"NEED-UI-TOOLS drives the real bridge through the transmitted config",
		async () => {
			const bin = stubT50Bin();
			await withT50Env(bin.log, async () => {
				const ws = mktmp("t55-e2e-");
				nodeFs.writeFileSync(
					path.join(ws, "workspace.toml"),
					"canonical = true\n",
				);
				nodeFs.writeFileSync(path.join(ws, "device.cdb"), "t55 stub CDB\n");
				stubT50CdbRows(bin.bin, [{ target: "t55-gw" }]);
				nodeFs.mkdirSync(path.join(ws, "notes"));
				nodeFs.writeFileSync(path.join(ws, "notes", "hello.md"), "# hello\n");
				const srv = await startT50Srv(bin.bin, {
					mcpToken: "t55-e2e-token",
					workspace: ws,
				});
				try {
					// The relay validates select ids against the last list.
					await getJson(`${srv.url}api/devices`);
					const buf = await collectSse(
						srv.url,
						[
							'"method":"ui/notify"',
							'"method":"ui/open"',
							'"method":"ui/select-device"',
							'"method":"turn/completed"',
						],
						async () => {
							const sent = await postJson(`${srv.url}api/chat/send`, {
								text: "NEED-UI-TOOLS path=notes/hello.md id=t55-gw",
							});
							expect(sent.json["ok"]).toBe(true);
						},
						30_000,
					);
					expect(buf).toContain('"text":"T55 smoke toast"');
					expect(buf).toContain('"path":"notes/hello.md"');
					expect(buf).toContain('"id":"t55-gw"');
					// The fake reports each tool result back in its turn text.
					expect(buf).toContain("t55 ui tools:");
					expect(buf).toContain("notified");
					expect(buf).toContain("opened notes/hello.md");
					expect(buf).toContain("selected t55-gw");
					expect(buf).not.toContain("FAILED");
				} finally {
					await srv.stop();
				}
			});
		},
		30_000,
	);
});

describe("preallow toggle end to end", () => {
	t55("settings toggle seeds and prunes the tool rules on disk", async () => {
		const bin = stubT50Bin();
		await withT50Env(bin.log, async () => {
			const cfg = mktmp("t55-tog-cfg-");
			const srv = await startT50Srv(bin.bin, {
				mcpToken: "t55-tog-token",
				configHome: cfg,
				dataHome: mktmp("t55-tog-dh-"),
			});
			try {
				const names = (): string[] => {
					const raw = nodeFs.readFileSync(policyFile(cfg), "utf8");
					const rules = (
						JSON.parse(raw) as { rules: Record<string, unknown>[] }
					).rules;
					return rules
						.filter(
							(e) =>
								(e["rule"] as Record<string, unknown>)?.["kind"] ===
								"tool_action",
						)
						.map(
							(e) =>
								(e["rule"] as Record<string, unknown>)["tool_name"] as string,
						)
						.sort();
				};
				// Boot default is on.
				expect(names()).toEqual([...SEED_TOOL_NAMES].sort());
				const status = await getJson(`${srv.url}api/status`);
				expect(
					(status["preallow"] as Record<string, unknown>)["tools"],
				).toEqual(SEED_TOOL_NAMES);
				const off = await postJson(`${srv.url}api/settings`, {
					preallowReads: false,
				});
				expect(off.json["ok"]).toBe(true);
				expect(names()).toEqual([]);
				const on = await postJson(`${srv.url}api/settings`, {
					preallowReads: true,
				});
				expect(on.json["ok"]).toBe(true);
				expect(names()).toEqual([...SEED_TOOL_NAMES].sort());
			} finally {
				await srv.stop();
			}
		});
	});
});
