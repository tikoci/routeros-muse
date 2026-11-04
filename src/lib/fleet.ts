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

/**
 * centrs retrieve argv for a device (T38, D23): the cdb link wins, the
 * legacy host is break-glass, neither is null (caller stays honest).
 * cdbFile points centrs at the workspace device.cdb when it ships one.
 */
export function centrsRetrieveArgs(
	device: Pick<Device, "cdb" | "host">,
	rosPath: string,
	cdbFile: string | null,
): string[] | null {
	const tail = ["--format", "json", "--timeout", "10s"];
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
 * Live stats for one device: identity + resource via centrs retrieve
 * under the caller's env (which carries the unlock binding). The
 * device is looked up in the CDB, like listDevices (D53).
 */
export async function deviceStats(
	id: string,
	cdbFile: string | null,
	env: Record<string, string>,
): Promise<StatsResult> {
	const listed = await listCdbDevices(cdbFile ?? undefined, env);
	if (!listed.ok) return { status: 200, body: { ok: false, why: listed.why } };
	const device = listed.devices.find((s) => s.id === id);
	if (!device)
		return { status: 404, body: { ok: false, why: `no device ${id}` } };
	const argsFor = (rosPath: string) =>
		centrsRetrieveArgs(device as Device, rosPath, cdbFile);
	if (!argsFor("/system/identity")) {
		return {
			status: 200,
			body: {
				ok: false,
				why: `device ${id} has no cdb link nor host yet (add cdb = "<centrs-device>" to its [device])`,
			},
		};
	}
	if (!have("centrs", env))
		return { status: 200, body: { ok: false, why: "centrs not on PATH" } };
	const [idr, res] = await Promise.all([
		run(["centrs", ...(argsFor("/system/identity") as string[])], {
			timeoutMs: 30_000,
			env,
		}),
		run(["centrs", ...(argsFor("/system/resource") as string[])], {
			timeoutMs: 30_000,
			env,
		}),
	]);
	try {
		const ident = JSON.parse(centrsOut(idr)) as Record<string, unknown>;
		const resource = JSON.parse(centrsOut(res)) as Record<string, unknown>;
		if (ident["ok"] !== true)
			return { status: 200, body: { ok: false, why: centrsWhy(ident) } };
		if (resource["ok"] !== true)
			return { status: 200, body: { ok: false, why: centrsWhy(resource) } };
		return {
			status: 200,
			body: { ok: true, identity: ident["data"], resource: resource["data"] },
		};
	} catch {
		return {
			status: 200,
			body: { ok: false, why: "centrs output unreadable" },
		};
	}
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
	comment?: string;
	recordType?: number;
	attributes?: Record<string, string>;
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

export const CREDENTIAL_KEYS = [
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
] as const;
export const VIA_VALUES = [
	"rest-api",
	"native-api",
	"ssh",
	"snmp",
	"mndp",
	"romon",
	"winbox-terminal",
	"btest",
	"mac-telnet",
] as const;
export const RECORD_TYPES = [
	"macTarget",
	"ipAdmin",
	"ipUser",
	"romonNeighbor",
	"romonTarget",
] as const;

/** Parse shell-word comment tokens, including quoted spaces and escaped quotes. Last token wins. */
export function credentialAttributes(comment: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (typeof comment !== "string") return out;
	const words = comment.match(/(?:[^\s"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
	for (const word of words) {
		const token = /^([A-Za-z][A-Za-z0-9_-]*)=(.*)$/.exec(word);
		if (!token || token[1] === undefined || token[2] === undefined) continue;
		const key = token[1];
		if (
			!(CREDENTIAL_KEYS as readonly string[]).includes(key) &&
			key !== "ssh-key" &&
			!(PORT_KEYS as readonly string[]).includes(key)
		)
			continue;
		out[key] = token[2].replace(/"((?:[^"\\]|\\.)*)"/g, (_, v: string) =>
			v.replace(/\\(["\\])/g, "$1"),
		);
	}
	return out;
}

export function cleanCredentialAttributes(
	value: unknown,
): Record<string, string> | null {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const out: Record<string, string> = {};
	for (const [key, v] of Object.entries(value)) {
		if (
			!(CREDENTIAL_KEYS as readonly string[]).includes(key) ||
			typeof v !== "string" ||
			!/^[A-Za-z0-9_.:/@+%, -]*$/.test(v)
		)
			return null;
		if (v !== "") {
			const enums: Record<string, readonly string[]> = {
				via: VIA_VALUES,
				validate: ["true", "false"],
				insecure: ["true", "false"],
				mcp: ["ro", "rw"],
				"altitude-type": ["MSL", "AGL"],
			};
			if (enums[key] && !enums[key]?.includes(v)) return null;
			if (key === "port" && !validPortValue(v)) return null;
			if (
				key === "timeout" &&
				(!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 2147483647)
			)
				return null;
			if (
				["lat", "lon", "altitude"].includes(key) &&
				(!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(v) ||
					!Number.isFinite(Number(v)) ||
					(key === "lat" && Math.abs(Number(v)) > 90) ||
					(key === "lon" && Math.abs(Number(v)) > 180))
			)
				return null;
		}
		out[key] = v;
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
		comment: strField(rec, "comment"),
		recordType:
			typeof rec["recordType"] === "number" ? rec["recordType"] : undefined,
		attributes: Object.fromEntries(
			CREDENTIAL_KEYS.map((k) => [
				k,
				credentialAttributes(rec["commentMirror"] ?? rec["comment"])[k] ?? "",
			]),
		),
		ports: portsOf(rec["comment"], rec["commentMirror"]),
		user: strField(rec, "user"),
		group: strField(rec, "group"),
		recordTypeName: strField(rec, "recordTypeName"),
		session: strField(rec, "session"),
		profile: strField(rec, "profile"),
		hasPassword: rec["savedPassword"] === true,
		sshKey:
			credentialAttributes(rec["commentMirror"] ?? rec["comment"])["ssh-key"] ??
			sshKeyOf(rec["comment"], rec["commentMirror"]),
	};
}

/** Canonical snapshot string: equal strings mean no drift. */
export function credentialSnapshot(d: CdbCredentialDetails): string {
	return JSON.stringify([
		d.target,
		d.comment ?? "",
		d.recordType ?? null,
		CREDENTIAL_KEYS.map((k) => d.attributes?.[k] ?? ""),
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
	group?: string;
	recordTypeName?: string;
	comment?: string;
	attributes?: Record<string, string>;
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
	if (nonEmpty(write.group)) args.push("--group", write.group);
	if (action === "add" && nonEmpty(write.recordTypeName))
		args.push("--record-type", write.recordTypeName);
	if (action === "add" && nonEmpty(write.comment))
		args.push("--comment", write.comment);
	if (write.sshKey !== undefined && (write.sshKey !== "" || action === "set"))
		args.push(`ssh-key=${JSON.stringify(write.sshKey)}`);
	for (const [k, v] of Object.entries(write.attributes ?? {})) {
		if (v === "" && action === "add") continue;
		args.push(`${k}=${JSON.stringify(v)}`);
	}
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
 * Write one record's credentials (T48). Grounded on bundled centrs 0.1.9 help and a disposable CDB roundtrip.
 * First-class fields use flags; allowlisted attributes use comment tokens.
 * Empty kv values remove tokens. First-class clearing remains blocked
 * because it rides the buggy C9 path upstream.
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
 * record type, session, profile, comment attributes, saved-password presence, and ssh-key,
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
		cleanCredentialAttributes(write.attributes) === null ||
		cleanPorts(write.ports) === null ||
		Object.entries(write).some(
			([k, v]) =>
				![
					"user",
					"password",
					"sshKey",
					"profile",
					"session",
					"group",
					"recordTypeName",
					"comment",
					"ports",
					"attributes",
				].includes(k) ||
				(typeof v === "string" &&
					(/^[ -]*--?/.test(v) ||
						[...v].some(
							(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
						))),
		) ||
		(write.recordTypeName &&
			!(RECORD_TYPES as readonly string[]).includes(write.recordTypeName))
	)
		return { ok: false, why: "bad credential fields" };
	if (
		expected &&
		!("missing" in expected) &&
		["user", "profile", "session", "group"].some(
			(k) =>
				write[k as keyof CdbCredentialWrite] === "" &&
				expected[k as keyof CdbCredentialDetails],
		)
	)
		return { ok: false, why: "first-class fields cannot be cleared" };
	if (
		expected &&
		!("missing" in expected) &&
		(write.comment !== undefined || write.recordTypeName !== undefined)
	)
		return { ok: false, why: "comment and record type are add-only" };
	if (
		!nonEmpty(write.user) &&
		!nonEmpty(write.password) &&
		write.sshKey === undefined &&
		!nonEmpty(write.group) &&
		!nonEmpty(write.recordTypeName) &&
		!nonEmpty(write.comment) &&
		Object.keys(write.attributes ?? {}).length === 0 &&
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
