// T133 review round 3 (findings A-F): fail-first hermetic tests.
// Every test below fails on deda4bb and passes with the fix.
// Hermetic: temp dirs (cleaned in afterAll), stub or bundled centrs,
// echo provider; no real routers.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as path from "node:path";
import {
	dataHomeDir,
	registerWorkspace,
	registryFile,
} from "../src/lib/registry";
import { have, run } from "../src/lib/run";
import { toolBinDir, toolEnv } from "../src/lib/tools";
import { detectCdbMode } from "../src/serve/auth";
import {
	checkSameOrigin,
	createCdbMutex,
	defaultLaunchWorkspaceServer,
	startServer,
} from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

/** Bundled centrs env: fixtures never depend on ambient PATH. */
function frontedEnv(): Record<string, string> {
	const env = toolEnv(toolBinDir());
	if (!have("centrs", env))
		throw new Error("bundled centrs missing: run bun install");
	return env;
}

function originOf(url: string): string {
	return new URL(url).origin;
}

function workspaceDir(prefix: string): string {
	const dir = mktmp(prefix);
	nodeFs.writeFileSync(
		path.join(dir, "workspace.toml"),
		'[home]\ntype = "single-copy"\ncanonical = true\n',
	);
	nodeFs.writeFileSync(path.join(dir, "AGENTS.md"), "# t133r3\n");
	nodeFs.writeFileSync(
		path.join(dir, "router.toml"),
		'[device]\nid = "t133-gw"\nrole = "gateway"\nsite = "lab"\n',
	);
	nodeFs.mkdirSync(path.join(dir, "operations"), { recursive: true });
	nodeFs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
	return dir;
}

/**
 * finding A table source: every /api literal the server registers,
 * derived from the source itself so the table cannot drift.
 */
function serverSourceApiPaths(): string[] {
	const srcPath = path.join(import.meta.dir, "..", "src", "serve", "server.ts");
	const src = nodeFs.readFileSync(srcPath, "utf8");
	const found = new Set<string>();
	for (const m of src.matchAll(/"(\/api\/[A-Za-z0-9/_.-]*)"/g))
		found.add(m[1] as string);
	return [...found]
		.filter((p) => !p.endsWith("/") && p !== "/api/mcp/relay")
		.sort();
}

/** A cross-origin simple POST: text/plain, foreign Origin, no preflight. */
async function csrfPost(url: string, p: string) {
	const r = await fetch(`${url}${p}`, {
		method: "POST",
		headers: {
			"content-type": "text/plain",
			origin: "https://evil.example",
		},
		body: "password=attacker-pw",
	});
	return { status: r.status, json: (await r.json()) as { ok: unknown } };
}

