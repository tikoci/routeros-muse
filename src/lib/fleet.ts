// Fleet module (T40): device inventory, live stats, and twins —
// UI-agnostic reads over the centrs CDB (D53: the only device list). Serve
// routes stay thin wrappers; the CLI wraps the same functions (one
// implementation, D30: centrs owns RouterOS semantics, we own the
// runtime around it). Passwords travel via the caller's env
// (CENTRS_CDB_PASSWORD), never argv.
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { have, run } from "./run";
import { parseToml } from "./toml";

export type Device = {
	id: string;
	label?: string;
	site?: string;
	role?: string;
	host?: string;
	/** RouterBoard model (router.toml only): feeds the context line. */
	model?: string;
	/** D23: centrs device handle this device links to (source of truth). */
	cdb?: string;
	/** Login user: the device's own key, or the CDB record's user (T64). */
	user?: string;
	/**
	 * T48: whether the linked CDB record carries a saved password.
	 * Present only when a `devices show` probe answered (absent =
	 * unknown: unlinked device, unprobed store, or probe failure).
	 */
	hasPassword?: boolean;
};

export function readDevices(root: string): Device[] {
	const file = path.join(root, "router.toml");
	let text: string;
	try {
		text = nodeFs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const parsed = parseToml(text);
	if (!parsed.ok) return [];
	const v = parsed.value;
	const out: Device[] = [];
	const push = (s: unknown) => {
		if (
			s &&
			typeof s === "object" &&
			typeof (s as Record<string, unknown>)["id"] === "string"
		) {
			const r = s as Record<string, unknown>;
			out.push({
				id: r["id"] as string,
				label: typeof r["label"] === "string" ? r["label"] : undefined,
				site: typeof r["site"] === "string" ? r["site"] : undefined,
				role: typeof r["role"] === "string" ? r["role"] : undefined,
				host: typeof r["host"] === "string" ? r["host"] : undefined,
				model: typeof r["model"] === "string" ? r["model"] : undefined,
				cdb:
					typeof r["cdb"] === "string" && r["cdb"].trim()
						? r["cdb"].trim()
						: undefined,
				user:
					typeof r["user"] === "string" && r["user"].trim()
						? r["user"].trim()
						: undefined,
			});
		}
	};
	if (Array.isArray(v["device"])) v["device"].forEach(push);
	else if (v["device"]) push(v["device"]);
	if (Array.isArray(v["devices"])) v["devices"].forEach(push);
	return out;
}

/** Per-read knobs: a projected attribute set and the per-request timeout. */
export type RetrieveOpts = { attributes?: string[]; timeout?: string };

/**
 * centrs retrieve argv for a device (T38, D23): the cdb link wins, the
 * legacy host is break-glass, neither is null (caller stays honest).
 * cdbFile points centrs at the workspace device.cdb when it ships one.
 */
export function centrsRetrieveArgs(
	device: Pick<Device, "cdb" | "host">,
	rosPath: string,
	cdbFile: string | null,
	opts?: RetrieveOpts,
): string[] | null {
	const tail = ["--format", "json", "--timeout", opts?.timeout ?? "10s"];
	if (opts?.attributes?.length)
		tail.push("--attributes", opts.attributes.join(","));
	if (cdbFile) tail.push("--cdb-file", cdbFile);
	if (device.cdb) return ["retrieve", device.cdb, rosPath, ...tail];
	if (device.host) return ["retrieve", "--host", device.host, rosPath, ...tail];
	return null;
}

/** One-line why from a centrs failure envelope (code + summary, capped). */
export function centrsWhy(parsed: unknown): string {
	const err = (parsed as Record<string, unknown> | null)?.["error"] as
		| Record<string, unknown>
		| undefined;
	const code =
		typeof err?.["code"] === "string" ? (err["code"] as string) : null;
	const summary =
		typeof err?.["summary"] === "string" ? (err["summary"] as string) : null;
	const line = [code, summary].filter(Boolean).join(": ");
	if (!line) return "device unreachable (see centrs output)";
	return line.length > 220 ? `${line.slice(0, 220)}…` : line;
}

/** centrs prints success envelopes to stdout, failure envelopes to stderr. */
function centrsOut(r: { stdout: string; stderr: string }): string {
	return r.stdout.trim() ? r.stdout : r.stderr;
}

/** Machine code from a failure envelope, for branch-on-code callers. */
export function centrsCode(parsed: unknown): string | null {
	const err = (parsed as Record<string, unknown> | null)?.["error"] as
		| Record<string, unknown>
		| undefined;
	return typeof err?.["code"] === "string" ? (err["code"] as string) : null;
}

export type CdbListResult =
	| { ok: true; devices: Device[] }
	| { ok: false; why: string };

/**
 * CDB list rows to device cards. The reserved __default__ record is a
 * credential fallback, not a target (T9; MCP never allowlists it), so
 * it is filtered from the inventory like everywhere else. The mapping
 * preserves (target, user) and nothing else.
 *
 * Defense-in-depth redaction guard (T64, C13): centrs#551 shipped
 * in 0.1.9 (show/mutation envelopes withhold passwords by default),
 * and this projection keeps us independent of that — no handler
 * forwards raw record envelopes to UI/chat/logs; it allowlists
 * id/cdb/user and drops everything else.
 */
export function cdbRowsToDevices(data: unknown): Device[] {
	const rows = Array.isArray(data)
		? data
		: data && typeof data === "object"
			? [data]
			: [];
	const devices: Device[] = [];
	for (const row of rows) {
		const rec = row as Record<string, unknown>;
		const t = rec["target"];
		if (typeof t === "string" && t.trim() && t.trim() !== "__default__") {
			const device: Device = { id: t.trim(), cdb: t.trim() };
			const u = rec["user"];
			if (typeof u === "string" && u.trim()) device.user = u.trim();
			devices.push(device);
		}
	}
	return devices;
}

/**
 * No-workspace device inventory: the centrs CDB is the whole registry.
 * passwords=true probes each row for a saved password (T48 inventory
 * affordance); device lookups (deviceStats) leave it off — they need the
 * link, not the presence bit, and skip the N extra spawns.
 */
export async function listCdbDevices(
	cdbFile?: string,
	env?: Record<string, string>,
	passwords = false,
): Promise<CdbListResult> {
	if (!have("centrs", env)) return { ok: false, why: "centrs not on PATH" };
	const args = ["devices", "list", "--format", "json"];
	if (cdbFile) args.push("--cdb-file", cdbFile);
	const r = await run(["centrs", ...args], { timeoutMs: 30_000, env });
	try {
		const parsed = JSON.parse(centrsOut(r)) as Record<string, unknown>;
		if (parsed["ok"] !== true) return { ok: false, why: centrsWhy(parsed) };
		const devices = cdbRowsToDevices(parsed["data"]);
		if (passwords && env) {
			const marks = await probeHasPassword(
				cdbFile ?? null,
				devices.map((d) => d.cdb),
				env,
			);
			devices.forEach((d, i) => {
				if (marks[i] !== undefined) d.hasPassword = marks[i];
			});
		}
		return { ok: true, devices };
	} catch {
		return { ok: false, why: "centrs devices output unreadable" };
	}
}

export type DevicesResult = {
	devices: Device[];
	source: "cdb";
	why?: string;
};

/**
 * Device inventory for serve + CLI (D53): the centrs CDB is the only
 * device list in every mode — the bound workspace device.cdb, or the
 * ambient store in no-workspace mode. Rows carry the saved-password
 * presence bit (T48). router.toml is no longer read for devices.
 */
export async function listDevices(
	cdbFile: string | null,
	env: Record<string, string>,
): Promise<DevicesResult> {
	const listed = await listCdbDevices(cdbFile ?? undefined, env, true);
	if (!listed.ok) return { devices: [], source: "cdb", why: listed.why };
	return { devices: listed.devices, source: "cdb" };
}

export type StatsResult = { status: number; body: unknown };

/**
 * One device read: data on success, a short why (+ centrs code) on
 * failure. Pane sections carry these so one failed read degrades only
 * its own section.
 */
export type Read<T> =
	| { ok: true; data: T }
	| { ok: false; why: string; code?: string };

/**
 * One centrs retrieve, parsed. The run deadline sits above centrs' own
 * per-request --timeout so centrs reports its own timeout envelope;
 * the kill is the backstop for a hung spawn.
 */
async function retrieve(
	device: Pick<Device, "cdb" | "host">,
	rosPath: string,
	cdbFile: string | null,
	env: Record<string, string>,
	opts: RetrieveOpts & { deadlineMs: number },
): Promise<Read<unknown>> {
	const args = centrsRetrieveArgs(device, rosPath, cdbFile, opts);
	if (!args) return { ok: false, why: "device has no cdb link nor host" };
	const r = await run(["centrs", ...args], {
		timeoutMs: opts.deadlineMs,
		env,
	});
	if (r.timedOut)
		return {
			ok: false,
			why: `no answer within ${Math.round(opts.deadlineMs / 1000)}s`,
			code: "muse/deadline",
		};
	try {
		const parsed = JSON.parse(centrsOut(r)) as Record<string, unknown>;
		if (parsed["ok"] !== true) {
			const code = centrsCode(parsed);
			return {
				ok: false,
				why: centrsWhy(parsed),
				...(code ? { code } : {}),
			};
		}
		return { ok: true, data: parsed["data"] };
	} catch {
		return { ok: false, why: "centrs output unreadable" };
	}
}

/** REST answers every scalar as a string ("2", "true"): read them back. */
function num(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v !== "string" || !/^-?[0-9]+(\.[0-9]+)?$/.test(v)) return null;
	return Number(v);
}
function bool(v: unknown): boolean {
	return v === true || v === "true";
}
function str(v: unknown): string | null {
	return typeof v === "string" && v !== "" ? v : null;
}
function rec(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}
function rows(v: unknown): Record<string, unknown>[] {
	if (Array.isArray(v)) return v.map(rec);
	return v && typeof v === "object" ? [rec(v)] : [];
}

