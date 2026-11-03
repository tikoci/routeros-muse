// T110 add-device: agent opens the UI dialog prefilled, the owner types
// the secret in the UI, the server writes router.toml + the CDB record.
//
// Fail-first, hermetic: a stateful fake `centrs` (this file only — the
// shared tests/t50-fake.ts stub does NOT emulate devices add/show, so
// per the task it stays untouched) backs the route legs. Relay legs
// need no centrs at all.

import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	slugFromHost,
	validAddHost,
	validAddId,
	validAddUser,
} from "../src/mcp/ui-tools";
import { startServer } from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

const CATALOG_FIXTURE = path.join(import.meta.dir, "fixtures", "model-catalog");

function makeDataHome(): string {
	return mktmp("t110-dh-");
}

function makeHome(): string {
	const home = mktmp("t110-home-");
	const dir = path.join(home, "muse", "model-catalog");
	nodeFs.mkdirSync(dir, { recursive: true });
	for (const f of nodeFs.readdirSync(CATALOG_FIXTURE)) {
		nodeFs.copyFileSync(path.join(CATALOG_FIXTURE, f), path.join(dir, f));
	}
	return home;
}

function makeWorkspace(routerToml: string): string {
	const dir = mktmp("t110-ws-");
	nodeFs.writeFileSync(path.join(dir, "workspace.toml"), "canonical = true\n");
	nodeFs.writeFileSync(path.join(dir, "router.toml"), routerToml);
	// The server binds <ws>/device.cdb; the shim treats an existing
	// path as an open CDB (auth bypass under allowOpenCdb) and keeps
	// its own record state in T110_STATE.
	nodeFs.writeFileSync(path.join(dir, "device.cdb"), "t110-fake-cdb\n");
	return dir;
}

/**
 * Stateful fake `centrs`, emulating the real JSON envelopes (grounded
 * against centrs 0.1.9-next: success on stdout, failure on stderr,
 * error {code, summary}, entry {target,user,...,savedPassword},
 * list rows [{target,user}]). Every invocation appends its argv to
 * T110_ARGV, so tests can assert the password channel. T110_FAIL_ADD=1
 * makes `devices add` fail (CDB-failure leg).
 */