describe("t133r3-A central same-origin guard", () => {
	test("every registered non-GET route refuses a foreign-Origin text/plain POST and changes nothing", async () => {
		const dir = workspaceDir("t133r3-acsrf-");
		const agentsBefore = nodeFs.readFileSync(
			path.join(dir, "AGENTS.md"),
			"utf8",
		);
		const env = frontedEnv();
		expect(
			(
				await run(
					[
						"centrs",
						"devices",
						"init",
						"--cdb-file",
						path.join(dir, "device.cdb"),
					],
					{
						timeoutMs: 30_000,
						env,
					},
				)
			).ok,
		).toBe(true);
		const nets = mktmp("t133r3-acsrf-nets-");
		const srv = await startServer({
			workspace: dir,
			provider: "echo",
			allowOpenCdb: true,
			dataHome: mktmp("t133r3-acsrf-dh-"),
			configHome: mktmp("t133r3-acsrf-cfg-"),
		});
		try {
			const settingsBefore = await (
				await fetch(`${srv.url}/api/settings`)
			).json();
			const devicesBefore = await (
				await fetch(`${srv.url}/api/devices`)
			).json();
			const paths = [
				...serverSourceApiPaths(),
				"/api/devices/t133probe/credentials",
				"/api/devices/t133probe/stats",
				"/api/past/t133probe",
			];
			// The table must be non-trivial: a scan that finds
			// nothing would pass vacuously.
			expect(paths.length).toBeGreaterThan(20);
			expect(paths).toContain("/api/settings");
			expect(paths).toContain("/api/chat/send");
			expect(paths).toContain("/api/devices/add");
			expect(paths).toContain("/api/file");
			for (const p of paths) {
				const res = await csrfPost(srv.url, p);
				expect(`${p} -> ${res.status}`).toBe(`${p} -> 403`);
				expect(res.json.ok).toBe(false);
			}
			// Nothing changed: settings, workspace files, devices,
			// registry, and the CDB mode are all as before. (Only
			// the stable settings fields: routerosSkills staging
			// runs in the background and moves under the test.)
			const settingsAfter = (await (
				await fetch(`${srv.url}/api/settings`)
			).json()) as Record<string, unknown>;
			for (const k of [
				"defaultAccess",
				"preallowReads",
				"autoRouterosSkills",
			]) {
				expect(settingsAfter[k]).toEqual(
					(settingsBefore as Record<string, unknown>)[k],
				);
			}
			expect(await (await fetch(`${srv.url}/api/devices`)).json()).toEqual(
				devicesBefore,
			);
			expect(nodeFs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(
				agentsBefore,
			);
			expect(nodeFs.readdirSync(nets)).toEqual([]);
			expect(
				(await detectCdbMode(path.join(dir, "device.cdb"), env)).mode,
			).toBe("open");
		} finally {
			await srv.stop();
		}
	});

	test("the relay exemption stays a 404 on the UI listener", async () => {
		const srv = await startServer({
			noWorkspace: true,
			provider: "echo",
			allowOpenCdb: true,
			cdbFile: path.join(mktmp("t133r3-arelay-"), "operator.cdb"),
			dataHome: mktmp("t133r3-arelay-dh-"),
			configHome: mktmp("t133r3-arelay-cfg-"),
			defaultWorkspaceDir: mktmp("t133r3-arelay-nets-"),
		});
		try {
			const res = await csrfPost(srv.url, "/api/mcp/relay");
			expect(res.status).toBe(404);
		} finally {
			await srv.stop();
		}
	});

	test("bodyless UI POSTs pass the guard with Origin and no content-type", async () => {
		const dir = workspaceDir("t133r3-abody-");
		const cdb = path.join(dir, "device.cdb");
		const env = frontedEnv();
		expect(
			(
				await run(
					["centrs", "devices", "init", "--encrypt", "--cdb-file", cdb],
					{
						timeoutMs: 30_000,
						env: { ...env, CENTRS_CDB_PASSWORD: "body-pw" },
					},
				)
			).ok,
		).toBe(true);
		const srv = await startServer({
			workspace: dir,
			provider: "echo",
			dataHome: mktmp("t133r3-abody-dh-"),
			configHome: mktmp("t133r3-abody-cfg-"),
		});
		try {
			// Locked: the guard passes (Origin ok, no JSON needed for
			// these), then the auth gate answers 401 — never 403.
			for (const p of [
				"/api/auth/oauth-recheck",
				"/api/twins/doctor",
				"/api/chat/new",
				"/api/chat/stop",
			]) {
				const r = await fetch(`${srv.url}${p}`, {
					method: "POST",
					headers: { origin: originOf(srv.url) },
				});
				expect(`${p} -> ${r.status}`).toBe(`${p} -> 401`);
				const evil = await fetch(`${srv.url}${p}`, {
					method: "POST",
					headers: { origin: "https://evil.example" },
				});
				expect(evil.status).toBe(403);
			}
		} finally {
			await srv.stop();
		}
	});
});

function firstExternalIPv4(): string | null {
	for (const addrs of Object.values(nodeOs.networkInterfaces())) {
		for (const a of addrs ?? []) {
			if (a.family === "IPv4" && !a.internal) return a.address;
		}
	}
	return null;
}

describe("t133r3-B LAN and IPv6 origins", () => {
	test("unit: interface origins accepted, foreign ports refused", () => {
		const lan = firstExternalIPv4();
		expect(lan).not.toBeNull();
		const mk = (origin: string, host: string) =>
			new Request("http://x/api/auth/unlock", {
				method: "POST",
				headers: { "content-type": "application/json", origin, host },
			});
		const ctx0 = { host: "0.0.0.0", port: 4321, displayHost: "127.0.0.1" };
		expect(
			checkSameOrigin(mk(`http://${lan}:4321`, `${lan}:4321`), ctx0),
		).toBeNull();
		expect(
			checkSameOrigin(mk("http://127.0.0.1:4321", "127.0.0.1:4321"), ctx0),
		).toBeNull();
		const ctx6 = { host: "::1", port: 4322, displayHost: "::1" };
		expect(
			checkSameOrigin(mk("http://[::1]:4322", "[::1]:4322"), ctx6),
		).toBeNull();
		// A foreign port is refused even with a good hostname.
		expect(
			checkSameOrigin(mk("http://127.0.0.1:9999", "127.0.0.1:4321"), ctx0),
		).toMatch(/origin/i);
		// The Host header's port is checked too.
		expect(
			checkSameOrigin(mk("http://127.0.0.1:4321", "127.0.0.1:9999"), ctx0),
		).toMatch(/host/i);
		expect(
			checkSameOrigin(mk("http://127.0.0.1:4321", "evil.example:4321"), ctx0),
		).toMatch(/host/i);
	});

	test("live: 0.0.0.0 bind unlocks through its LAN IP URL", async () => {
		const lan = firstExternalIPv4();
		expect(lan).not.toBeNull();
		const srv = await startServer({
			host: "0.0.0.0",
			noWorkspace: true,
			provider: "echo",
			allowOpenCdb: true,
			cdbFile: path.join(mktmp("t133r3-blan-"), "operator.cdb"),
			dataHome: mktmp("t133r3-blan-dh-"),
			configHome: mktmp("t133r3-blan-cfg-"),
			defaultWorkspaceDir: mktmp("t133r3-blan-nets-"),
		});
		try {
			const r = await fetch(`${srv.url}/api/auth/lock`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: `http://${lan}:${srv.port}`,
				},
				body: "{}",
			});
			expect(r.status).toBe(200);
			const evilPort = await fetch(`${srv.url}/api/auth/lock`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: `http://${lan}:${srv.port + 1}`,
				},
				body: "{}",
			});
			expect(evilPort.status).toBe(403);
		} finally {
			await srv.stop();
		}
	});

	test("live: ::1 bind accepts its bracketed Origin", async () => {
		const srv = await startServer({
			host: "::1",
			noWorkspace: true,
			provider: "echo",
			allowOpenCdb: true,
			cdbFile: path.join(mktmp("t133r3-bip6-"), "operator.cdb"),
			dataHome: mktmp("t133r3-bip6-dh-"),
			configHome: mktmp("t133r3-bip6-cfg-"),
			defaultWorkspaceDir: mktmp("t133r3-bip6-nets-"),
		});
		try {
			const r = await fetch(`http://[::1]:${srv.port}/api/auth/lock`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: `http://[::1]:${srv.port}`,
				},
				body: "{}",
			});
			expect(r.status).toBe(200);
		} finally {
			await srv.stop();
		}
	});
});

