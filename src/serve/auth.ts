// First-pass auth (T39, D24): CDB-password web login plus Meta-OAuth gate.
//
// The CDB state machine is grounded on centrs envelopes (see
// docs/design/t39-auth-design.md): list-without-password tells open from
// encrypted, list-with-password verifies a candidate. Passwords travel
// via CENTRS_CDB_PASSWORD (env), never argv (ps-visible).
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { have, redactSecret, run } from "../lib/run";

export type CdbScope = "workspace" | "default" | "override";
export type CdbMode = "encrypted" | "open" | "missing" | "unavailable";
export type MetaAuth = "unknown" | "authed" | "absent";

/** Which CDB backs auth, and where the UI should point for encryption. */
export type AuthCdb = {
	file: string | null;
	scope: CdbScope;
	displayPath: string;
};

type CentrsEnvelope = {
	ok?: unknown;
	data?: unknown;
	warnings?: unknown;
	error?: { code?: unknown; summary?: unknown };
};

function warningCodes(env: CentrsEnvelope): string[] {
	if (!Array.isArray(env.warnings)) return [];
	const out: string[] = [];
	for (const w of env.warnings) {
		const code = (w as Record<string, unknown> | null)?.["code"];
		if (typeof code === "string") out.push(code);
	}
	return out;
}

function parseEnvelope(text: string): CentrsEnvelope | null {
	try {
		return JSON.parse(text) as CentrsEnvelope;
	} catch {
		return null;
	}
}

/** Extract stdout-or-stderr like the server's centrsOut (success on stdout). */
function centrsText(r: { stdout: string; stderr: string }): string {
	return r.stdout.trim() ? r.stdout : r.stderr;
}

function codeOf(env: CentrsEnvelope): string | null {
	const code = env.error?.code;
	return typeof code === "string" ? code : null;
}

/**
 * Detect whether a CDB is encrypted, open, missing, or unreadable.
 * file=null lets centrs resolve the default store. Never throws for
 * CDB states; only centrs-missing surfaces as unavailable. Strips any
 * inherited CENTRS_CDB_PASSWORD first: detection must answer from the
 * file alone, never from ambient credentials (an ambient password
 * would otherwise read an encrypted CDB as open).
 */
export async function detectCdbMode(
	file: string | null,
	spawnEnv?: Record<string, string>,
): Promise<{ mode: CdbMode; why?: string }> {
	if (!have("centrs", spawnEnv))
		return { mode: "unavailable", why: "centrs not on PATH" };
	const args = ["devices", "list", "--format", "json"];
	if (file) args.push("--cdb-file", file);
	const childEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(spawnEnv ?? process.env)) {
		if (v !== undefined && k !== "CENTRS_CDB_PASSWORD") childEnv[k] = v;
	}
	const r = await run(["centrs", ...args], {
		timeoutMs: 30_000,
		env: childEnv,
	});
	const env = parseEnvelope(centrsText(r));
	if (!env) return { mode: "unavailable", why: "centrs output unreadable" };
	if (env.ok === true) return { mode: "open" };
	if (codeOf(env) === "cdb/password-required") return { mode: "encrypted" };
	if (codeOf(env) === "cdb/not-found")
		return { mode: "missing", why: "CDB file not found" };
	return {
		mode: "unavailable",
		why: `centrs: ${codeOf(env) ?? "read failed"}`,
	};
}

/**
 * Verify a candidate password against an (encrypted) CDB. Returns ok only
 * when centrs decrypts successfully; wrong passwords come back as
 * cdb/decrypt-failed, never an exception. Verify requires encrypted: an
 * ok:true envelope carrying cdb/password-not-needed (open file, the
 * password was ignored) does NOT verify — read off the same envelope,
 * zero extra spawns.
 */
export async function verifyCdbPassword(
	file: string | null,
	password: string,
	spawnEnv?: Record<string, string>,
): Promise<{ ok: true } | { ok: false; code: string; why: string }> {
	const args = ["devices", "list", "--format", "json"];
	if (file) args.push("--cdb-file", file);
	const childEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(spawnEnv ?? process.env)) {
		if (v !== undefined) childEnv[k] = v;
	}
	childEnv["CENTRS_CDB_PASSWORD"] = password;
	const r = await run(["centrs", ...args], {
		timeoutMs: 30_000,
		env: childEnv,
	});
	const env = parseEnvelope(centrsText(r));
	if (env?.ok === true) {
		if (warningCodes(env).includes("cdb/password-not-needed")) {
			return {
				ok: false,
				code: "cdb/password-not-needed",
				why: "centrs: cdb/password-not-needed (open CDB ignores the password)",
			};
		}
		return { ok: true };
	}
	const code = (env && codeOf(env)) || "cdb/unreadable";
	return { ok: false, code, why: `centrs: ${code}` };
}

