// Device pane + status poll projections, anchored on real wire captures
// (tests/fixtures/device-stats: centrs 0.1.9 `retrieve --format json`
// against a disposable CHR 7.25.1 x86 under quickchr; envelopes cut to
// ok/data/error/warnings/tips, meta dropped). The fixtures were read
// with the same --attributes sets the server requests.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	ADDRESS_ATTRIBUTES,
	centrsRetrieveArgs,
	INTERFACE_ATTRIBUTES,
	LOG_ATTRIBUTES,
	projectInterfaces,
	projectLog,
	projectStatus,
	projectSystem,
	type Read,
	STATUS_ATTRIBUTES,
} from "../src/lib/fleet";
import {
	DEVICE_POLL_DEFAULT,
	readDevicePollSeconds,
	settingsFile,
	writeDevicePollSeconds,
} from "../src/lib/settings";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

const FIX = path.join(import.meta.dir, "fixtures", "device-stats");
type Envelope = {
	ok: boolean;
	data?: unknown;
	error?: { code: string; summary: string };
};
const env = (name: string): Envelope =>
	JSON.parse(nodeFs.readFileSync(path.join(FIX, `${name}.json`), "utf8"));
const asRead = (e: Envelope): Read<unknown> =>
	e.ok
		? { ok: true, data: e.data }
		: { ok: false, why: e.error?.summary ?? "", code: e.error?.code };

describe("wire facts the projections rely on", () => {
	test("REST answers every resource scalar as a string", () => {
		const r = env("resource").data as Record<string, unknown>;
		expect(r["cpu-load"]).toBeTypeOf("string");
		expect(r["total-memory"]).toBeTypeOf("string");
		expect(r["cpu-count"]).toBe("1");
	});
	test("CHR has no /system/routerboard: centrs validation/unknown-path", () => {
		const rb = env("routerboard-chr");
		expect(rb.ok).toBe(false);
		expect(rb.error?.code).toBe("validation/unknown-path");
	});
	test("a refused port is a transport/connection-refused envelope", () => {
		expect(env("resource-refused").error?.code).toBe(
			"transport/connection-refused",
		);
	});
	test("log topics are one comma list mixing facility and severity", () => {
		const rows = env("log").data as { topics: string }[];
		expect(rows.some((r) => r.topics === "system,error,critical")).toBe(true);
		expect(rows.some((r) => r.topics === "script,warning")).toBe(true);
	});
});

describe("projectSystem", () => {
	test("CHR: board-name stands in, routerboard absent, numbers parsed", () => {
		const sys = projectSystem(
			env("resource").data,
			asRead(env("identity")),
			asRead(env("routerboard-chr")),
		);
		expect(sys).toEqual({
			identity: "CHR",
			model: null,
			boardName: "CHR QEMU Standard PC (i440FX + PIIX, 1996)",
			routerboard: "absent",
			architecture: "x86_64",
			version: "7.25.1",
			uptime: sys.uptime,
			cpuCount: 1,
			cpuLoad: sys.cpuLoad,
			memFree: sys.memFree,
			memTotal: 536870912,
			diskFree: sys.diskFree,
			diskTotal: 93564928,
		});
		expect(sys.uptime).toMatch(/^[0-9wdhms]+$/);
		expect(typeof sys.cpuLoad).toBe("number");
		expect(sys.memFree).toBeLessThan(sys.memTotal as number);
		expect(sys.diskFree).toBeLessThan(sys.diskTotal as number);
	});
	test("a routerboard read supplies the model; a failed one is unread", () => {
		const res = env("resource").data;
		const rb = projectSystem(res, null, {
			ok: true,
			data: { model: "RB5009UG+S+" },
		});
		expect(rb.model).toBe("RB5009UG+S+");
		expect(rb.routerboard).toBe("present");
		expect(rb.identity).toBeNull();
		const down = projectSystem(res, null, {
			ok: false,
			why: "x",
			code: "transport/timeout",
		});
		expect(down.routerboard).toBe("unread");
		expect(down.model).toBeNull();
	});
});

describe("projectInterfaces", () => {
	const rows = projectInterfaces(
		env("interface").data,
		env("ip-address").data,
		env("ipv6-address").data,
	);
	test("one row per interface, in RouterOS order", () => {
		expect(rows.map((r) => r.name)).toEqual([
			"ether1",
			"br-lab",
			"br-mgmt",
			"lo",
		]);
	});
	test("state, MAC and counters come through typed", () => {
		const [ether1, brLab, , lo] = rows;
		expect(ether1?.running).toBe(true);
		expect(ether1?.disabled).toBe(false);
		expect(ether1?.mac).toBe("02:34:A0:16:2C:D2");
		expect(typeof ether1?.rxBytes).toBe("number");
		expect(brLab?.disabled).toBe(true);
		expect(brLab?.running).toBe(false);
		expect(brLab?.rxBytes).toBe(0);
		expect(lo?.mac).toBeNull();
	});
	test("addresses join by interface; link-local IPv6 is dropped", () => {
		const by = Object.fromEntries(
			rows.map((r) => [r.name, r.addresses.map((a) => a.address)]),
		);
		expect(by).toEqual({
			ether1: ["10.0.2.15/24"],
			"br-lab": [],
			"br-mgmt": ["192.168.88.1/24", "fd00:88::1/64"],
			lo: ["::1/128"],
		});
		expect(rows[2]?.addresses.map((a) => a.family)).toEqual([4, 6]);
	});
	test("a failed address read leaves the rows without addresses", () => {
		const bare = projectInterfaces(env("interface").data, null, null);
		expect(bare).toHaveLength(4);
		expect(bare.every((r) => r.addresses.length === 0)).toBe(true);
	});
});