function writeShim(dir: string, name: string, body: string): void {
	const file = path.join(dir, name);
	nodeFs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	nodeFs.chmodSync(file, 0o755);
}

/**
 * finding C stub: `devices list` answers from a mode file, and the
 * first call after a hold_next marker snapshots the mode at detection
 * start, then blocks on hold — so a detection can straddle a mutation.
 */
function gatingCentrsBin(): { bin: string; cdbDir: string } {
	const bin = mktmp("t133r3-cbin-");
	const cdbDir = mktmp("t133r3-ccdb-");
	nodeFs.writeFileSync(path.join(cdbDir, "mode"), "open");
	writeShim(
		bin,
		"centrs",
		`D="$T133_CDB_DIR"\n` +
			`if [ "$1" = "devices" ] && [ "$2" = "list" ]; then\n` +
			`  if [ -f "$D/hold_next" ]; then\n` +
			`    rm -f "$D/hold_next"\n` +
			`    cat "$D/mode" > "$D/snapshot"\n` +
			`    while [ -f "$D/hold" ]; do sleep 0.05; done\n` +
			`    mode=$(cat "$D/snapshot")\n` +
			`  else\n` +
			`    mode=$(cat "$D/mode")\n` +
			`  fi\n` +
			`  if [ "$mode" = "encrypted" ] && [ -z "$CENTRS_CDB_PASSWORD" ]; then\n` +
			`    echo '{"ok":false,"error":{"code":"cdb/password-required","summary":"locked"}}'\n` +
			`  else\n` +
			`    echo '{"ok":true,"data":{"devices":[]}}'\n` +
			`  fi\n` +
			`  exit 0\n` +
			`fi\n` +
			`if [ "$1" = "devices" ] && [ "$2" = "encrypt" ]; then\n` +
			`  echo "encrypted" > "$D/mode"\n` +
			`  echo '{"ok":true,"data":{}}'\n` +
			`  exit 0\n` +
			`fi\n` +
			`echo '{"ok":false,"error":{"code":"cdb/unreadable","summary":"stub"}}'\n` +
			`exit 1`,
	);
	return { bin, cdbDir };
}

