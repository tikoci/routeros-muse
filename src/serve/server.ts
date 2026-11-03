// Mode B server (T31 slice 2): loopback Bun server over the workspace.
// Serves the v10 UI (ui.html, live-wired copy of the approved concept),
// bridges chat to the local muse over MSP, and reads tree/files/devices/
// twins/alerts from real sources. Anything unreachable degrades to an
// honest unavailable state, never demo data.

import * as nodeFs from "node:fs";
import * as nodeNet from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CdbCredentialDetails,
	type Device,
	deviceStats,
	doctorTwins,
	listCdbDevices,
	listDevices,
	listTwins,
	readDevices,
	setCdbCredentials,
	showCdbDevice,
} from "../lib/fleet";
import {
	checkServerPid,
	ensurePreallowReads,
	ensurePrivateHome,
	privateConfigHome,
	READ_COMMANDS,
	workspaceHosts,
} from "../lib/preallow";
import {
	dataHomeDir,
	defaultWorkspacesDir,
	pruneRegistry,
	type RegistryEntry,
	readRegistry,
	registerWorkspace,
	registryEntryAlive,
	registryFile,
} from "../lib/registry";
import {
	compareRouterosCatalogs,
	loadRouterosSkills,
	type RouterosSkillsReport,
	type SkillsBundle,
	type SkillsVerification,
	stageRouterosSkills,
} from "../lib/routeros-skills";
import { have, run } from "../lib/run";
import {
	isDefaultAccess,
	readAutoRouterosSkills,
	readDefaultAccess,
	readPreallowReads,
	SettingsSymlinkError,
	writeAutoRouterosSkills,
	writeDefaultAccess,
	writePreallowReads,
} from "../lib/settings";
import { listTemplates, type TemplateMeta } from "../lib/templates";
import { parseToml } from "../lib/toml";
import {
	toolBinDir as defaultToolBinDir,
	detectInstalled,
	type Installed,
	packageRoot,
	type ToolSource,
	toolEnv,
	toolSource,
} from "../lib/tools";
import {
	ageOf,
	artifactProvenanceForBuffer,
	artifactSecurityHeaders,
	artifactTier,
	isArtifactPath,
	listAlerts,
	listRecents,
	readTomlSections,
	readWorkspaceFile,
	resolveArtifact,
	scaffoldWorkspace,
	serveArtifactTier,
	type TierMemo,
	type TreeEntry,
	walkTree,
	writeWorkspaceFile,
} from "../lib/workspace";
import {
	ROSETTA_MCP_SERVER,
	rosettaEntry,
	seedToolNames,
	sessionMcpServers,
} from "../mcp/trilogy-tools";
import {
	mintMcpToken,
	NOTIFY_TEXT_MAX,
	resolveUiOpen,
	slugFromHost,
	stripMcpPrefix,
	tokensEqual,
	validAddHost,
	validAddId,
	validAddUser,
} from "../mcp/ui-tools";
import {
	type ApprovalMode,
	type McpServerConfig,
	MspClient,
	MspError,
	type MspSession,
	type PermissionState,
	type ReasoningEffort,
	type TurnInput,
	type ViewEvent,
} from "../msp/client";
import { runRenderJob } from "../render/jobs";
import {
	type AuthCdb,
	backupScanDir,
	type CdbMode,
	clearCookieHeader,
	cookieToken,
	createSessionStore,
	detectCdbMode,
	encryptOpenCdb,
	initEncryptedCdb,
	listCdbBackups,
	type MetaAuth,
	probeMetaAuth,
	retainedBackupsWarning,
	sessionCookieHeader,
	verifyCdbPassword,
	workerEnv,
} from "./auth";

export type ServeOpts = {
	workspace?: string;
	/** D23 no-workspace mode: quickchr/centrs only, no workspace attached. */
	noWorkspace?: boolean;
	port?: number;
	host?: string;
	provider?: string;
	museHome?: string;
	/** SSE heartbeat period; tests shrink it, production leaves the default. */
	heartbeatMs?: number;
	/**
	 * Explicit CDB path for every centrs call (no-workspace mode has no
	 * workspace device.cdb to discover). Beats discovery when set.
	 */
	cdbFile?: string;
	/**
	 * Dev/automation escape hatch (D24): an open CDB implies no auth.
	 * Without it, an open CDB refuses entry with encryption guidance.
	 */
	allowOpenCdb?: boolean;
	/**
	 * Override for the package tool bundle (T51, D26): tests point at a
	 * stub bin dir. Defaults to the package's own node_modules/.bin.
	 */
	toolBinDir?: string;
	/**
	 * Override for the package root used to resolve the trilogy MCP
	 * bundle entries (T105): tests point at a stub bundle. Defaults
	 * to the detected package root (null when unknown — both
	 * trilogy servers then omit, honestly).
	 */
	packageRoot?: string | null;
	/**
	 * XDG data-home override for the workspaces registry (T40): tests
	 * isolate here. Defaults to the real XDG_DATA_HOME.
	 */
	dataHome?: string;
	/**
	 * Creation-root override for new workspaces (T40): tests create
	 * hermetically. Defaults to ~/Networks.
	 */
	defaultWorkspaceDir?: string;
	/**
	 * Default MSP approval mode for the main session (T93 --yolo:
	 * allowAll). Beats settings.toml for the run. The access
	 * selector reads this same state, so the UI shows it as it
	 * already would. Defaults to promptUnmatched (D38: Ask first),
	 * or settings.toml [agent] default_access when stored.
	 */
	defaultApprovalMode?: ApprovalMode;
	/**
	 * D39: spawn the worker with --trust-workspace (default true),
	 * so the workspace AGENTS.md and .agents/skills load. False
	 * spawns untrusted. No-workspace mode never passes the flag.
	 */
	trustWorkspace?: boolean;
	/**
	 * Private muse config-home override (T101 round 4, D45):
	 * tests isolate here (the override is the exact home, no
	 * workspace id is appended). Defaults to this workspace's
	 * home, <dataHome>/routeros-muse/.muse-config/<workspace-id>
	 * (no-workspace mode: .muse-config/_no-workspace/).
	 * Forwarded to worker spawns (museConfigHome) so the worker
	 * reads the same policy file the server seeds; the shared
	 * ~/.config/muse is never written (auth reaches the worker
	 * as a symlink).
	 */
	configHome?: string;
	/**
	 * T55 relay-token override (tests only): fixes the per-session
	 * MCP token instead of minting a fresh one per server run.
	 */
	mcpToken?: string;
	/**
	 * T133: how the picker create flow serves the new workspace.
	 * The default spawns `routeros-muse start <dir> --no-open
	 * --port <free>` as a detached child and waits for it to
	 * answer. Tests inject a fake. The boundary carries dir and
	 * port only — the password never crosses it in any form.
	 */
	launchWorkspaceServer?: (
		dir: string,
		port: number,
	) => Promise<LaunchedWorkspace>;
};

/** A workspace child server (T133 picker create handoff). */
export type LaunchedWorkspace = {
	url: string;
	stop: () => Promise<void>;
	/** Bounded child log tail for failure whys (default launcher only). */
	logs?: () => string;
};

/** A free loopback port for the picker-spawned child (T133). */
export function pickFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = nodeNet.createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const addr = probe.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			if (!port) {
				probe.close();
				reject(new Error("no free port"));
				return;
			}
			probe.close((err) => {
				if (err) reject(err);
				else resolve(port);
			});
		});
	});
}

/**
 * Same-origin guard (T133 review P1, round 3 finding A): applied
 * CENTRALLY, once, at the top of the /api dispatch, to every
 * request whose method is not GET/HEAD/OPTIONS. Every guarded
 * request must carry an Origin that is this server's own origin
 * and a Host that is too (DNS-rebinding). Non-allowlisted routes
 * must also carry `Content-Type: application/json` — a cross-site
 * simple (text/plain, no-preflight) POST can neither set that
 * header nor forge the Origin. Browsers always send Origin on
 * these fetches; a missing or foreign one is a cross-site request
 * and is refused. Returns the refusal why, or null when the
 * request passes.
 *
 * Round 3 finding B: an Origin is accepted when its scheme is
 * http(s), its port equals the served port, and its hostname
 * (brackets stripped, lower-cased) is in the SAME allowed-host
 * set the Host check uses — the bound host, the loopback names,
 * and the local interface addresses on wildcard binds — so a
 * --host 0.0.0.0 server unlocks through its LAN URL and a ::1
 * bind accepts its bracketed Origin. The Host header's port is
 * checked against the served port too.
 */
export type SameOriginCtx = {
	host: string;
	port: number;
	displayHost: string;
};

/** Bracket-stripped, lower-cased host for set comparison. */
export function normalizeOriginHost(host: string): string {
	let h = host.trim().toLowerCase();
	if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
	return h;
}

/** Split a Host header into its hostname and explicit port, if any. */
function splitHostPort(header: string): {
	host: string;
	port: number | null;
} {
	const h = header.trim().toLowerCase();
	if (h.startsWith("[")) {
		const end = h.indexOf("]");
		if (end < 0) return { host: h, port: null };
		const rest = h.slice(end + 1);
		const port =
			rest.startsWith(":") && /^\d+$/.test(rest.slice(1))
				? Number(rest.slice(1))
				: null;
		return { host: h.slice(1, end), port };
	}
	// A bare multi-colon value is an unbracketed IPv6 literal, not host:port.
	if (h.indexOf(":") !== h.lastIndexOf(":")) return { host: h, port: null };
	const idx = h.lastIndexOf(":");
	if (idx >= 0 && /^\d+$/.test(h.slice(idx + 1)))
		return { host: h.slice(0, idx), port: Number(h.slice(idx + 1)) };
	return { host: h, port: null };
}

function allowedHosts(ctx: SameOriginCtx): Set<string> {
	const out = new Set<string>();
	out.add(normalizeOriginHost(ctx.displayHost));
	out.add(normalizeOriginHost(ctx.host));
	for (const name of ["127.0.0.1", "localhost", "::1"]) out.add(name);
	if (!isLoopbackHost(normalizeOriginHost(ctx.host))) {
		// LAN bind: the server answers on its interface addresses too.
		for (const addrs of Object.values(os.networkInterfaces())) {
			for (const a of addrs ?? []) {
				if (a.family === "IPv4" && !a.internal)
					out.add(normalizeOriginHost(a.address));
				if (a.family === "IPv6" && !a.internal)
					out.add(normalizeOriginHost(a.address));
			}
		}
	}
	return out;
}

export function checkSameOrigin(
	req: Request,
	ctx: SameOriginCtx,
	opts: { requireJson?: boolean } = {},
): string | null {
	const requireJson = opts.requireJson !== false;
	if (requireJson) {
		const ct = req.headers.get("content-type") ?? "";
		const mediaType = ct.split(";", 1)[0]?.trim().toLowerCase();
		if (mediaType !== "application/json")
			return "refusing: Content-Type must be application/json";
	}
	const origin = req.headers.get("origin");
	if (!origin) return "refusing: missing Origin";
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return "refusing: malformed Origin";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
		return "refusing: foreign Origin";
	const port = parsed.port
		? Number(parsed.port)
		: parsed.protocol === "https:"
			? 443
			: 80;
	if (port !== ctx.port) return "refusing: foreign Origin";
	if (!allowedHosts(ctx).has(normalizeOriginHost(parsed.hostname)))
		return "refusing: foreign Origin";
	const { host: bare, port: hostPort } = splitHostPort(
		req.headers.get("host") ?? "",
	);
	if (!allowedHosts(ctx).has(normalizeOriginHost(bare)))
		return "refusing: foreign Host";
	if (hostPort !== null && hostPort !== ctx.port)
		return "refusing: foreign Host";
	return null;
}

/**
 * Finding A allowlist: the only /api POSTs the UI sends without a
 * JSON body (bodyless POSTs — inventoried from ui.html fetch
 * calls: twins doctor, new session, stop, oauth recheck). They keep
 * the Origin/Host check; only the Content-Type requirement is
 * lifted. Everything else needs application/json.
 */
export const BODYLESS_POST_PATHS = new Set([
	"/api/auth/oauth-recheck",
	"/api/twins/doctor",
	"/api/chat/new",
	"/api/chat/stop",
]);

/**
 * Per-path promise-chain mutex (T133 review P1): serializes
 * detect+mutate on one absolute CDB path so two concurrent
 * encrypt-now calls cannot both succeed with different
 * passwords. The loser re-detects inside the lock and gets a
 * 409 without ever running centrs. External writers (a second
 * process) are NOT covered — atomicity there is upstream
 * (tikoci/centrs#581, need C15).
 */
export type CdbMutex = {
	<T>(key: string, fn: () => Promise<T>): Promise<T>;
	/** In-flight key count (round 3 finding F: entries must clear). */
	pending: () => number;
};

export function createCdbMutex(): CdbMutex {
	const tails = new Map<string, Promise<void>>();
	const run = (async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
		const prev = tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const tail = new Promise<void>((r) => {
			release = r;
		});
		// The stored entry is the chained promise itself, so the
		// finally below can recognize it: comparing against the
		// bare tail never matches and leaks the entry (round 3 F).
		const cur = prev.then(() => tail);
		tails.set(key, cur);
		await prev;
		try {
			return await fn();
		} finally {
			release();
			if (tails.get(key) === cur) tails.delete(key);
		}
	}) as CdbMutex;
	run.pending = () => tails.size;
	return run;
}

/**
 * Child env for a picker-spawned workspace server (T133 review
 * P1): the package-fronted tools minus any inherited
 * CENTRS_CDB_PASSWORD — the password never crosses to the
 * child in any form — plus the picker's effective data home.
 */
export function pickerChildEnv(
	tools: Record<string, string>,
	dataHome?: string,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(tools)) {
		if (k !== "CENTRS_CDB_PASSWORD") env[k] = v;
	}
	if (dataHome) env["XDG_DATA_HOME"] = dataHome;
	return env;
}

/**
 * Wait for a spawned child to answer its public auth state (T133):
 * any parseable `{state}` proves it is up; the caller checks the
 * state is the expected `locked`. Bounded — never waits forever:
 * the readiness fetch and the body parse share one AbortSignal
 * under the remaining overall budget, so even a listener that
 * accepts and never responds returns in time.
 */
export async function waitForChildReady(
	url: string,
	timeoutMs = 20_000,
): Promise<{ ok: true; state: string } | { ok: false; why: string }> {
	const deadline = Date.now() + timeoutMs;
	let last = "no answer";
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			return { ok: false, why: `child did not answer: ${last.slice(0, 160)}` };
		}
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), remaining);
		try {
			const r = await fetch(`${url}/api/auth/state`, {
				signal: ctrl.signal,
			});
			const aborted = new Promise<never>((_, reject) => {
				if (ctrl.signal.aborted) reject(new Error("aborted"));
				else
					ctrl.signal.addEventListener("abort", () =>
						reject(new Error("aborted")),
					);
			});
			const j = (await Promise.race([r.json(), aborted])) as {
				state?: unknown;
			};
			if (typeof j.state === "string") return { ok: true, state: j.state };
			last = `unexpected auth state (HTTP ${r.status})`;
		} catch (err) {
			last =
				err instanceof Error && err.name === "AbortError"
					? "readiness timed out"
					: err instanceof Error
						? err.message
						: String(err);
		} finally {
			clearTimeout(timer);
		}
		if (Date.now() >= deadline) {
			return { ok: false, why: `child did not answer: ${last.slice(0, 160)}` };
		}
		await new Promise((r) => setTimeout(r, Math.min(250, remaining)));
	}
}

const CHILD_LOG_CAP = 32 * 1024;

/** SIGTERM-to-SIGKILL grace for picker-spawned children (T133 review). */
export const CHILD_STOP_GRACE_MS = 3000;

/** Bounded capture of a spawned child's output (T133): kept bytes
 * plus a truncation mark; the drain never blocks the child. */
function drainToCap(stream: ReadableStream<Uint8Array> | null): {
	text: () => string;
} {
	let buf = "";
	let truncated = false;
	if (stream) {
		void (async () => {
			const reader = stream.getReader();
			const dec = new TextDecoder();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value && buf.length < CHILD_LOG_CAP)
					buf += dec.decode(value, { stream: true });
				else truncated = true;
			}
		})().catch(() => {});
	}
	return {
		text: () => (truncated ? `${buf}\n…(truncated)` : buf),
	};
}

/**
 * Default picker handoff (T133, D52): spawn this same entry point as
 * `routeros-muse start <dir> --no-open --port <free>` detached from
 * the request, with bounded log capture. The child serves the new
 * workspace on loopback; the browser lands on its lock screen (no
 * auto-login token). The child env is the package-fronted tools env
 * — no password in any form.
 */
export async function defaultLaunchWorkspaceServer(
	dir: string,
	port: number,
	tools: Record<string, string>,
	inherit?: { provider?: string; dataHome?: string },
): Promise<LaunchedWorkspace> {
	// The CLI entry, never the current entry point: an in-process
	// host (tests, smoke) has its own Bun.main, and spawning that
	// would re-run the host instead of serving the workspace.
	const root = packageRoot();
	const entry = root ? path.join(root, "src", "index.ts") : Bun.main;
	if (!entry)
		throw new Error("cannot spawn a workspace server without an entry point");
	// The child serves the same way its picker does (T133): same
	// provider (an echo picker spawns an echo child — no real muse
	// probe, hermetic), and the picker's effective data home so the
	// child registers where the picker does.
	const argv = [
		process.execPath,
		entry,
		"start",
		dir,
		"--no-open",
		"--port",
		String(port),
	];
	if (inherit?.provider) argv.push("--provider", inherit.provider);
	const proc = Bun.spawn(argv, {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: pickerChildEnv(tools, inherit?.dataHome),
	});
	const out = drainToCap(proc.stdout);
	const err = drainToCap(proc.stderr);
	const url = `http://127.0.0.1:${port}`;
	return {
		url,
		logs: () => `${out.text()}\n${err.text()}`.trim().slice(-2000),
		stop: async () => {
			// Two-phase: SIGTERM, then SIGKILL after a short grace.
			try {
				proc.kill();
			} catch {
				// Already gone; the stop is best-effort.
				return;
			}
			if (proc.exitCode !== null) return;
			await new Promise((r) => setTimeout(r, CHILD_STOP_GRACE_MS));
			if (proc.exitCode !== null) return;
			try {
				proc.kill("SIGKILL");
			} catch {
				// Gone during the grace window.
			}
		},
	};
}

/** Reachable LAN URLs for a port (external IPv4 only, no loopback/link-local). */
export function lanUrls(
	port: number,
	ifaces: Record<
		string,
		os.NetworkInterfaceInfo[] | undefined
	> = os.networkInterfaces(),
): string[] {
	const out: string[] = [];
	for (const addrs of Object.values(ifaces)) {
		for (const a of addrs ?? []) {
			if (a.family !== "IPv4" || a.internal) continue;
			if (a.address.startsWith("169.254.")) continue;
			out.push(`http://${a.address}:${port}/`);
		}
	}
	return [...new Set(out)].sort();
}

export function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * T101/D42: the permission profile for an access mode. Ask first
 * (promptUnmatched) runs sandboxed under :ask-me; Allow all
 * (allowAll, also --yolo) runs unsandboxed under :unrestricted.
 * The legacy modes the access route still accepts (onRequest,
 * denyUnmatched) map to the sandboxed profile: only an explicit
 * Allow all lifts the sandbox. Never edits muse's settings.json —
 * the profile rides the wire (session/start + setPermissionProfile).
 */
export function profileForAccess(mode: string): ":ask-me" | ":unrestricted" {
	return mode === "allowAll" ? ":unrestricted" : ":ask-me";
}

/** Context percent from a usage event; null when the basis has no limit. */
export function contextPercent(used: unknown, window: unknown): number | null {
	if (typeof used === "number" && typeof window === "number" && window > 0) {
		return Math.min(100, Math.round((used / window) * 100));
	}
	return null;
}

export type ServerHandle = {
	url: string;
	urls: string[];
	port: number;
	hostname: string;
	/**
	 * T106: the dedicated ui_* relay listener (own 127.0.0.1
	 * ephemeral port). Tests speak the relay here; the UI
	 * listener no longer serves the route.
	 */
	relayUrl: string;
	stop: () => Promise<void>;
};

type ChatMsg = { role: "user" | "agent"; text: string };

