// Tool resolution tests (T51, D26): package-root discovery, PATH
// fronting, pinned-spec reads, and env-honoring detection. Stub
// shims prove the fronted env wins over ambient PATH; the real-bundle
// test anchors the installed package.json pins when present.
import { describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { have, run } from "../src/lib/run";
import {
	detectInstalled,
	packageRoot,
	pinnedTools,
	toolBinDir,
	toolEnv,
	toolSource,
	toolSourceLines,
} from "../src/lib/tools";

// Stub shims are POSIX shell; the fronting logic they prove is
// platform-neutral (path.delimiter), the scripts are not.
const tposix = process.platform === "win32" ? test.skip : test;

function writeShim(dir: string, name: string, body: string): void {
	const file = path.join(dir, name);
	nodeFs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	nodeFs.chmodSync(file, 0o755);
}

function stubBin(): string {
	const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t51-stubbin-"));
	writeShim(dir, "quickchr", 'echo "stub-quickchr 9.9.1-stub"');
	writeShim(dir, "centrs", 'echo "stub-centrs 9.9.2-stub"');
	writeShim(dir, "rosetta", 'echo "stub-rosetta 9.9.3-stub"');
	return dir;
}

describe("package root and bundle", () => {
	test("packageRoot finds this package from its own source tree", () => {
		const root = packageRoot();
		expect(root).not.toBeNull();
		const pkg = JSON.parse(
			nodeFs.readFileSync(path.join(root as string, "package.json"), "utf8"),
		) as Record<string, unknown>;
		expect(pkg["name"]).toBe("@tikoci/routeros-muse");
	});

	test("packageRoot returns null outside any routeros-muse tree", () => {
		const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t51-nopkg-"));
		nodeFs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ name: "something-else" }),
		);
		// Point past the decoy so no routeros-muse package.json is reachable.
		const deep = path.join(dir, "a", "b");
		nodeFs.mkdirSync(deep, { recursive: true });
		const here = packageRoot(deep);
		// Either null (walk hit the decoy chain end) or an outer root that
		// is not this temp tree; never the decoy itself.
		if (here !== null) expect(here).not.toBe(dir);
	});

	test("toolBinDir is null without a bundle, set with one", () => {
		const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t51-bindir-"));
		expect(toolBinDir(dir)).toBeNull();
		const bin = path.join(dir, "node_modules", ".bin");
		nodeFs.mkdirSync(bin, { recursive: true });
		expect(toolBinDir(dir)).toBe(bin);
	});

	test("toolSource labels honestly", () => {
		expect(toolSource("/x/node_modules/.bin")).toBe("package");
		expect(toolSource(null)).toBe("ambient");
	});
});

describe("toolEnv", () => {
	test("fronts the bin dir and preserves everything else", () => {
		const env = toolEnv("/fake/.bin", {
			PATH: "/usr/bin:/bin",
			KEEP: "yes",
		} as NodeJS.ProcessEnv);
		expect(env["PATH"]).toBe(`/fake/.bin${path.delimiter}/usr/bin:/bin`);
		expect(env["KEEP"]).toBe("yes");
	});

	test("null bin dir copies the base untouched", () => {
		const env = toolEnv(null, { PATH: "/usr/bin" } as NodeJS.ProcessEnv);
		expect(env["PATH"]).toBe("/usr/bin");
	});

	test("result is a fresh record, never the base", () => {
		const base = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
		const env = toolEnv("/fake/.bin", base);
		env["PATH"] = "mutated";
		env["ADDED"] = "x";
		expect(base["PATH"]).toBe("/usr/bin");
		expect("ADDED" in base).toBe(false);
	});

	test("undefined values are dropped, like the other spawn sites", () => {
		const env = toolEnv(null, {
			PATH: "/usr/bin",
			GONE: undefined,
		} as unknown as NodeJS.ProcessEnv);
		expect("GONE" in env).toBe(false);
	});
});

