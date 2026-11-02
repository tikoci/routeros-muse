// T105: the trilogy's MCP servers (centrs and rosetta) in the session
// config — fail-first suite.
//
// The session config gains centrs + rosetta stdio servers next to
// routeros_muse, launched via process.execPath (bun) with ABSOLUTE
// bundle entry paths. A bundle entry missing on disk omits only that
// server (honest degradation, worker still starts). The centrs entry
// binds CENTRS_CDB_FILE to the session's CDB in workspace mode and to
// the operator default (no env) otherwise; CENTRS_CDB_PASSWORD never
// rides the config. The read-only tools of both servers seed tagged
// tool_action allow rules under the same preallow toggle; the mixed
// and write tools are never seeded. sessionMcp-denied hosts still get
// chat without the config (existing MspClient.uiTools gate).
//
// Hermetic: unit tests over the builder + seed set, plus fake-backed
// server spawns (MCPCFG log seam, like t55). The real `muse` binary is
// never run here; live approval behavior is captured separately.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { ensurePreallowReads, policyFile } from "../src/lib/preallow";
import {
	CENTRS_MCP_SERVER,
	CENTRS_READONLY_TOOLS,
	ROSETTA_MCP_SERVER,
	ROSETTA_TOOL_NAMES,
	SEED_TOOL_NAMES,
	sessionMcpServers,
	TRILOGY_SEED_TOOLS,
	trilogyToolName,
} from "../src/mcp/trilogy-tools";
import { UI_MCP_SERVER, uiMcpServers } from "../src/mcp/ui-tools";
import type { McpServerConfig } from "../src/msp/client";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";
import { startT50Srv, stubT50Bin, withT50Env } from "./t50-fake";

afterAll(cleanupTmpdirs);

const t105 = process.platform !== "win32" ? test : test.skip;

function readToolNames(cfg: string): string[] {
	const raw = nodeFs.readFileSync(policyFile(cfg), "utf8");
	const rules = (JSON.parse(raw) as { rules: Record<string, unknown>[] }).rules;
	return rules
		.filter(
			(e) => (e["rule"] as Record<string, unknown>)?.["kind"] === "tool_action",
		)
		.map((e) => (e["rule"] as Record<string, unknown>)["tool_name"] as string)
		.sort();
}

describe("trilogy server identity", () => {
	test("config keys are centrs and rosetta", () => {
		expect(CENTRS_MCP_SERVER).toBe("centrs");
		expect(ROSETTA_MCP_SERVER).toBe("rosetta");
	});

	test("namespaced names match the mcp__<server>__<tool> wire shape", () => {
		expect(trilogyToolName("centrs", "centrs_retrieve")).toBe(
			"mcp__centrs__centrs_retrieve",
		);
		expect(trilogyToolName("rosetta", "routeros_search")).toBe(
			"mcp__rosetta__routeros_search",
		);
	});

	test("centrs read-only set is exactly explain/validate/retrieve", () => {
		expect([...CENTRS_READONLY_TOOLS]).toEqual([
			"centrs_explain",
			"centrs_validate",
			"centrs_retrieve",
		]);
	});

	test("rosetta tool set is the verified read-only set", () => {
		expect<string[]>([...ROSETTA_TOOL_NAMES].sort()).toEqual(
			[
				"routeros_command_diff",
				"routeros_command_tree",
				"routeros_command_version_check",
				"routeros_current_versions",
				"routeros_device_lookup",
				"routeros_dude_get_page",
				"routeros_dude_search",
				"routeros_explain_command",
				"routeros_get_page",
				"routeros_lookup_property",
				"routeros_search",
				"routeros_search_changelogs",
				"routeros_search_tests",
				"routeros_stats",
			].sort(),
		);
	});
});

