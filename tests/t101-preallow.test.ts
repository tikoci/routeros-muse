// T101 (D43) phase 1: pre-seeded read allow rules — fail-first suite over
// src/lib/settings.ts (preallow_reads toggle) and src/lib/preallow.ts
// (approval-policy.json seeding). Pure unit tests, no server/worker.
//
// Hermetic: every test sets XDG_CONFIG_HOME to a fresh mktmp dir
// (save/restore around the body) and passes configHome explicitly —
// the real ~/.config/muse is never touched.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	configHomeDir,
	ensurePreallowReads,
	networkRuleForHost,
	POLICY_SCHEMA_VERSION,
	PREALLOW_TAG,
	policyFile,
	READ_COMMANDS,
} from "../src/lib/preallow";
import {
	readPreallowReads,
	settingsFile,
	writePreallowReads,
} from "../src/lib/settings";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

/** Fresh XDG_CONFIG_HOME for the body; restored after. Returns the dir. */
function withCfgHome<T>(fn: (cfg: string) => T): T {
	const cfg = mktmp("t101-cfg-");
	const saved = process.env["XDG_CONFIG_HOME"];
	process.env["XDG_CONFIG_HOME"] = cfg;
	try {
		return fn(cfg);
	} finally {
		if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
		else process.env["XDG_CONFIG_HOME"] = saved;
	}
}

function seedSettings(dataHome: string, text: string): string {
	const file = settingsFile(dataHome);
	nodeFs.mkdirSync(path.dirname(file), { recursive: true });
	nodeFs.writeFileSync(file, text);
	return file;
}

describe("settings preallow_reads toggle", () => {
	test("missing file reads default true", () => {
		withCfgHome(() => {
			expect(readPreallowReads(mktmp("t101set-missing-"))).toBe(true);
		});
	});

	test("explicit false reads false, true reads true, garbage reads true", () => {
		withCfgHome(() => {
			const dh = mktmp("t101set-vals-");
			seedSettings(dh, "[agent]\npreallow_reads = false\n");
			expect(readPreallowReads(dh)).toBe(false);
			seedSettings(dh, "[agent]\npreallow_reads = true\n");
			expect(readPreallowReads(dh)).toBe(true);
			seedSettings(dh, '[agent]\npreallow_reads = "maybe"\n');
			expect(readPreallowReads(dh)).toBe(true);
		});
	});

	test("write false then read false; other lines byte-identical; no temp left", () => {
		withCfgHome(() => {
			const dh = mktmp("t101set-write-");
			const before =
				'# note\n[other]\nkeep = true\n[agent]\ndefault_access = "allowAll"\n';
			const file = seedSettings(dh, before);
			writePreallowReads(dh, false);
			expect(readPreallowReads(dh)).toBe(false);
			const after = nodeFs.readFileSync(file, "utf8");
			expect(after).toContain("preallow_reads = false");
			for (const line of before.split("\n")) {
				if (line) expect(after).toContain(line);
			}
			expect(nodeFs.readdirSync(path.dirname(file))).toEqual(["settings.toml"]);
		});
	});

	test("quoted-key spellings dedup to one bare key", () => {
		withCfgHome(() => {
			const dh = mktmp("t101set-quote-");
			const file = seedSettings(
				dh,
				"[agent]\n\"preallow_reads\" = true\n'preallow_reads' = true\n",
			);
			writePreallowReads(dh, false);
			const text = nodeFs.readFileSync(file, "utf8");
			expect(
				text.split("\n").filter((l) => /preallow_reads\s*=/.test(l)),
			).toHaveLength(1);
			expect(readPreallowReads(dh)).toBe(false);
		});
	});
});

describe("policy file paths", () => {
	test("policyFile resolves under the config home", () => {
		withCfgHome((cfg) => {
			expect(policyFile(cfg)).toBe(
				path.join(cfg, "muse", "approval-policy.json"),
			);
			expect(configHomeDir(cfg)).toBe(cfg);
		});
	});

	test("explicit home beats XDG_CONFIG_HOME", () => {
		withCfgHome((cfg) => {
			const other = mktmp("t101-cfg-other-");
			expect(policyFile(other)).toBe(
				path.join(other, "muse", "approval-policy.json"),
			);
			expect(configHomeDir()).toBe(cfg);
		});
	});
});

describe("read command set", () => {
	test("centrs execute is NEVER in the seed set", () => {
		for (const prefix of READ_COMMANDS) {
			expect(prefix).not.toContain("execute");
		}
	});

	test("round 2: exactly centrs retrieve + quickchr list/doctor (D43 as amended)", () => {
		// find runs -exec/-delete, rosetta browse writes its DB, and
		// cat/grep/ls are not confined to the workspace: all dropped.
		expect(READ_COMMANDS).toEqual([
			["centrs", "retrieve"],
			["quickchr", "list"],
			["quickchr", "doctor"],
		]);
	});
});

