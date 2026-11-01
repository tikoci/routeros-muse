// T84: TOML editor must fail closed on shapes it cannot re-emit.
// Seeded workspace, echo provider, no routers, no network.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { readDevices } from "../src/lib/fleet";
import { startServer } from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

const CATALOG_FIXTURE = path.join(import.meta.dir, "fixtures", "model-catalog");

const MULTI_DEVICE_TOML = `title = "t84 net"

[[device]]
id = "t84-a"
role = "gateway"

[[device]]
id = "t84-b"
role = "gateway"

[settings]
mode = "true"
count = 3
enabled = true

[settings.proxy]
host = "proxy.example"
`;

// Old editor serialization shape: [[device]] flattened to a headerless
// top-level string. Same top-level keys, but device flips array -> string.
const CORRUPTING_TOML = `title = "t84 net"
device = "[{\\"id\\": \\"t84-a\\"}, {\\"id\\": \\"t84-b\\"}]"

[settings]
mode = "true"
count = 3
enabled = true

[settings.proxy]
host = "proxy.example"
`;

const EDITABLE_TOML = `[app]
name = "hello"
count = 3
`;

function makeDataHome(): string {
	return mktmp("t84-dh-");
}

function makeHome(): string {
	const home = mktmp("t84-home-");
	const dir = path.join(home, "muse", "model-catalog");
	nodeFs.mkdirSync(dir, { recursive: true });
	for (const f of nodeFs.readdirSync(CATALOG_FIXTURE)) {
		nodeFs.copyFileSync(path.join(CATALOG_FIXTURE, f), path.join(dir, f));
	}
	return home;
}

function makeWorkspace(): string {
	const dir = mktmp("t84-ws-");
	nodeFs.writeFileSync(
		path.join(dir, "workspace.toml"),
		'[home]\ntype = "single-copy"\ncanonical = true\n',
	);
	nodeFs.writeFileSync(path.join(dir, "router.toml"), MULTI_DEVICE_TOML);
	nodeFs.writeFileSync(path.join(dir, "editable.toml"), EDITABLE_TOML);
	return dir;
}

type TomlRow = { key: string; value: string; readonly: boolean; why: string };
type TomlSection = { name: string; rows: TomlRow[] };
type TomlBody = {
	ok: boolean;
	path?: string;
	sections?: TomlSection[];
	writable?: boolean;
	why?: string;
};

