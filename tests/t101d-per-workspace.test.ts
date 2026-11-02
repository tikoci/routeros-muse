// T101 round 4 (D45): one private muse config home per workspace —
// fail-first suite.
//
// <dataHome>/routeros-muse/.muse-config/<workspace-id>/ holds its own
// approval-policy.json, settings.json, auth.json link and tikoci link.
// No-workspace mode gets the fixed _no-workspace home. The
// cross-process seed lock and the registry host union are gone: each
// workspace seeds only its own router.toml hosts. Two servers on the
// same workspace get a warning only (pid file, never load-bearing).
//
// Hermetic: mktmp dirs, stub/fake muse, explicit homes — the real
// ~/.config is never touched.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as preallow from "../src/lib/preallow";
import {
	checkServerPid,
	configHomeDir,
	ensurePreallowReads,
	ensurePrivateHome,
	museAuthFile,
	NO_WORKSPACE_ID,
	POLICY_SCHEMA_VERSION,
	PREALLOW_TAG,
	policyFile,
	privateConfigHome,
	privateConfigRoot,
	workspaceConfigId,
	workspaceHosts,
} from "../src/lib/preallow";
import { dataHomeDir } from "../src/lib/registry";
import { museAuthFile as agentMuseAuthFile } from "../src/steps/agent";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";
import { startT50Srv, stubT50Bin, withT50Env } from "./t50-fake";

afterAll(cleanupTmpdirs);

const t101d = process.platform !== "win32" ? test : test.skip;

function withRealHome<T>(fn: (real: string) => T): T {
	const real = mktmp("t101d-real-");
	const saved = process.env["XDG_CONFIG_HOME"];
	process.env["XDG_CONFIG_HOME"] = real;
	try {
		return fn(real);
	} finally {
		if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
		else process.env["XDG_CONFIG_HOME"] = saved;
	}
}

function seedFakeAuth(real: string): string {
	const file = path.join(real, "muse", "auth.json");
	nodeFs.mkdirSync(path.dirname(file), { recursive: true });
	nodeFs.writeFileSync(file, '{"providers":{"meta":{"mechanism":"oauth"}}}\n');
	return file;
}

function makeWs(hosts: string[]): string {
	const dir = mktmp("t101d-ws-");
	nodeFs.writeFileSync(path.join(dir, "workspace.toml"), "canonical = true\n");
	nodeFs.writeFileSync(
		path.join(dir, "router.toml"),
		hosts.map((h, i) => `[[device]]\nid = "d${i}"\nhost = "${h}"\n`).join(""),
	);
	return dir;
}

function readPolicy(priv: string): {
	schema_version: unknown;
	rules: Record<string, unknown>[];
} {
	return JSON.parse(nodeFs.readFileSync(policyFile(priv), "utf8")) as {
		schema_version: unknown;
		rules: Record<string, unknown>[];
	};
}

function taggedHosts(priv: string): unknown[] {
	return readPolicy(priv)
		.rules.filter(
			(r) =>
				r["reason"] === PREALLOW_TAG &&
				(r["rule"] as Record<string, unknown>)["kind"] === "network",
		)
		.map((r) => (r["rule"] as Record<string, unknown>)["host"]);
}

async function getJson(url: string): Promise<Record<string, unknown>> {
	const res = await fetch(url);
	return (await res.json()) as Record<string, unknown>;
}

