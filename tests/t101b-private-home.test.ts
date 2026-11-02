// T101 round 2 (D44): private muse config home — fail-first suite.
//
// Our muse workers run with XDG_CONFIG_HOME pointed at a private home
// (<dataHome>/routeros-muse/muse-config) holding our own
// approval-policy.json + settings.json plus a symlink to the user's
// real auth.json. The shared ~/.config/muse is never written.
//
// Hermetic: temp dirs for the private home, the real home (fake
// auth.json, never read for content — link target only), and the
// server data home. XDG_CONFIG_HOME points at a temp sentinel the
// server must leave untouched.
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
	unionWorkspaceHosts,
	withSeedLock,
} from "../src/lib/preallow";
import { startServer } from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";
import { startT50Srv, stubT50Bin, withT50Env } from "./t50-fake";

afterAll(cleanupTmpdirs);

const t101b = process.platform !== "win32" ? test : test.skip;

/** Fresh XDG_CONFIG_HOME for the body; restored after. Returns the dir. */
function withRealHome<T>(fn: (real: string) => T): T {
	const real = mktmp("t101b-real-");
	const saved = process.env["XDG_CONFIG_HOME"];
	process.env["XDG_CONFIG_HOME"] = real;
	try {
		return fn(real);
	} finally {
		if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
		else process.env["XDG_CONFIG_HOME"] = saved;
	}
}

