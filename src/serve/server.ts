// Mode B server (T31 slice 2): loopback Bun server over the workspace.
// Serves the v10 UI (ui.html, live-wired copy of the approved concept),
// bridges chat to the local muse over MSP, and reads tree/files/devices/
// twins/alerts from real sources. Anything unreachable degrades to an
// honest unavailable state, never demo data.

import * as nodeFs from "node:fs";
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
import { have, run } from "../lib/run";
import {
	isDefaultAccess,
	readDefaultAccess,
	readPreallowReads,
	SettingsSymlinkError,
	writeDefaultAccess,
	writePreallowReads,
} from "../lib/settings";
import { listTemplates, type TemplateMeta } from "../lib/templates";
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
	CDB_ENCRYPT_STEERING,
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
	mcpToolName,
	mintMcpToken,
	NOTIFY_TEXT_MAX,
	resolveUiOpen,
	stripMcpPrefix,
	tokensEqual,
	UI_TOOL_NAMES,
	uiMcpServers,
} from "../mcp/ui-tools";
import {
	type ApprovalMode,
	type McpServerConfig,
	MspClient,
	MspError,
	type PermissionState,
	type ReasoningEffort,
	type TurnInput,
	type ViewEvent,
} from "../msp/client";
import { runRenderJob } from "../render/jobs";
import {
	type AuthCdb,
	type CdbMode,
	clearCookieHeader,
	cookieToken,
	createSessionStore,
	detectCdbMode,
	type MetaAuth,
	probeMetaAuth,
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
};

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