describe("per-workspace layout and id", () => {
	test("root nests under the data home with a leading dot", () => {
		const dh = mktmp("t101d-root-");
		expect(privateConfigRoot(dh)).toBe(
			path.join(dh, "routeros-muse", ".muse-config"),
		);
		expect(
			privateConfigHome(dh, mktmp("t101d-root-ws-")).startsWith(
				`${privateConfigRoot(dh)}${path.sep}`,
			),
		).toBe(true);
	});

	test("id is <sanitized-basename>-<hash12> and stable", () => {
		const base = mktmp("t101d-id-");
		const ws = path.join(base, "shop");
		nodeFs.mkdirSync(ws);
		const id = workspaceConfigId(ws);
		expect(id).toMatch(/^shop-[0-9a-f]{12}$/);
		// Stable across spellings of the same root.
		expect(workspaceConfigId(`${ws}/`)).toBe(id);
		expect(workspaceConfigId(ws)).toBe(id);
	});

	test("a moved workspace gets a new home (documented, seeding recreates)", () => {
		const base = mktmp("t101d-move-");
		const a = path.join(base, "a");
		const b = path.join(base, "b");
		nodeFs.mkdirSync(a);
		nodeFs.mkdirSync(b);
		expect(workspaceConfigId(a)).not.toBe(workspaceConfigId(b));
	});

	test("two workspaces get separate homes under one data home", () => {
		const dh = mktmp("t101d-two-");
		const a = makeWs(["a.lan"]);
		const b = makeWs(["b.lan"]);
		const ha = privateConfigHome(dh, a);
		const hb = privateConfigHome(dh, b);
		expect(ha).not.toBe(hb);
		expect(path.dirname(ha)).toBe(privateConfigRoot(dh));
		expect(path.dirname(hb)).toBe(privateConfigRoot(dh));
	});

	test("no-workspace mode gets the fixed _no-workspace home", () => {
		const dh = mktmp("t101d-nows-");
		expect(NO_WORKSPACE_ID).toBe("_no-workspace");
		expect(privateConfigHome(dh)).toBe(
			path.join(privateConfigRoot(dh), "_no-workspace"),
		);
		expect(privateConfigHome(dh, undefined)).toBe(privateConfigHome(dh));
	});
});

describe("each workspace seeds only its own hosts", () => {
	t101d("workspaceHosts reads this root's router.toml only", () => {
		const a = makeWs(["a.lan", "shared.lan"]);
		expect(workspaceHosts(a).sort()).toEqual(["a.lan", "shared.lan"]);
		const gone = path.join(mktmp("t101d-gone-"), "nope");
		expect(workspaceHosts(gone)).toEqual([]);
		const bad = mktmp("t101d-bad-");
		nodeFs.writeFileSync(path.join(bad, "router.toml"), "{not toml");
		expect(workspaceHosts(bad)).toEqual([]);
	});

	t101d("two servers on one data home seed disjoint policies", async () => {
		const real = mktmp("t101d-disj-real-");
		seedFakeAuth(real);
		const saved = process.env["XDG_CONFIG_HOME"];
		process.env["XDG_CONFIG_HOME"] = real;
		try {
			const dh = mktmp("t101d-disj-dh-");
			const a = makeWs(["a.lan"]);
			const b = makeWs(["b.lan"]);
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const ha = privateConfigHome(dh, a);
				const hb = privateConfigHome(dh, b);
				const s1 = await startT50Srv(bin, { dataHome: dh, workspace: a });
				await s1.stop();
				const s2 = await startT50Srv(bin, { dataHome: dh, workspace: b });
				try {
					// Each policy holds exactly its own host — no union.
					expect(taggedHosts(ha)).toEqual(["a.lan"]);
					expect(taggedHosts(hb)).toEqual(["b.lan"]);
					const status = await getJson(`${s2.url}api/status`);
					const pre = status["preallow"] as Record<string, unknown>;
					expect(pre["configHome"]).toBe(hb);
					expect(pre["hosts"]).toEqual(["b.lan"]);
				} finally {
					await s2.stop();
				}
			});
		} finally {
			if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
			else process.env["XDG_CONFIG_HOME"] = saved;
		}
	});

	t101d(
		"router.toml change re-seeds: dropped host pruned, owner rule kept",
		() => {
			withRealHome(() => {
				const priv = mktmp("t101d-prune-");
				const ws = makeWs(["old.lan"]);
				const owner = {
					effect: "allow",
					durability: "local_persistent",
					rule: { kind: "network", host: "owner-choice", port: 443 },
					reason: null,
				};
				nodeFs.mkdirSync(path.dirname(policyFile(priv)), { recursive: true });
				nodeFs.writeFileSync(
					policyFile(priv),
					JSON.stringify({ schema_version: 2, rules: [owner] }),
				);
				ensurePreallowReads({
					configHome: priv,
					workspaceRoot: ws,
					hosts: workspaceHosts(ws),
					enabled: true,
				});
				expect(taggedHosts(priv)).toEqual(["old.lan"]);
				nodeFs.writeFileSync(
					path.join(ws, "router.toml"),
					'[[device]]\nid = "d0"\nhost = "new.lan"\n',
				);
				ensurePreallowReads({
					configHome: priv,
					workspaceRoot: ws,
					hosts: workspaceHosts(ws),
					enabled: true,
				});
				expect(taggedHosts(priv)).toEqual(["new.lan"]);
				// The owner's own untagged Always-allow choice is never touched.
				expect(readPolicy(priv).rules).toContainEqual(owner);
			});
		},
	);
});