const SHIM = String.raw`
import * as fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(process.env["T110_ARGV"], argv.join(" ") + "\n");
const stateFile = process.env["T110_STATE"] + "/records.json";
function load() {
	try {
		return JSON.parse(fs.readFileSync(stateFile, "utf8"));
	} catch {
		return {};
	}
}
function save(s) {
	fs.writeFileSync(stateFile, JSON.stringify(s));
}
function fail(code, summary) {
	process.stderr.write(JSON.stringify({ ok: false, error: { code, summary }, warnings: [], tips: [], meta: {} }));
	process.exit(0);
}
function cdbFileOf() {
	const i = argv.indexOf("--cdb-file");
	return i >= 0 ? argv[i + 1] : null;
}
if (argv[0] !== "devices") {
	process.stdout.write("stub-centrs 9.9.9-t110\n");
	process.exit(0);
}
const sub = argv[1];
const f = cdbFileOf();
if (f && !fs.existsSync(f)) fail("cdb/not-found", "CDB file not found");
if (process.env["T110_FAIL_ADD"] === "1" && sub === "add") fail("cdb/locked", "simulated encrypted-CDB write failure");
function flag(name) {
	const i = argv.indexOf(name);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
function entryOf(target, rec) {
	return {
		target,
		recordType: 5,
		recordTypeName: "ipAdmin",
		group: "",
		user: rec.user || "",
		session: rec.session || "",
		comment: "",
		commentMirror: rec.sshKey ? "ssh-key=" + rec.sshKey : "",
		profile: rec.profile || "<none>",
		savedPassword: !!rec.password,
	};
}
const st = load();
if (sub === "list") {
	const rows = Object.entries(st).map(([target, rec]) => ({ target, user: rec.user || "" }));
	process.stdout.write(JSON.stringify({ ok: true, data: rows, warnings: [], tips: [], meta: {} }));
	process.exit(0);
}
const target = argv.find((a, i) => i >= 2 && !a.startsWith("-") && argv[i - 1] !== "--cdb-file" && !a.includes("="));
if (!target) fail("cdb/bad-target", "need a target");
if (sub === "show") {
	const rec = st[target];
	if (!rec) fail("cdb/not-found-target", 'No CDB entry matches "' + target + '".');
	process.stdout.write(JSON.stringify({ ok: true, data: { entry: entryOf(target, rec) }, warnings: [], tips: [], meta: {} }));
	process.exit(0);
}
if (sub === "add") {
	if (st[target]) fail("cdb/already-exists", 'A CDB entry for "' + target + '" already exists.');
	const rec = { user: flag("--user") || "", password: flag("--password") || "", sshKey: "", profile: flag("--profile") || "", session: flag("--session") || "" };
	const kv = argv.find((a) => a.startsWith("ssh-key="));
	if (kv) rec.sshKey = kv.slice("ssh-key=".length);
	st[target] = rec;
	save(st);
	process.stdout.write(JSON.stringify({ ok: true, data: { action: "add", target, entry: entryOf(target, rec) }, warnings: [], tips: [], meta: {} }));
	process.exit(0);
}
if (sub === "set") {
	const rec = st[target];
	if (!rec) fail("cdb/not-found-target", 'No CDB entry matches "' + target + '".');
	const u = flag("--user");
	if (u !== undefined) rec.user = u;
	const p = flag("--password");
	if (p !== undefined) rec.password = p;
	const kv = argv.find((a) => a.startsWith("ssh-key="));
	if (kv) rec.sshKey = kv.slice("ssh-key=".length);
	const pr = flag("--profile");
	if (pr !== undefined) rec.profile = pr;
	const se = flag("--session");
	if (se !== undefined) rec.session = se;
	st[target] = rec;
	save(st);
	process.stdout.write(JSON.stringify({ ok: true, data: { action: "set", target, entry: entryOf(target, rec) }, warnings: [], tips: [], meta: {} }));
	process.exit(0);
}
fail("cdb/bad-subcommand", "unknown devices subcommand");
`;

function stubT110Bin(): { bin: string; state: string; argvLog: string } {
	const bin = mktmp("t110-bin-");
	const state = mktmp("t110-state-");
	const argvLog = path.join(state, "argv.log");
	nodeFs.writeFileSync(argvLog, "");
	nodeFs.writeFileSync(stateFileOf(state), "{}");
	// Shell wrapper execs the bun shim (the tests/t50-fake.ts pattern):
	// the file on PATH must be named exactly `centrs`.
	const impl = path.join(bin, "centrs-shim.ts");
	nodeFs.writeFileSync(impl, SHIM);
	const shim = path.join(bin, "centrs");
	nodeFs.writeFileSync(
		shim,
		`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(impl)} "$@"\n`,
	);
	nodeFs.chmodSync(shim, 0o755);
	return { bin, state, argvLog };
}

function stateFileOf(state: string): string {
	return path.join(state, "records.json");
}

function readState(state: string): Record<string, Record<string, string>> {
	return JSON.parse(nodeFs.readFileSync(stateFileOf(state), "utf8"));
}

function argvLines(argvLog: string): string[] {
	return nodeFs
		.readFileSync(argvLog, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "");
}

type Started = {
	url: string;
	relayUrl: string;
	stop: () => Promise<void>;
};

