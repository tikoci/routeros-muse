// T50 follow-up: settings.toml write safety. Hermetic unit tests over
// src/lib/settings.ts (no server, no worker): symlink refusal,
// atomic temp+rename writes, and quoted-key dedup.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	readDefaultAccess,
	settingsFile,
	writeDefaultAccess,
} from "../src/lib/settings";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

function seedFile(dataHome: string, text: string): string {
	const file = settingsFile(dataHome);
	nodeFs.mkdirSync(path.dirname(file), { recursive: true });
	nodeFs.writeFileSync(file, text);
	return file;
}

function keyLines(text: string): string[] {
	return text
		.split("\n")
		.filter((l) => /(^|\s)["']?default_access["']?\s*=/.test(l));
}

describe("settings symlink refusal", () => {
	test("settings.toml symlinked to a victim: write fails, victim unchanged", () => {
		const dh = mktmp("t50set-symfile-");
		const victim = path.join(dh, "victim.txt");
		nodeFs.writeFileSync(victim, "victim-bytes\n");
		const file = settingsFile(dh);
		nodeFs.mkdirSync(path.dirname(file), { recursive: true });
		nodeFs.symlinkSync(victim, file);
		expect(() => writeDefaultAccess(dh, "allowAll")).toThrow(/symlink/i);
		expect(nodeFs.readFileSync(victim, "utf8")).toBe("victim-bytes\n");
	});

	test("symlinked routeros-muse dir: write refused", () => {
		const dh = mktmp("t50set-symdir-");
		const target = path.join(dh, "real-target");
		nodeFs.mkdirSync(target, { recursive: true });
		nodeFs.symlinkSync(target, path.join(dh, "routeros-muse"));
		expect(() => writeDefaultAccess(dh, "allowAll")).toThrow(/symlink/i);
		expect(nodeFs.readdirSync(target)).toEqual([]);
	});

	test("symlinked settings.toml: read falls back to null like a corrupt file", () => {
		const dh = mktmp("t50set-symread-");
		const victim = path.join(dh, "victim.txt");
		nodeFs.writeFileSync(victim, '[agent]\ndefault_access = "allowAll"\n');
		const file = settingsFile(dh);
		nodeFs.mkdirSync(path.dirname(file), { recursive: true });
		nodeFs.symlinkSync(victim, file);
		expect(readDefaultAccess(dh)).toBeNull();
	});
});

describe("settings atomic write", () => {
	test("throwing writer: original bytes identical, no temp left", () => {
		const dh = mktmp("t50set-atomthrow-");
		const before =
			'# note\n[other]\nkeep = true\n[agent]\ndefault_access = "promptUnmatched"\n';
		const file = seedFile(dh, before);
		expect(() =>
			writeDefaultAccess(dh, "allowAll", {
				writeSync: () => {
					throw new Error("ENOSPC: no space left");
				},
			}),
		).toThrow(/ENOSPC/);
		expect(nodeFs.readFileSync(file, "utf8")).toBe(before);
		expect(nodeFs.readdirSync(path.dirname(file))).toEqual(["settings.toml"]);
	});

	test("short writer: original bytes identical, no temp left", () => {
		const dh = mktmp("t50set-atomshort-");
		const before = '[agent]\ndefault_access = "promptUnmatched"\n';
		const file = seedFile(dh, before);
		expect(() =>
			writeDefaultAccess(dh, "allowAll", { writeSync: () => 0 }),
		).toThrow(/short write/);
		expect(nodeFs.readFileSync(file, "utf8")).toBe(before);
		expect(nodeFs.readdirSync(path.dirname(file))).toEqual(["settings.toml"]);
	});

	test("successful write leaves no temp behind", () => {
		const dh = mktmp("t50set-atomok-");
		const file = seedFile(dh, '[agent]\ndefault_access = "promptUnmatched"\n');
		writeDefaultAccess(dh, "allowAll");
		expect(nodeFs.readdirSync(path.dirname(file))).toEqual(["settings.toml"]);
		expect(readDefaultAccess(dh)).toBe("allowAll");
	});
});

describe("settings quoted-key dedup", () => {
	test("double-quoted key: save writes exactly one key, reads back", () => {
		const dh = mktmp("t50set-qdouble-");
		const file = seedFile(
			dh,
			'[agent]\n"default_access" = "promptUnmatched"\n',
		);
		writeDefaultAccess(dh, "allowAll");
		const text = nodeFs.readFileSync(file, "utf8");
		expect(keyLines(text)).toHaveLength(1);
		expect(readDefaultAccess(dh)).toBe("allowAll");
	});

	test("single-quoted key: save writes exactly one key, reads back", () => {
		const dh = mktmp("t50set-qsingle-");
		const file = seedFile(
			dh,
			"[agent]\n'default_access' = 'promptUnmatched'\n",
		);
		writeDefaultAccess(dh, "allowAll");
		const text = nodeFs.readFileSync(file, "utf8");
		expect(keyLines(text)).toHaveLength(1);
		expect(readDefaultAccess(dh)).toBe("allowAll");
	});

	test("bare plus quoted duplicates collapse to exactly one key", () => {
		const dh = mktmp("t50set-qdup-");
		const file = seedFile(
			dh,
			'[agent]\ndefault_access = "promptUnmatched"\n"default_access" = "promptUnmatched"\n',
		);
		writeDefaultAccess(dh, "allowAll");
		const text = nodeFs.readFileSync(file, "utf8");
		expect(keyLines(text)).toHaveLength(1);
		expect(readDefaultAccess(dh)).toBe("allowAll");
	});
});

describe("settings re-review edge cases", () => {
	const tnotroot =
		process.platform !== "win32" && process.getuid?.() !== 0 ? test : test.skip;
	tnotroot("an unreadable settings file is never replaced", () => {
		const dh = mktmp("t50c-unread-");
		const file = seedFile(
			dh,
			'# keep me\n[agent]\ndefault_access = "promptUnmatched"\n[other]\nx = 1\n',
		);
		nodeFs.chmodSync(file, 0o000);
		try {
			expect(() => writeDefaultAccess(dh, "allowAll")).toThrow(/EACCES/);
		} finally {
			nodeFs.chmodSync(file, 0o600);
		}
		expect(nodeFs.readFileSync(file, "utf8")).toContain("# keep me");
		expect(nodeFs.readFileSync(file, "utf8")).toContain("[other]");
	});

	for (const header of ['["agent"]', "['agent']", "[ agent ]"]) {
		test(`quoted/spaced table ${header} is updated in place`, () => {
			const dh = mktmp("t50c-qtable-");
			const file = seedFile(
				dh,
				`${header}\ndefault_access = "promptUnmatched"\n`,
			);
			writeDefaultAccess(dh, "allowAll");
			const text = nodeFs.readFileSync(file, "utf8");
			expect(text.match(/^\s*\[/gm)?.length).toBe(1);
			expect(readDefaultAccess(dh)).toBe("allowAll");
		});
	}
});