/** The status poll's one-line summary (projection of /system/resource). */
export type DeviceStatus = {
	uptime: string | null;
	cpuLoad: number | null;
	version: string | null;
};

export const STATUS_ATTRIBUTES = ["uptime", "cpu-load", "version"];

export function projectStatus(resource: unknown): DeviceStatus {
	const r = rec(resource);
	return {
		uptime: str(r["uptime"]),
		cpuLoad: num(r["cpu-load"]),
		version: str(r["version"]),
	};
}

export type DeviceSystem = {
	identity: string | null;
	/** /system/routerboard model; null on CHR/x86 (no such menu). */
	model: string | null;
	boardName: string | null;
	/** present = routerboard read; absent = no menu (CHR/x86); unread = failed. */
	routerboard: "present" | "absent" | "unread";
	architecture: string | null;
	version: string | null;
	uptime: string | null;
	cpuCount: number | null;
	cpuLoad: number | null;
	memFree: number | null;
	memTotal: number | null;
	diskFree: number | null;
	diskTotal: number | null;
};

/**
 * Wire facts (CHR 7.25.1 capture, tests/fixtures/device-stats): every
 * resource value is a string; CHR answers /system/routerboard with
 * centrs `validation/unknown-path` (the menu does not exist), which is
 * "absent", not a failure.
 */
