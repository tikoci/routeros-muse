// Encrypted new-workspace flow (T133, D52): scaffold creates the
// CDB encrypted via `centrs devices init --encrypt` with the password
// in the child env only (never argv, never logged, never in workspace
// files). No decision = refusal, not a silent open CDB. Hermetic:
// temp dirs (all cleaned in afterAll), stub centrs, temp CDBs; the
// round-trip leg uses the real bundled centrs against temp CDBs.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { parseCli } from "../src/cli/args";
import { decideCdb, decideTemplate } from "../src/lib/cdbSetup";
import { registerWorkspace, registryFile } from "../src/lib/registry";
import { have, run } from "../src/lib/run";
import { Stop } from "../src/lib/stop";
import { toolBinDir, toolEnv } from "../src/lib/tools";
import { scaffoldIntoDir, scaffoldWorkspace } from "../src/lib/workspace";
import {
	backupScanDir,
	detectCdbMode,
	listCdbBackups,
	retainedBackupsWarning,
	verifyCdbPassword,
	workerEnv,
} from "../src/serve/auth";
import {
	checkSameOrigin,
	createCdbMutex,
	defaultLaunchWorkspaceServer,
	type LaunchedWorkspace,
	pickerChildEnv,
	pickFreePort,
	startServer,
	waitForChildReady,
} from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

/** Bundled centrs env: fixtures never depend on ambient PATH. */
function frontedEnv(): Record<string, string> {
	const env = toolEnv(toolBinDir());
	if (!have("centrs", env))
		throw new Error("bundled centrs missing: run bun install");
	return env;
}

afterAll(cleanupTmpdirs);

const POSIX = process.platform !== "win32";
const tposix = POSIX ? test : test.skip;

function writeShim(dir: string, name: string, body: string): void {
	const file = path.join(dir, name);
	nodeFs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	nodeFs.chmodSync(file, 0o755);
}

/**
 * Recording stub bin: `devices init` touches the CDB and logs its
 * argv plus the child-visible CENTRS_CDB_PASSWORD to $T133_LOG.
 */
function recordingCentrsBin(): { bin: string; log: string } {
	const dir = mktmp("t133-recbin-");
	const log = path.join(mktmp("t133-reclog-"), "calls.log");
	writeShim(
		dir,
		"centrs",
		`if [ "$1" = "devices" ] && [ "$2" = "init" ]; then\n` +
			`  echo "argv: $*" >> "$T133_LOG"\n` +
			`  echo "pw: \${CENTRS_CDB_PASSWORD-unset}" >> "$T133_LOG"\n` +
			`  while [ $# -gt 0 ]; do if [ "$1" = "--cdb-file" ]; then : > "$2"; exit 0; fi; shift; done\n` +
			`  exit 1\nfi\nexit 1`,
	);
	return { bin: dir, log };
}

function failingCentrsBin(): string {
	const dir = mktmp("t133-failbin-");
	writeShim(dir, "centrs", "exit 1");
	return dir;
}

/** Stub bin: echoes the child password to stderr, then fails. */
function leakingCentrsBin(): string {
	const dir = mktmp("t133-leakbin-");
	writeShim(
		dir,
		"centrs",
		`echo "init refused for [$CENTRS_CDB_PASSWORD] (argv: $*)" >&2\nexit 1`,
	);
	return dir;
}

function envWithLog(
	bin: string,
	log: string,
	extra?: Record<string, string>,
): Record<string, string> {
	return { ...toolEnv(bin), T133_LOG: log, ...(extra ?? {}) };
}