describe("T84 toml editor fail-closed", () => {
	test("GET /api/toml flags all three readonly classes and merges (top)", async () => {
		const ws = makeWorkspace();
		const srv = await startServer({
			dataHome: makeDataHome(),
			allowOpenCdb: true,
			workspace: ws,
			provider: "echo",
			museHome: makeHome(),
		});
		try {
			const r = await fetch(
				`${srv.url}api/toml?path=${encodeURIComponent("router.toml")}`,
			);
			const j = (await r.json()) as TomlBody;
			expect(j.ok).toBe(true);
			expect(j.writable).toBe(false);
			const sections = j.sections ?? [];
			const tops = sections.filter((s) => s.name === "(top)");
			expect(tops.length).toBe(1);
			const topRows = tops[0]?.rows ?? [];
			expect(topRows.length).toBe(2);
			for (const row of topRows) {
				expect(row.readonly).toBe(true);
				expect(row.why).toBe(
					"top-level arrays and values cannot be edited in this slice; edit the file by hand",
				);
			}
			const settings = sections.find((s) => s.name === "settings");
			expect(settings).toBeDefined();
			const byKey = new Map(
				(settings?.rows ?? []).map((row) => [row.key, row]),
			);
			expect(byKey.get("mode")?.readonly).toBe(true);
			expect(byKey.get("mode")?.why).toBe(
				"value looks like a boolean or number; saving would change its type",
			);
			expect(byKey.get("proxy")?.readonly).toBe(true);
			expect(byKey.get("proxy")?.why).toBe(
				"nested tables and arrays cannot be edited in this slice",
			);
			// Real bools/numbers round-trip; they stay editable.
			expect(byKey.get("count")?.readonly).toBe(false);
			expect(byKey.get("enabled")?.readonly).toBe(false);
		} finally {
			await srv.stop();
		}
	}, 30_000);

	test("editor-marked corrupting save is rejected and devices survive", async () => {
		const ws = makeWorkspace();
		expect(readDevices(ws).length).toBe(2);
		const srv = await startServer({
			dataHome: makeDataHome(),
			allowOpenCdb: true,
			workspace: ws,
			provider: "echo",
			museHome: makeHome(),
		});
		try {
			const r = await fetch(`${srv.url}api/file`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					path: "router.toml",
					text: CORRUPTING_TOML,
					fromTomlEditor: true,
				}),
			});
			expect(r.status).toBe(409);
			const j = (await r.json()) as { ok: boolean; why: string };
			expect(j.ok).toBe(false);
			expect(j.why).toContain("device");
			expect(readDevices(ws).length).toBe(2);
		} finally {
			await srv.stop();
		}
	}, 30_000);

	test("editor-marked in-section scalar edit succeeds", async () => {
		const ws = makeWorkspace();
		const srv = await startServer({
			dataHome: makeDataHome(),
			allowOpenCdb: true,
			workspace: ws,
			provider: "echo",
			museHome: makeHome(),
		});
		try {
			const before = (await (
				await fetch(
					`${srv.url}api/toml?path=${encodeURIComponent("editable.toml")}`,
				)
			).json()) as TomlBody;
			expect(before.ok).toBe(true);
			expect(before.writable).toBe(true);
			const r = await fetch(`${srv.url}api/file`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					path: "editable.toml",
					text: '[app]\nname = "world"\ncount = 3\n',
					fromTomlEditor: true,
				}),
			});
			expect(r.status).toBe(200);
			const after = nodeFs.readFileSync(path.join(ws, "editable.toml"), "utf8");
			expect(after).toContain('name = "world"');
		} finally {
			await srv.stop();
		}
	}, 30_000);

	test("unmarked writes keep the syntax-only check", async () => {
		const ws = makeWorkspace();
		const srv = await startServer({
			dataHome: makeDataHome(),
			allowOpenCdb: true,
			workspace: ws,
			provider: "echo",
			museHome: makeHome(),
		});
		try {
			const r = await fetch(`${srv.url}api/file`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: "router.toml", text: CORRUPTING_TOML }),
			});
			// No editor marker: syntax-valid text saves, as today.
			expect(r.status).toBe(200);
		} finally {
			await srv.stop();
		}
	}, 30_000);

	test("editor-marked in-section type flip is rejected", async () => {
		const ws = makeWorkspace();
		const srv = await startServer({
			dataHome: makeDataHome(),
			allowOpenCdb: true,
			workspace: ws,
			provider: "echo",
			museHome: makeHome(),
		});
		try {
			// settings.mode flips string "true" to bool true; top-level keys
			// and kinds are unchanged, so only the row-level guard catches it.
			const flipped = MULTI_DEVICE_TOML.replace('mode = "true"', "mode = true");
			const r = await fetch(`${srv.url}api/file`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					path: "router.toml",
					text: flipped,
					fromTomlEditor: true,
				}),
			});
			expect(r.status).toBe(409);
			const j = (await r.json()) as { ok: boolean; why: string };
			expect(j.ok).toBe(false);
			expect(j.why).toContain("settings.mode");
			expect(
				nodeFs.readFileSync(path.join(ws, "router.toml"), "utf8"),
			).toContain('mode = "true"');
		} finally {
			await srv.stop();
		}
	}, 30_000);

	test("editor-marked save without a readable original is rejected", async () => {
		const ws = makeWorkspace();
		const srv = await startServer({
			dataHome: makeDataHome(),
			allowOpenCdb: true,
			workspace: ws,
			provider: "echo",
			museHome: makeHome(),
		});
		try {
			const r = await fetch(`${srv.url}api/file`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					path: "missing84.toml",
					text: '[app]\nname = "new"\n',
					fromTomlEditor: true,
				}),
			});
			expect(r.status).toBe(409);
			expect(nodeFs.existsSync(path.join(ws, "missing84.toml"))).toBe(false);
		} finally {
			await srv.stop();
		}
	}, 30_000);
});