/** A fake real-home auth.json. Content is never asserted (never read). */
function seedFakeAuth(real: string): string {
	const file = path.join(real, "muse", "auth.json");
	nodeFs.mkdirSync(path.dirname(file), { recursive: true });
	nodeFs.writeFileSync(file, '{"providers":{"meta":{"mechanism":"oauth"}}}\n');
	return file;
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

function makeWs(hosts: string[]): string {
	const dir = mktmp("t101b-ws-");
	nodeFs.writeFileSync(path.join(dir, "workspace.toml"), "canonical = true\n");
	nodeFs.writeFileSync(
		path.join(dir, "router.toml"),
		hosts.map((h, i) => `[[device]]\nid = "d${i}"\nhost = "${h}"\n`).join(""),
	);
	return dir;
}

describe("private home path", () => {
	test("privateConfigHome nests under the data home", () => {
		const dh = mktmp("t101b-dh-");
		expect(privateConfigHome(dh)).toBe(
			path.join(dh, "routeros-muse", "muse-config"),
		);
	});
});

describe("read set (D43 as amended)", () => {
	test("exactly centrs retrieve + quickchr list/doctor, nothing else", () => {
		expect(READ_COMMANDS).toEqual([
			["centrs", "retrieve"],
			["quickchr", "list"],
			["quickchr", "doctor"],
		]);
	});
});

describe("ensurePrivateHome", () => {
	t101b("creates the layout: muse dir, settings.json, auth symlink", () => {
		withRealHome((real) => {
			const realAuth = seedFakeAuth(real);
			const priv = mktmp("t101b-priv-");
			const res = ensurePrivateHome({ privateHome: priv });
			expect(res.warnings).toEqual([]);
			const museDir = path.join(priv, "muse");
			expect(nodeFs.statSync(museDir).isDirectory()).toBe(true);
			const settings = JSON.parse(
				nodeFs.readFileSync(path.join(museDir, "settings.json"), "utf8"),
			) as Record<string, unknown>;
			expect(settings["schema_version"]).toBe(1);
			const link = path.join(museDir, "auth.json");
			expect(nodeFs.lstatSync(link).isSymbolicLink()).toBe(true);
			expect(nodeFs.readlinkSync(link)).toBe(realAuth);
			expect(res.changed).toBe(true);
		});
	});

	t101b("dirs are 0700 and settings.json is 0600", () => {
		withRealHome((real) => {
			seedFakeAuth(real);
			const priv = mktmp("t101b-modes-");
			ensurePrivateHome({ privateHome: priv });
			const mode = (p: string): number => nodeFs.statSync(p).mode & 0o777;
			expect(mode(path.join(priv))).toBe(0o700);
			expect(mode(path.join(priv, "muse"))).toBe(0o700);
			expect(mode(path.join(priv, "muse", "settings.json"))).toBe(0o600);
		});
	});

	t101b("settings.json is minimal: schema_version only", () => {
		withRealHome((real) => {
			seedFakeAuth(real);
			const priv = mktmp("t101b-min-");
			ensurePrivateHome({ privateHome: priv });
			const raw = nodeFs.readFileSync(
				path.join(priv, "muse", "settings.json"),
				"utf8",
			);
			expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual([
				"schema_version",
			]);
		});
	});

	t101b("second ensure is a no-op (bytes + mtimes stable)", () => {
		withRealHome((real) => {
			seedFakeAuth(real);
			const priv = mktmp("t101b-idem-");
			ensurePrivateHome({ privateHome: priv });
			const settings = path.join(priv, "muse", "settings.json");
			const before = nodeFs.readFileSync(settings, "utf8");
			const mtime = nodeFs.statSync(settings).mtimeMs;
			const res = ensurePrivateHome({ privateHome: priv });
			expect(res.changed).toBe(false);
			expect(nodeFs.readFileSync(settings, "utf8")).toBe(before);
			expect(nodeFs.statSync(settings).mtimeMs).toBe(mtime);
		});
	});

	t101b("re-links when muse replaced auth.json with a regular file", () => {
		withRealHome((real) => {
			const realAuth = seedFakeAuth(real);
			const priv = mktmp("t101b-relink-");
			ensurePrivateHome({ privateHome: priv });
			const link = path.join(priv, "muse", "auth.json");
			nodeFs.unlinkSync(link);
			nodeFs.writeFileSync(link, '{"replaced":true}\n');
			expect(nodeFs.lstatSync(link).isSymbolicLink()).toBe(false);
			ensurePrivateHome({ privateHome: priv });
			expect(nodeFs.lstatSync(link).isSymbolicLink()).toBe(true);
			expect(nodeFs.readlinkSync(link)).toBe(realAuth);
		});
	});

	t101b("re-links a stale link target, and recreates a missing link", () => {
		withRealHome((real) => {
			const realAuth = seedFakeAuth(real);
			const priv = mktmp("t101b-stale-");
			ensurePrivateHome({ privateHome: priv });
			const link = path.join(priv, "muse", "auth.json");
			nodeFs.unlinkSync(link);
			nodeFs.symlinkSync(path.join(real, "muse", "elsewhere.json"), link);
			ensurePrivateHome({ privateHome: priv });
			expect(nodeFs.readlinkSync(link)).toBe(realAuth);
			nodeFs.unlinkSync(link);
			ensurePrivateHome({ privateHome: priv });
			expect(nodeFs.readlinkSync(link)).toBe(realAuth);
		});
	});

	t101b("missing real auth.json: warns not-signed-in, touches nothing", () => {
		withRealHome(() => {
			const priv = mktmp("t101b-noauth-");
			const res = ensurePrivateHome({ privateHome: priv });
			expect(res.warnings.join(" ")).toMatch(/not signed in/i);
			// The home itself is still ensured (dirs + settings); only
			// the link is skipped — there is nothing to point at.
			expect(nodeFs.existsSync(path.join(priv, "muse", "settings.json"))).toBe(
				true,
			);
			expect(nodeFs.existsSync(path.join(priv, "muse", "auth.json"))).toBe(
				false,
			);
		});
	});

	t101b("missing real auth.json leaves an existing private file alone", () => {
		withRealHome(() => {
			const priv = mktmp("t101b-noauth-keep-");
			const museDir = path.join(priv, "muse");
			nodeFs.mkdirSync(museDir, { recursive: true });
			const auth = path.join(museDir, "auth.json");
			nodeFs.writeFileSync(auth, '{"kept":true}\n');
			const res = ensurePrivateHome({ privateHome: priv });
			expect(res.warnings.join(" ")).toMatch(/not signed in/i);
			expect(nodeFs.readFileSync(auth, "utf8")).toBe('{"kept":true}\n');
		});
	});

	t101b("same-path real and private home: no link, no warning", () => {
		withRealHome((real) => {
			seedFakeAuth(real);
			const res = ensurePrivateHome({
				privateHome: real,
				realConfigHome: real,
			});
			expect(res.warnings).toEqual([]);
			// The real auth.json stays a regular file, never a link.
			expect(
				nodeFs.lstatSync(path.join(real, "muse", "auth.json")).isSymbolicLink(),
			).toBe(false);
		});
	});

	t101b("explicit realConfigHome beats process env", () => {
		withRealHome(() => {
			const other = mktmp("t101b-other-");
			const otherAuth = seedFakeAuth(other);
			const priv = mktmp("t101b-expl-");
			const res = ensurePrivateHome({
				privateHome: priv,
				realConfigHome: other,
			});
			expect(res.warnings).toEqual([]);
			expect(nodeFs.readlinkSync(path.join(priv, "muse", "auth.json"))).toBe(
				otherAuth,
			);
		});
	});

	t101b("symlinked muse-config parent: refused, victim untouched", () => {
		withRealHome((real) => {
			seedFakeAuth(real);
			const base = mktmp("t101b-symparent-");
			const victim = path.join(base, "victim.txt");
			nodeFs.writeFileSync(victim, "victim-bytes\n");
			const target = path.join(base, "real-target");
			nodeFs.mkdirSync(target, { recursive: true });
			const priv = path.join(base, "muse-config");
			nodeFs.symlinkSync(target, priv);
			expect(() => ensurePrivateHome({ privateHome: priv })).toThrow(
				/symlink/i,
			);
			expect(nodeFs.readFileSync(victim, "utf8")).toBe("victim-bytes\n");
			expect(nodeFs.readdirSync(target)).toEqual([]);
		});
	});
});

describe("withSeedLock", () => {
	test("runs the body and returns its value", () => {
		expect(withSeedLock(() => 42)).toBe(42);
	});

	test("re-entrant seeding throws instead of interleaving", () => {
		expect(() => withSeedLock(() => withSeedLock(() => "inner"))).toThrow(
			/re-entered/,
		);
	});
});

describe("unionWorkspaceHosts", () => {
	test("union over roots: normalized, deduped, missing roots skipped", () => {
		const a = makeWs(["h1", "shared"]);
		const b = makeWs(["shared", "h2"]);
		const gone = path.join(mktmp("t101b-gone-"), "nope");
		expect(unionWorkspaceHosts([a, b, gone])).toEqual(["h1", "shared", "h2"]);
	});

	test("unparseable router.toml contributes nothing", () => {
		const dir = mktmp("t101b-bad-");
		nodeFs.writeFileSync(path.join(dir, "router.toml"), "{not toml");
		expect(unionWorkspaceHosts([dir])).toEqual([]);
	});
});

describe("network union ownership (D44)", () => {
	test("union change prunes the dropped host, keeps the shared one once", () => {
		withRealHome(() => {
			const priv = mktmp("t101b-union-");
			const ws = mktmp("t101b-union-ws-");
			ensurePreallowReads({
				configHome: priv,
				workspaceRoot: ws,
				hosts: ["h1", "shared"],
				enabled: true,
			});
			expect(taggedHosts(priv).sort()).toEqual(["h1", "shared"]);
			// A later seed with the recomputed union drops h1.
			ensurePreallowReads({
				configHome: priv,
				workspaceRoot: ws,
				hosts: ["shared", "h2"],
				enabled: true,
			});
			expect(taggedHosts(priv).sort()).toEqual(["h2", "shared"]);
		});
	});

	test("two workspaces sharing a host: one tagged rule, survives either seed", () => {
		withRealHome(() => {
			const priv = mktmp("t101b-shared-");
			const a = mktmp("t101b-shared-a-");
			const b = mktmp("t101b-shared-b-");
			const union = ["shared", "ha", "hb"];
			ensurePreallowReads({
				configHome: priv,
				workspaceRoot: a,
				hosts: union,
				enabled: true,
			});
			ensurePreallowReads({
				configHome: priv,
				workspaceRoot: b,
				hosts: union,
				enabled: true,
			});
			const hosts = taggedHosts(priv);
			expect(hosts.filter((h) => h === "shared")).toHaveLength(1);
			expect([...hosts].sort()).toEqual(["ha", "hb", "shared"]);
			// Both workspaces drop the host: the next union prunes it.
			ensurePreallowReads({
				configHome: priv,
				workspaceRoot: a,
				hosts: ["ha", "hb"],
				enabled: true,
			});
			expect(taggedHosts(priv).sort()).toEqual(["ha", "hb"]);
		});
	});

	test("untagged network rules are never touched", () => {
		withRealHome(() => {
			const priv = mktmp("t101b-untag-");
			const ws = mktmp("t101b-untag-ws-");
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
				hosts: ["h1"],
				enabled: true,
			});
			expect(readPolicy(priv).rules).toContainEqual(owner);
			// Disabled prunes every tagged rule but still keeps the owner's.
			ensurePreallowReads({
				configHome: priv,
				workspaceRoot: ws,
				hosts: [],
				enabled: false,
			});
			const after = readPolicy(priv);
			expect(after.rules).toContainEqual(owner);
			expect(after.rules.filter((r) => r["reason"] === PREALLOW_TAG)).toEqual(
				[],
			);
		});
	});

	test("stale seed commands (ls/cat/...) from round 1 are replaced, not merged", () => {
		withRealHome(() => {
			const priv = mktmp("t101b-stale-");
			const ws = mktmp("t101b-stale-ws-");
			nodeFs.mkdirSync(path.dirname(policyFile(priv)), { recursive: true });
			nodeFs.writeFileSync(
				policyFile(priv),
				JSON.stringify({
					schema_version: 2,
					rules: ["ls", "cat", "rosetta"].map((cmd) => ({
						effect: "allow",
						durability: "local_persistent",
						rule: {
							kind: "shell_command_argv_prefix",
							argv_prefix: [cmd],
							workspace_root: ws,
						},
						reason: PREALLOW_TAG,
					})),
				}),
			);
			ensurePreallowReads({
				configHome: priv,
				workspaceRoot: ws,
				hosts: [],
				enabled: true,
			});
			const ours = readPolicy(priv).rules.filter(
				(r) => r["reason"] === PREALLOW_TAG,
			);
			expect(ours).toHaveLength(READ_COMMANDS.length);
			const prefixes = ours.map((r) =>
				JSON.stringify((r["rule"] as Record<string, unknown>)["argv_prefix"]),
			);
			expect(prefixes).not.toContain(JSON.stringify(["ls"]));
			expect(prefixes).toContain(JSON.stringify(["centrs", "retrieve"]));
		});
	});
});