describe("t133 encrypted scaffold", () => {
	tposix(
		"encrypted scaffold passes --encrypt with the password in env only",
		async () => {
			const { bin, log } = recordingCentrsBin();
			const parent = mktmp("t133-enc-parent-");
			const res = await scaffoldWorkspace(
				parent,
				"ws",
				envWithLog(bin, log),
				"minimal",
				{
					cdb: { kind: "encrypted", password: "s3cret-pw" },
				},
			);
			expect(res.ok).toBe(true);
			const calls = nodeFs.readFileSync(log, "utf8");
			expect(calls).toMatch(/--encrypt/);
			expect(calls).toMatch(/pw: s3cret-pw/);
			// The password rides the child env, never argv.
			expect(calls).not.toMatch(/s3cret-pw.*--cdb-file|--cdb-file.*s3cret-pw/);
			const argvLine =
				calls.split("\n").find((l) => l.startsWith("argv: ")) ?? "";
			expect(argvLine).not.toContain("s3cret-pw");
			expect(nodeFs.existsSync(path.join(parent, "ws", "device.cdb"))).toBe(
				true,
			);
		},
	);

	tposix("ambient CENTRS_CDB_PASSWORD never reaches an open init", async () => {
		const { bin, log } = recordingCentrsBin();
		const parent = mktmp("t133-amb-parent-");
		const res = await scaffoldWorkspace(
			parent,
			"ws",
			envWithLog(bin, log, { CENTRS_CDB_PASSWORD: "ambient-leak" }),
			"minimal",
			{ cdb: { kind: "open" } },
		);
		expect(res.ok).toBe(true);
		const calls = nodeFs.readFileSync(log, "utf8");
		expect(calls).not.toMatch(/--encrypt/);
		expect(calls).toMatch(/pw: unset/);
		expect(calls).not.toContain("ambient-leak");
	});

	tposix(
		"ambient password never overrides the explicit scaffold password",
		async () => {
			const { bin, log } = recordingCentrsBin();
			const parent = mktmp("t133-over-parent-");
			const res = await scaffoldWorkspace(
				parent,
				"ws",
				envWithLog(bin, log, { CENTRS_CDB_PASSWORD: "ambient-leak" }),
				"minimal",
				{ cdb: { kind: "encrypted", password: "explicit-pw" } },
			);
			expect(res.ok).toBe(true);
			const calls = nodeFs.readFileSync(log, "utf8");
			expect(calls).toMatch(/pw: explicit-pw/);
			expect(calls).not.toContain("ambient-leak");
		},
	);

	tposix("no CDB decision refuses without writing anything", async () => {
		const { bin, log } = recordingCentrsBin();
		const parent = mktmp("t133-nodec-parent-");
		const res = await scaffoldWorkspace(
			parent,
			"ws",
			envWithLog(bin, log),
			"minimal",
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.why).toMatch(/refusing.*open device\.cdb/i);
		expect(nodeFs.existsSync(path.join(parent, "ws"))).toBe(false);
		expect(nodeFs.existsSync(log)).toBe(false);
	});

	tposix("empty password refuses without writing anything", async () => {
		const { bin, log } = recordingCentrsBin();
		const parent = mktmp("t133-empty-parent-");
		const res = await scaffoldWorkspace(
			parent,
			"ws",
			envWithLog(bin, log),
			"minimal",
			{
				cdb: { kind: "encrypted", password: "" },
			},
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.why).toMatch(/empty|refusing/i);
		expect(nodeFs.existsSync(path.join(parent, "ws"))).toBe(false);
	});

	tposix("scaffoldIntoDir honors the same encrypted contract", async () => {
		const { bin, log } = recordingCentrsBin();
		const dir = mktmp("t133-into-");
		const res = await scaffoldIntoDir(dir, envWithLog(bin, log), "network", {
			cdb: { kind: "encrypted", password: "net-pw" },
		});
		expect(res.ok).toBe(true);
		const calls = nodeFs.readFileSync(log, "utf8");
		expect(calls).toMatch(/--encrypt/);
		expect(calls).toMatch(/pw: net-pw/);
		expect(nodeFs.existsSync(path.join(dir, "START-HERE.md"))).toBe(true);
	});

	tposix(
		"scaffoldIntoDir without a decision refuses and writes nothing",
		async () => {
			const { bin, log } = recordingCentrsBin();
			const dir = mktmp("t133-intonodec-");
			const res = await scaffoldIntoDir(dir, envWithLog(bin, log), "minimal");
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.why).toMatch(/refusing.*open device\.cdb/i);
			expect(nodeFs.readdirSync(dir)).toEqual([]);
		},
	);

	tposix("centrs failure rolls back the encrypted scaffold", async () => {
		const parent = mktmp("t133-rollback-parent-");
		const res = await scaffoldWorkspace(
			parent,
			"ws",
			toolEnv(failingCentrsBin()),
			"minimal",
			{
				cdb: { kind: "encrypted", password: "pw" },
			},
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.why).toMatch(/centrs devices init failed/);
		expect(nodeFs.existsSync(path.join(parent, "ws"))).toBe(false);
	});

	tposix("failure why never carries the password", async () => {
		const dir = mktmp("t133-leak-");
		const res = await scaffoldIntoDir(
			dir,
			{
				...toolEnv(leakingCentrsBin()),
				CENTRS_CDB_PASSWORD: "ambient-secret-pw",
			},
			"minimal",
			{
				cdb: { kind: "encrypted", password: "super-secret-pw" },
			},
		);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.why).not.toContain("super-secret-pw");
			expect(res.why).not.toContain("ambient-secret-pw");
		}
		expect(nodeFs.readdirSync(dir)).toEqual([]);
	});
});

