// Mode B server tests (T31 slice 2). Echo provider + isolated homes;
// hermetic, no API cost. Skipped when `muse` is not on PATH.
import { afterAll, describe, expect, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	cdbRowsToDevices,
	centrsRetrieveArgs,
	centrsWhy,
	cleanPorts,
	credentialSnapshot,
	PORT_KEYS,
	portsOf,
	projectCdbEntry,
	validPortValue,
} from "../src/lib/fleet";
import { have, run } from "../src/lib/run";
import { toolBinDir, toolEnv } from "../src/lib/tools";
import { hiddenFromFiles } from "../src/lib/workspace";
import { uiMcpServers } from "../src/mcp/ui-tools";
import { MspClient } from "../src/msp/client";
import {
	createSessionStore,
	detectCdbMode,
	probeMetaAuth,
	verifyCdbPassword,
	workerEnv,
} from "../src/serve/auth";
import {
	contextPercent,
	isLoopbackHost,
	lanUrls,
	startServer,
} from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

const HAVE_MUSE = have("muse");
const HAVE_CENTRS = have("centrs");
const t = HAVE_MUSE ? test : test.skip;
const tc = HAVE_MUSE && HAVE_CENTRS ? test : test.skip;
const tcentrs = HAVE_CENTRS ? test : test.skip;

function makeWorkspace(): string {
	const dir = mktmp("t31-serve-ws-");
	nodeFs.writeFileSync(path.join(dir, "workspace.toml"), "canonical = true\n");
	nodeFs.writeFileSync(
		path.join(dir, "router.toml"),
		'[device]\nid = "test-gw"\nrole = "gateway"\nsite = "lab"\n',
	);
	nodeFs.mkdirSync(path.join(dir, "operations"), { recursive: true });
	nodeFs.writeFileSync(
		path.join(dir, "operations", "drift.md"),
		"# drift\n\n## DRIFT-1\n\n- open: yes\n",
	);
	nodeFs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
	return dir;
}

/**
 * D53: the CDB is the only device list. Init <ws>/device.cdb with real
 * centrs and add each target (open store, no passwords).
 */
async function seedWorkspaceCdb(
	ws: string,
	records: { target: string; user?: string }[],
): Promise<string> {
	const cdb = path.join(ws, "device.cdb");
	const init = await run(["centrs", "devices", "init", "--cdb-file", cdb], {
		timeoutMs: 30_000,
	});
	expect(init.ok).toBe(true);
	for (const r of records) {
		const args = ["centrs", "devices", "add", r.target, "--cdb-file", cdb];
		if (r.user !== undefined) args.push("--user", r.user);
		const add = await run(args, { timeoutMs: 30_000 });
		expect(add.ok).toBe(true);
	}
	return cdb;
}

const CATALOG_FIXTURE = path.join(import.meta.dir, "fixtures", "model-catalog");

// T40 hermeticity: every test server gets its own data home, so
// workspace boots never touch the developer's real registry.
function makeDataHome(): string {
	return mktmp("t31-serve-dh-");
}

function makeHome(seeded = true): string {
	const home = mktmp("t31-serve-home-");
	if (seeded) {
		const dir = path.join(home, "muse", "model-catalog");
		nodeFs.mkdirSync(dir, { recursive: true });
		for (const f of nodeFs.readdirSync(CATALOG_FIXTURE)) {
			nodeFs.copyFileSync(path.join(CATALOG_FIXTURE, f), path.join(dir, f));
		}
	}
	return home;
}

describe("listen addresses", () => {
	test("lanUrls keeps external IPv4 only", () => {
		const urls = lanUrls(8479, {
			lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
			eth0: [
				{ address: "172.22.74.195", family: "IPv4", internal: false } as never,
				{ address: "fe80::1", family: "IPv6", internal: false } as never,
			],
			zt: [
				{ address: "172.29.8.151", family: "IPv4", internal: false } as never,
			],
			dead: [
				{ address: "169.254.9.9", family: "IPv4", internal: false } as never,
			],
		});
		expect(urls).toEqual([
			"http://172.22.74.195:8479/",
			"http://172.29.8.151:8479/",
		]);
	});

	test("loopback detection", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
		expect(isLoopbackHost("172.22.74.195")).toBe(false);
	});

	test("cdb link wins, host is break-glass, neither is null", () => {
		expect(
			centrsRetrieveArgs({ cdb: "gw", host: "h" }, "/system/identity", null),
		).toEqual([
			"retrieve",
			"gw",
			"/system/identity",
			"--format",
			"json",
			"--timeout",
			"10s",
		]);
		expect(centrsRetrieveArgs({ host: "h" }, "/system/identity", null)).toEqual(
			[
				"retrieve",
				"--host",
				"h",
				"/system/identity",
				"--format",
				"json",
				"--timeout",
				"10s",
			],
		);
		expect(centrsRetrieveArgs({}, "/system/identity", null)).toBeNull();
	});

	test("workspace device.cdb is passed through when shipped", () => {
		const args = centrsRetrieveArgs(
			{ cdb: "gw" },
			"/system/resource",
			"/ws/device.cdb",
		);
		expect(args).toContain("--cdb-file");
		expect(args).toContain("/ws/device.cdb");
		expect(args?.[1]).toBe("gw");
	});

	test("cdb rows map to devices; __default__ and empty shapes drop out", () => {
		expect(
			cdbRowsToDevices([
				{ target: "gw" },
				{ target: "__default__" },
				{ target: "  " },
				{ nope: 1 },
			]),
		).toEqual([{ id: "gw", cdb: "gw" }]);
		expect(cdbRowsToDevices({})).toEqual([]);
		expect(cdbRowsToDevices(null)).toEqual([]);
	});

	test("centrs failure envelopes collapse to code + summary", () => {
		expect(
			centrsWhy({
				ok: false,
				error: { code: "transport/timeout", summary: "Timed out." },
			}),
		).toBe("transport/timeout: Timed out.");
		expect(centrsWhy({ ok: false })).toBe(
			"device unreachable (see centrs output)",
		);
		expect(centrsWhy(null)).toBe("device unreachable (see centrs output)");
	});

	test("context percent rounds, clamps, and yields on missing basis", () => {
		expect(contextPercent(4, 1007997)).toBe(0);
		expect(contextPercent(503999, 1007997)).toBe(50);
		expect(contextPercent(2000000, 1007997)).toBe(100);
		expect(contextPercent(4, undefined)).toBeNull();
		expect(contextPercent(undefined, 1007997)).toBeNull();
		expect(contextPercent(4, 0)).toBeNull();
	});
});

