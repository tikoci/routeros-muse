// T105/T112: the session's MCP servers (rosetta) in the session
// config — fail-first suite.
//
// T105 shipped centrs + rosetta stdio servers next to
// routeros_muse; T112 dropped the centrs server — agents use the
// richer centrs CLI this phase, and centrs-as-MCP returns after
// GitHub once the T111 password channel exists. rosetta stays
// exactly as it is: launched via process.execPath (bun) with an
// ABSOLUTE bundle entry path. A bundle entry missing on disk omits
// only that server (honest degradation, worker still starts). No
// centrs_* tool_action rule is seeded any more; stale tagged
// centrs_* rules from T105-era workspaces are pruned on reseed.
// The read-only rosetta tools seed tagged tool_action allow rules
// under the same preallow toggle; the mixed/write tools are never
// seeded. sessionMcp-denied hosts still get chat without the config
// (existing MspClient.uiTools gate).
//
// Hermetic: unit tests over the builder + seed set, plus fake-backed
// server spawns (MCPCFG log seam, like t55). The real `muse` binary is
// never run here; live approval behavior is captured separately.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { ensurePreallowReads, policyFile } from "../src/lib/preallow";
import {
	ROSETTA_MCP_SERVER,
	ROSETTA_TOOL_NAMES,
	SEED_TOOL_NAMES,
	sessionMcpServers,
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

describe("server identity", () => {
	test("config key is rosetta; there is no centrs server", () => {
		expect(ROSETTA_MCP_SERVER).toBe("rosetta");
	});

	test("namespaced names match the mcp__<server>__<tool> wire shape", () => {
		expect(trilogyToolName("rosetta", "routeros_search")).toBe(
			"mcp__rosetta__routeros_search",
		);
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
	test("real bundle yields ui + rosetta with absolute entry paths, no centrs", () => {
		const { servers: cfg, missed } = sessionMcpServers({
			bridge: "/pkg/src/mcp/ui-bridge.ts",
			bun: "/bin/bun",
			url: "http://127.0.0.1:9999/",
			token: "tok",
		});
		expect(missed).toEqual([]);
		expect(Object.keys(cfg).sort()).toEqual(
			[UI_MCP_SERVER, ROSETTA_MCP_SERVER].sort(),
		);
		expect("centrs" in cfg).toBe(false);
		const ui = cfg[UI_MCP_SERVER];
		const want = uiMcpServers({
			bridge: "/pkg/src/mcp/ui-bridge.ts",
			bun: "/bin/bun",
			url: "http://127.0.0.1:9999/",
			token: "tok",
		})[UI_MCP_SERVER] as McpServerConfig;
		expect(ui).toEqual(want);
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

	test("the config never carries a CDB password", () => {
		const { servers: cfg, missed } = sessionMcpServers({
			bridge: "/pkg/src/mcp/ui-bridge.ts",
			bun: "/bin/bun",
			url: "http://127.0.0.1:9999/",
			token: "tok",
		});
		expect(missed).toEqual([]);
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
			pkgRoot: pkg,
		});
		// T112: a centrs bundle entry never becomes a server — the
		// stub above is ignored, only rosetta is missed.
		expect(missed).toEqual([ROSETTA_MCP_SERVER]);
		expect(Object.keys(cfg)).toEqual([UI_MCP_SERVER]);
	});

	test("missing package root omits rosetta, ui remains", () => {
		const { servers: cfg, missed } = sessionMcpServers({
			bridge: "/pkg/src/mcp/ui-bridge.ts",
			bun: "/bin/bun",
			url: "http://127.0.0.1:9999/",
			token: "tok",
			pkgRoot: mktmp("t105-pkg-empty-"),
		});
		expect(missed).toEqual([ROSETTA_MCP_SERVER]);
		expect(Object.keys(cfg)).toEqual([UI_MCP_SERVER]);
	});
});

describe("seed set", () => {
	test("seed set is exactly the ui + read-only rosetta tools, namespaced", () => {
		// Independent hardcoded pin of the full seed list (review
		// fix): routeros_current_versions is NOT seeded — its handler
		// fetches MikroTik's upgrade server per call, so it is not a
		// local read. T112: no centrs_* tool is seeded at all.
		expect([...SEED_TOOL_NAMES].sort()).toEqual(
			[
				"mcp__routeros_muse__ui_add_device",
				"mcp__routeros_muse__ui_notify",
				"mcp__routeros_muse__ui_open",
				"mcp__routeros_muse__ui_select_device",
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
		expect(SEED_TOOL_NAMES).not.toContain(
			"mcp__rosetta__routeros_current_versions",
		);
		// No centrs tool is seeded — not the read-only three, not
		// the mixed/write tools (permissions.md P7: tool_action
		// rules cannot scope per-op).
		for (const banned of [
			"mcp__centrs__centrs_explain",
			"mcp__centrs__centrs_validate",
			"mcp__centrs__centrs_retrieve",
			"mcp__centrs__centrs_execute",
			"mcp__centrs__centrs_devices",
			"mcp__centrs__centrs_discover",
		]) {
			expect(SEED_TOOL_NAMES).not.toContain(banned);
		}
	});

	test("enabled seeds the ui + rosetta tool rules and no centrs rule", () => {
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
		expect(names).toContain("mcp__rosetta__routeros_search");
		expect(names.filter((n) => n.startsWith("mcp__centrs__"))).toEqual([]);
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

	test("stale T105 centrs rules are pruned on reseed (no migration)", () => {
		// A T105-era workspace already carries tagged centrs_*
		// rules. Seeding owns every tagged tool_action rule (D45:
		// never kept, desired re-adds exactly the current set), so
		// the reseed drops them — no migration step needed.
		const cfg = mktmp("t105-stale-");
		const ws = mktmp("t105-stale-ws-");
		nodeFs.mkdirSync(path.join(cfg, "muse"), { recursive: true });
		nodeFs.writeFileSync(
			policyFile(cfg),
			`${JSON.stringify(
				{
					schema_version: 2,
					rules: [
						{
							effect: "allow",
							durability: "local_persistent",
							rule: {
								kind: "tool_action",
								tool_name: "mcp__centrs__centrs_retrieve",
							},
							reason: "routeros-muse:seed",
						},
						{
							effect: "allow",
							durability: "local_persistent",
							rule: {
								kind: "tool_action",
								tool_name: "mcp__centrs__centrs_execute",
							},
							reason: "routeros-muse:seed",
						},
					],
				},
				null,
				2,
			)}\n`,
		);
		ensurePreallowReads({
			configHome: cfg,
			workspaceRoot: ws,
			hosts: [],
			enabled: true,
		});
		const names = readToolNames(cfg);
		expect(names.filter((n) => n.startsWith("mcp__centrs__"))).toEqual([]);
		expect(names).toContain("mcp__rosetta__routeros_search");
	});

	test("disabled prunes the rosetta rules with the rest", () => {
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
		expect(readToolNames(cfg)).toEqual([]);
	});
});

describe("bundle drift guard", () => {
	test("rosetta seed constants still match the installed bundle's tools", () => {
		// Parse the INSTALLED bundle's registerTool calls: a renamed
		// tool must fail here, not rot silently (spark critic P2).
		const root = path.resolve(import.meta.dir, "..");
		const rosettaSrc = nodeFs.readFileSync(
			path.join(root, "node_modules/@tikoci/rosetta/src/mcp.ts"),
			"utf8",
		);
		const rosettaReg = new Set(
			[...rosettaSrc.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map(
				(m) => m[1] as string,
			),
		);
		expect([...rosettaReg].sort()).toEqual([...ROSETTA_TOOL_NAMES].sort());
		for (const t of ROSETTA_TOOL_NAMES) {
			const seeded = SEED_TOOL_NAMES.includes(`mcp__rosetta__${t}`);
			expect(seeded).toBe(t !== "routeros_current_versions");
		}
	});
});

describe("worker spawn carries rosetta", () => {
	t105(
		"MCPCFG log holds ui + rosetta with absolute bundle paths, no centrs",
		async () => {
			const bin = stubT50Bin();
			await withT50Env(bin.log, async () => {
				const srv = await startT50Srv(bin.bin, {
					mcpToken: "t105-fixed-token",
				});
				try {
					const res = await fetch(`${srv.url}api/chat/send`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							origin: new URL(srv.url).origin,
						},
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
						[UI_MCP_SERVER, ROSETTA_MCP_SERVER].sort(),
					);
					expect("centrs" in cfg).toBe(false);
					expect(JSON.stringify(cfg)).not.toContain("CENTRS_CDB_PASSWORD");
					const rosetta = cfg[ROSETTA_MCP_SERVER] as Record<string, unknown>;
					expect(rosetta["transport"]).toBe("stdio");
					expect(rosetta["command"]).toBe(process.execPath);
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
					expect(tools).toContain("mcp__routeros_muse__ui_notify");
					expect(tools.filter((t) => t.startsWith("mcp__rosetta__"))).toEqual(
						[],
					);
					expect(tools.filter((t) => t.startsWith("mcp__centrs__"))).toEqual(
						[],
					);
					const cfgHome = pre["configHome"] as string;
					const names = readToolNames(cfgHome);
					expect(names).toContain("mcp__routeros_muse__ui_notify");
					expect(names.filter((t) => t.startsWith("mcp__rosetta__"))).toEqual(
						[],
					);
					expect(names.filter((t) => t.startsWith("mcp__centrs__"))).toEqual(
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
							headers: {
								"content-type": "application/json",
								origin: new URL(srv.url).origin,
							},
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