function parseContextLine(line: string): TargetChip | null {
	if (!line.startsWith(TARGET_CONTEXT_PREFIX)) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(line.slice(TARGET_CONTEXT_PREFIX.length));
	} catch {
		return null;
	}
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
	if (!noWs && !nodeFs.existsSync(path.join(root, "workspace.toml"))) {
		throw new Error(`not a workspace (no workspace.toml): ${root}`);
	}
	// Fail-closed CDB binding (T64): workspace mode always binds its
	// absolute device.cdb — even when the file is missing (centrs then
	// answers cdb/not-found, which routes to setup/steering, instead of
	// silently reading the operator store). An explicit cdbFile beats
	// the binding in both modes. Only no-workspace mode without an
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
	const binDir = opts.toolBinDir ?? defaultToolBinDir();
	const tools = toolEnv(binDir);
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
	function mcpServers(): Record<string, McpServerConfig> {
		return uiMcpServers({
			bridge: mcpBridge,
			bun: process.execPath,
			url: `http://127.0.0.1:${relay.port}/`,
			token: mcpToken,
		});
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
	// starts 0 and bumps on every turnStart send, worker spawn/takeover,
	// stopWorker/lock, and effective force-stop; lastTurnId tracks the
	// live turn (cleared on its turn/completed). Stop pins its interrupt
	// to the live turn; force-stop pins itself to the generation the UI
	// saw when Stop was pressed.
	let runGeneration = 0;
	let lastTurnId: string | null = null;
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
	 * seeds only the ui_* tool rules (same toggle) and reports
	 * them: commands/hosts stay empty, so the toggle can be seen
	 * and revoked there too (T106).
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
			tools: enabled ? [...UI_TOOL_NAMES].map(mcpToolName) : [],
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
	async function stopWorker(): Promise<void> {
		const prev = mspPromise;
		mspPromise = null;
		mspOwner = null;
		msp = null;
		// T71: the run dies with the worker (covers lock, which funnels here).
		runGeneration += 1;
		lastTurnId = null;
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
		sessionStartedAt = null;
		if (prev) {
			try {
				await (await prev).close();
			} catch {
				// already gone; the verdict stands
			}
		}
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

	function ensureMsp(key: string): Promise<MspClient> {
		if (mspPromise && mspOwner === key) return mspPromise;
		// New owner (or first spawn): stop any previous worker, then
		// spawn under the new owner's unlock context. stopWorker's
		// sync prefix runs now (captures + nulls); the spawn waits it.
		const stopping = stopWorker();
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
				} catch (err) {
					mspWhy = err instanceof Error ? err.message : String(err);
					throw new Error(
						`refusing to spawn the muse worker: private config home is unsafe (${mspWhy})`,
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
						// echoes every session/start + setApprovalMode).
						const p = ev.params as Record<string, unknown>;
						if (typeof p["mode"] === "string") lastAccess = p["mode"];
					}
					if (ev.method === "session/permissionProfileChanged") {
						// T101: same fold for the profile (every
						// accepted setPermissionProfile commit).
						const p = ev.params as Record<string, unknown>;
						if (typeof p["profileId"] === "string")
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
				});
				msp = client;
				return client;
			})();
			mspPromise = spawned;
			spawned.catch(() => {
				if (mspPromise === spawned) mspPromise = null;
			});
		}
		return mspPromise;
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
			const approvalMode = defaultAccess();
			const permissionProfile = profileForAccess(approvalMode);
			const { session } = await client.sessionStart({
				workspaceRoot: root,
				approvalMode,
				permissionProfile,
			});
			if (!isMine() || mainOwner !== key || mspOwner !== key) {
				const cur = mainPromise;
				if (cur && !isMine()) return cur;
				if (isMine()) {
					mainPromise = null;
					mainOwner = null;
				}
				return ensureMain(key);
			}
			mainSession = session.sessionId;
			// The session runs at this mode now; stopWorker cleared
			// lastAccess on the way up, so restore the truth here.
			// T101: the host's permissionState is the truth for the
			// live profile; fall back to what we asked for when an
			// older host reports none.
			lastAccess = approvalMode;
			const live = session["permissionState"] as PermissionState | undefined;
			lastProfile =
				typeof live?.profileId === "string"
					? live.profileId
					: permissionProfile;
			sessionStartedAt = Date.now();
			mainSettled = true;
			return mainSession;
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
					// encrypted mid-run, and the gate cache follows.
					const live = await detectCdbMode(authCdb.file, envFor(req));
					cdbModeState = live;
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
						...(live.why ? { why: live.why } : {}),
					});
				}
				if (p === "/api/auth/unlock" && req.method === "POST") {
					const body = (await req.json()) as { password?: unknown };
					if (typeof body.password !== "string" || body.password === "") {
						return json({ ok: false, why: "need {password}" }, 400);
					}
					const live = await detectCdbMode(authCdb.file, envFor(req));
					cdbModeState = live;
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
				if (p === "/api/auth/lock" && req.method === "POST") {
					// Worker-stop semantics (T64): revoke the token (which
					// drops its unlock context) and stop the MSP worker
					// bound to it. Chats resume via past sessions (T60
					// seam); the response never implies revocation from a
					// running child.
					const token = cookieToken(req);
					sessions.revoke(token);
					if (token && mspOwner === token) await stopWorker();
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
						const made = await scaffoldWorkspace(
							defaultDir,
							body.name,
							envFor(req),
							template,
						);
						if (!made.ok) return json({ ok: false, why: made.why }, 400);
						const workspace = registerWorkspace(regFile, body.name, made.dir);
						// D45: no re-seed — the new workspace gets
						// its own home (and its own seed) when it
						// is served; ours is unchanged.
						return json({
							ok: true,
							workspace,
							template,
							command: serveCommand(made.dir),
							steering: CDB_ENCRYPT_STEERING,
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
						return json({
							ok: true,
							workspace,
							command: serveCommand(found.path),
						});
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
					const body = (await req.json()) as {
						text?: string;
						images?: { base64Data: string; mediaType: string }[];
						targets?: unknown;
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
					const key = workerKey(req);
					const sid = await ensureMain(key);
					const client = await ensureMsp(key);
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
					try {
						const { turnId } = await client.turnStart({
							sessionId: sid,
							input,
						});
						// T71: every started turn is a new run generation.
						runGeneration += 1;
						lastTurnId = turnId;
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
				}
				if (p === "/api/chat/stop" && req.method === "POST") {
					// T71 graceful stop: pinned interrupt, capped at 10s. Every
					// answer carries the correlation IDs (turnId + generation)
					// so the UI can pin a later Force stop to this moment.
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
						await withTimeout(
							client.turnInterrupt({ sessionId: sid, turnId }),
							10_000,
							() => new Error("interrupt timed out"),
						);
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
					const stage1 = await new Promise<"completed" | "exited" | "timeout">(
						(resolve) => {
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
						},
					);
					if (stage1 === "completed" || stage1 === "exited") {
						// The interrupt stage resolved it: the turn completed
						// (worker usually still alive — keep it and its session)
						// or the worker exited alongside. Reap through the
						// standard teardown only when the worker is actually
						// gone (close on a dead worker resolves promptly).
						if (stillMine() && (await client.waitForExit(0))) {
							await stopWorker();
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
					// Stage 2: stdin EOF with a ≤5s exit wait. close() itself
					// waits unboundedly, so EOF + bounded wait are spelled out.
					client.stdinEof();
					if (await client.waitForExit(5000)) {
						if (stillMine()) await stopWorker();
						if (changedMidForce()) return changedAnswer();
						if (stillMine()) runGeneration += 1;
						return json({
							ok: true,
							forced: true,
							step: "exit",
							turnId: lastTurnId,
							generation: runGeneration,
						});
					}
					// Stage 3: SIGTERM + ≤5s.
					client.kill("SIGTERM");
					if (await client.waitForExit(5000)) {
						if (stillMine()) await stopWorker();
						if (changedMidForce()) return changedAnswer();
						if (stillMine()) runGeneration += 1;
						return json({
							ok: true,
							forced: true,
							step: "term",
							turnId: lastTurnId,
							generation: runGeneration,
						});
					}
					// Stage 4: SIGKILL + ≤5s.
					client.kill("SIGKILL");
					if (await client.waitForExit(5000)) {
						if (stillMine()) await stopWorker();
						if (changedMidForce()) return changedAnswer();
						if (stillMine()) runGeneration += 1;
						return json({
							ok: true,
							forced: true,
							step: "kill",
							turnId: lastTurnId,
							generation: runGeneration,
						});
					}
					return json({
						ok: false,
						why: "worker survived SIGKILL",
						turnId: lastTurnId,
						generation: runGeneration,
					});
				}
				if (p === "/api/chat/history") {
					const key = workerKey(req);
					const sid = await ensureMain(key);
					return json({
						ok: true,
						sessionId: sid,
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
					const body = (await req.json()) as { modelId?: string };
					if (typeof body.modelId !== "string" || !body.modelId) {
						return json({ ok: false, why: "need {modelId}" }, 400);
					}
					const key = workerKey(req);
					const sid = await ensureMain(key);
					const client = await ensureMsp(key);
					try {
						await client.sessionSetModel(sid, body.modelId);
						lastModelId = body.modelId;
						return json({ ok: true, modelId: body.modelId });
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
				if (p === "/api/chat/effort" && req.method === "POST") {
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
					const key = workerKey(req);
					const sid = await ensureMain(key);
					const client = await ensureMsp(key);
					try {
						await client.sessionSetReasoningEffort(
							sid,
							body.effort as ReasoningEffort,
						);
						lastEffort = body.effort;
						return json({ ok: true, effort: body.effort });
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
				if (p === "/api/chat/access" && req.method === "POST") {
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
					const key = workerKey(req);
					const sid = await ensureMain(key);
					const client = await ensureMsp(key);
					try {
						await client.sessionSetApprovalMode(sid, body.mode as ApprovalMode);
					} catch (err) {
						if (err instanceof MspError) {
							return json(
								{ ok: false, why: `${err.kind}: ${err.message}` },
								400,
							);
						}
						throw err;
					}
					lastAccess = body.mode;
					// T101: the profile follows the mode on the live
					// session (verified mid-session method). A profile
					// failure after a mode change reports both
					// honestly: the mode moved, the profile did not.
					const want = profileForAccess(body.mode);
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
									mode: body.mode,
									profile: lastProfile,
								},
								400,
							);
						}
						throw err;
					}
					return json({ ok: true, mode: body.mode, profile: lastProfile });
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
						});
					}
					if (req.method === "POST") {
						const body = (await req.json()) as {
							defaultAccess?: unknown;
							preallowReads?: unknown;
						};
						if (
							body.defaultAccess === undefined &&
							body.preallowReads === undefined
						) {
							return json(
								{
									ok: false,
									why: "need {defaultAccess} and/or {preallowReads}",
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
						try {
							if (body.defaultAccess !== undefined) {
								writeDefaultAccess(opts.dataHome, body.defaultAccess);
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
						.filter((s) => s.sessionId !== mainSession)
						.map((s) => ({
							id: s.sessionId,
							name:
								typeof s.name === "string" && s.name
									? s.name
									: typeof s["firstUserPrompt"] === "string"
										? stripTargetPreamble(s["firstUserPrompt"] as string).slice(
												0,
												60,
											)
										: "untitled session",
							age:
								typeof s["updatedAt"] === "string"
									? ageOf(Date.parse(s["updatedAt"] as string))
									: "?",
							turns: typeof s.turnCount === "number" ? s.turnCount : 0,
						}));
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
	return {
		url: `http://${displayHost}:${boundPort}/`,
		urls: isLoopbackHost(host) ? [] : lanUrls(boundPort),
		port: boundPort,
		hostname: boundHost,
		relayUrl: `http://127.0.0.1:${relay.port}/`,
		stop: async () => {
			clearInterval(hb);
			relay.stop();
			server.stop();
			await stopWorker();
		},
	};
}
