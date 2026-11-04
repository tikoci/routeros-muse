// T148 (D53): devices.toml, the generated text mirror of the CDB.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { cdbRowsToMirror } from "../src/lib/fleet";
import {
	MIRROR_FILE,
	MIRROR_MARKER,
	renderDevicesToml,
	writeDevicesMirror,
} from "../src/lib/mirror";
import { parseToml } from "../src/lib/toml";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(() => cleanupTmpdirs());

describe("cdbRowsToMirror", () => {
	test("keeps target, user, ports and webfig; never a secret column", () => {
		const rows = cdbRowsToMirror([
			{
				target: "office-gw",
				user: "admin",
				password: "pw-secret",
				pass: "pw-secret",
				secret: "pw-secret",
				comment: "www-port=8080; ssh-port=2222; ssh-key=AAAA-secret",
			},
			{ target: "__default__", user: "x" },
			{ target: "  " },
			{ target: "nouser" },
		]);
		expect(rows).toEqual([
			{
				id: "office-gw",
				user: "admin",
				ports: { "www-port": "8080", "ssh-port": "2222" },
				webfigUrl: "http://office-gw:8080/webfig/",
			},
			{ id: "nouser", ports: {}, webfigUrl: "http://nouser/webfig/" },
		]);
		expect(JSON.stringify(rows)).not.toContain("secret");
	});
});

describe("renderDevicesToml", () => {
	test("marker first, sorted devices, numeric ports, valid TOML", () => {
		const text = renderDevicesToml([
			{ id: "zeta", ports: {} },
			{
				id: "192.0.2.7",
				user: "admin",
				ports: { "www-port": "8080", "api-ssl-port": "8729" },
				webfigUrl: "http://192.0.2.7:8080/webfig/",
			},
		]);
		expect(text.split("\n")[0]).toBe(MIRROR_MARKER);
		const parsed = parseToml(text);
		if (!parsed.ok) throw new Error(parsed.error);
		expect(parsed.value["device"]).toEqual([
			{
				id: "192.0.2.7",
				user: "admin",
				"www-port": 8080,
				"api-ssl-port": 8729,
				webfig: "http://192.0.2.7:8080/webfig/",
			},
			{ id: "zeta" },
		]);
	});

	test("an empty CDB still renders a valid, marked file", () => {
		const text = renderDevicesToml([]);
		expect(text.startsWith(MIRROR_MARKER)).toBe(true);
		expect(text).toContain("no devices in the CDB yet");
		expect(parseToml(text).ok).toBe(true);
	});
});

describe("writeDevicesMirror", () => {
	const rows = [{ id: "gw", user: "admin", ports: {} }];

	test("writes when absent, skips when unchanged, rewrites on change", () => {
		const root = mktmp("t148-ws-");
		expect(writeDevicesMirror(root, rows)).toEqual({ written: true });
		const file = path.join(root, MIRROR_FILE);
		expect(nodeFs.readFileSync(file, "utf8")).toBe(renderDevicesToml(rows));
		expect(writeDevicesMirror(root, rows)).toEqual({ written: false });
		const more = [...rows, { id: "gw2", ports: {} }];
		expect(writeDevicesMirror(root, more)).toEqual({ written: true });
		expect(nodeFs.readFileSync(file, "utf8")).toContain('id = "gw2"');
	});

	test("never overwrites a devices.toml without the marker", () => {
		const root = mktmp("t148-ws-");
		const file = path.join(root, MIRROR_FILE);
		nodeFs.writeFileSync(file, "# mine\n[x]\ny = 1\n");
		const res = writeDevicesMirror(root, rows);
		expect(res.written).toBe(false);
		expect("why" in res && res.why).toContain("without the generated marker");
		expect(nodeFs.readFileSync(file, "utf8")).toBe("# mine\n[x]\ny = 1\n");
	});

	test("refuses a symlinked devices.toml and leaves its target alone", () => {
		const root = mktmp("t148-ws-");
		const outside = path.join(mktmp("t148-out-"), "victim.toml");
		nodeFs.writeFileSync(outside, `${MIRROR_MARKER}\n`);
		nodeFs.symlinkSync(outside, path.join(root, MIRROR_FILE));
		const res = writeDevicesMirror(root, rows);
		expect(res.written).toBe(false);
		expect(nodeFs.readFileSync(outside, "utf8")).toBe(`${MIRROR_MARKER}\n`);
	});
});
