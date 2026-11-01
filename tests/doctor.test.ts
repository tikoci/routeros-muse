import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	type DoctorEntry,
	loadDoctorSpec,
	mergeEntries,
} from "../src/steps/doctor";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

const FX = path.join(import.meta.dir, "fixtures");

function entry(over: Partial<DoctorEntry> = {}): DoctorEntry {
	return {
		id: "x",
		os: "linux",
		tier: "helpful",
		detect: "true",
		hint: "h",
		why: "w",
		skills: [],
		required_for: [],
		...over,
	};
}

describe("doctor merge", () => {
	test("same id+os overrides, new ids append", () => {
		const base = [entry({ id: "qemu", hint: "BASE" }), entry({ id: "git" })];
		const overlay = [
			entry({ id: "qemu", hint: "OVERLAY" }),
			entry({ id: "extra" }),
		];
		const merged = mergeEntries(base, overlay);
		expect(merged.length).toBe(3);
		expect(merged.find((e) => e.id === "qemu")?.hint).toBe("OVERLAY");
		expect(merged.find((e) => e.id === "git")?.hint).toBe("h");
		expect(merged.find((e) => e.id === "extra")).toBeDefined();
	});

	test("different os does not override", () => {
		const merged = mergeEntries(
			[entry({ id: "qemu", os: "linux" })],
			[entry({ id: "qemu", os: "mac" })],
		);
		expect(merged.length).toBe(2);
	});
});

describe("packaged spec + workspace overlay", () => {
	test("packaged doctor.toml parses with the required entries", async () => {
		const dir = mktmp("t30-doc-");
		const entries = await loadDoctorSpec(dir);
		const ids = new Set(entries.map((e) => `${e.id}/${e.os}`));
		for (const want of [
			"muse/mac",
			"bun/linux",
			"git/mac",
			"qemu/linux",
			"graphviz/mac",
		]) {
			expect(ids.has(want)).toBe(true);
		}
		for (const e of entries) {
			expect(["required", "recommended", "helpful"]).toContain(e.tier);
		}
	});

	test("workspace doctor.local.toml merges on top", async () => {
		const dir = mktmp("t30-doc-");
		nodeFs.copyFileSync(
			path.join(FX, "doctor.local.toml"),
			path.join(dir, "doctor.local.toml"),
		);
		const entries = await loadDoctorSpec(dir);
		expect(entries.find((e) => e.id === "qemu" && e.os === "linux")?.hint).toBe(
			"OVERLAY HINT",
		);
		expect(entries.find((e) => e.id === "lab-printer")).toBeDefined();
	});
});
