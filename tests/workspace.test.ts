import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	findConflictCopies,
	isConflictName,
	isGitUrl,
	readAndValidate,
} from "../src/steps/workspace";

const FX = path.join(import.meta.dir, "fixtures");

describe("workspace validation", () => {
	test("good workspace validates with pins", async () => {
		const r = await readAndValidate(path.join(FX, "ws-good"));
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.config.home["canonical"]).toBe(true);
			expect(r.config.pins["quickchr"]).toBe("0.5.2");
		}
	});

	test("non-canonical copy is refused", async () => {
		const r = await readAndValidate(path.join(FX, "ws-bad-canonical"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason.join("\n")).toMatch(/canonical/);
	});

	test("missing AGENTS.md is refused", async () => {
		const r = await readAndValidate(path.join(FX, "ws-no-agents"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason.join("\n")).toMatch(/AGENTS\.md/);
	});

	test("unparsable workspace.toml is refused", async () => {
		const r = await readAndValidate(path.join(FX, "ws-bad-toml"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason.join("\n")).toMatch(/does not parse/);
	});

	test("missing workspace.toml is refused", async () => {
		const r = await readAndValidate(path.join(FX, "does-not-exist"));
		expect(r.ok).toBe(false);
	});

	test("conflict copies are refused, not merged", async () => {
		const r = await readAndValidate(path.join(FX, "ws-conflict"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason.join("\n")).toMatch(/single-canonical guard/);
	});
});

describe("conflict names", () => {
	test("dropbox + syncthing patterns hit anywhere", () => {
		expect(
			isConflictName("router (bob's conflicted copy 2026-01-01).toml"),
		).toBe(true);
		expect(isConflictName("y.sync-conflict-20260101.md")).toBe(true);
	});

	test("drive (N) dupes hit only md/toml", () => {
		expect(isConflictName("notes (1).md")).toBe(true);
		expect(isConflictName("photo (1).jpg")).toBe(false);
	});

	test("ordinary names pass", () => {
		for (const n of [
			"workspace.toml",
			"AGENTS.md",
			"001-x-handoff.md",
			"notes.md",
		]) {
			expect(isConflictName(n)).toBe(false);
		}
	});

	test("walk finds nested hits and skips .git", () => {
		const { hits } = findConflictCopies(path.join(FX, "ws-conflict"));
		expect(hits.length).toBe(3);
		expect(hits.some((h) => h.includes("sub/"))).toBe(true);
	});
});

describe("git urls", () => {
	test("remote shapes detected", () => {
		expect(isGitUrl("https://github.com/you/net.git")).toBe(true);
		expect(isGitUrl("git@github.com:you/net.git")).toBe(true);
		expect(isGitUrl("ssh://git@host/you/net.git")).toBe(true);
		expect(isGitUrl("file:///srv/git/net.git")).toBe(true);
	});

	test("local paths are not urls", () => {
		expect(isGitUrl("/home/you/net")).toBe(false);
		expect(isGitUrl("./net")).toBe(false);
		expect(isGitUrl("~/net")).toBe(false);
	});
});
