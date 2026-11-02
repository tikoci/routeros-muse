// Workspaces registry + picker + creation (T40). Hermetic: temp
// data homes and creation roots, seeded temp CDBs; no network, no
// live meta turns.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	dataHomeDir,
	defaultWorkspacesDir,
	pruneRegistry,
	readRegistry,
	registerWorkspace,
	registryEntryAlive,
	registryFile,
	writeRegistry,
} from "../src/lib/registry";
import { have } from "../src/lib/run";
import { toolEnv } from "../src/lib/tools";
import { scaffoldWorkspace, validWorkspaceName } from "../src/lib/workspace";
import { serveCommand, startServer } from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

const HAVE_CENTRS = have("centrs");
const POSIX = process.platform !== "win32";
const tcentrs = POSIX && HAVE_CENTRS ? test : test.skip;

function tempDataHome(): string {
	return mktmp("t40-reg-home-");
}

function makeWsDir(): string {
	const dir = mktmp("t40-reg-ws-");
	nodeFs.writeFileSync(path.join(dir, "workspace.toml"), "canonical = true\n");
	nodeFs.writeFileSync(path.join(dir, "AGENTS.md"), "# ws\n");
	return dir;
}

function makeHome(): string {
	const home = mktmp("t40-reg-mhome-");
	const dir = path.join(home, "muse", "model-catalog");
	nodeFs.mkdirSync(dir, { recursive: true });
	const fixture = path.join(import.meta.dir, "fixtures", "model-catalog");
	for (const f of nodeFs.readdirSync(fixture)) {
		nodeFs.copyFileSync(path.join(fixture, f), path.join(dir, f));
	}
	return home;
}

describe("registry paths", () => {
	test("registry file honors the data-home override chain", () => {
		expect(registryFile("/dh")).toBe(
			path.join("/dh", "routeros-muse", "registry.toml"),
		);
		expect(dataHomeDir("/dh")).toBe("/dh");
		expect(dataHomeDir()).toBe(
			process.env["XDG_DATA_HOME"] ??
				path.join(os.homedir(), ".local", "share"),
		);
	});

	test("new workspaces default to ~/Networks", () => {
		expect(defaultWorkspacesDir()).toBe(path.join(os.homedir(), "Networks"));
		expect(defaultWorkspacesDir("/tmp/nets")).toBe("/tmp/nets");
	});
});

describe("registry read/write", () => {
	test("missing file reads empty; roundtrip preserves entries", () => {
		const file = path.join(tempDataHome(), "routeros-muse", "registry.toml");
		expect(readRegistry(file)).toEqual({ entries: [], corrupt: false });
		writeRegistry(file, [
			{
				name: "a",
				path: "/ws/a",
				added: "2026-01-01T00:00:00.000Z",
				lastOpened: "2026-01-02T00:00:00.000Z",
			},
		]);
		expect(readRegistry(file)).toEqual({
			entries: [
				{
					name: "a",
					path: "/ws/a",
					added: "2026-01-01T00:00:00.000Z",
					lastOpened: "2026-01-02T00:00:00.000Z",
				},
			],
			corrupt: false,
		});
	});

	test("unparseable + malformed rows flag corrupt", () => {
		const bad = path.join(tempDataHome(), "registry.toml");
		nodeFs.writeFileSync(bad, "[[workspace\nname = ");
		expect(readRegistry(bad).corrupt).toBe(true);
		nodeFs.writeFileSync(bad, '[[workspace]]\nname = "half"\npath = "/x"\n');
		const half = readRegistry(bad);
		expect(half.entries).toEqual([]);
		expect(half.corrupt).toBe(true);
	});

	test("register upserts by path, keeps added, refreshes lastOpened", () => {
		const file = path.join(tempDataHome(), "registry.toml");
		const first = registerWorkspace(file, "ws", "/ws", "2026-01-01T00:00:00Z");
		expect(first).toEqual({
			name: "ws",
			path: "/ws",
			added: "2026-01-01T00:00:00Z",
			lastOpened: "2026-01-01T00:00:00Z",
		});
		const second = registerWorkspace(
			file,
			"renamed",
			"/ws",
			"2026-02-01T00:00:00Z",
		);
		expect(second.added).toBe("2026-01-01T00:00:00Z");
		expect(second.lastOpened).toBe("2026-02-01T00:00:00Z");
		expect(second.name).toBe("renamed");
		expect(readRegistry(file).entries).toHaveLength(1);
	});

	test("prune drops dead entries, keeps live ones", () => {
		const file = path.join(tempDataHome(), "registry.toml");
		const live = makeWsDir();
		const deadDir = path.join(os.tmpdir(), "t40-reg-dead-");
		writeRegistry(file, [
			{ name: "live", path: live, added: "a", lastOpened: "b" },
			{ name: "dead", path: `${deadDir}nope`, added: "a", lastOpened: "b" },
		]);
		expect(
			registryEntryAlive({
				name: "l",
				path: live,
				added: "a",
				lastOpened: "b",
			}),
		).toBe(true);
		expect(
			registryEntryAlive({
				name: "d",
				path: `${deadDir}nope`,
				added: "a",
				lastOpened: "b",
			}),
		).toBe(false);
		const { entries, removed } = pruneRegistry(file);
		expect(removed).toBe(1);
		expect(entries.map((e) => e.name)).toEqual(["live"]);
		expect(readRegistry(file).entries).toHaveLength(1);
	});
});