describe("t133r3-C stale detection cannot restore a bypass", () => {
	test("a detection straddling encrypt leaves the cache encrypted and /api/tree 401", async () => {
		const { bin, cdbDir } = gatingCentrsBin();
		const dir = workspaceDir("t133r3-cws-");
		// The stub reads its mode dir from the process env the
		// server fronts (toolEnv copies it at boot).
		process.env["T133_CDB_DIR"] = cdbDir;
		const srv = await startServer({
			workspace: dir,
			provider: "echo",
			// Bypass on: while the CDB reads open, anonymous
			// /api/tree answers 200 — the stale read would
			// restore exactly this bypass.
			allowOpenCdb: true,
			toolBinDir: bin,
			dataHome: mktmp("t133r3-c-dh-"),
			configHome: mktmp("t133r3-c-cfg-"),
		});
		try {
			const origin = originOf(srv.url);
			expect(await (await fetch(`${srv.url}/api/tree`)).status).toBe(200);
			// Arm a one-shot hold for the NEXT detection, then start
			// an auth-state read that blocks inside centrs.
			nodeFs.writeFileSync(path.join(cdbDir, "hold"), "1");
			nodeFs.writeFileSync(path.join(cdbDir, "hold_next"), "1");
			const stateP = fetch(`${srv.url}/api/auth/state`).then((r) => r.json());
			for (
				let i = 0;
				i < 200 && !nodeFs.existsSync(path.join(cdbDir, "snapshot"));
				i++
			) {
				await new Promise((r) => setTimeout(r, 50));
			}
			expect(nodeFs.existsSync(path.join(cdbDir, "snapshot"))).toBe(true);
			// Encrypt while the read is stuck: the cache flips.
			const enc = await fetch(`${srv.url}/api/auth/encrypt`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({ password: "c-pw" }),
			});
			expect(enc.status).toBe(200);
			expect(await (await fetch(`${srv.url}/api/tree`)).status).toBe(401);
			// Release the stale read: it saw "open" at detection
			// start, but the mutation landed first — the cache must
			// stay encrypted and the tree must stay 401.
			nodeFs.rmSync(path.join(cdbDir, "hold"));
			await stateP;
			expect(await (await fetch(`${srv.url}/api/tree`)).status).toBe(401);
			const st = (await (await fetch(`${srv.url}/api/auth/state`)).json()) as {
				state: string;
			};
			expect(st.state).toBe("locked");
		} finally {
			delete process.env["T133_CDB_DIR"];
			await srv.stop();
		}
	}, 60_000);
});

describe("t133r3-D create racing stop leaks no child", () => {
	test("a launch in flight at stop() is awaited, killed, and refused", async () => {
		const dh = mktmp("t133r3-d-dh-");
		const nets = mktmp("t133r3-d-nets-");
		const tools = frontedEnv();
		let childUrl: string | null = null;
		let entered = false;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const srv = await startServer({
			noWorkspace: true,
			provider: "echo",
			allowOpenCdb: true,
			cdbFile: path.join(mktmp("t133r3-d-op-"), "operator.cdb"),
			dataHome: dh,
			configHome: mktmp("t133r3-d-cfg-"),
			defaultWorkspaceDir: nets,
			launchWorkspaceServer: async (dir, port) => {
				entered = true;
				await gate;
				const real = await defaultLaunchWorkspaceServer(dir, port, tools, {
					provider: "echo",
					dataHome: dataHomeDir(dh),
				});
				childUrl = real.url;
				return real;
			},
		});
		try {
			const origin = originOf(srv.url);
			const createP = fetch(`${srv.url}/api/workspaces`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({
					action: "create",
					name: "racews",
					password: "race-pw",
				}),
			}).then(async (r) => ({
				status: r.status,
				json: (await r.json()) as Record<string, unknown>,
			}));
			for (let i = 0; i < 200 && !entered; i++) {
				await new Promise((r) => setTimeout(r, 50));
			}
			expect(entered).toBe(true);
			// Stop while the launch is still in flight, then let it finish.
			const stopP = srv.stop();
			await new Promise((r) => setTimeout(r, 200));
			release();
			const created = await createP;
			await stopP;
			expect(childUrl).not.toBeNull();
			// The racing create is refused, never handed a live child.
			expect(created.json["ok"]).toBe(false);
			// No child is reachable afterwards.
			let reachable = false;
			for (let i = 0; i < 30 && !reachable; i++) {
				try {
					const r = await fetch(`${childUrl}/api/auth/state`);
					if (r.status < 500) reachable = true;
					else break;
				} catch {
					break;
				}
				await new Promise((r) => setTimeout(r, 250));
			}
			expect(reachable).toBe(false);
		} finally {
			release();
			await srv.stop().catch(() => {});
		}
	}, 120_000);
});