describe("projectLog", () => {
	const log = projectLog(env("log").data);
	const rows = env("log").data as { topics: string; message: string }[];
	test("total is the buffer read", () => {
		expect(log.total).toBe(rows.length);
	});
	test("problems: the last ten error/warning/critical entries, newest first", () => {
		const wanted = rows
			.filter((r) => /(^|,)(error|warning|critical)(,|$)/.test(r.topics))
			.slice(-10)
			.reverse()
			.map((r) => r.message);
		expect(log.problems.map((p) => p.message)).toEqual(wanted);
		expect(log.problems).toHaveLength(10);
		expect(log.problems.map((p) => p.message)).toContain(
			"muse-stats: synthetic warning for capture",
		);
	});
	test("severities count apart from facility topics", () => {
		const sev = Object.fromEntries(
			log.severities.map((s) => [s.topic, s.count]),
		);
		const count = (t: string) =>
			rows.filter((r) => r.topics.split(",").includes(t)).length;
		expect(sev).toEqual({
			critical: count("critical"),
			error: count("error"),
			warning: count("warning"),
			info: count("info"),
		});
		expect(log.topics.map((t) => t.topic)).not.toContain("error");
		expect(log.topics[0]?.topic).toBe("system");
		const counts = log.topics.map((t) => t.count);
		expect(counts).toEqual([...counts].sort((a, b) => b - a));
	});
	test("empty buffer and a custom limit", () => {
		expect(projectLog([])).toEqual({
			total: 0,
			problems: [],
			severities: [],
			topics: [],
		});
		expect(projectLog(env("log").data, 3).problems).toHaveLength(3);
	});
});

describe("status poll", () => {
	test("projectStatus reads the three polled attributes", () => {
		const s = projectStatus(env("resource").data);
		expect(s.version).toBe("7.25.1");
		expect(typeof s.cpuLoad).toBe("number");
		expect(s.uptime).not.toBeNull();
		expect(projectStatus({})).toEqual({
			uptime: null,
			cpuLoad: null,
			version: null,
		});
	});
	test("retrieve argv carries the attribute set and timeout", () => {
		expect(
			centrsRetrieveArgs({ cdb: "gw" }, "/system/resource", "/w/device.cdb", {
				attributes: STATUS_ATTRIBUTES,
				timeout: "5s",
			}),
		).toEqual([
			"retrieve",
			"gw",
			"/system/resource",
			"--format",
			"json",
			"--timeout",
			"5s",
			"--attributes",
			"uptime,cpu-load,version",
			"--cdb-file",
			"/w/device.cdb",
		]);
		// The pre-existing default stays: 10s, no projection.
		expect(centrsRetrieveArgs({ cdb: "gw" }, "/log", null)).toEqual([
			"retrieve",
			"gw",
			"/log",
			"--format",
			"json",
			"--timeout",
			"10s",
		]);
	});
	test("the attribute sets are the ones the fixtures were read with", () => {
		const keys = (name: string) =>
			[
				...new Set(
					(env(name).data as Record<string, unknown>[]).flatMap(Object.keys),
				),
			].sort();
		expect(keys("interface")).toEqual([...INTERFACE_ATTRIBUTES].sort());
		expect(keys("ip-address")).toEqual([...ADDRESS_ATTRIBUTES].sort());
		expect(keys("log")).toEqual([...LOG_ATTRIBUTES].sort());
	});
});

describe("poll interval setting", () => {
	test("defaults to 30s, stores [devices] status_poll_seconds", () => {
		const dh = mktmp("dev-poll-dh-");
		expect(readDevicePollSeconds(dh)).toBe(DEVICE_POLL_DEFAULT);
		expect(DEVICE_POLL_DEFAULT).toBe(30);
		writeDevicePollSeconds(dh, 0);
		expect(readDevicePollSeconds(dh)).toBe(0);
		writeDevicePollSeconds(dh, 60);
		expect(readDevicePollSeconds(dh)).toBe(60);
		expect(nodeFs.readFileSync(settingsFile(dh), "utf8")).toBe(
			"[devices]\nstatus_poll_seconds = 60\n",
		);
	});
	test("lives beside [agent] keys without disturbing them", () => {
		const dh = mktmp("dev-poll-dh-");
		nodeFs.mkdirSync(path.dirname(settingsFile(dh)), { recursive: true });
		nodeFs.writeFileSync(
			settingsFile(dh),
			'# mine\n[agent]\ndefault_access = "allowAll"\n',
		);
		writeDevicePollSeconds(dh, 15);
		expect(nodeFs.readFileSync(settingsFile(dh), "utf8")).toBe(
			'# mine\n[agent]\ndefault_access = "allowAll"\n\n[devices]\nstatus_poll_seconds = 15\n',
		);
		expect(readDevicePollSeconds(dh)).toBe(15);
	});
	test("an off-step value reads as the default", () => {
		const dh = mktmp("dev-poll-dh-");
		nodeFs.mkdirSync(path.dirname(settingsFile(dh)), { recursive: true });
		nodeFs.writeFileSync(
			settingsFile(dh),
			"[devices]\nstatus_poll_seconds = 7\n",
		);
		expect(readDevicePollSeconds(dh)).toBe(DEVICE_POLL_DEFAULT);
	});
});
