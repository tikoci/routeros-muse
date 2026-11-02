// T55 (D41): per-session MCP server shared defs.
//
// routeros-muse serves a per-session MCP server with ui_* tools so
// the agent can drive real UI: ui_notify posts a toast, ui_open
// opens a workspace file in a center tab through the existing
// viewers, ui_select_device sets a target chip. The worker
// negotiates sessionMcp at initialize and passes config.mcpServers
// at session/start (grounded B2 round trip); muse spawns the stdio
// bridge (ui-bridge.ts, self-contained) which relays tools/call to
// the running server over loopback HTTP with a per-session token.
//
// This module holds the canonical names, the relay credentials,
// the config builder, and the ui_open path check. The bridge
// itself duplicates the tool schemas (it is zero-dependency and
// standalone); the suite pins both sides against each other.
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	ARTIFACT_MAX_BYTES,
	isArtifactPath,
	MAX_FILE_BYTES,
	safeJoin,
} from "../lib/workspace";
import type { McpServerConfig } from "../msp/client";

/** MCP server name (muse accepts underscores un-normalized; B2 normalized hyphens). */
export const UI_MCP_SERVER = "routeros_muse";

/**
 * The demo tool set. Each one drives real UI that already exists.
 * ui_add_device opens the existing Set-credentials modal in add mode
 * (T110): the owner types the password in the UI, so it never enters
 * chat or argv. Opening the dialog is owner-gated by the Save click.
 */
export const UI_TOOL_NAMES = [
	"ui_notify",
	"ui_open",
	"ui_select_device",
	"ui_add_device",
] as const;

export type UiToolName = (typeof UI_TOOL_NAMES)[number];

/** muse's namespaced tool spelling: mcp__<server>__<tool> (B2). */
export function mcpToolName(short: string): string {
	return `mcp__${UI_MCP_SERVER}__${short}`;
}

/**
 * Accept the namespaced spelling on the relay: the MCP wire carries
 * the short name, but a host that echoes its own spelling still lands.
 */
export function stripMcpPrefix(tool: string): string {
	const prefix = `mcp__${UI_MCP_SERVER}__`;
	return tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
}

/** T110 validators (shared by the relay and POST /api/devices/add). */

/** IPv4/IPv6/hostname: letters, digits, dots, colons, dashes, underscores. */
const HOST_RE = /^[A-Za-z0-9._:-]{1,255}$/;
/** CDB login user: conservative handle charset. */
const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** router.toml device id slug: lowercase, dash-separated. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validAddHost(host: unknown): host is string {
	return typeof host === "string" && HOST_RE.test(host);
}

export function validAddUser(user: unknown): user is string {
	return typeof user === "string" && USER_RE.test(user);
}

export function validAddId(id: unknown): id is string {
	return typeof id === "string" && ID_RE.test(id);
}

/**
 * Derive a device id slug from a host: lowercase, non [a-z0-9-] runs
 * collapse to one dash, trimmed. Empty result (e.g. "::") falls back
 * to "device".
 */
export function slugFromHost(host: string): string {
	const slug = host
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || "device";
}

/** Relay coordinates, passed to the bridge via the mcpServers env. */
export const RELAY_URL_ENV = "ROUTEROS_MUSE_URL";
export const RELAY_TOKEN_ENV = "ROUTEROS_MUSE_MCP_TOKEN";

/** Fresh per-session relay token: 16 random bytes, hex. */
export function mintMcpToken(): string {
	return nodeCrypto.randomBytes(16).toString("hex");
}

/** Constant-time token compare; empty never matches. */
export function tokensEqual(a: string, b: string): boolean {
	if (!a || !b) return false;
	const ba = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	return ba.length === bb.length && nodeCrypto.timingSafeEqual(ba, bb);
}

export type UiMcpConfig = {
	/** Absolute path to src/mcp/ui-bridge.ts. */
	bridge: string;
	/** Bun binary that runs the bridge (process.execPath). */
	bun: string;
	/** Server base URL (loopback); the bridge POSTs <url>api/mcp/relay. */
	url: string;
	/** Per-session relay token. */
	token: string;
};

/** The session/start config.mcpServers value (B2 stdio shape). */
export function uiMcpServers(
	opts: UiMcpConfig,
): Record<string, McpServerConfig> {
	return {
		[UI_MCP_SERVER]: {
			transport: "stdio",
			command: opts.bun,
			args: [opts.bridge],
			env: {
				[RELAY_URL_ENV]: opts.url,
				[RELAY_TOKEN_ENV]: opts.token,
			},
		},
	};
}

/** Longest toast text the UI shows; longer input truncates, honestly reported. */
export const NOTIFY_TEXT_MAX = 2000;

export type UiOpenKind = "toml" | "artifact" | "doc";

export type UiOpenResult =
	| { ok: true; kind: UiOpenKind }
	| { ok: false; why: string };

/**
 * Validate a ui_open path: inside the workspace (safeJoin), no
 * symlink in any component (lstat walk, mirroring resolveArtifact),
 * and an O_NOFOLLOW open + fstat proving the final is still a
 * regular file (a swap between lstat and open fails ELOOP instead
 * of following). The UI fetches the bytes itself through the
 * existing file/artifact routes; this check only gates the event.
 */
export function resolveUiOpen(root: string, rel: string): UiOpenResult {
	if (typeof rel !== "string" || !rel) return { ok: false, why: "need {path}" };
	const full = safeJoin(root, rel);
	if (!full) return { ok: false, why: "path escapes the workspace" };
	const base = path.resolve(root);
	const parts = path.relative(base, full).split(path.sep);
	let cursor = base;
	for (let i = 0; i < parts.length; i++) {
		cursor = path.join(cursor, parts[i] as string);
		let lst: nodeFs.Stats;
		try {
			lst = nodeFs.lstatSync(cursor);
		} catch {
			return { ok: false, why: "no such file" };
		}
		if (lst.isSymbolicLink())
			return { ok: false, why: `refused: ${rel} passes through a symlink` };
		if (i === parts.length - 1 && !lst.isFile())
			return { ok: false, why: "not a file" };
	}
	const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = nodeFs.constants;
	let fd: number;
	try {
		fd = nodeFs.openSync(full, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ELOOP")
			return { ok: false, why: `refused: ${rel} passes through a symlink` };
		return { ok: false, why: "no such file" };
	}
	// The UI reads through one viewer per kind: doc panes fetch
	// /api/file (512 KiB cap) and artifacts fetch /api/artifact
	// (8 MiB cap); TOML panes fetch /api/toml, whose read path has
	// no cap of its own — preflight applies the same 512 KiB order
	// there. Over-limit reports the limit instead of an `opened`
	// the viewer then refuses.
	const kind: UiOpenKind = rel.endsWith(".toml")
		? "toml"
		: isArtifactPath(rel)
			? "artifact"
			: "doc";
	const limit = kind === "artifact" ? ARTIFACT_MAX_BYTES : MAX_FILE_BYTES;
	const limitName = kind === "artifact" ? "8 MiB" : "512 KiB";
	try {
		const st = nodeFs.fstatSync(fd);
		if (!st.isFile()) return { ok: false, why: "not a file" };
		if (st.size > limit)
			return {
				ok: false,
				why: `too large for the ${kind} viewer (${limitName} limit)`,
			};
	} catch {
		return { ok: false, why: "not a file" };
	} finally {
		try {
			nodeFs.closeSync(fd);
		} catch {
			// Proven already; a close failure is not a gate failure.
		}
	}
	return { ok: true, kind };
}