function readPolicy(cfg: string): {
	schema_version: unknown;
	rules: Record<string, unknown>[];
} {
	return JSON.parse(nodeFs.readFileSync(policyFile(cfg), "utf8")) as {
		schema_version: unknown;
		rules: Record<string, unknown>[];
	};
}

describe("ensurePreallowReads", () => {
	test("missing file: created, schema 2, shell set tagged", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			const res = ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [],
				enabled: true,
			});
			expect(res.changed).toBe(true);
			expect(res.enabled).toBe(true);
			expect(res.warnings).toEqual([]);
			const doc = readPolicy(cfg);
			expect(doc.schema_version).toBe(POLICY_SCHEMA_VERSION);
			const ours = doc.rules.filter((r) => r["reason"] === PREALLOW_TAG);
			expect(ours.length).toBe(READ_COMMANDS.length);
			for (const prefix of READ_COMMANDS) {
				expect(
					ours.some(
						(r) =>
							(r["rule"] as Record<string, unknown>)["kind"] ===
								"shell_command_argv_prefix" &&
							JSON.stringify(
								(r["rule"] as Record<string, unknown>)["argv_prefix"],
							) === JSON.stringify(prefix) &&
							(r["rule"] as Record<string, unknown>)["workspace_root"] === ws,
					),
				).toBe(true);
			}
			for (const r of ours) {
				expect(r["effect"]).toBe("allow");
				expect(r["durability"]).toBe("local_persistent");
			}
			expect(res.seededHosts).toEqual([]);
		});
	});

	test("foreign rules preserved byte-values; untagged same-root same-argv kept alongside ours", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			const foreignOther = {
				effect: "allow",
				durability: "local_persistent",
				rule: {
					kind: "shell_command_argv_prefix",
					argv_prefix: ["rm"],
					workspace_root: "/some/other/ws",
				},
				reason: "someone-else",
			};
			const foreignSame = {
				effect: "allow",
				durability: "local_persistent",
				rule: {
					kind: "shell_command_argv_prefix",
					argv_prefix: ["centrs", "retrieve"],
					workspace_root: ws,
				},
				reason: null,
			};
			nodeFs.mkdirSync(path.dirname(policyFile(cfg)), { recursive: true });
			nodeFs.writeFileSync(
				policyFile(cfg),
				JSON.stringify({
					schema_version: 2,
					rules: [foreignOther, foreignSame],
				}),
			);
			const res = ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [],
				enabled: true,
			});
			expect(res.changed).toBe(true);
			const doc = readPolicy(cfg);
			// Foreign entries survive deep-equal (key order + values kept).
			expect(doc.rules).toContainEqual(foreignOther);
			expect(doc.rules).toContainEqual(foreignSame);
			// Our tagged rule is ADDED, not merged into the foreign one.
			const sameRules = doc.rules.filter(
				(r) =>
					JSON.stringify(
						(r["rule"] as Record<string, unknown>)["argv_prefix"],
					) === JSON.stringify(["centrs", "retrieve"]),
			);
			expect(sameRules).toHaveLength(2);
		});
	});

	test("idempotent: second ensure changes nothing, bytes identical", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [],
				enabled: true,
			});
			const before = nodeFs.readFileSync(policyFile(cfg), "utf8");
			const res = ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [],
				enabled: true,
			});
			expect(res.changed).toBe(false);
			expect(res.warnings).toEqual([]);
			expect(nodeFs.readFileSync(policyFile(cfg), "utf8")).toBe(before);
		});
	});

	test("re-key on move: dead-root tagged rules pruned, current ensured", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			const dead = path.join(cfg, "ws-gone");
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
								argv_prefix: ["ls"],
								workspace_root: dead,
							},
							reason: PREALLOW_TAG,
						},
					],
				}),
			);
			const res = ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [],
				enabled: true,
			});
			expect(res.changed).toBe(true);
			const doc = readPolicy(cfg);
			const roots = doc.rules.map(
				(r) => (r["rule"] as Record<string, unknown>)["workspace_root"],
			);
			expect(roots).not.toContain(dead);
			expect(roots).toContain(ws);
		});
	});

	test("tagged rules for another live root survive", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			const other = mktmp("t101-ws-other-");
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
								argv_prefix: ["ls"],
								workspace_root: other,
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
			const doc = readPolicy(cfg);
			expect(
				doc.rules.some(
					(r) =>
						(r["rule"] as Record<string, unknown>)["workspace_root"] ===
							other && r["reason"] === PREALLOW_TAG,
				),
			).toBe(true);
		});
	});

	test("enabled:false removes our rules for this root only", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [],
				enabled: true,
			});
			const res = ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [],
				enabled: false,
			});
			expect(res.changed).toBe(true);
			expect(res.enabled).toBe(false);
			const doc = readPolicy(cfg);
			expect(
				doc.rules.filter((r) => r["reason"] === PREALLOW_TAG),
			).toHaveLength(0);
			// Second off-ensure is a no-op.
			const again = ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [],
				enabled: false,
			});
			expect(again.changed).toBe(false);
		});
	});

	test("schema_version 3: skipped with warning, bytes untouched", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			nodeFs.mkdirSync(path.dirname(policyFile(cfg)), { recursive: true });
			const before = JSON.stringify({
				schema_version: 3,
				rules: [{ future: true }],
			});
			nodeFs.writeFileSync(policyFile(cfg), before);
			const res = ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [],
				enabled: true,
			});
			expect(res.changed).toBe(false);
			expect(res.warnings.join(" ")).toMatch(/schema/i);
			expect(nodeFs.readFileSync(policyFile(cfg), "utf8")).toBe(before);
		});
	});

	test("corrupt JSON: skipped with warning, bytes untouched", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			nodeFs.mkdirSync(path.dirname(policyFile(cfg)), { recursive: true });
			nodeFs.writeFileSync(policyFile(cfg), "{not json");
			const res = ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [],
				enabled: true,
			});
			expect(res.changed).toBe(false);
			expect(res.warnings.join(" ")).toMatch(/parse|corrupt|json/i);
			expect(nodeFs.readFileSync(policyFile(cfg), "utf8")).toBe("{not json");
		});
	});

	test("symlinked policy file: refused, victim untouched", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			const victim = path.join(cfg, "victim.txt");
			nodeFs.writeFileSync(victim, "victim-bytes\n");
			nodeFs.mkdirSync(path.dirname(policyFile(cfg)), { recursive: true });
			nodeFs.symlinkSync(victim, policyFile(cfg));
			expect(() =>
				ensurePreallowReads({
					configHome: cfg,
					workspaceRoot: ws,
					hosts: [],
					enabled: true,
				}),
			).toThrow(/symlink/i);
			expect(nodeFs.readFileSync(victim, "utf8")).toBe("victim-bytes\n");
		});
	});

	test("symlinked muse dir: refused", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			const target = path.join(cfg, "real-target");
			nodeFs.mkdirSync(target, { recursive: true });
			nodeFs.symlinkSync(target, path.dirname(policyFile(cfg)));
			expect(() =>
				ensurePreallowReads({
					configHome: cfg,
					workspaceRoot: ws,
					hosts: [],
					enabled: true,
				}),
			).toThrow(/symlink/i);
			expect(nodeFs.readdirSync(target)).toEqual([]);
		});
	});

	test("concurrent writer: one mid-write change converges, no temp left", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			const base = JSON.stringify({ schema_version: 2, rules: [] });
			nodeFs.mkdirSync(path.dirname(policyFile(cfg)), { recursive: true });
			nodeFs.writeFileSync(policyFile(cfg), base);
			const foreign = {
				effect: "allow",
				durability: "local_persistent",
				rule: {
					kind: "shell_command_argv_prefix",
					argv_prefix: ["rm"],
					workspace_root: "/elsewhere",
				},
				reason: "someone-else",
			};
			const raced = JSON.stringify({ schema_version: 2, rules: [foreign] });
			let reads = 0;
			const realRead = nodeFs.readFileSync;
			const res = ensurePreallowReads(
				{ configHome: cfg, workspaceRoot: ws, hosts: [], enabled: true },
				{
					readFileSync: () => {
						reads++;
						// First read sees base; the re-read sees a concurrent
						// writer's bytes; thereafter the file is stable.
						if (reads === 1) return base;
						return raced;
					},
				},
			);
			expect(res.changed).toBe(true);
			// The winner merged over the raced bytes: foreign rule kept.
			const doc = JSON.parse(realRead(policyFile(cfg), "utf8")) as {
				rules: unknown[];
			};
			expect(doc.rules).toContainEqual(foreign);
			expect(
				doc.rules.filter(
					(r) => (r as Record<string, unknown>)["reason"] === PREALLOW_TAG,
				).length,
			).toBeGreaterThan(0);
			expect(
				nodeFs
					.readdirSync(path.dirname(policyFile(cfg)))
					.filter((f) => f !== "approval-policy.json"),
			).toEqual([]);
		});
	});

	test("racy file that never settles: gives up with warning, original kept, no temp left", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			const base = JSON.stringify({ schema_version: 2, rules: [] });
			nodeFs.mkdirSync(path.dirname(policyFile(cfg)), { recursive: true });
			nodeFs.writeFileSync(policyFile(cfg), base);
			let n = 0;
			const res = ensurePreallowReads(
				{ configHome: cfg, workspaceRoot: ws, hosts: [], enabled: true },
				{
					readFileSync: () => {
						// Every read sees a different file: the race never ends.
						n++;
						return JSON.stringify({
							schema_version: 2,
							rules: [{ marker: n }],
						});
					},
				},
			);
			expect(res.changed).toBe(false);
			expect(res.warnings.join(" ")).toMatch(/concurrent|race|changed/i);
			expect(
				nodeFs
					.readdirSync(path.dirname(policyFile(cfg)))
					.filter((f) => f !== "approval-policy.json"),
			).toEqual([]);
		});
	});
});