/** One structured transcript row (T37). Messages carry role+text; every
 *  other MSP kind carries the card fields its renderer needs, and
 *  unknown kinds fall back to kind+status+text (SS4.10). Refs are
 *  opaque `item/readOutput` handles for open-in-tab. */
export type TranscriptItem = {
	kind: string;
	role?: "user" | "agent";
	text?: string;
	/** T49: device chips parsed from the user row's preamble block. */
	targets?: TargetChip[];
	tool?: string;
	status?: string;
	hint?: string;
	output?: string;
	failureReason?: string;
	patch?: { added: number; removed: number; files: number };
	itemId?: string;
	outputRef?: string;
	outputBytes?: number;
	patchRef?: string;
	truncated?: boolean;
	objective?: string;
	childSessionId?: string;
	resultSummary?: string;
	controlStatus?: string;
};

const HINT_KEYS = [
	"command",
	"cmd",
	"path",
	"file_path",
	"filePath",
	"query",
	"url",
];

/** Short human hint for a toolCall, parsed from the verbatim args JSON. */
function toolHint(tool: string, args: unknown): string {
	if (typeof args !== "string" || !args) return tool;
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		for (const key of HINT_KEYS) {
			const v = parsed[key];
			if (typeof v === "string" && v.trim()) {
				const oneLine = v.trim().split("\n")[0] ?? "";
				return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
			}
		}
	} catch {
		// model-emitted almost-JSON: fall through to the bare tool name
	}
	return tool;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v ? v : undefined;
}

/** Fold a view page into chronological transcript rows (latest revision wins). */
export function transcriptItems(events: ViewEvent[]): TranscriptItem[] {
	const items = new Map<string, Record<string, unknown>>();
	// Pages ascend by cursor in both directions; backward just takes the tail.
	for (const ev of events) {
		if (ev.method === "item/completed" || ev.method === "item/updated") {
			const item = (ev.params as Record<string, unknown>)["item"] as
				| Record<string, unknown>
				| undefined;
			const id = item?.["itemId"] ?? item?.["id"];
			if (item && typeof id === "string") items.set(id, item);
		}
	}
	const out: TranscriptItem[] = [];
	for (const item of items.values()) {
		const kind = typeof item["kind"] === "string" ? item["kind"] : "unknown";
		const id = str(item["itemId"] ?? item["id"]);
		const status = str(item["status"]);
		if (kind === "userMessage" || kind === "agentMessage") {
			const text = str(item["text"]);
			if (!text) continue;
			if (kind === "agentMessage") {
				// An agent quoting the tag is its own voice and
				// stays verbatim — the preamble strip is user-only.
				out.push({ kind, role: "agent", text });
				continue;
			}
			// T49: the send route prepends target context to the stored
			// user text; rows show the prose plus chips, never the raw
			// preamble. History and live SSE share this mapper, so one
			// strip point covers both — and chips survive reload.
			const parsed = parseTargetPreamble(text);
			const row: TranscriptItem = {
				kind,
				role: "user",
				text: parsed.text,
			};
			if (parsed.targets.length > 0) row.targets = parsed.targets;
			out.push(row);
			continue;
		}
		if (kind === "toolCall") {
			const tool = str(item["tool"]) ?? "tool";
			const row: TranscriptItem = {
				kind,
				tool,
				status,
				hint: toolHint(tool, item["args"]),
			};
			if (id) row.itemId = id;
			const output = str(item["visibleOutput"]);
			if (output) row.output = output;
			const failure = str(item["failureReason"]);
			if (failure) row.failureReason = failure;
			const ps = item["patchSummary"] as Record<string, unknown> | undefined;
			if (
				ps &&
				typeof ps["added"] === "number" &&
				typeof ps["removed"] === "number" &&
				typeof ps["files"] === "number"
			) {
				row.patch = {
					added: ps["added"],
					removed: ps["removed"],
					files: ps["files"],
				};
			}
			const oref = item["outputRef"] as Record<string, unknown> | undefined;
			if (
				oref &&
				oref["availability"] === "available" &&
				typeof oref["id"] === "string"
			) {
				row.outputRef = oref["id"];
				if (typeof oref["byteLen"] === "number")
					row.outputBytes = oref["byteLen"];
			}
			const pref = item["patchRef"] as Record<string, unknown> | undefined;
			if (
				pref &&
				pref["availability"] === "available" &&
				typeof pref["id"] === "string"
			) {
				row.patchRef = pref["id"];
			}
			if (item["truncated"] === true) row.truncated = true;
			out.push(row);
			continue;
		}
		if (kind === "subagent") {
			const row: TranscriptItem = { kind, status };
			if (id) row.itemId = id;
			const objective = str(item["objective"]);
			if (objective)
				row.objective =
					objective.length > 300 ? `${objective.slice(0, 300)}…` : objective;
			const role = str(item["role"]);
			if (role) row.hint = role;
			const child = str(item["childSessionId"]);
			if (child) row.childSessionId = child;
			const result = item["result"] as Record<string, unknown> | undefined;
			const summary = result ? str(result["summary"]) : undefined;
			if (summary) row.resultSummary = summary;
			const control = str(item["controlStatus"]);
			if (control) row.controlStatus = control;
			const fallback = str(item["fallbackText"]);
			if (fallback && !objective && !summary) row.text = fallback;
			out.push(row);
			continue;
		}
		// Generic card: kind name + status + the best text the kind offers.
		const summary = Array.isArray(item["summary"])
			? item["summary"]
					.filter((s): s is string => typeof s === "string")
					.join("\n")
			: undefined;
		const text =
			str(item["fallbackText"]) ??
			str(item["text"]) ??
			summary ??
			str(item["objective"]) ??
			"";
		const row: TranscriptItem = { kind, status, text };
		if (id) row.itemId = id;
		out.push(row);
	}
	return out;
}

const UI_PATH = new URL("./ui.html", import.meta.url);

/**
 * Restart line for open-in-place (T40): the server binds its root at
 * boot, so opening another workspace is a restart at that path — the
 * picker shows this command instead of pretending to switch live.
 */
