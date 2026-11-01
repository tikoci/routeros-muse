// Anchor tests for checker.ts verify functions. Pure tmp-dir fixtures, no router.
// Run: bun test
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyFiles, verifyManifestSchema, verifySlot } from "./checker";
import { sha256Hex } from "./sanitize";

function manifest(files: { path: string; sha256: string; bytes: number }[]) {
	return {
		target: "t",
		serial: "AAA",
		capturedAt: new Date().toISOString(),
		tools: { centrs: "c", quickchr: "q" },
		files,
		status: "ok" as const,
		notes: [],
	};
}

// Build out/<slot>/<stamp>/ + latest symlink in a tmp dir; returns slot dir.
function fixtureSlot(
	m: ReturnType<typeof manifest>,
	payloads: Record<string, string>,
): string {
	const root = mkdtempSync(join(tmpdir(), "checker-"));
	const slotDir = join(root, "t");
	const dir = join(slotDir, "stamp");
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(payloads))
		writeFileSync(join(dir, name), content);
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
	symlinkSync("stamp", join(slotDir, "latest"));
	return slotDir;
}

describe("verifyManifestSchema", () => {
	test("accepts a good manifest", () => {
		expect(verifyManifestSchema(manifest([]))).toEqual([]);
	});
	test("flags missing fields and bad status", () => {
		const problems = verifyManifestSchema({
			target: "",
			files: [],
			status: "bogus",
			notes: "x",
		});
		expect(problems.length).toBeGreaterThan(2);
		expect(problems.join(";")).toContain("status");
	});
	test("flags bad sha256 and bytes in file entries", () => {
		const problems = verifyManifestSchema(
			manifest([{ path: "a.json", sha256: "zzz", bytes: -1 }]),
		);
		expect(problems.join(";")).toContain("sha256");
		expect(problems.join(";")).toContain("bytes");
	});
});

describe("verifyFiles", () => {
	test("clean files pass, totalBytes sums sizes", () => {
		const dir = mkdtempSync(join(tmpdir(), "checker-"));
		writeFileSync(join(dir, "a.txt"), "abc");
		const r = verifyFiles(dir, [
			{ path: "a.txt", sha256: sha256Hex("abc"), bytes: 3 },
		]);
		expect(r.problems).toEqual([]);
		expect(r.totalBytes).toBe(3);
	});
	test("flags missing file, tampered content, wrong bytes", () => {
		const dir = mkdtempSync(join(tmpdir(), "checker-"));
		writeFileSync(join(dir, "a.txt"), "tampered");
		const r = verifyFiles(dir, [
			{ path: "a.txt", sha256: sha256Hex("abc"), bytes: 3 },
			{ path: "gone.txt", sha256: sha256Hex("x"), bytes: 1 },
		]);
		expect(r.problems.join(";")).toContain("sha256 mismatch");
		expect(r.problems.join(";")).toContain("missing");
	});
});

describe("verifySlot", () => {
	test("clean slot ok with byte total", () => {
		const m = manifest([{ path: "a.txt", sha256: sha256Hex("abc"), bytes: 3 }]);
		const report = verifySlot(fixtureSlot(m, { "a.txt": "abc" }), "t");
		expect(report.ok).toBe(true);
		expect(report.totalBytes).toBe(3);
		expect(report.files).toBe(1);
	});
	test("dangling latest fails", () => {
		const root = mkdtempSync(join(tmpdir(), "checker-"));
		const slotDir = join(root, "t");
		mkdirSync(slotDir, { recursive: true });
		symlinkSync("no-such-dir", join(slotDir, "latest"));
		const report = verifySlot(slotDir, "t");
		expect(report.ok).toBe(false);
		expect(report.problems.join(";")).toMatch(/latest|manifest/);
	});
	test("missing slot dir fails", () => {
		const report = verifySlot(
			join(tmpdir(), `checker-nope-${Date.now()}`),
			"t",
		);
		expect(report.ok).toBe(false);
	});
});