describe("network rules (probed shape)", () => {
	test("rule is exactly the live-probed host-only shape, muse key order", () => {
		expect(networkRuleForHost("192.168.88.1")).toEqual({
			kind: "network",
			host: "192.168.88.1",
		});
		expect(Object.keys(networkRuleForHost("h"))).toEqual(["kind", "host"]);
	});

	test("hosts seeded as tagged entries and reported", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			const res = ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: ["192.168.88.1", "router.lan"],
				enabled: true,
			});
			expect(res.seededHosts).toEqual(["192.168.88.1", "router.lan"]);
			const doc = readPolicy(cfg);
			for (const h of ["192.168.88.1", "router.lan"]) {
				expect(doc.rules).toContainEqual({
					effect: "allow",
					durability: "local_persistent",
					rule: { kind: "network", host: h },
					reason: PREALLOW_TAG,
				});
			}
		});
	});

	test("host list: trims, drops empties, dedupes", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			const res = ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [" h1 ", "", "h1", "h2"],
				enabled: true,
			});
			expect(res.seededHosts).toEqual(["h1", "h2"]);
			const doc = readPolicy(cfg);
			expect(
				doc.rules.filter(
					(r) => (r["rule"] as Record<string, unknown>)["kind"] === "network",
				),
			).toHaveLength(2);
		});
	});

	test("round 2: tagged network rules outside the union are pruned", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			nodeFs.mkdirSync(path.dirname(policyFile(cfg)), { recursive: true });
			nodeFs.writeFileSync(
				policyFile(cfg),
				JSON.stringify({
					schema_version: 2,
					rules: [
						{
							effect: "allow",
							durability: "local_persistent",
							rule: { kind: "network", host: "removed-ws-router" },
							reason: PREALLOW_TAG,
						},
					],
				}),
			);
			// The caller passes the recomputed union: the removed
			// workspace's host is gone from it, so it is pruned.
			ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: ["h1"],
				enabled: true,
			});
			const doc = readPolicy(cfg);
			const hosts = doc.rules
				.filter((r) => r["reason"] === PREALLOW_TAG)
				.map((r) => (r["rule"] as Record<string, unknown>)["host"]);
			expect(hosts).not.toContain("removed-ws-router");
			expect(hosts).toContain("h1");
		});
	});

	test("round 2: enabled:false removes every tagged network rule, keeps foreign", () => {
		withCfgHome((cfg) => {
			const ws = mktmp("t101-ws-");
			ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: ["h1"],
				enabled: true,
			});
			const doc = readPolicy(cfg);
			const other = {
				effect: "allow",
				durability: "local_persistent",
				rule: { kind: "network", host: "h2" },
				reason: PREALLOW_TAG,
			};
			const foreign = {
				effect: "allow",
				durability: "local_persistent",
				rule: { kind: "network", host: "h1", port: 3000, protocol: "http" },
				reason: null,
			};
			nodeFs.writeFileSync(
				policyFile(cfg),
				JSON.stringify({
					schema_version: 2,
					rules: [...doc.rules, other, foreign],
				}),
			);
			// Disabled means the union is empty: every tagged rule goes.
			ensurePreallowReads({
				configHome: cfg,
				workspaceRoot: ws,
				hosts: [],
				enabled: false,
			});
			const after = readPolicy(cfg);
			expect(after.rules).toContainEqual(foreign);
			expect(after.rules.filter((r) => r["reason"] === PREALLOW_TAG)).toEqual(
				[],
			);
		});
	});
});