describe("reviewer small fixes", () => {
	test("idempotence is order-insensitive (rules + keys)", () => {
		withRealHome(() => {
			const priv = mktmp("t101b-order-");
			const ws = mktmp("t101b-order-ws-");
			ensurePreallowReads({
				configHome: priv,
				workspaceRoot: ws,
				hosts: ["h1"],
				enabled: true,
			});
			// Rewrite the same set shuffled, with shuffled keys inside
			// entries: content-equal, byte-different.
			const doc = readPolicy(priv);
			expect(doc.schema_version).toBe(POLICY_SCHEMA_VERSION);
			const shuffled = [...doc.rules].reverse().map((r) => {
				const out: Record<string, unknown> = {};
				for (const k of Object.keys(r).reverse()) out[k] = r[k];
				return out;
			});
			nodeFs.writeFileSync(
				policyFile(priv),
				JSON.stringify({ schema_version: 2, rules: shuffled }),
			);
			const bytes = nodeFs.readFileSync(policyFile(priv), "utf8");
			const res = ensurePreallowReads({
				configHome: priv,
				workspaceRoot: ws,
				hosts: ["h1"],
				enabled: true,
			});
			expect(res.changed).toBe(false);
			expect(res.warnings).toEqual([]);
			expect(nodeFs.readFileSync(policyFile(priv), "utf8")).toBe(bytes);
		});
	});

	test("rename failure unlinks the temp and rethrows", () => {
		withRealHome(() => {
			const priv = mktmp("t101b-rename-");
			const ws = mktmp("t101b-rename-ws-");
			expect(() =>
				ensurePreallowReads(
					{ configHome: priv, workspaceRoot: ws, hosts: [], enabled: true },
					{
						renameSync: () => {
							throw new Error("boom-rename");
						},
					},
				),
			).toThrow(/boom-rename/);
			expect(nodeFs.readdirSync(path.join(priv, "muse"))).toEqual([]);
			expect(nodeFs.existsSync(policyFile(priv))).toBe(false);
		});
	});
});