export type CdbMutationResult =
	| { ok: true }
	| { ok: false; code: string; why: string };

/**
 * Child env for a CDB mutation: the explicit password rides
 * CENTRS_CDB_PASSWORD, an ambient one never leaks in.
 */
function mutationEnv(
	password: string,
	spawnEnv?: Record<string, string>,
): Record<string, string> {
	const child: Record<string, string> = {};
	for (const [k, v] of Object.entries(spawnEnv ?? process.env)) {
		if (v !== undefined && k !== "CENTRS_CDB_PASSWORD") child[k] = v;
	}
	child["CENTRS_CDB_PASSWORD"] = password;
	return child;
}

function mutationFailure(
	action: string,
	r: { stdout: string; stderr: string },
	password: string,
): CdbMutationResult {
	const env = parseEnvelope(centrsText(r));
	if (env) {
		const code = codeOf(env) ?? "cdb/unreadable";
		return { ok: false, code, why: redactSecret(`centrs: ${code}`, password) };
	}
	const line = centrsText(r).trim().split("\n")[0] ?? "";
	return {
		ok: false,
		code: "cdb/unreadable",
		why: redactSecret(
			`centrs ${action} failed${line ? `: ${line.slice(0, 160)}` : ""}`,
			password,
		),
	};
}

/**
 * Convert an open CDB to encrypted (T133 encrypt-now): `centrs
 * devices encrypt --no-backup` with the password in the child env
 * only. The caller re-checks the mode first — this never converts
 * anything but an open registry, and failure whys redact the
 * password.
 */
export async function encryptOpenCdb(
	file: string | null,
	password: string,
	spawnEnv?: Record<string, string>,
): Promise<CdbMutationResult> {
	if (!have("centrs", spawnEnv))
		return { ok: false, code: "cdb/unavailable", why: "centrs not on PATH" };
	const args = ["devices", "encrypt", "--no-backup", "--format", "json"];
	if (file) args.push("--cdb-file", file);
	const r = await run(["centrs", ...args], {
		timeoutMs: 30_000,
		env: mutationEnv(password, spawnEnv),
	});
	const env = parseEnvelope(centrsText(r));
	if (env?.ok === true) return { ok: true };
	return mutationFailure("encrypt", r, password);
}

/**
 * Create an encrypted CDB (T133 missing-registry overlay):
 * `centrs devices init --encrypt` with the password in the child
 * env only. Refuses an existing file the same way the scaffold
 * does (no clobber); the caller re-checks the missing mode first.
 */
export async function initEncryptedCdb(
	file: string,
	password: string,
	spawnEnv?: Record<string, string>,
): Promise<CdbMutationResult> {
	if (!have("centrs", spawnEnv))
		return { ok: false, code: "cdb/unavailable", why: "centrs not on PATH" };
	const r = await run(
		[
			"centrs",
			"devices",
			"init",
			"--encrypt",
			"--cdb-file",
			file,
			"--format",
			"json",
		],
		{ timeoutMs: 30_000, env: mutationEnv(password, spawnEnv) },
	);
	const env = parseEnvelope(centrsText(r));
	if (env?.ok === true) return { ok: true };
	return mutationFailure("init --encrypt", r, password);
}

/**
 * Plaintext pre-conversion snapshots beside the CDB
 * (device.cdb.bak.*): the encrypt overlay warns about these —
 * encryption protects only the active CDB. Basenames, sorted;
 * unreadable dirs read as none.
 */
export function listCdbBackups(file: string): string[] {
	const prefix = `${path.basename(file)}.bak.`;
	let names: string[];
	try {
		names = nodeFs.readdirSync(path.dirname(file));
	} catch {
		return [];
	}
	return names.filter((n) => n.startsWith(prefix)).sort();
}