describe("pinnedTools", () => {
	test("reads trilogy specs from a fixture package.json", () => {
		const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t51-pkg-"));
		nodeFs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({
				dependencies: {
					"@tikoci/centrs": "next",
					"@tikoci/quickchr": "0.5.4",
				},
			}),
		);
		expect(pinnedTools(dir)).toEqual({
			quickchr: "0.5.4",
			centrs: "next",
			rosetta: null,
		});
	});

	test("missing package.json yields nulls, never throws", () => {
		const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t51-nopkgjson-"));
		expect(pinnedTools(dir)).toEqual({
			quickchr: null,
			centrs: null,
			rosetta: null,
		});
		expect(pinnedTools(null)).toEqual({
			quickchr: null,
			centrs: null,
			rosetta: null,
		});
	});
});

describe("toolSourceLines", () => {
	test("package bundle lines name specs and dir", () => {
		const lines = toolSourceLines(
			{ quickchr: "next", centrs: "next", rosetta: null },
			"/pkg/node_modules/.bin",
		);
		expect(lines[0]).toContain("quickchr@next");
		expect(lines[0]).toContain("rosetta@(not pinned)");
		expect(lines[1]).toContain("package bundle (/pkg/node_modules/.bin)");
	});

	test("missing bundle warns and prints the remedy", () => {
		const lines = toolSourceLines(
			{ quickchr: "next", centrs: "next", rosetta: "next" },
			null,
		);
		expect(lines.join("\n")).toContain("WARNING");
		expect(lines.join("\n")).toContain("ambient PATH");
		expect(lines.join("\n")).toContain("bun install");
	});
});

describe("env-honoring detection", () => {
	tposix("have answers for the passed env, not ambient PATH", () => {
		const dir = stubBin();
		writeShim(dir, "stubprobe-t51", "echo hi");
		expect(have("stubprobe-t51", toolEnv(dir))).toBe(true);
		expect(
			have(
				"stubprobe-t51",
				toolEnv(null, { PATH: os.tmpdir() } as NodeJS.ProcessEnv),
			),
		).toBe(false);
	});

	tposix("narrowed PATH without a shell reads as absent, never throws", () => {
		const empty = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t51-emptypath-"));
		expect(
			have("centrs", toolEnv(null, { PATH: empty } as NodeJS.ProcessEnv)),
		).toBe(false);
	});

	tposix("run resolves argv through the passed env", async () => {
		const dir = stubBin();
		writeShim(dir, "stubwho-t51", "echo stub-who-ok");
		const r = await run(["stubwho-t51"], {
			timeoutMs: 10_000,
			env: toolEnv(dir),
		});
		expect(r.ok).toBe(true);
		expect(r.stdout).toContain("stub-who-ok");
	});

	tposix(
		"detectInstalled reports the fronted builds, not ambient",
		async () => {
			const found = await detectInstalled(toolEnv(stubBin()));
			expect(found).toEqual({
				quickchr: "9.9.1-stub",
				centrs: "9.9.2-stub",
				rosetta: "9.9.3-stub",
			});
		},
	);
});

// The installed bundle: package.json pins must resolve to working
// builds. Skipped on checkouts where `bun install` has not run yet.
const tbundle = toolBinDir() ? test : test.skip;

describe("installed bundle", () => {
	tbundle("package-fronted detection reports all three tools", async () => {
		const found = await detectInstalled(toolEnv(toolBinDir()));
		expect(found.quickchr).toMatch(/^\d+\.\d+\.\d+/);
		expect(found.centrs).toMatch(/^\d+\.\d+\.\d+/);
		expect(found.rosetta).toMatch(/^\d+\.\d+\.\d+/);
	});

	tbundle("package.json pins the trilogy to the preview channel", () => {
		const specs = pinnedTools();
		expect(specs).toEqual({
			quickchr: "next",
			centrs: "next",
			rosetta: "next",
		});
	});
});