export function projectSystem(
	resource: unknown,
	identity: Read<unknown> | null,
	routerboard: Read<unknown> | null,
): DeviceSystem {
	const r = rec(resource);
	const rbState: DeviceSystem["routerboard"] = !routerboard
		? "unread"
		: routerboard.ok
			? "present"
			: routerboard.code === "validation/unknown-path"
				? "absent"
				: "unread";
	return {
		identity: identity?.ok ? str(rec(identity.data)["name"]) : null,
		model:
			routerboard?.ok === true ? str(rec(routerboard.data)["model"]) : null,
		boardName: str(r["board-name"]),
		routerboard: rbState,
		architecture: str(r["architecture-name"]),
		version: str(r["version"]),
		uptime: str(r["uptime"]),
		cpuCount: num(r["cpu-count"]),
		cpuLoad: num(r["cpu-load"]),
		memFree: num(r["free-memory"]),
		memTotal: num(r["total-memory"]),
		diskFree: num(r["free-hdd-space"]),
		diskTotal: num(r["total-hdd-space"]),
	};
}

export type DeviceAddress = {
	address: string;
	family: 4 | 6;
	disabled: boolean;
	invalid: boolean;
};

export type DeviceInterface = {
	name: string;
	type: string | null;
	running: boolean;
	disabled: boolean;
	/** null for the all-zero MAC (loopback) and MAC-less types. */
	mac: string | null;
	addresses: DeviceAddress[];
	rxBytes: number | null;
	txBytes: number | null;
};

export const INTERFACE_ATTRIBUTES = [
	"name",
	"type",
	"running",
	"disabled",
	"mac-address",
	"rx-byte",
	"tx-byte",
];
export const ADDRESS_ATTRIBUTES = [
	"address",
	"interface",
	"disabled",
	"invalid",
];

/** fe80::/10 — every IPv6 interface has one; noise in a compact table. */
function linkLocal6(address: string): boolean {
	return /^fe[89ab][0-9a-f]?:/i.test(address);
}