async function startT110Srv(opts: {
	workspace?: string;
	noWorkspace?: boolean;
	state: string;
	bin: string;
	failAdd?: boolean;
}): Promise<Started> {
	const savedState = process.env["T110_STATE"];
	const savedFail = process.env["T110_FAIL_ADD"];
	const savedArgv = process.env["T110_ARGV"];
	process.env["T110_STATE"] = opts.state;
	process.env["T110_ARGV"] = path.join(opts.state, "argv.log");
	if (opts.failAdd) process.env["T110_FAIL_ADD"] = "1";
	else delete process.env["T110_FAIL_ADD"];
	try {
		const srv = await startServer({
			dataHome: makeDataHome(),
			configHome: mktmp("t110-cfg-"),
			allowOpenCdb: true,
			...(opts.noWorkspace
				? { noWorkspace: true }
				: { workspace: opts.workspace }),
			provider: "echo",
			museHome: makeHome(),
			toolBinDir: opts.bin,
			mcpToken: "t110-relay-token",
		});
		return { url: srv.url, relayUrl: srv.relayUrl, stop: () => srv.stop() };
	} finally {
		if (savedState === undefined) delete process.env["T110_STATE"];
		else process.env["T110_STATE"] = savedState;
		if (savedFail === undefined) delete process.env["T110_FAIL_ADD"];
		else process.env["T110_FAIL_ADD"] = savedFail;
		if (savedArgv === undefined) delete process.env["T110_ARGV"];
		else process.env["T110_ARGV"] = savedArgv;
	}
}

async function relay(
	relayUrl: string,
	tool: string,
	args: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await fetch(`${relayUrl}api/mcp/relay`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: "t110-relay-token", tool, arguments: args }),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
	};
}

async function postAdd(
	url: string,
	body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await fetch(`${url}api/devices/add`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: new URL(url).origin,
		},
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
	};
}

async function collectSse(
	url: string,
	want: string[],
	during: () => Promise<void>,
): Promise<string> {
	const ctl = new AbortController();
	const res = await fetch(`${url}api/chat/events`, {
		headers: { accept: "text/event-stream" },
		signal: ctl.signal,
	});
	if (!res.body) throw new Error("empty SSE body");
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	const done = (async () => {
		for (;;) {
			const { done: d, value } = await reader.read();
			if (d) break;
			buf += dec.decode(value, { stream: true });
			if (want.every((w) => buf.includes(w))) break;
		}
	})();
	try {
		await Promise.race([
			(async () => {
				await during();
				await done;
			})(),
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error(`sse timeout: ${buf.slice(-200)}`)),
					15_000,
				),
			),
		]);
	} finally {
		ctl.abort();
	}
	return buf;
}

describe("add validators", () => {
	test("hosts accept IPv4/IPv6/hostnames, refuse spaces and metacharacters", () => {
		for (const h of [
			"192.0.2.99",
			"router.lan",
			"gw-01_east",
			"::1",
			"fe80::1",
			"a".repeat(255),
		]) {
			expect(validAddHost(h)).toBe(true);
		}
		for (const h of [
			"",
			"a b",
			"a;b",
			"a&b",
			"a`b",
			"a$b",
			"a/b",
			"a\nb",
			"a".repeat(256),
		]) {
			expect(validAddHost(h)).toBe(false);
		}
		expect(validAddHost(undefined)).toBe(false);
	});

	test("users and ids use the conservative charsets", () => {
		expect(validAddUser("robot-admin")).toBe(true);
		expect(validAddUser("")).toBe(false);
		expect(validAddUser("a b")).toBe(false);
		expect(validAddUser("Admin")).toBe(true);
		expect(validAddId("192-0-2-99")).toBe(true);
		expect(validAddId("192.0.2.99")).toBe(false);
		expect(validAddId("Upper")).toBe(false);
		expect(validAddId("-lead")).toBe(false);
		expect(validAddId("")).toBe(false);
	});

	test("slugFromHost lowercases and collapses runs", () => {
		expect(slugFromHost("192.0.2.99")).toBe("192-0-2-99");
		expect(slugFromHost("GW-01.East")).toBe("gw-01-east");
		expect(slugFromHost("::")).toBe("device");
	});
});

