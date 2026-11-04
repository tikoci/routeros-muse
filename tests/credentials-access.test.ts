import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanCredentialAttributes,
	credentialAttributes,
	credentialSnapshot,
	projectCdbEntry,
	setCdbCredentials,
	showCdbDevice,
} from "../src/lib/fleet";

describe("Access record fields", () => {
	test("comment tokens preserve quoting and last-wins semantics", () => {
		expect(
			credentialAttributes(
				'identity=old identity="edge router" "identity=inert" source=mndp ssh-key="/tmp/my key"',
			),
		).toEqual({
			identity: "edge router",
			source: "mndp",
			"ssh-key": "/tmp/my key",
		});
	});
	test("attribute validation rejects unknown keys, bad enums and numeric bounds", () => {
		for (const attributes of [
			{ note: "x" },
			{ via: "ssh-api" },
			{ validate: "yes" },
			{ mcp: "admin" },
			{ lat: "90.1" },
			{ lon: "-181" },
			{ timeout: "0" },
			{ timeout: "2147483648" },
			{ port: "65536" },
			{ altitude: "NaN" },
			{ source: "x;password=x" },
		])
			expect(cleanCredentialAttributes(attributes)).toBeNull();
		expect(
			cleanCredentialAttributes({
				lat: "-90",
				lon: "180",
				timeout: "1",
				port: "65535",
				mcp: "rw",
				"altitude-type": "AGL",
				identity: "",
			}),
		).not.toBeNull();
	});
	test("every projected attribute participates in the conflict snapshot", () => {
		const base = projectCdbEntry({
			target: "192.0.2.10",
			comment: "identity=edge via=ssh",
			recordType: 6,
			recordTypeName: "ipUser",
		});
		if (!base) throw new Error("projection failed");
		for (const key of [
			"identity",
			"mac",
			"ip",
			"via",
			"validate",
			"insecure",
			"timeout",
			"port",
			"source",
			"mcp",
			"lat",
			"lon",
			"altitude",
			"altitude-type",
		])
			expect(
				credentialSnapshot({
					...base,
					attributes: { ...base.attributes, [key]: "changed" },
				}),
			).not.toBe(credentialSnapshot(base));
		expect(credentialSnapshot({ ...base, comment: "changed" })).not.toBe(
			credentialSnapshot(base),
		);
		expect(credentialSnapshot({ ...base, recordType: 5 })).not.toBe(
			credentialSnapshot(base),
		);
	});
	test("bundled CDB roundtrip writes all attributes and clears kv tokens", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "access-record-"));
		const cdb = path.join(dir, "device.cdb");
		const env = {
			...process.env,
			PATH: `${path.resolve("node_modules/.bin")}:${process.env["PATH"]}`,
			CENTRS_SKIP_ENV_FILE: "1",
		} as Record<string, string>;
		try {
			const init = Bun.spawnSync(
				["centrs", "devices", "init", "--cdb-file", cdb],
				{ env },
			);
			expect(init.exitCode).toBe(0);
			const write = {
				user: "probe",
				group: "lab",
				profile: "work",
				session: "session",
				recordTypeName: "ipUser",
				comment: "fixture",
				sshKey: "/tmp/my key",
				attributes: {
					identity: "edge",
					mac: "02:00:00:00:00:01",
					ip: "192.0.2.10",
					via: "ssh",
					validate: "false",
					insecure: "false",
					timeout: "5000",
					port: "2222",
					source: "mndp",
					mcp: "ro",
					lat: "1",
					lon: "2",
					altitude: "3",
					"altitude-type": "AGL",
				},
				ports: { "www-port": "8080" },
			};
			const added = await setCdbCredentials(cdb, "192.0.2.10", write, env, {
				missing: true,
			});
			expect(added.ok).toBe(true);
			if (!added.ok) throw new Error(added.why);
			expect(added.details).toMatchObject({
				user: "probe",
				group: "lab",
				profile: "work",
				session: "session",
				recordTypeName: "ipUser",
				sshKey: "/tmp/my key",
				attributes: write.attributes,
			});
			const cleared = await setCdbCredentials(
				cdb,
				"192.0.2.10",
				{
					sshKey: "",
					attributes: { identity: "", port: "" },
					ports: { "www-port": "" },
				},
				env,
				added.details,
			);
			expect(cleared.ok).toBe(true);
			const seen = await showCdbDevice(cdb, "192.0.2.10", env);
			expect(seen.ok).toBe(true);
			if (!seen.ok) throw new Error(seen.why);
			expect(seen.details.sshKey).toBe("");
			expect(seen.details.attributes?.["identity"]).toBe("");
			expect(seen.details.ports).toEqual({});
			expect(
				(
					await setCdbCredentials(
						cdb,
						"192.0.2.10",
						{ group: "" },
						env,
						seen.details,
					)
				).ok,
			).toBe(false);
			expect(
				(
					await setCdbCredentials(
						cdb,
						"192.0.2.10",
						{ attributes: { evil: "x" } },
						env,
						seen.details,
					)
				).ok,
			).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 30000);
});