describe("serve", () => {
	t(
		"serves the UI on loopback only",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				expect(srv.hostname).toBe("127.0.0.1");
				const r = await fetch(srv.url);
				expect(r.status).toBe(200);
				const html = await r.text();
				expect(html).toContain("RouterOS Muse");
				expect(html).toContain('id="chatmsgs"');
				// T35: real MikroTik symbol, no placeholder plusmark.
				expect(html).toContain('viewBox="0 0 41.83 44.62"');
				expect(html).not.toContain('plusmark">⊕<');
				// T45: reconnect chip present (hidden until a stream drop).
				expect(html).toContain('id="ssestate"');
				// T37: structured transcript cards + output tab pane.
				expect(html).toContain('id="pane-output"');
				expect(html).toContain("renderRow");
				expect(html).toContain("renderOutput");
				expect(html).toContain("tout-pre");
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);

	t(
		"status, tree, recents reflect the workspace",
		async () => {
			const ws = makeWorkspace();
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const st = (await (
					await fetch(`${srv.url}api/status`)
				).json()) as Record<string, unknown>;
				expect(st["workspace"]).toBe(ws);
				expect(st["provider"]).toBe("echo");
				const tree = (await (await fetch(`${srv.url}api/tree`)).json()) as {
					entries: { path: string }[];
				};
				expect(tree.entries.map((e) => e.path)).toContain("workspace.toml");
				const rec = (await (await fetch(`${srv.url}api/recents`)).json()) as {
					recents: { path: string }[];
				};
				expect(rec.recents.map((r) => r.path)).toContain("workspace.toml");
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);

	test("file list hides dotfiles and CDB stores (T143)", () => {
		expect(hiddenFromFiles(".agents")).toBe(true);
		expect(hiddenFromFiles(".env")).toBe(true);
		expect(hiddenFromFiles("device.cdb")).toBe(true);
		expect(hiddenFromFiles("DEVICE.CDB")).toBe(true);
		expect(hiddenFromFiles("device.cdb.bak.2026-11-04T02-46-02-298Z")).toBe(
			true,
		);
		expect(hiddenFromFiles("router.toml")).toBe(false);
		expect(hiddenFromFiles("notes.md")).toBe(false);
		expect(hiddenFromFiles("cdb-notes.md")).toBe(false);
		expect(hiddenFromFiles("my.cdbx")).toBe(false);
	});

	tc(
		"GET /api/files lists the workspace minus dot-dirs and CDB files",
		async () => {
			const ws = makeWorkspace();
			// A real (open) store, so the CDB gate lets the request through.
			await seedWorkspaceCdb(ws, []);
			nodeFs.mkdirSync(path.join(ws, ".agents", "skills"), { recursive: true });
			nodeFs.writeFileSync(path.join(ws, ".agents", "skills", "x.md"), "x\n");
			nodeFs.writeFileSync(path.join(ws, ".hidden"), "h\n");
			nodeFs.writeFileSync(
				path.join(ws, "device.cdb.bak.2026-11-04T02-46-02-298Z"),
				"bak\n",
			);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const files = (await (await fetch(`${srv.url}api/files`)).json()) as {
					entries: { path: string }[];
				};
				const paths = files.entries.map((e) => e.path);
				for (const want of [
					"workspace.toml",
					"router.toml",
					"operations",
					"operations/drift.md",
					"inbox",
				]) {
					expect(paths).toContain(want);
				}
				for (const p of paths) {
					expect(p.split("/").some((seg) => seg.startsWith("."))).toBe(false);
					expect(p).not.toMatch(/\.cdb(\.|$)/i);
				}
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);

	t(
		"GET /api/files is refused without a workspace",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				noWorkspace: true,
				cdbFile: path.join(mktmp("t31-serve-nows-"), "absent.cdb"),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const r = await fetch(`${srv.url}api/files`);
				expect(r.status).toBe(200);
				expect(await r.json()).toEqual({
					ok: false,
					why: "no workspace attached",
				});
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);

	t(
		"file roundtrip validates TOML and blocks traversal",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const get = (await (
					await fetch(`${srv.url}api/file?path=router.toml`)
				).json()) as {
					ok: boolean;
					text: string;
				};
				expect(get.ok).toBe(true);
				expect(get.text).toContain("test-gw");
				const badToml = await fetch(`${srv.url}api/file`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: new URL(srv.url).origin,
					},
					body: JSON.stringify({ path: "router.toml", text: "[device\nid = " }),
				});
				expect(badToml.status).toBe(400);
				const goodToml = await fetch(`${srv.url}api/file`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: new URL(srv.url).origin,
					},
					body: JSON.stringify({ path: "extra.toml", text: "[a]\nb = 1\n" }),
				});
				expect(goodToml.status).toBe(200);
				const trav = await fetch(
					`${srv.url}api/file?path=${encodeURIComponent("../x")}`,
				);
				expect(trav.status).toBe(400);
				const toml = (await (
					await fetch(`${srv.url}api/toml?path=router.toml`)
				).json()) as {
					ok: boolean;
					sections: { name: string; rows: unknown[] }[];
				};
				expect(toml.ok).toBe(true);
				expect(toml.sections.map((s) => s.name)).toContain("device");
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);

	tc(
		"devices come from the CDB, never router.toml; unknown ids 404 on stats",
		async () => {
			// makeWorkspace's router.toml names test-gw; D53 ignores it.
			const ws = makeWorkspace();
			await seedWorkspaceCdb(ws, [{ target: "192.0.2.1" }]);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const dev = (await (await fetch(`${srv.url}api/devices`)).json()) as {
					devices: { id: string }[];
					source: string;
				};
				expect(dev.source).toBe("cdb");
				expect(dev.devices.map((d) => d.id)).toEqual(["192.0.2.1"]);
				const stats = await fetch(`${srv.url}api/devices/test-gw/stats`);
				expect(stats.status).toBe(404);
				expect(((await stats.json()) as { why: string }).why).toBe(
					"no device test-gw",
				);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tc(
		"a CDB row is the device card payload (id = cdb = target)",
		async () => {
			const ws = makeWorkspace();
			await seedWorkspaceCdb(ws, [{ target: "office-gw", user: "admin" }]);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const dev = (await (await fetch(`${srv.url}api/devices`)).json()) as {
					devices: Record<string, unknown>[];
				};
				expect(dev.devices).toEqual([
					{
						id: "office-gw",
						cdb: "office-gw",
						user: "admin",
						hasPassword: false,
					},
				]);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tc(
		"cdb-linked stats run centrs against the workspace device.cdb",
		async () => {
			const ws = makeWorkspace();
			// Documentation address (RFC 5737): unroutable, so the retrieve leg
			// must fail honestly at the transport, proving the wiring ran.
			await seedWorkspaceCdb(ws, [{ target: "192.0.2.1" }]);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const stats = (await (
					await fetch(`${srv.url}api/devices/192.0.2.1/stats`)
				).json()) as { ok: boolean; why: string };
				expect(stats.ok).toBe(false);
				expect(stats.why).toContain("transport/timeout");
			} finally {
				await srv.stop();
			}
		},
		90_000,
	);

	test("doctor alerts fire for missing required tools (no muse needed)", async () => {
		const ws = makeWorkspace();
		nodeFs.writeFileSync(
			path.join(ws, "doctor.local.toml"),
			'[[tool]]\nid = "smoke-bogus"\nos = "linux"\ntier = "required"\n' +
				'detect = "command -v definitely-not-a-real-tool-xyz"\n' +
				'hint = "install the bogus tool"\nwhy = "proves the alerts branch"\n',
		);
		const srv = await startServer({
			dataHome: makeDataHome(),
			configHome: mktmp("t31-serve-cfg-"),
			allowOpenCdb: true,
			workspace: ws,
			provider: "echo",
			museHome: makeHome(),
		});
		try {
			const j = (await (await fetch(`${srv.url}api/alerts`)).json()) as {
				alerts: { title: string; body: string; src: string }[];
			};
			const hit = j.alerts.find((a) => a.title === "smoke-bogus is missing");
			if (!hit) throw new Error("missing-tool alert never fired");
			expect(hit.body).toBe("install the bogus tool");
			expect(hit.src).toBe("muse doctor · required");
		} finally {
			await srv.stop();
		}
	}, 30_000);

	t(
		"no-workspace mode: status null, files refuse, devices come from the CDB",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				noWorkspace: true,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const st = (await (
					await fetch(`${srv.url}api/status`)
				).json()) as Record<string, unknown>;
				expect(st["workspace"]).toBeNull();
				expect(st["mode"]).toBe("no-workspace");
				for (const route of ["api/tree", "api/recents", "api/alerts"]) {
					const r = await fetch(`${srv.url}${route}`);
					expect(r.status).toBe(200);
					expect(((await r.json()) as { why: string }).why).toContain(
						"no workspace attached",
					);
				}
				const dev = (await (await fetch(`${srv.url}api/devices`)).json()) as {
					devices: { id: string; cdb?: string }[];
					source: string;
					why?: string;
				};
				expect(dev.source).toBe("cdb");
				expect(Array.isArray(dev.devices)).toBe(true);
				expect(dev.devices.map((d) => d.id)).not.toContain("__default__");
				for (const d of dev.devices) {
					expect(typeof d.id).toBe("string");
					expect(d.cdb).toBe(d.id);
				}
				if (!HAVE_CENTRS) expect(dev.why).toContain("centrs not on PATH");
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tc(
		"no-workspace cdbFile override serves that registry, never the operator CDB",
		async () => {
			const dir = mktmp("t46-serve-cdb-");
			const emptyCdb = path.join(dir, "empty.cdb");
			const init = Bun.spawnSync(["centrs", "devices", "init"], {
				env: { ...process.env, CENTRS_CDB_FILE: emptyCdb },
			});
			expect(init.exitCode).toBe(0);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				noWorkspace: true,
				provider: "echo",
				museHome: makeHome(),
				cdbFile: emptyCdb,
			});
			try {
				const dev = (await (await fetch(`${srv.url}api/devices`)).json()) as {
					devices: unknown[];
					source: string;
					why?: string;
				};
				expect(dev.source).toBe("cdb");
				expect(dev.devices).toEqual([]);
				expect(dev.why).toBeUndefined();
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	t(
		"chat send roundtrips through echo; past and stats follow",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const send = (await (
					await fetch(`${srv.url}api/chat/send`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							origin: new URL(srv.url).origin,
						},
						body: JSON.stringify({ text: "SERVE-ECHO-PROBE" }),
					})
				).json()) as { ok: boolean; turnId: string };
				expect(send.ok).toBe(true);
				expect(send.turnId).toBeString();
				let seen = false;
				for (let i = 0; i < 50 && !seen; i++) {
					const h = (await (
						await fetch(`${srv.url}api/chat/history`)
					).json()) as {
						messages: { role: string; text: string }[];
					};
					const hasUser = h.messages.some(
						(m) => m.role === "user" && m.text.includes("SERVE-ECHO-PROBE"),
					);
					const hasEcho = h.messages.some(
						(m) => m.role === "agent" && m.text.includes("SERVE-ECHO-PROBE"),
					);
					seen = hasUser && hasEcho;
					if (seen) {
						// Pages ascend in both directions: user turn precedes its echo.
						const ui = h.messages.findIndex(
							(m) => m.role === "user" && m.text.includes("SERVE-ECHO-PROBE"),
						);
						const ai = h.messages.findIndex(
							(m) => m.role === "agent" && m.text.includes("SERVE-ECHO-PROBE"),
						);
						expect(ui).toBeGreaterThanOrEqual(0);
						expect(ai).toBeGreaterThan(ui);
					} else {
						await new Promise((r) => setTimeout(r, 200));
					}
				}
				expect(seen).toBe(true);
				const stats = (await (
					await fetch(`${srv.url}api/chat/stats`)
				).json()) as {
					ok: boolean;
				};
				expect(stats.ok).toBe(true);
				const past = (await (await fetch(`${srv.url}api/past`)).json()) as {
					pasts: unknown[];
				};
				expect(Array.isArray(past.pasts)).toBe(true);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	t(
		"concurrent first calls share one host (no sessionInUse)",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				// Page load fires these together; the drive grant must land on one host.
				const [h, p] = await Promise.all([
					fetch(`${srv.url}api/chat/history`).then((r) => r.json()),
					fetch(`${srv.url}api/past`).then((r) => r.json()),
				]);
				expect((h as { ok: boolean }).ok).toBe(true);
				expect(Array.isArray((p as { pasts: unknown[] }).pasts)).toBe(true);
				const send = (await (
					await fetch(`${srv.url}api/chat/send`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							origin: new URL(srv.url).origin,
						},
						body: JSON.stringify({ text: "RACE-PROBE" }),
					})
				).json()) as { ok: boolean; why?: string };
				expect(send.ok).toBe(true);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	t(
		"explicit host is honored and LAN urls listed",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
				host: "0.0.0.0",
			});
			try {
				expect(srv.hostname).toBe("0.0.0.0");
				expect(srv.url).toContain("127.0.0.1");
				for (const u of srv.urls) {
					expect(u).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/$/);
					expect(u).not.toContain("127.0.0.1");
				}
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);

	t(
		"control routes: models catalog, effort/access set, model honest",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const catalog = (await (
					await fetch(`${srv.url}api/chat/models`)
				).json()) as {
					ok: boolean;
					models: { modelId: string; label: string; isDefault: boolean }[];
				};
				expect(catalog.ok).toBe(true);
				expect(catalog.models.length).toBeGreaterThan(0);
				expect(catalog.models.some((m) => m.isDefault)).toBe(true);
				const effort = await fetch(`${srv.url}api/chat/effort`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: new URL(srv.url).origin,
					},
					body: JSON.stringify({ effort: "max" }),
				});
				expect(effort.status).toBe(200);
				const badEffort = await fetch(`${srv.url}api/chat/effort`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: new URL(srv.url).origin,
					},
					body: JSON.stringify({ effort: "turbo" }),
				});
				expect(badEffort.status).toBe(400);
				const access = await fetch(`${srv.url}api/chat/access`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: new URL(srv.url).origin,
					},
					body: JSON.stringify({ mode: "onRequest" }),
				});
				expect(access.status).toBe(200);
				// Echo rejects catalog models; the route must surface the host answer.
				const firstModel = catalog.models[0];
				if (!firstModel) throw new Error("empty model catalog");
				const model = (await (
					await fetch(`${srv.url}api/chat/model`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							origin: new URL(srv.url).origin,
						},
						body: JSON.stringify({ modelId: firstModel.modelId }),
					})
				).json()) as { ok: boolean; why: string };
				expect(model.ok).toBe(false);
				expect(model.why).toContain("commandRejected");
				const stats = (await (
					await fetch(`${srv.url}api/chat/stats`)
				).json()) as {
					effort: string;
					access: string;
				};
				expect(stats.effort).toBe("max");
				expect(stats.access).toBe("onRequest");
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	t(
		"stats carries computed context, msgs, and tokens",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				await fetch(`${srv.url}api/chat/send`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: new URL(srv.url).origin,
					},
					body: JSON.stringify({ text: "STATS-PROBE" }),
				});
				type ChatStats = {
					ok: boolean;
					msgs: number;
					contextPct: number | null;
					pressure: string | null;
					totalTokens: number | null;
				};
				let stats: ChatStats | null = null;
				for (let i = 0; i < 50; i++) {
					const s = (await (
						await fetch(`${srv.url}api/chat/stats`)
					).json()) as ChatStats;
					stats = s;
					if (s.msgs >= 2 && s.contextPct !== null) break;
					await new Promise((r) => setTimeout(r, 200));
				}
				if (!stats) throw new Error("chat stats never converged");
				expect(stats.msgs).toBeGreaterThanOrEqual(2);
				expect(typeof stats.contextPct).toBe("number");
				expect(stats.pressure).toBe("normal");
				expect(typeof stats.totalTokens).toBe("number");
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	t(
		"history carries structured items alongside messages",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				await fetch(`${srv.url}api/chat/send`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: new URL(srv.url).origin,
					},
					body: JSON.stringify({ text: "ITEMS-PROBE" }),
				});
				type HistoryItem = { kind: string; role?: string; text?: string };
				let items: HistoryItem[] | null = null;
				for (let i = 0; i < 50; i++) {
					const h = (await (
						await fetch(`${srv.url}api/chat/history`)
					).json()) as {
						messages: unknown[];
						items: HistoryItem[] | null;
					};
					if (Array.isArray(h.items) && h.items.length >= 2) {
						items = h.items;
						break;
					}
					await new Promise((r) => setTimeout(r, 200));
				}
				expect(items).not.toBeNull();
				if (!items) throw new Error("history items never arrived");
				expect(items.map((m) => m.kind)).toContain("userMessage");
				expect(items.map((m) => m.kind)).toContain("agentMessage");
				expect(items.every((m) => typeof m.kind === "string")).toBe(true);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	t(
		"output route validates params and surfaces host errors",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const missing = await fetch(`${srv.url}api/chat/output`);
				expect(missing.status).toBe(400);
				const bogus = (await (
					await fetch(`${srv.url}api/chat/output?itemId=nope&ref=nope`)
				).json()) as { ok: boolean; why: string };
				expect(bogus.ok).toBe(false);
				expect(typeof bogus.why).toBe("string");
				expect(bogus.why.length).toBeGreaterThan(0);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	t(
		"live item events carry mapped rows",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			const ctl = new AbortController();
			try {
				const r = await fetch(`${srv.url}api/chat/events`, {
					signal: ctl.signal,
				});
				expect(r.status).toBe(200);
				if (!r.body) throw new Error("empty SSE body");
				const reader = r.body.getReader();
				const dec = new TextDecoder();
				let buf = "";
				const found = (async () => {
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) return false;
							buf += dec.decode(value, { stream: true });
							if (
								buf.includes('"method":"item/completed"') &&
								buf.includes('"row":{') &&
								buf.includes('"kind":"agentMessage"')
							) {
								return true;
							}
							if (buf.length > 500000) return false;
						}
					} catch {
						return false;
					}
				})();
				const send = await fetch(`${srv.url}api/chat/send`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: new URL(srv.url).origin,
					},
					body: JSON.stringify({ text: "ROW-PROBE" }),
				});
				expect(send.status).toBe(200);
				const timeout = new Promise((resolve) =>
					setTimeout(() => resolve(false), 30000),
				);
				const ok = await Promise.race([found, timeout]);
				ctl.abort();
				expect(ok).toBe(true);
			} finally {
				ctl.abort();
				await srv.stop();
			}
		},
		60_000,
	);

	t(
		"chat events stream as SSE",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const ctl = new AbortController();
				const r = await fetch(`${srv.url}api/chat/events`, {
					signal: ctl.signal,
				});
				expect(r.status).toBe(200);
				expect(r.headers.get("content-type")).toContain("text/event-stream");
				if (!r.body) throw new Error("empty SSE body");
				const reader = r.body.getReader();
				const { value } = await reader.read();
				ctl.abort();
				expect(new TextDecoder().decode(value)).toContain("connected");
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);

	t(
		"sse heartbeat holds the stream through quiet stretches",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
				heartbeatMs: 100,
			});
			const ctl = new AbortController();
			try {
				const r = await fetch(`${srv.url}api/chat/events`, {
					signal: ctl.signal,
				});
				expect(r.status).toBe(200);
				if (!r.body) throw new Error("empty SSE body");
				const reader = r.body.getReader();
				const dec = new TextDecoder();
				let buf = "";
				const deadline = Date.now() + 5000;
				for (;;) {
					if (buf.includes(": ping")) break;
					if (Date.now() > deadline) break;
					const { done, value } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
				}
				ctl.abort();
				expect(buf).toContain(": ping");
			} finally {
				ctl.abort();
				await srv.stop();
			}
		},
		30_000,
	);
});

