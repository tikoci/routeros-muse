// Scaffold write safety (T97): exclusive creates, no symlink
// follow, honest rollback. Fail-first for the four init bugs:
// TOCTOU overwrite, dangling-symlink escape, partial copy
// blocking retry, rollback deleting a pre-existing empty dir —
// plus the symlinked-subdir variant. Hermetic: temp dirs (all
// cleaned in afterAll), stub centrs, no live turns.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toolEnv } from "../src/lib/tools";
import { scaffoldIntoDir } from "../src/lib/workspace";

const POSIX = process.platform !== "win32";
const tposix = POSIX ? test : test.skip;

const tmpdirs: string[] = [];
afterAll(() => {
	for (const d of tmpdirs) {
		nodeFs.rmSync(d, { recursive: true, force: true });
	}
});

function mktmp(prefix: string): string {
	const d = nodeFs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpdirs.push(d);
	return d;
}

function writeShim(dir: string, name: string, body: string): void {
	const file = path.join(dir, name);
	nodeFs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	nodeFs.chmodSync(file, 0o755);
}

/** Stub bin: centrs init touches the CDB. */
function stubCentrsBin(): string {
	const dir = mktmp("t97-bin-");
	writeShim(
		dir,
		"centrs",
		`if [ "$1" = "devices" ] && [ "$2" = "init" ]; then\n` +
			`  while [ $# -gt 0 ]; do if [ "$1" = "--cdb-file" ]; then : > "$2"; exit 0; fi; shift; done\n` +
			`  exit 1\nfi\nexit 1`,
	);
	return dir;
}

function failingCentrsBin(): string {
	const dir = mktmp("t97-failbin-");
	writeShim(dir, "centrs", "exit 1");
	return dir;
}

describe("scaffold write safety", () => {
	tposix("TOCTOU: a competing write after preflight is not overwritten", async () => {
		const dir = mktmp("t97-toctou-");
		const competing = "OWNER DATA — must survive\n";
		const res = await scaffoldIntoDir(dir, toolEnv(stubCentrsBin()), "minimal", {
			afterPreflight: () => {
				nodeFs.writeFileSync(path.join(dir, "workspace.toml"), competing);
			},
		});
		expect(res.ok).toBe(false);
		expect(nodeFs.readFileSync(path.join(dir, "workspace.toml"), "utf8")).toBe(
			competing,
		);
		expect(nodeFs.readdirSync(dir).sort()).toEqual(["workspace.toml"]);
	});

	tposix("dangling workspace.toml symlink is a conflict; target untouched", async () => {
		const outer = mktmp("t97-symlink-");
		const dir = path.join(outer, "ws");
		nodeFs.mkdirSync(dir);
		const outside = path.join(outer, "outside.txt");
		nodeFs.symlinkSync(outside, path.join(dir, "workspace.toml"));
		const res = await scaffoldIntoDir(dir, toolEnv(stubCentrsBin()), "minimal");
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.conflicts).toContain("workspace.toml");
		expect(nodeFs.existsSync(outside)).toBe(false);
		expect(
			nodeFs.lstatSync(path.join(dir, "workspace.toml")).isSymbolicLink(),
		).toBe(true);
		expect(nodeFs.readdirSync(dir)).toEqual(["workspace.toml"]);
	});

	tposix("symlinked subdir is a conflict; nothing lands outside", async () => {
		const outer = mktmp("t97-symdir-");
		const dir = path.join(outer, "ws");
		nodeFs.mkdirSync(dir);
		const outside = path.join(outer, "outside");
		nodeFs.mkdirSync(outside);
		nodeFs.symlinkSync(outside, path.join(dir, "checks"));
		const res = await scaffoldIntoDir(dir, toolEnv(stubCentrsBin()), "network");
		expect(res.ok).toBe(false);
		expect(nodeFs.readdirSync(outside)).toEqual([]);
		expect(nodeFs.lstatSync(path.join(dir, "checks")).isSymbolicLink()).toBe(
			true,
		);
	});

	tposix("checks-file failure leaves nothing; retry succeeds", async () => {
		const dir = mktmp("t97-checksfile-");
		nodeFs.writeFileSync(path.join(dir, "checks"), "I am a file, not a dir\n");
		const res = await scaffoldIntoDir(dir, toolEnv(stubCentrsBin()), "network");
		expect(res.ok).toBe(false);
		expect(nodeFs.readdirSync(dir).sort()).toEqual(["checks"]);
		nodeFs.rmSync(path.join(dir, "checks"));
		const retry = await scaffoldIntoDir(
			dir,
			toolEnv(stubCentrsBin()),
			"network",
		);
		expect(retry.ok).toBe(true);
	});

	tposix("failed init keeps a pre-existing empty dir", async () => {
		const dir = mktmp("t97-emptydest-");
		expect(nodeFs.readdirSync(dir)).toEqual([]);
		const res = await scaffoldIntoDir(
			dir,
			toolEnv(failingCentrsBin()),
			"minimal",
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.why).toMatch(/centrs devices init failed/);
		expect(nodeFs.existsSync(dir)).toBe(true);
		expect(nodeFs.readdirSync(dir)).toEqual([]);
	});
});
