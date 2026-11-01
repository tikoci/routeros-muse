import { describe, expect, test } from "bun:test";
import { comparePins, isUnpinned, parseVersion } from "../src/steps/pins";
import { mapMode, parseRouterFlag, tcpProbe } from "../src/steps/probe";

describe("capability mode", () => {
	test("four modes incl the twin-only edge", () => {
		expect(mapMode(true, true)).toBe("full");
		expect(mapMode(true, false)).toBe("twin-only");
		expect(mapMode(false, true)).toBe("real-box-only");
		expect(mapMode(false, false)).toBe("design-only");
	});
});

describe("router flag", () => {
	test("bare host probes the RouterOS ports", () => {
		expect(parseRouterFlag("router.lan")).toEqual({
			host: "router.lan",
			ports: [8728, 8291, 22],
		});
	});

	test("host:port pins one port", () => {
		expect(parseRouterFlag("router.lan:8728")).toEqual({
			host: "router.lan",
			ports: [8728],
		});
	});
});

describe("tcp probe", () => {
	test("open loopback port probes true, closed probes false", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("ok"),
		});
		const port = server.port;
		if (port === undefined)
			throw new Error("probe server bound without a port");
		try {
			expect(await tcpProbe("127.0.0.1", port, 2000)).toBe(true);
		} finally {
			server.stop(true);
		}
		expect(await tcpProbe("127.0.0.1", port, 1000)).toBe(false);
	});
});

describe("pins", () => {
	test("unpinned spellings", () => {
		expect(isUnpinned("unpinned-todo")).toBe(true);
		expect(isUnpinned("TODO")).toBe(true);
		expect(isUnpinned("")).toBe(true);
		expect(isUnpinned(undefined)).toBe(true);
		expect(isUnpinned("0.5.2")).toBe(false);
	});

	test("compare finds unpinned + mismatches, exact match passes", () => {
		const installed = { quickchr: "0.5.2", centrs: "0.1.8", rosetta: "0.11.3" };
		const r = comparePins(
			{ quickchr: "0.5.2", centrs: "0.1.9-next", rosetta: "unpinned-todo" },
			installed,
		);
		expect(r.unpinned).toEqual(["rosetta"]);
		expect(r.mismatched).toEqual([
			{ tool: "centrs", pin: "0.1.9-next", installed: "0.1.8" },
		]);
		const clean = comparePins(
			{ quickchr: "0.5.2", centrs: "0.1.8", rosetta: "0.11.3" },
			installed,
		);
		expect(clean.unpinned).toEqual([]);
		expect(clean.mismatched).toEqual([]);
	});

	test("version parse keeps suffixes", () => {
		expect(parseVersion("quickchr 0.5.2\n")).toBe("0.5.2");
		expect(parseVersion("0.1.9-next")).toBe("0.1.9-next");
		expect(parseVersion("no version here")).toBeNull();
	});
});
