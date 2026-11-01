// T82 interim disclosure pins. The C15 conflict check (the
// credentialSnapshot re-read-and-compare in setCdbCredentials) is
// password-blind and non-atomic; the durable fix is upstream
// tikoci/centrs#581. These tests PIN the interim behavior — not the
// fixed behavior — so the disclosure cannot silently regress.
//
// Hermetic: real centrs binary, temp CDB file, no routers, no network
// (the seeded-CDB pattern from the T48 suite in serve.test.ts).
import { describe, expect, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	credentialSnapshot,
	setCdbCredentials,
	showCdbDevice,
} from "../src/lib/fleet";
import { have } from "../src/lib/run";

const HAVE_CENTRS = have("centrs");
const tcentrs = HAVE_CENTRS ? test : test.skip;

function seedOpenCdb(): string {
	const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t82-seed-"));
	const cdb = path.join(dir, "seeded.cdb");
	const env = { ...process.env, CENTRS_CDB_FILE: cdb };
	const init = childProcess.spawnSync("centrs", ["devices", "init"], { env });
	expect(init.status).toBe(0);
	const added = childProcess.spawnSync(
		"centrs",
		[
			"devices",
			"add",
			"t82-target",
			"--user",
			"t82-admin",
			"--password",
			"t82-fixture-pw-a",
			"--format",
			"json",
		],
		{ env },
	);
	expect(added.status).toBe(0);
	return cdb;
}

function rotatePassword(cdb: string, password: string): void {
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		CENTRS_CDB_FILE: cdb,
	};
	const out = childProcess.spawnSync(
		"centrs",
		[
			"devices",
			"set",
			"t82-target",
			"--password",
			password,
			"--format",
			"json",
		],
		{ env },
	);
	expect(out.status).toBe(0);
}

describe("T82 interim conflict-check limits", () => {
	// INTERIM(T82/C15) KNOWN-GAP PIN: a password A→B rotation leaves the
	// snapshot identical, so a sequential stale write through
	// setCdbCredentials with the older baseline succeeds with
	// conflict=false (the blindness the modal note discloses). FLIP
	// THIS TEST to expect-conflict once tikoci/centrs#581 lands.
	tcentrs(
		"INTERIM(T82/C15): password rotation is invisible to the snapshot and a stale sequential write succeeds",
		async () => {
			const cdb = seedOpenCdb();
			const env = {
				...(process.env as Record<string, string>),
				CENTRS_CDB_FILE: cdb,
			};
			const baseline = await showCdbDevice(cdb, "t82-target", env);
			expect(baseline.ok).toBe(true);
			if (!baseline.ok) return;
			rotatePassword(cdb, "t82-fixture-pw-b");
			const rotated = await showCdbDevice(cdb, "t82-target", env);
			expect(rotated.ok).toBe(true);
			if (!rotated.ok) return;
			expect(credentialSnapshot(rotated.details)).toBe(
				credentialSnapshot(baseline.details),
			);
			const stale = await setCdbCredentials(
				cdb,
				"t82-target",
				{ password: "t82-fixture-pw-c" },
				env,
				baseline.details,
			);
			expect(stale.ok).toBe(true);
			expect("conflict" in stale && stale.conflict).toBe(false);
		},
	);

	// INTERIM(T82) DISCLOSURE PIN: the modal carries the static
	// limitation note so nobody silently deletes it. Rewording is the
	// parent's call at review; deleting the disclosure while C15 is
	// open is not. Remove or rewrite this test when #581 lands.
	test("INTERIM(T82): credentials modal carries the conflict-check limitation note", () => {
		const html = nodeFs.readFileSync(
			path.join(import.meta.dir, "..", "src", "serve", "ui.html"),
			"utf8",
		);
		const ctx = html.indexOf('id="credctx"');
		const note = html.indexOf('id="credlimit"');
		const firstField = html.indexOf('id="credf-user"');
		expect(ctx).toBeGreaterThan(-1);
		expect(note).toBeGreaterThan(-1);
		// Static note sits under the context block, above the fields.
		expect(note).toBeGreaterThan(ctx);
		expect(firstField).toBeGreaterThan(note);
		// Password-value invisibility disclosure…
		expect(html).toContain("Password-value changes are invisible to it");
		expect(html).toContain("will NOT raise a conflict");
		// …and the durable-fix reference.
		expect(html).toContain("tikoci/centrs#581");
	});
});