/**
 * /interface rows joined with /ip/address and /ipv6/address by
 * interface name. Either address list may be null (its read failed):
 * the rows still render, without those addresses.
 */
export function projectInterfaces(
	interfaces: unknown,
	ipv4: unknown,
	ipv6: unknown,
): DeviceInterface[] {
	const byIf = new Map<string, DeviceAddress[]>();
	const add = (list: unknown, family: 4 | 6) => {
		for (const a of rows(list)) {
			const address = str(a["address"]);
			const iface = str(a["interface"]);
			if (!address || !iface) continue;
			if (family === 6 && linkLocal6(address)) continue;
			const list2 = byIf.get(iface) ?? [];
			list2.push({
				address,
				family,
				disabled: bool(a["disabled"]),
				invalid: bool(a["invalid"]),
			});
			byIf.set(iface, list2);
		}
	};
	add(ipv4, 4);
	add(ipv6, 6);
	const out: DeviceInterface[] = [];
	for (const i of rows(interfaces)) {
		const name = str(i["name"]);
		if (!name) continue;
		const mac = str(i["mac-address"]);
		out.push({
			name,
			type: str(i["type"]),
			running: bool(i["running"]),
			disabled: bool(i["disabled"]),
			mac: mac && !/^(00:){5}00$/.test(mac) ? mac : null,
			addresses: byIf.get(name) ?? [],
			rxBytes: num(i["rx-byte"]),
			txBytes: num(i["tx-byte"]),
		});
	}
	return out;
}

export type LogEntry = { time: string; topics: string[]; message: string };
export type DeviceLog = {
	/** Entries in the buffer read. */
	total: number;
	/** Last N error/warning/critical entries, newest first. */
	problems: LogEntry[];
	/** Count per severity topic present in the buffer. */
	severities: { topic: string; count: number }[];
	/** Count per facility topic (system, dhcp, …), most first. */
	topics: { topic: string; count: number }[];
};

export const LOG_ATTRIBUTES = ["time", "topics", "message"];
const SEVERITIES = ["critical", "error", "warning", "info", "debug"];
const PROBLEM = new Set(["critical", "error", "warning"]);

/**
 * /log (oldest first, as RouterOS answers) to the pane's log section.
 * topics is RouterOS' comma list ("system,error,critical"): severity
 * words count apart from facility words.
 */
export function projectLog(entries: unknown, limit = 10): DeviceLog {
	const all = rows(entries).map((e) => ({
		time: str(e["time"]) ?? "",
		topics: (str(e["topics"]) ?? "").split(",").filter(Boolean),
		message: str(e["message"]) ?? "",
	}));
	const sev = new Map<string, number>();
	const fac = new Map<string, number>();
	for (const e of all) {
		for (const t of e.topics) {
			const m = SEVERITIES.includes(t) ? sev : fac;
			m.set(t, (m.get(t) ?? 0) + 1);
		}
	}
	const problems = all
		.filter((e) => e.topics.some((t) => PROBLEM.has(t)))
		.slice(-limit)
		.reverse();
	return {
		total: all.length,
		problems,
		severities: SEVERITIES.filter((t) => sev.has(t)).map((topic) => ({
			topic,
			count: sev.get(topic) as number,
		})),
		topics: [...fac.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([topic, count]) => ({ topic, count })),
	};
}

export type DeviceDetails = {
	system: Read<DeviceSystem>;
	interfaces: Read<{ rows: DeviceInterface[]; addressWhy?: string }>;
	log: Read<DeviceLog>;
};

/** Each pane read's own deadline (centrs --timeout, then the kill). */
const DETAIL_READ = { timeout: "8s", deadlineMs: 15_000 } as const;
const STATUS_READ = { timeout: "5s", deadlineMs: 10_000 } as const;

type Lookup =
	| { ok: true; device: Device }
	| { ok: false; status: number; why: string };

/** The device as the CDB lists it (D53), linked, with centrs present. */
async function lookupDevice(
	id: string,
	cdbFile: string | null,
	env: Record<string, string>,
): Promise<Lookup> {
	const listed = await listCdbDevices(cdbFile ?? undefined, env);
	if (!listed.ok) return { ok: false, status: 200, why: listed.why };
	const device = listed.devices.find((s) => s.id === id);
	if (!device) return { ok: false, status: 404, why: `no device ${id}` };
	if (!centrsRetrieveArgs(device, "/system/resource", cdbFile))
		return {
			ok: false,
			status: 200,
			why: `device ${id} has no cdb link nor host yet (add cdb = "<centrs-device>" to its [device])`,
		};
	return { ok: true, device };
}