describe("t133 CDB password decisions", () => {
	function scriptedSecrets(
		answers: (string | null)[],
	): (q: string) => Promise<string | null> {
		let i = 0;
		return async (_q: string) =>
			i < answers.length ? (answers[i++] ?? null) : null;
	}

	test("TTY typed-twice match returns the encrypted decision", async () => {
		const printed: string[] = [];
		const res = await decideCdb({
			passwordStdin: false,
			openCdb: false,
			isTty: true,
			askSecret: scriptedSecrets(["pw-one", "pw-one"]),
			readStdinPassword: async () => null,
			print: (l) => printed.push(l),
		});
		expect(res).toEqual({ kind: "encrypted", password: "pw-one" });
	});

	test("TTY mismatch re-asks, empty re-asks, EOF aborts", async () => {
		const printed: string[] = [];
		const print = (l: string) => printed.push(l);
		const base = {
			passwordStdin: false,
			openCdb: false,
			isTty: true,
			readStdinPassword: async () => null,
			print,
		};
		const mismatch = await decideCdb({
			...base,
			askSecret: scriptedSecrets(["aa", "bb", "cc", "cc"]),
		});
		expect(mismatch).toEqual({ kind: "encrypted", password: "cc" });
		expect(printed.join("\n")).toMatch(/do not match/i);
		const empty = await decideCdb({
			...base,
			askSecret: scriptedSecrets(["", "", "dd", "dd"]),
		});
		expect(empty).toEqual({ kind: "encrypted", password: "dd" });
		expect(printed.join("\n")).toMatch(/must not be empty/i);
		const eof = await decideCdb({
			...base,
			askSecret: scriptedSecrets([null]),
		});
		expect(eof.kind).toBe("abort");
	});

	test("--password-stdin wins without a TTY; empty aborts", async () => {
		const ok = await decideCdb({
			passwordStdin: true,
			openCdb: false,
			isTty: false,
			askSecret: scriptedSecrets([]),
			readStdinPassword: async () => "piped-pw",
			print: () => {},
		});
		expect(ok).toEqual({ kind: "encrypted", password: "piped-pw" });
		const empty = await decideCdb({
			passwordStdin: true,
			openCdb: false,
			isTty: false,
			askSecret: scriptedSecrets([]),
			readStdinPassword: async () => null,
			print: () => {},
		});
		expect(empty.kind).toBe("abort");
	});

	test("--password-stdin and --open-cdb together abort", async () => {
		const res = await decideCdb({
			passwordStdin: true,
			openCdb: true,
			isTty: false,
			askSecret: scriptedSecrets([]),
			readStdinPassword: async () => "x",
			print: () => {},
		});
		expect(res.kind).toBe("abort");
	});

	test("no TTY and no flags aborts naming both escapes", async () => {
		const printed: string[] = [];
		const res = await decideCdb({
			passwordStdin: false,
			openCdb: false,
			isTty: false,
			askSecret: scriptedSecrets([]),
			readStdinPassword: async () => null,
			print: (l) => printed.push(l),
		});
		expect(res.kind).toBe("abort");
		if (res.kind === "abort") {
			expect(res.why).toMatch(/--password-stdin/);
			expect(res.why).toMatch(/--open-cdb/);
		}
	});

	test("--open-cdb returns the explicit open decision", async () => {
		const res = await decideCdb({
			passwordStdin: false,
			openCdb: true,
			isTty: false,
			askSecret: scriptedSecrets([]),
			readStdinPassword: async () => null,
			print: () => {},
		});
		expect(res).toEqual({ kind: "open" });
	});

	test("decideTemplate: given wins, TTY prompts with a minimal default, off-TTY defaults", async () => {
		const given = await decideTemplate({
			given: "network",
			isTty: true,
			ask: async () => "minimal",
			print: () => {},
		});
		expect(given).toEqual({ ok: true, template: "network" });
		const bad = await decideTemplate({
			given: "nope",
			isTty: false,
			ask: async () => null,
			print: () => {},
		});
		expect(bad.ok).toBe(false);
		const prompted = await decideTemplate({
			isTty: true,
			ask: async () => "",
			print: () => {},
		});
		expect(prompted).toEqual({ ok: true, template: "minimal" });
		const reprompt = await decideTemplate({
			isTty: true,
			print: () => {},
			ask: (() => {
				const answers = ["bogus", "network"];
				return async () => answers.shift() ?? null;
			})(),
		});
		expect(reprompt).toEqual({ ok: true, template: "network" });
		const headless = await decideTemplate({
			isTty: false,
			ask: async () => "network",
			print: () => {},
		});
		expect(headless).toEqual({ ok: true, template: "minimal" });
	});
});