describe("sessionMcpServers builder", () => {
	test("real bundle yields all three servers with absolute entry paths", () => {
		const { servers: cfg, missed } = sessionMcpServers({
			bridge: "/pkg/src/mcp/ui-bridge.ts",
			bun: "/bin/bun",
			url: "http://127.0.0.1:9999/",
			token: "tok",
			cdbFile: "/ws/device.cdb",
		});
		expect(missed).toEqual([]);
		expect(Object.keys(cfg).sort()).toEqual(
			[UI_MCP_SERVER, CENTRS_MCP_SERVER, ROSETTA_MCP_SERVER].sort(),
		);
		const ui = cfg[UI_MCP_SERVER];
		const want = uiMcpServers({
			bridge: "/pkg/src/mcp/ui-bridge.ts",
			bun: "/bin/bun",
			url: "http://127.0.0.1:9999/",
			token: "tok",
		})[UI_MCP_SERVER] as McpServerConfig;
		expect(ui).toEqual(want);
		const centrs = cfg[CENTRS_MCP_SERVER] as McpServerConfig;
		expect(centrs.transport).toBe("stdio");
		expect(centrs.command).toBe("/bin/bun");
		expect(centrs.args).toEqual([
			expect.stringMatching(/node_modules\/@tikoci\/centrs\/src\/cli\.ts$/),
			"mcp",
		]);
		expect(path.isAbsolute(centrs.args[0] as string)).toBe(true);
		expect(nodeFs.existsSync(centrs.args[0] as string)).toBe(true);
		expect(centrs.env).toEqual({ CENTRS_CDB_FILE: "/ws/device.cdb" });
		const rosetta = cfg[ROSETTA_MCP_SERVER] as McpServerConfig;
		expect(rosetta.transport).toBe("stdio");
		expect(rosetta.command).toBe("/bin/bun");
		expect(rosetta.args).toEqual([
			expect.stringMatching(
				/node_modules\/@tikoci\/rosetta\/bin\/rosetta\.js$/,
			),
		]);
		expect(path.isAbsolute(rosetta.args[0] as string)).toBe(true);
		expect(nodeFs.existsSync(rosetta.args[0] as string)).toBe(true);
	});

	test("no cdbFile omits CENTRS_CDB_FILE (operator default), never a password", () => {
		const { servers: cfg, missed } = sessionMcpServers({
			bridge: "/pkg/src/mcp/ui-bridge.ts",
			bun: "/bin/bun",
			url: "http://127.0.0.1:9999/",
			token: "tok",
			cdbFile: null,
		});
		expect(missed).toEqual([]);
		const centrs = cfg[CENTRS_MCP_SERVER] as McpServerConfig;
		expect(centrs).toBeDefined();
		expect(centrs.env).toEqual({});
		expect(JSON.stringify(cfg)).not.toContain("CENTRS_CDB_PASSWORD");
	});

	test("missing rosetta bundle entry omits only rosetta", () => {
		const pkg = mktmp("t105-pkg-norosetta-");
		nodeFs.mkdirSync(
			path.join(pkg, "node_modules", "@tikoci", "centrs", "src"),
			{
				recursive: true,
			},
		);
		nodeFs.writeFileSync(
			path.join(pkg, "node_modules", "@tikoci", "centrs", "src", "cli.ts"),
			"// stub\n",
		);
		const { servers: cfg, missed } = sessionMcpServers({
			bridge: "/pkg/src/mcp/ui-bridge.ts",
			bun: "/bin/bun",
			url: "http://127.0.0.1:9999/",
			token: "tok",
			cdbFile: "/ws/device.cdb",
			pkgRoot: pkg,
		});
		expect(missed).toEqual([ROSETTA_MCP_SERVER]);
		expect(Object.keys(cfg).sort()).toEqual(
			[UI_MCP_SERVER, CENTRS_MCP_SERVER].sort(),
		);
	});

	test("missing centrs bundle entry omits only centrs", () => {
		const pkg = mktmp("t105-pkg-nocentrs-");
		nodeFs.mkdirSync(
			path.join(pkg, "node_modules", "@tikoci", "rosetta", "bin"),
			{ recursive: true },
		);
		nodeFs.writeFileSync(
			path.join(pkg, "node_modules", "@tikoci", "rosetta", "bin", "rosetta.js"),
			"// stub\n",
		);
		const { servers: cfg, missed } = sessionMcpServers({
			bridge: "/pkg/src/mcp/ui-bridge.ts",
			bun: "/bin/bun",
			url: "http://127.0.0.1:9999/",
			token: "tok",
			cdbFile: "/ws/device.cdb",
			pkgRoot: pkg,
		});
		expect(missed).toEqual([CENTRS_MCP_SERVER]);
		expect(Object.keys(cfg).sort()).toEqual(
			[UI_MCP_SERVER, ROSETTA_MCP_SERVER].sort(),
		);
	});

	test("missing package root omits both, ui remains", () => {
		const { servers: cfg, missed } = sessionMcpServers({
			bridge: "/pkg/src/mcp/ui-bridge.ts",
			bun: "/bin/bun",
			url: "http://127.0.0.1:9999/",
			token: "tok",
			cdbFile: "/ws/device.cdb",
			pkgRoot: mktmp("t105-pkg-empty-"),
		});
		expect(missed).toEqual([CENTRS_MCP_SERVER, ROSETTA_MCP_SERVER]);
		expect(Object.keys(cfg)).toEqual([UI_MCP_SERVER]);
	});
});