/**
 * Server-owned unlock context (T64): the bound CDB plus the password
 * that opens it. Bound to a session token at unlock, held in memory
 * only, dropped at lock. cdbFile=null is the explicit default-store
 * selection (no-workspace mode without an override): centrs resolves
 * the operator store itself, never via a path we guess (D30).
 */
export type UnlockContext = {
	cdbFile: string | null;
	password: string;
};

/**
 * One explicit per-worker environment (T64): the package-fronted base
 * plus the CDB binding. cdbFile points centrs at the bound store via
 * CENTRS_CDB_FILE (explicit --cdb-file argv still wins where passed);
 * password rides only unlocked sessions, and an empty one is omitted.
 * Always a fresh record — never mutates base or process.env.
 */
export function workerEnv(
	base: Record<string, string>,
	cdbFile: string | null,
	password: string | null,
): Record<string, string> {
	const env: Record<string, string> = { ...base };
	if (cdbFile) env["CENTRS_CDB_FILE"] = cdbFile;
	if (password) env["CENTRS_CDB_PASSWORD"] = password;
	return env;
}

/** In-memory web sessions. Restart re-locks; hardening is T63. */
export type SessionStore = {
	issue: () => string;
	/** Bind the unlock context proven at unlock to a live token. */
	bind: (token: string, ctx: UnlockContext) => void;
	/** The bound context, or null for unknown tokens and bypass mode. */
	ctx: (token: string | null) => UnlockContext | null;
	valid: (token: string | null) => boolean;
	/** Revoke the token and drop its unlock context with it. */
	revoke: (token: string | null) => void;
};

export function createSessionStore(): SessionStore {
	const live = new Set<string>();
	const bound = new Map<string, UnlockContext>();
	return {
		issue: () => {
			const bytes = new Uint8Array(16);
			crypto.getRandomValues(bytes);
			const token = [...bytes]
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			live.add(token);
			return token;
		},
		bind: (token, ctx) => {
			if (live.has(token)) bound.set(token, ctx);
		},
		ctx: (token) =>
			typeof token === "string" ? (bound.get(token) ?? null) : null,
		valid: (token) =>
			typeof token === "string" && token !== "" && live.has(token),
		revoke: (token) => {
			if (token) {
				live.delete(token);
				bound.delete(token);
			}
		},
	};
}

export const SESSION_COOKIE = "rmsid";

export function cookieToken(req: Request): string | null {
	const header = req.headers.get("cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === SESSION_COOKIE)
			return decodeURIComponent(part.slice(eq + 1).trim()) || null;
	}
	return null;
}

export function sessionCookieHeader(token: string): string {
	return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`;
}

export function clearCookieHeader(): string {
	return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Minimal probe client (structural: stubs satisfy it in tests). */
export type ProbeClient = {
	sessionStart: (opts: { workspaceRoot: string }) => Promise<{
		session: { sessionId: string };
	}>;
	runTurn: (opts: {
		sessionId: string;
		input: { type: "text"; text: string }[];
		timeoutMs?: number;
	}) => Promise<{
		terminal: string;
		error?: { kind?: string; message?: string };
	}>;
	call: (method: string, params: unknown) => Promise<unknown>;
	close: () => Promise<void>;
};

export const PROBE_TEXT = "Reply with only the word ok";

/**
 * Disposable-session OAuth probe: a minimal turn on a throwaway session.
 * ONLY authRequired flips to absent — every other outcome (completed
 * turns, other failures, transport errors) stays honest: completed
 * proves auth, anything else proves nothing.
 */
export async function probeMetaAuth(
	spawnClient: () => Promise<ProbeClient>,
	workspaceRoot: string,
): Promise<"authed" | "absent" | "unknown"> {
	let client: ProbeClient | null = null;
	try {
		client = await spawnClient();
		const started = await client.sessionStart({ workspaceRoot });
		const sid = started.session.sessionId;
		try {
			const out = await client.runTurn({
				sessionId: sid,
				input: [{ type: "text", text: PROBE_TEXT }],
				timeoutMs: 90_000,
			});
			if (out.terminal === "completed") return "authed";
			if (out.error?.kind === "authRequired") return "absent";
			return "unknown";
		} finally {
			try {
				await client.call("session/leave", { sessionId: sid });
			} catch {
				// best-effort release; the probe verdict stands
			}
		}
	} catch {
		return "unknown";
	} finally {
		if (client) await client.close();
	}
}