describe("no-workspace seeding", () => {
	test("undefined root seeds the network union only, no shell rules", () => {
		withRealHome(() => {
			const priv = mktmp("t101b-nows-");
			const res = ensurePreallowReads({
				configHome: priv,
				hosts: ["h1"],
				enabled: true,
			});
			expect(res.changed).toBe(true);
			expect(res.seededCommands).toEqual([]);
			const rules = readPolicy(priv).rules;
			expect(
				rules.every(
					(r) => (r["rule"] as Record<string, unknown>)["kind"] === "network",
				),
			).toBe(true);
			expect(taggedHosts(priv)).toEqual(["h1"]);
		});
	});

	test("undefined root still prunes dead-root shell rules", () => {
		withRealHome(() => {
			const priv = mktmp("t101b-nows-prune-");
			const dead = path.join(priv, "ws-gone");
			nodeFs.mkdirSync(path.dirname(policyFile(priv)), { recursive: true });
			nodeFs.writeFileSync(
				policyFile(priv),
				JSON.stringify({
					schema_version: 2,
					rules: [
						{
							effect: "allow",
							durability: "local_persistent",
							rule: {
								kind: "shell_command_argv_prefix",
								argv_prefix: ["centrs", "retrieve"],
								workspace_root: dead,
							},
							reason: PREALLOW_TAG,
						},
					],
				}),
			);
			ensurePreallowReads({
				configHome: priv,
				hosts: ["h1"],
				enabled: true,
			});
			const rules = readPolicy(priv).rules;
			expect(
				rules.some(
					(r) =>
						(r["rule"] as Record<string, unknown>)["workspace_root"] === dead,
				),
			).toBe(false);
			expect(taggedHosts(priv)).toEqual(["h1"]);
		});
	});

	test("undefined root with empty union and empty file writes nothing", () => {
		withRealHome(() => {
			const priv = mktmp("t101b-nows-empty-");
			const res = ensurePreallowReads({
				configHome: priv,
				hosts: [],
				enabled: true,
			});
			expect(res.changed).toBe(false);
			expect(nodeFs.existsSync(policyFile(priv))).toBe(false);
		});
	});
});