describe("t133r3-E open accepts any reported auth state", () => {
	test("open on an open-CDB workspace redirects and the encrypt overlay shows", async () => {
		const dh = mktmp("t133r3-e-dh-");
		const dir = path.join(nets_(dh), "openws");
		nodeFs.mkdirSync(dir, { recursive: true });
		nodeFs.writeFileSync(
			path.join(dir, "workspace.toml"),
			'[home]\ntype = "single-copy"\ncanonical = true\n',
		);
		nodeFs.writeFileSync(path.join(dir, "AGENTS.md"), "# t133r3\n");
		const env = frontedEnv();
		expect(
			(
				await run(
					[
						"centrs",
						"devices",
						"init",
						"--cdb-file",
						path.join(dir, "device.cdb"),
					],
					{
						timeoutMs: 30_000,
						env,
					},
				)
			).ok,
		).toBe(true);
		registerWorkspace(registryFile(dh), "openws", dir);
		const srv = await startServer({
			noWorkspace: true,
			provider: "echo",
			allowOpenCdb: true,
			cdbFile: path.join(mktmp("t133r3-e-op-"), "operator.cdb"),
			dataHome: dh,
			configHome: mktmp("t133r3-e-cfg-"),
			defaultWorkspaceDir: mktmp("t133r3-e-nets-"),
		});
		try {
			const origin = originOf(srv.url);
			const r = await fetch(`${srv.url}/api/workspaces`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({ action: "open", name: "openws" }),
			});
			const body = (await r.json()) as Record<string, unknown>;
			expect(body["ok"]).toBe(true);
			expect(typeof body["url"]).toBe("string");
			const childUrl = body["url"] as string;
			const st = (await (await fetch(`${childUrl}/api/auth/state`)).json()) as {
				state: string;
			};
			expect(st.state).toBe("open-needs-encryption");
			const html = await (await fetch(`${childUrl}/`)).text();
			expect(html).toContain("guidescreen");
			expect(html).toContain("/api/auth/encrypt");
		} finally {
			await srv.stop();
		}
	}, 120_000);

	test("open on a missing-CDB workspace redirects and the create overlay shows", async () => {
		const dh = mktmp("t133r3-e2-dh-");
		const dir = path.join(nets_(dh), "missingws");
		nodeFs.mkdirSync(dir, { recursive: true });
		nodeFs.writeFileSync(
			path.join(dir, "workspace.toml"),
			'[home]\ntype = "single-copy"\ncanonical = true\n',
		);
		nodeFs.writeFileSync(path.join(dir, "AGENTS.md"), "# t133r3\n");
		registerWorkspace(registryFile(dh), "missingws", dir);
		const srv = await startServer({
			noWorkspace: true,
			provider: "echo",
			allowOpenCdb: true,
			cdbFile: path.join(mktmp("t133r3-e2-op-"), "operator.cdb"),
			dataHome: dh,
			configHome: mktmp("t133r3-e2-cfg-"),
			defaultWorkspaceDir: mktmp("t133r3-e2-nets-"),
		});
		try {
			const origin = originOf(srv.url);
			const r = await fetch(`${srv.url}/api/workspaces`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({ action: "open", name: "missingws" }),
			});
			const body = (await r.json()) as Record<string, unknown>;
			expect(body["ok"]).toBe(true);
			expect(typeof body["url"]).toBe("string");
			const childUrl = body["url"] as string;
			const st = (await (await fetch(`${childUrl}/api/auth/state`)).json()) as {
				state: string;
			};
			expect(st.state).toBe("missing");
			const html = await (await fetch(`${childUrl}/`)).text();
			expect(html).toContain("guidescreen");
			expect(html).toContain("/api/auth/create-cdb");
		} finally {
			await srv.stop();
		}
	}, 120_000);
});

function nets_(dh: string): string {
	const d = path.join(dh, "nets");
	nodeFs.mkdirSync(d, { recursive: true });
	return d;
}

describe("t133r3-F CDB mutex entries clear", () => {
	test("101 keys leave the map empty on success and on throw", async () => {
		const mutex = createCdbMutex();
		expect(mutex.pending()).toBe(0);
		await Promise.all(
			Array.from({ length: 101 }, (_, i) => mutex(`k${i}`, async () => i)),
		);
		expect(mutex.pending()).toBe(0);
		await Promise.all(
			Array.from({ length: 101 }, (_, i) =>
				mutex(`t${i}`, async (): Promise<void> => {
					throw new Error(`boom ${i}`);
				}).catch(() => {}),
			),
		);
		expect(mutex.pending()).toBe(0);
	});
});