describe("auth (T39)", () => {
	// Encrypted-empty CDB fixture: 0 records, password below. Generated
	// once via centrs@0b3f589 writeWinBoxCdb([], {encryptWith}) — the CLI
	// cannot produce encrypted CDBs (see docs/design/t39-auth-design.md).
	const ENCRYPTED_FIXTURE = path.join(
		import.meta.dir,
		"fixtures",
		"cdb-encrypted-empty.cdb",
	);
	const FIXTURE_PASSWORD = "t39-fixture-password";

	function cookieFrom(res: Response): string | null {
		const set = res.headers.get("set-cookie");
		if (!set) return null;
		const m = /rmsid=([^;]+)/.exec(set);
		return m?.[1] ? `rmsid=${m[1]}` : null;
	}

	async function postJson(
		url: string,
		body: unknown,
		cookie?: string,
	): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: new URL(url).origin,
				...(cookie ? { cookie } : {}),
			},
			body: JSON.stringify(body),
		});
		return {
			status: res.status,
			json: (await res.json()) as Record<string, unknown>,
			res,
		};
	}

	tcentrs(
		"locked workspace: state, wrong password, unlock, cookie gate, lock",
		async () => {
			const ws = makeWorkspace();
			nodeFs.copyFileSync(ENCRYPTED_FIXTURE, path.join(ws, "device.cdb"));
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const st = (await (await fetch(`${srv.url}api/auth/state`)).json()) as {
					state: string;
					cdb: string;
				};
				expect(st.state).toBe("locked");
				expect(st.cdb).toBe("workspace");
				expect((await fetch(`${srv.url}api/status`)).status).toBe(401);
				const bad = await postJson(`${srv.url}api/auth/unlock`, {
					password: "wrong",
				});
				expect(bad.status).toBe(401);
				expect(bad.json["code"]).toBe("cdb/decrypt-failed");
				const good = await postJson(`${srv.url}api/auth/unlock`, {
					password: FIXTURE_PASSWORD,
				});
				expect(good.status).toBe(200);
				const cookie = cookieFrom(good.res);
				expect(cookie).not.toBeNull();
				const authed = await fetch(`${srv.url}api/status`, {
					headers: { cookie: cookie as string },
				});
				expect(authed.status).toBe(200);
				const locked = await postJson(
					`${srv.url}api/auth/lock`,
					{},
					cookie as string,
				);
				expect(locked.status).toBe(200);
				const relocked = await fetch(`${srv.url}api/status`, {
					headers: { cookie: cookie as string },
				});
				expect(relocked.status).toBe(401);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	function makeOpenCdbWorkspace(): string {
		const ws = makeWorkspace();
		const file = path.join(ws, "device.cdb");
		const init = childProcess.spawnSync("centrs", ["devices", "init"], {
			env: { ...process.env, CENTRS_CDB_FILE: file },
		});
		expect(init.status).toBe(0);
		return ws;
	}

	tcentrs(
		"open workspace without flag refuses with guidance state",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				workspace: makeOpenCdbWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const st = (await (await fetch(`${srv.url}api/auth/state`)).json()) as {
					state: string;
				};
				expect(st.state).toBe("open-needs-encryption");
				const denied = await fetch(`${srv.url}api/status`);
				expect(denied.status).toBe(401);
				expect(((await denied.json()) as { code: string }).code).toBe(
					"auth/open-cdb",
				);
				const unlock = await postJson(`${srv.url}api/auth/unlock`, {
					password: "anything",
				});
				expect(unlock.status).toBe(400);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tcentrs(
		"open workspace with flag enters bypassed",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeOpenCdbWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const st = (await (await fetch(`${srv.url}api/auth/state`)).json()) as {
					state: string;
				};
				expect(st.state).toBe("bypassed");
				expect((await fetch(`${srv.url}api/status`)).status).toBe(200);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	test("probe maps outcomes: only authRequired means absent", async () => {
		const stub = (terminal: string, error?: { kind?: string }) => async () => ({
			sessionStart: async () => ({ session: { sessionId: "s-probe" } }),
			runTurn: async () => ({ terminal, ...(error ? { error } : {}) }),
			call: async () => ({}),
			close: async () => {},
		});
		const ws = os.tmpdir();
		expect(await probeMetaAuth(stub("completed"), ws)).toBe("authed");
		expect(
			await probeMetaAuth(stub("failed", { kind: "authRequired" }), ws),
		).toBe("absent");
		expect(await probeMetaAuth(stub("failed", { kind: "other" }), ws)).toBe(
			"unknown",
		);
		expect(
			await probeMetaAuth(async () => {
				throw new Error("boom");
			}, ws),
		).toBe("unknown");
	});

	t(
		"hermetic logged-out probe reports absent (no turn cost)",
		async () => {
			const home = mktmp("t39-nohome-");
			const config = mktmp("t39-noconfig-");
			nodeFs.mkdirSync(path.join(config, "muse"), { recursive: true });
			const ws = mktmp("t39-probe-ws-");
			const got = await probeMetaAuth(
				() =>
					MspClient.spawn({
						provider: "meta",
						museHome: home,
						museConfigHome: config,
						// T55: every spawn carries the ui config (the
						// logged-out probe never reaches a tool call).
						mcpServers: uiMcpServers({
							bridge: path.join(
								path.resolve(import.meta.dir, ".."),
								"src",
								"mcp",
								"ui-bridge.ts",
							),
							bun: process.execPath,
							url: "http://127.0.0.1:9/",
							token: "t39-dummy-token",
						}),
					}),
				ws,
			);
			expect(got).toBe("absent");
		},
		60_000,
	);
});

describe("package tool bundle (T51)", () => {
	// POSIX-only: the stub trilogy is shell scripts. No muse or real
	// centrs needed — hermetic by construction.
	const tstub = process.platform === "win32" ? test.skip : test;

	function stubTrilogy(): string {
		const dir = mktmp("t51-srvbin-");
		const shim = (name: string, body: string): void => {
			const file = path.join(dir, name);
			nodeFs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
			nodeFs.chmodSync(file, 0o755);
		};
		shim(
			"centrs",
			`if [ "$1" = "devices" ]; then printf '%s\\n' '{"ok":true,"data":[{"target":"stub-gw","user":"admin"},{"target":"__default__","user":"fallback"}],"warnings":[],"tips":[],"meta":{}}'; else echo "stub-centrs 9.9.2-stub"; fi`,
		);
		shim(
			"quickchr",
			`if [ "$1" = "list" ]; then echo "[]"; else echo "stub-quickchr 9.9.1-stub"; fi`,
		);
		shim("rosetta", `echo "stub-rosetta 9.9.3-stub"`);
		return dir;
	}

	async function stubServer(bin: string): Promise<{
		url: string;
		stop: () => Promise<void>;
	}> {
		const srv = await startServer({
			dataHome: makeDataHome(),
			configHome: mktmp("t31-serve-cfg-"),
			noWorkspace: true,
			allowOpenCdb: true,
			provider: "echo",
			museHome: makeHome(),
			toolBinDir: bin,
		});
		return srv;
	}

	tstub(
		"status reports the fronted bundle source and versions",
		async () => {
			const bin = stubTrilogy();
			const srv = await stubServer(bin);
			try {
				const status = (await (await fetch(`${srv.url}api/status`)).json()) as {
					tools: {
						source: string;
						binDir: string;
						versions: Record<string, string | null>;
					};
				};
				expect(status.tools.source).toBe("package");
				expect(status.tools.binDir).toBe(bin);
				expect(status.tools.versions).toEqual({
					quickchr: "9.9.1-stub",
					centrs: "9.9.2-stub",
					rosetta: "9.9.3-stub",
				});
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tstub(
		"no-workspace inventory resolves centrs through the bundle",
		async () => {
			const bin = stubTrilogy();
			const srv = await stubServer(bin);
			try {
				const body = (await (await fetch(`${srv.url}api/devices`)).json()) as {
					devices: { id: string; cdb: string; user?: string }[];
					source: string;
				};
				expect(body.source).toBe("cdb");
				expect(body.devices).toEqual([
					{ id: "stub-gw", cdb: "stub-gw", user: "admin" },
				]);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);
});

describe("unlock context (T64)", () => {
	const ENCRYPTED_FIXTURE = path.join(
		import.meta.dir,
		"fixtures",
		"cdb-encrypted-empty.cdb",
	);
	const FIXTURE_PASSWORD = "t39-fixture-password";
	// Stub shims are POSIX shell; the acceptance legs also need ambient
	// muse (spawn gate), real centrs, and the installed bundle.
	const t64stub = process.platform === "win32" ? test.skip : test;
	const t64acc =
		HAVE_MUSE && HAVE_CENTRS && toolBinDir() !== null ? t64stub : test.skip;

	function writeShim(dir: string, name: string, body: string): void {
		const file = path.join(dir, name);
		nodeFs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
		nodeFs.chmodSync(file, 0o755);
	}

	function cookieFrom(res: Response): string | null {
		const set = res.headers.get("set-cookie");
		if (!set) return null;
		const m = /rmsid=([^;]+)/.exec(set);
		return m?.[1] ? `rmsid=${m[1]}` : null;
	}

	async function postJson(
		url: string,
		body: unknown,
		cookie?: string,
	): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: new URL(url).origin,
				...(cookie ? { cookie } : {}),
			},
			body: JSON.stringify(body),
		});
		return {
			status: res.status,
			json: (await res.json()) as Record<string, unknown>,
			res,
		};
	}

	test("sessions bind the unlock context and drop it on revoke", () => {
		const store = createSessionStore();
		expect(store.ctx(null)).toBeNull();
		expect(store.ctx("nope")).toBeNull();
		const token = store.issue();
		expect(store.valid(token)).toBe(true);
		expect(store.ctx(token)).toBeNull();
		store.bind(token, { cdbFile: "/ws/device.cdb", password: "pw" });
		expect(store.ctx(token)).toEqual({
			cdbFile: "/ws/device.cdb",
			password: "pw",
		});
		store.bind("nope", { cdbFile: null, password: "x" });
		expect(store.ctx("nope")).toBeNull();
		store.revoke(token);
		expect(store.valid(token)).toBe(false);
		expect(store.ctx(token)).toBeNull();
	});

	test("workerEnv layers the CDB binding on a fresh record", () => {
		const base = { PATH: "/bin", KEEP: "yes" };
		const full = workerEnv(base, "/ws/device.cdb", "pw");
		expect(full["CENTRS_CDB_FILE"]).toBe("/ws/device.cdb");
		expect(full["CENTRS_CDB_PASSWORD"]).toBe("pw");
		expect(full["PATH"]).toBe("/bin");
		expect(full["KEEP"]).toBe("yes");
		const anon = workerEnv(base, null, null);
		expect("CENTRS_CDB_FILE" in anon).toBe(false);
		expect("CENTRS_CDB_PASSWORD" in anon).toBe(false);
		const nopw = workerEnv(base, "/ws/device.cdb", null);
		expect(nopw["CENTRS_CDB_FILE"]).toBe("/ws/device.cdb");
		expect("CENTRS_CDB_PASSWORD" in nopw).toBe(false);
		const empty = workerEnv(base, null, "");
		expect("CENTRS_CDB_PASSWORD" in empty).toBe(false);
		full["PATH"] = "mutated";
		expect(base).toEqual({ PATH: "/bin", KEEP: "yes" });
	});

	test("cdb rows preserve (target,user) and drop everything sensitive", () => {
		expect(
			cdbRowsToDevices([
				{
					target: "gw",
					user: "admin",
					password: "s3cret",
					savedPassword: true,
					sources: { target: { kind: "cdb" } },
				},
				{ target: "__default__", user: "fallback", password: "x" },
				{ target: "nou", password: "y" },
			]),
		).toEqual([
			{ id: "gw", cdb: "gw", user: "admin" },
			{ id: "nou", cdb: "nou" },
		]);
		for (const row of cdbRowsToDevices([
			{ target: "g", password: "p", pass: "p", secret: "p" },
		])) {
			expect("password" in row).toBe(false);
			expect(JSON.stringify(row)).not.toContain('"p"');
		}
	});

	tcentrs("detection strips an inherited CDB password", async () => {
		const withPw = toolEnv(null, {
			...process.env,
			CENTRS_CDB_PASSWORD: FIXTURE_PASSWORD,
		});
		expect((await detectCdbMode(ENCRYPTED_FIXTURE, withPw)).mode).toBe(
			"encrypted",
		);
		const withWrong = toolEnv(null, {
			...process.env,
			CENTRS_CDB_PASSWORD: "wrong",
		});
		expect((await detectCdbMode(ENCRYPTED_FIXTURE, withWrong)).mode).toBe(
			"encrypted",
		);
	});

	tcentrs("detection reports an explicit missing path as missing", async () => {
		const dir = mktmp("t64-missing-");
		const got = await detectCdbMode(path.join(dir, "device.cdb"));
		expect(got.mode).toBe("missing");
	});

	t64stub(
		"verify refuses the open-file warning with a single spawn",
		async () => {
			const dir = mktmp("t64-verbin-");
			const calls = path.join(dir, "calls.log");
			writeShim(
				dir,
				"centrs",
				`echo call >> ${JSON.stringify(calls)}\nprintf '%s\\n' '{"ok":true,"data":[],"warnings":[{"code":"cdb/password-not-needed","message":"ignored"}],"tips":[],"meta":{}}'`,
			);
			const out = await verifyCdbPassword(
				"/fake/open.cdb",
				"anything",
				toolEnv(dir),
			);
			expect(out.ok).toBe(false);
			if (out.ok) throw new Error("open file verified");
			expect(out.code).toBe("cdb/password-not-needed");
			expect(
				nodeFs.readFileSync(calls, "utf8").trim().split("\n"),
			).toHaveLength(1);
		},
	);

	tcentrs("verify requires encrypted against real CDBs", async () => {
		const dir = mktmp("t64-verify-");
		const openCdb = path.join(dir, "open.cdb");
		const init = childProcess.spawnSync("centrs", ["devices", "init"], {
			env: { ...process.env, CENTRS_CDB_FILE: openCdb },
		});
		expect(init.status).toBe(0);
		expect((await verifyCdbPassword(openCdb, "anything")).ok).toBe(false);
		const bad = await verifyCdbPassword(ENCRYPTED_FIXTURE, "wrong");
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.code).toBe("cdb/decrypt-failed");
		expect(
			(await verifyCdbPassword(ENCRYPTED_FIXTURE, FIXTURE_PASSWORD)).ok,
		).toBe(true);
	});

	tcentrs(
		"missing workspace routes to setup state and refuses honestly",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const st = (await (await fetch(`${srv.url}api/auth/state`)).json()) as {
					state: string;
					mode: string;
					cdb: string;
					cdbFile: string;
				};
				expect(st.state).toBe("missing");
				expect(st.mode).toBe("missing");
				expect(st.cdb).toBe("workspace");
				expect(st.cdbFile).toContain("device.cdb");
				const denied = await fetch(`${srv.url}api/status`);
				expect(denied.status).toBe(401);
				expect(((await denied.json()) as { code: string }).code).toBe(
					"auth/missing",
				);
				const unlock = await postJson(`${srv.url}api/auth/unlock`, {
					password: "anything",
				});
				expect(unlock.status).toBe(400);
				expect(unlock.json["code"]).toBe("auth/missing");
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tcentrs(
		"missing workspace with the flag enters bypassed",
		async () => {
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const st = (await (await fetch(`${srv.url}api/auth/state`)).json()) as {
					state: string;
					mode: string;
				};
				expect(st.state).toBe("bypassed");
				expect(st.mode).toBe("missing");
				expect((await fetch(`${srv.url}api/status`)).status).toBe(200);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	t64stub(
		"device rows carry no password key",
		async () => {
			const bin = mktmp("t64-redact-");
			writeShim(
				bin,
				"centrs",
				`printf '%s\\n' '{"ok":true,"data":[{"target":"redact-gw","user":"admin","password":"s3cret","sources":{}}],"warnings":[],"tips":[],"meta":{}}'`,
			);
			writeShim(bin, "quickchr", `echo "[]"`);
			writeShim(bin, "rosetta", `echo "stub-rosetta 9.9.3-stub"`);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				noWorkspace: true,
				allowOpenCdb: true,
				provider: "echo",
				museHome: makeHome(),
				toolBinDir: bin,
			});
			try {
				const body = (await (await fetch(`${srv.url}api/devices`)).json()) as {
					devices: Record<string, unknown>[];
					source: string;
				};
				expect(body.source).toBe("cdb");
				expect(body.devices).toEqual([
					{ id: "redact-gw", cdb: "redact-gw", user: "admin" },
				]);
				for (const row of body.devices) {
					expect("password" in row).toBe(false);
				}
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	// Stub-muse bindir: the stub answers initialize + session/start +
	// turn/start with canned ids (the server's fixed call order) and
	// records its spawn env; the trilogy symlinks ARE the installed
	// package builds, so both legs prove package-selected resolution.
	function stubMuseBin(): { bin: string; seen: string } {
		const realBin = toolBinDir();
		if (!realBin) throw new Error("installed bundle required");
		const bin = mktmp("t64-musebin-");
		const seen = path.join(bin, "muse-env.txt");
		const out = JSON.stringify(seen);
		writeShim(
			bin,
			"muse",
			`{\necho "PATH0=$(printf '%s' "$PATH" | cut -d: -f1)"\necho "CDB_FILE=\${CENTRS_CDB_FILE:-}"\necho "CDB_PASSWORD=\${CENTRS_CDB_PASSWORD:-}"\n} > ${out}\nIFS= read -r _l1\nprintf '{"jsonrpc":"2.0","id":1,"result":{}}\\n'\nIFS= read -r _l2\nIFS= read -r _l3\nprintf '{"jsonrpc":"2.0","id":2,"result":{"session":{"sessionId":"stub-s"},"viewCursor":""}}\\n'\nIFS= read -r _l4\nprintf '{"jsonrpc":"2.0","id":3,"result":{}}\\n'\nIFS= read -r _l5\nprintf '{"jsonrpc":"2.0","id":4,"result":{"turnId":"stub-t","disposition":"started"}}\\n'\ncat > /dev/null\necho "STDIN_CLOSED" >> ${out}`,
		);
		for (const t of ["quickchr", "centrs", "rosetta"]) {
			nodeFs.symlinkSync(path.join(realBin, t), path.join(bin, t));
		}
		return { bin, seen };
	}

	function seedEncrypted(): string {
		const dir = mktmp("t64-seed-");
		const cdb = path.join(dir, "seeded.cdb");
		nodeFs.copyFileSync(ENCRYPTED_FIXTURE, cdb);
		const added = childProcess.spawnSync(
			"centrs",
			[
				"devices",
				"add",
				"t64-gw",
				"--user",
				"t64-admin",
				"--cdb-file",
				cdb,
				"--format",
				"json",
			],
			{
				env: { ...process.env, CENTRS_CDB_PASSWORD: FIXTURE_PASSWORD },
			},
		);
		expect(added.status).toBe(0);
		return cdb;
	}

	t64acc(
		"unlock propagates to UI devices and the agent worker env",
		async () => {
			const savedPw = process.env["CENTRS_CDB_PASSWORD"];
			delete process.env["CENTRS_CDB_PASSWORD"];
			try {
				const { bin, seen } = stubMuseBin();
				// Both legs resolve the identical package builds: the
				// fronted centrs is the installed bundle file itself.
				expect(nodeFs.realpathSync(path.join(bin, "centrs"))).toBe(
					nodeFs.realpathSync(path.join(toolBinDir() as string, "centrs")),
				);
				const cdb = seedEncrypted();
				const srv = await startServer({
					dataHome: makeDataHome(),
					configHome: mktmp("t31-serve-cfg-"),
					noWorkspace: true,
					provider: "echo",
					museHome: makeHome(),
					cdbFile: cdb,
					toolBinDir: bin,
				});
				try {
					const st0 = (await (
						await fetch(`${srv.url}api/auth/state`)
					).json()) as { state: string };
					expect(st0.state).toBe("locked");
					const good = await postJson(`${srv.url}api/auth/unlock`, {
						password: FIXTURE_PASSWORD,
					});
					expect(good.status).toBe(200);
					const cookie = cookieFrom(good.res);
					expect(cookie).not.toBeNull();
					// UI leg: the unlocked session reads the encrypted CDB.
					const dev = (await (
						await fetch(`${srv.url}api/devices`, {
							headers: { cookie: cookie as string },
						})
					).json()) as {
						devices: unknown[];
						source: string;
						why?: string;
					};
					expect(dev.source).toBe("cdb");
					expect(dev.why).toBeUndefined();
					expect(dev.devices).toEqual([
						{
							id: "t64-gw",
							cdb: "t64-gw",
							user: "t64-admin",
							hasPassword: false,
						},
					]);
					// Agent leg: the worker spawns under the unlock context.
					const send = await postJson(
						`${srv.url}api/chat/send`,
						{ text: "T64-AGENT-PROBE" },
						cookie as string,
					);
					expect(send.status).toBe(200);
					expect(send.json["ok"]).toBe(true);
					const observed = Object.fromEntries(
						nodeFs
							.readFileSync(seen, "utf8")
							.trim()
							.split("\n")
							.map((l) => {
								const i = l.indexOf("=");
								return [l.slice(0, i), l.slice(i + 1)];
							}),
					);
					expect(observed["CDB_FILE"]).toBe(cdb);
					expect(observed["CDB_PASSWORD"]).toBe(FIXTURE_PASSWORD);
					expect(observed["PATH0"]).toBe(bin);
					// Both sides report the package bundle, real versions.
					const status = (await (
						await fetch(`${srv.url}api/status`, {
							headers: { cookie: cookie as string },
						})
					).json()) as {
						tools: {
							source: string;
							binDir: string;
							versions: Record<string, string | null>;
						};
					};
					expect(status.tools.source).toBe("package");
					expect(status.tools.binDir).toBe(bin);
					expect(status.tools.versions["centrs"]).toMatch(/^\d+\.\d+\.\d+/);
				} finally {
					await srv.stop();
				}
			} finally {
				if (savedPw === undefined) delete process.env["CENTRS_CDB_PASSWORD"];
				else process.env["CENTRS_CDB_PASSWORD"] = savedPw;
			}
		},
		120_000,
	);

	t64acc(
		"lock revokes the token, stops its worker, and drops the context",
		async () => {
			const { bin, seen } = stubMuseBin();
			const cdb = seedEncrypted();
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				noWorkspace: true,
				provider: "echo",
				museHome: makeHome(),
				cdbFile: cdb,
				toolBinDir: bin,
			});
			try {
				const good = await postJson(`${srv.url}api/auth/unlock`, {
					password: FIXTURE_PASSWORD,
				});
				expect(good.status).toBe(200);
				const cookie = cookieFrom(good.res);
				expect(cookie).not.toBeNull();
				const send = await postJson(
					`${srv.url}api/chat/send`,
					{ text: "T64-LOCK-PROBE" },
					cookie as string,
				);
				expect(send.json["ok"]).toBe(true);
				expect(nodeFs.readFileSync(seen, "utf8")).not.toContain("STDIN_CLOSED");
				const lock = await postJson(
					`${srv.url}api/auth/lock`,
					{},
					cookie as string,
				);
				expect(lock.status).toBe(200);
				// Token revoked: the old cookie no longer admits anything.
				expect(
					(
						await fetch(`${srv.url}api/status`, {
							headers: { cookie: cookie as string },
						})
					).status,
				).toBe(401);
				// Worker stopped: lock awaited the close, so the child's
				// stdin saw EOF and the process exited (nothing left holds
				// the dropped context).
				expect(nodeFs.readFileSync(seen, "utf8")).toContain("STDIN_CLOSED");
				// The server survives the stop: unlock again, chat again.
				const good2 = await postJson(`${srv.url}api/auth/unlock`, {
					password: FIXTURE_PASSWORD,
				});
				expect(good2.status).toBe(200);
				const cookie2 = cookieFrom(good2.res);
				const send2 = await postJson(
					`${srv.url}api/chat/send`,
					{ text: "T64-AFTER-LOCK" },
					cookie2 as string,
				);
				expect(send2.status).toBe(200);
				expect(send2.json["ok"]).toBe(true);
			} finally {
				await srv.stop();
			}
		},
		120_000,
	);
});

describe("set credentials (T48)", () => {
	const T48_FIXTURE = path.join(
		import.meta.dir,
		"fixtures",
		"cdb-encrypted-empty.cdb",
	);
	const T48_FIXTURE_PASSWORD = "t39-fixture-password";

	type SeedRecord = {
		target: string;
		user?: string;
		password?: string;
		sshKey?: string;
	};

	function seedOpenCdb(records: SeedRecord[]): string {
		const dir = mktmp("t48-seed-");
		const cdb = path.join(dir, "seeded.cdb");
		const env = { ...process.env, CENTRS_CDB_FILE: cdb };
		const init = childProcess.spawnSync("centrs", ["devices", "init"], { env });
		expect(init.status).toBe(0);
		for (const r of records) {
			const args = ["devices", "add", r.target, "--format", "json"];
			if (r.user !== undefined) args.push("--user", r.user);
			if (r.password !== undefined) args.push("--password", r.password);
			if (r.sshKey !== undefined) args.push(`ssh-key=${r.sshKey}`);
			const added = childProcess.spawnSync("centrs", args, { env });
			expect(added.status).toBe(0);
		}
		return cdb;
	}

	function seedEncryptedCdb(user?: string): string {
		const dir = mktmp("t48-enc-");
		const cdb = path.join(dir, "seeded.cdb");
		nodeFs.copyFileSync(T48_FIXTURE, cdb);
		const env = {
			...process.env,
			CENTRS_CDB_FILE: cdb,
			CENTRS_CDB_PASSWORD: T48_FIXTURE_PASSWORD,
		};
		const args = ["devices", "add", "t48-target", "--format", "json"];
		if (user !== undefined) args.push("--user", user);
		const added = childProcess.spawnSync("centrs", args, { env });
		expect(added.status).toBe(0);
		return cdb;
	}

	/** D53: the workspace device.cdb is the device list; no router.toml. */
	function makeCredWorkspace(cdb: string): string {
		const dir = mktmp("t48-ws-");
		nodeFs.writeFileSync(
			path.join(dir, "workspace.toml"),
			"canonical = true\n",
		);
		nodeFs.copyFileSync(cdb, path.join(dir, "device.cdb"));
		return dir;
	}

	/** Direct readback for assertions (never printed, never logged). */
	function centrsShow(
		cdb: string,
		target: string,
		cdbPassword?: string,
	): Record<string, unknown> {
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			CENTRS_CDB_FILE: cdb,
		};
		if (cdbPassword !== undefined) env["CENTRS_CDB_PASSWORD"] = cdbPassword;
		const out = childProcess.spawnSync(
			"centrs",
			["devices", "show", target, "--format", "json"],
			{ env },
		);
		expect(out.status).toBe(0);
		const parsed = JSON.parse(
			out.stdout.toString() || out.stderr.toString(),
		) as Record<string, unknown>;
		expect(parsed["ok"]).toBe(true);
		return (parsed["data"] as Record<string, unknown>)["entry"] as Record<
			string,
			unknown
		>;
	}

	function centrsSet(
		cdb: string,
		target: string,
		args: string[],
		cdbPassword?: string,
	): void {
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			CENTRS_CDB_FILE: cdb,
		};
		if (cdbPassword !== undefined) env["CENTRS_CDB_PASSWORD"] = cdbPassword;
		const out = childProcess.spawnSync(
			"centrs",
			["devices", "set", target, ...args, "--format", "json"],
			{ env },
		);
		expect(out.status).toBe(0);
	}

	function t48cookie(res: Response): string | null {
		const set = res.headers.get("set-cookie");
		if (!set) return null;
		const m = /rmsid=([^;]+)/.exec(set);
		return m?.[1] ? `rmsid=${m[1]}` : null;
	}

	async function t48post(
		url: string,
		body: unknown,
		cookie?: string,
	): Promise<{ status: number; json: Record<string, unknown> }> {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: new URL(url).origin,
				...(cookie ? { cookie } : {}),
			},
			body: JSON.stringify(body),
		});
		return {
			status: res.status,
			json: (await res.json()) as Record<string, unknown>,
		};
	}

	test("projection drops secrets and parses the ssh-key pair", () => {
		const got = projectCdbEntry({
			target: "gw",
			user: "admin",
			password: "s3cret",
			savedPassword: true,
			commentMirror: "ssh-key=/home/op/.ssh/id_ed25519 www-port=7080",
			profile: "<none>",
			recordTypeName: "ipAdmin",
			group: "",
			session: "s1",
		});
		expect(got).toMatchObject({
			target: "gw",
			ports: { "www-port": "7080" },
			user: "admin",
			group: "",
			recordTypeName: "ipAdmin",
			session: "s1",
			profile: "<none>",
			hasPassword: true,
			sshKey: "/home/op/.ssh/id_ed25519",
		});
		expect(JSON.stringify(got)).not.toContain("s3cret");
		expect(
			projectCdbEntry({ target: "bare", savedPassword: false }),
		).toMatchObject({ hasPassword: false, sshKey: "", ports: {} });
		expect(projectCdbEntry(null)).toBeNull();
		expect(projectCdbEntry({ user: "no-target" })).toBeNull();
		expect(projectCdbEntry([{ target: "array-is-not-an-entry" }])).toBeNull();
	});

	test("snapshots distinguish drift and only drift", () => {
		const base = {
			target: "gw",
			user: "admin",
			group: "",
			recordTypeName: "ipAdmin",
			session: "",
			profile: "<none>",
			hasPassword: false,
			sshKey: "",
		};
		expect(credentialSnapshot(base)).toBe(credentialSnapshot({ ...base }));
		expect(credentialSnapshot({ ...base, user: "root" })).not.toBe(
			credentialSnapshot(base),
		);
		expect(credentialSnapshot({ ...base, hasPassword: true })).not.toBe(
			credentialSnapshot(base),
		);
		expect(credentialSnapshot({ ...base, sshKey: "/k" })).not.toBe(
			credentialSnapshot(base),
		);
		// Ports are part of the snapshot; an absent map equals an empty one.
		expect(
			credentialSnapshot({ ...base, ports: { "www-port": "7080" } }),
		).not.toBe(credentialSnapshot(base));
		expect(credentialSnapshot({ ...base, ports: {} })).toBe(
			credentialSnapshot(base),
		);
	});

	test("port keys parse from the comment kv-soup (centrs#618)", () => {
		expect([...PORT_KEYS]).toEqual([
			"www-port",
			"www-ssl-port",
			"api-port",
			"api-ssl-port",
			"ssh-port",
		]);
		expect(portsOf("ssh-key=/k www-port=7080;api-ssl-port=8729", "")).toEqual({
			"www-port": "7080",
			"api-ssl-port": "8729",
		});
		// The mirror wins over the comment, per key.
		expect(portsOf("www-port=1", "www-port=2")).toEqual({ "www-port": "2" });
		// Only whole keys: www-ssl-port must not satisfy www-port.
		expect(portsOf("www-ssl-port=443", "")).toEqual({ "www-ssl-port": "443" });
		// Unknown keys and non-strings are ignored.
		expect(portsOf("telnet-port=23", "")).toEqual({});
		expect(portsOf(undefined, null)).toEqual({});
	});

	test("port values are empty (clear) or 1-65535", () => {
		for (const v of ["", "1", "80", "65535"])
			expect(validPortValue(v)).toBe(true);
		for (const v of ["0", "65536", "123456", "-1", "8o", " 80", "1.5"])
			expect(validPortValue(v)).toBe(false);
		expect(validPortValue(80)).toBe(false);
		expect(validPortValue(undefined)).toBe(false);
	});

	test("cleanPorts keeps known keys, refuses anything else whole", () => {
		expect(cleanPorts(undefined)).toEqual({});
		expect(cleanPorts(null)).toEqual({});
		expect(cleanPorts({ "www-port": "7080", "ssh-port": "" })).toEqual({
			"www-port": "7080",
			"ssh-port": "",
		});
		expect(cleanPorts({ "www-port": "7080", "telnet-port": "23" })).toBeNull();
		expect(cleanPorts({ "www-port": "70000" })).toBeNull();
		expect(cleanPorts({ "www-port": 7080 })).toBeNull();
		expect(cleanPorts(["www-port"])).toBeNull();
		expect(cleanPorts("www-port=80")).toBeNull();
	});

	tcentrs(
		"inventory marks password presence per row",
		async () => {
			const cdb = seedOpenCdb([
				{ target: "t48-with", user: "admin", password: "t48-seed-pw" },
				{ target: "t48-without", user: "admin" },
			]);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				noWorkspace: true,
				allowOpenCdb: true,
				provider: "echo",
				museHome: makeHome(),
				cdbFile: cdb,
			});
			try {
				const body = (await (await fetch(`${srv.url}api/devices`)).json()) as {
					devices: Record<string, unknown>[];
					source: string;
				};
				expect(body.source).toBe("cdb");
				const marks = Object.fromEntries(
					body.devices.map((d) => [d["id"], d["hasPassword"]]),
				);
				expect(marks).toEqual({ "t48-with": true, "t48-without": false });
				expect(JSON.stringify(body)).not.toContain("t48-seed-pw");
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tcentrs(
		"GET details are redacted; an unknown target answers missing",
		async () => {
			const cdb = seedOpenCdb([
				{
					target: "t48-target",
					user: "admin",
					password: "t48-seed-pw",
					sshKey: "/home/op/.ssh/id_ed25519",
				},
			]);
			const ws = makeCredWorkspace(cdb);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const good = (await (
					await fetch(`${srv.url}api/devices/t48-target/credentials`)
				).json()) as { ok: boolean; details: Record<string, unknown> };
				expect(good.ok).toBe(true);
				expect(good.details).toMatchObject({
					target: "t48-target",
					ports: {},
					user: "admin",
					hasPassword: true,
					sshKey: "/home/op/.ssh/id_ed25519",
				});
				expect("password" in good.details).toBe(false);
				// D53: the id IS the CDB target; an unknown one is a
				// missing record (the modal's create path), not a 404.
				const unknown = await fetch(`${srv.url}api/devices/nope/credentials`);
				expect(unknown.status).toBe(200);
				expect(await unknown.json()).toMatchObject({
					ok: false,
					missing: true,
					code: "cdb/not-found-target",
				});
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tcentrs(
		"POST writes credentials and the record reads back",
		async () => {
			const cdb = seedOpenCdb([{ target: "t48-target", user: "admin" }]);
			const ws = makeCredWorkspace(cdb);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const before = (await (
					await fetch(`${srv.url}api/devices/t48-target/credentials`)
				).json()) as { ok: boolean; details: Record<string, unknown> };
				expect(before.ok).toBe(true);
				const wrote = await t48post(
					`${srv.url}api/devices/t48-target/credentials`,
					{
						user: "t48-admin",
						password: "t48-new-secret",
						sshKey: "/home/op/.ssh/t48_ed25519",
						expected: before.details,
					},
				);
				expect(wrote.status).toBe(200);
				expect(wrote.json["ok"]).toBe(true);
				expect(wrote.json["action"]).toBe("set");
				expect(
					(wrote.json["details"] as Record<string, unknown>)["hasPassword"],
				).toBe(true);
				// The new secret travels the POST but never comes back out.
				expect(JSON.stringify(wrote.json)).not.toContain("t48-new-secret");
				const entry = centrsShow(path.join(ws, "device.cdb"), "t48-target");
				expect(entry["user"]).toBe("t48-admin");
				expect(entry["savedPassword"]).toBe(true);
				expect(entry["commentMirror"]).toContain(
					"ssh-key=/home/op/.ssh/t48_ed25519",
				);
				// The inventory re-reads the write (no stale cards).
				const inv = (await (await fetch(`${srv.url}api/devices`)).json()) as {
					devices: Record<string, unknown>[];
				};
				expect(
					inv.devices.find((d) => d["id"] === "t48-target")?.["hasPassword"],
				).toBe(true);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tcentrs(
		"POST reports a conflict instead of overwriting drift",
		async () => {
			const cdb = seedOpenCdb([{ target: "t48-target", user: "admin" }]);
			const ws = makeCredWorkspace(cdb);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const before = (await (
					await fetch(`${srv.url}api/devices/t48-target/credentials`)
				).json()) as { ok: boolean; details: Record<string, unknown> };
				expect(before.ok).toBe(true);
				// Another writer lands between the modal read and the save.
				centrsSet(path.join(ws, "device.cdb"), "t48-target", [
					"--user",
					"t48-other",
				]);
				const raced = await t48post(
					`${srv.url}api/devices/t48-target/credentials`,
					{ user: "t48-mine", expected: before.details },
				);
				expect(raced.status).toBe(409);
				expect(raced.json["conflict"]).toBe(true);
				expect((raced.json["current"] as Record<string, unknown>)["user"]).toBe(
					"t48-other",
				);
				// The loser's value never landed.
				const entry = centrsShow(path.join(ws, "device.cdb"), "t48-target");
				expect(entry["user"]).toBe("t48-other");
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tcentrs(
		"POST creates a missing record via add",
		async () => {
			const cdb = seedOpenCdb([]);
			const ws = makeCredWorkspace(cdb);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const missing = (await (
					await fetch(`${srv.url}api/devices/t48-fresh/credentials`)
				).json()) as { ok: boolean; missing?: boolean; code?: string };
				expect(missing.ok).toBe(false);
				expect(missing.missing).toBe(true);
				expect(missing.code).toBe("cdb/not-found-target");
				const wrote = await t48post(
					`${srv.url}api/devices/t48-fresh/credentials`,
					{
						user: "t48-admin",
						password: "t48-fresh-secret",
						expected: { missing: true },
					},
				);
				expect(wrote.status).toBe(200);
				expect(wrote.json["ok"]).toBe(true);
				expect(wrote.json["action"]).toBe("add");
				expect(JSON.stringify(wrote.json)).not.toContain("t48-fresh-secret");
				const entry = centrsShow(path.join(ws, "device.cdb"), "t48-fresh");
				expect(entry["user"]).toBe("t48-admin");
				expect(entry["savedPassword"]).toBe(true);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tcentrs(
		"POST refuses a blind write without a baseline",
		async () => {
			const cdb = seedOpenCdb([{ target: "t48-target", user: "admin" }]);
			const ws = makeCredWorkspace(cdb);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const blind = await t48post(
					`${srv.url}api/devices/t48-target/credentials`,
					{
						user: "t48-mine",
					},
				);
				expect(blind.status).toBe(400);
				expect(blind.json["code"]).toBe("cdb/stale-write-refused");
				const entry = centrsShow(path.join(ws, "device.cdb"), "t48-target");
				expect(entry["user"]).toBe("admin");
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tcentrs(
		"POST writes through the session unlock on an encrypted CDB",
		async () => {
			const cdb = seedEncryptedCdb("admin");
			const ws = makeCredWorkspace(cdb);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				expect(
					(await fetch(`${srv.url}api/devices/t48-target/credentials`)).status,
				).toBe(401);
				const unlock = await fetch(`${srv.url}api/auth/unlock`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: new URL(srv.url).origin,
					},
					body: JSON.stringify({ password: T48_FIXTURE_PASSWORD }),
				});
				expect(unlock.status).toBe(200);
				const authed = t48cookie(unlock);
				expect(authed).not.toBeNull();
				const before = (await (
					await fetch(`${srv.url}api/devices/t48-target/credentials`, {
						headers: { cookie: authed as string },
					})
				).json()) as { ok: boolean; details: Record<string, unknown> };
				expect(before.ok).toBe(true);
				const wrote = await t48post(
					`${srv.url}api/devices/t48-target/credentials`,
					{ password: "t48-enc-secret", expected: before.details },
					authed as string,
				);
				expect(wrote.status).toBe(200);
				expect(wrote.json["ok"]).toBe(true);
				expect(JSON.stringify(wrote.json)).not.toContain("t48-enc-secret");
				const entry = centrsShow(
					path.join(ws, "device.cdb"),
					"t48-target",
					T48_FIXTURE_PASSWORD,
				);
				expect(entry["savedPassword"]).toBe(true);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tcentrs(
		"POST ports writes key=value and an empty value removes the key",
		async () => {
			const cdb = seedOpenCdb([{ target: "t48-target", user: "admin" }]);
			const ws = makeCredWorkspace(cdb);
			const wsCdb = path.join(ws, "device.cdb");
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const url = `${srv.url}api/devices/t48-target/credentials`;
				const before = (await (await fetch(url)).json()) as {
					ok: boolean;
					details: Record<string, unknown>;
				};
				expect(before.details["ports"]).toEqual({});
				// Ports alone are a write (not "nothing to write").
				const set = await t48post(url, {
					ports: { "www-port": "7080" },
					expected: before.details,
				});
				expect(set.status).toBe(200);
				expect(set.json["ok"]).toBe(true);
				expect(set.json["action"]).toBe("set");
				expect(
					(set.json["details"] as Record<string, unknown>)["ports"],
				).toEqual({ "www-port": "7080" });
				// centrs 0.1.9 stores the unknown key verbatim (#618 pending).
				expect(String(centrsShow(wsCdb, "t48-target")["comment"])).toContain(
					"www-port=7080",
				);
				const after = (await (await fetch(url)).json()) as {
					details: Record<string, unknown>;
				};
				expect(after.details["ports"]).toEqual({ "www-port": "7080" });
				const cleared = await t48post(url, {
					ports: { "www-port": "" },
					expected: after.details,
				});
				expect(cleared.status).toBe(200);
				expect(cleared.json["ok"]).toBe(true);
				expect(
					(cleared.json["details"] as Record<string, unknown>)["ports"],
				).toEqual({});
				const entry = centrsShow(wsCdb, "t48-target");
				expect(String(entry["comment"])).not.toContain("www-port");
				expect(entry["user"]).toBe("admin");
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tcentrs(
		"POST bad ports is a 400 and writes nothing",
		async () => {
			const cdb = seedOpenCdb([{ target: "t48-target", user: "admin" }]);
			const ws = makeCredWorkspace(cdb);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const url = `${srv.url}api/devices/t48-target/credentials`;
				const before = (await (await fetch(url)).json()) as {
					details: Record<string, unknown>;
				};
				for (const ports of [
					{ "www-port": "0" },
					{ "www-port": "65536" },
					{ "telnet-port": "23" },
					"80",
				]) {
					const r = await t48post(url, {
						user: "t48-other",
						ports,
						expected: before.details,
					});
					expect(r.status).toBe(400);
					expect(r.json).toEqual({
						ok: false,
						why: "bad {ports} (known port keys, 1-65535)",
					});
				}
				const entry = centrsShow(path.join(ws, "device.cdb"), "t48-target");
				expect(entry["user"]).toBe("admin");
				expect(String(entry["comment"])).toBe("");
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	tcentrs(
		"POST /api/devices/:id/remove removes the CDB record",
		async () => {
			const cdb = seedOpenCdb([
				{ target: "t48-target", user: "admin" },
				{ target: "t48-keep", user: "admin" },
			]);
			const ws = makeCredWorkspace(cdb);
			const srv = await startServer({
				dataHome: makeDataHome(),
				configHome: mktmp("t31-serve-cfg-"),
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeHome(),
			});
			try {
				const removed = await t48post(
					`${srv.url}api/devices/t48-target/remove`,
					{},
				);
				expect(removed.status).toBe(200);
				expect(removed.json).toEqual({ ok: true });
				const inv = (await (await fetch(`${srv.url}api/devices`)).json()) as {
					devices: { id: string }[];
				};
				expect(inv.devices.map((d) => d.id)).toEqual(["t48-keep"]);
				// A second remove fails honestly through centrs.
				const again = await t48post(
					`${srv.url}api/devices/t48-target/remove`,
					{},
				);
				expect(again.json["ok"]).toBe(false);
				expect(typeof again.json["why"]).toBe("string");
				// Ids that are not valid hosts never reach centrs.
				const bad = await t48post(
					`${srv.url}api/devices/${encodeURIComponent("a b")}/remove`,
					{},
				);
				expect(bad.status).toBe(404);
				expect(bad.json).toEqual({ ok: false, why: "no device a b" });
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);
});