describe("trilogy preallow seed", () => {
	test("seed set is exactly the read-only tools, namespaced", () => {
		// Independent hardcoded pin of the full seed list (review
		// fix): routeros_current_versions is NOT seeded — its handler
		// fetches MikroTik's upgrade server per call, so it is not a
		// local read.
		expect([...SEED_TOOL_NAMES].sort()).toEqual(
			[
				"mcp__routeros_muse__ui_notify",
				"mcp__routeros_muse__ui_open",
				"mcp__routeros_muse__ui_select_device",
				"mcp__centrs__centrs_explain",
				"mcp__centrs__centrs_validate",
				"mcp__centrs__centrs_retrieve",
				"mcp__rosetta__routeros_command_diff",
				"mcp__rosetta__routeros_command_tree",
				"mcp__rosetta__routeros_command_version_check",
				"mcp__rosetta__routeros_device_lookup",
				"mcp__rosetta__routeros_dude_get_page",
				"mcp__rosetta__routeros_dude_search",
				"mcp__rosetta__routeros_explain_command",
				"mcp__rosetta__routeros_get_page",
				"mcp__rosetta__routeros_lookup_property",
				"mcp__rosetta__routeros_search",
				"mcp__rosetta__routeros_search_changelogs",
				"mcp__rosetta__routeros_search_tests",
				"mcp__rosetta__routeros_stats",
			].sort(),
		);
		expect(TRILOGY_SEED_TOOLS).not.toContain(
			"mcp__rosetta__routeros_current_versions",
		);
		// The mixed/write tools are never seeded (permissions.md P7:
		// tool_action rules cannot scope per-op).
		for (const banned of [
			"mcp__centrs__centrs_execute",
			"mcp__centrs__centrs_devices",
			"mcp__centrs__centrs_discover",
		]) {
			expect(TRILOGY_SEED_TOOLS).not.toContain(banned);
		}
	});

	test("enabled seeds exactly the ui + trilogy read-only tool rules", () => {
		const cfg = mktmp("t105-seed-");
		const res = ensurePreallowReads({
			configHome: cfg,
			workspaceRoot: mktmp("t105-seed-ws-"),
			hosts: [],
			enabled: true,
		});
		expect(res.warnings).toEqual([]);
		const names = readToolNames(cfg);
		expect(names).toContain("mcp__routeros_muse__ui_notify");
		expect(names).toContain("mcp__centrs__centrs_retrieve");
		expect(names).toContain("mcp__rosetta__routeros_search");
		for (const banned of [
			"mcp__centrs__centrs_execute",
			"mcp__centrs__centrs_devices",
			"mcp__centrs__centrs_discover",
		]) {
			expect(names).not.toContain(banned);
		}
	});

	test("a narrowed seed set prunes previously seeded rules", () => {
		const cfg = mktmp("t105-narrow-");
		const ws = mktmp("t105-narrow-ws-");
		ensurePreallowReads({
			configHome: cfg,
			workspaceRoot: ws,
			hosts: [],
			enabled: true,
		});
		expect(
			readToolNames(cfg).filter((n) => n.startsWith("mcp__rosetta__")),
		).not.toEqual([]);
		ensurePreallowReads({
			configHome: cfg,
			workspaceRoot: ws,
			hosts: [],
			enabled: true,
			seedTools: ["mcp__routeros_muse__ui_notify"],
		});
		expect(readToolNames(cfg)).toEqual(["mcp__routeros_muse__ui_notify"]);
	});

	test("disabled prunes the trilogy rules with the rest", () => {
		const cfg = mktmp("t105-prune-");
		const ws = mktmp("t105-prune-ws-");
		ensurePreallowReads({
			configHome: cfg,
			workspaceRoot: ws,
			hosts: [],
			enabled: true,
		});
		expect(readToolNames(cfg).length).toBeGreaterThan(0);
		ensurePreallowReads({
			configHome: cfg,
			workspaceRoot: ws,
			hosts: [],
			enabled: false,
		});
		expect(
			readToolNames(cfg).filter((n) => n.startsWith("mcp__centrs__")),
		).toEqual([]);
		expect(
			readToolNames(cfg).filter((n) => n.startsWith("mcp__rosetta__")),
		).toEqual([]);
	});
});

