import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { privateConfigHome } from "../src/lib/preallow";
import { have } from "../src/lib/run";
import { writeAutoRouterosSkills } from "../src/lib/settings";
import { startServer } from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";
import { stubT71Bin, withT71Env } from "./t71-fake";

afterAll(cleanupTmpdirs);
const live = have("muse") ? test : test.skip;
async function json(url: string, body?: unknown) {
	const res = await fetch(
		url,
		body === undefined
			? {}
			: {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: new URL(url).origin,
					},
					body: JSON.stringify(body),
				},
	);
	return { status: res.status, body: await res.json() };
}
function workspace() {
	const ws = mktmp("t100-ws-");
	fs.writeFileSync(
		path.join(ws, "workspace.toml"),
		"[home]\ncanonical = true\n",
	);
	fs.writeFileSync(path.join(ws, "AGENTS.md"), "# workspace\n");
	return ws;
}

describe("T100 real Muse sessions", () => {
	for (const noWorkspace of [false, true]) {
		live(
			`default skills and next-chat toggles in ${noWorkspace ? "no-workspace" : "untrusted workspace"} mode`,
			async () => {
				const dh = mktmp("t100-data-");
				const ws = workspace();
				const cfg = privateConfigHome(dh, noWorkspace ? undefined : ws);
				const file = path.join(
					cfg,
					"muse/skills/routeros-fundamentals/SKILL.md",
				);
				const srv = await startServer({
					dataHome: dh,
					...(noWorkspace ? { noWorkspace: true } : { workspace: ws }),
					provider: "echo",
					allowOpenCdb: true,
					trustWorkspace: false,
					museHome: mktmp("t100-muse-"),
				});
				try {
					const first = (await json(`${srv.url}api/chat/history`)).body;
					expect(first.ok).toBe(true);
					const settings = (await json(`${srv.url}api/settings`)).body;
					expect(settings.autoRouterosSkills).toBe(true);
					expect(settings.routerosSkills.staged).toHaveLength(19);
					expect(settings.routerosSkills.verification.loaded).toHaveLength(19);
					expect(settings.routerosSkills.verification.warnings).toEqual([]);
					expect(fs.existsSync(path.join(ws, ".agents"))).toBe(false);
					const inode = fs.statSync(file).ino;
					const off = await json(`${srv.url}api/settings`, {
						autoRouterosSkills: false,
					});
					expect(off.status).toBe(200);
					expect(off.body.routerosSkills.pending).toBe(true);
					expect(fs.statSync(file).ino).toBe(inode);
					expect(
						(await json(`${srv.url}api/chat/history`)).body.sessionId,
					).toBe(first.sessionId);
					const next = await json(`${srv.url}api/chat/new`, {});
					expect(next.status).toBe(200);
					expect(fs.existsSync(file)).toBe(false);
					const applied = (await json(`${srv.url}api/settings`)).body;
					expect(applied.routerosSkills.pending).toBe(false);
					expect(applied.routerosSkills.appliedEnabled).toBe(false);
					await json(`${srv.url}api/settings`, { autoRouterosSkills: true });
					expect(fs.existsSync(file)).toBe(false);
					const resumed = await json(`${srv.url}api/chat/resume`, {
						sessionId: first.sessionId,
					});
					expect(resumed.status).toBe(200);
					expect(fs.existsSync(file)).toBe(true);
					const again = (await json(`${srv.url}api/settings`)).body;
					expect(again.routerosSkills.verification.loaded).toHaveLength(19);
					expect(again.routerosSkills.pending).toBe(false);
					const invalid = await json(`${srv.url}api/settings`, {
						autoRouterosSkills: "false",
						defaultAccess: "allowAll",
					});
					expect(invalid.status).toBe(400);
					expect(
						(await json(`${srv.url}api/settings`)).body.defaultAccess,
					).toBe("promptUnmatched");
				} finally {
					await srv.stop();
				}
			},
			60_000,
		);
	}
	live(
		"one machine setting is honored in another workspace on its first chat",
		async () => {
			const dh = mktmp("t100-machine-");
			writeAutoRouterosSkills(dh, false);
			for (const ws of [workspace(), workspace()]) {
				const srv = await startServer({
					workspace: ws,
					dataHome: dh,
					provider: "echo",
					allowOpenCdb: true,
					museHome: mktmp("t100-muse-"),
					trustWorkspace: false,
				});
				try {
					expect((await json(`${srv.url}api/chat/history`)).body.ok).toBe(true);
					const settings = (await json(`${srv.url}api/settings`)).body;
					expect(settings.autoRouterosSkills).toBe(false);
					expect(settings.routerosSkills.staged).toEqual([]);
				} finally {
					await srv.stop();
				}
			}
		},
		60_000,
	);
	live(
		"trusted workspace overrides are reported without replacing the owner's skill",
		async () => {
			const ws = workspace();
			const dir = path.join(ws, ".agents/skills/routeros-fundamentals");
			fs.mkdirSync(dir, { recursive: true });
			const text =
				"---\nname: routeros-fundamentals\ndescription: Owner-maintained workspace copy.\n---\n# Owner copy\n";
			fs.writeFileSync(path.join(dir, "SKILL.md"), text);
			const srv = await startServer({
				workspace: ws,
				dataHome: mktmp("t100-override-data-"),
				provider: "echo",
				museHome: mktmp("t100-override-muse-"),
				allowOpenCdb: true,
			});
			try {
				await json(`${srv.url}api/chat/history`);
				const report = (await json(`${srv.url}api/settings`)).body
					.routerosSkills;
				expect(report.verification.workspaceOverrides).toEqual([
					"routeros-fundamentals",
				]);
				expect(report.verification.loaded).toHaveLength(18);
				expect(report.verification.warnings.join()).toContain(
					"Workspace skills override",
				);
				expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe(text);
			} finally {
				await srv.stop();
			}
		},
		60_000,
	);
});

test("T100 saving the opt-out during a running turn preserves its worker and files", async () => {
	const { bin, log } = stubT71Bin();
	await withT71Env(log, { mode: "interruptible" }, async () => {
		const dh = mktmp("t100-running-");
		const ws = workspace();
		const srv = await startServer({
			workspace: ws,
			dataHome: dh,
			toolBinDir: bin,
			provider: "echo",
			allowOpenCdb: true,
		});
		try {
			const sent = await json(`${srv.url}api/chat/send`, { text: "hold turn" });
			expect(sent.body.ok).toBe(true);
			const before = (await json(`${srv.url}api/chat/history`)).body;
			expect(before.running).toBe(true);
			await json(`${srv.url}api/settings`, { autoRouterosSkills: false });
			const after = (await json(`${srv.url}api/chat/history`)).body;
			expect(after.sessionId).toBe(before.sessionId);
			expect(after.turnId).toBe(before.turnId);
			expect(after.running).toBe(true);
			expect(
				fs.existsSync(
					path.join(
						privateConfigHome(dh, ws),
						"muse/skills/routeros-fundamentals/SKILL.md",
					),
				),
			).toBe(true);
			expect(fs.readFileSync(log, "utf8")).not.toContain("EOF");
			await json(`${srv.url}api/chat/stop`, {});
		} finally {
			await srv.stop();
		}
	});
}, 30_000);