describe("workspace names", () => {
	test("single basename segment only", () => {
		expect(validWorkspaceName("office")).toBe(true);
		expect(validWorkspaceName("cabin-link_2.v1")).toBe(true);
		for (const bad of ["", "../x", "a/b", "a b", "-lead", ".", "a:b"]) {
			expect(validWorkspaceName(bad)).toBe(false);
		}
	});
});

describe("scaffold", () => {
	test("bad names + existing targets refuse without touching disk", async () => {
		const parent = mktmp("t40-scaf-");
		const bad = await scaffoldWorkspace(parent, "../evil", {});
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.why).toContain("one path segment");
		nodeFs.mkdirSync(path.join(parent, "taken"));
		const taken = await scaffoldWorkspace(parent, "taken", {});
		expect(taken.ok).toBe(false);
		if (!taken.ok) expect(taken.why).toContain("already exists");
		expect(nodeFs.existsSync(path.join(parent, "evil"))).toBe(false);
	});

	test("missing centrs rolls the target back", async () => {
		const parent = mktmp("t40-scaf-");
		// PATH with sh but no centrs: have() answers honestly false.
		const shOnly = mktmp("t40-shonly-");
		if (POSIX) nodeFs.symlinkSync("/bin/sh", path.join(shOnly, "sh"));
		const env = toolEnv(null, { ...process.env, PATH: POSIX ? shOnly : "" });
		const res = await scaffoldWorkspace(parent, "noroll", env);
		if (have("centrs", env)) return;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.why).toBe("centrs not on PATH");
		expect(nodeFs.existsSync(path.join(parent, "noroll"))).toBe(false);
	});

	tcentrs(
		"success writes the minimal runnable workspace",
		async () => {
			const parent = mktmp("t40-scaf-");
			const res = await scaffoldWorkspace(parent, "acme", toolEnv(null));
			expect(res.ok).toBe(true);
			if (!res.ok) throw new Error("scaffold failed");
			expect(res.dir).toBe(path.join(parent, "acme"));
			const toml = nodeFs.readFileSync(
				path.join(res.dir, "workspace.toml"),
				"utf8",
			);
			expect(toml).toContain("canonical = true");
			expect(toml).toContain('quickchr = "next"');
			expect(toml).toContain('centrs = "next"');
			expect(toml).toContain('rosetta = "next"');
			expect(
				nodeFs.readFileSync(path.join(res.dir, "AGENTS.md"), "utf8"),
			).toContain("minimal scaffold");
			const router = nodeFs.readFileSync(
				path.join(res.dir, "router.toml"),
				"utf8",
			);
			expect(router).toContain("# [device]");
			expect(nodeFs.existsSync(path.join(res.dir, "device.cdb"))).toBe(true);
		},
		60_000,
	);
});

describe("serveCommand", () => {
	test("restart line names the package entry + workspace", () => {
		const cmd = serveCommand("/ws/acme");
		expect(cmd).toContain("serve");
		expect(cmd).toContain("/ws/acme");
		expect(cmd.startsWith("bun ") || cmd.startsWith("routeros-muse ")).toBe(
			true,
		);
	});
});