export function serveCommand(workspaceDir: string): string {
	const quoted = `"${workspaceDir.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	const root = packageRoot();
	if (root) return `bun ${path.join(root, "src", "index.ts")} serve ${quoted}`;
	return `routeros-muse serve ${quoted}`;
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

/**
 * T49 target preamble: exactly one line per device, data-quoted —
 * the payload is JSON built ONLY from validated inventory fields
 * (id/label/host/model), never user, cdb, or anything
 * credential-shaped. JSON quoting neutralizes brackets, parens,
 * quotes, and newlines, so hostile fields round-trip exactly.
 */
const TARGET_CONTEXT_PREFIX = "[routeros-muse context] target device: ";

export function targetPreambleLines(devices: Device[]): string[] {
	return devices.map((d) => {
		const name = typeof d.label === "string" && d.label ? d.label : d.id;
		const payload: Record<string, string> = { id: d.id, name };
		if (typeof d.host === "string" && d.host) payload["host"] = d.host;
		if (typeof d.model === "string" && d.model) payload["model"] = d.model;
		return `${TARGET_CONTEXT_PREFIX}${JSON.stringify(payload)}`;
	});
}

/**
 * Send-time forgery neutralizer: any user line starting with the
 * context tag (after optional whitespace) gets a backslash before
 * the bracket, so the agent sees escaped user text — never server
 * context. The display never un-escapes; the backslash stays visible.
 */
const FORGED_CONTEXT_LINE = /^(\s*)\[routeros-muse context\]/;

export function escapeForgedContextLines(text: string): string {
	return text
		.split("\n")
		.map((line) =>
			FORGED_CONTEXT_LINE.test(line)
				? line.replace(FORGED_CONTEXT_LINE, "$1\\[routeros-muse context]")
				: line,
		)
		.join("\n");
}

export type TargetChip = { id: string; name: string; host?: string };

function chipFromPayload(obj: unknown): TargetChip | null {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
	const rec = obj as Record<string, unknown>;
	if (typeof rec["id"] !== "string") return null;
	const chip: TargetChip = {
		id: rec["id"],
		name:
			typeof rec["name"] === "string" && rec["name"] ? rec["name"] : rec["id"],
	};
	if (typeof rec["host"] === "string" && rec["host"]) chip.host = rec["host"];
	return chip;
}

function parseContextLine(line: string): TargetChip | null {
	if (!line.startsWith(TARGET_CONTEXT_PREFIX)) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(line.slice(TARGET_CONTEXT_PREFIX.length));
	} catch {
		return null;
	}
	return chipFromPayload(obj);
}

/**
 * End index (exclusive) of the balanced JSON object starting at
 * `from`, or -1. Braces inside strings never count, so hostile
 * labels round-trip exactly; only flat string-map payloads occur.
 */
function balancedJsonEnd(s: string, from: number): number {
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = from; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
		} else if (c === '"') inStr = true;
		else if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/**
 * T107 summary-only flattened form: the host flattens newline runs
 * to one space in session/list firstUserPrompt/title (live echo+meta
 * probes 2026-11-02), so the multi-line grammar cannot match —
 * JSON.parse chokes on the trailing prose — and the past-chat name
 * leaked the raw preamble. This parses that flattened image:
 * leading tag+JSON blocks joined by spaces. Callers must confine it
 * to session summaries whose provenance they have established;
 * transcript rows use the exact multi-line grammar only, because
 * sessions created outside this server's escaped send route can
 * contain the same single line as literal user text.
 */
function parseFlattenedPreamble(
	text: string,
): { targets: TargetChip[]; text: string } | null {
	const targets: TargetChip[] = [];
	let rest = text;
	for (;;) {
		if (!rest.startsWith(TARGET_CONTEXT_PREFIX)) break;
		if (rest[TARGET_CONTEXT_PREFIX.length] !== "{") return null;
		const end = balancedJsonEnd(rest, TARGET_CONTEXT_PREFIX.length);
		if (end < 0) return null;
		let chip: TargetChip | null;
		try {
			chip = chipFromPayload(
				JSON.parse(rest.slice(TARGET_CONTEXT_PREFIX.length, end)),
			);
		} catch {
			return null;
		}
		if (!chip) return null;
		targets.push(chip);
		const after = rest.slice(end);
		// No separator (bare block, or trailing spaces with no prose)
		// is not a generated turn input: verbatim, like the
		// multi-line no-separator stance.
		if (after === "") return null;
		const sep = /^[ \t]+/.exec(after);
		if (!sep) return null;
		const prose = after.slice(sep[0].length);
		if (prose === "") return null;
		rest = prose;
	}
	if (targets.length === 0) return null;
	return { targets, text: rest };
}

/**
 * Split a leading generated preamble block (grammar lines + one
 * blank separator) from the user prose. Anything else — escaped
 * forgeries, mid-text quotes, a block without its blank line —
 * stays verbatim with zero targets.
 */
export function parseTargetPreamble(text: string): {
	targets: TargetChip[];
	text: string;
} {
	const lines = text.split("\n");
	const targets: TargetChip[] = [];
	let i = 0;
	for (; i < lines.length; i++) {
		const chip = parseContextLine(lines[i] ?? "");
		if (!chip) break;
		targets.push(chip);
	}
	if (targets.length === 0) return { targets, text };
	if (i >= lines.length || lines[i] !== "") return { targets: [], text };
	return { targets, text: lines.slice(i + 1).join("\n") };
}

/**
 * Strip a leading generated preamble block (plus its blank
 * separator) so history never shows the raw context the send route
 * prepended. Grammar-exact: only tag + valid JSON object with a
 * string id counts — ordinary prose starting with the tag was
 * escaped at send and can no longer match.
 */
export function stripTargetPreamble(text: string): string {
	return parseTargetPreamble(text).text;
}

/**
 * Parse a session summary's first prompt. Multi-line summaries use
 * the exact grammar; single-line summaries may use the host's
 * flattened image. This is not a transcript parser: use it only for
 * summaries from sessions this server created.
 */
export function parseSessionSummaryPreamble(text: string): {
	targets: TargetChip[];
	text: string;
} {
	if (text.includes("\n")) return parseTargetPreamble(text);
	return parseFlattenedPreamble(text) ?? { targets: [], text };
}

export function stripSessionSummaryPreamble(text: string): string {
	return parseSessionSummaryPreamble(text).text;
}

/** T55: max relay request body (a ui_* call is a few hundred bytes). */
const RELAY_MAX_BYTES = 64 * 1024;

/** True for 127.0.0.0/8, ::1, and their IPv4-mapped forms. */
export function isLoopbackPeer(address: string | undefined): boolean {
	if (!address) return false;
	const a = address.startsWith("::ffff:") ? address.slice(7) : address;
	return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Read a request body as text, or null once it exceeds max bytes. */
async function readBodyCapped(
	req: Request,
	max: number,
): Promise<string | null> {
	const declared = Number(req.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > max) return null;
	if (!req.body) return "";
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function startServer(opts: ServeOpts): Promise<ServerHandle> {
	const noWs = opts.noWorkspace === true;
	if (noWs && opts.workspace !== undefined) {
		throw new Error("noWorkspace and workspace are mutually exclusive");
	}
	if (!noWs && opts.workspace === undefined) {
		throw new Error(
			"no workspace given (or pass noWorkspace for centrs/quickchr-only mode)",
		);
	}
	// No-workspace mode still needs a root for the MSP session: the
	// server's cwd, honestly labeled. Workspace file routes refuse.
	const root = noWs ? process.cwd() : path.resolve(opts.workspace as string);
	// P2-4: the workspaceRoot every session/start carries, realpath-
	// canonical. A session belongs to this server only when its own
	// workspaceRoot canonicalizes to the same value (same muse data
	// home, another workspace root is a foreign session).
	let canonicalRoot: string;
	try {
		canonicalRoot = nodeFs.realpathSync(root);
	} catch {
		canonicalRoot = root;
	}
	function sessionIsOurs(s: MspSession): boolean {
		const ws = s.workspaceRoot;
		if (typeof ws !== "string" || !ws) return false;
		let canon: string;
		try {
			canon = nodeFs.realpathSync(ws);
		} catch {
			return false;
		}
		return canon === canonicalRoot;
	}
	if (!noWs && !nodeFs.existsSync(path.join(root, "workspace.toml"))) {
		throw new Error(`not a workspace (no workspace.toml): ${root}`);
	}
	// Fail-closed CDB binding (T64): workspace mode always binds its
	// absolute device.cdb — even when the file is missing (centrs then
	// answers cdb/not-found, which routes to the setup overlay,
	// instead of silently reading the operator store). An explicit
	// cdbFile beats the binding in both modes. Only no-workspace mode without an
	// override resolves the operator default — that mode IS the
	// explicit operator-CDB selection (its purpose is the operator
	// CDB), so global-CDB use stays explicit-only everywhere.
	const cdbFile =
		opts.cdbFile ?? (!noWs ? path.join(root, "device.cdb") : null);
	const devCdbPath = !noWs ? path.join(root, "device.cdb") : null;
	const authCdb: AuthCdb =
		opts.cdbFile !== undefined
			? {
					file: opts.cdbFile,
					scope: "override",
					displayPath: opts.cdbFile,
				}
			: devCdbPath
				? { file: devCdbPath, scope: "workspace", displayPath: devCdbPath }
				: {
						file: null,
						scope: "default",
						displayPath: "~/.config/tikoci/winbox.cdb (centrs default)",
					};
	// T40 registry: serving a workspace (re-)registers it, so the
	// no-workspace picker lists real history. A registry write failure
	// warns but never blocks the boot.
	const regFile = registryFile(opts.dataHome);
	// T101 round 4 (D45): this workspace's private muse config
	// home — the XDG_CONFIG_HOME every worker spawns with, and
	// the only approval-policy.json we seed. Per workspace
	// (<dataHome>/routeros-muse/.muse-config/<workspace-id>);
	// no-workspace mode gets the fixed _no-workspace home. Tests
	// override it directly.
	const museCfgHome =
		opts.configHome ??
		privateConfigHome(opts.dataHome, noWs ? undefined : root);
	const defaultDir = defaultWorkspacesDir(opts.defaultWorkspaceDir);
	// T93: the picker create flow offers these templates (minimal
	// default); read once at boot from the package templates dir.
	const templates: TemplateMeta[] = listTemplates();
	if (!noWs) {
		try {
			registerWorkspace(regFile, path.basename(root), root);
		} catch (err) {
			console.error(
				`workspaces registry write failed (serving anyway): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	// T51/D26: every trilogy spawn (UI subprocesses and the MSP child)
	// runs under this package-fronted env, so all sides resolve the
	// identical package.json-pinned builds. toolBinDir is null when the
	// bundle is not installed: ambient PATH, honestly labeled.
	// T133 review P1: an inherited CENTRS_CDB_PASSWORD never rides
	// this base env — only an explicitly unlocked session password is
	// ever added (workerEnv), and spawned children never get one.
	const binDir = opts.toolBinDir ?? defaultToolBinDir();
	const tools = toolEnv(binDir);
	delete tools["CENTRS_CDB_PASSWORD"];
	const source: ToolSource = toolSource(binDir);
	// Lazy + cached: version detection spawns the trilogy (quickchr
	// version phones home), so only the first /api/status call pays it.
	let toolInfoCache: Promise<{
		source: ToolSource;
		binDir: string | null;
		versions: Installed;
	}> | null = null;
	function toolInfo(): Promise<{
		source: ToolSource;
		binDir: string | null;
		versions: Installed;
	}> {
		if (!toolInfoCache) {
			toolInfoCache = detectInstalled(tools).then((versions) => ({
				source,
				binDir,
				versions,
			}));
		}
		return toolInfoCache;
	}
	const sessions = createSessionStore();
	// T133 review: per-path CDB mutation mutex (encrypt race) plus
	// every workspace child this picker spawned (orphan cleanup).
	const cdbMutex = createCdbMutex();
	const children = new Set<LaunchedWorkspace>();
	// Round 3 finding D: picker shutdown. Set first in stop();
	// launches that start after it are refused, launches in flight
	// are awaited (bounded) and kill any child they produced.
	let pickerStopping = false;
	const inFlightLaunches = new Set<Promise<void>>();
	/** stop() waits this long for in-flight launches before killing. */
	const STOP_LAUNCH_WAIT_MS = 60_000;
	let metaAuth: MetaAuth = "unknown";
	const uiHtml = await Bun.file(UI_PATH).text();
	const provider =
		opts.provider ?? process.env["ROUTEROS_MUSE_PROVIDER"] ?? "meta";
	// D39: the worker loads the workspace AGENTS.md + .agents/skills
	// only under --trust-workspace. Default on; the start flag opts
	// out; no-workspace mode has no workspace to trust. Every
	// `muse serve` spawn (worker + auth probes) carries the same args.
	const trustWorkspace = !noWs && opts.trustWorkspace !== false;
	const mspExtraArgs = trustWorkspace ? ["--trust-workspace"] : [];
	// T55/D41 + T106: the per-session MCP relay credentials. The
	// token is minted fresh per server run (tests override it);
	// the bridge reaches the DEDICATED relay listener below (its
	// own 127.0.0.1 ephemeral port) over loopback even when the UI
	// itself is LAN-bound.
	const mcpToken = opts.mcpToken ? opts.mcpToken : mintMcpToken();
	const mcpBridge = fileURLToPath(
		new URL("../mcp/ui-bridge.ts", import.meta.url),
	);
	// T105/T112: the rosetta MCP bundle entry resolves once at
	// boot (absolute path, D26). A missing entry omits only that
	// server — the worker still starts — and warns once here, the
	// same honest-degradation shape toolInfo uses for missing
	// binaries.
	const trilogyPkgRoot =
		opts.packageRoot !== undefined ? opts.packageRoot : packageRoot();
	const trilogyResolved = {
		rosetta: rosettaEntry(trilogyPkgRoot) !== null,
	};
	// T112: centrs via CLI this phase; centrs MCP returns after GitHub (T111 password channel)
	for (const [name, entry] of [
		[ROSETTA_MCP_SERVER, rosettaEntry(trilogyPkgRoot)],
	] as const) {
		if (!entry) {
			console.error(
				`MCP server '${name}' omitted: bundle entry missing under ` +
					`${trilogyPkgRoot ?? "(unknown package root)"} — ` +
					`the worker still starts without it`,
			);
		}
	}
	// Only resolved servers' tools are seeded/reported (review fix).
	const resolvedSeedTools = seedToolNames(trilogyResolved);
	function mcpServers(): Record<string, McpServerConfig> {
		return sessionMcpServers({
			bridge: mcpBridge,
			bun: process.execPath,
			url: `http://127.0.0.1:${relay.port}/`,
			token: mcpToken,
			pkgRoot: trilogyPkgRoot,
		}).servers;
	}

	// MSP host: one client, one main session, lazy-started. Both inits
	// are promise-gated (single-flight): page load fires history + past
	// concurrently, and two racing spawns would split the drive grant
	// across two hosts (observed as sessionInUse on the first send).
	// T64: the worker is bound to the session token (or the bypass key)
	// that spawned it, and runs under that session's unlock context; a
	// new owner stops the previous worker before spawning.
	let mspPromise: Promise<MspClient> | null = null;
	let mspOwner: string | null = null;
	let mainPromise: Promise<string> | null = null;
	let mainOwner: string | null = null;
	let mainSettled = false;
	let msp: MspClient | null = null;
	let mainSession: string | null = null;
	// T71 stop lifecycle: the live run on the main session. runGeneration
	// starts at the boot time in ms (restart-monotonic: open tabs gate
	// late responses on it, so a counter reset to 0 would strand them;
	// the old server could only outrank it with more bumps than ms of
	// uptime) and bumps on every turnStart send, worker spawn/takeover,
	// stopWorker/lock, and effective force-stop; lastTurnId tracks the
	// live turn (cleared on its turn/completed). Stop pins its interrupt
	// to the live turn; force-stop pins itself to the generation the UI
	// saw when Stop was pressed.
	// Accepted residual: Date.now() is restart-monotonic unless the wall clock steps backwards.
	let runGeneration = Date.now();
	let lastTurnId: string | null = null;
	// Round 3: the send whose turnStart is in flight (sends serialize on
	// the lifecycle lock, so at most one). Notifications always forward
	// to SSE immediately, in wire order — never held. Only the run-state
	// bookkeeping waits: turn/completed ids seen while pending, so the
	// ack skips installing an already-finished turn (the bd957eb
	// stuck-turn guarantee without the buffer). stopQueued records a
	// Stop that landed mid-start; done resolves when the start settles
	// so Force can wait instead of claiming a ghost.
	type PendingStart = {
		worker: Promise<MspClient> | null;
		client: MspClient;
		completedIds: Set<string>;
		untypedCompleted: boolean;
		stopQueued: boolean;
		done: Promise<void>;
		resolveDone: () => void;
	};
	let pendingStart: PendingStart | null = null;
	// S3: a turn/start whose ack never answered (timeout, not a host
	// refusal) while its worker stayed alive. The turn may be live on
	// the worker, so the run is unresolved — history reports running
	// until a force-stop teardown resolves it — and Stop/Force route
	// through teardown instead of the (unknown) turn id.
	type UnresolvedStart = {
		worker: Promise<MspClient> | null;
		client: MspClient;
	};
	let unresolvedStart: UnresolvedStart | null = null;
	/** The live-run state /api/chat/stop uses, for history + swap answers. */
	function liveRun(): { running: boolean; turnId: string | null } {
		const pending = pendingStart !== null && pendingStart.worker === mspPromise;
		const unresolved =
			unresolvedStart !== null && unresolvedStart.worker === mspPromise;
		// While unresolved the tracked id is the previous turn's (the
		// live turn, if any, never acked an id) — report unknown.
		return {
			running: lastTurnId !== null || pending || unresolved,
			turnId: unresolved ? null : lastTurnId,
		};
	}
	// T60/T85 lifecycle lock: send holds it from main-resolve to
	// turn-start ack; a main swap (new/resume) holds it from the busy
	// check through publish. One promise chain, released in finally;
	// it never rejects (fn's own errors propagate to its caller).
	let lifecycleTail: Promise<void> = Promise.resolve();
	async function withLifecycleLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = lifecycleTail;
		let release!: () => void;
		lifecycleTail = new Promise<void>((r) => {
			release = r;
		});
		await prev;
		try {
			return await fn();
		} finally {
			release();
		}
	}
	// P1-3: bumped when a lock tears the worker down, so work queued
	// on the lifecycle lock can tell its owner is gone deterministically.
	let ownerGeneration = 0;
	/** P1-3: the ownership a lock-taker captured before queueing. */
	type LockEntry = {
		key: string;
		token: string | null;
		authed: boolean;
		gen: number;
	};
	function captureLockEntry(req: Request): LockEntry {
		const token = cookieToken(req);
		return {
			key: workerKey(req),
			token,
			authed: sessions.valid(token),
			gen: ownerGeneration,
		};
	}
	/**
	 * P1-3: re-validate a queued operation after it acquires the lifecycle
	 * lock (the auth gate's check, plus the owner generation). A refusal
	 * returns before any ensureMsp or spawn: 401 when the queued token
	 * was revoked, 409 when a live owner's worker was torn down under
	 * it (someone else's lock — retry on a fresh entry).
	 */
	function queuedStale(entry: LockEntry): {
		status: number;
		error: string;
		why: string;
	} | null {
		if (entry.authed && !sessions.valid(entry.token)) {
			return {
				status: 401,
				error: "revoked",
				why: "that session was locked while the request queued — unlock again",
			};
		}
		if (entry.gen !== ownerGeneration) {
			return {
				status: 409,
				error: "owner-changed",
				why: "ownership changed while the request queued — retry",
			};
		}
		return null;
	}
	// T60/T85: stops in flight (both routes count). Swaps refuse
	// while one runs — a swap mid-force-stop would yank the worker
	// the escalation is converging on.
	let stopInFlight = 0;
	async function withStopInFlight<T>(fn: () => Promise<T>): Promise<T> {
		stopInFlight += 1;
		try {
			return await fn();
		} finally {
			stopInFlight -= 1;
		}
	}
	let mspWhy: string | null = null;
	let contextPct: number | null = null;
	let contextPressure: string | null = null;
	let totalTokens: number | null = null;
	let lastModelId: string | null = null;
	let lastEffort: string | null = null;
	// T50/D38: the mode new main sessions start in. --yolo (the opt)
	// beats the stored setting for the run; without either, Ask
	// first (promptUnmatched) is the default. Read fresh at each
	// session start so a settings write applies to the next session.
	function defaultAccess(): ApprovalMode {
		return (
			opts.defaultApprovalMode ??
			readDefaultAccess(opts.dataHome) ??
			"promptUnmatched"
		);
	}
	let lastAccess: string | null = defaultAccess();
	// T101: the profile in effect (or the next session starts in).
	// Tracks session/start + setPermissionProfile responses and the
	// permissionProfileChanged fold — never null, like lastAccess.
	let lastProfile: string | null = profileForAccess(defaultAccess());
	// P1-2: which session+generation the cached settings were last
	// written for. Every settings mutation (and every publish) stamps
	// it; the settings-change notification folds below only apply
	// when the event's session and the live generation both match —
	// a stale echo never writes over the current main's state.
	let settingsStamp: { sid: string; gen: number } | null = null;
	function settingsCurrent(sid: unknown): boolean {
		return (
			settingsStamp !== null &&
			typeof sid === "string" &&
			sid === settingsStamp.sid &&
			sid === mainSession &&
			runGeneration === settingsStamp.gen
		);
	}
	// T101/D43: pre-seed report for /api/status. Workspace mode
	// fills this at boot; no-workspace mode stays null.
	type PreallowReport = {
		enabled: boolean;
		commands: string[];
		hosts: string[];
		/** T55: the seeded ui_* tools (namespaced), empty when off. */
		tools: string[];
		warnings: string[];
		configHome: string;
		/** Round 3: set when the private home itself was rejected. */
		homeError: string | null;
	};
	let preallow: PreallowReport | null = null;
	function preallowState(): PreallowReport | null {
		return preallow;
	}
	// Spawn-time home warnings (re-link failures) stash here and
	// drain into the next report; capped, workspace mode only.
	let homeWarnings: string[] = [];
	function stashHomeWarnings(more: string[]): void {
		homeWarnings = [...homeWarnings, ...more].slice(-8);
	}
	/**
	 * Run the D43/D45 seed and refresh the report. Never throws:
	 * seeding failures (unreadable file, unknown schema, lost
	 * races) land as warnings and the boot continues. Always
	 * ensures the private home first (both modes: workers need
	 * auth everywhere); fails closed — when the home itself is
	 * rejected, the seed is SKIPPED (never write through a link
	 * we refused) and the reason lands in homeError + warnings +
	 * the boot log. Each workspace seeds only its own
	 * router.toml hosts (D45, no union). No-workspace mode
	 * seeds the same resolved MCP tool rules (ui + trilogy, T105;
	 * same toggle) and reports them: commands/hosts stay empty, so
	 * the toggle can be seen and revoked there too (T106).
	 */
	function refreshPreallow(enabled: boolean): void {
		const warnings: string[] = [...homeWarnings];
		homeWarnings = [];
		let homeError: string | null = null;
		try {
			const home = ensurePrivateHome({
				privateHome: museCfgHome,
				dataHome: dataHomeDir(opts.dataHome),
			});
			warnings.push(...home.warnings);
		} catch (err) {
			homeError = err instanceof Error ? err.message : String(err);
			warnings.push(homeError);
			console.error(`private muse home unsafe, seeding skipped: ${homeError}`);
		}
		const hosts = enabled && !noWs ? workspaceHosts(root) : [];
		if (homeError === null) {
			try {
				const res = ensurePreallowReads({
					configHome: museCfgHome,
					...(noWs ? {} : { workspaceRoot: root }),
					hosts,
					enabled,
					seedTools: resolvedSeedTools,
				});
				warnings.push(...res.warnings);
			} catch (err) {
				warnings.push(err instanceof Error ? err.message : String(err));
			}
			if (!noWs) {
				// D45: warn-only same-workspace detection (never
				// load-bearing; the check itself never throws).
				const { warning } = checkServerPid(museCfgHome);
				if (warning !== null) warnings.push(warning);
			}
		}
		const commands = noWs ? [] : READ_COMMANDS.map((p) => p.join(" "));
		preallow = {
			enabled,
			commands,
			hosts,
			tools: enabled ? [...resolvedSeedTools] : [],
			warnings,
			configHome: museCfgHome,
			homeError,
		};
	}
	/**
	 * Re-ensure the private home (auth symlink) before a worker
	 * spawn. THROWS on an unsafe home: the caller must not spawn
	 * with it (fail closed — never fall back to the shared
	 * ~/.config/muse). Benign warnings still stash for the report.
	 */
	function ensureHomeOrThrow(): void {
		const home = ensurePrivateHome({
			privateHome: museCfgHome,
			dataHome: dataHomeDir(opts.dataHome),
		});
		stashHomeWarnings(home.warnings);
	}
	refreshPreallow(readPreallowReads(opts.dataHome));
	// T100: the preference is machine-wide; these files belong only to
	// this private worker home. POST saves it without touching a live chat.
	let skillsBundle: SkillsBundle | undefined;
	let skillsReport: RouterosSkillsReport = {
		enabled: readAutoRouterosSkills(opts.dataHome),
		revision: null,
		bundledCount: 0,
		staged: [],
		warnings: [],
		error: null,
	};
	let skillsVerification: SkillsVerification | null = null;
	let skillsStateVersion = 0;
	function skillsState() {
		const enabled = readAutoRouterosSkills(opts.dataHome);
		return {
			...skillsReport,
			version: ++skillsStateVersion,
			enabled,
			appliedEnabled: skillsReport.enabled,
			pending: enabled !== skillsReport.enabled,
			verification: skillsVerification,
		};
	}
	function prepareSkills(): void {
		const enabled = readAutoRouterosSkills(opts.dataHome);
		try {
			ensureHomeOrThrow();
			if (enabled && !skillsBundle) skillsBundle = loadRouterosSkills();
			skillsReport = stageRouterosSkills({
				privateHome: museCfgHome,
				enabled,
				bundle: skillsBundle,
			});
			skillsVerification = null;
		} catch (err) {
			skillsReport = {
				...skillsReport,
				enabled,
				error: err instanceof Error ? err.message : String(err),
			};
			throw err;
		}
	}
	// Keep Settings reachable even when delivery needs attention. A worker
	// spawn/new chat retries and refuses unsafe/incomplete delivery.
	try {
		prepareSkills();
	} catch {
		/* report carries the actionable error */
	}
	async function verifySkills(client: MspClient, sid: string): Promise<void> {
		if (!skillsReport.enabled || !skillsBundle) {
			emit({ method: "routeros-skills/changed", params: {} });
			return;
		}
		const snapshot = skillsReport;
		try {
			const mspCatalog = (await client.call(
				"skill/list",
				{ sessionId: sid },
				5_000,
			)) as Parameters<typeof compareRouterosCatalogs>[0]["msp"];
			if (!Array.isArray(mspCatalog?.skills))
				throw new Error("Muse did not return a skill catalog");
			const env = {
				...tools,
				XDG_CONFIG_HOME: museCfgHome,
				...(opts.museHome ? { XDG_DATA_HOME: opts.museHome } : {}),
			};
			const res = await run(
				[
					"muse",
					"skills",
					"list",
					"--workspace",
					root,
					...(trustWorkspace ? ["--trust-workspace"] : []),
					"--json",
				],
				{ env, timeoutMs: 10_000 },
			);
			if (!res.ok)
				throw new Error(
					"Muse full skill catalog check failed; run muse skills list --json with the private config home",
				);
			const cli = JSON.parse(res.stdout) as Parameters<
				typeof compareRouterosCatalogs
			>[0]["cli"];
			if (!Array.isArray(cli.skills) || !Array.isArray(cli.diagnostics))
				throw new Error("Muse returned an invalid full skill catalog");
			if (skillsReport === snapshot && msp === client) {
				skillsVerification = compareRouterosCatalogs({
					bundle: skillsBundle,
					staged: snapshot.staged,
					privateHome: museCfgHome,
					msp: mspCatalog,
					cli,
				});
			}
		} catch (err) {
			if (skillsReport === snapshot)
				skillsVerification = {
					loaded: [],
					workspaceOverrides: [],
					personalCopiesShadowed: 0,
					warnings: [
						`Skill verification unavailable: ${err instanceof Error ? err.message : String(err)}`,
					],
				};
		}
		emit({ method: "routeros-skills/changed", params: {} });
	}
	let sessionStartedAt: number | null = null;
	const sse = new Set<(line: string) => void>();

	function emit(obj: unknown): void {
		const line = `data: ${JSON.stringify(obj)}\n\n`;
		for (const send of sse) {
			try {
				send(line);
			} catch {
				// drop broken subscribers lazily on next write
			}
		}
	}

	/**
	 * Race p against ms; on timeout reject with err(). The timer is
	 * cleared either way, and a late p rejection stays handled by the
	 * race (no unhandled warnings). T71 graceful-stop interrupt cap.
	 */
	function withTimeout<T>(
		p: Promise<T>,
		ms: number,
		err: () => Error,
	): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const gate = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(err()), ms);
		});
		return Promise.race([p, gate]).finally(() => {
			if (timer !== null) clearTimeout(timer);
		});
	}

	/** T39: OAuth state flip, announced so the UI can gate the composer. */
	function setMeta(next: MetaAuth): void {
		if (metaAuth === next) return;
		metaAuth = next;
		emit({ method: "meta/authChanged", params: { meta: next } });
	}

	// SSE heartbeat (T45): Bun reaps connections idle past idleTimeout
	// (default 10s — it killed quiet streams mid-turn, the observed
	// "agent stalling": a lost turn/completed sticks Stop on forever).
	// Comment frames never reach onmessage; they only hold the stream.
	const hb = setInterval(() => {
		if (sse.size === 0) return;
		for (const send of sse) {
			try {
				send(": ping\n\n");
			} catch {
				// drop broken subscribers lazily on next write
			}
		}
	}, opts.heartbeatMs ?? 15_000);
	if (typeof (hb as unknown as { unref?: unknown }).unref === "function") {
		(hb as unknown as { unref: () => void }).unref();
	}

	/**
	 * Stop the MSP worker and drop its session/stats. Lock (T64) calls
	 * this for the token it revokes: the worker is stopped, its unlock
	 * context is dropped with the token, and nothing is implied about
	 * revoking credentials from a running child — there is no running
	 * child left. Past chats survive in the muse session store and
	 * resume from there (T60 seam).
	 */
	async function stopWorker(
		reason = "worker-stopped",
		broadcast = true,
	): Promise<void> {
		const prev = mspPromise;
		mspPromise = null;
		mspOwner = null;
		msp = null;
		// T71: the run dies with the worker (covers lock, which funnels here).
		runGeneration += 1;
		lastTurnId = null;
		// Round 3: a torn-down worker settles any pending start (its
		// turnStart is about to fail; Force waiters must not hang on it).
		if (pendingStart !== null) {
			const p = pendingStart;
			pendingStart = null;
			p.resolveDone();
		}
		// S3: an unresolved start dies with the worker it was captured on.
		unresolvedStart = null;
		// T81: only a published session dies with its worker. An
		// in-flight reservation (mainSettled false) survives the
		// stop, so its guard adopts the live generation instead of
		// re-stealing — nulling every reservation is what wedged
		// exact-overlap takeovers into alternating re-spawns.
		if (mainSettled) {
			mainPromise = null;
			mainOwner = null;
			mainSettled = false;
		}
		mainSession = null;
		mspWhy = null;
		contextPct = null;
		contextPressure = null;
		totalTokens = null;
		lastModelId = null;
		lastEffort = null;
		// T50: with no live session the truthful access is the mode
		// the next session starts in (what /api/chat/stats reports
		// pre-session) — never null, which the UI would read as the
		// wrong fallback. ensureMain restores the live mode after.
		// T101: same for the profile.
		lastAccess = defaultAccess();
		lastProfile = profileForAccess(defaultAccess());
		settingsStamp = null;
		sessionStartedAt = null;
		if (prev) {
			// run/state: every tab clears its running UI on this (Stop
			// hidden, Send back unless its main went stale). Only when a
			// worker actually went away — first-spawn calls with nothing
			// cached stay silent — and never on server shutdown (the
			// listener is already down; tabs must not chase the broadcast
			// with stats/pending fetches against it).
			if (broadcast)
				emit({ method: "run/state", params: { running: false, reason } });
			try {
				await (await prev).close();
			} catch {
				// already gone; the verdict stands
			}
		}
	}

	/**
	 * The worker exited on its own (crash, kill, EOF): invalidate the
	 * cached worker/main exactly like an intentional stop, so the next
	 * history/send spawns fresh instead of timing out on the corpse,
	 * and broadcast run/state so tabs clear their running UI. The
	 * mspPromise guard keeps exactly one emit: an intentional stopWorker
	 * nulls first, so a trailing exit lands here as a no-op.
	 */
	function handleWorkerExit(worker: Promise<MspClient>, reason: string): void {
		if (mspPromise !== worker) return;
		void stopWorker(reason);
	}

	/**
	 * Which worker owns this request: its valid session token, else the
	 * shared bypass worker. Only issued tokens get a worker — anything
	 * else admitted (open/missing + flag) shares bypass.
	 */
	function workerKey(req: Request): string {
		const token = cookieToken(req);
		return token && sessions.valid(token) ? token : "bypass";
	}

	/**
	 * Per-request centrs environment (T64): the package-fronted tools
	 * plus CENTRS_CDB_PASSWORD from the requesting session's unlock
	 * context. Anonymous/bypass requests get the tools alone.
	 */
	function envFor(req: Request): Record<string, string> {
		return workerEnv(
			tools,
			cdbFile,
			sessions.ctx(cookieToken(req))?.password ?? null,
		);
	}

	/**
	 * Fold one worker notification: live-turn tracking, meter folds,
	 * settings folds, and the SSE fan-out. Every notification forwards
	 * immediately, in wire order — never held. While a send's turnStart
	 * is in flight the listener additionally records turn/completed ids
	 * so the ack skips an already-finished turn; the fold itself still
	 * runs now (a pre-install completion for the new turn matches
	 * nothing, so the tracking stays correct).
	 */
	function handleMspNotification(ev: ViewEvent): void {
		if (ev.method === "turn/completed") {
			// T71: settle the live-turn tracking. Echo (verified by
			// wire probe) always carries the turnId; hosts that do
			// not fall back to clearing on any completion since
			// the main session runs one turn at a time. A
			// completion for an older turn never clears a newer one.
			const doneId = (ev.params as Record<string, unknown>)["turnId"];
			if (typeof doneId === "string") {
				if (doneId === lastTurnId) lastTurnId = null;
			} else {
				lastTurnId = null;
			}
			// T39 passive OAuth flip: only authRequired is evidence.
			const perr = (ev.params as Record<string, unknown>)["error"] as
				| Record<string, unknown>
				| undefined;
			if (perr?.["kind"] === "authRequired") setMeta("absent");
		}
		if (ev.method === "session/contextUsage") {
			// The wire sends used/window tokens, never a percent: compute it,
			// and show tokens-only when the basis has no limit.
			const p = ev.params as Record<string, unknown>;
			contextPct = contextPercent(p["usedTokens"], p["windowTokens"]);
			contextPressure =
				typeof p["pressure"] === "string" ? p["pressure"] : null;
		}
		if (ev.method === "session/tokenUsage") {
			const p = ev.params as Record<string, unknown>;
			const cum = p["cumulative"] as Record<string, unknown> | undefined;
			const total = cum?.["totalTokens"] ?? p["totalTokens"];
			if (typeof total === "number") totalTokens = total;
			if (typeof p["modelId"] === "string") lastModelId = p["modelId"];
		}
		if (ev.method === "session/approvalModeChanged") {
			// T50: the host is the truth for the live mode (it
			// echoes every session/start + setApprovalMode) —
			// P1-2: scoped to the stamped session+generation.
			const p = ev.params as Record<string, unknown>;
			if (typeof p["mode"] === "string" && settingsCurrent(p["sessionId"]))
				lastAccess = p["mode"];
		}
		if (ev.method === "session/permissionProfileChanged") {
			// T101: same fold for the profile (every
			// accepted setPermissionProfile commit) —
			// P1-2: scoped to the stamped session+generation.
			const p = ev.params as Record<string, unknown>;
			if (typeof p["profileId"] === "string" && settingsCurrent(p["sessionId"]))
				lastProfile = p["profileId"];
		}
		if (
			(ev.method === "item/started" ||
				ev.method === "item/updated" ||
				ev.method === "item/completed") &&
			(ev.params as Record<string, unknown>)["item"]
		) {
			// Live rows ride the same mapper as history: one shape, no drift.
			// Textless messages map to nothing (streaming bubble keys off the raw item).
			const rows = transcriptItems([
				{ method: "item/completed", params: ev.params },
			]);
			emit({
				method: ev.method,
				params: { ...ev.params, row: rows[0] ?? null },
			});
			return;
		}
		emit({ method: ev.method, params: ev.params });
	}

	function ensureMsp(key: string): Promise<MspClient> {
		if (mspPromise && mspOwner === key) return mspPromise;
		// New owner (or first spawn): stop any previous worker, then
		// spawn under the new owner's unlock context. stopWorker's
		// sync prefix runs now (captures + nulls); the spawn waits it.
		const stopping = stopWorker("takeover");
		mspOwner = key;
		// T71: every spawn/takeover starts a new run generation (the
		// stopWorker above already bumped for the teardown; this bump is
		// for the new worker — pins are equality-checked, so the double
		// bump is harmless).
		runGeneration += 1;
		lastTurnId = null;
		{
			const spawned = (async () => {
				await stopping;
				if (!have("muse", tools)) {
					mspWhy = "muse not on PATH";
					throw new Error(mspWhy);
				}
				try {
					ensureHomeOrThrow();
					prepareSkills();
				} catch (err) {
					mspWhy = err instanceof Error ? err.message : String(err);
					throw new Error(
						`refusing to spawn the muse worker: private home or bundled skills unavailable (${mspWhy})`,
					);
				}
				const client = await MspClient.spawn({
					provider,
					museHome: opts.museHome,
					museConfigHome: museCfgHome,
					mcpServers: mcpServers(),
					experimental: true,
					extraArgs: mspExtraArgs,
					env: workerEnv(tools, cdbFile, sessions.ctx(key)?.password ?? null),
				});
				client.onNotification((ev) => {
					// Round 3 (P2-C): every notification forwards
					// immediately, in wire order — never held
					// (approvals included). While a turnStart is
					// pending only the bookkeeping waits: record this
					// worker's turn/completed ids so the ack can skip
					// an already-finished turn.
					// A completion after the start went unresolved is
					// that turn ending (any id but the previously tracked
					// turn's): the run resolves without a teardown.
					if (
						unresolvedStart !== null &&
						unresolvedStart.worker === mspPromise &&
						ev.method === "turn/completed"
					) {
						const doneId = (ev.params as Record<string, unknown>)["turnId"];
						if (typeof doneId !== "string" || doneId !== lastTurnId)
							unresolvedStart = null;
					}
					if (
						pendingStart !== null &&
						pendingStart.worker === mspPromise &&
						ev.method === "turn/completed"
					) {
						const doneId = (ev.params as Record<string, unknown>)["turnId"];
						if (typeof doneId === "string")
							pendingStart.completedIds.add(doneId);
						else pendingStart.untypedCompleted = true;
					}
					handleMspNotification(ev);
				});
				msp = client;
				return client;
			})();
			mspPromise = spawned;
			// A worker that dies on its own invalidates + broadcasts
			// (run/state) instead of lingering as a corpse that times
			// out later view/page calls.
			spawned.then(
				(client) =>
					client.onExit(() => handleWorkerExit(spawned, "worker-exited")),
				() => {},
			);
			spawned.catch(() => {
				if (mspPromise === spawned) mspPromise = null;
			});
		}
		return mspPromise;
	}

	/**
	 * T60/T85: an honest swap refusal — the route maps it to its
	 * status, never a 500. Thrown from inside the swap body so the
	 * reservation restores the previous main on the way out.
	 */
	class SwapRefusal extends Error {
		status: number;
		error: string;
		why: string;

		constructor(status: number, error: string, why: string) {
			super(why);
			this.name = "SwapRefusal";
			this.status = status;
			this.error = error;
			this.why = why;
		}
	}

	/** T60/T85: map a swap-path MSP failure to an honest refusal. */
	function mspRefusal(err: MspError): {
		status: number;
		error: string;
		why: string;
	} {
		if (err.kind === "sessionNotFound" || err.kind === "notFound") {
			return {
				status: 404,
				error: "unknown-session",
				why: `that session is gone from this workspace (${err.message})`,
			};
		}
		if (err.kind === "sessionInUse") {
			return {
				status: 409,
				error: "session-in-use",
				why: "that session is held by another connection — close it there first",
			};
		}
		return {
			status: 400,
			error: "msp-error",
			why: `${err.kind}: ${err.message}`,
		};
	}

	/**
	 * T60/T85: the one session/start path. ensureMain (first session)
	 * and /api/chat/new (fresh session) both start here, so a new
	 * session always carries the settings currently in effect: the
	 * live approval mode + permission profile, the live model when
	 * one was chosen (a start member), the live effort via the
	 * setter (no start member exists), and the worker's MCP config
	 * (attached by the client itself). For ensureMain this is
	 * behavior-preserving: whenever it starts, live == default
	 * (stopWorker resets both together, and boot sets both).
	 */
	async function startMainSession(client: MspClient): Promise<{
		session: MspSession;
		viewCursor: string;
		approvalMode: ApprovalMode;
		permissionProfile: string;
	}> {
		// P1-2: snapshot the settings once, before the first await
		// (this runs inside the lifecycle lock; the settings routes
		// hold the same lock, so the snapshot cannot mix generations).
		const approvalMode = (lastAccess as ApprovalMode | null) ?? defaultAccess();
		const permissionProfile = lastProfile ?? profileForAccess(approvalMode);
		const snapModel = lastModelId;
		const snapEffort = lastEffort;
		prepareSkills();
		const started = await client.sessionStart({
			workspaceRoot: root,
			approvalMode,
			permissionProfile,
			...(snapModel ? { modelId: snapModel } : {}),
		});
		if (snapEffort !== null) {
			await client.sessionSetReasoningEffort(
				started.session.sessionId,
				snapEffort as ReasoningEffort,
			);
		}
		await verifySkills(client, started.session.sessionId);
		return { ...started, approvalMode, permissionProfile };
	}

	/**
	 * T60/T85: publish a session id as main. Shared by ensureMain
	 * and the swap: the mode/profile truth, a reset meter and age,
	 * and a run bump that retires every pre-swap stop-force pin.
	 * lastTurnId is untouched: it is null at every swap entry, and
	 * a send that landed mid-swap owns it now. lastModelId and
	 * lastEffort are untouched too — the new main carries them.
	 */
	function publishMain(
		sid: string,
		session: MspSession,
		requested: { approvalMode: ApprovalMode; permissionProfile: string },
	): void {
		mainSession = sid;
		// The session runs at this mode now; the host's
		// permissionState is the truth for the live profile, with
		// the requested one as the older-host fallback.
		lastAccess = requested.approvalMode;
		const live = session["permissionState"] as PermissionState | undefined;
		lastProfile =
			typeof live?.profileId === "string"
				? live.profileId
				: requested.permissionProfile;
		sessionStartedAt = Date.now();
		contextPct = null;
		contextPressure = null;
		totalTokens = null;
		runGeneration += 1;
		settingsStamp = { sid, gen: runGeneration };
		mainSettled = true;
		// P2-6: one event per publish, existing channel + envelope.
		// Every tab reloads off it (the swapping tab included).
		emit({
			method: "main/changed",
			params: { sessionId: sid, generation: runGeneration },
		});
	}

	type SwapRefusalOutcome = {
		ok: false;
		status: number;
		error: string;
		why: string;
	};
	type SwapOutcome = { ok: true; sessionId: string } | SwapRefusalOutcome;

	/**
	 * T60/T85: the swap busy check. The routes pre-check it (fast
	 * 409, and the no-op orders under it — a resume of the current
	 * main while running is refused, not no-op'd) and swapMain
	 * re-checks it inside the lock (authoritative: a turn may have
	 * started between the pre-check and the acquisition).
	 */
	function busyRefusal(): SwapRefusalOutcome | null {
		if (lastTurnId !== null) {
			return {
				ok: false,
				status: 409,
				error: "turn-running",
				why: "a turn is still running — press Stop first, then switch sessions",
			};
		}
		// S3: an unresolved start may hold a live turn on the worker —
		// swapping under it would orphan the turn onto a past session.
		if (unresolvedStart !== null && unresolvedStart.worker === mspPromise) {
			return {
				ok: false,
				status: 409,
				error: "turn-running",
				why: "a turn start never answered — press Stop first, then switch sessions",
			};
		}
		if (stopInFlight > 0) {
			return {
				ok: false,
				status: 409,
				error: "stop-in-progress",
				why: "a stop is still in progress — wait for Stop to settle, then switch sessions",
			};
		}
		return null;
	}

	/**
	 * T60/T85: atomically swap which session is main. The body holds
	 * the lifecycle lock from the busy check through publish, so a
	 * send's turnStart can never slip onto the old main mid-swap —
	 * sends arriving mid-swap await the reservation and land on the
	 * new main instead. Queued swaps serialize (each sees the
	 * previous one's settled main); only a swap racing an
	 * in-flight ensureMain is refused (409 session-starting).
	 *
	 * On failure the previous main is restored and mid-swap waiters
	 * resolve to it, while the route reports the refusal. A stale
	 * continuation (owner/worker moved on — the lock/takeover race)
	 * clears its own claim and throws: it never adopts anything,
	 * and never restores a dead generation's main.
	 */
	async function swapMain(
		key: string,
		work: (client: MspClient) => Promise<{
			session: MspSession;
			approvalMode: ApprovalMode;
			permissionProfile: string;
		}>,
		entry?: LockEntry,
	): Promise<SwapOutcome> {
		return withLifecycleLock(async () => {
			// P1-3: a queued swap re-validates its owner after
			// acquiring the lock — before any ensureMsp or spawn.
			if (entry) {
				const stale = queuedStale(entry);
				if (stale) return { ok: false, ...stale };
			}
			const busy = busyRefusal();
			if (busy) return busy;
			if (mainPromise && mainOwner === key && !mainSettled) {
				return {
					ok: false,
					status: 409,
					error: "session-starting",
					why: "the main session is still starting — retry in a moment",
				};
			}
			// The restore target: only a settled main of this owner
			// can come back (a stale generation never restores).
			const prevPromise =
				mainPromise && mainOwner === key && mainSettled ? mainPromise : null;
			let outcome: SwapOutcome | null = null;
			const starting = (async (): Promise<string> => {
				const isMine = (): boolean => mainPromise === starting;
				const guardOk = (): boolean =>
					isMine() && mainOwner === key && mspOwner === key;
				const failStale = (): never => {
					if (isMine()) {
						mainPromise = null;
						mainOwner = null;
					}
					throw new Error("main session changed during switch");
				};
				try {
					const client = await ensureMsp(key);
					if (!guardOk()) failStale();
					const produced = await work(client);
					if (!guardOk()) failStale();
					publishMain(produced.session.sessionId, produced.session, {
						approvalMode: produced.approvalMode,
						permissionProfile: produced.permissionProfile,
					});
					return produced.session.sessionId;
				} catch (err) {
					if (!guardOk()) {
						// Stale (or torn down mid-work): clear the
						// own claim and fail cleanly — never adopt,
						// never restore the dead generation.
						if (isMine()) {
							mainPromise = null;
							mainOwner = null;
						}
						throw err;
					}
					if (
						(err instanceof SwapRefusal || err instanceof MspError) &&
						prevPromise
					) {
						// Honest failure with a live previous main:
						// restore it, resolve mid-swap waiters onto
						// it, and hand the route the refusal.
						mainPromise = prevPromise;
						mainOwner = key;
						mainSettled = true;
						outcome =
							err instanceof SwapRefusal
								? {
										ok: false,
										status: err.status,
										error: err.error,
										why: err.why,
									}
								: { ok: false, ...mspRefusal(err) };
						return prevPromise;
					}
					if (isMine()) {
						mainPromise = null;
						mainOwner = null;
					}
					throw err;
				}
			})();
			mainPromise = starting;
			mainOwner = key;
			mainSettled = false;
			starting.catch(() => {
				if (mainPromise === starting) {
					mainPromise = null;
					mainOwner = null;
				}
			});
			const sid = await starting;
			return outcome ?? { ok: true, sessionId: sid };
		});
	}

	/**
	 * T81: the main session is bound to the worker owner that started
	 * it. A cached promise serves only its owner (same-key callers
	 * still single-flight); a stale starter adopts the live
	 * generation when one exists, and only re-enters when nothing
	 * live is left to adopt. Convergence: reserves are synchronous,
	 * so at most one null-observer recurses per null window — every
	 * later waker sees its reservation and adopts — and a
	 * recurse-then-takeover happens only when nothing live exists to
	 * adopt.
	 */
	function ensureMain(key: string): Promise<string> {
		if (mainPromise && mainOwner === key) return mainPromise;
		const starting = (async () => {
			// Deferred identity check: naming `starting` at this
			// body's top level trips tsc's use-before-assign (the
			// body starts running before the const is assigned),
			// while the guard only runs after an await.
			const isMine = (): boolean => mainPromise === starting;
			const client = await ensureMsp(key);
			if (!isMine() || mainOwner !== key || mspOwner !== key) {
				const cur = mainPromise;
				// Adopt the live generation; only a null-or-self
				// cache re-enters (clearing any own claim first, so
				// the recurse never awaits its own promise).
				if (cur && !isMine()) return cur;
				if (isMine()) {
					mainPromise = null;
					mainOwner = null;
				}
				return ensureMain(key);
			}
			const started = await startMainSession(client);
			if (!isMine() || mainOwner !== key || mspOwner !== key) {
				const cur = mainPromise;
				if (cur && !isMine()) return cur;
				if (isMine()) {
					mainPromise = null;
					mainOwner = null;
				}
				return ensureMain(key);
			}
			publishMain(started.session.sessionId, started.session, {
				approvalMode: started.approvalMode,
				permissionProfile: started.permissionProfile,
			});
			return started.session.sessionId;
		})();
		mainPromise = starting;
		mainOwner = key;
		mainSettled = false;
		starting.catch(() => {
			if (mainPromise === starting) {
				mainPromise = null;
				mainOwner = null;
			}
		});
		return mainPromise;
	}

	async function historyOf(
		key: string,
		sessionId: string,
	): Promise<{ messages: ChatMsg[]; count: number; items: TranscriptItem[] }> {
		const client = await ensureMsp(key);
		const page = await client.viewPage({
			sessionId,
			limit: 200,
			direction: "backward",
		});
		const items = transcriptItems(page.events);
		const messages: ChatMsg[] = [];
		for (const item of items) {
			if (
				(item.kind === "userMessage" || item.kind === "agentMessage") &&
				item.text
			) {
				messages.push({
					role: item.kind === "userMessage" ? "user" : "agent",
					text: item.text,
				});
			}
		}
		return { messages, count: messages.length, items };
	}

	// T39: resolve the CDB mode once at boot; auth routes refresh it.
	// Echo needs no OAuth, so it starts authed; meta probes in the
	// background (a disposable turn — fast-fail when logged out).
	let cdbModeState: { mode: CdbMode; why?: string } = await detectCdbMode(
		authCdb.file,
		tools,
	);
	// Round 3 finding C: a monotonic CDB generation. Every CDB
	// mutation bumps it; a detection result can only write the
	// cache when the generation hasn't changed since that
	// detection started — so an auth-state read straddling an
	// encrypt cannot restore a stale "open" over the fresh
	// "encrypted" and reopen the bypass.
	let cdbGeneration = 0;
	function noteCdbMutation(): void {
		cdbGeneration += 1;
	}
	function cacheCdbMode(
		live: { mode: CdbMode; why?: string },
		gen: number,
	): void {
		if (gen === cdbGeneration) cdbModeState = live;
	}
	if (provider === "echo") {
		metaAuth = "authed";
	}

	// T106: the ui_* tools relay handler. The bridge POSTs
	// {token, tool, arguments}; the token is the only credential
	// (401 otherwise, never a tool result). Tool-level refusals
	// stay 200 ok:false so the bridge returns them as isError
	// results the agent can report back. Every accepted call fans
	// out as a ui/* SSE event the UI renders.
	async function relayResponse(
		req: Request,
		peer: string | undefined,
	): Promise<Response> {
		// Loopback peers only (defense in depth: the listener
		// itself binds 127.0.0.1, so only loopback can dial it —
		// the bind is the boundary, this check is not load-bearing).
		if (!isLoopbackPeer(peer)) {
			return json({ ok: false, why: "relay is loopback-only" }, 403);
		}
		// Bounded before parsing (and before the token
		// check): a tool call is a few hundred bytes.
		const raw = await readBodyCapped(req, RELAY_MAX_BYTES);
		if (raw === null) {
			return json({ ok: false, why: "relay body too large" }, 413);
		}
		let body: { token?: unknown; tool?: unknown; arguments?: unknown };
		try {
			body = JSON.parse(raw) as typeof body;
		} catch {
			return json({ ok: false, why: "relay body is not JSON" }, 400);
		}
		if (body === null || typeof body !== "object") {
			return json({ ok: false, why: "relay body is not an object" }, 400);
		}
		if (typeof body.token !== "string" || !tokensEqual(body.token, mcpToken)) {
			return json({ ok: false, why: "bad or missing relay token" }, 401);
		}
		const tool = stripMcpPrefix(typeof body.tool === "string" ? body.tool : "");
		const args = (
			body.arguments && typeof body.arguments === "object" ? body.arguments : {}
		) as Record<string, unknown>;
		if (tool === "ui_notify") {
			const text = args["text"];
			const level = args["level"];
			if (typeof text !== "string" || !text) {
				return json({ ok: false, why: "need {text}" });
			}
			if (
				level !== undefined &&
				level !== "info" &&
				level !== "warn" &&
				level !== "alert"
			) {
				return json({
					ok: false,
					why: `unknown level: ${String(level).slice(0, 40)} (want info|warn|alert)`,
				});
			}
			const shown = level === "warn" || level === "alert" ? level : "info";
			emit({
				method: "ui/notify",
				params: { text: text.slice(0, NOTIFY_TEXT_MAX), level: shown },
			});
			let cut = "";
			if (text.length > NOTIFY_TEXT_MAX) {
				cut = `… (truncated to ${NOTIFY_TEXT_MAX} chars)`;
			} else if (text.length > 120) {
				cut = "…";
			}
			return json({
				ok: true,
				result: `notified (${shown}): ${text.slice(0, 120)}${cut}`,
			});
		}
		if (tool === "ui_open") {
			if (noWs) return json({ ok: false, why: "no workspace attached" });
			const rel = args["path"];
			if (typeof rel !== "string" || !rel) {
				return json({ ok: false, why: "need {path}" });
			}
			const checked = resolveUiOpen(root, rel);
			if (!checked.ok) return json({ ok: false, why: checked.why });
			emit({
				method: "ui/open",
				params: { path: rel, kind: checked.kind },
			});
			return json({ ok: true, result: `opened ${rel}` });
		}
		if (tool === "ui_select_device") {
			if (noWs) return json({ ok: false, why: "no workspace attached" });
			const id = args["id"];
			if (typeof id !== "string" || !id) {
				return json({ ok: false, why: "need {id}" });
			}
			const dev = readDevices(root).find((d) => d.id === id);
			if (!dev) {
				return json({
					ok: false,
					why: `unknown device id: ${id.slice(0, 120)}`,
				});
			}
			emit({ method: "ui/select-device", params: { id } });
			return json({ ok: true, result: `selected ${id}` });
		}
		// T110: open the Add-device dialog prefilled with host/user.
		// Supported in both modes (no noWs refusal: the dialog saves
		// router.toml in workspace mode, CDB-only without one). The
		// host is display-only in the UI — never written from this
		// spelling unchecked — and both spellings re-validate at the
		// POST route (defense in depth: the route is directly
		// reachable). Returns ok:true on open only; the owner may
		// cancel, and saving is their click, so this never claims the
		// device was added.
		if (tool === "ui_add_device") {
			const host = args["host"];
			if (!validAddHost(host)) {
				return json({
					ok: false,
					why: "need {host} (letters, digits, dot, colon, dash, underscore, 1-255 chars; no spaces or metacharacters)",
				});
			}
			const userRaw = args["user"];
			if (userRaw !== undefined && userRaw !== "" && !validAddUser(userRaw)) {
				return json({
					ok: false,
					why: "bad {user} (letters, digits, dot, dash, underscore, 1-64 chars)",
				});
			}
			const idRaw = args["id"];
			if (idRaw !== undefined && idRaw !== "" && !validAddId(idRaw)) {
				return json({
					ok: false,
					why: "bad {id} (lowercase slug: [a-z0-9-], starts alnum, 1-64 chars)",
				});
			}
			const user = typeof userRaw === "string" ? userRaw : "";
			const id =
				typeof idRaw === "string" && idRaw !== "" ? idRaw : slugFromHost(host);
			emit({ method: "ui/add-device", params: { host, user, id } });
			return json({
				ok: true,
				result: `add-device dialog opened for ${host}`,
			});
		}
		return json({
			ok: false,
			why: `unknown ui tool: ${tool.slice(0, 120)}`,
		});
	}

	// T106: the relay rides its OWN loopback listener (ephemeral
	// port on 127.0.0.1), started and stopped with the main
	// server. The UI listener no longer serves the route at all, so
	// a --host 127.0.0.2 or LAN bind cannot break bridge calls and
	// the relay is never exposed past loopback. This listener
	// serves that one route only; everything else 404s here.
	// Created after the main listener below (relayAfter) so a
	// failed main bind cannot orphan it (codex re-review F1).
	let relay: ReturnType<typeof Bun.serve>;

	const host = opts.host ?? "127.0.0.1";
	const server = Bun.serve({
		hostname: host,
		port: opts.port ?? 0,
		// T45: the 10s default reaped quiet SSE streams and any slow route
		// (60s doctor run, cold spawn). 120s covers every run budget below.
		idleTimeout: 120,
		async fetch(req) {
			const url = new URL(req.url);
			const p = url.pathname;
			// Round 3 finding A: the same-origin guard runs CENTRALLY,
			// once, at the top of the /api dispatch, on EVERY request
			// whose method is not GET/HEAD/OPTIONS — never per-route,
			// so no mutation route can be left unguarded. The only
			// exemption is /api/mcp/relay (below: it 404s on this
			// listener; the dedicated relay listener is
			// token-authenticated for non-browser callers). JSON is
			// required centrally too, except BODYLESS_POST_PATHS.
			if (
				p.startsWith("/api/") &&
				req.method !== "GET" &&
				req.method !== "HEAD" &&
				req.method !== "OPTIONS" &&
				p !== "/api/mcp/relay"
			) {
				if (boundPort === undefined)
					return json({ ok: false, why: "server not bound" }, 500);
				const why = checkSameOrigin(
					req,
					{ host, port: boundPort, displayHost },
					{ requireJson: !BODYLESS_POST_PATHS.has(p) },
				);
				if (why) return json({ ok: false, why }, 403);
			}
			try {
				// T106: the relay route does not exist on this listener
				// at all (own 127.0.0.1 listener) — 404 before the auth
				// gate, locked or not.
				if (p === "/api/mcp/relay")
					return json({ ok: false, why: "not found" }, 404);
				// T39 whole-app gate: the shell and the state/unlock/lock
				// routes stay public so a locked browser can unlock;
				// everything else needs a session unless a passwordless
				// CDB (open or missing — neither has a secret to prove)
				// is explicitly bypassed.
				const authed = sessions.valid(cookieToken(req));
				const authBypass =
					(cdbModeState.mode === "open" || cdbModeState.mode === "missing") &&
					opts.allowOpenCdb === true;
				// T106: the relay is gone from this listener (own
				// 127.0.0.1 listener); nothing here stays public for it.
				const publicPath =
					p === "/" ||
					p === "/index.html" ||
					p === "/api/auth/state" ||
					p === "/api/auth/unlock" ||
					p === "/api/auth/encrypt" ||
					p === "/api/auth/create-cdb" ||
					p === "/api/auth/lock";
				if (!authBypass && !authed && !publicPath) {
					const code =
						cdbModeState.mode === "open"
							? "auth/open-cdb"
							: cdbModeState.mode === "missing"
								? "auth/missing"
								: cdbModeState.mode === "unavailable"
									? "auth/unavailable"
									: "auth/locked";
					return json({ ok: false, why: "auth required", code }, 401);
				}
				// No-workspace mode: file/tree/alert/render routes answer "n/a".
				// 200, not 400: a missing workspace is operational state, not a
				// malformed request — same envelope as everywhere else
				// ({devices: [], why}, {available: false}), and it keeps the
				// browser console clean so real errors stay visible.
				// Chat, devices (from the CDB), twins, and status stay live.
				if (
					noWs &&
					(p === "/api/tree" ||
						p === "/api/recents" ||
						p === "/api/file" ||
						p === "/api/toml" ||
						p === "/api/alerts" ||
						p === "/api/render" ||
						p === "/api/artifact")
				) {
					return json({ ok: false, why: "no workspace attached" });
				}
				if (p === "/" || p === "/index.html") {
					return new Response(uiHtml, {
						headers: { "content-type": "text/html; charset=utf-8" },
					});
				}
				if (p === "/api/auth/state") {
					// Fresh detection every call: the operator may have
					// encrypted mid-run, and the gate cache follows —
					// unless a mutation landed mid-detection (finding
					// C), in which case the cache keeps the fresher
					// mutation result and this response stays local.
					const gen = cdbGeneration;
					const live = await detectCdbMode(authCdb.file, envFor(req));
					cacheCdbMode(live, gen);
					const state = sessions.valid(cookieToken(req))
						? "unlocked"
						: live.mode === "encrypted"
							? "locked"
							: live.mode === "open"
								? opts.allowOpenCdb === true
									? "bypassed"
									: "open-needs-encryption"
								: live.mode === "missing"
									? opts.allowOpenCdb === true
										? "bypassed"
										: "missing"
									: "unavailable";
					return json({
						cdb: authCdb.scope,
						cdbFile: authCdb.displayPath,
						state,
						mode: live.mode,
						meta: metaAuth,
						// T133: the overlays show their pre-auth CDB
						// mutation forms only on a loopback bind.
						loopback: isLoopbackHost(host),
						...(live.why ? { why: live.why } : {}),
					});
				}
				if (p === "/api/auth/unlock" && req.method === "POST") {
					const body = (await req.json()) as { password?: unknown };
					if (typeof body.password !== "string" || body.password === "") {
						return json({ ok: false, why: "need {password}" }, 400);
					}
					const gen = cdbGeneration;
					const live = await detectCdbMode(authCdb.file, envFor(req));
					cacheCdbMode(live, gen);
					if (live.mode !== "encrypted") {
						return json(
							{
								ok: false,
								why: "no encrypted CDB to unlock",
								code:
									live.mode === "missing"
										? "auth/missing"
										: live.mode === "unavailable"
											? "auth/unavailable"
											: "auth/open-cdb",
							},
							400,
						);
					}
					const check = await verifyCdbPassword(
						authCdb.file,
						body.password,
						envFor(req),
					);
					if (!check.ok) {
						await new Promise((r) => setTimeout(r, 500));
						return json(
							{ ok: false, why: "wrong CDB password", code: check.code },
							401,
						);
					}
					const token = sessions.issue();
					sessions.bind(token, {
						cdbFile: authCdb.file,
						password: body.password,
					});
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: {
							"content-type": "application/json",
							"set-cookie": sessionCookieHeader(token),
						},
					});
				}
				// T133 pre-auth CDB mutations (D52): encrypt-now turns
				// an open CDB encrypted, create-cdb fills a missing
				// workspace registry encrypted. Both re-check the
				// live mode first and run only for their own mode —
				// never when encrypted. Loopback-only: setting the
				// credential-store password from an unauthenticated
				// endpoint must not cross the network.
				if (
					(p === "/api/auth/encrypt" || p === "/api/auth/create-cdb") &&
					req.method === "POST"
				) {
					if (!isLoopbackHost(host)) {
						return json(
							{
								ok: false,
								why: "refusing: CDB mutations need a loopback bind",
							},
							403,
						);
					}
					const body = (await req.json()) as { password?: unknown };
					if (typeof body.password !== "string" || body.password === "") {
						return json({ ok: false, why: "need {password}" }, 400);
					}
					const password = body.password;
					const alreadyEncrypted = (where: string) =>
						json(
							{
								ok: false,
								why: `refusing: the CDB is already encrypted (${where})`,
							},
							409,
						);
					// After a successful conversion the cached mode
					// flips to the re-detected encrypted state and the
					// bypass worker (if any) is stopped: anonymous
					// routes re-gate as locked from this response on.
					// The bump-then-write is atomic (no await between),
					// so reads that started mid-mutation can no longer
					// overwrite it (finding C).
					const afterMutation = async (reported: string | null) => {
						const live = await detectCdbMode(authCdb.file, envFor(req));
						noteCdbMutation();
						cdbModeState = live;
						if (mspOwner === "bypass") await stopWorker("cdb-encrypted");
						const scan = backupScanDir(authCdb.file, envFor(req), reported);
						if (!scan)
							return json({
								ok: true,
								retainedBackups: retainedBackupsWarning(),
							});
						return json({ ok: true, backups: listCdbBackups(scan) });
					};
					// Serialized per absolute CDB path: two concurrent
					// encrypt-now calls cannot both succeed with
					// different passwords. The loser re-detects inside
					// the lock and gets a 409 without running centrs.
					const key = authCdb.file
						? path.resolve(authCdb.file)
						: "operator-default";
					return await cdbMutex(key, async () => {
						// Invalidate in-flight detections first: any
						// read that started before this mutation must
						// not write the cache after it (finding C).
						noteCdbMutation();
						const live = await detectCdbMode(authCdb.file, envFor(req));
						cacheCdbMode(live, cdbGeneration);
						if (p === "/api/auth/encrypt") {
							if (live.mode === "encrypted") return alreadyEncrypted("encrypt");
							if (live.mode !== "open") {
								return json(
									{
										ok: false,
										why: `refusing: no open CDB to encrypt (mode: ${live.mode})`,
									},
									400,
								);
							}
							const done = await encryptOpenCdb(
								authCdb.file,
								password,
								envFor(req),
							);
							if (!done.ok) return json({ ok: false, why: done.why }, 500);
							return await afterMutation(done.cdbFile ?? null);
						}
						// create-cdb: the bound workspace path only (D32).
						if (authCdb.scope !== "workspace" || !authCdb.file) {
							return json(
								{
									ok: false,
									why: "refusing: create-cdb needs a bound workspace registry",
								},
								400,
							);
						}
						if (live.mode === "encrypted")
							return alreadyEncrypted("create-cdb");
						if (live.mode !== "missing") {
							return json(
								{
									ok: false,
									why: `refusing: a CDB already exists (mode: ${live.mode})`,
								},
								400,
							);
						}
						const done = await initEncryptedCdb(
							authCdb.file,
							password,
							envFor(req),
						);
						if (!done.ok) return json({ ok: false, why: done.why }, 500);
						return await afterMutation(done.cdbFile ?? null);
					});
				}
				if (p === "/api/auth/lock" && req.method === "POST") {
					// Worker-stop semantics (T64): revoke the token (which
					// drops its unlock context) and stop the MSP worker
					// bound to it. Chats resume via past sessions (T60
					// seam); the response never implies revocation from a
					// running child.
					const token = cookieToken(req);
					sessions.revoke(token);
					if (token && mspOwner === token) {
						// P1-3: queued work on the lifecycle lock invalidates
						// deterministically instead of respawning this owner.
						ownerGeneration += 1;
						await stopWorker("locked");
					}
					return new Response(JSON.stringify({ ok: true }), {
						headers: {
							"content-type": "application/json",
							"set-cookie": clearCookieHeader(),
						},
					});
				}
				if (p === "/api/auth/oauth-recheck" && req.method === "POST") {
					if (provider === "echo") {
						setMeta("authed");
						return json({ ok: true, meta: metaAuth });
					}
					const m = await probeMetaAuth(() => {
						// Round 3: the recheck probe runs in the
						// private home like every other spawn
						// (never the shared ~/.config/muse), and
						// never spawns with an unsafe one.
						ensureHomeOrThrow();
						return MspClient.spawn({
							provider,
							museHome: opts.museHome,
							museConfigHome: museCfgHome,
							// Disposable probe: no ui tools (a probe turn must
							// never emit a real UI action).
							mcpServers: {},
							extraArgs: mspExtraArgs,
							env: tools,
						});
					}, root);
					if (m !== "unknown") setMeta(m);
					return json({ ok: true, meta: metaAuth });
				}
				if (p === "/api/status") {
					let museVersion: string | null = null;
					// The probe resolves under the server's fronted
					// tools env (T50 spawn gate), never ambient PATH.
					if (have("muse", tools)) {
						const r = await run(["muse", "--version"], {
							timeoutMs: 10_000,
							env: tools,
						});
						museVersion = r.stdout.trim().split("\n")[0] || null;
					}
					return json({
						workspace: noWs ? null : root,
						mode: noWs ? "no-workspace" : "workspace",
						provider,
						muse: museVersion,
						msp: msp ? "connected" : mspWhy ? `unavailable: ${mspWhy}` : "lazy",
						mainSession,
						permissionProfile: lastProfile,
						preallow: preallowState(),
						routerosSkills: skillsState(),
						tools: await toolInfo(),
						trustWorkspace: noWs ? null : opts.trustWorkspace !== false,
					});
				}
				if (p === "/api/workspaces" && req.method === "GET") {
					const { entries, corrupt } = readRegistry(regFile);
					const workspaces: (RegistryEntry & { alive: boolean })[] =
						entries.map((e) => ({ ...e, alive: registryEntryAlive(e) }));
					return json({
						workspaces,
						defaultDir,
						templates,
						...(corrupt ? { corrupt: true } : {}),
					});
				}
				if (p === "/api/workspaces" && req.method === "POST") {
					const body = (await req.json()) as {
						action?: unknown;
						name?: unknown;
						template?: unknown;
						password?: unknown;
					};
					if (body.action === "prune") {
						const { removed } = pruneRegistry(regFile);
						// D45: no re-seed — this workspace's hosts
						// are its own router.toml, untouched by the
						// registry. (Each pruned workspace's own
						// home keeps its last seed, harmless: that
						// server is gone with it.)
						return json({ ok: true, removed });
					}
					// D52 handoff, shared by create and open: serve the
					// workspace in a detached child on a free loopback
					// port, wait for it, and hand the browser its URL.
					// This picker stays up and tracks the child so its
					// own stop() takes the child down with it. No
					// auto-login token — the browser lands on the
					// child's lock screen.
					const launch =
						opts.launchWorkspaceServer ??
						((d, p) =>
							defaultLaunchWorkspaceServer(d, p, tools, {
								provider,
								dataHome: dataHomeDir(opts.dataHome),
							}));
					// Round 3 finding E: open accepts any auth state the
					// child reports (locked, open-needs-encryption,
					// missing, bypassed) once it answers — an older
					// open-CDB or missing-CDB workspace still hands
					// off to its overlay. Create keeps requiring
					// locked: a fresh workspace must be encrypted.
					const launchAndTrack = async (
						dir: string,
						expectLocked = true,
					): Promise<
						{ ok: true; child: LaunchedWorkspace } | { ok: false; why: string }
					> => {
						// Finding D: refused once shutdown started.
						if (pickerStopping) return { ok: false, why: "server is stopping" };
						let flightDone!: () => void;
						const flight = new Promise<void>((r) => {
							flightDone = r;
						});
						inFlightLaunches.add(flight);
						try {
							let port: number;
							try {
								port = await pickFreePort();
							} catch (err) {
								return {
									ok: false,
									why: `no free port: ${err instanceof Error ? err.message : String(err)}`,
								};
							}
							let child: LaunchedWorkspace;
							try {
								child = await launch(dir, port);
							} catch (err) {
								return {
									ok: false,
									why: `workspace server did not start: ${err instanceof Error ? err.message : String(err)}`,
								};
							}
							// A create that completes during shutdown
							// kills the child it just produced instead
							// of leaking it (finding D).
							if (pickerStopping) {
								await child.stop().catch(() => {});
								return { ok: false, why: "server is stopping" };
							}
							children.add(child);
							const ready = await waitForChildReady(child.url);
							if (pickerStopping) {
								children.delete(child);
								await child.stop().catch(() => {});
								return { ok: false, why: "server is stopping" };
							}
							if (!ready.ok) {
								children.delete(child);
								await child.stop().catch(() => {});
								const logs = child.logs?.();
								return {
									ok: false,
									why: `${ready.why}${logs ? `: ${logs.slice(0, 500)}` : ""}`,
								};
							}
							if (expectLocked && ready.state !== "locked") {
								children.delete(child);
								await child.stop().catch(() => {});
								return {
									ok: false,
									why: `new workspace is not locked (state: ${ready.state})`,
								};
							}
							return { ok: true, child };
						} finally {
							flightDone();
							inFlightLaunches.delete(flight);
						}
					};
					if (body.action === "create") {
						if (typeof body.name !== "string" || !body.name) {
							return json(
								{ ok: false, why: 'need {action: "create", name}' },
								400,
							);
						}
						const template =
							typeof body.template === "string" && body.template
								? body.template
								: "minimal";
						if (!templates.some((t) => t.name === template)) {
							return json(
								{
									ok: false,
									why: `unknown template: ${template} (have: ${templates.map((t) => t.name).join(", ") || "none"})`,
								},
								400,
							);
						}
						// T133: new workspaces are created encrypted. The
						// password crosses this request body only — the
						// scaffold puts it in the centrs child env, and
						// the child server below never receives it.
						const password =
							typeof body.password === "string" ? body.password : "";
						if (!password) {
							return json(
								{
									ok: false,
									why: "need {password} (new workspaces are created encrypted)",
								},
								400,
							);
						}
						const made = await scaffoldWorkspace(
							defaultDir,
							body.name,
							envFor(req),
							template,
							{
								cdb: { kind: "encrypted", password },
							},
						);
						if (!made.ok) return json({ ok: false, why: made.why }, 400);
						const workspace = registerWorkspace(regFile, body.name, made.dir);
						// D45: no re-seed — the new workspace gets
						// its own home (and its own seed) when it
						// is served; ours is unchanged.
						const started = await launchAndTrack(made.dir);
						if (!started.ok) {
							// Partial success: the workspace exists and
							// is registered, only the launch failed.
							// The UI shows it as created-with-failed-
							// launch and offers Retry (the open action
							// below runs this same spawn+redirect).
							return json({
								ok: false,
								created: true,
								workspace,
								command: serveCommand(made.dir),
								why: started.why,
							});
						}
						return json({
							ok: true,
							workspace,
							template,
							url: started.child.url,
						});
					}
					if (body.action === "open") {
						if (typeof body.name !== "string" || !body.name) {
							return json(
								{ ok: false, why: 'need {action: "open", name}' },
								400,
							);
						}
						const found = readRegistry(regFile).entries.find(
							(e) => e.name === body.name,
						);
						if (!found) {
							return json(
								{ ok: false, why: `unknown workspace: ${body.name}` },
								404,
							);
						}
						if (!registryEntryAlive(found)) {
							return json(
								{ ok: false, why: `not a workspace anymore: ${found.path}` },
								400,
							);
						}
						const workspace = registerWorkspace(
							regFile,
							found.name,
							found.path,
						);
						// Retry = open: the same spawn+redirect launch
						// as create. The restart command stays as the
						// fallback text when the launch itself fails.
						// Open takes any reported auth state (finding
						// E); only create requires locked.
						const started = await launchAndTrack(found.path, false);
						if (!started.ok) {
							return json(
								{
									ok: false,
									workspace,
									command: serveCommand(found.path),
									why: started.why,
								},
								500,
							);
						}
						return json({ ok: true, workspace, url: started.child.url });
					}
					return json(
						{ ok: false, why: "need {action: prune|create|open}" },
						400,
					);
				}
				if (p === "/api/tree") {
					const out: TreeEntry[] = [];
					walkTree(root, 0, out);
					// Artifact entries carry a sandbox tier HINT for
					// display; the viewer re-verifies via meta on open
					// and the route decides from the served bytes.
					// One memo per request: every artifact in a render
					// dir shares its single verification.
					const cx = {
						dataHome: opts.dataHome,
						cache: new Map<string, TierMemo>(),
					};
					const entries = out.map((e) =>
						isArtifactPath(e.path)
							? { ...e, tier: artifactTier(root, e.path, cx) }
							: e,
					);
					return json({ root, entries });
				}
				if (p === "/api/recents") {
					// One tier memo per request, as in /api/tree.
					const cx = {
						dataHome: opts.dataHome,
						cache: new Map<string, TierMemo>(),
					};
					return json({ recents: listRecents(root, cx) });
				}
				// T109 P1: chat-link preflight. Anchors in agent bubbles
				// preflight here before the UI opens anything: the gate is
				// resolveUiOpen (symlinks, credential stores, size), the
				// same check as the ui_open relay. Workspace mode only.
				if (p === "/api/open-check" && req.method === "POST") {
					if (noWs) return json({ ok: false, why: "no workspace attached" });
					// T109 re-review: malformed/null JSON and oversized
					// paths are 400s, never 500s.
					let body: unknown;
					try {
						body = await req.json();
					} catch {
						return json({ ok: false, why: "invalid json" }, 400);
					}
					if (
						body === null ||
						typeof body !== "object" ||
						typeof (body as { path?: unknown }).path !== "string"
					)
						return json({ ok: false, why: "need {path}" }, 400);
					const rel = (body as { path: string }).path;
					if (rel.length > 4096)
						return json({ ok: false, why: "path too long" }, 400);
					return json(resolveUiOpen(root, rel));
				}
				if (p === "/api/file" && req.method === "GET") {
					const rel = url.searchParams.get("path") ?? "";
					const res = readWorkspaceFile(root, rel);
					return json(res.body, res.status);
				}
				if (p === "/api/file" && req.method === "POST") {
					const body = (await req.json()) as {
						path?: string;
						text?: string;
						fromTomlEditor?: unknown;
					};
					if (typeof body.path !== "string" || typeof body.text !== "string") {
						return json({ ok: false, why: "need {path, text}" }, 400);
					}
					const res = writeWorkspaceFile(
						root,
						body.path,
						body.text,
						body.fromTomlEditor === true ? { fromTomlEditor: true } : undefined,
					);
					if (res.status === 200 && body.path === "router.toml") {
						// D45: this workspace's hosts feed its own
						// network rules — re-seed so dropped hosts
						// are pruned.
						refreshPreallow(readPreallowReads(opts.dataHome));
					}
					return json(res.body, res.status);
				}
				if (p === "/api/toml" && req.method === "GET") {
					const rel = url.searchParams.get("path") ?? "";
					const res = readTomlSections(root, rel);
					return json(res.body, res.status);
				}
				if (p === "/api/devices") {
					return json(
						await listDevices(noWs ? null : root, cdbFile, envFor(req)),
					);
				}
				if (p.startsWith("/api/devices/") && p.endsWith("/stats")) {
					const id = decodeURIComponent(
						p.slice("/api/devices/".length, -"/stats".length),
					);
					const res = await deviceStats(
						noWs ? null : root,
						id,
						cdbFile,
						envFor(req),
					);
					return json(res.body, res.status);
				}
				// T48 set-credentials modal: thin wrappers over the fleet
				// write helpers. GET reads the redacted record for modal
				// context; POST writes with the requesting session's bound
				// unlock (envFor) — the browser never sends the unlock
				// password, only the NEW credential, over loopback. Nothing
				// here logs bodies or argv (C13 guard).
				if (p.startsWith("/api/devices/") && p.endsWith("/credentials")) {
					const id = decodeURIComponent(
						p.slice("/api/devices/".length, -"/credentials".length),
					);
					let target: string | null;
					if (noWs) {
						target = id;
					} else {
						const listed = await listDevices(root, null, envFor(req));
						const device = listed.devices.find((s) => s.id === id);
						if (!device)
							return json({ ok: false, why: `no device ${id}` }, 404);
						if (!device.cdb) {
							return json(
								{
									ok: false,
									why: `device ${id} has no cdb link yet (add cdb = "<centrs-device>" to its [device])`,
								},
								400,
							);
						}
						target = device.cdb;
					}
					if (req.method === "GET") {
						const seen = await showCdbDevice(cdbFile, target, envFor(req));
						if (!seen.ok) {
							return json({
								ok: false,
								why: seen.why,
								...(seen.code ? { code: seen.code } : {}),
								...(seen.code === "cdb/not-found-target"
									? { missing: true }
									: {}),
							});
						}
						return json({ ok: true, details: seen.details });
					}
					if (req.method === "POST") {
						const body = (await req.json()) as {
							user?: unknown;
							password?: unknown;
							sshKey?: unknown;
							profile?: unknown;
							session?: unknown;
							expected?: unknown;
						};
						const field = (v: unknown): string | undefined =>
							typeof v === "string" ? v : undefined;
						const exp = body.expected as
							| CdbCredentialDetails
							| { missing: true }
							| null
							| undefined;
						const res = await setCdbCredentials(
							cdbFile,
							target,
							{
								user: field(body.user),
								password: field(body.password),
								sshKey: field(body.sshKey),
								profile: field(body.profile),
								session: field(body.session),
							},
							envFor(req),
							exp === undefined ? null : exp,
						);
						if (!res.ok && "conflict" in res) {
							return json(
								{
									ok: false,
									conflict: true,
									why: res.why,
									current: res.current,
								},
								409,
							);
						}
						if (!res.ok) {
							return json(
								{
									ok: false,
									why: res.why,
									...(res.code ? { code: res.code } : {}),
								},
								res.code === "cdb/stale-write-refused" ? 400 : 200,
							);
						}
						return json({
							ok: true,
							action: res.action,
							details: res.details,
						});
					}
					return json({ ok: false, why: "need GET or POST" }, 405);
				}
				// T110 add-device save: the owner typed the secret in the
				// UI modal (opened via the ui_add_device relay), so the
				// password rides this loopback POST body only (the same
				// accepted shape as T48) — never logged, never argv in
				// OUR code (setCdbCredentials' internal centrs argv is
				// the documented existing residual). Workspace mode
				// appends a [device] block to router.toml then creates
				// the CDB record; no-workspace mode is CDB-only. The
				// router.toml entry stays when the CDB write fails — the
				// card's Set credentials affordance is the recovery.
				if (p === "/api/devices/add" && req.method === "POST") {
					const body = (await req.json()) as {
						host?: unknown;
						user?: unknown;
						password?: unknown;
						sshKey?: unknown;
						profile?: unknown;
						session?: unknown;
						id?: unknown;
					};
					// Defense in depth: the route is directly reachable,
					// so it re-validates with the same validators as the
					// relay (ui-tools.ts).
					if (!validAddHost(body.host)) {
						return json({
							ok: false,
							why: "need {host} (letters, digits, dot, colon, dash, underscore, 1-255 chars; no spaces or metacharacters)",
						});
					}
					const host = body.host;
					const field = (v: unknown): string | undefined =>
						typeof v === "string" ? v : undefined;
					const user = field(body.user) ?? "";
					const password = field(body.password) ?? "";
					const sshKey = field(body.sshKey) ?? "";
					const profile = field(body.profile) ?? "";
					const session = field(body.session) ?? "";
					if (!user || !validAddUser(user)) {
						return json({
							ok: false,
							why: "need {user} (letters, digits, dot, dash, underscore, 1-64 chars)",
						});
					}
					if (!password && !sshKey) {
						return json({
							ok: false,
							why: "need {password} or {sshKey} (one secret to save)",
						});
					}
					const idRaw = field(body.id) ?? "";
					if (idRaw !== "" && !validAddId(idRaw)) {
						return json({
							ok: false,
							why: "bad {id} (lowercase slug: [a-z0-9-], starts alnum, 1-64 chars)",
						});
					}
					// No-workspace mode has no router.toml, so the id is
					// the CDB host target itself (the inventory key the
					// new card renders under).
					const id = noWs ? host : idRaw !== "" ? idRaw : slugFromHost(host);
					// Workspace mode: append the device block first.
					// Re-read immediately before write (C15 interim
					// stance, same as credentials) and refuse on an
					// unparseable file rather than appending blind.
					if (!noWs) {
						let current: string;
						try {
							current = nodeFs.readFileSync(
								path.join(root, "router.toml"),
								"utf8",
							);
						} catch {
							current = "";
						}
						// Parsed value drives the block form below; a
						// missing file starts empty.
						let v: Record<string, unknown> = {};
						if (current !== "") {
							const parsedNow = parseToml(current);
							if (!parsedNow.ok) {
								return json(
									{
										ok: false,
										stage: "router",
										id,
										why: "router.toml is unparseable; edit the file by hand",
									},
									409,
								);
							}
							v = (parsedNow.value ?? {}) as Record<string, unknown>;
						}
						const devices = readDevices(root);
						const byId = devices.find((d) => d.id === id);
						const coversHost = (d: Device): boolean =>
							d.cdb === host || (d.cdb === undefined && d.host === host);
						if (byId && (coversHost(byId) || byId.host === host)) {
							// Idempotent retry: same id+host (a legacy cdb
							// target differing from host is still this
							// device) — skip the append.
						} else if (byId) {
							return json(
								{
									ok: false,
									stage: "router",
									id,
									why: `device id ${id} already names a different host; pick another id`,
								},
								409,
							);
						} else if (devices.some((d) => d.id !== id && coversHost(d))) {
							return json(
								{
									ok: false,
									stage: "router",
									id,
									why: `host ${host} is already registered under another id; open that card instead`,
								},
								409,
							);
						} else {
							// Block form follows the file: a second [device]
							// table would be a duplicate-table error, so a
							// file that already names devices grows the
							// [[device]] array-of-tables shape instead (the
							// same shape readDevices and the suite use). A
							// lone [device] single table is promoted by
							// rewriting its header line only — every other
							// byte stays untouched. Anything more exotic
							// refuses honestly rather than appending blind.
							const entry = `id = "${id}"\nhost = "${host}"\ncdb = "${host}"\n`;
							let base = current;
							let header: string;
							if (Array.isArray(v["device"])) {
								header = "[[device]]";
							} else if (v["device"] && typeof v["device"] === "object") {
								const rewritten = current.replace(
									/^[ \t]*\[[ \t]*device[ \t]*\][ \t]*\r?$/m,
									"[[device]]",
								);
								if (rewritten === current) {
									return json(
										{
											ok: false,
											stage: "router",
											id,
											why: "router.toml [device] header is not in plain form; edit the file by hand",
										},
										409,
									);
								}
								base = rewritten;
								header = "[[device]]";
							} else if (Array.isArray(v["devices"])) {
								header = "[[devices]]";
							} else if (
								v["device"] !== undefined ||
								v["devices"] !== undefined
							) {
								return json(
									{
										ok: false,
										stage: "router",
										id,
										why: "router.toml device shape is not a table or array; edit the file by hand",
									},
									409,
								);
							} else {
								header = "[device]";
							}
							const sep = base === "" || base.endsWith("\n") ? "" : "\n";
							const next = `${base}${sep}\n${header}\n${entry}`;
							const parsedNext = parseToml(next);
							if (!parsedNext.ok) {
								return json(
									{
										ok: false,
										stage: "router",
										id,
										why: "router.toml is unparseable; edit the file by hand",
									},
									409,
								);
							}
							const written = writeWorkspaceFile(root, "router.toml", next);
							if (written.status !== 200) {
								const why =
									typeof (written.body as Record<string, unknown>)?.["why"] ===
									"string"
										? (written.body as Record<string, unknown>)["why"]
										: "router.toml write refused";
								return json(
									{ ok: false, stage: "router", id, why },
									written.status,
								);
							}
						}
					}
					// Then create the CDB record via the T48 creation
					// path ({missing:true}); never a parallel writer.
					const created = await setCdbCredentials(
						cdbFile,
						host,
						{
							user,
							...(password ? { password } : {}),
							...(sshKey ? { sshKey } : {}),
							...(profile ? { profile } : {}),
							...(session ? { session } : {}),
						},
						envFor(req),
						{ missing: true },
					);
					if (created.ok) {
						return json({ ok: true, id, action: created.action });
					}
					if ("conflict" in created) {
						// Retry after a half-finished first save: the record
						// exists. Re-run the helper with the fresh snapshot
						// (its own expected-snapshot semantics) — but only
						// when the record carries OUR user, so a retry never
						// overwrites a stranger's credentials. Otherwise the
						// 409 stands and the owner reviews in the modal.
						if (created.current.user === user) {
							const retried = await setCdbCredentials(
								cdbFile,
								host,
								{
									user,
									...(password ? { password } : {}),
									...(sshKey ? { sshKey } : {}),
									...(profile ? { profile } : {}),
									...(session ? { session } : {}),
								},
								envFor(req),
								created.current,
							);
							if (retried.ok) {
								return json({ ok: true, id, action: retried.action });
							}
							if ("conflict" in retried) {
								return json(
									{
										ok: false,
										stage: "cdb",
										id,
										conflict: true,
										why: retried.why,
										current: retried.current,
									},
									409,
								);
							}
							return json(
								{
									ok: false,
									stage: "cdb",
									id,
									why: retried.why,
									...(retried.code ? { code: retried.code } : {}),
								},
								retried.code === "cdb/stale-write-refused" ? 400 : 200,
							);
						}
						return json(
							{
								ok: false,
								stage: "cdb",
								id,
								conflict: true,
								why: created.why,
								current: created.current,
							},
							409,
						);
					}
					// Encrypted-CDB creation failures ride the envelope
					// honestly here — no workaround.
					return json(
						{
							ok: false,
							stage: "cdb",
							id,
							why: created.why,
							...(created.code ? { code: created.code } : {}),
						},
						created.code === "cdb/stale-write-refused" ? 400 : 200,
					);
				}
				if (p === "/api/twins") {
					return json(await listTwins(tools));
				}
				if (p === "/api/twins/doctor" && req.method === "POST") {
					return json(await doctorTwins(tools));
				}
				if (p === "/api/alerts") {
					return json(await listAlerts(root));
				}
				if (p === "/api/chat/send" && req.method === "POST") {
					// P1-3: capture the owner before validation awaits.
					const entry = captureLockEntry(req);
					const body = (await req.json()) as {
						text?: string;
						images?: { base64Data: string; mediaType: string }[];
						targets?: unknown;
						expectedSessionId?: unknown;
					};
					if (typeof body.text !== "string" || !body.text.trim()) {
						return json({ ok: false, why: "need {text}" }, 400);
					}
					if (metaAuth === "absent") {
						return json(
							{
								ok: false,
								why: "meta login required (run `muse login` in your terminal)",
								code: "auth/oauth-required",
							},
							403,
						);
					}
					// T49: validate pill targets against the same
					// inventory the device list shows (router.toml in
					// workspace mode, the CDB without one) and prepend
					// one context line per known id. Unknown ids drop
					// silently — a stale pill must never steer — and
					// the client-sent name/host are ignored: the line
					// is rebuilt from the inventory, never trusted.
					const seen = new Set<string>();
					const valid: Device[] = [];
					if (Array.isArray(body.targets)) {
						let inventory: Device[];
						if (noWs) {
							const listed = await listCdbDevices(
								cdbFile ?? undefined,
								envFor(req),
							);
							inventory = listed.ok ? listed.devices : [];
						} else {
							inventory = readDevices(root);
						}
						const byId = new Map(inventory.map((d) => [d.id, d]));
						for (const t of body.targets) {
							const id = (t as Record<string, unknown> | null)?.["id"];
							if (typeof id !== "string" || seen.has(id)) continue;
							seen.add(id);
							const dev = byId.get(id);
							if (dev) valid.push(dev);
						}
					}
					const preamble = targetPreambleLines(valid);
					// muse clips user text near 64 KiB; an oversized
					// block would arrive as broken JSON and break
					// history, so refuse it outright.
					if (preamble.join("\n").length > 8_192) {
						return json(
							{ ok: false, why: "target context exceeds 8192 characters" },
							400,
						);
					}
					// Forged context lines in the user text are
					// escaped before the real block is prepended,
					// so the agent can tell server context from
					// user prose that merely quotes the tag.
					const safe = escapeForgedContextLines(body.text);
					const text =
						preamble.length > 0 ? `${preamble.join("\n")}\n\n${safe}` : safe;
					const input: TurnInput[] = [{ type: "text", text }];
					for (const img of body.images ?? []) {
						input.push({
							type: "image",
							base64Data: img.base64Data,
							mediaType: img.mediaType,
						});
					}
					// T60/T85: the MSP section holds the lifecycle
					// lock from main-resolve to turn-start ack, so a
					// main swap can never slip between the two (a
					// turn starting on the old main mid-swap would
					// orphan onto a past session). Validation above
					// stays outside — and no longer spawns a
					// session just to refuse an oversized preamble.
					// The await is load-bearing: a bare promise
					// return would skip the outer catch (Bun's
					// default 500 instead of our JSON envelope).
					return await withLifecycleLock(async () => {
						// P1-3: re-validate after queueing, before any spawn.
						const stale = queuedStale(entry);
						if (stale) {
							return json(
								{ ok: false, error: stale.error, why: stale.why },
								stale.status,
							);
						}
						const sid = await ensureMain(entry.key);
						// P2-6: a tab pinned to an older main must reload, never
						// land on the wrong session. Unpinned sends (tests, curl)
						// skip the check. The current id rides along so the UI
						// can adopt it in the same round trip.
						if (
							typeof body.expectedSessionId === "string" &&
							body.expectedSessionId !== "" &&
							body.expectedSessionId !== sid
						) {
							const run = liveRun();
							return json(
								{
									ok: false,
									error: "main-changed",
									why: "the main session changed — your draft was kept; load the current chat, then send again",
									sessionId: sid,
									generation: runGeneration,
									running: run.running,
									turnId: run.turnId,
								},
								409,
							);
						}
						const client = await ensureMsp(entry.key);
						try {
							// Round 3 (P2-C/P2-D): track the in-flight
							// turnStart — its turn/completed ids (a
							// same-chunk completion would otherwise
							// install as live: the stuck turn) and a Stop
							// that lands mid-start. Notifications forward
							// immediately throughout.
							let resolveDone!: () => void;
							const done = new Promise<void>((r) => {
								resolveDone = r;
							});
							const pending: PendingStart = {
								worker: mspPromise,
								client,
								completedIds: new Set(),
								untypedCompleted: false,
								stopQueued: false,
								done,
								resolveDone,
							};
							pendingStart = pending;
							let turnId: string;
							try {
								({ turnId } = await client.turnStart({
									sessionId: sid,
									input,
								}));
							} catch (err) {
								if (pendingStart === pending) pendingStart = null;
								resolveDone();
								if (!(err instanceof MspError)) {
									// S3: an ambiguous ack failure (timeout) on
									// a live worker — the turn may have
									// started. Keep the run unresolved instead
									// of clearing to idle; a dead worker needs
									// no marker (the exit watcher answers).
									let alive = false;
									try {
										alive = !(await client.waitForExit(0));
									} catch {
										alive = false;
									}
									// A completion for any turn other than the
									// previously tracked one is this start's
									// turn finishing (one turn per session):
									// the run is over, not unresolved.
									const prevTurn = lastTurnId;
									const finished =
										pending.untypedCompleted ||
										[...pending.completedIds].some((id) => id !== prevTurn);
									if (alive && !finished && mspPromise === pending.worker) {
										unresolvedStart = {
											worker: pending.worker,
											client,
										};
										// Tell every tab: a completion may already
										// have hidden Stop, and Stop/Force are the
										// only way out of an unresolved start.
										emit({
											method: "run/state",
											params: { running: true, reason: "unresolved-start" },
										});
									}
								}
								throw err;
							}
							// Reconcile before installing: a completion
							// already seen for this turn means it
							// finished fast — never install it as running.
							// An untyped completion counts (the fold
							// clears on any completion without a turnId).
							// Either way the install replaces the previous
							// tracking (a steered-over orphan clears).
							const completed =
								pending.untypedCompleted || pending.completedIds.has(turnId);
							// T71: every started turn is a new run generation.
							runGeneration += 1;
							lastTurnId = completed ? null : turnId;
							const queued = pending.stopQueued;
							if (pendingStart === pending) pendingStart = null;
							resolveDone();
							// Round 3 (P2-D): a Stop that landed mid-start
							// interrupts now, through the normal T71 path
							// (bounded; missing_run syncs like Stop).
							if (queued && !completed && lastTurnId === turnId) {
								try {
									await withStopInFlight(() =>
										withTimeout(
											client.turnInterrupt({ sessionId: sid, turnId }),
											10_000,
											() => new Error("interrupt timed out"),
										),
									);
								} catch (err) {
									if (err instanceof MspError && err.reason === "missing_run") {
										if (lastTurnId === turnId) lastTurnId = null;
									}
									// A timed-out queued interrupt leaves the turn
									// live: its completion (or a re-Stop onto the
									// fresh generation) settles it.
								}
							}
							return json({ ok: true, turnId, sessionId: sid });
						} catch (err) {
							if (err instanceof MspError) {
								return json(
									{ ok: false, why: `${err.kind}: ${err.message}` },
									400,
								);
							}
							throw err;
						}
					});
				}
				if (p === "/api/chat/stop" && req.method === "POST") {
					// T71 graceful stop: pinned interrupt, capped at 10s. Every
					// answer carries the correlation IDs (turnId + generation)
					// so the UI can pin a later Force stop to this moment.
					// S2: a pending start wins over any tracked turn — the
					// tracked id is the previous turn's, and interrupting
					// it would miss the turn that is actually starting.
					const pending = pendingStart;
					if (pending !== null && pending.worker === mspPromise) {
						// Round 3 (P2-D): a turnStart is in flight — record
						// the stop; the send interrupts on ack through the
						// T71 path above.
						pending.stopQueued = true;
						return json({
							ok: true,
							stopped: false,
							queued: true,
							turnId: null,
							generation: runGeneration,
						});
					}
					// S3: the start never answered and its turn id is
					// unknown — nothing to interrupt; the UI offers Force
					// (worker teardown) off this answer.
					if (
						unresolvedStart !== null &&
						unresolvedStart.worker === mspPromise
					) {
						return json({
							ok: true,
							stopped: false,
							turnId: null,
							generation: runGeneration,
							why: "the turn start never answered — Force stop tears the worker down",
						});
					}
					const client = msp;
					const sid = mainSession;
					const turnId = lastTurnId;
					if (!client || !sid || !turnId) {
						return json({
							ok: true,
							stopped: false,
							turnId,
							generation: runGeneration,
							why: "no live run",
						});
					}
					try {
						// T60/T85: swaps refuse while this interrupt
						// is in flight (the only await below; the
						// rest of the route is sync and atomic).
						stopInFlight += 1;
						try {
							await withTimeout(
								client.turnInterrupt({ sessionId: sid, turnId }),
								10_000,
								() => new Error("interrupt timed out"),
							);
						} finally {
							stopInFlight -= 1;
						}
						return json({
							ok: true,
							stopped: true,
							turnId,
							generation: runGeneration,
						});
					} catch (err) {
						if (err instanceof MspError && err.reason === "missing_run") {
							// The host has no run: sync the tracking (a completion
							// we never saw already settled it) instead of pinning
							// Force to a ghost. Guarded: a newer send may have
							// replaced the live turn while we awaited.
							if (lastTurnId === turnId) lastTurnId = null;
							return json({
								ok: true,
								stopped: false,
								turnId: lastTurnId,
								generation: runGeneration,
								why: "no live run",
							});
						}
						if (err instanceof Error && err.message === "interrupt timed out") {
							// Not a 500: the UI offers Force stop off this.
							return json({
								ok: true,
								stopped: false,
								turnId,
								generation: runGeneration,
								why: "interrupt timed out",
							});
						}
						throw err;
					}
				}
				if (p === "/api/chat/stop-force" && req.method === "POST") {
					// T60/T85: swaps refuse while a force stop runs.
					// The await is load-bearing (see the send route).
					return await withStopInFlight(async () => {
						// T71 run-pinned force stop. Refuses stale pins without
						// touching the worker; otherwise bounded escalation:
						// interrupt + ≤5s completion-or-exit, stdin EOF + ≤5s,
						// SIGTERM + ≤5s, SIGKILL + ≤5s. Worst case ~20s + overhead,
						// never a hang. ok:false outcomes stay 200 (honest
						// operational answers the UI handles, console-clean).
						const body = (await req.json()) as { generation?: unknown };
						if (typeof body.generation !== "number") {
							return json({ ok: false, why: "need {generation}" }, 400);
						}
						if (body.generation !== runGeneration) {
							return json({
								ok: false,
								code: "stale-generation",
								why: "run changed since Stop was pressed",
								turnId: lastTurnId,
								generation: runGeneration,
							});
						}
						// EOF→TERM→KILL teardown shared by the interrupt-stage
						// fallback below and the unknown-turn-id paths (S3):
						// each stage waits ≤5s for the exit. Returns the
						// killing step, or null when the worker survived
						// SIGKILL.
						const escalateTeardown = async (
							target: MspClient,
						): Promise<"exit" | "term" | "kill" | null> => {
							target.stdinEof();
							if (await target.waitForExit(5000)) return "exit";
							target.kill("SIGTERM");
							if (await target.waitForExit(5000)) return "term";
							target.kill("SIGKILL");
							if (await target.waitForExit(5000)) return "kill";
							return null;
						};
						// S3: the turn id is unknown (a start that never
						// acked) — the only honest stop is tearing the
						// captured worker down. Reaps + retires the pin on
						// success like every other effective force stop.
						const teardownUnknownTurn = async (target: {
							worker: Promise<MspClient> | null;
							client: MspClient;
						}): Promise<Response> => {
							const mine = mspPromise;
							const step = await escalateTeardown(target.client);
							if (step === null) {
								return json({
									ok: false,
									why: "worker survived SIGKILL",
									turnId: lastTurnId,
									generation: runGeneration,
								});
							}
							if (mspPromise === mine) await stopWorker("force-stop");
							if (mspPromise === mine) runGeneration += 1;
							return json({
								ok: true,
								forced: true,
								step,
								turnId: lastTurnId,
								generation: runGeneration,
							});
						};
						const pending = pendingStart;
						if (pending !== null && pending.worker === mspPromise) {
							// Round 3 (P2-D): a turnStart is in flight — wait
							// for it (bounded by the T71 interrupt cap)
							// instead of claiming the pre-start worker as
							// stopped. The pin re-checks after: the send's
							// bump retires it to stale-generation (the UI
							// re-Stops onto a fresh pin, already handled).
							try {
								await withTimeout(
									pending.done,
									10_000,
									() => new Error("start timed out"),
								);
							} catch {
								// S3: still starting after 10s — the turn id
								// is unknown and may stay unknown (the ack
								// can time out at 30s). Tear the captured
								// worker down; a retry loop would just wait
								// out the timeout and then lie idle.
								if (body.generation !== runGeneration) {
									return json({
										ok: false,
										code: "stale-generation",
										why: "run changed since Stop was pressed",
										turnId: lastTurnId,
										generation: runGeneration,
									});
								}
								return await teardownUnknownTurn(pending);
							}
							if (body.generation !== runGeneration) {
								return json({
									ok: false,
									code: "stale-generation",
									why: "run changed since Stop was pressed",
									turnId: lastTurnId,
									generation: runGeneration,
								});
							}
						}
						const stuck = unresolvedStart;
						if (stuck !== null && stuck.worker === mspPromise) {
							// S3: the start never answered — there is no
							// interrupt to send. History stays running until
							// this teardown resolves.
							return await teardownUnknownTurn(stuck);
						}
						const client = msp;
						const sid = mainSession;
						const turnId = lastTurnId;
						const myWorker = mspPromise;
						const stillMine = (): boolean => mspPromise === myWorker;
						if (!client || !sid || !turnId) {
							// Nothing live (the turn settled between Stop and
							// Force): trivially stopped, worker untouched.
							return json({
								ok: true,
								forced: true,
								step: "interrupt",
								turnId,
								generation: runGeneration,
							});
						}
						// A newer turn started mid-force (or a takeover brought
						// one): our outcome is stale, say so instead of claiming
						// a stop — the UI keeps its running state and the user
						// re-stops onto a fresh pin. No bump: the pin stays
						// retryable only when the run did NOT change, and here
						// the send/takeover already bumped.
						const changedMidForce = (): boolean =>
							lastTurnId !== null && lastTurnId !== turnId;
						const changedAnswer = (): Response =>
							json({
								ok: false,
								why: "run changed during force stop",
								turnId: lastTurnId,
								generation: runGeneration,
							});
						// Stage 1: fire the pinned interrupt (never awaited past
						// the shared budget) and wait ≤5s for turn/completed-or-exit.
						const stage1 = await new Promise<
							"completed" | "exited" | "timeout"
						>((resolve) => {
							let settled = false;
							const finish = (v: "completed" | "exited" | "timeout"): void => {
								if (settled) return;
								settled = true;
								clearTimeout(timer);
								off();
								resolve(v);
							};
							const timer = setTimeout(() => finish("timeout"), 5000);
							const off = client.onNotification((ev) => {
								if (ev.method !== "turn/completed") return;
								const doneId = (ev.params as Record<string, unknown>)["turnId"];
								if (typeof doneId === "string" ? doneId === turnId : true) {
									finish("completed");
								}
							});
							void client.waitForExit(5000).then((exited) => {
								if (exited) finish("exited");
							});
							client.turnInterrupt({ sessionId: sid, turnId }).catch(() => {
								// A refused/hung interrupt falls through to teardown.
							});
						});
						if (stage1 === "completed" || stage1 === "exited") {
							// The interrupt stage resolved it: the turn completed
							// (worker usually still alive — keep it and its session)
							// or the worker exited alongside. Reap through the
							// standard teardown only when the worker is actually
							// gone (close on a dead worker resolves promptly).
							if (stillMine() && (await client.waitForExit(0))) {
								await stopWorker("force-stop");
							} else if (stillMine() && lastTurnId === turnId) {
								lastTurnId = null;
							}
							if (changedMidForce()) return changedAnswer();
							if (stillMine()) runGeneration += 1;
							return json({
								ok: true,
								forced: true,
								step: "interrupt",
								turnId: lastTurnId,
								generation: runGeneration,
							});
						}
						// Stages 2-4: stdin EOF, SIGTERM, SIGKILL with ≤5s exit
						// waits each. close() itself waits unboundedly, so EOF
						// + bounded wait are spelled out in the shared helper.
						const step = await escalateTeardown(client);
						if (step === null) {
							return json({
								ok: false,
								why: "worker survived SIGKILL",
								turnId: lastTurnId,
								generation: runGeneration,
							});
						}
						if (stillMine()) await stopWorker("force-stop");
						if (changedMidForce()) return changedAnswer();
						if (stillMine()) runGeneration += 1;
						return json({
							ok: true,
							forced: true,
							step,
							turnId: lastTurnId,
							generation: runGeneration,
						});
					});
				}
				if (p === "/api/chat/new" && req.method === "POST") {
					// T85: start a fresh MSP session on the SAME worker
					// (no restart, no re-unlock) with the settings in
					// effect, and swap main to it atomically. The
					// previous session stays in session/list, so it
					// shows up in Past chats. Refused while a turn
					// runs or a stop is in flight — never auto-stops.
					const preBusy = busyRefusal();
					if (preBusy) {
						return json(
							{ ok: false, error: preBusy.error, why: preBusy.why },
							preBusy.status,
						);
					}
					// P1-3: capture the owner before queueing (a lock past
					// this point invalidates instead of re-keying to bypass).
					const entry = captureLockEntry(req);
					let result: SwapOutcome;
					try {
						result = await swapMain(
							entry.key,
							async (client) => {
								const started = await startMainSession(client);
								return {
									session: started.session,
									approvalMode: started.approvalMode,
									permissionProfile: started.permissionProfile,
								};
							},
							entry,
						);
					} catch (err) {
						if (err instanceof SwapRefusal) {
							return json(
								{ ok: false, error: err.error, why: err.why },
								err.status,
							);
						}
						if (err instanceof MspError) {
							const m = mspRefusal(err);
							return json({ ok: false, error: m.error, why: m.why }, m.status);
						}
						throw err;
					}
					if (!result.ok) {
						return json(
							{ ok: false, error: result.error, why: result.why },
							result.status,
						);
					}
					const run = liveRun();
					return json({
						ok: true,
						sessionId: result.sessionId,
						generation: runGeneration,
						running: run.running,
						turnId: run.turnId,
					});
				}
				if (p === "/api/chat/resume" && req.method === "POST") {
					// P1-3: capture the owner first (validation awaits below).
					const entry = captureLockEntry(req);
					// T60: resume a past session as main. The id must be
					// one this worker's session/list returns — never an
					// arbitrary id — and the live UI settings are
					// re-applied the way the settings routes do. Any
					// failure leaves main unchanged.
					const body = (await req.json()) as { sessionId?: unknown };
					if (typeof body.sessionId !== "string" || !body.sessionId) {
						return json(
							{ ok: false, error: "bad-request", why: "need {sessionId}" },
							400,
						);
					}
					const sid = body.sessionId;
					const key = entry.key;
					// Busy orders over the no-op: resuming the current
					// main mid-turn is refused, not silently kept.
					const preBusy = busyRefusal();
					if (preBusy) {
						return json(
							{ ok: false, error: preBusy.error, why: preBusy.why },
							preBusy.status,
						);
					}
					if (mainSession === sid && mainSettled && mainOwner === key) {
						const run = liveRun();
						return json({
							ok: true,
							sessionId: sid,
							resumed: false,
							generation: runGeneration,
							running: run.running,
							turnId: run.turnId,
						});
					}
					let result: SwapOutcome;
					try {
						result = await swapMain(
							key,
							async (client) => {
								const list = await client.sessionList();
								const found = list.sessions.find((s) => s.sessionId === sid);
								if (!found) {
									throw new SwapRefusal(
										404,
										"unknown-session",
										`no session ${sid} in this workspace`,
									);
								}
								if (!sessionIsOurs(found)) {
									throw new SwapRefusal(
										404,
										"not-this-workspace",
										`session ${sid} belongs to another workspace`,
									);
								}
								prepareSkills();
								const resumed = await client.sessionResume(sid);
								if (
									resumed.abnormalEnd !== undefined &&
									resumed.abnormalEnd !== null
								) {
									throw new SwapRefusal(
										409,
										"abnormal-end",
										"that session's last run ended abnormally and cannot be resumed — start a new session instead",
									);
								}
								await verifySkills(client, sid);
								// P1-2: snapshot the settings once, inside the
								// lock (the setters below await; nothing may
								// interleave a re-read between them).
								const snapModel = lastModelId;
								const snapEffort = lastEffort;
								const snapMode =
									(lastAccess as ApprovalMode | null) ?? defaultAccess();
								const snapWant = lastProfile ?? profileForAccess(snapMode);
								if (snapModel !== null) {
									await client.sessionSetModel(sid, snapModel);
								}
								if (snapEffort !== null) {
									await client.sessionSetReasoningEffort(
										sid,
										snapEffort as ReasoningEffort,
									);
								}
								await client.sessionSetApprovalMode(sid, snapMode);
								const applied = await client.sessionSetPermissionProfile(
									sid,
									snapWant,
								);
								const profile =
									typeof applied.permissionState?.profileId === "string"
										? applied.permissionState.profileId
										: snapWant;
								// P1-1: publish the state the setters produced,
								// never the resume snapshot (it predates them —
								// publishing it cached a stale profile the next
								// /new inherited). session/read is the durable
								// post-setter state on the wire.
								const read = await client.sessionRead(sid);
								const fresh = read["session"] as MspSession | undefined;
								if (!fresh || typeof fresh !== "object") {
									throw new SwapRefusal(
										400,
										"msp-error",
										"session/read after resume carried no session",
									);
								}
								return {
									session: fresh,
									approvalMode: snapMode,
									permissionProfile: profile,
								};
							},
							entry,
						);
					} catch (err) {
						if (err instanceof SwapRefusal) {
							return json(
								{ ok: false, error: err.error, why: err.why },
								err.status,
							);
						}
						if (err instanceof MspError) {
							const m = mspRefusal(err);
							return json({ ok: false, error: m.error, why: m.why }, m.status);
						}
						throw err;
					}
					if (!result.ok) {
						return json(
							{ ok: false, error: result.error, why: result.why },
							result.status,
						);
					}
					const rrun = liveRun();
					return json({
						ok: true,
						sessionId: result.sessionId,
						resumed: true,
						generation: runGeneration,
						running: rrun.running,
						turnId: rrun.turnId,
					});
				}
				if (p === "/api/chat/history") {
					const key = workerKey(req);
					const sid = await ensureMain(key);
					const run = liveRun();
					return json({
						ok: true,
						sessionId: sid,
						// The main generation (same monotonic counter as
						// main/changed): the UI gates late responses on it.
						generation: runGeneration,
						// Round 3 (P1-A): the server's live-run state, from
						// the same tracking /api/chat/stop uses. Tabs take
						// liveness from here, never from stream continuity.
						running: run.running,
						turnId: run.turnId,
						...(await historyOf(key, sid)),
					});
				}
				if (p === "/api/chat/output") {
					const itemId = url.searchParams.get("itemId") ?? "";
					const ref = url.searchParams.get("ref") ?? "";
					if (!itemId || !ref) {
						return json({ ok: false, why: "need ?itemId=&ref=" }, 400);
					}
					const key = workerKey(req);
					const sid = await ensureMain(key);
					const client = await ensureMsp(key);
					try {
						const body = await client.itemReadOutput({
							sessionId: sid,
							itemId,
							outputRef: ref,
						});
						return json({ ok: true, ...body });
					} catch (err) {
						if (err instanceof MspError) {
							return json(
								{ ok: false, why: `${err.kind}: ${err.message}` },
								400,
							);
						}
						throw err;
					}
				}
				if (p === "/api/chat/stats") {
					if (!mainSession) {
						return json({
							ok: true,
							turns: 0,
							msgs: 0,
							contextPct: null,
							pressure: null,
							totalTokens: null,
							ageMin: 0,
							model: null,
							effort: null,
							// The configured default (T93 --yolo), so the
							// access selector shows it before any turn;
							// null without one, exactly as before.
							access: lastAccess,
							profile: lastProfile,
						});
					}
					const key = workerKey(req);
					const client = await ensureMsp(key);
					const list = await client.sessionList();
					const me = list.sessions.find((s) => s.sessionId === mainSession);
					const { count } = await historyOf(key, mainSession);
					const row = (me ?? {}) as Record<string, unknown>;
					return json({
						ok: true,
						turns: typeof me?.turnCount === "number" ? me.turnCount : 0,
						msgs: count,
						contextPct,
						pressure: contextPressure,
						totalTokens,
						ageMin: sessionStartedAt
							? Math.floor((Date.now() - sessionStartedAt) / 60000)
							: 0,
						model:
							lastModelId ??
							(typeof row["modelId"] === "string"
								? (row["modelId"] as string)
								: null),
						effort:
							lastEffort ??
							(typeof row["reasoningEffort"] === "string"
								? (row["reasoningEffort"] as string)
								: null),
						access: lastAccess,
						profile: lastProfile,
					});
				}
				if (p === "/api/chat/models") {
					const key = workerKey(req);
					const client = await ensureMsp(key);
					const catalog = await client.modelList();
					return json({
						ok: true,
						models: catalog.models.map((m) => ({
							modelId: m.modelId,
							label: m.displayLabel ?? m.modelId,
							isDefault: m.isDefault ?? false,
						})),
						current: lastModelId,
					});
				}
				if (p === "/api/chat/model" && req.method === "POST") {
					// P1-3: capture the owner before validation awaits.
					const entry = captureLockEntry(req);
					const body = (await req.json()) as { modelId?: string };
					if (typeof body.modelId !== "string" || !body.modelId) {
						return json({ ok: false, why: "need {modelId}" }, 400);
					}
					const modelId = body.modelId;
					// P1-2: settings mutate under the lifecycle lock, like
					// send/new/resume — the await is load-bearing (see send).
					return await withLifecycleLock(async () => {
						// P1-3: re-validate after queueing, before any spawn.
						const stale = queuedStale(entry);
						if (stale) {
							return json(
								{ ok: false, error: stale.error, why: stale.why },
								stale.status,
							);
						}
						const sid = await ensureMain(entry.key);
						const client = await ensureMsp(entry.key);
						settingsStamp = { sid, gen: runGeneration };
						try {
							await client.sessionSetModel(sid, modelId);
							lastModelId = modelId;
							return json({ ok: true, modelId });
						} catch (err) {
							if (err instanceof MspError) {
								return json(
									{ ok: false, why: `${err.kind}: ${err.message}` },
									400,
								);
							}
							throw err;
						}
					});
				}
				if (p === "/api/chat/effort" && req.method === "POST") {
					// P1-3: capture the owner before validation awaits.
					const entry = captureLockEntry(req);
					const body = (await req.json()) as { effort?: string };
					const tiers = [
						"none",
						"minimal",
						"low",
						"medium",
						"high",
						"xhigh",
						"max",
						"ultra",
					];
					if (typeof body.effort !== "string" || !tiers.includes(body.effort)) {
						return json(
							{ ok: false, why: `need {effort} one of ${tiers.join("|")}` },
							400,
						);
					}
					const effort = body.effort as string;
					// P1-2: settings mutate under the lifecycle lock, like
					// send/new/resume — the await is load-bearing (see send).
					return await withLifecycleLock(async () => {
						// P1-3: re-validate after queueing, before any spawn.
						const stale = queuedStale(entry);
						if (stale) {
							return json(
								{ ok: false, error: stale.error, why: stale.why },
								stale.status,
							);
						}
						const sid = await ensureMain(entry.key);
						const client = await ensureMsp(entry.key);
						settingsStamp = { sid, gen: runGeneration };
						try {
							await client.sessionSetReasoningEffort(
								sid,
								effort as ReasoningEffort,
							);
							lastEffort = effort;
							return json({ ok: true, effort });
						} catch (err) {
							if (err instanceof MspError) {
								return json(
									{ ok: false, why: `${err.kind}: ${err.message}` },
									400,
								);
							}
							throw err;
						}
					});
				}
				if (p === "/api/chat/access" && req.method === "POST") {
					// P1-3: capture the owner before validation awaits.
					const entry = captureLockEntry(req);
					const body = (await req.json()) as { mode?: string };
					const modes = [
						"allowAll",
						"promptUnmatched",
						"onRequest",
						"denyUnmatched",
					];
					if (typeof body.mode !== "string" || !modes.includes(body.mode)) {
						return json(
							{ ok: false, why: `need {mode} one of ${modes.join("|")}` },
							400,
						);
					}
					const mode = body.mode as ApprovalMode;
					// P1-2: settings mutate under the lifecycle lock, like
					// send/new/resume — the await is load-bearing (see send).
					return await withLifecycleLock(async () => {
						// P1-3: re-validate after queueing, before any spawn.
						const stale = queuedStale(entry);
						if (stale) {
							return json(
								{ ok: false, error: stale.error, why: stale.why },
								stale.status,
							);
						}
						const sid = await ensureMain(entry.key);
						const client = await ensureMsp(entry.key);
						settingsStamp = { sid, gen: runGeneration };
						try {
							await client.sessionSetApprovalMode(sid, mode);
						} catch (err) {
							if (err instanceof MspError) {
								return json(
									{ ok: false, why: `${err.kind}: ${err.message}` },
									400,
								);
							}
							throw err;
						}
						lastAccess = mode;
						// T101: the profile follows the mode on the live
						// session (verified mid-session method). A profile
						// failure after a mode change reports both
						// honestly: the mode moved, the profile did not.
						const want = profileForAccess(mode);
						try {
							const res = await client.sessionSetPermissionProfile(sid, want);
							lastProfile =
								typeof res.permissionState?.profileId === "string"
									? res.permissionState.profileId
									: want;
						} catch (err) {
							if (err instanceof MspError) {
								return json(
									{
										ok: false,
										why: `${err.kind}: ${err.message}`,
										mode,
										profile: lastProfile,
									},
									400,
								);
							}
							throw err;
						}
						return json({ ok: true, mode, profile: lastProfile });
					});
				}
				// T50 approval/question surface: thin relays over the MSP
				// decide/answer/cancel/listPending commands. Choice ids
				// and requirement ids are echoed from the host's own
				// request frames (the UI renders them verbatim); the
				// host validates them, and a rejection surfaces as
				// ok:false (a stale requirementId is a normal race, not
				// a 500). Main session only.
				if (p === "/api/chat/pending") {
					// Late join / reload / reconnect recovery. No
					// session yet means nothing pending — and must not
					// spawn one just to ask (a fresh session has no
					// pending items by construction).
					if (!mainSession) {
						return json({ ok: true, approvals: [], userInputs: [] });
					}
					const key = workerKey(req);
					const client = await ensureMsp(key);
					try {
						const list = await client.approvalListPending(mainSession);
						return json({
							ok: true,
							approvals: list.approvals,
							userInputs: list.userInputs,
						});
					} catch (err) {
						if (err instanceof MspError) {
							return json(
								{ ok: false, why: `${err.kind}: ${err.message}` },
								400,
							);
						}
						throw err;
					}
				}
				if (p === "/api/chat/approval/decide" && req.method === "POST") {
					const body = (await req.json()) as {
						approvalId?: unknown;
						choiceId?: unknown;
						requirementId?: unknown;
					};
					const reqId = body.requirementId as Record<string, unknown> | null;
					if (
						typeof body.approvalId !== "string" ||
						typeof body.choiceId !== "string" ||
						typeof reqId !== "object" ||
						reqId === null ||
						typeof reqId["approvalId"] !== "string" ||
						typeof reqId["sourceIndex"] !== "number"
					) {
						return json(
							{ ok: false, why: "need {approvalId, choiceId, requirementId}" },
							400,
						);
					}
					const key = workerKey(req);
					const sid = await ensureMain(key);
					const client = await ensureMsp(key);
					try {
						const res = await client.approvalDecide({
							sessionId: sid,
							approvalId: body.approvalId,
							requirementId: {
								approvalId: reqId["approvalId"] as string,
								sourceIndex: reqId["sourceIndex"] as number,
							},
							choiceId: body.choiceId,
						});
						return json({ ok: true, terminal: res.terminal });
					} catch (err) {
						if (err instanceof MspError) {
							return json(
								{ ok: false, why: `${err.kind}: ${err.message}` },
								400,
							);
						}
						throw err;
					}
				}
				if (p === "/api/chat/question/answer" && req.method === "POST") {
					const body = (await req.json()) as {
						userInputId?: unknown;
						answers?: unknown;
					};
					const answers = body.answers;
					const validAnswer = (a: unknown): boolean => {
						if (typeof a !== "object" || a === null) return false;
						const r = a as Record<string, unknown>;
						if (typeof r["questionId"] !== "string") return false;
						const shapes = [
							typeof r["selectedLabel"] === "string",
							Array.isArray(r["selectedLabels"]) &&
								(r["selectedLabels"] as unknown[]).every(
									(s) => typeof s === "string",
								),
							typeof r["freeText"] === "string",
						].filter(Boolean).length;
						return shapes === 1;
					};
					if (
						typeof body.userInputId !== "string" ||
						!Array.isArray(answers) ||
						answers.length === 0 ||
						!answers.every(validAnswer)
					) {
						return json(
							{
								ok: false,
								why: "need {userInputId, answers:[{questionId, selectedLabel|selectedLabels|freeText}]}",
							},
							400,
						);
					}
					const key = workerKey(req);
					const sid = await ensureMain(key);
					const client = await ensureMsp(key);
					try {
						await client.userInputAnswer({
							sessionId: sid,
							userInputId: body.userInputId,
							answers: answers as {
								questionId: string;
								selectedLabel?: string;
								selectedLabels?: string[];
								freeText?: string;
								note?: string;
							}[],
						});
						return json({ ok: true });
					} catch (err) {
						if (err instanceof MspError) {
							return json(
								{ ok: false, why: `${err.kind}: ${err.message}` },
								400,
							);
						}
						throw err;
					}
				}
				// T106: the relay no longer shares this listener — it
				// rides its own 127.0.0.1 listener (relayResponse
				// above). A relay POST here is an unknown route.
				if (p === "/api/chat/question/cancel" && req.method === "POST") {
					const body = (await req.json()) as {
						userInputId?: unknown;
						reason?: unknown;
					};
					if (typeof body.userInputId !== "string") {
						return json({ ok: false, why: "need {userInputId}" }, 400);
					}
					const key = workerKey(req);
					const sid = await ensureMain(key);
					const client = await ensureMsp(key);
					try {
						await client.userInputCancel({
							sessionId: sid,
							userInputId: body.userInputId,
							...(typeof body.reason === "string"
								? { reason: body.reason }
								: {}),
						});
						return json({ ok: true });
					} catch (err) {
						if (err instanceof MspError) {
							return json(
								{ ok: false, why: `${err.kind}: ${err.message}` },
								400,
							);
						}
						throw err;
					}
				}
				// T50/D38: the default access mode lives in settings.toml
				// ([agent] default_access). GET reports the effective
				// default (what the next session starts in); POST stores
				// one of the two selector modes. The live session mode is
				// separate (/api/chat/access) and untouched here.
				// T101: the same route carries the pre-seed switch
				// ([agent] preallow_reads): POST applies it at once
				// (reseed or removal), and GET reports it.
				if (p === "/api/settings") {
					if (req.method === "GET") {
						return json({
							ok: true,
							defaultAccess: defaultAccess(),
							preallowReads: readPreallowReads(opts.dataHome),
							autoRouterosSkills: readAutoRouterosSkills(opts.dataHome),
							routerosSkills: skillsState(),
						});
					}
					if (req.method === "POST") {
						const body = (await req.json()) as {
							defaultAccess?: unknown;
							preallowReads?: unknown;
							autoRouterosSkills?: unknown;
						};
						if (
							body.defaultAccess === undefined &&
							body.preallowReads === undefined &&
							body.autoRouterosSkills === undefined
						) {
							return json(
								{
									ok: false,
									why: "need {defaultAccess}, {preallowReads}, or {autoRouterosSkills}",
								},
								400,
							);
						}
						if (
							body.defaultAccess !== undefined &&
							!isDefaultAccess(body.defaultAccess)
						) {
							return json(
								{
									ok: false,
									why: "need {defaultAccess} one of promptUnmatched|allowAll",
								},
								400,
							);
						}
						if (
							body.preallowReads !== undefined &&
							typeof body.preallowReads !== "boolean"
						) {
							return json(
								{ ok: false, why: "need {preallowReads} boolean" },
								400,
							);
						}
						if (
							body.autoRouterosSkills !== undefined &&
							typeof body.autoRouterosSkills !== "boolean"
						) {
							return json(
								{ ok: false, why: "need {autoRouterosSkills} boolean" },
								400,
							);
						}
						try {
							if (body.defaultAccess !== undefined) {
								writeDefaultAccess(opts.dataHome, body.defaultAccess);
							}
							if (typeof body.autoRouterosSkills === "boolean") {
								writeAutoRouterosSkills(opts.dataHome, body.autoRouterosSkills);
							}
							if (typeof body.preallowReads === "boolean") {
								writePreallowReads(opts.dataHome, body.preallowReads);
								refreshPreallow(body.preallowReads);
							}
						} catch (err) {
							// A symlinked settings chain is refused, not
							// followed (409: the on-disk state conflicts).
							if (err instanceof SettingsSymlinkError) {
								return json({ ok: false, why: err.message }, 409);
							}
							throw err;
						}
						return json({
							ok: true,
							defaultAccess: defaultAccess(),
							preallowReads: readPreallowReads(opts.dataHome),
							autoRouterosSkills: readAutoRouterosSkills(opts.dataHome),
							routerosSkills: skillsState(),
						});
					}
					return json({ ok: false, why: "need GET or POST" }, 405);
				}
				if (p === "/api/chat/events") {
					let send: (line: string) => void = () => {};
					const stream = new ReadableStream<string>({
						start(controller) {
							send = (line: string) => {
								try {
									controller.enqueue(line);
								} catch {
									sse.delete(send);
								}
							};
							sse.add(send);
							controller.enqueue(": connected\n\n");
						},
						cancel() {
							sse.delete(send);
						},
					});
					return new Response(stream, {
						headers: {
							"content-type": "text/event-stream",
							"cache-control": "no-cache",
							connection: "keep-alive",
						},
					});
				}
				if (p === "/api/past") {
					const key = workerKey(req);
					const client = await ensureMsp(key);
					const list = await client.sessionList();
					const pasts = list.sessions
						.filter((s) => s.sessionId !== mainSession && sessionIsOurs(s))
						.map((s) => {
							const prompt =
								typeof s["firstUserPrompt"] === "string"
									? (s["firstUserPrompt"] as string)
									: null;
							const creator = s["createdByClient"];
							const fromRouterMuse =
								creator !== null &&
								typeof creator === "object" &&
								!Array.isArray(creator) &&
								(creator as Record<string, unknown>)["name"] ===
									"routeros_muse";
							return {
								id: s.sessionId,
								name:
									typeof s.name === "string" && s.name
										? s.name
										: prompt !== null
											? (fromRouterMuse
													? stripSessionSummaryPreamble(prompt)
													: prompt
												).slice(0, 60)
											: "untitled session",
								age:
									typeof s["updatedAt"] === "string"
										? ageOf(Date.parse(s["updatedAt"] as string))
										: "?",
								turns: typeof s.turnCount === "number" ? s.turnCount : 0,
							};
						});
					return json({ pasts });
				}
				if (p === "/api/render" && req.method === "POST") {
					const body = (await req.json()) as { job?: string; input?: unknown };
					if (typeof body.job !== "string")
						return json({ ok: false, why: "need {job, input}" }, 400);
					const res = await runRenderJob(
						root,
						body.job,
						body.input,
						"web",
						opts.dataHome,
					);
					return json(res, res.ok ? 200 : 400);
				}
				if (p === "/api/artifact") {
					const rel = url.searchParams.get("path") ?? "";
					const res = resolveArtifact(root, rel);
					if (!res.ok) return json({ ok: false, why: res.why }, res.status);
					// Serve-time tier: a client tier name is never
					// trusted (a stale tree must not grant scripts to
					// edited bytes) — only the owner's opt-in bit is
					// read from the query, and provenance is decided
					// against the exact buffer just read through the
					// fd, never a reopened pathname.
					const optin = url.searchParams.get("optin") === "1";
					const tier = serveArtifactTier(root, rel, res.body, {
						dataHome: opts.dataHome,
						optin,
					});
					return new Response(new Uint8Array(res.body), {
						headers: {
							"content-type": res.contentType,
							...artifactSecurityHeaders(tier),
						},
					});
				}
				if (p === "/api/artifact/meta") {
					// Fresh provenance label for the viewer tab: always
					// 200, null on anything unresolvable or unverified.
					const rel = url.searchParams.get("path") ?? "";
					const res = resolveArtifact(root, rel);
					if (!res.ok) return json({ provenance: null });
					return json({
						provenance: artifactProvenanceForBuffer(
							root,
							rel,
							res.body,
							opts.dataHome,
						),
					});
				}
				if (p.startsWith("/api/past/")) {
					const id = decodeURIComponent(p.slice("/api/past/".length));
					const { messages, count } = await historyOf(workerKey(req), id);
					const firstUser = messages.find((m) => m.role === "user")?.text ?? "";
					const lastAgent =
						[...messages].reverse().find((m) => m.role === "agent")?.text ?? "";
					return json({
						ok: true,
						id,
						count,
						firstUser: firstUser.slice(0, 500),
						lastAgent: lastAgent.slice(0, 800),
					});
				}
				return json({ ok: false, why: "not found" }, 404);
			} catch (err) {
				return json(
					{ ok: false, why: err instanceof Error ? err.message : String(err) },
					500,
				);
			}
		},
	});

	try {
		relay = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req, srv) {
				try {
					const url = new URL(req.url);
					if (url.pathname === "/api/mcp/relay" && req.method === "POST") {
						return await relayResponse(req, srv.requestIP(req)?.address);
					}
					return json({ ok: false, why: "not found" }, 404);
				} catch (err) {
					return json(
						{
							ok: false,
							why: err instanceof Error ? err.message : String(err),
						},
						500,
					);
				}
			},
		});
	} catch (err) {
		// Relay bind failed after the main listener started: do not
		// orphan it (codex re-review round 2).
		clearInterval(hb);
		server.stop();
		throw err;
	}

	// Meta probes in the background (a disposable turn —
	// fast-fail when logged out). Fires after the bind: the probe
	// spawn carries the ui MCP config whose relay URL needs the
	// bound port (T55).
	if (provider !== "echo" && have("muse", tools)) {
		void (async () => {
			try {
				const m = await probeMetaAuth(() => {
					// Throws on an unsafe home: the probe never
					// spawns with it (probeMetaAuth maps the
					// throw to "unknown", same as any spawn failure).
					ensureHomeOrThrow();
					return MspClient.spawn({
						provider,
						museHome: opts.museHome,
						museConfigHome: museCfgHome,
						mcpServers: {}, // Disposable probe: no ui tools.
						experimental: true,
						extraArgs: mspExtraArgs,
						env: tools,
					});
				}, root);
				if (m !== "unknown") setMeta(m);
			} catch {
				// probe failure is not auth evidence; stays unknown
			}
		})();
	}

	const boundPort = server.port;
	const boundHost = server.hostname;
	if (boundPort === undefined || boundHost === undefined) {
		clearInterval(hb);
		relay.stop();
		server.stop();
		throw new Error("server started without an address");
	}
	const displayHost =
		host === "0.0.0.0" || host === "::" ? "127.0.0.1" : boundHost;
	// Signals can overlap: every caller must await the same child drain
	// before the CLI exits, including a second SIGINT during shutdown.
	let stopPromise: Promise<void> | undefined;
	return {
		url: `http://${displayHost}:${boundPort}/`,
		urls: isLoopbackHost(host) ? [] : lanUrls(boundPort),
		port: boundPort,
		hostname: boundHost,
		relayUrl: `http://127.0.0.1:${relay.port}/`,
		stop: () => {
			stopPromise ??= (async () => {
				// Finding D: the flag goes first, so launches that start
				// after it are refused and in-flight ones kill the child
				// they produced instead of tracking it as live.
				pickerStopping = true;
				clearInterval(hb);
				relay.stop();
				server.stop();
				// In-flight launches are awaited (bounded): only once
				// they settle is the child set complete — stop() then
				// kills the full set, so a create completing during
				// shutdown leaks nothing.
				if (inFlightLaunches.size > 0) {
					// Clear the bound timer once launches settle: a
					// pending 60 s timer would hold the event loop open.
					let waitTimer: ReturnType<typeof setTimeout> | undefined;
					try {
						await Promise.race([
							Promise.allSettled([...inFlightLaunches]),
							new Promise((r) => {
								waitTimer = setTimeout(r, STOP_LAUNCH_WAIT_MS);
							}),
						]);
					} finally {
						clearTimeout(waitTimer);
					}
				}
				// T133 review P2: spawned workspace children die with the
				// picker — one Ctrl-C ends the session. SIGTERM first,
				// then SIGKILL after the launcher's own grace.
				const kids = [...children];
				children.clear();
				for (const kid of kids) {
					try {
						await kid.stop();
					} catch {
						// Best-effort: the child is already gone.
					}
				}
				await stopWorker("shutdown", false);
			})();
			return stopPromise;
		},
	};
}