describe("the cross-process lock is gone", () => {
	test("no SEED_LOCK_* exports remain", () => {
		expect("SEED_LOCK_TIMEOUT_MS" in preallow).toBe(false);
		expect("SEED_LOCK_STALE_MS" in preallow).toBe(false);
		expect("unionWorkspaceHosts" in preallow).toBe(false);
	});

	t101d("seeding creates no .lock files", () => {
		withRealHome(() => {
			const priv = mktmp("t101d-nolock-");
			const ws = mktmp("t101d-nolock-ws-");
			ensurePreallowReads({
				configHome: priv,
				workspaceRoot: ws,
				hosts: ["h1"],
				enabled: true,
			});
			const files = nodeFs.readdirSync(path.join(priv, "muse"));
			expect(files).toEqual(["approval-policy.json"]);
			expect(nodeFs.existsSync(`${policyFile(priv)}.lock`)).toBe(false);
		});
	});

	t101d("a server boot leaves no .lock file in its home", async () => {
		const real = mktmp("t101d-nolockb-real-");
		seedFakeAuth(real);
		const saved = process.env["XDG_CONFIG_HOME"];
		process.env["XDG_CONFIG_HOME"] = real;
		try {
			const ws = makeWs(["10.9.9.9"]);
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, { workspace: ws });
				try {
					const priv = privateConfigHome(srv.dataHome, ws);
					const files = nodeFs.readdirSync(path.join(priv, "muse"));
					expect(files.filter((f) => f.endsWith(".lock"))).toEqual([]);
				} finally {
					await srv.stop();
				}
			});
		} finally {
			if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
			else process.env["XDG_CONFIG_HOME"] = saved;
		}
	});
});