describe("t133 picker create + auth mutations", () => {
	const launched: { stop: () => Promise<void> }[] = [];
	const servers: { stop: () => Promise<void> }[] = [];
	afterAll(async () => {
		for (const s of launched) await s.stop();
		for (const s of servers) await s.stop();
	});

	function writeWorkspace(dir: string): void {
		nodeFs.writeFileSync(
			path.join(dir, "workspace.toml"),
			'[home]\ntype = "single-copy"\ncanonical = true\n',
		);
		// resolveStart serves only validated workspaces (AGENTS.md
		// required, like every real scaffold writes).
		nodeFs.writeFileSync(path.join(dir, "AGENTS.md"), "# t133 workspace\n");
		nodeFs.writeFileSync(
			path.join(dir, "router.toml"),
			'[device]\nid = "t133-gw"\nrole = "gateway"\nsite = "lab"\n',
		);
		nodeFs.mkdirSync(path.join(dir, "operations"), { recursive: true });
		nodeFs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
	}

	function track<T extends { stop: () => Promise<void> }>(s: T): T {
		servers.push(s);
		return s;
	}

	/** Fronted centrs (the pinned bundle): fixtures never depend on ambient. */
	async function runFrontedCentrs(args: string[], cdbPassword?: string) {
		const env = frontedEnv();
		if (cdbPassword !== undefined) env["CENTRS_CDB_PASSWORD"] = cdbPassword;
		return run(["centrs", ...args], { timeoutMs: 30_000, env });
	}

	/** Fake child: serves a locked auth state so the ready poll passes. */
	function fakeLockedLauncher(calls: { dir: string; port: number }[]) {
		return async (dir: string, port: number): Promise<LaunchedWorkspace> => {
			calls.push({ dir, port });
			const stub = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () => Response.json({ state: "locked" }),
			});
			launched.push({ stop: async () => stub.stop() });
			return {
				url: `http://127.0.0.1:${stub.port}`,
				stop: async () => stub.stop(),
			};
		};
	}

	function pickerOpts(over?: Record<string, unknown>) {
		// Like the smoke picker: bypassed via --allow-open-cdb against
		// a hermetic (missing) operator store, so /api/workspaces is
		// public without unlocking the real operator CDB.
		return {
			noWorkspace: true,
			provider: "echo",
			allowOpenCdb: true,
			cdbFile: path.join(mktmp("t133-op-"), "operator.cdb"),
			dataHome: mktmp("t133-dh-"),
			configHome: mktmp("t133-cfg-"),
			defaultWorkspaceDir: mktmp("t133-nets-"),
			...(over ?? {}),
		};
	}

	async function post(srv: { url: string }, p: string, body: unknown) {
		const r = await fetch(`${srv.url}${p}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: new URL(srv.url).origin,
			},
			body: JSON.stringify(body),
		});
		return {
			status: r.status,
			json: (await r.json()) as Record<string, unknown>,
		};
	}

	test("create without a password refuses", async () => {
		const srv = track(await startServer(pickerOpts()));
		const res = await post(srv, "/api/workspaces", {
			action: "create",
			name: "nopw",
		});
		expect(res.status).toBe(400);
		expect(res.json["why"]).toMatch(/password/i);
	});

	test("create encrypts, spawns without the password, and returns the URL", async () => {
		const calls: { dir: string; port: number }[] = [];
		const opts = pickerOpts({
			launchWorkspaceServer: fakeLockedLauncher(calls),
		});
		const srv = track(await startServer(opts));
		const res = await post(srv, "/api/workspaces", {
			action: "create",
			name: "encws",
			template: "minimal",
			password: "create-pw-1",
		});
		expect(res.status).toBe(200);
		expect(typeof res.json["url"]).toBe("string");
		expect(res.json["template"]).toBe("minimal");
		expect(res.json).not.toHaveProperty("command");
		expect(res.json).not.toHaveProperty("steering");
		expect(calls.length).toBe(1);
		const call = calls[0] as { dir: string; port: number };
		expect(call.dir).toBe(
			path.join(opts.defaultWorkspaceDir as string, "encws"),
		);
		expect(Number.isInteger(call.port)).toBe(true);
		// The launcher boundary carries dir and port only — never the password.
		expect(JSON.stringify(call)).not.toContain("create-pw-1");
		const mode = await detectCdbMode(
			path.join(call.dir, "device.cdb"),
			frontedEnv(),
		);
		expect(mode.mode).toBe("encrypted");
		expect(
			await verifyCdbPassword(
				path.join(call.dir, "device.cdb"),
				"create-pw-1",
				frontedEnv(),
			),
		).toEqual({
			ok: true,
		});
	});

	test("create with an unknown template refuses", async () => {
		const srv = track(await startServer(pickerOpts()));
		const res = await post(srv, "/api/workspaces", {
			action: "create",
			name: "badtpl",
			template: "nope",
			password: "pw",
		});
		expect(res.status).toBe(400);
	});

	test("encrypt-now converts an open CDB and then locks", async () => {
		const dir = mktmp("t133-openws-");
		writeWorkspace(dir);
		const cdb = path.join(dir, "device.cdb");
		const init = await runFrontedCentrs(["devices", "init", "--cdb-file", cdb]);
		expect(init.ok).toBe(true);
		const srv = track(
			await startServer({
				workspace: dir,
				provider: "echo",
				dataHome: mktmp("t133-dh-"),
				configHome: mktmp("t133-cfg-"),
			}),
		);
		const state0 = (await (
			await fetch(`${srv.url}/api/auth/state`)
		).json()) as {
			state: string;
		};
		expect(state0.state).toBe("open-needs-encryption");
		const enc = await post(srv, "/api/auth/encrypt", {
			password: "now-encrypted",
		});
		expect(enc.status).toBe(200);
		expect(enc.json["ok"]).toBe(true);
		expect(enc.json["backups"]).toEqual([]);
		expect((await detectCdbMode(cdb, frontedEnv())).mode).toBe("encrypted");
		const state1 = (await (
			await fetch(`${srv.url}/api/auth/state`)
		).json()) as {
			state: string;
		};
		expect(state1.state).toBe("locked");
	});

	test("encrypt-now warns about pre-existing plaintext backups", async () => {
		const dir = mktmp("t133-bakws-");
		writeWorkspace(dir);
		const cdb = path.join(dir, "device.cdb");
		expect(
			(await runFrontedCentrs(["devices", "init", "--cdb-file", cdb])).ok,
		).toBe(true);
		nodeFs.writeFileSync(`${cdb}.bak.2026-01-01T00-00-00-000Z`, "plaintext");
		const srv = track(
			await startServer({
				workspace: dir,
				provider: "echo",
				dataHome: mktmp("t133-dh-"),
				configHome: mktmp("t133-cfg-"),
			}),
		);
		const enc = await post(srv, "/api/auth/encrypt", { password: "pw2" });
		expect(enc.status).toBe(200);
		expect(enc.json["backups"]).toEqual([
			`${path.basename(cdb)}.bak.2026-01-01T00-00-00-000Z`,
		]);
	});

	test("encrypt-now refuses when already encrypted or missing", async () => {
		const dir = mktmp("t133-encws-");
		writeWorkspace(dir);
		const cdb = path.join(dir, "device.cdb");
		expect(
			(
				await runFrontedCentrs(
					["devices", "init", "--encrypt", "--cdb-file", cdb],
					"fixture-pw",
				)
			).ok,
		).toBe(true);
		const srv = track(
			await startServer({
				workspace: dir,
				provider: "echo",
				dataHome: mktmp("t133-dh-"),
				configHome: mktmp("t133-cfg-"),
			}),
		);
		const enc = await post(srv, "/api/auth/encrypt", { password: "pw" });
		expect(enc.status).toBe(409);
		expect(String(enc.json["why"])).toMatch(/already encrypted/i);
		const missDir = mktmp("t133-missws-");
		writeWorkspace(missDir);
		const missSrv = track(
			await startServer({
				workspace: missDir,
				provider: "echo",
				dataHome: mktmp("t133-dh-"),
				configHome: mktmp("t133-cfg-"),
			}),
		);
		const missEnc = await post(missSrv, "/api/auth/encrypt", {
			password: "pw",
		});
		expect(missEnc.status).toBe(400);
	});

	test("encrypt-now refuses off loopback", async () => {
		const dir = mktmp("t133-nlbws-");
		writeWorkspace(dir);
		const cdb = path.join(dir, "device.cdb");
		expect(
			(await runFrontedCentrs(["devices", "init", "--cdb-file", cdb])).ok,
		).toBe(true);
		const srv = track(
			await startServer({
				workspace: dir,
				provider: "echo",
				host: "127.0.0.2",
				dataHome: mktmp("t133-dh-"),
				configHome: mktmp("t133-cfg-"),
			}),
		);
		const enc = await post(srv, "/api/auth/encrypt", { password: "pw" });
		expect(enc.status).toBe(403);
		expect((await detectCdbMode(cdb, frontedEnv())).mode).toBe("open");
	});

	test("create-cdb fills a missing workspace registry, then refuses", async () => {
		const dir = mktmp("t133-fillws-");
		writeWorkspace(dir);
		const cdb = path.join(dir, "device.cdb");
		const srv = track(
			await startServer({
				workspace: dir,
				provider: "echo",
				dataHome: mktmp("t133-dh-"),
				configHome: mktmp("t133-cfg-"),
			}),
		);
		const state0 = (await (
			await fetch(`${srv.url}/api/auth/state`)
		).json()) as {
			state: string;
		};
		expect(state0.state).toBe("missing");
		const created = await post(srv, "/api/auth/create-cdb", {
			password: "fresh-pw",
		});
		expect(created.status).toBe(200);
		expect((await detectCdbMode(cdb, frontedEnv())).mode).toBe("encrypted");
		const again = await post(srv, "/api/auth/create-cdb", {
			password: "other",
		});
		expect(again.status).toBe(409);
		expect(String(again.json["why"])).toMatch(/already encrypted/i);
	});

	test("create-cdb refuses open registries and operator scope", async () => {
		const dir = mktmp("t133-fillopen-");
		writeWorkspace(dir);
		const cdb = path.join(dir, "device.cdb");
		expect(
			(await runFrontedCentrs(["devices", "init", "--cdb-file", cdb])).ok,
		).toBe(true);
		const srv = track(
			await startServer({
				workspace: dir,
				provider: "echo",
				dataHome: mktmp("t133-dh-"),
				configHome: mktmp("t133-cfg-"),
			}),
		);
		const res = await post(srv, "/api/auth/create-cdb", { password: "pw" });
		expect(res.status).toBe(400);
		const nws = track(await startServer(pickerOpts()));
		const opRes = await post(nws, "/api/auth/create-cdb", { password: "pw" });
		expect(opRes.status).toBe(400);
		expect(String(opRes.json["why"])).toMatch(/workspace/i);
	});

	test("listCdbBackups lists only bak siblings, sorted", () => {
		const dir = mktmp("t133-baks-");
		const cdb = path.join(dir, "device.cdb");
		nodeFs.writeFileSync(cdb, "x");
		nodeFs.writeFileSync(`${cdb}.bak.b`, "x");
		nodeFs.writeFileSync(`${cdb}.bak.a`, "x");
		nodeFs.writeFileSync(path.join(dir, "other.txt"), "x");
		expect(listCdbBackups(cdb)).toEqual([
			"device.cdb.bak.a",
			"device.cdb.bak.b",
		]);
		expect(listCdbBackups(path.join(dir, "nope.cdb"))).toEqual([]);
	});

	test("default launcher spawns the CLI entry and lands locked", async () => {
		const dir = mktmp("t133-childws-");
		writeWorkspace(dir);
		const cdb = path.join(dir, "device.cdb");
		expect(
			(
				await runFrontedCentrs(
					["devices", "init", "--encrypt", "--cdb-file", cdb],
					"child-pw",
				)
			).ok,
		).toBe(true);
		const port = await pickFreePort();
		const child = await defaultLaunchWorkspaceServer(
			dir,
			port,
			toolEnv(toolBinDir()),
			{ provider: "echo", dataHome: mktmp("t133-child-dh-") },
		);
		launched.push({ stop: () => child.stop() });
		try {
			const ready = await waitForChildReady(child.url, 30_000);
			expect(ready).toEqual({ ok: true, state: "locked" });
			const r = await fetch(`${child.url}/api/auth/unlock`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: new URL(child.url).origin,
				},
				body: JSON.stringify({ password: "child-pw" }),
			});
			expect(((await r.json()) as { ok: unknown }).ok).toBe(true);
		} finally {
			await child.stop();
		}
	}, 60_000);

	test("waitForChildReady resolves locked, times out on silence", async () => {
		const stub = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ state: "locked" }),
		});
		try {
			const ready = await waitForChildReady(
				`http://127.0.0.1:${stub.port}`,
				5000,
			);
			expect(ready).toEqual({ ok: true, state: "locked" });
		} finally {
			stub.stop();
		}
		const silent = await waitForChildReady("http://127.0.0.1:1", 1500);
		expect(silent.ok).toBe(false);
	});
});