/**
 * The device pane (first open + Refresh, never polled): system,
 * interfaces and log, gathered as seven independent reads in
 * parallel. A failed read degrades its own section; only when every
 * section failed is the whole answer ok:false (the device is
 * unreachable, and the why says how).
 */
export async function deviceStats(
	id: string,
	cdbFile: string | null,
	env: Record<string, string>,
): Promise<StatsResult> {
	if (!have("centrs", env))
		return { status: 200, body: { ok: false, why: "centrs not on PATH" } };
	const found = await lookupDevice(id, cdbFile, env);
	if (!found.ok)
		return { status: found.status, body: { ok: false, why: found.why } };
	const read = (rosPath: string, attributes?: string[]) =>
		retrieve(found.device, rosPath, cdbFile, env, {
			...DETAIL_READ,
			...(attributes ? { attributes } : {}),
		});
	const [res, ident, rb, ifs, v4, v6, log] = await Promise.all([
		read("/system/resource"),
		read("/system/identity"),
		// model only: the routerboard menu also carries the serial (D1).
		read("/system/routerboard", ["model"]),
		read("/interface", INTERFACE_ATTRIBUTES),
		read("/ip/address", ADDRESS_ATTRIBUTES),
		read("/ipv6/address", ADDRESS_ATTRIBUTES),
		read("/log", LOG_ATTRIBUTES),
	]);
	const addressWhy = [
		v4.ok ? null : `IPv4 addresses: ${v4.why}`,
		v6.ok ? null : `IPv6 addresses: ${v6.why}`,
	]
		.filter(Boolean)
		.join(" · ");
	const details: DeviceDetails = {
		system: res.ok
			? { ok: true, data: projectSystem(res.data, ident, rb) }
			: res,
		interfaces: ifs.ok
			? {
					ok: true,
					data: {
						rows: projectInterfaces(
							ifs.data,
							v4.ok ? v4.data : null,
							v6.ok ? v6.data : null,
						),
						...(addressWhy ? { addressWhy } : {}),
					},
				}
			: ifs,
		log: log.ok ? { ok: true, data: projectLog(log.data) } : log,
	};
	if (!res.ok && !ifs.ok && !log.ok)
		return { status: 200, body: { ok: false, why: res.why, ...details } };
	return { status: 200, body: { ok: true, ...details } };
}

/**
 * The status poll's one read: /system/resource, three attributes.
 * The caller vouches for the id (D53: the id is the CDB target, and
 * serve checks it against the list the UI last loaded), so a poll
 * tick costs one centrs spawn per device, not a list + a read.
 */
export async function deviceStatus(
	id: string,
	cdbFile: string | null,
	env: Record<string, string>,
): Promise<Read<DeviceStatus>> {
	if (!have("centrs", env)) return { ok: false, why: "centrs not on PATH" };
	const r = await retrieve({ cdb: id }, "/system/resource", cdbFile, env, {
		...STATUS_READ,
		attributes: STATUS_ATTRIBUTES,
	});
	return r.ok ? { ok: true, data: projectStatus(r.data) } : r;
}

export type TwinsResult =
	| { available: true; twins: unknown[] }
	| { available: false; why: string };

export async function listTwins(
	env: Record<string, string>,
): Promise<TwinsResult> {
	if (!have("quickchr", env))
		return { available: false, why: "quickchr not on PATH" };
	const l = await run(["quickchr", "list", "--json"], {
		timeoutMs: 30_000,
		env,
	});
	try {
		const list = JSON.parse(l.stdout) as unknown[];
		return { available: true, twins: list };
	} catch {
		return { available: false, why: "quickchr list unreadable" };
	}
}

export type TwinsDoctorResult =
	| { ok: boolean; checks: unknown }
	| { ok: false; why: string };

export async function doctorTwins(
	env: Record<string, string>,
): Promise<TwinsDoctorResult> {
	if (!have("quickchr", env)) return { ok: false, why: "quickchr not on PATH" };
	const d = await run(["quickchr", "doctor", "--json"], {
		timeoutMs: 60_000,
		env,
	});
	try {
		const doc = JSON.parse(d.stdout) as Record<string, unknown>;
		return {
			ok: doc["ok"] === true,
			checks: doc["checks"] ?? [],
		};
	} catch {
		return { ok: false, why: "quickchr doctor unreadable" };
	}
}