describe("workspaces routes", () => {
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

	test("GET lists entries with liveness + the default dir", async () => {
		const dh = tempDataHome();
		const live = makeWsDir();
		registerWorkspace(registryFile(dh), "live", live);
		registerWorkspace(registryFile(dh), "dead", path.join(dh, "gone"));
		const srv = await startServer({
			allowOpenCdb: true,
			noWorkspace: true,
			provider: "echo",
			museHome: makeHome(),
			dataHome: dh,
			configHome: mktmp("t40-reg-cfg-"),
			defaultWorkspaceDir: path.join(dh, "nets"),
		});
		try {
			const got = (await (await fetch(`${srv.url}api/workspaces`)).json()) as {
				workspaces: { name: string; alive: boolean }[];
				defaultDir: string;
			};
			expect(got.defaultDir).toBe(path.join(dh, "nets"));
			expect(got.workspaces).toHaveLength(2);
			expect(got.workspaces.find((w) => w.name === "live")?.alive).toBe(true);
			expect(got.workspaces.find((w) => w.name === "dead")?.alive).toBe(false);
		} finally {
			await srv.stop();
		}
	}, 30_000);

	test("prune + open: honest outcomes, open touches + prints restart", async () => {
		const dh = tempDataHome();
		const live = makeWsDir();
		registerWorkspace(registryFile(dh), "live", live, "2020-01-01T00:00:00Z");
		registerWorkspace(registryFile(dh), "dead", path.join(dh, "gone"));
		const srv = await startServer({
			allowOpenCdb: true,
			noWorkspace: true,
			provider: "echo",
			museHome: makeHome(),
			dataHome: dh,
			configHome: mktmp("t40-reg-cfg-"),
			defaultWorkspaceDir: path.join(dh, "nets"),
		});
		try {
			const pruned = await postJson(`${srv.url}api/workspaces`, {
				action: "prune",
			});
			expect(pruned.json).toEqual({ ok: true, removed: 1 });
			const opened = await postJson(`${srv.url}api/workspaces`, {
				action: "open",
				name: "live",
			});
			expect(opened.status).toBe(200);
			expect(opened.json["ok"]).toBe(true);
			expect(opened.json["command"] as string).toContain("serve");
			expect(opened.json["command"] as string).toContain(live);
			const touched = readRegistry(registryFile(dh)).entries.find(
				(e) => e.name === "live",
			);
			expect(touched?.added).toBe("2020-01-01T00:00:00Z");
			expect(touched?.lastOpened).not.toBe("2020-01-01T00:00:00Z");
			const unknown = await postJson(`${srv.url}api/workspaces`, {
				action: "open",
				name: "nope",
			});
			expect(unknown.status).toBe(404);
			const junk = await postJson(`${srv.url}api/workspaces`, {
				action: "frobnicate",
			});
			expect(junk.status).toBe(400);
		} finally {
			await srv.stop();
		}
	}, 30_000);

	tcentrs(
		"create scaffolds, registers, and steers to encryption",
		async () => {
			const dh = tempDataHome();
			const srv = await startServer({
				allowOpenCdb: true,
				noWorkspace: true,
				provider: "echo",
				museHome: makeHome(),
				dataHome: dh,
				configHome: mktmp("t40-reg-cfg-"),
				defaultWorkspaceDir: path.join(dh, "nets"),
			});
			try {
				const bad = await postJson(`${srv.url}api/workspaces`, {
					action: "create",
					name: "../evil",
				});
				expect(bad.status).toBe(400);
				const made = await postJson(`${srv.url}api/workspaces`, {
					action: "create",
					name: "acme",
				});
				expect(made.status).toBe(200);
				expect(made.json["ok"]).toBe(true);
				const dir = path.join(dh, "nets", "acme");
				expect((made.json["workspace"] as { path: string }).path).toBe(dir);
				expect(made.json["command"] as string).toContain("serve");
				expect(made.json["command"] as string).toContain(dir);
				expect(made.json["steering"] as string).toContain("WinBox");
				expect(made.json["steering"] as string).toContain("558");
				expect(nodeFs.existsSync(path.join(dir, "workspace.toml"))).toBe(true);
				expect(nodeFs.existsSync(path.join(dir, "device.cdb"))).toBe(true);
				expect(
					readRegistry(registryFile(dh)).entries.map((e) => e.name),
				).toContain("acme");
				const dup = await postJson(`${srv.url}api/workspaces`, {
					action: "create",
					name: "acme",
				});
				expect(dup.status).toBe(400);
				expect(dup.json["why"] as string).toContain("already exists");
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);

	test("workspace-mode boot registers the workspace", async () => {
		const dh = tempDataHome();
		const ws = makeWsDir();
		const srv = await startServer({
			allowOpenCdb: true,
			workspace: ws,
			provider: "echo",
			museHome: makeHome(),
			dataHome: dh,
			configHome: mktmp("t40-reg-cfg-"),
		});
		try {
			const entries = readRegistry(registryFile(dh)).entries;
			expect(entries.map((e) => e.path)).toContain(ws);
			expect(entries.find((e) => e.path === ws)?.name).toBe(path.basename(ws));
		} finally {
			await srv.stop();
		}
	}, 30_000);

	test("no-workspace boot registers nothing", async () => {
		const dh = tempDataHome();
		const srv = await startServer({
			allowOpenCdb: true,
			noWorkspace: true,
			provider: "echo",
			museHome: makeHome(),
			dataHome: dh,
			configHome: mktmp("t40-reg-cfg-"),
		});
		try {
			expect(readRegistry(registryFile(dh)).entries).toEqual([]);
		} finally {
			await srv.stop();
		}
	}, 30_000);
});
