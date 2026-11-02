// T101 (D42/D43) phase 2: explicit permission profile per session +
// server-side pre-seed wiring. Fail-first suite over the scriptable
// fake (tests/t50-fake.ts, extended with the captured profile
// shapes): session/start sends permissionProfile, the access route
// changes the live profile, status/stats/settings report it, and
// boot ensures the workspace's tagged rules with an off switch.
//
// Hermetic: every test sets XDG_CONFIG_HOME to a fresh mktmp dir
// (save/restore) AND passes configHome to the server — the real
// ~/.config/muse is never touched. The fake fronts PATH via
// toolBinDir; bypass-mode servers (no CDB, no centrs).
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { PREALLOW_TAG, policyFile, READ_COMMANDS } from "../src/lib/preallow";
import { mcpToolName, UI_TOOL_NAMES } from "../src/mcp/ui-tools";
import { profileForAccess, startServer } from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";
import { startT50Srv, stubT50Bin, withT50Env } from "./t50-fake";

afterAll(cleanupTmpdirs);

const t101 = process.platform !== "win32" ? test : test.skip;

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

/**
 * Fresh XDG_CONFIG_HOME for the body; restored after. Returns the dir.
 * Seeds a fake auth.json so the private-home ensure stays quiet (in
 * these tests the private home IS the process config home, so no
 * link is needed). Auth content is never asserted.
 */
async function withCfgHome<T>(fn: (cfg: string) => Promise<T>): Promise<T> {
	const cfg = mktmp("t101-cfg-");
	nodeFs.mkdirSync(path.join(cfg, "muse"), { recursive: true });
	nodeFs.writeFileSync(
		path.join(cfg, "muse", "auth.json"),
		'{"providers":{"meta":{"mechanism":"oauth"}}}\n',
	);
	const saved = process.env["XDG_CONFIG_HOME"];
	process.env["XDG_CONFIG_HOME"] = cfg;
	try {
		return await fn(cfg);
	} finally {
		if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
		else process.env["XDG_CONFIG_HOME"] = saved;
	}
}

/** Workspace with a router.toml carrying two hosts. */
function makeT101Workspace(): string {
	const dir = mktmp("t101-ws-");
	nodeFs.writeFileSync(path.join(dir, "workspace.toml"), "canonical = true\n");
	nodeFs.writeFileSync(
		path.join(dir, "router.toml"),
		'[[device]]\nid = "gw"\nhost = "192.168.88.1"\n[[device]]\nid = "ap"\nhost = "router.lan"\n',
	);
	return dir;
}

function fakeLog(bin: string): string {
	return nodeFs.readFileSync(path.join(bin, "msp.log"), "utf8");
}

describe("access-to-profile mapping", () => {
	test("allowAll maps to :unrestricted, everything else to :ask-me", () => {
		expect(profileForAccess("allowAll")).toBe(":unrestricted");
		expect(profileForAccess("promptUnmatched")).toBe(":ask-me");
		expect(profileForAccess("onRequest")).toBe(":ask-me");
		expect(profileForAccess("denyUnmatched")).toBe(":ask-me");
	});
});

