// T101 round 3: fail-first suite for the request-changes fixes.
//
// 1. `centrs retrieve` dropped from the seeded read set (C19: a
//    fragment path rebooted a CHR without --yes).
// 2. Fail closed on an unsafe private home (no seed, no spawn).
// 3. Cross-process seed lock.
// 4. Small items: settings.json mode, dangling real auth.json.
// 5. Worker isolation is real (fake muse records XDG_CONFIG_HOME).
//
// Hermetic: mktmp dirs, stub/fake muse, explicit config homes — the
// real ~/.config is never touched.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	ensurePreallowReads,
	ensurePrivateHome,
	POLICY_SCHEMA_VERSION,
	PREALLOW_TAG,
	policyFile,
	privateConfigHome,
	READ_COMMANDS,
} from "../src/lib/preallow";
import { dataHomeDir } from "../src/lib/registry";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";
import { startT50Srv, stubT50Bin, withT50Env } from "./t50-fake";

afterAll(cleanupTmpdirs);

const t101c = process.platform !== "win32" ? test : test.skip;

function readPolicy(cfg: string): {
	schema_version: unknown;
	rules: Record<string, unknown>[];
} {
	return JSON.parse(nodeFs.readFileSync(policyFile(cfg), "utf8")) as {
		schema_version: unknown;
		rules: Record<string, unknown>[];
	};
}

function taggedPrefixes(cfg: string): string[] {
	return readPolicy(cfg)
		.rules.filter((r) => r["reason"] === PREALLOW_TAG)
		.map((r) =>
			JSON.stringify((r["rule"] as Record<string, unknown>)["argv_prefix"]),
		);
}

describe("round 3 fix 1: centrs retrieve out of the seed set (C19)", () => {
	test("READ_COMMANDS is exactly quickchr list/doctor", () => {
		// retrieve dispatched a write (POST /rest/system/reboot) from
		// a fragment path without --yes (C19): it stays unseeded
		// until the upstream fix lands and the pin consumes it.
		expect(READ_COMMANDS).toEqual([
			["quickchr", "list"],
			["quickchr", "doctor"],
		]);
		expect(POLICY_SCHEMA_VERSION).toBe(2);
	});

	t101c(
		"a tagged round-2 centrs retrieve rule is pruned on the next seed",
		() => {
			const cfg = mktmp("t101c-retrieve-");
			const ws = mktmp("t101c-retrieve-ws-");
			nodeFs.mkdirSync(path.dirname(policyFile(cfg)), { recursive: true });
			nodeFs.writeFileSync(
				policyFile(cfg),
				JSON.stringify({
					schema_version: 2,
					rules: [
						{
							effect: "allow",
							durability: "local_persistent",
							rule: {
								kind: "shell_command_argv_prefix",
								argv_prefix: ["centrs", "retrieve"],
								workspace_root: ws,
							},
							reason: PREALLOW_TAG,
						},
					],
				}),
			);
			ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [],
				enabled: true,
			});
			const prefixes = taggedPrefixes(cfg);
			expect(prefixes).not.toContain(JSON.stringify(["centrs", "retrieve"]));
			expect(prefixes).toContain(JSON.stringify(["quickchr", "list"]));
			expect(prefixes).toContain(JSON.stringify(["quickchr", "doctor"]));
		},
	);
});

