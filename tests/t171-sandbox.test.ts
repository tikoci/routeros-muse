import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	readDisableSandbox,
	settingsFile,
	writeDisableSandbox,
} from "../src/lib/settings";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";
import { startT50Srv, stubT50Bin, withT50Env } from "./t50-fake";

afterAll(cleanupTmpdirs);

async function json(url: string, body?: unknown) {
	const r = await fetch(
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
	return { status: r.status, body: await r.json() };
}

test("sandbox removal requires explicit true, and refuses symlink settings", () => {
	const dh = mktmp("t171-settings-");
	expect(readDisableSandbox(dh)).toBe(false);
	writeDisableSandbox(dh, true);
	expect(readDisableSandbox(dh)).toBe(true);
	const file = settingsFile(dh);
	for (const value of ['"true"', "1", "false", "[broken"]) {
		fs.writeFileSync(file, `[agent]\ndisable_sandbox = ${value}\n`);
		expect(readDisableSandbox(dh)).toBe(false);
	}
	const victim = path.join(dh, "victim");
	writeDisableSandbox(dh, true);
	fs.renameSync(file, victim);
	fs.symlinkSync(victim, file);
	expect(readDisableSandbox(dh)).toBe(false);
	expect(() => writeDisableSandbox(dh, true)).toThrow(/symlink/);
});

test("saved override requires server restart, preserves Ask first and can be restored", async () => {
	const { bin, log } = stubT50Bin();
	const dh = mktmp("t171-data-");
	await withT50Env(log, async () => {
		for (const applied of [false, true, false]) {
			const srv = await startT50Srv(bin, { dataHome: dh });
			try {
				const url = `${srv.url}api/settings`;
				expect((await json(url)).body).toMatchObject({
					disableSandbox: applied,
					disableSandboxApplied: applied,
					sandboxRestartRequired: false,
					defaultAccess: "promptUnmatched",
				});
				const invalid = await json(url, {
					disableSandbox: "true",
					defaultAccess: "allowAll",
				});
				expect(invalid.status).toBe(400);
				const saved = await json(url, { disableSandbox: !applied });
				expect(saved.body).toMatchObject({
					disableSandbox: !applied,
					disableSandboxApplied: applied,
					sandboxRestartRequired: true,
					defaultAccess: "promptUnmatched",
				});
				// Even the FIRST worker after saving uses the boot value.
				fs.writeFileSync(path.join(bin, "argv.log"), "");
				await json(`${srv.url}api/chat/send`, { text: "hello" });
				const argv = fs.readFileSync(path.join(bin, "argv.log"), "utf8");
				expect(argv.includes("--disable-sandbox")).toBe(applied);
				expect(fs.readFileSync(log, "utf8")).toContain(
					"approvalMode=promptUnmatched permissionProfile=:ask-me",
				);
				await json(`${srv.url}api/chat/new`, {});
				expect((await json(url)).body.sandboxRestartRequired).toBe(true);
				await json(url, { disableSandbox: applied });
				expect((await json(url)).body.sandboxRestartRequired).toBe(false);
				writeDisableSandbox(dh, !applied);
			} finally {
				await srv.stop();
			}
		}
	});
}, 30_000);