/**
 * Redaction-aware projection of one CDB record (T48). Extends the T64
 * guard above: no caller forwards a raw entry — this shape carries
 * the context a credentials
 * modal needs (target, user, handles, ssh-key path, whether a password
 * is saved) and drops the password itself. Fixed key order doubles as
 * the canonical snapshot for the C15 interim conflict check below.
 */
export type CdbCredentialDetails = {
	target: string;
	/** Per-service port overrides from the comment kv-soup (centrs#618). */
	ports?: Record<string, string>;
	user: string;
	group: string;
	recordTypeName: string;
	session: string;
	profile: string;
	hasPassword: boolean;
	sshKey: string;
};

const strField = (rec: Record<string, unknown>, key: string): string => {
	const v = rec[key];
	return typeof v === "string" ? v : "";
};

/**
 * ssh-key path out of the comment kv-soup (commentMirror mirrors the
 * comment; either may carry it). Separator-tolerant: matches the
 * `ssh-key=<path>` pair wherever it sits. "" when the record has none.
 */
export function sshKeyOf(comment: unknown, mirror: unknown): string {
	for (const c of [mirror, comment]) {
		if (typeof c !== "string" || !c) continue;
		const m = /(?:^|[\s;])ssh-key=([^\s;]+)/.exec(` ${c}`);
		if (m?.[1]) return m[1];
	}
	return "";
}

/**
 * centrs#618 per-service port keys, named after /ip/service. Stored
 * verbatim in the record comment today (centrs 0.1.9 warns
 * cdb/unknown-option and ignores them); they take effect when #618
 * ships. Only the services centrs connects to.
 */
export const PORT_KEYS = [
	"www-port",
	"www-ssl-port",
	"api-port",
	"api-ssl-port",
	"ssh-port",
] as const;

/** Port keys out of the comment kv-soup, same tolerance as sshKeyOf. */
export function portsOf(
	comment: unknown,
	mirror: unknown,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of PORT_KEYS) {
		for (const c of [mirror, comment]) {
			if (typeof c !== "string" || !c) continue;
			const m = new RegExp(`(?:^|[\\s;])${key}=([^\\s;]+)`).exec(` ${c}`);
			if (m?.[1]) {
				out[key] = m[1];
				break;
			}
		}
	}
	return out;
}

/** "" (clear) or an integer 1-65535; the same rule centrs applies to port=. */
export function validPortValue(v: unknown): v is string {
	if (typeof v !== "string") return false;
	if (v === "") return true;
	if (!/^[0-9]{1,5}$/.test(v)) return false;
	const n = Number(v);
	return n >= 1 && n <= 65535;
}

/** Keep only known port keys with valid values; null when any is invalid. */
export function cleanPorts(v: unknown): Record<string, string> | null {
	if (v === undefined || v === null) return {};
	if (typeof v !== "object" || Array.isArray(v)) return null;
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		if (!(PORT_KEYS as readonly string[]).includes(k)) return null;
		if (!validPortValue(val)) return null;
		out[k] = val;
	}
	return out;
}

export function projectCdbEntry(entry: unknown): CdbCredentialDetails | null {
	if (!entry || typeof entry !== "object") return null;
	const rec = entry as Record<string, unknown>;
	const target = rec["target"];
	if (typeof target !== "string" || !target.trim()) return null;
	return {
		target: target.trim(),
		ports: portsOf(rec["comment"], rec["commentMirror"]),
		user: strField(rec, "user"),
		group: strField(rec, "group"),
		recordTypeName: strField(rec, "recordTypeName"),
		session: strField(rec, "session"),
		profile: strField(rec, "profile"),
		hasPassword: rec["savedPassword"] === true,
		sshKey: sshKeyOf(rec["comment"], rec["commentMirror"]),
	};
}

/** Canonical snapshot string: equal strings mean no drift. */
export function credentialSnapshot(d: CdbCredentialDetails): string {
	return JSON.stringify([
		d.target,
		d.user,
		d.group,
		d.recordTypeName,
		d.session,
		d.profile,
		d.hasPassword,
		d.sshKey,
		PORT_KEYS.map((k) => d.ports?.[k] ?? ""),
	]);
}

export type ShowCdbResult =
	| { ok: true; details: CdbCredentialDetails }
	| { ok: false; why: string; code?: string };