async function postJson(
	url: string,
	body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
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

describe("T101b server wiring (D44)", () => {
	t101b("boot lays out the private home under the data home", async () => {
		const real = mktmp("t101b-srv-real-");
		seedFakeAuth(real);
		const saved = process.env["XDG_CONFIG_HOME"];
		process.env["XDG_CONFIG_HOME"] = real;
		try {
			const ws = makeWs(["10.0.0.1"]);
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, { workspace: ws });
				try {
					const priv = privateConfigHome(srv.dataHome);
					expect(
						nodeFs.existsSync(path.join(priv, "muse", "settings.json")),
					).toBe(true);
					expect(
						nodeFs
							.lstatSync(path.join(priv, "muse", "auth.json"))
							.isSymbolicLink(),
					).toBe(true);
					expect(nodeFs.existsSync(policyFile(priv))).toBe(true);
					const status = await getJson(`${srv.url}api/status`);
					const pre = status["preallow"] as Record<string, unknown>;
					expect(pre["configHome"]).toBe(priv);
					expect(pre["commands"]).toEqual([
						"centrs retrieve",
						"quickchr list",
						"quickchr doctor",
					]);
				} finally {
					await srv.stop();
				}
			});
		} finally {
			if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
			else process.env["XDG_CONFIG_HOME"] = saved;
		}
	});

	t101b("the real config home is never written", async () => {
		const real = mktmp("t101b-srv-clean-");
		seedFakeAuth(real);
		const before = JSON.stringify(
			nodeFs.readdirSync(path.join(real, "muse")).sort(),
		);
		const saved = process.env["XDG_CONFIG_HOME"];
		process.env["XDG_CONFIG_HOME"] = real;
		try {
			const ws = makeWs(["10.0.0.2"]);
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, { workspace: ws });
				try {
					await postJson(`${srv.url}api/chat/send`, { text: "hello" });
					await postJson(`${srv.url}api/settings`, { preallowReads: false });
					await postJson(`${srv.url}api/settings`, { preallowReads: true });
					await postJson(`${srv.url}api/chat/access`, { mode: "allowAll" });
				} finally {
					await srv.stop();
				}
			});
		} finally {
			if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
			else process.env["XDG_CONFIG_HOME"] = saved;
		}
		expect(
			JSON.stringify(nodeFs.readdirSync(path.join(real, "muse")).sort()),
		).toBe(before);
		expect(
			nodeFs.existsSync(path.join(real, "muse", "approval-policy.json")),
		).toBe(false);
	});

	t101b(
		"union spans registered workspaces; drop + prune converges",
		async () => {
			const real = mktmp("t101b-union-real-");
			seedFakeAuth(real);
			const saved = process.env["XDG_CONFIG_HOME"];
			process.env["XDG_CONFIG_HOME"] = real;
			try {
				const dh = mktmp("t101b-union-dh-");
				const a = makeWs(["shared.lan", "a.lan"]);
				const b = makeWs(["shared.lan", "b.lan"]);
				const { bin, log } = stubT50Bin();
				await withT50Env(log, async () => {
					const priv = privateConfigHome(dh);
					const s1 = await startT50Srv(bin, { dataHome: dh, workspace: a });
					await s1.stop();
					const s2 = await startT50Srv(bin, { dataHome: dh, workspace: b });
					try {
						expect(taggedHosts(priv).sort()).toEqual([
							"a.lan",
							"b.lan",
							"shared.lan",
						]);
						// Workspace a goes away; prune re-seeds the union.
						nodeFs.rmSync(a, { recursive: true, force: true });
						const pruned = await postJson(`${s2.url}api/workspaces`, {
							action: "prune",
						});
						expect(pruned.json["removed"]).toBe(1);
						expect(taggedHosts(priv).sort()).toEqual(["b.lan", "shared.lan"]);
					} finally {
						await s2.stop();
					}
				});
			} finally {
				if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
				else process.env["XDG_CONFIG_HOME"] = saved;
			}
		},
	);

	t101b("router.toml edits re-seed the union", async () => {
		const real = mktmp("t101b-edit-real-");
		seedFakeAuth(real);
		const saved = process.env["XDG_CONFIG_HOME"];
		process.env["XDG_CONFIG_HOME"] = real;
		try {
			const ws = makeWs(["old.lan"]);
			const { bin, log } = stubT50Bin();
			await withT50Env(log, async () => {
				const srv = await startT50Srv(bin, { workspace: ws });
				try {
					const priv = privateConfigHome(srv.dataHome);
					expect(taggedHosts(priv)).toEqual(["old.lan"]);
					const saved = await postJson(`${srv.url}api/file`, {
						path: "router.toml",
						text: '[[device]]\nid = "d0"\nhost = "new.lan"\n',
						fromTomlEditor: true,
					});
					expect(saved.status).toBe(200);
					expect(taggedHosts(priv)).toEqual(["new.lan"]);
				} finally {
					await srv.stop();
				}
			});
		} finally {
			if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
			else process.env["XDG_CONFIG_HOME"] = saved;
		}
	});

	t101b(
		"no-workspace boot ensures the home but seeds no policy file",
		async () => {
			const real = mktmp("t101b-nows-real-");
			seedFakeAuth(real);
			const saved = process.env["XDG_CONFIG_HOME"];
			process.env["XDG_CONFIG_HOME"] = real;
			try {
				const dh = mktmp("t101b-nows-dh-");
				const { bin } = stubT50Bin();
				const srv = await startServer({
					dataHome: dh,
					allowOpenCdb: true,
					noWorkspace: true,
					provider: "echo",
					museHome: mktmp("t101b-nows-home-"),
					toolBinDir: bin,
				});
				try {
					const priv = privateConfigHome(dh);
					expect(
						nodeFs.existsSync(path.join(priv, "muse", "settings.json")),
					).toBe(true);
					expect(
						nodeFs
							.lstatSync(path.join(priv, "muse", "auth.json"))
							.isSymbolicLink(),
					).toBe(true);
					expect(nodeFs.existsSync(policyFile(priv))).toBe(false);
					const status = await getJson(`${srv.url}api/status`);
					expect(status["preallow"]).toBeNull();
				} finally {
					await srv.stop();
				}
			} finally {
				if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
				else process.env["XDG_CONFIG_HOME"] = saved;
			}
		},
	);
});
