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
import { have, run } from "../src/lib/run";
import { Stop } from "../src/lib/stop";
import { toolBinDir, toolEnv } from "../src/lib/tools";
import { scaffoldIntoDir, scaffoldWorkspace } from "../src/lib/workspace";
import {
	detectCdbMode,
	listCdbBackups,
	verifyCdbPassword,
} from "../src/serve/auth";
import {
	defaultLaunchWorkspaceServer,
	type LaunchedWorkspace,
	pickFreePort,
	startServer,
	waitForChildReady,
} from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

const POSIX = process.platform !== "win32";
const tposix = POSIX ? test : test.skip;
const HAVE_CENTRS = have("centrs");
const tcentrs = HAVE_CENTRS ? test : test.skip;

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

	/** Fronted centrs (the pinned 0.1.9): fixtures never depend on ambient. */
	async function runFrontedCentrs(args: string[], cdbPassword?: string) {
		const env = toolEnv(toolBinDir());
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
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return {
			status: r.status,
			json: (await r.json()) as Record<string, unknown>,
		};
	}

	tcentrs("create without a password refuses", async () => {
		const srv = track(await startServer(pickerOpts()));
		const res = await post(srv, "/api/workspaces", {
			action: "create",
			name: "nopw",
		});
		expect(res.status).toBe(400);
		expect(res.json["why"]).toMatch(/password/i);
	});

	tcentrs(
		"create encrypts, spawns without the password, and returns the URL",
		async () => {
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
			const mode = await detectCdbMode(path.join(call.dir, "device.cdb"));
			expect(mode.mode).toBe("encrypted");
			expect(
				await verifyCdbPassword(
					path.join(call.dir, "device.cdb"),
					"create-pw-1",
				),
			).toEqual({
				ok: true,
			});
		},
	);

	tcentrs("create with an unknown template refuses", async () => {
		const srv = track(await startServer(pickerOpts()));
		const res = await post(srv, "/api/workspaces", {
			action: "create",
			name: "badtpl",
			template: "nope",
			password: "pw",
		});
		expect(res.status).toBe(400);
	});

	tcentrs("encrypt-now converts an open CDB and then locks", async () => {
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
		expect((await detectCdbMode(cdb)).mode).toBe("encrypted");
		const state1 = (await (
			await fetch(`${srv.url}/api/auth/state`)
		).json()) as {
			state: string;
		};
		expect(state1.state).toBe("locked");
	});

	tcentrs(
		"encrypt-now warns about pre-existing plaintext backups",
		async () => {
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
		},
	);

	tcentrs("encrypt-now refuses when already encrypted or missing", async () => {
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
		expect(enc.status).toBe(400);
		expect(String(enc.json["why"])).toMatch(/already encrypted|refusing/i);
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

	tcentrs("encrypt-now refuses off loopback", async () => {
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
		expect((await detectCdbMode(cdb)).mode).toBe("open");
	});

	tcentrs(
		"create-cdb fills a missing workspace registry, then refuses",
		async () => {
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
			expect((await detectCdbMode(cdb)).mode).toBe("encrypted");
			const again = await post(srv, "/api/auth/create-cdb", {
				password: "other",
			});
			expect(again.status).toBe(400);
			expect(String(again.json["why"])).toMatch(/already encrypted|refusing/i);
		},
	);

	tcentrs("create-cdb refuses open registries and operator scope", async () => {
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

	tcentrs(
		"default launcher spawns the CLI entry and lands locked",
		async () => {
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
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ password: "child-pw" }),
				});
				expect(((await r.json()) as { ok: unknown }).ok).toBe(true);
			} finally {
				await child.stop();
			}
		},
		60_000,
	);

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
	tcentrs(
		"real centrs round trip: encrypted scaffold unlocks with the password",
		async () => {
			const parent = mktmp("t133-real-parent-");
			const res = await scaffoldWorkspace(
				parent,
				"ws",
				toolEnv(null),
				"minimal",
				{
					cdb: { kind: "encrypted", password: "real-roundtrip-pw" },
				},
			);
			expect(res.ok).toBe(true);
			const cdb = path.join(parent, "ws", "device.cdb");
			expect((await detectCdbMode(cdb)).mode).toBe("encrypted");
			expect(await verifyCdbPassword(cdb, "real-roundtrip-pw")).toEqual({
				ok: true,
			});
			const wrong = await verifyCdbPassword(cdb, "nope");
			expect(wrong.ok).toBe(false);
		},
	);
});
