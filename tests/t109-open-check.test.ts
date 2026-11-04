// T109 re-review: POST /api/open-check request-shape hygiene.
// Malformed/null JSON and oversized paths are 400s, never 500s.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { cleanupTmpdirs } from "./helpers/tmp";
import { startT50Srv, stubT50Bin, withT50Env } from "./t50-fake";

afterAll(cleanupTmpdirs);

const t109 = process.platform === "win32" ? test.skip : test;

describe("POST /api/open-check hygiene", () => {
	t109("malformed and oversized bodies refuse 400, valid opens", async () => {
		const bin = stubT50Bin();
		await withT50Env(bin.log, async () => {
			const srv = await startT50Srv(bin.bin);
			try {
				// A displayable fixture in the smoke workspace.
				const st = (await (await fetch(`${srv.url}api/status`)).json()) as {
					workspace: string;
				};
				nodeFs.writeFileSync(path.join(st.workspace, "ok.md"), "# ok\n");
				const raw = (body: string) =>
					fetch(`${srv.url}api/open-check`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							origin: new URL(srv.url).origin,
						},
						body,
					});
				expect((await raw("{not json")).status).toBe(400);
				expect((await raw("null")).status).toBe(400);
				expect(
					(await raw(JSON.stringify({ path: "x".repeat(5000) }))).status,
				).toBe(400);
				const ok = await raw(JSON.stringify({ path: "ok.md" }));
				expect(ok.status).toBe(200);
				expect(((await ok.json()) as { ok: unknown }).ok).toBe(true);
			} finally {
				await srv.stop();
			}
		});
	});
});
