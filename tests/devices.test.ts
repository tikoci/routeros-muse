// CLI fleet reads (T40): `devices list` + `devices stats` through the
// fronted bundle with the T64 fail-closed binding. Hermetic: stub
// shims or seeded temp CDBs, never the network (documentation
// addresses and decrypt-failed legs only), no live meta turns.
import { describe, expect, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	bindCdb,
	devicesList,
	devicesStats,
	parseDevices,
	resolveCliWorkspace,
} from "../src/cli/devices";
import { askSecret } from "../src/lib/prompt";
import { have } from "../src/lib/run";
import { Stop } from "../src/lib/stop";
import { toolBinDir } from "../src/lib/tools";

const BUN = Bun.which("bun");
const HAVE_CENTRS = have("centrs");
const HAVE_SCRIPT = have("script");
const POSIX = process.platform !== "win32";
const tstub = POSIX ? test : test.skip;
const tcentrs = POSIX && HAVE_CENTRS ? test : test.skip;
const tcli = POSIX && BUN !== null ? test : test.skip;
const tpty =
	POSIX && BUN !== null && HAVE_CENTRS && HAVE_SCRIPT ? test : test.skip;

const ENCRYPTED_FIXTURE = path.join(
	import.meta.dir,
	"fixtures",
	"cdb-encrypted-empty.cdb",
);
const FIXTURE_PASSWORD = "t39-fixture-password";

function makeCliWorkspace(routerToml: string): string {
	const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t40-cli-ws-"));
	nodeFs.writeFileSync(path.join(dir, "workspace.toml"), "canonical = true\n");
	nodeFs.writeFileSync(path.join(dir, "AGENTS.md"), "# ws\n");
	nodeFs.writeFileSync(path.join(dir, "router.toml"), routerToml);
	return dir;
}

function writeShim(dir: string, name: string, body: string): void {
	const file = path.join(dir, name);
	nodeFs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	nodeFs.chmodSync(file, 0o755);
}

describe("devices args + workspace", () => {
	test("parseDevices splits list/stats, --cdb-file, rejects junk", () => {
		expect(parseDevices(["list"])).toEqual({
			cmd: "list",
			workspace: undefined,
		});
		expect(
			parseDevices(["stats", "gw", "./ws", "--cdb-file", "/x.cdb"]),
		).toEqual({
			cmd: "stats",
			id: "gw",
			workspace: "./ws",
			cdbFile: "/x.cdb",
		});
		expect(parseDevices(["stats", "gw"])).toEqual({
			cmd: "stats",
			id: "gw",
			workspace: undefined,
		});
		expect(parseDevices(["stats", "gw", "./ws"])).toEqual({
			cmd: "stats",
			id: "gw",
			workspace: "./ws",
		});
		expect(() => parseDevices([])).toThrow(Stop);
		expect(() => parseDevices(["stats"])).toThrow(Stop);
		expect(() => parseDevices(["stats", "a", "b", "c"])).toThrow(Stop);
		expect(() => parseDevices(["frobnicate"])).toThrow(Stop);
		expect(() => parseDevices(["list", "--bogus"])).toThrow(Stop);
		expect(() => parseDevices(["list", "--cdb-file"])).toThrow(Stop);
		expect(() =>
			parseDevices(["list", "./ws", "--cdb-file", "/x.cdb"]),
		).toThrow(Stop);
	});

	test("resolveCliWorkspace defaults to cwd, refuses non-workspaces", () => {
		const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t40-cli-nows-"));
		expect(() => resolveCliWorkspace(dir)).toThrow(Stop);
		const ws = makeCliWorkspace('[device]\nid = "a"\n');
		expect(resolveCliWorkspace(ws)).toBe(ws);
	});

	test("bindCdb is the workspace device.cdb unless overridden", () => {
		expect(bindCdb("/ws", undefined)).toBe("/ws/device.cdb");
		expect(bindCdb("/ws", "/o.cdb")).toBe("/o.cdb");
	});

	test("askSecret is null off a TTY (stdin piped under bun test)", async () => {
		if (process.stdin.isTTY) return;
		expect(await askSecret("pw:")).toBeNull();
	});
});