describe("T101 Part A: explicit profile per session", () => {
	t101("default start sends :ask-me with experimental opt-in", async () => {
		await withCfgHome(async (cfg) => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, { configHome: cfg });
				try {
					await postJson(`${srv.url}api/chat/send`, { text: "hello" });
					const lines = fakeLog(bin);
					expect(lines).toContain("experimentalApi=true");
					expect(lines).toContain("permissionProfile=:ask-me");
					const stats = await getJson(`${srv.url}api/chat/stats`);
					expect(stats["profile"]).toBe(":ask-me");
				} finally {
					await srv.stop();
				}
			});
		});
	});

	t101("allowAll start sends :unrestricted", async () => {
		await withCfgHome(async (cfg) => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, {
					configHome: cfg,
					defaultApprovalMode: "allowAll",
				});
				try {
					await postJson(`${srv.url}api/chat/send`, { text: "hello" });
					expect(fakeLog(bin)).toContain("permissionProfile=:unrestricted");
					const stats = await getJson(`${srv.url}api/chat/stats`);
					expect(stats["profile"]).toBe(":unrestricted");
				} finally {
					await srv.stop();
				}
			});
		});
	});

	t101(
		"pre-session stats report the next-session profile, never null",
		async () => {
			await withCfgHome(async (cfg) => {
				const { bin, log } = stubT50Bin();
				await withT50Env(log, async () => {
					const srv = await startT50Srv(bin, { configHome: cfg });
					try {
						const stats = await getJson(`${srv.url}api/chat/stats`);
						expect(stats["profile"]).toBe(":ask-me");
					} finally {
						await srv.stop();
					}
				});
			});
		},
	);

	t101("access change applies the profile to the live session", async () => {
		await withCfgHome(async (cfg) => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, { configHome: cfg });
				try {
					await postJson(`${srv.url}api/chat/send`, { text: "hello" });
					const res = await postJson(`${srv.url}api/chat/access`, {
						mode: "allowAll",
					});
					expect(res.status).toBe(200);
					expect(res.json["mode"]).toBe("allowAll");
					expect(res.json["profile"]).toBe(":unrestricted");
					const lines = fakeLog(bin);
					expect(lines).toContain("MODE allowAll");
					expect(lines).toContain("PROFILE :unrestricted");
					const stats = await getJson(`${srv.url}api/chat/stats`);
					expect(stats["profile"]).toBe(":unrestricted");
					const status = await getJson(`${srv.url}api/status`);
					expect(status["permissionProfile"]).toBe(":unrestricted");
					// And back: promptUnmatched re-sandboxes the live session.
					const back = await postJson(`${srv.url}api/chat/access`, {
						mode: "promptUnmatched",
					});
					expect(back.json["profile"]).toBe(":ask-me");
					expect(fakeLog(bin)).toContain("PROFILE :ask-me");
				} finally {
					await srv.stop();
				}
			});
		});
	});

	t101(
		"round 2: server owns its private home, never the real one",
		async () => {
			const real = mktmp("t101-real-");
			nodeFs.mkdirSync(path.join(real, "muse"), { recursive: true });
			nodeFs.writeFileSync(
				path.join(real, "muse", "auth.json"),
				'{"providers":{"meta":{"mechanism":"oauth"}}}\n',
			);
			const saved = process.env["XDG_CONFIG_HOME"];
			process.env["XDG_CONFIG_HOME"] = real;
			try {
				const priv = mktmp("t101-priv-");
				const { bin, log } = stubT50Bin();
				await withT50Env(log, async () => {
					const srv = await startT50Srv(bin, { configHome: priv });
					try {
						await postJson(`${srv.url}api/chat/send`, { text: "hello" });
						await postJson(`${srv.url}api/chat/access`, { mode: "allowAll" });
						// Private home: our policy + our settings + the auth link.
						expect(nodeFs.readdirSync(path.join(priv, "muse")).sort()).toEqual([
							"approval-policy.json",
							"auth.json",
							"settings.json",
						]);
						expect(
							nodeFs
								.lstatSync(path.join(priv, "muse", "auth.json"))
								.isSymbolicLink(),
						).toBe(true);
						// Real home: the planted auth.json only, nothing added.
						expect(nodeFs.readdirSync(path.join(real, "muse")).sort()).toEqual([
							"auth.json",
						]);
					} finally {
						await srv.stop();
					}
				});
			} finally {
				if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
				else process.env["XDG_CONFIG_HOME"] = saved;
			}
		},
	);
});