/** One redacted record read. Fails honest, never throws for CDB states. */
export async function showCdbDevice(
	cdbFile: string | null,
	target: string,
	env: Record<string, string>,
): Promise<ShowCdbResult> {
	if (!have("centrs", env)) return { ok: false, why: "centrs not on PATH" };
	const args = ["devices", "show", target, "--format", "json"];
	if (cdbFile) args.push("--cdb-file", cdbFile);
	const r = await run(["centrs", ...args], { timeoutMs: 30_000, env });
	try {
		const parsed = JSON.parse(centrsOut(r)) as Record<string, unknown>;
		if (parsed["ok"] !== true) {
			return {
				ok: false,
				why: centrsWhy(parsed),
				code: centrsCode(parsed) ?? undefined,
			};
		}
		const entry = (parsed["data"] as Record<string, unknown> | null)?.["entry"];
		const details = projectCdbEntry(entry);
		if (!details)
			return { ok: false, why: "centrs devices show output unreadable" };
		return { ok: true, details };
	} catch {
		return { ok: false, why: "centrs devices show output unreadable" };
	}
}

export type CdbCredentialWrite = {
	user?: string;
	password?: string;
	sshKey?: string;
	profile?: string;
	session?: string;
	/** Port key -> value; "" removes the key (set only). */
	ports?: Record<string, string>;
};

export type SetCdbResult =
	| { ok: true; action: "set" | "add"; details: CdbCredentialDetails }
	| { ok: false; why: string; code?: string }
	| { ok: false; conflict: true; why: string; current: CdbCredentialDetails };

const nonEmpty = (v: string | undefined): v is string =>
	typeof v === "string" && v !== "";

function writeArgs(
	action: "set" | "add",
	target: string,
	write: CdbCredentialWrite,
	cdbFile: string | null,
): string[] {
	const args = ["devices", action, target];
	if (nonEmpty(write.user)) args.push("--user", write.user);
	// No env/stdin channel exists for the RECORD password (only the CDB
	// password rides CENTRS_CDB_PASSWORD): argv is the one centrs honors.
	// Transiently ps-visible on this local box (D31 trust model); never
	// logged, never echoed, and omitted entirely when not being set.
	if (nonEmpty(write.password)) args.push("--password", write.password);
	if (nonEmpty(write.profile)) args.push("--profile", write.profile);
	if (nonEmpty(write.session)) args.push("--session", write.session);
	if (nonEmpty(write.sshKey)) args.push(`ssh-key=${write.sshKey}`);
	for (const [k, v] of Object.entries(write.ports ?? {})) {
		// A new record has nothing to remove; `key=` removes on set.
		if (v === "" && action === "add") continue;
		args.push(`${k}=${v}`);
	}
	args.push("--format", "json");
	if (cdbFile) args.push("--cdb-file", cdbFile);
	return args;
}

/**
 * Write one record's credentials (T48). Grounded on centrs
 * 0.1.9-next `devices set/add --help`: first-class --user/--password/
 * --profile/--session plus the comment kv-soup `ssh-key=<path>` pair —
 * nothing else is a credential scheme there, so nothing else is
 * offered. Empty fields are left unchanged, never cleared (clearing
 * rides the buggy C9 path upstream; not offered until it is sound).
 *
 * INTERIM single-writer stance pending tikoci/centrs#581 (C15) — a
 * re-read-and-compare, not a lock: the caller passes the snapshot its
 * modal read at open (`expected`, or `{missing:true}` when the record
 * was absent); this re-reads before writing and reports a conflict
 * with the redacted current record instead of overwriting on any
 * drift. Without a baseline there is no drift to detect, so a missing
 * `expected` refuses rather than writing blind. A missing record is
 * created via `add` (never --force: a raced create fails as
 * cdb/already-exists and is re-read into a conflict).
 *
 * Two hard limits (T82) — do not mistake this for a lock:
 * password-blind — the snapshot compares only target, user, group,
 * record type, session, profile, saved-password presence, and ssh-key,
 * so a password-value rotation (A→B→C) leaves it identical and even a
 * sequential stale write succeeds with conflict=false; non-atomic —
 * the re-read and the write are separate centrs calls, so two
 * simultaneous saves can both succeed with one silently lost. The
 * durable fix is upstream tikoci/centrs#581 (C15).
 */