describe("round 3 fix 2: fail closed on an unsafe private home", () => {
	t101c("seed refuses a symlinked config-home root, victim untouched", () => {
		const base = mktmp("t101c-cfgroot-");
		const victim = path.join(base, "victim.txt");
		nodeFs.writeFileSync(victim, "victim-bytes\n");
		const target = path.join(base, "real-target");
		nodeFs.mkdirSync(target, { recursive: true });
		const cfg = path.join(base, "muse-config");
		nodeFs.symlinkSync(target, cfg);
		const ws = mktmp("t101c-cfgroot-ws-");
		expect(() =>
			ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [],
				enabled: true,
			}),
		).toThrow(/symlink/i);
		expect(nodeFs.readFileSync(victim, "utf8")).toBe("victim-bytes\n");
		expect(nodeFs.readdirSync(target)).toEqual([]);
	});

	t101c("private home refuses a symlinked <dataHome>/routeros-muse", () => {
		const base = mktmp("t101c-rm-");
		const target = path.join(base, "real-target");
		nodeFs.mkdirSync(target, { recursive: true });
		const dh = path.join(base, "dh");
		nodeFs.mkdirSync(dh, { recursive: true });
		nodeFs.symlinkSync(target, path.join(dh, "routeros-muse"));
		expect(() =>
			ensurePrivateHome({
				privateHome: privateConfigHome(dh),
				dataHome: dataHomeDir(dh),
			}),
		).toThrow(/symlink/i);
		expect(nodeFs.readdirSync(target)).toEqual([]);
	});

	t101c("private home refuses a symlinked approval-policy.json", () => {
		const base = mktmp("t101c-pol-");
		const victim = path.join(base, "victim.txt");
		nodeFs.writeFileSync(victim, "victim-bytes\n");
		const dh = path.join(base, "dh");
		const priv = privateConfigHome(dh);
		const museDir = path.join(priv, "muse");
		nodeFs.mkdirSync(museDir, { recursive: true });
		nodeFs.symlinkSync(victim, path.join(museDir, "approval-policy.json"));
		expect(() =>
			ensurePrivateHome({ privateHome: priv, dataHome: dataHomeDir(dh) }),
		).toThrow(/symlink/i);
		expect(nodeFs.readFileSync(victim, "utf8")).toBe("victim-bytes\n");
	});

	t101c("symlinks above <dataHome>/routeros-muse are allowed", () => {
		// A symlinked ~/.local is a legit setup: only the chain from
		// routeros-muse down is checked, never its parents.
		const base = mktmp("t101c-above-");
		nodeFs.mkdirSync(path.join(base, "real", "dh"), { recursive: true });
		nodeFs.symlinkSync(path.join(base, "real"), path.join(base, "link"));
		const dh = path.join(base, "link", "dh");
		const emptyReal = mktmp("t101c-above-real-");
		const res = ensurePrivateHome({
			privateHome: privateConfigHome(dh),
			dataHome: dataHomeDir(dh),
			realConfigHome: emptyReal,
		});
		expect(res.warnings.join(" ")).toMatch(/not signed in/i);
		expect(
			nodeFs.existsSync(
				path.join(privateConfigHome(dh), "muse", "settings.json"),
			),
		).toBe(true);
	});

	t101c(
		"symlinked muse-config: boot seeds nothing through the link, status carries the error, session start fails",
		async () => {
			const real = mktmp("t101c-unsafe-real-");
			nodeFs.mkdirSync(path.join(real, "muse"), { recursive: true });
			nodeFs.writeFileSync(
				path.join(real, "muse", "auth.json"),
				'{"fake":true}\n',
			);
			const saved = process.env["XDG_CONFIG_HOME"];
			process.env["XDG_CONFIG_HOME"] = real;
			try {
				const dh = mktmp("t101c-unsafe-dh-");
				nodeFs.mkdirSync(path.join(dh, "routeros-muse"), {
					recursive: true,
				});
				const fake = mktmp("t101c-unsafe-fake-");
				nodeFs.symlinkSync(fake, path.join(dh, "routeros-muse", "muse-config"));
				const ws = mktmp("t101c-unsafe-ws-");
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
						const status = (await (
							await fetch(`${srv.url}api/status`)
						).json()) as Record<string, unknown>;
						const pre = status["preallow"] as Record<string, unknown>;
						expect(String(pre["homeError"] ?? "")).toMatch(/symlink/i);
						// Session start fails with the reason — no worker spawn.
						const res = await fetch(`${srv.url}api/chat/send`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ text: "hello" }),
						});
						expect(res.status).toBe(500);
						const body = (await res.json()) as Record<string, unknown>;
						expect(String(body["why"] ?? "")).toMatch(/symlink/i);
						// No worker spawn: the shim logs every muse
						// argv, and no `serve` line may appear (the
						// status version probe legitimately runs
						// `muse --version`, never a worker).
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