describe("devicesList", () => {
	test("formats present fields, names the file when empty", async () => {
		const ws = makeCliWorkspace(
			'[device]\nid = "test-gw"\nrole = "gateway"\nsite = "lab"\ncdb = "office-gw"\nuser = "admin"\n',
		);
		const full = await devicesList(ws);
		expect(full.exit).toBe(0);
		expect(full.err).toBe("");
		expect(full.out).toBe(
			"test-gw site=lab role=gateway cdb=office-gw user=admin\n",
		);
		const empty = makeCliWorkspace('note = "no devices"\n');
		const none = await devicesList(empty);
		expect(none.exit).toBe(0);
		expect(none.out).toBe(`no devices in ${path.join(empty, "router.toml")}\n`);
	});
});

describe("devicesStats", () => {
	tstub(
		"env passthrough feeds the stub bundle without prompting",
		async () => {
			const ws = makeCliWorkspace(
				'[device]\nid = "stub-gw"\ncdb = "stub-gw"\n',
			);
			const bin = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t40-devbin-"));
			const log = path.join(bin, "seen.log");
			writeShim(
				bin,
				"centrs",
				[
					`LOG=${JSON.stringify(log)}`,
					`echo "PATH0=$(printf '%s' "$PATH" | cut -d: -f1)" >> "$LOG"`,
					`[ -n "$CENTRS_CDB_PASSWORD" ] && echo "PW_SET=yes" >> "$LOG" || echo "PW_SET=no" >> "$LOG"`,
					`[ "$CENTRS_CDB_PASSWORD" = "pw-passthrough" ] && echo "PW_MATCH=yes" >> "$LOG" || echo "PW_MATCH=no" >> "$LOG"`,
					`echo "CDB_FILE=$CENTRS_CDB_FILE" >> "$LOG"`,
					`echo "ARGV=$*" >> "$LOG"`,
					`if [ "$1" = "devices" ]; then`,
					`  printf '%s\\n' '{"ok":false,"error":{"code":"cdb/password-required","summary":"locked"}}' >&2; exit 1`,
					`fi`,
					`printf '%s\\n' '{"ok":true,"data":{"name":"stub-gw"},"warnings":[],"tips":[],"meta":{}}'`,
				].join("\n"),
			);
			let prompted = 0;
			const res = await devicesStats(ws, "stub-gw", "/ws/device.cdb", {
				toolBinDir: bin,
				// Ambient PATH stays: the bundle fronts it, so the stub
				// still wins first while `sh` keeps resolving.
				baseEnv: {
					...process.env,
					CENTRS_CDB_PASSWORD: "pw-passthrough",
				},
				prompter: async () => {
					prompted++;
					return "should-never-prompt";
				},
			});
			expect(prompted).toBe(0);
			expect(res.exit).toBe(0);
			expect(res.out).toContain("stub-gw");
			const seen = nodeFs.readFileSync(log, "utf8");
			// Fronted-bundle resolution: the stub answered, from the front.
			expect(seen).toContain(`PATH0=${bin}`);
			// Fail-closed binding on both channels: env + argv.
			expect(seen).toContain("CDB_FILE=/ws/device.cdb");
			expect(seen).toContain("--cdb-file /ws/device.cdb");
			// Passthrough value reached the child (presence + match markers
			// only — the shim never logs the password itself).
			expect(seen).toContain("PW_SET=yes");
			expect(seen).toContain("PW_MATCH=yes");
			expect(seen).not.toContain("pw-passthrough");
		},
		30_000,
	);

	tstub(
		"prompted password reaches the child; null prompt stops",
		async () => {
			const ws = makeCliWorkspace(
				'[device]\nid = "stub-gw"\ncdb = "stub-gw"\n',
			);
			const bin = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t40-devbin-"));
			const log = path.join(bin, "seen.log");
			writeShim(
				bin,
				"centrs",
				[
					`LOG=${JSON.stringify(log)}`,
					`[ "$CENTRS_CDB_PASSWORD" = "pw-prompted" ] && echo "PW_MATCH=yes" >> "$LOG" || echo "PW_MATCH=no" >> "$LOG"`,
					`if [ "$1" = "devices" ]; then`,
					`  printf '%s\\n' '{"ok":false,"error":{"code":"cdb/password-required","summary":"locked"}}' >&2; exit 1`,
					`fi`,
					`printf '%s\\n' '{"ok":true,"data":{},"warnings":[],"tips":[],"meta":{}}'`,
				].join("\n"),
			);
			const baseEnv = { ...process.env };
			delete baseEnv["CENTRS_CDB_PASSWORD"];
			let question = "";
			const ok = await devicesStats(ws, "stub-gw", "/ws/device.cdb", {
				toolBinDir: bin,
				baseEnv,
				prompter: async (q) => {
					question = q;
					return "pw-prompted";
				},
			});
			expect(ok.exit).toBe(0);
			expect(question).toContain("/ws/device.cdb");
			expect(nodeFs.readFileSync(log, "utf8")).toContain("PW_MATCH=yes");
			const refused = await devicesStats(ws, "stub-gw", "/ws/device.cdb", {
				toolBinDir: bin,
				baseEnv,
				prompter: async () => null,
			});
			expect(refused.exit).toBe(2);
			expect(refused.err).toContain("no password is available");
			expect(refused.err).toContain("CENTRS_CDB_PASSWORD");
		},
		30_000,
	);

	tstub("unknown device stops before any unlock attempt", async () => {
		const ws = makeCliWorkspace('[device]\nid = "stub-gw"\ncdb = "stub-gw"\n');
		let prompted = 0;
		const res = await devicesStats(ws, "nope", "/ws/device.cdb", {
			toolBinDir: null,
			prompter: async () => {
				prompted++;
				return "x";
			},
		});
		expect(res.exit).toBe(1);
		expect(res.err).toBe("error: no device nope\n");
		expect(prompted).toBe(0);
	});

	tcentrs(
		"seeded open CDB: unlinkable device fails before the network",
		async () => {
			const ws = makeCliWorkspace(
				'[device]\nid = "plain-gw"\nrole = "gateway"\n',
			);
			const cdb = path.join(ws, "device.cdb");
			const init = childProcess.spawnSync("centrs", ["devices", "init"], {
				env: { ...process.env, CENTRS_CDB_FILE: cdb },
			});
			expect(init.status).toBe(0);
			const res = await devicesStats(ws, "plain-gw", cdb);
			expect(res.exit).toBe(1);
			expect(res.err).toContain("no cdb link nor host");
		},
		60_000,
	);

	tcentrs(
		"seeded encrypted CDB: env unlock proceeds, null prompt stops",
		async () => {
			const ws = makeCliWorkspace(
				'[device]\nid = "plain-gw"\nrole = "gateway"\n',
			);
			const cdb = path.join(ws, "device.cdb");
			nodeFs.copyFileSync(ENCRYPTED_FIXTURE, cdb);
			const withPw = await devicesStats(ws, "plain-gw", cdb, {
				baseEnv: { ...process.env, CENTRS_CDB_PASSWORD: FIXTURE_PASSWORD },
				prompter: async () => {
					throw new Error("must not prompt with passthrough set");
				},
			});
			expect(withPw.exit).toBe(1);
			expect(withPw.err).toContain("no cdb link nor host");
			const baseEnv = { ...process.env };
			delete baseEnv["CENTRS_CDB_PASSWORD"];
			const without = await devicesStats(ws, "plain-gw", cdb, {
				baseEnv,
				prompter: async () => null,
			});
			expect(without.exit).toBe(2);
			expect(without.err).toContain("no password is available");
		},
		60_000,
	);
});

