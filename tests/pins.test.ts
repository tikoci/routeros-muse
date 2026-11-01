import { describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	comparePins,
	isChannelPin,
	isUnpinned,
	mismatchMessage,
	resolveChannelPin,
	resolvePins,
	unpinnedMessage,
} from "../src/steps/pins";

describe("channel pins", () => {
	test("next with or without @ is a channel pin", () => {
		expect(isChannelPin("next")).toBe(true);
		expect(isChannelPin("@next")).toBe(true);
		expect(isChannelPin("  Next ")).toBe(true);
		expect(isChannelPin("0.5.2")).toBe(false);
		expect(isChannelPin("unpinned-todo")).toBe(false);
		expect(isChannelPin("")).toBe(false);
		expect(isChannelPin(null)).toBe(false);
	});

	test("channel entries resolve, exact pins pass through", async () => {
		const r = await resolvePins(
			{ quickchr: "next", centrs: "@next", rosetta: "0.2.0" },
			async (tool) =>
				({ quickchr: "0.5.4", centrs: "0.1.9-next.24", rosetta: null })[tool],
		);
		expect(r.failed).toEqual([]);
		expect(r.pins).toEqual({
			quickchr: "0.5.4",
			centrs: "0.1.9-next.24",
			rosetta: "0.2.0",
		});
	});

	test("unresolvable channels fail closed with names", async () => {
		const r = await resolvePins(
			{ quickchr: "next", centrs: "0.1.8" },
			async () => null,
		);
		expect(r.failed).toEqual(["quickchr"]);
		expect(r.pins["centrs"]).toBe("0.1.8");
	});

	test("resolved channel pins compare exactly, like fixed pins", async () => {
		const { pins } = await resolvePins(
			{ quickchr: "next", centrs: "next" },
			async (tool) => (tool === "quickchr" ? "0.5.4" : "0.1.9-next.24"),
		);
		// Release build installed where the channel is pinned: mismatch.
		const stale = comparePins(pins, {
			quickchr: "0.5.4",
			centrs: "0.1.8",
			rosetta: null,
		});
		expect(stale.mismatched.map((m) => m.tool)).toEqual(["centrs"]);
		const fresh = comparePins(pins, {
			quickchr: "0.5.4",
			centrs: "0.1.9-next.24",
			rosetta: null,
		});
		expect(fresh.mismatched).toEqual([]);
		expect(isUnpinned("next")).toBe(false);
	});

	test("live registry resolution is version-shaped when reachable", async () => {
		const v = await resolveChannelPin("centrs");
		if (v === null) {
			console.log("  (registry unreachable; channel parse untested)");
			return;
		}
		expect(v).toMatch(/^\d+\.\d+\.\d+/);
	}, 60_000);

	test("channel resolution leaves no node-compile-cache in TMPDIR", async () => {
		// T94: npm enables Node's compile cache by default, landing in
		// $TMPDIR/node-compile-cache. The resolve spawn disables it, so
		// clearing the cache and resolving must not bring it back.
		const cache = path.join(
			process.env["TMPDIR"] ?? os.tmpdir(),
			"node-compile-cache",
		);
		nodeFs.rmSync(cache, { recursive: true, force: true });
		await resolveChannelPin("centrs");
		expect(nodeFs.existsSync(cache)).toBe(false);
	}, 60_000);
});

describe("verified-against stop bodies", () => {
	test("unpinned names TODOs with running versions", () => {
		const lines = unpinnedMessage(["rosetta"], {
			quickchr: "0.5.4",
			centrs: "0.1.9-next.24",
			rosetta: null,
		});
		expect(lines[0]).toContain("[pins].rosetta");
		expect(lines.join("\n")).toContain("TODO [pins].rosetta");
		expect(lines.join("\n")).toContain("verified version");
		expect(lines.join("\n")).not.toContain("install -g");
	});

	test("mismatch names running vs verified with bundle-or-refresh remedies", () => {
		const lines = mismatchMessage(
			[{ tool: "centrs", pin: "0.1.8", installed: "0.1.9-next.24" }],
			"package",
		);
		const text = lines.join("\n");
		expect(text).toContain("verified-against [pins]");
		expect(text).toContain("running 0.1.9-next.24 (package bundle)");
		expect(text).toContain("vs verified 0.1.8");
		expect(text).toContain("bun install");
		expect(text).toContain("bump [pins]");
		expect(text).not.toContain("install -g");
	});

	test("mismatch labels the ambient fallback honestly", () => {
		const lines = mismatchMessage(
			[{ tool: "quickchr", pin: "0.5.4", installed: null }],
			"ambient",
		);
		expect(lines.join("\n")).toContain("missing (ambient PATH)");
	});
});