describe("round 3 fix 4: small items", () => {
	t101c(
		"byte-identical settings.json with a wrong mode is chmodded 0600",
		() => {
			const base = mktmp("t101c-mode-");
			const emptyReal = path.join(base, "real");
			nodeFs.mkdirSync(emptyReal, { recursive: true });
			const priv = path.join(base, "priv");
			ensurePrivateHome({ privateHome: priv, realConfigHome: emptyReal });
			const settings = path.join(priv, "muse", "settings.json");
			const bytes = nodeFs.readFileSync(settings, "utf8");
			nodeFs.chmodSync(settings, 0o644);
			expect(nodeFs.statSync(settings).mode & 0o777).toBe(0o644);
			ensurePrivateHome({ privateHome: priv, realConfigHome: emptyReal });
			expect(nodeFs.statSync(settings).mode & 0o777).toBe(0o600);
			expect(nodeFs.readFileSync(settings, "utf8")).toBe(bytes);
		},
	);

	t101c(
		"dangling real auth.json symlink warns not-signed-in, links nothing",
		() => {
			const base = mktmp("t101c-dangle-");
			const real = path.join(base, "real");
			nodeFs.mkdirSync(path.join(real, "muse"), { recursive: true });
			nodeFs.symlinkSync(
				path.join(real, "muse", "gone.json"),
				path.join(real, "muse", "auth.json"),
			);
			const priv = path.join(base, "priv");
			const res = ensurePrivateHome({
				privateHome: priv,
				realConfigHome: real,
			});
			expect(res.warnings.join(" ")).toMatch(/not signed in/i);
			expect(nodeFs.existsSync(path.join(priv, "muse", "auth.json"))).toBe(
				false,
			);
		},
	);

	t101c("dangling real auth.json leaves an existing private file alone", () => {
		const base = mktmp("t101c-dangle-keep-");
		const real = path.join(base, "real");
		nodeFs.mkdirSync(path.join(real, "muse"), { recursive: true });
		nodeFs.symlinkSync(
			path.join(real, "muse", "gone.json"),
			path.join(real, "muse", "auth.json"),
		);
		const priv = path.join(base, "priv");
		const museDir = path.join(priv, "muse");
		nodeFs.mkdirSync(museDir, { recursive: true });
		const auth = path.join(museDir, "auth.json");
		nodeFs.writeFileSync(auth, '{"kept":true}\n');
		const res = ensurePrivateHome({ privateHome: priv, realConfigHome: real });
		expect(res.warnings.join(" ")).toMatch(/not signed in/i);
		expect(nodeFs.readFileSync(auth, "utf8")).toBe('{"kept":true}\n');
	});
});