describe("devices CLI wiring", () => {
	const CLI = path.join(import.meta.dir, "..", "src", "index.ts");

	async function runCli(
		args: string[],
		env?: Record<string, string | undefined>,
	): Promise<{ exit: number; out: string; err: string }> {
		const proc = Bun.spawn([BUN as string, CLI, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			env: env ?? process.env,
		});
		const [out, err, exit] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exit, out, err };
	}

	tcli(
		"help names the T48 write boundary",
		async () => {
			const r = await runCli(["devices", "--help"]);
			expect(r.exit).toBe(0);
			expect(r.out).toContain("devices list");
			expect(r.out).toContain("devices stats");
			expect(r.out).toContain("out of scope here (T48");
		},
		30_000,
	);

	tcli(
		"bare devices + bad workspace are usage errors",
		async () => {
			expect((await runCli(["devices"])).exit).toBe(2);
			const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t40-cli-nows-"));
			const r = await runCli(["devices", "list", dir]);
			expect(r.exit).toBe(2);
			expect(r.out).toContain("not a workspace");
		},
		30_000,
	);

	tcli(
		"list prints devices, stats refuses unknown ids",
		async () => {
			const ws = makeCliWorkspace('[device]\nid = "cli-gw"\nsite = "lab"\n');
			const list = await runCli(["devices", "list", ws]);
			expect(list.exit).toBe(0);
			expect(list.out).toBe("cli-gw site=lab\n");
			const stats = await runCli(["devices", "stats", "nope", ws]);
			expect(stats.exit).toBe(1);
			expect(stats.err).toBe("error: no device nope\n");
		},
		30_000,
	);

	tcli(
		"stats honors the bound CDB prompt-less via passthrough (stdin ignored)",
		async () => {
			const ws = makeCliWorkspace('[device]\nid = "plain-gw"\n');
			const cdb = path.join(ws, "device.cdb");
			nodeFs.copyFileSync(ENCRYPTED_FIXTURE, cdb);
			const env = { ...process.env, CENTRS_CDB_PASSWORD: FIXTURE_PASSWORD };
			const r = await runCli(["devices", "stats", "plain-gw", ws], env);
			expect(r.exit).toBe(1);
			expect(r.err).toContain("no cdb link nor host");
		},
		60_000,
	);

	tcli(
		"stats without a password on a non-TTY stops, never hangs",
		async () => {
			const ws = makeCliWorkspace('[device]\nid = "plain-gw"\n');
			nodeFs.copyFileSync(ENCRYPTED_FIXTURE, path.join(ws, "device.cdb"));
			const env = { ...process.env };
			delete env["CENTRS_CDB_PASSWORD"];
			const r = await runCli(["devices", "stats", "plain-gw", ws], env);
			expect(r.exit).toBe(2);
			expect(r.err).toContain("no password is available");
		},
		60_000,
	);

	tcli(
		"stats resolves centrs through the package bundle, not ambient PATH",
		async () => {
			if (toolBinDir() === null) return;
			const ws = makeCliWorkspace(
				'[device]\nid = "doc-gw"\ncdb = "192.0.2.1"\n',
			);
			// Documentation address (RFC 5737): unroutable, so the retrieve
			// leg must fail honestly at the transport — proving the real
			// (bundled) centrs ran, not the ambient fake below.
			const cdb = path.join(ws, "device.cdb");
			expect(
				childProcess.spawnSync("centrs", ["devices", "init"], {
					env: { ...process.env, CENTRS_CDB_FILE: cdb },
				}).status,
			).toBe(0);
			expect(
				childProcess.spawnSync("centrs", [
					"devices",
					"add",
					"192.0.2.1",
					"--cdb-file",
					cdb,
				]).status,
			).toBe(0);
			const fake = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t40-fakebin-"));
			writeShim(fake, "centrs", `echo "FAKE-CENTRS-ANSWERED"; exit 99`);
			nodeFs.symlinkSync("/bin/sh", path.join(fake, "sh"));
			// The bundled centrs is a `#!/usr/bin/env bun` script: without
			// its interpreter on PATH the bundle leg could not run either.
			nodeFs.symlinkSync(BUN as string, path.join(fake, "bun"));
			const r = await runCli(["devices", "stats", "doc-gw", ws], {
				...process.env,
				PATH: fake,
			});
			expect(r.exit).toBe(1);
			expect(r.err).toContain("transport/timeout");
			expect(r.err).not.toContain("FAKE-CENTRS");
		},
		120_000,
	);

	tpty(
		"TTY prompt reads the password with no echo (pty via script)",
		async () => {
			const ws = makeCliWorkspace(
				'[device]\nid = "sealed-gw"\ncdb = "sealed-gw"\n',
			);
			nodeFs.copyFileSync(ENCRYPTED_FIXTURE, path.join(ws, "device.cdb"));
			const env = { ...process.env };
			delete env["CENTRS_CDB_PASSWORD"];
			// Feed the password late: the CLI prompts only after its
			// detect spawn, so early bytes would echo at the pty layer.
			const feeder = Bun.spawn(["sh", "-c", "sleep 3; printf 'wrong-pw\\n'"], {
				stdout: "pipe",
			});
			const proc = Bun.spawn(
				[
					"script",
					"-qec",
					`bun ${JSON.stringify(CLI)} devices stats sealed-gw ${JSON.stringify(ws)}`,
					"/dev/null",
				],
				{ stdin: feeder.stdout, stdout: "pipe", stderr: "pipe", env },
			);
			const [out, err, exit] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			await feeder.exited;
			const transcript = `${out}\n${err}`;
			// Wrong password was READ (empty/EOF would stop at exit 2
			// with "no password is available"; right would reach the
			// transport): centrs fails the open before any network.
			expect(exit).toBe(1);
			expect(transcript).toContain("decrypt-failed");
			// ... and never echoed back.
			expect(transcript).not.toContain("wrong-pw");
		},
		120_000,
	);
});