describe("ui_add_device relay", () => {
	test("valid call emits ui/add-device and reports opened, never added", async () => {
		const { bin, state } = stubT110Bin();
		const srv = await startT110Srv({
			workspace: makeWorkspace(
				'[device]\nid = "t110-gw"\nhost = "192.0.2.1"\ncdb = "192.0.2.1"\n',
			),
			state,
			bin,
		});
		try {
			const buf = await collectSse(
				srv.url,
				['"method":"ui/add-device"'],
				async () => {
					const r = await relay(srv.relayUrl, "ui_add_device", {
						host: "192.0.2.99",
						user: "robot-admin",
					});
					expect(r.json["ok"]).toBe(true);
					expect(String(r.json["result"])).toBe(
						"add-device dialog opened for 192.0.2.99",
					);
					expect(String(r.json["result"])).not.toContain("added");
				},
			);
			expect(buf).toContain('"host":"192.0.2.99"');
			expect(buf).toContain('"user":"robot-admin"');
			expect(buf).toContain('"id":"192-0-2-99"');
		} finally {
			await srv.stop();
		}
	});

	test("explicit id rides the event; namespaced spelling works", async () => {
		const { bin, state } = stubT110Bin();
		const srv = await startT110Srv({
			workspace: makeWorkspace(""),
			state,
			bin,
		});
		try {
			const buf = await collectSse(
				srv.url,
				['"method":"ui/add-device"'],
				async () => {
					const r = await relay(
						srv.relayUrl,
						"mcp__routeros_muse__ui_add_device",
						{
							host: "gw.lan",
							user: "admin",
							id: "branch-gw",
						},
					);
					expect(r.json["ok"]).toBe(true);
				},
			);
			expect(buf).toContain('"id":"branch-gw"');
		} finally {
			await srv.stop();
		}
	});

	test("bad host/user/id are refused; no event fires", async () => {
		const { bin, state } = stubT110Bin();
		const srv = await startT110Srv({
			workspace: makeWorkspace(""),
			state,
			bin,
		});
		try {
			for (const [args, want] of [
				[{ host: "a b" }, /need \{host\}/],
				[{ host: "a;b" }, /need \{host\}/],
				[{ host: "" }, /need \{host\}/],
				[{ host: "192.0.2.99", user: "a b" }, /bad \{user\}/],
				[{ host: "192.0.2.99", id: "Upper" }, /bad \{id\}/],
			] as [Record<string, unknown>, RegExp][]) {
				const r = await relay(srv.relayUrl, "ui_add_device", args);
				expect(r.json["ok"]).toBe(false);
				expect(String(r.json["why"])).toMatch(want);
			}
		} finally {
			await srv.stop();
		}
	});

	test("works in no-workspace mode (no refusal)", async () => {
		const { bin, state } = stubT110Bin();
		const srv = await startT110Srv({ noWorkspace: true, state, bin });
		try {
			const r = await relay(srv.relayUrl, "ui_add_device", {
				host: "192.0.2.99",
			});
			expect(r.json["ok"]).toBe(true);
		} finally {
			await srv.stop();
		}
	});
});

