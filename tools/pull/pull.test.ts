// Anchor tests: pin what the code does NOW. Run: bun test
import { describe, expect, test } from "bun:test";
import {
	checkSerial,
	redactExport,
	sha256Hex,
	stableExportHeader,
	stripVolatile,
} from "./sanitize";

describe("redactExport", () => {
	test("redacts secret-bearing keys, keeps the rest", () => {
		const input = `/user add name=bob password=hunter2 group=full
/ip address add address=10.0.0.1/24 interface=ether1
/radius add secret=s3cret address=10.0.0.2
/container/envs/add list=app name=API_TOKEN value=abc123
/container/envs/add list=app name=PORT value=8080`;
		const out = redactExport(input);
		expect(out).not.toContain("hunter2");
		expect(out).not.toContain("s3cret");
		expect(out).not.toContain("abc123");
		expect(out).toContain("PORT value=8080");
		expect(out).toContain("10.0.0.1/24");
	});

	test("redacts secret values in inline /container/add env lists", () => {
		const input = `/container/add env="HTTP_PORT=3001,TUNNEL_TOKEN=eyJhsecret" name=app-cloudflare-tunnel`;
		const out = redactExport(input);
		expect(out).toContain("HTTP_PORT=3001");
		expect(out).not.toContain("eyJhsecret");
		expect(out).toContain("TUNNEL_TOKEN=[redacted]");
	});
});

describe("stableExportHeader", () => {
	test("drops datetime, keeps version", () => {
		const out = stableExportHeader(
			"# 2026-10-26 20:18:17 by RouterOS 7.26beta3\n# system id = X",
		);
		expect(out).toContain("# by RouterOS 7.26beta3");
		expect(out).not.toContain("20:18:17");
	});
});

describe("stripVolatile", () => {
	test("drops counters/timestamps, keeps config, recurses", () => {
		const input = {
			name: "ether1",
			uptime: "2d",
			"rx-byte": 123,
			nested: [{ address: "10.0.0.1/24", "last-seen": "never" }],
		};
		expect(stripVolatile(input)).toEqual({
			name: "ether1",
			nested: [{ address: "10.0.0.1/24" }],
		});
	});
});

describe("sha256Hex", () => {
	test("known vector", () => {
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("checkSerial", () => {
	const prev = {
		target: "t",
		serial: "AAA",
		capturedAt: "",
		tools: { centrs: "", quickchr: "" },
		files: [],
		status: "ok" as const,
		notes: [],
	};
	test("first capture proceeds", () => {
		expect(checkSerial(null, "AAA")).toBeNull();
	});
	test("matching serial proceeds", () => {
		expect(checkSerial(prev, "AAA")).toBeNull();
	});
	test("mismatch refuses with reason", () => {
		const r = checkSerial(prev, "BBB");
		expect(r).toContain("AAA");
		expect(r).toContain("BBB");
	});
});