describe("t133 CLI flags", () => {
	test("init takes --template, --password-stdin, --open-cdb", () => {
		const p = parseCli(["init", "--template", "network", "--password-stdin"]);
		expect(p.cmd).toBe("init");
		if (p.cmd === "init") {
			expect(p.opts.template).toBe("network");
			expect(p.opts.passwordStdin).toBe(true);
			expect(p.opts.openCdb).toBe(false);
		}
		const o = parseCli(["init", "--open-cdb"]);
		if (o.cmd === "init") expect(o.opts.openCdb).toBe(true);
	});

	test("start takes --template, --password-stdin, --open-cdb", () => {
		const p = parseCli(["start", "--password-stdin", "--template", "minimal"]);
		expect(p.cmd).toBe("start");
		if (p.cmd === "start") {
			expect(p.opts.passwordStdin).toBe(true);
			expect(p.opts.template).toBe("minimal");
		}
	});

	test("conflicting create flags stop with usage", () => {
		expect(() => parseCli(["init", "--password-stdin", "--open-cdb"])).toThrow(
			Stop,
		);
		expect(() => parseCli(["start", "--password-stdin", "--open-cdb"])).toThrow(
			Stop,
		);
		expect(() => parseCli(["init", "--template", "bogus"])).toThrow(Stop);
	});
});