export async function setCdbCredentials(
	cdbFile: string | null,
	target: string,
	write: CdbCredentialWrite,
	env: Record<string, string>,
	expected?: CdbCredentialDetails | { missing: true } | null,
): Promise<SetCdbResult> {
	if (!have("centrs", env)) return { ok: false, why: "centrs not on PATH" };
	if (
		!nonEmpty(write.user) &&
		!nonEmpty(write.password) &&
		!nonEmpty(write.sshKey) &&
		!nonEmpty(write.profile) &&
		!nonEmpty(write.session) &&
		Object.keys(write.ports ?? {}).length === 0
	) {
		return { ok: false, why: "nothing to write (all fields empty)" };
	}
	if (expected === undefined || expected === null) {
		return {
			ok: false,
			code: "cdb/stale-write-refused",
			why: "refusing a blind write: re-read the record first (no baseline to compare)",
		};
	}
	const runWrite = async (action: "set" | "add"): Promise<SetCdbResult> => {
		const r = await run(
			["centrs", ...writeArgs(action, target, write, cdbFile)],
			{
				timeoutMs: 30_000,
				env,
			},
		);
		try {
			const parsed = JSON.parse(centrsOut(r)) as Record<string, unknown>;
			if (parsed["ok"] !== true) {
				const code = centrsCode(parsed);
				// Raced create: someone added the record between our
				// re-read and the add — say conflict, with the current.
				if (action === "add" && code === "cdb/already-exists") {
					const now = await showCdbDevice(cdbFile, target, env);
					if (now.ok) {
						return {
							ok: false,
							conflict: true,
							why: `record for ${target} was created while the modal was open; review it before writing`,
							current: now.details,
						};
					}
				}
				return {
					ok: false,
					why: centrsWhy(parsed),
					code: code ?? undefined,
				};
			}
			const entry = (parsed["data"] as Record<string, unknown> | null)?.[
				"entry"
			];
			const details = projectCdbEntry(entry);
			if (!details) return { ok: false, why: "centrs write output unreadable" };
			return { ok: true, action, details };
		} catch {
			return { ok: false, why: "centrs write output unreadable" };
		}
	};
	// The C15 re-read: the record as it stands NOW, not at modal open.
	const seen = await showCdbDevice(cdbFile, target, env);
	if (!seen.ok) {
		if (seen.code !== "cdb/not-found-target") return seen;
		if (!("missing" in expected) || expected.missing !== true) {
			return {
				ok: false,
				conflict: true,
				why: `record for ${target} was deleted while the modal was open`,
				current: {
					target,
					ports: {},
					user: "",
					group: "",
					recordTypeName: "",
					session: "",
					profile: "",
					hasPassword: false,
					sshKey: "",
				},
			};
		}
		return runWrite("add");
	}
	if ("missing" in expected) {
		if (expected.missing !== true) {
			return {
				ok: false,
				code: "cdb/stale-write-refused",
				why: "refusing a blind write: the baseline is not a record snapshot",
			};
		}
		return {
			ok: false,
			conflict: true,
			why: `record for ${target} was created while the modal was open; review it before writing`,
			current: seen.details,
		};
	}
	if (credentialSnapshot(expected) !== credentialSnapshot(seen.details)) {
		return {
			ok: false,
			conflict: true,
			why: `record for ${target} changed while the modal was open; review it before writing`,
			current: seen.details,
		};
	}
	return runWrite("set");
}

/**
 * Password-presence probe for inventory rows (T48): one `devices show`
 * per linked handle, in parallel. A dangling link (not-found-target)
 * honestly reads as no password; any other probe failure leaves the
 * row unmarked (unknown), never a guessed false. Only the boolean
 * survives — the show output itself stays server-side (C13 guard).
 */
export async function probeHasPassword(
	cdbFile: string | null,
	targets: (string | undefined)[],
	env: Record<string, string>,
): Promise<(boolean | undefined)[]> {
	return Promise.all(
		targets.map(async (t) => {
			if (!t) return undefined;
			const seen = await showCdbDevice(cdbFile, t, env);
			if (seen.ok) return seen.details.hasPassword;
			if (seen.code === "cdb/not-found-target") return false;
			return undefined;
		}),
	);
}

export type RemoveCdbResult = { ok: true } | { ok: false; why: string };

/** Remove one CDB record (centrs keeps its own backup of the store). */
export async function removeCdbDevice(
	cdbFile: string | null,
	target: string,
	env: Record<string, string>,
): Promise<RemoveCdbResult> {
	if (!have("centrs", env)) return { ok: false, why: "centrs not on PATH" };
	const args = ["devices", "remove", target, "--format", "json"];
	if (cdbFile) args.push("--cdb-file", cdbFile);
	const r = await run(["centrs", ...args], { timeoutMs: 30_000, env });
	try {
		const parsed = JSON.parse(centrsOut(r)) as Record<string, unknown>;
		if (parsed["ok"] !== true) return { ok: false, why: centrsWhy(parsed) };
		return { ok: true };
	} catch {
		return { ok: false, why: "centrs devices remove output unreadable" };
	}
}