describe("POST /api/devices/add", () => {
	test("creates the router.toml entry and the CDB record", async () => {
		const { bin, state, argvLog } = stubT110Bin();
		const ws = makeWorkspace(
			'[device]\nid = "t110-gw"\nhost = "192.0.2.1"\ncdb = "192.0.2.1"\n',
		);
		const srv = await startT110Srv({ workspace: ws, state, bin });
		try {
			const r = await postAdd(srv.url, {
				host: "192.0.2.99",
				user: "robot-admin",
				password: "t110-secret",
			});
			expect(r.status).toBe(200);
			expect(r.json).toMatchObject({
				ok: true,
				id: "192-0-2-99",
				action: "add",
			});
			expect(JSON.stringify(r.json)).not.toContain("t110-secret");
			const toml = nodeFs.readFileSync(path.join(ws, "router.toml"), "utf8");
			expect(toml).toContain('id = "192-0-2-99"');
			expect(toml).toContain('host = "192.0.2.99"');
			expect(toml).toContain('cdb = "192.0.2.99"');
			// The lone [device] single table promotes to the
			// [[device]] array (header rewrite only); the original
			// block survives and both devices list.
			expect(toml).toContain('id = "t110-gw"');
			const inv = (await (await fetch(`${srv.url}api/devices`)).json()) as {
				devices: { id: string }[];
			};
			expect(inv.devices.map((d) => d.id).sort()).toEqual([
				"192-0-2-99",
				"t110-gw",
			]);
			expect(readState(state)["192.0.2.99"]).toMatchObject({
				user: "robot-admin",
				password: "t110-secret",
			});
			// The secret rides only the documented devices-add channel.
			const lines = argvLines(argvLog);
			const withSecret = lines.filter((l) => l.includes("t110-secret"));
			expect(withSecret.length).toBeGreaterThan(0);
			for (const l of withSecret) {
				expect(l.startsWith("devices add ")).toBe(true);
			}
			expect(
				lines.filter((l) => l.startsWith("devices show")).join("\n"),
			).not.toContain("t110-secret");
			expect(
				lines.filter((l) => l.startsWith("devices list")).join("\n"),
			).not.toContain("t110-secret");
		} finally {
			await srv.stop();
		}
	});

	test("duplicate-same retry is ok and does not duplicate the block", async () => {
		const { bin, state } = stubT110Bin();
		const ws = makeWorkspace("");
		const srv = await startT110Srv({ workspace: ws, state, bin });
		try {
			const body = {
				host: "192.0.2.99",
				user: "robot-admin",
				password: "t110-secret",
			};
			expect((await postAdd(srv.url, body)).json["ok"]).toBe(true);
			const again = await postAdd(srv.url, body);
			expect(again.json["ok"]).toBe(true);
			const toml = nodeFs.readFileSync(path.join(ws, "router.toml"), "utf8");
			expect(toml.match(/id = "192-0-2-99"/g)).toHaveLength(1);
		} finally {
			await srv.stop();
		}
	});

	test("legacy cdb!=host with same id+host retries, not a 409", async () => {
		const { bin, state } = stubT110Bin();
		const before =
			'[device]\nid = "legacy"\nhost = "192.0.2.99"\ncdb = "legacy-name"\n';
		const ws = makeWorkspace(before);
		const srv = await startT110Srv({ workspace: ws, state, bin });
		try {
			const r = await postAdd(srv.url, {
				id: "legacy",
				host: "192.0.2.99",
				user: "robot-admin",
				password: "t110-secret",
			});
			expect(r.status).toBe(200);
			expect(r.json["ok"]).toBe(true);
			// No duplicate block appended.
			expect(nodeFs.readFileSync(path.join(ws, "router.toml"), "utf8")).toBe(
				before,
			);
		} finally {
			await srv.stop();
		}
	});

	test("duplicate-different-host id is a 409 with no write", async () => {
		const { bin, state } = stubT110Bin();
		const before =
			'[device]\nid = "taken"\nhost = "192.0.2.1"\ncdb = "192.0.2.1"\n';
		const ws = makeWorkspace(before);
		const srv = await startT110Srv({ workspace: ws, state, bin });
		try {
			const r = await postAdd(srv.url, {
				id: "taken",
				host: "192.0.2.99",
				user: "robot-admin",
				password: "t110-secret",
			});
			expect(r.status).toBe(409);
			expect(r.json).toMatchObject({ ok: false, stage: "router", id: "taken" });
			expect(nodeFs.readFileSync(path.join(ws, "router.toml"), "utf8")).toBe(
				before,
			);
			expect(readState(state)["192.0.2.99"]).toBeUndefined();
		} finally {
			await srv.stop();
		}
	});

	test("already-registered host under another id is a 409", async () => {
		const { bin, state } = stubT110Bin();
		const ws = makeWorkspace(
			'[device]\nid = "id-a"\nhost = "192.0.2.50"\ncdb = "192.0.2.50"\n',
		);
		const srv = await startT110Srv({ workspace: ws, state, bin });
		try {
			const r = await postAdd(srv.url, {
				host: "192.0.2.50",
				user: "robot-admin",
				password: "t110-secret",
			});
			expect(r.status).toBe(409);
			expect(String(r.json["why"])).toMatch(/another id/);
		} finally {
			await srv.stop();
		}
	});

	test("unparseable router.toml is refused without any write", async () => {
		const { bin, state } = stubT110Bin();
		const ws = makeWorkspace('[device]\nid = "broken"\n= nope\n');
		const srv = await startT110Srv({ workspace: ws, state, bin });
		try {
			const before = nodeFs.readFileSync(path.join(ws, "router.toml"), "utf8");
			const r = await postAdd(srv.url, {
				host: "192.0.2.99",
				user: "robot-admin",
				password: "t110-secret",
			});
			expect(r.status).toBe(409);
			expect(r.json).toMatchObject({
				ok: false,
				stage: "router",
				why: "router.toml is unparseable; edit the file by hand",
			});
			expect(nodeFs.readFileSync(path.join(ws, "router.toml"), "utf8")).toBe(
				before,
			);
			expect(readState(state)["192.0.2.99"]).toBeUndefined();
		} finally {
			await srv.stop();
		}
	});

	test("CDB failure keeps the router entry and answers ok:false with stage", async () => {
		const { bin, state } = stubT110Bin();
		const ws = makeWorkspace("");
		const srv = await startT110Srv({
			workspace: ws,
			state,
			bin,
			failAdd: true,
		});
		try {
			const r = await postAdd(srv.url, {
				host: "192.0.2.99",
				user: "robot-admin",
				password: "t110-secret",
			});
			expect(r.json).toMatchObject({
				ok: false,
				stage: "cdb",
				id: "192-0-2-99",
			});
			expect(JSON.stringify(r.json)).not.toContain("t110-secret");
			// The router.toml entry stays: Set credentials is the recovery.
			expect(
				nodeFs.readFileSync(path.join(ws, "router.toml"), "utf8"),
			).toContain('id = "192-0-2-99"');
		} finally {
			await srv.stop();
		}
	});

	test("validation refuses bad shapes before any write", async () => {
		const { bin, state } = stubT110Bin();
		const ws = makeWorkspace("");
		const srv = await startT110Srv({ workspace: ws, state, bin });
		try {
			const before = nodeFs.readFileSync(path.join(ws, "router.toml"), "utf8");
			for (const [body, want] of [
				[{ host: "a b", user: "u", password: "p" }, /need \{host\}/],
				[{ host: "192.0.2.99", user: "", password: "p" }, /need \{user\}/],
				[{ host: "192.0.2.99", user: "u" }, /need \{password\} or \{sshKey\}/],
				[
					{ host: "192.0.2.99", user: "u", password: "p", id: "Bad" },
					/bad \{id\}/,
				],
			] as [Record<string, unknown>, RegExp][]) {
				const r = await postAdd(srv.url, body);
				expect(r.json["ok"]).toBe(false);
				expect(String(r.json["why"])).toMatch(want);
			}
			expect(nodeFs.readFileSync(path.join(ws, "router.toml"), "utf8")).toBe(
				before,
			);
			expect(Object.keys(readState(state))).toHaveLength(0);
		} finally {
			await srv.stop();
		}
	});

	test("no-workspace mode is CDB-only; id is the host target", async () => {
		const { bin, state } = stubT110Bin();
		const srv = await startT110Srv({ noWorkspace: true, state, bin });
		try {
			const r = await postAdd(srv.url, {
				host: "192.0.2.99",
				user: "robot-admin",
				password: "t110-secret",
			});
			expect(r.json).toMatchObject({ ok: true, id: "192.0.2.99" });
			expect(readState(state)["192.0.2.99"]?.["user"]).toBe("robot-admin");
		} finally {
			await srv.stop();
		}
	});
});

afterAll(cleanupTmpdirs);