describe("t133 encrypted scaffold, real centrs", () => {
	test("real centrs round trip: encrypted scaffold unlocks with the password", async () => {
		const parent = mktmp("t133-real-parent-");
		const res = await scaffoldWorkspace(parent, "ws", frontedEnv(), "minimal", {
			cdb: { kind: "encrypted", password: "real-roundtrip-pw" },
		});
		expect(res.ok).toBe(true);
		const cdb = path.join(parent, "ws", "device.cdb");
		expect((await detectCdbMode(cdb, frontedEnv())).mode).toBe("encrypted");
		expect(
			await verifyCdbPassword(cdb, "real-roundtrip-pw", frontedEnv()),
		).toEqual({
			ok: true,
		});
		const wrong = await verifyCdbPassword(cdb, "nope", frontedEnv());
		expect(wrong.ok).toBe(false);
	});
});

describe("t133 review fixes", () => {
	function originOf(url: string): string {
		return new URL(url).origin;
	}

	/** A cross-origin simple POST: text/plain, foreign Origin, no preflight. */
	async function csrfPost(url: string, p: string) {
		const r = await fetch(`${url}${p}`, {
			method: "POST",
			headers: {
				"content-type": "text/plain",
				origin: "https://evil.example",
			},
			body: JSON.stringify({ password: "attacker-pw" }),
		});
		return { status: r.status, json: (await r.json()) as { ok: unknown } };
	}

	function openWorkspaceDir(): string {
		const dir = mktmp("t133-csrfws-");
		nodeFs.writeFileSync(
			path.join(dir, "workspace.toml"),
			'[home]\ntype = "single-copy"\ncanonical = true\n',
		);
		nodeFs.writeFileSync(path.join(dir, "AGENTS.md"), "# t133\n");
		nodeFs.writeFileSync(
			path.join(dir, "router.toml"),
			'[device]\nid = "t133-gw"\nrole = "gateway"\nsite = "lab"\n',
		);
		nodeFs.mkdirSync(path.join(dir, "operations"), { recursive: true });
		nodeFs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
		return dir;
	}

	test("P1 cross-origin simple POSTs are rejected on every guarded route", async () => {
		const dir = openWorkspaceDir();
		const cdb = path.join(dir, "device.cdb");
		const env = (() => {
			const e = (() => {
				const inner = toolEnv(toolBinDir());
				if (!have("centrs", inner))
					throw new Error("bundled centrs missing: run bun install");
				return inner;
			})();
			return e;
		})();
		expect(
			(
				await run(["centrs", "devices", "init", "--cdb-file", cdb], {
					timeoutMs: 30_000,
					env,
				})
			).ok,
		).toBe(true);
		const srv = await startServer({
			workspace: dir,
			provider: "echo",
			dataHome: mktmp("t133-csrf-dh-"),
			configHome: mktmp("t133-csrf-cfg-"),
		});
		try {
			for (const p of [
				"/api/auth/unlock",
				"/api/auth/encrypt",
				"/api/auth/create-cdb",
				"/api/auth/lock",
			]) {
				const res = await csrfPost(srv.url, p);
				expect(res.status).toBe(403);
				expect(res.json.ok).toBe(false);
			}
			// The attacker's password must not have taken effect.
			expect((await detectCdbMode(cdb, env)).mode).toBe("open");
			// Missing Origin is rejected too.
			const noOrigin = await fetch(`${srv.url}/api/auth/encrypt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ password: "attacker-pw" }),
			});
			expect(noOrigin.status).toBe(403);
			expect((await detectCdbMode(cdb, env)).mode).toBe("open");
			// Wrong content-type is rejected even with the right Origin.
			const wrongCt = await fetch(`${srv.url}/api/auth/encrypt`, {
				method: "POST",
				headers: {
					"content-type": "text/plain",
					origin: originOf(srv.url),
				},
				body: JSON.stringify({ password: "attacker-pw" }),
			});
			expect(wrongCt.status).toBe(403);
			expect((await detectCdbMode(cdb, env)).mode).toBe("open");
		} finally {
			await srv.stop();
		}
	});

	test("P1 workspaces POST rejects cross-origin simple requests", async () => {
		const srv = await startServer({
			noWorkspace: true,
			provider: "echo",
			allowOpenCdb: true,
			cdbFile: path.join(mktmp("t133-csrfop-"), "operator.cdb"),
			dataHome: mktmp("t133-csrf-dh2-"),
			configHome: mktmp("t133-csrf-cfg2-"),
			defaultWorkspaceDir: mktmp("t133-csrf-nets-"),
		});
		try {
			const res = await csrfPost(srv.url, "/api/workspaces");
			expect(res.status).toBe(403);
		} finally {
			await srv.stop();
		}
	});

	test("P1 guard unit: foreign Host and foreign Origin refused", () => {
		const ctx = { host: "127.0.0.1", port: 4321, displayHost: "127.0.0.1" };
		const good = new Request("http://127.0.0.1:4321/api/auth/unlock", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://127.0.0.1:4321",
				host: "127.0.0.1:4321",
			},
		});
		expect(checkSameOrigin(good, ctx)).toBeNull();
		const evilOrigin = new Request("http://127.0.0.1:4321/api/auth/unlock", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://evil.example",
				host: "127.0.0.1:4321",
			},
		});
		expect(checkSameOrigin(evilOrigin, ctx)).toMatch(/origin/i);
		const evilHost = new Request("http://127.0.0.1:4321/api/auth/unlock", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://127.0.0.1:4321",
				host: "evil.example",
			},
		});
		expect(checkSameOrigin(evilHost, ctx)).toMatch(/host/i);
	});

	test("P1 workerEnv strips an ambient CENTRS_CDB_PASSWORD", () => {
		const base = {
			PATH: "/bin",
			CENTRS_CDB_PASSWORD: "ambient-leak",
		};
		expect(workerEnv(base, "/tmp/x.cdb", null)).toEqual({
			PATH: "/bin",
			CENTRS_CDB_FILE: "/tmp/x.cdb",
		});
		// An explicit unlock password still rides.
		expect(
			workerEnv(base, "/tmp/x.cdb", "session-pw")["CENTRS_CDB_PASSWORD"],
		).toBe("session-pw");
	});

	test("P1 picker child env never carries CENTRS_CDB_PASSWORD", () => {
		const tools = {
			PATH: "/bin",
			CENTRS_CDB_PASSWORD: "picker-ambient-leak",
		};
		const env = pickerChildEnv(tools, "/tmp/datahome");
		expect(env["CENTRS_CDB_PASSWORD"]).toBeUndefined();
		expect(env["PATH"]).toContain("/bin");
	});

	test("P1 per-path CDB mutex serializes detect+mutate", async () => {
		const mutex = createCdbMutex();
		const gate = (into: string[], name: string, ms: number) => async () => {
			into.push(`${name}-in`);
			await new Promise((r) => setTimeout(r, ms));
			into.push(`${name}-out`);
		};
		const order: string[] = [];
		await Promise.all([
			mutex("/tmp/same.cdb", gate(order, "a", 50)),
			mutex("/tmp/same.cdb", gate(order, "b", 1)),
		]);
		// Same key serializes: b waits for a.
		expect(order).toEqual(["a-in", "a-out", "b-in", "b-out"]);
		// Different keys run together.
		const order2: string[] = [];
		await Promise.all([
			mutex("/tmp/one.cdb", gate(order2, "a", 50)),
			mutex("/tmp/two.cdb", gate(order2, "b", 1)),
		]);
		expect(order2[0]).toBe("a-in");
		expect(order2[1]).toBe("b-in");
	});

	test("P1 concurrent encrypt-now: one wins, the other is a 409", async () => {
		const dir = openWorkspaceDir();
		const cdb = path.join(dir, "device.cdb");
		const env = toolEnv(toolBinDir());
		expect(
			(
				await run(["centrs", "devices", "init", "--cdb-file", cdb], {
					timeoutMs: 30_000,
					env,
				})
			).ok,
		).toBe(true);
		const srv = await startServer({
			workspace: dir,
			provider: "echo",
			dataHome: mktmp("t133-race-dh-"),
			configHome: mktmp("t133-race-cfg-"),
		});
		try {
			const origin = originOf(srv.url);
			const fire = (pw: string) =>
				fetch(`${srv.url}/api/auth/encrypt`, {
					method: "POST",
					headers: { "content-type": "application/json", origin },
					body: JSON.stringify({ password: pw }),
				}).then(async (r) => ({
					status: r.status,
					json: (await r.json()) as { ok: unknown },
				}));
			const [first, second] = await Promise.all([
				fire("race-pw-one"),
				fire("race-pw-two"),
			]);
			const statuses = [first.status, second.status].sort();
			expect(statuses).toEqual([200, 409]);
			const winners = [first, second].filter((r) => r.status === 200);
			expect(winners).toHaveLength(1);
			expect((await detectCdbMode(cdb, env)).mode).toBe("encrypted");
		} finally {
			await srv.stop();
		}
	}, 60_000);

	test("P2 bypass drops the moment encrypt-now succeeds", async () => {
		const dir = openWorkspaceDir();
		const cdb = path.join(dir, "device.cdb");
		const env = toolEnv(toolBinDir());
		expect(
			(
				await run(["centrs", "devices", "init", "--cdb-file", cdb], {
					timeoutMs: 30_000,
					env,
				})
			).ok,
		).toBe(true);
		const srv = await startServer({
			workspace: dir,
			provider: "echo",
			allowOpenCdb: true,
			dataHome: mktmp("t133-byp-dh-"),
			configHome: mktmp("t133-byp-cfg-"),
		});
		try {
			const origin = originOf(srv.url);
			expect(await (await fetch(`${srv.url}/api/tree`)).json()).toHaveProperty(
				"entries",
			);
			const enc = await fetch(`${srv.url}/api/auth/encrypt`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({ password: "bypass-pw" }),
			});
			expect(enc.status).toBe(200);
			const tree = await fetch(`${srv.url}/api/tree`);
			expect(tree.status).toBe(401);
			const state = (await (
				await fetch(`${srv.url}/api/auth/state`)
			).json()) as { state: string };
			expect(state.state).toBe("locked");
		} finally {
			await srv.stop();
		}
	});

	test("P2 backup scan resolves the operator CDB path, warns when unknown", () => {
		const dir = mktmp("t133-scan-");
		const cdb = path.join(dir, "device.cdb");
		nodeFs.writeFileSync(cdb, "x");
		nodeFs.writeFileSync(`${cdb}.bak.2026-01-01T00-00-00-000Z`, "old");
		// Bound path wins.
		expect(backupScanDir(cdb, {}, null)).toBe(cdb);
		// Operator scope: the spawn env binding resolves it.
		expect(backupScanDir(null, { CENTRS_CDB_FILE: cdb }, null)).toBe(cdb);
		// Operator scope: the mutation envelope's reported path resolves it.
		expect(backupScanDir(null, {}, cdb)).toBe(cdb);
		// Nothing resolvable: an explicit warning, not silence.
		expect(backupScanDir(null, {}, null)).toBeNull();
		expect(retainedBackupsWarning()).toMatch(/plaintext/i);
	});

	test("P2 readiness aborts a hanging listener within budget", async () => {
		const hanging = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Promise<Response>(() => {}),
		});
		try {
			const started = Date.now();
			const res = await waitForChildReady(
				`http://127.0.0.1:${hanging.port}`,
				2000,
			);
			const elapsed = Date.now() - started;
			expect(res.ok).toBe(false);
			expect(elapsed).toBeLessThan(2000 + 1500);
		} finally {
			hanging.stop();
		}
	});

	test("P2 picker stop terminates the spawned child", async () => {
		const dir = openWorkspaceDir();
		const cdb = path.join(dir, "device.cdb");
		const env = toolEnv(toolBinDir());
		expect(
			(
				await run(
					["centrs", "devices", "init", "--encrypt", "--cdb-file", cdb],
					{
						timeoutMs: 30_000,
						env: { ...env, CENTRS_CDB_PASSWORD: "child-pw" },
					},
				)
			).ok,
		).toBe(true);
		const picker = await startServer({
			noWorkspace: true,
			provider: "echo",
			allowOpenCdb: true,
			cdbFile: path.join(mktmp("t133-orphop-"), "operator.cdb"),
			dataHome: mktmp("t133-orph-dh-"),
			configHome: mktmp("t133-orph-cfg-"),
			defaultWorkspaceDir: mktmp("t133-orph-nets-"),
		});
		try {
			const origin = originOf(picker.url);
			const created = await fetch(`${picker.url}/api/workspaces`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({
					action: "create",
					name: "orphanws",
					password: "orphan-pw",
				}),
			});
			const body = (await created.json()) as {
				ok: unknown;
				url?: string;
			};
			expect(body.ok).toBe(true);
			expect(typeof body.url).toBe("string");
			const childUrl = body.url as string;
			expect(
				(
					(await (await fetch(`${childUrl}/api/auth/state`)).json()) as {
						state: unknown;
					}
				).state,
			).toBe("locked");
			await picker.stop();
			// The child is gone with the picker: the port stops answering.
			let answered = false;
			for (let i = 0; i < 20 && !answered; i++) {
				try {
					await fetch(`${childUrl}/api/auth/state`);
					answered = true;
					await new Promise((r) => setTimeout(r, 250));
				} catch {
					answered = false;
					break;
				}
			}
			expect(answered).toBe(false);
		} finally {
			await picker.stop().catch(() => {});
		}
	}, 120_000);

	test("P2 create launch failure returns partial created:true", async () => {
		const nets = mktmp("t133-partial-nets-");
		const srv = await startServer({
			noWorkspace: true,
			provider: "echo",
			allowOpenCdb: true,
			cdbFile: path.join(mktmp("t133-partial-op-"), "operator.cdb"),
			dataHome: mktmp("t133-partial-dh-"),
			configHome: mktmp("t133-partial-cfg-"),
			defaultWorkspaceDir: nets,
			launchWorkspaceServer: async () => {
				throw new Error("boom: no runtime");
			},
		});
		try {
			const origin = originOf(srv.url);
			const r = await fetch(`${srv.url}/api/workspaces`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({
					action: "create",
					name: "halfws",
					password: "half-pw",
				}),
			});
			const body = (await r.json()) as Record<string, unknown>;
			expect(body["ok"]).toBe(false);
			expect(body["created"]).toBe(true);
			expect(typeof body["command"]).toBe("string");
			expect(typeof body["why"]).toBe("string");
			expect(nodeFs.existsSync(path.join(nets, "halfws", "device.cdb"))).toBe(
				true,
			);
		} finally {
			await srv.stop();
		}
	});

	test("P2 open uses spawn+redirect (Retry = open)", async () => {
		const dh = mktmp("t133-reopen-dh-");
		const dir = path.join(dh, "retryws");
		nodeFs.mkdirSync(dir, { recursive: true });
		nodeFs.writeFileSync(
			path.join(dir, "workspace.toml"),
			'[home]\ntype = "single-copy"\ncanonical = true\n',
		);
		nodeFs.writeFileSync(path.join(dir, "AGENTS.md"), "# t133\n");
		registerWorkspace(registryFile(dh), "retryws", dir);
		const stub = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ state: "locked" }),
		});
		const srv = await startServer({
			noWorkspace: true,
			provider: "echo",
			allowOpenCdb: true,
			cdbFile: path.join(mktmp("t133-reopen-op-"), "operator.cdb"),
			dataHome: dh,
			configHome: mktmp("t133-reopen-cfg-"),
			defaultWorkspaceDir: mktmp("t133-reopen-nets-"),
			launchWorkspaceServer: async () => ({
				url: `http://127.0.0.1:${stub.port}`,
				stop: async () => {},
			}),
		});
		try {
			const origin = originOf(srv.url);
			const r = await fetch(`${srv.url}/api/workspaces`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({ action: "open", name: "retryws" }),
			});
			const body = (await r.json()) as Record<string, unknown>;
			expect(body["ok"]).toBe(true);
			expect(body["url"]).toBe(`http://127.0.0.1:${stub.port}`);
		} finally {
			await srv.stop();
			stub.stop();
		}
	});
});