describe("same-workspace warning (pid file, warn only)", () => {
	t101d("a live foreign pid warns; our pid is recorded", () => {
		const priv = mktmp("t101d-pid-");
		const sleeper = Bun.spawn(["sleep", "30"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			nodeFs.writeFileSync(path.join(priv, "server.pid"), `${sleeper.pid}\n`);
			const { warning } = checkServerPid(priv);
			expect(warning ?? "").toMatch(
				new RegExp(`another server.*pid ${sleeper.pid}`),
			);
			expect(warning ?? "").toContain(priv);
			// Recording our pid does not clear the evidence: the
			// warning fired before the overwrite.
			expect(nodeFs.readFileSync(path.join(priv, "server.pid"), "utf8")).toBe(
				`${process.pid}\n`,
			);
		} finally {
			sleeper.kill();
		}
	});

	t101d("a stale pid file is silently ignored and replaced", () => {
		const priv = mktmp("t101d-stale-");
		const deadPid = 2 ** 30 + (process.pid % 1000);
		try {
			process.kill(deadPid, 0);
			return; // Absurdly unlikely; never fail the suite on it.
		} catch {
			// Expected: the pid is dead.
		}
		nodeFs.writeFileSync(path.join(priv, "server.pid"), `${deadPid}\n`);
		expect(checkServerPid(priv).warning).toBeNull();
		expect(nodeFs.readFileSync(path.join(priv, "server.pid"), "utf8")).toBe(
			`${process.pid}\n`,
		);
	});

	t101d("unparseable pid content warns nothing, own pid recorded", () => {
		const priv = mktmp("t101d-unparse-");
		nodeFs.writeFileSync(path.join(priv, "server.pid"), "not-a-pid\n");
		expect(checkServerPid(priv).warning).toBeNull();
		expect(nodeFs.readFileSync(path.join(priv, "server.pid"), "utf8")).toBe(
			`${process.pid}\n`,
		);
	});

	t101d("a symlinked pid file is never followed, never replaced", () => {
		const base = mktmp("t101d-pidlink-");
		const priv = path.join(base, "priv");
		nodeFs.mkdirSync(priv, { recursive: true });
		const victim = path.join(base, "victim.txt");
		nodeFs.writeFileSync(victim, "victim-bytes\n");
		nodeFs.symlinkSync(victim, path.join(priv, "server.pid"));
		expect(checkServerPid(priv).warning).toBeNull();
		expect(nodeFs.readFileSync(victim, "utf8")).toBe("victim-bytes\n");
		expect(
			nodeFs.lstatSync(path.join(priv, "server.pid")).isSymbolicLink(),
		).toBe(true);
	});

	t101d(
		"a foreign live pid at boot surfaces the warning in status",
		async () => {
			const real = mktmp("t101d-two-real-");
			seedFakeAuth(real);
			const saved = process.env["XDG_CONFIG_HOME"];
			process.env["XDG_CONFIG_HOME"] = real;
			// A stand-in for the other server process (in-process test
			// servers share our pid, so a sleeper plays the foreign one).
			const sleeper = Bun.spawn(["sleep", "30"], {
				stdout: "ignore",
				stderr: "ignore",
			});
			try {
				const dh = mktmp("t101d-two-dh-");
				const ws = makeWs(["10.8.8.8"]);
				const priv = privateConfigHome(dh, ws);
				nodeFs.mkdirSync(priv, { recursive: true });
				nodeFs.writeFileSync(path.join(priv, "server.pid"), `${sleeper.pid}\n`);
				const { bin, log } = stubT50Bin();
				await withT50Env(log, async () => {
					const srv = await startT50Srv(bin, { dataHome: dh, workspace: ws });
					try {
						const status = await getJson(`${srv.url}api/status`);
						const pre = status["preallow"] as Record<string, unknown>;
						const warnings = (pre["warnings"] as string[]).join("\n");
						expect(warnings).toMatch(/another server.*pid/);
						// Warn only: the server still seeds and serves.
						expect(pre["hosts"]).toEqual(["10.8.8.8"]);
					} finally {
						await srv.stop();
					}
				});
			} finally {
				sleeper.kill();
				if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
				else process.env["XDG_CONFIG_HOME"] = saved;
			}
		},
	);
});

describe("chain checks (D45 layout)", () => {
	t101d("private home refuses a symlinked .muse-config", () => {
		const base = mktmp("t101d-dotmc-");
		const target = path.join(base, "real-target");
		nodeFs.mkdirSync(target, { recursive: true });
		const dh = path.join(base, "dh");
		nodeFs.mkdirSync(path.join(dh, "routeros-muse"), { recursive: true });
		nodeFs.symlinkSync(target, path.join(dh, "routeros-muse", ".muse-config"));
		const ws = mktmp("t101d-dotmc-ws-");
		expect(() =>
			ensurePrivateHome({
				privateHome: privateConfigHome(dh, ws),
				dataHome: dataHomeDir(dh),
			}),
		).toThrow(/symlink/i);
		expect(nodeFs.readdirSync(target)).toEqual([]);
	});

	t101d("private home refuses a symlinked <workspace-id> dir", () => {
		const base = mktmp("t101d-wsid-");
		const target = path.join(base, "real-target");
		nodeFs.mkdirSync(target, { recursive: true });
		const dh = path.join(base, "dh");
		const ws = mktmp("t101d-wsid-ws-");
		const priv = privateConfigHome(dh, ws);
		nodeFs.mkdirSync(path.dirname(priv), { recursive: true });
		nodeFs.symlinkSync(target, priv);
		expect(() =>
			ensurePrivateHome({
				privateHome: priv,
				dataHome: dataHomeDir(dh),
			}),
		).toThrow(/symlink/i);
		expect(nodeFs.readdirSync(target)).toEqual([]);
	});

	t101d("symlinks above <dataHome>/routeros-muse are still allowed", () => {
		const base = mktmp("t101d-above-");
		nodeFs.mkdirSync(path.join(base, "real", "dh"), { recursive: true });
		nodeFs.symlinkSync(path.join(base, "real"), path.join(base, "link"));
		const dh = path.join(base, "link", "dh");
		const ws = mktmp("t101d-above-ws-");
		const emptyReal = mktmp("t101d-above-real-");
		const res = ensurePrivateHome({
			privateHome: privateConfigHome(dh, ws),
			dataHome: dataHomeDir(dh),
			realConfigHome: emptyReal,
		});
		expect(res.warnings.join(" ")).toMatch(/not signed in/i);
		expect(
			nodeFs.existsSync(
				path.join(privateConfigHome(dh, ws), "muse", "settings.json"),
			),
		).toBe(true);
	});
});

describe("fail closed on an unsafe per-workspace home", () => {
	t101d(
		"symlinked .muse-config: boot seeds nothing, status carries the error, session start fails",
		async () => {
			const real = mktmp("t101d-unsafe-real-");
			nodeFs.mkdirSync(path.join(real, "muse"), { recursive: true });
			nodeFs.writeFileSync(
				path.join(real, "muse", "auth.json"),
				'{"fake":true}\n',
			);
			const saved = process.env["XDG_CONFIG_HOME"];
			process.env["XDG_CONFIG_HOME"] = real;
			try {
				const dh = mktmp("t101d-unsafe-dh-");
				nodeFs.mkdirSync(path.join(dh, "routeros-muse"), {
					recursive: true,
				});
				const fake = mktmp("t101d-unsafe-fake-");
				nodeFs.symlinkSync(
					fake,
					path.join(dh, "routeros-muse", ".muse-config"),
				);
				const ws = mktmp("t101d-unsafe-ws-");
				nodeFs.writeFileSync(
					path.join(ws, "workspace.toml"),
					"canonical = true\n",
				);
				const { bin, log } = stubT50Bin();
				await withT50Env(log, async () => {
					const srv = await startT50Srv(bin, { dataHome: dh, workspace: ws });
					try {
						// The boot wrote nothing through the link.
						expect(
							nodeFs.existsSync(
								path.join(fake, "muse", "approval-policy.json"),
							),
						).toBe(false);
						expect(nodeFs.readdirSync(fake)).toEqual([]);
						const status = await getJson(`${srv.url}api/status`);
						const pre = status["preallow"] as Record<string, unknown>;
						expect(String(pre["homeError"] ?? "")).toMatch(/symlink/i);
						const res = await fetch(`${srv.url}api/chat/send`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ text: "hello" }),
						});
						expect(res.status).toBe(500);
						const body = (await res.json()) as Record<string, unknown>;
						expect(String(body["why"] ?? "")).toMatch(/symlink/i);
						const argvLog = path.join(bin, "argv.log");
						const argv = nodeFs.existsSync(argvLog)
							? nodeFs.readFileSync(argvLog, "utf8")
							: "";
						expect(argv).not.toMatch(/^serve /m);
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

describe("spawn isolation on every path", () => {
	t101d(
		"worker, boot probe and oauth-recheck all run under this workspace's home",
		async () => {
			const real = mktmp("t101d-iso-real-");
			nodeFs.mkdirSync(path.join(real, "muse"), { recursive: true });
			nodeFs.writeFileSync(
				path.join(real, "muse", "auth.json"),
				'{"fake":true}\n',
			);
			const saved = process.env["XDG_CONFIG_HOME"];
			process.env["XDG_CONFIG_HOME"] = real;
			try {
				const ws = makeWs([]);
				const { bin, log } = stubT50Bin();
				await withT50Env(log, async () => {
					// provider meta runs the boot auth probe (a
					// disposable spawn); the send below spawns the
					// worker; the recheck runs a second probe. The
					// fake records the XDG_CONFIG_HOME each received.
					const srv = await startT50Srv(bin, {
						provider: "meta",
						workspace: ws,
					});
					try {
						const priv = privateConfigHome(srv.dataHome, ws);
						const recheck = await fetch(`${srv.url}api/auth/oauth-recheck`, {
							method: "POST",
						});
						expect(recheck.status).toBe(200);
						const send = await fetch(`${srv.url}api/chat/send`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ text: "hello" }),
						});
						expect(send.status).toBe(200);
						const deadline = Date.now() + 20_000;
						let lines: string[] = [];
						for (;;) {
							const logged = nodeFs.existsSync(log)
								? nodeFs.readFileSync(log, "utf8")
								: "";
							lines = logged
								.split("\n")
								.filter((l) => l.startsWith("CONFIG_HOME "));
							if (lines.length >= 3 || Date.now() > deadline) break;
							await Bun.sleep(100);
						}
						expect(lines.length).toBeGreaterThanOrEqual(3);
						for (const line of lines) {
							expect(line).toBe(`CONFIG_HOME ${priv}`);
						}
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

describe("muse auth path helper", () => {
	test("honors XDG_CONFIG_HOME, else ~/.config", () => {
		const tmp = mktmp("t101d-auth-");
		const saved = process.env["XDG_CONFIG_HOME"];
		process.env["XDG_CONFIG_HOME"] = tmp;
		try {
			expect(museAuthFile()).toBe(path.join(tmp, "muse", "auth.json"));
		} finally {
			if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
			else process.env["XDG_CONFIG_HOME"] = saved;
		}
		delete process.env["XDG_CONFIG_HOME"];
		try {
			expect(museAuthFile()).toBe(
				path.join(os.homedir(), ".config", "muse", "auth.json"),
			);
		} finally {
			if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
			else process.env["XDG_CONFIG_HOME"] = saved;
		}
	});

	test("explicit home beats the process env", () => {
		withRealHome(() => {
			const other = mktmp("t101d-authexpl-");
			expect(museAuthFile(other)).toBe(path.join(other, "muse", "auth.json"));
		});
	});

	test("the agent check resolves the same file", () => {
		withRealHome((real) => {
			expect(agentMuseAuthFile()).toBe(museAuthFile());
			expect(agentMuseAuthFile()).toBe(path.join(real, "muse", "auth.json"));
		});
	});

	t101d("ensurePrivateHome links the XDG-resolved auth", () => {
		withRealHome((real) => {
			const realAuth = seedFakeAuth(real);
			expect(realAuth).toBe(museAuthFile());
			const priv = mktmp("t101d-authlink-");
			ensurePrivateHome({ privateHome: priv });
			expect(nodeFs.readlinkSync(path.join(priv, "muse", "auth.json"))).toBe(
				realAuth,
			);
		});
	});
});

describe("schema constants", () => {
	test("policy schema is still v2", () => {
		expect(POLICY_SCHEMA_VERSION).toBe(2);
	});
});

describe("round-4 review fixes", () => {
	t101d("a FIFO at server.pid neither blocks nor is written into", () => {
		const home = mktmp("t101d-fifo-");
		const pidFile = path.join(home, "server.pid");
		expect(Bun.spawnSync(["mkfifo", pidFile]).exitCode).toBe(0);
		// Run in a child so a regression (blocking open/write) fails
		// by timeout instead of hanging the suite.
		const r = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`const p = require(${JSON.stringify(path.resolve("src/lib/preallow.ts"))}); console.log(JSON.stringify(p.checkServerPid(${JSON.stringify(home)})));`,
			],
			{ timeout: 5_000 },
		);
		expect(r.exitCode).toBe(0);
		const st = nodeFs.lstatSync(pidFile);
		expect(st.isFile()).toBe(true);
		expect(nodeFs.readFileSync(pidFile, "utf8").trim()).toMatch(/^\d+$/);
	});

	t101d(
		"disabling via a symlinked spelling drops grants seeded under the real path",
		() => {
			const real = makeWs([]);
			const alias = path.join(mktmp("t101d-alias-"), "ws-link");
			nodeFs.symlinkSync(real, alias);
			const dh = mktmp("t101d-alias-dh-");
			const priv = privateConfigHome(dh, real);
			expect(privateConfigHome(dh, alias)).toBe(priv);
			ensurePreallowReads({
				configHome: priv,
				workspaceRoot: real,
				hosts: [],
				enabled: true,
			});
			expect(
				readPolicy(priv).rules.filter((r) => r["reason"] === PREALLOW_TAG)
					.length,
			).toBe(3);
			ensurePreallowReads({
				configHome: priv,
				workspaceRoot: alias,
				hosts: [],
				enabled: false,
			});
			expect(
				readPolicy(priv).rules.filter((r) => r["reason"] === PREALLOW_TAG),
			).toEqual([]);
		},
	);

	t101d("a 243-char workspace name still yields a creatable home", () => {
		const parent = mktmp("t101d-long-");
		const ws = path.join(parent, "w".repeat(243));
		nodeFs.mkdirSync(ws);
		const id = workspaceConfigId(ws);
		expect(id.length).toBeLessThanOrEqual(preallow.WORKSPACE_ID_BASE_MAX + 13);
		const dh = mktmp("t101d-long-dh-");
		const real = mktmp("t101d-long-real-");
		expect(() =>
			ensurePrivateHome({
				privateHome: privateConfigHome(dh, ws),
				dataHome: dataHomeDir(dh),
				realConfigHome: real,
			}),
		).not.toThrow();
	});

	t101d(
		"an empty XDG_CONFIG_HOME counts as unset (the launcher's -n test)",
		() => {
			const saved = process.env["XDG_CONFIG_HOME"];
			process.env["XDG_CONFIG_HOME"] = "";
			try {
				expect(configHomeDir()).toBe(path.join(os.homedir(), ".config"));
				expect(museAuthFile()).toBe(
					path.join(os.homedir(), ".config", "muse", "auth.json"),
				);
			} finally {
				if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
				else process.env["XDG_CONFIG_HOME"] = saved;
			}
		},
	);

	t101d(
		"oauth-recheck never spawns a worker on an unsafe home",
		async () => {
			const real = mktmp("t101d-rck-real-");
			nodeFs.mkdirSync(path.join(real, "muse"), { recursive: true });
			nodeFs.writeFileSync(
				path.join(real, "muse", "auth.json"),
				'{"fake":true}\n',
			);
			const saved = process.env["XDG_CONFIG_HOME"];
			process.env["XDG_CONFIG_HOME"] = real;
			try {
				const dh = mktmp("t101d-rck-dh-");
				nodeFs.mkdirSync(path.join(dh, "routeros-muse"), { recursive: true });
				const fake = mktmp("t101d-rck-fake-");
				nodeFs.symlinkSync(
					fake,
					path.join(dh, "routeros-muse", ".muse-config"),
				);
				const ws = makeWs([]);
				const { bin, log } = stubT50Bin();
				await withT50Env(log, async () => {
					const srv = await startT50Srv(bin, {
						provider: "meta",
						dataHome: dh,
						workspace: ws,
					});
					try {
						const r = await fetch(`${srv.url}api/auth/oauth-recheck`, {
							method: "POST",
						});
						expect(r.status).toBe(200);
						const argvLog = path.join(bin, "argv.log");
						const argv = nodeFs.existsSync(argvLog)
							? nodeFs.readFileSync(argvLog, "utf8")
							: "";
						expect(argv).not.toMatch(/^serve /m);
						expect(nodeFs.existsSync(path.join(fake, "muse"))).toBe(false);
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
