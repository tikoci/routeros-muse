import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerWorkspace, registryFile } from "../src/lib/registry";
import { toolBinDir, toolEnv } from "../src/lib/tools";
import {
	checkSameOrigin,
	defaultLaunchWorkspaceServer,
	startServer,
} from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

test("T133 JSON guard checks the media type rather than a substring", () => {
	const ctx = { host: "127.0.0.1", port: 4321, displayHost: "127.0.0.1" };
	const check = (contentType: string) =>
		checkSameOrigin(
			new Request("http://127.0.0.1:4321/api/auth/unlock", {
				method: "POST",
				headers: {
					origin: "http://127.0.0.1:4321",
					host: "127.0.0.1:4321",
					"content-type": contentType,
				},
			}),
			ctx,
		);
	for (const ct of ["application/json", "Application/JSON; charset=utf-8"])
		expect(check(ct)).toBeNull();
	for (const ct of [
		"application/jsonp",
		"text/plain; hint=application/json",
		"otherapplication/json",
	])
		expect(check(ct)).toMatch(/Content-Type/);
});

function workspace(): string {
	const dir = mktmp("t133finish-ws-");
	fs.writeFileSync(
		path.join(dir, "workspace.toml"),
		'[home]\ntype = "single-copy"\ncanonical = true\n',
	);
	fs.writeFileSync(path.join(dir, "AGENTS.md"), "# test workspace\n");
	return dir;
}

test("T133 open preserves an unavailable-CDB child's diagnostic overlay", async () => {
	const dir = workspace();
	fs.writeFileSync(path.join(dir, "device.cdb"), "invalid registry");
	const dataHome = mktmp("t133finish-unavailable-dh-");
	registerWorkspace(registryFile(dataHome), "broken", dir);
	const srv = await startServer({
		noWorkspace: true,
		provider: "echo",
		allowOpenCdb: true,
		cdbFile: path.join(dataHome, "operator.cdb"),
		dataHome,
		configHome: mktmp("t133finish-unavailable-cfg-"),
	});
	try {
		const r = await fetch(`${srv.url}api/workspaces`, {
			method: "POST",
			headers: {
				origin: new URL(srv.url).origin,
				"content-type": "application/json",
			},
			body: JSON.stringify({ action: "open", name: "broken" }),
		});
		const result = (await r.json()) as { ok: boolean; url: string };
		expect(result.ok).toBe(true);
		const state = await (await fetch(`${result.url}/api/auth/state`)).json();
		expect(state).toHaveProperty("state", "unavailable");
		expect(await (await fetch(`${result.url}/api/tree`)).status).toBe(401);
	} finally {
		await srv.stop();
	}
}, 60_000);

test("T133 concurrent stops both await the real child's termination", async () => {
	const dir = workspace();
	const dataHome = mktmp("t133finish-stop-dh-");
	registerWorkspace(registryFile(dataHome), "child", dir);
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let stopping!: () => void;
	const entered = new Promise<void>((r) => {
		stopping = r;
	});
	const srv = await startServer({
		noWorkspace: true,
		provider: "echo",
		allowOpenCdb: true,
		cdbFile: path.join(dataHome, "operator.cdb"),
		dataHome,
		configHome: mktmp("t133finish-stop-cfg-"),
		launchWorkspaceServer: async (root, port) => {
			const child = await defaultLaunchWorkspaceServer(
				root,
				port,
				toolEnv(toolBinDir()),
				{ provider: "echo", dataHome },
			);
			return {
				...child,
				stop: async () => {
					stopping();
					await gate;
					await child.stop();
				},
			};
		},
	});
	try {
		const r = await fetch(`${srv.url}api/workspaces`, {
			method: "POST",
			headers: {
				origin: new URL(srv.url).origin,
				"content-type": "application/json",
			},
			body: JSON.stringify({ action: "open", name: "child" }),
		});
		const result = (await r.json()) as { ok: boolean; url: string };
		expect(result.ok).toBe(true);
		const first = srv.stop();
		await entered;
		let secondResolved = false;
		const second = srv.stop().then(() => {
			secondResolved = true;
		});
		await new Promise((r) => setTimeout(r, 100));
		expect(secondResolved).toBe(false);
		release();
		await Promise.all([first, second]);
		await expect(fetch(`${result.url}/api/auth/state`)).rejects.toThrow();
	} finally {
		release();
		await srv.stop();
	}
}, 60_000);