describe("worker spawn carries the trilogy", () => {
	t105(
		"MCPCFG log holds all three servers with absolute bundle paths",
		async () => {
			const bin = stubT50Bin();
			await withT50Env(bin.log, async () => {
				const srv = await startT50Srv(bin.bin, {
					mcpToken: "t105-fixed-token",
				});
				try {
					const res = await fetch(`${srv.url}api/chat/send`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ text: "hello trilogy" }),
					});
					expect(((await res.json()) as Record<string, unknown>)["ok"]).toBe(
						true,
					);
					const log = nodeFs.readFileSync(bin.log, "utf8");
					const cfgLine = log.split("\n").find((l) => l.startsWith("MCPCFG "));
					expect(cfgLine).toBeDefined();
					const cfg = JSON.parse(
						cfgLine?.slice("MCPCFG ".length) ?? "{}",
					) as Record<string, Record<string, unknown>>;
					expect(Object.keys(cfg).sort()).toEqual(
						[UI_MCP_SERVER, CENTRS_MCP_SERVER, ROSETTA_MCP_SERVER].sort(),
					);
					const centrs = cfg[CENTRS_MCP_SERVER] as Record<string, unknown>;
					expect(centrs["transport"]).toBe("stdio");
					expect(centrs["command"]).toBe(process.execPath);
					const args = centrs["args"] as string[];
					expect(args[1]).toBe("mcp");
					expect(path.isAbsolute(args[0] as string)).toBe(true);
					expect(nodeFs.existsSync(args[0] as string)).toBe(true);
					const env = centrs["env"] as Record<string, string>;
					const bound = env["CENTRS_CDB_FILE"];
					expect(typeof bound).toBe("string");
					expect((bound as string).endsWith("device.cdb")).toBe(true);
					expect("CENTRS_CDB_PASSWORD" in env).toBe(false);
					const rosetta = cfg[ROSETTA_MCP_SERVER] as Record<string, unknown>;
					const rargs = rosetta["args"] as string[];
					expect(path.isAbsolute(rargs[0] as string)).toBe(true);
					expect(nodeFs.existsSync(rargs[0] as string)).toBe(true);
				} finally {
					await srv.stop();
				}
			});
		},
	);

	t105(
		"server with a missing rosetta entry reports and seeds only resolved tools",
		async () => {
			const pkg = mktmp("t105-srv-norosetta-");
			nodeFs.mkdirSync(
				path.join(pkg, "node_modules", "@tikoci", "centrs", "src"),
				{ recursive: true },
			);
			nodeFs.writeFileSync(
				path.join(pkg, "node_modules", "@tikoci", "centrs", "src", "cli.ts"),
				"// stub\n",
			);
			const bin = stubT50Bin();
			await withT50Env(bin.log, async () => {
				const srv = await startT50Srv(bin.bin, { packageRoot: pkg });
				try {
					const st = (await (
						await fetch(`${srv.url}api/status`)
					).json()) as Record<string, unknown>;
					const pre = st["preallow"] as Record<string, unknown>;
					const tools = pre["tools"] as string[];
					expect(tools).toContain("mcp__centrs__centrs_retrieve");
					expect(tools).toContain("mcp__routeros_muse__ui_notify");
					expect(tools.filter((t) => t.startsWith("mcp__rosetta__"))).toEqual(
						[],
					);
					const cfgHome = pre["configHome"] as string;
					const names = readToolNames(cfgHome);
					expect(names).toContain("mcp__centrs__centrs_retrieve");
					expect(names.filter((t) => t.startsWith("mcp__rosetta__"))).toEqual(
						[],
					);
				} finally {
					await srv.stop();
				}
			});
		},
	);

	t105(
		"sessionMcp-denied host still starts chat (no config, no crash)",
		async () => {
			const bin = stubT50Bin();
			const saved = process.env["FAKE_DENY_SESSION_MCP"];
			process.env["FAKE_DENY_SESSION_MCP"] = "1";
			try {
				await withT50Env(bin.log, async () => {
					const srv = await startT50Srv(bin.bin, {});
					try {
						const res = await fetch(`${srv.url}api/chat/send`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ text: "hello denied" }),
						});
						expect(((await res.json()) as Record<string, unknown>)["ok"]).toBe(
							true,
						);
						const log = nodeFs.readFileSync(bin.log, "utf8");
						expect(
							log.split("\n").filter((l) => l.startsWith("MCPCFG ")),
						).toEqual([]);
					} finally {
						await srv.stop();
					}
				});
			} finally {
				if (saved === undefined) delete process.env["FAKE_DENY_SESSION_MCP"];
				else process.env["FAKE_DENY_SESSION_MCP"] = saved;
			}
		},
	);
});