describe("round 3 fix 3: cross-process seed lock", () => {
	t101c(
		"two real processes seeding together keep both rule sets",
		async () => {
			const base = mktmp("t101c-race-");
			const cfg = path.join(base, "cfg");
			const wsA = path.join(base, "ws-a");
			const wsB = path.join(base, "ws-b");
			nodeFs.mkdirSync(wsA, { recursive: true });
			nodeFs.mkdirSync(wsB, { recursive: true });
			const coord = path.join(base, "coord");
			nodeFs.mkdirSync(coord, { recursive: true });
			const worker = path.join(import.meta.dir, "t101c-seed-worker.ts");
			// Both sides assert the SAME union (two servers share
			// one registry, so their unions agree); the shells
			// differ per root — that is what the race dropped.
			const run = (role: string, ws: string) =>
				Bun.spawn(
					[
						process.execPath,
						worker,
						cfg,
						ws,
						role,
						coord,
						"host-a.lan",
						"host-b.lan",
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
			const a = run("a", wsA);
			const b = run("b", wsB);
			const [outA, outB] = await Promise.all([
				new Response(a.stdout).text(),
				new Response(b.stdout).text(),
			]);
			const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
			expect(codeA).toBe(0);
			expect(codeB).toBe(0);
			expect(outA).not.toContain("error");
			expect(outB).not.toContain("error");
			// Both workspaces' shell sets survived, and the union
			// holds both hosts: no rename clobbered the other.
			const rules = readPolicy(cfg).rules;
			for (const ws of [wsA, wsB]) {
				for (const prefix of READ_COMMANDS) {
					expect(
						rules.some(
							(r) =>
								r["reason"] === PREALLOW_TAG &&
								JSON.stringify(
									(r["rule"] as Record<string, unknown>)["argv_prefix"],
								) === JSON.stringify(prefix) &&
								(r["rule"] as Record<string, unknown>)["workspace_root"] === ws,
						),
					).toBe(true);
				}
			}
			const hosts = rules
				.filter(
					(r) =>
						r["reason"] === PREALLOW_TAG &&
						(r["rule"] as Record<string, unknown>)["kind"] === "network",
				)
				.map((r) => (r["rule"] as Record<string, unknown>)["host"]);
			expect([...hosts].sort()).toEqual(["host-a.lan", "host-b.lan"]);
			// The lock released: no leftover beside the policy.
			expect(
				nodeFs
					.readdirSync(path.join(cfg, "muse"))
					.filter((f) => f !== "approval-policy.json"),
			).toEqual([]);
		},
		60_000,
	);

	t101c("the lock holds pid + timestamp and releases in a finally", () => {
		const cfg = mktmp("t101c-lockshape-");
		const ws = mktmp("t101c-lockshape-ws-");
		let seen: string | null = null;
		ensurePreallowReads(
			{ configHome: cfg, workspaceRoot: ws, hosts: [], enabled: true },
			{
				renameSync: (tmp, file) => {
					seen = nodeFs.readFileSync(`${policyFile(cfg)}.lock`, "utf8");
					nodeFs.renameSync(tmp, file);
				},
			},
		);
		const parsed = JSON.parse(seen as unknown as string) as Record<
			string,
			unknown
		>;
		expect(parsed["pid"]).toBe(process.pid);
		expect(typeof parsed["started"]).toBe("number");
		expect(nodeFs.existsSync(`${policyFile(cfg)}.lock`)).toBe(false);
	});

	t101c("a stale lock (dead pid) is broken, then released", () => {
		const cfg = mktmp("t101c-stale-");
		const ws = mktmp("t101c-stale-ws-");
		nodeFs.mkdirSync(path.dirname(policyFile(cfg)), { recursive: true });
		// A pid that cannot be alive (large + reaped check).
		const deadPid = 2 ** 30 + (process.pid % 1000);
		let alive = true;
		try {
			process.kill(deadPid, 0);
		} catch {
			alive = false;
		}
		if (alive) return; // Absurdly unlikely; never hang the suite.
		nodeFs.writeFileSync(
			`${policyFile(cfg)}.lock`,
			JSON.stringify({ pid: deadPid, started: Date.now() }),
		);
		const res = ensurePreallowReads({
			configHome: cfg,
			workspaceRoot: ws,
			hosts: [],
			enabled: true,
		});
		expect(res.changed).toBe(true);
		expect(nodeFs.existsSync(`${policyFile(cfg)}.lock`)).toBe(false);
		expect(taggedPrefixes(cfg)).toContain(JSON.stringify(["quickchr", "list"]));
	});

	t101c(
		"a live fresh lock gives up with a warning and leaves the file alone",
		() => {
			const cfg = mktmp("t101c-held-");
			const ws = mktmp("t101c-held-ws-");
			nodeFs.mkdirSync(path.dirname(policyFile(cfg)), { recursive: true });
			const before = JSON.stringify({ schema_version: 2, rules: [] });
			nodeFs.writeFileSync(policyFile(cfg), before);
			nodeFs.writeFileSync(
				`${policyFile(cfg)}.lock`,
				JSON.stringify({ pid: process.pid, started: Date.now() }),
			);
			const res = ensurePreallowReads(
				{
					configHome: cfg,
					workspaceRoot: ws,
					hosts: [],
					enabled: true,
					lockTimeoutMs: 150,
				},
				undefined,
			);
			expect(res.changed).toBe(false);
			expect(res.warnings.join(" ")).toMatch(/lock/i);
			expect(nodeFs.readFileSync(policyFile(cfg), "utf8")).toBe(before);
		},
	);
});

describe("round 3 fix 5: worker isolation is real", () => {
	t101c(
		"worker and auth probe both run under the private config home",
		async () => {
			const real = mktmp("t101c-iso-real-");
			nodeFs.mkdirSync(path.join(real, "muse"), { recursive: true });
			nodeFs.writeFileSync(
				path.join(real, "muse", "auth.json"),
				'{"fake":true}\n',
			);
			const saved = process.env["XDG_CONFIG_HOME"];
			process.env["XDG_CONFIG_HOME"] = real;
			try {
				const { bin, log } = stubT50Bin();
				await withT50Env(log, async () => {
					// provider meta runs the boot auth probe (a
					// disposable spawn); the send below spawns the
					// worker. The fake records the XDG_CONFIG_HOME
					// each spawn received.
					const srv = await startT50Srv(bin, { provider: "meta" });
					try {
						const priv = privateConfigHome(srv.dataHome);
						const res = await fetch(`${srv.url}api/chat/send`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ text: "hello" }),
						});
						expect(res.status).toBe(200);
						const deadline = Date.now() + 20_000;
						let lines: string[] = [];
						for (;;) {
							const logged = nodeFs.existsSync(log)
								? nodeFs.readFileSync(log, "utf8")
								: "";
							lines = logged
								.split("\n")
								.filter((l) => l.startsWith("CONFIG_HOME "));
							if (lines.length >= 2 || Date.now() > deadline) break;
							await Bun.sleep(100);
						}
						expect(lines.length).toBeGreaterThanOrEqual(2);
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