describe("T101 Part B: server pre-seed wiring", () => {
	t101("boot seeds the shell set tagged for this workspace", async () => {
		await withCfgHome(async (cfg) => {
			const ws = makeT101Workspace();
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, { configHome: cfg, workspace: ws });
				try {
					const doc = JSON.parse(
						nodeFs.readFileSync(policyFile(cfg), "utf8"),
					) as { rules: Record<string, unknown>[] };
					const ours = doc.rules.filter((r) => r["reason"] === PREALLOW_TAG);
					for (const prefix of READ_COMMANDS) {
						expect(
							ours.some(
								(r) =>
									JSON.stringify(
										(r["rule"] as Record<string, unknown>)["argv_prefix"],
									) === JSON.stringify(prefix) &&
									(r["rule"] as Record<string, unknown>)["workspace_root"] ===
										ws,
							),
						).toBe(true);
					}
				} finally {
					await srv.stop();
				}
			});
		});
	});

	t101("boot seeds network rules for router.toml hosts", async () => {
		await withCfgHome(async (cfg) => {
			const ws = makeT101Workspace();
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, { configHome: cfg, workspace: ws });
				try {
					const doc = JSON.parse(
						nodeFs.readFileSync(policyFile(cfg), "utf8"),
					) as { rules: Record<string, unknown>[] };
					const nets = doc.rules.filter(
						(r) =>
							(r["rule"] as Record<string, unknown>)["kind"] === "network" &&
							r["reason"] === PREALLOW_TAG,
					);
					const hosts = nets.map(
						(r) => (r["rule"] as Record<string, unknown>)["host"],
					);
					expect(hosts).toContain("192.168.88.1");
					expect(hosts).toContain("router.lan");
				} finally {
					await srv.stop();
				}
			});
		});
	});

	t101("status reports the profile and the pre-seeded set", async () => {
		await withCfgHome(async (cfg) => {
			const ws = makeT101Workspace();
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, { configHome: cfg, workspace: ws });
				try {
					const status = await getJson(`${srv.url}api/status`);
					expect(status["permissionProfile"]).toBe(":ask-me");
					const pre = status["preallow"] as Record<string, unknown>;
					expect(pre["enabled"]).toBe(true);
					expect(pre["warnings"]).toEqual([]);
					expect(pre["commands"]).toEqual(
						READ_COMMANDS.map((p) => p.join(" ")),
					);
					expect(pre["hosts"]).toEqual(["192.168.88.1", "router.lan"]);
				} finally {
					await srv.stop();
				}
			});
		});
	});

	t101("settings toggle off removes our rules, on re-seeds them", async () => {
		await withCfgHome(async (cfg) => {
			const ws = makeT101Workspace();
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, { configHome: cfg, workspace: ws });
				try {
					const before = await getJson(`${srv.url}api/settings`);
					expect(before["preallowReads"]).toBe(true);
					const off = await postJson(`${srv.url}api/settings`, {
						preallowReads: false,
					});
					expect(off.status).toBe(200);
					expect(off.json["preallowReads"]).toBe(false);
					const doc = JSON.parse(
						nodeFs.readFileSync(policyFile(cfg), "utf8"),
					) as { rules: Record<string, unknown>[] };
					expect(
						doc.rules.filter((r) => r["reason"] === PREALLOW_TAG),
					).toHaveLength(0);
					const status = await getJson(`${srv.url}api/status`);
					expect(
						(status["preallow"] as Record<string, unknown>)["enabled"],
					).toBe(false);
					const on = await postJson(`${srv.url}api/settings`, {
						preallowReads: true,
					});
					expect(on.json["preallowReads"]).toBe(true);
					const reseeded = JSON.parse(
						nodeFs.readFileSync(policyFile(cfg), "utf8"),
					) as { rules: Record<string, unknown>[] };
					expect(
						reseeded.rules.filter((r) => r["reason"] === PREALLOW_TAG).length,
					).toBeGreaterThan(0);
				} finally {
					await srv.stop();
				}
			});
		});
	});

	t101("no-workspace mode seeds only the tool set", async () => {
		await withCfgHome(async (cfg) => {
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startServer({
					dataHome: mktmp("t101-dh-"),
					allowOpenCdb: true,
					noWorkspace: true,
					provider: "echo",
					museHome: mktmp("t101-home-"),
					toolBinDir: bin,
					configHome: cfg,
				});
				try {
					const status = await getJson(`${srv.url}api/status`);
					expect(status["preallow"]).toBeNull();
					// T55: the ui tool set seeds; the report stays null.
					const rules = (
						JSON.parse(nodeFs.readFileSync(policyFile(cfg), "utf8")) as {
							rules: Record<string, unknown>[];
						}
					).rules;
					expect(rules).toHaveLength(UI_TOOL_NAMES.length);
					expect(
						rules
							.map(
								(r) =>
									(r["rule"] as Record<string, unknown>)["tool_name"] as string,
							)
							.sort(),
					).toEqual([...UI_TOOL_NAMES].map(mcpToolName).sort());
				} finally {
					await srv.stop();
				}
			});
		});
	});

	t101(
		"unknown policy schema: boot succeeds, status warns, file untouched",
		async () => {
			await withCfgHome(async (cfg) => {
				const ws = makeT101Workspace();
				nodeFs.mkdirSync(path.dirname(policyFile(cfg)), { recursive: true });
				const before = JSON.stringify({ schema_version: 9, rules: [] });
				nodeFs.writeFileSync(policyFile(cfg), before);
				const { bin, log } = stubT50Bin();
				await withT50Env(log, async () => {
					const srv = await startT50Srv(bin, {
						configHome: cfg,
						workspace: ws,
					});
					try {
						const status = await getJson(`${srv.url}api/status`);
						const pre = status["preallow"] as Record<string, unknown>;
						expect((pre["warnings"] as string[]).join(" ")).toMatch(/schema/i);
						expect(nodeFs.readFileSync(policyFile(cfg), "utf8")).toBe(before);
					} finally {
						await srv.stop();
					}
				});
			});
		},
	);

	t101(
		"symlinked policy file: boot succeeds, status warns, victim untouched",
		async () => {
			await withCfgHome(async (cfg) => {
				const ws = makeT101Workspace();
				const victim = path.join(cfg, "victim.txt");
				nodeFs.writeFileSync(victim, "victim-bytes\n");
				nodeFs.mkdirSync(path.dirname(policyFile(cfg)), { recursive: true });
				nodeFs.symlinkSync(victim, policyFile(cfg));
				const { bin, log } = stubT50Bin();
				await withT50Env(log, async () => {
					const srv = await startT50Srv(bin, {
						configHome: cfg,
						workspace: ws,
					});
					try {
						const status = await getJson(`${srv.url}api/status`);
						const pre = status["preallow"] as Record<string, unknown>;
						expect((pre["warnings"] as string[]).join(" ")).toMatch(/symlink/i);
						expect(nodeFs.readFileSync(victim, "utf8")).toBe("victim-bytes\n");
					} finally {
						await srv.stop();
					}
				});
			});
		},
	);
});
