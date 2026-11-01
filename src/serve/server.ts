// Mode B server (T31 slice 2): loopback Bun server over the workspace.
// Serves the v10 UI (ui.html, live-wired copy of the approved concept),
// bridges chat to the local muse over MSP, and reads tree/files/devices/
// twins/alerts from real sources. Anything unreachable degrades to an
// honest unavailable state, never demo data.

import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CdbCredentialDetails,
	deviceStats,
	doctorTwins,
	listDevices,
	listTwins,
	setCdbCredentials,
	showCdbDevice,
} from "../lib/fleet";
import {
	defaultWorkspacesDir,
	pruneRegistry,
	type RegistryEntry,
	readRegistry,
	registerWorkspace,
	registryEntryAlive,
	registryFile,
} from "../lib/registry";
import { have, run } from "../lib/run";
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
	artifactSecurityHeaders,
	artifactTier,
	CDB_ENCRYPT_STEERING,
	type TierMemo,
	isArtifactPath,
	listAlerts,
	listRecents,
	readTomlSections,
	readWorkspaceFile,
	resolveArtifact,
	scaffoldWorkspace,
	type TreeEntry,
	walkTree,
	writeWorkspaceFile,
} from "../lib/workspace";
import {
	type ApprovalMode,
	MspClient,
	MspError,
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
	 * allowAll). The access selector reads this same state, so the
	 * UI shows it as it already would. Defaults to onRequest.
	 */
	defaultApprovalMode?: ApprovalMode;
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
			out.push({ kind, role: kind === "userMessage" ? "user" : "agent", text });
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
	let lastAccess: string | null = opts.defaultApprovalMode ?? null;
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
		lastAccess = null;
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
				if (!have("muse")) {
					mspWhy = "muse not on PATH";
					throw new Error(mspWhy);
				}
				const client = await MspClient.spawn({
					provider,
					museHome: opts.museHome,
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
			const approvalMode = opts.defaultApprovalMode ?? "onRequest";
			const { session } = await client.sessionStart({
				workspaceRoot: root,
				approvalMode,
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
			lastAccess = approvalMode;
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
	} else if (have("muse")) {
		void (async () => {
			try {
				const m = await probeMetaAuth(
					() =>
						MspClient.spawn({
							provider,
							museHome: opts.museHome,
							env: tools,
						}),
					root,
				);
				if (m !== "unknown") setMeta(m);
			} catch {
				// probe failure is not auth evidence; stays unknown
			}
		})();
	}

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
				// T39 whole-app gate: the shell and the state/unlock/lock
				// routes stay public so a locked browser can unlock;
				// everything else needs a session unless a passwordless
				// CDB (open or missing — neither has a secret to prove)
				// is explicitly bypassed.
				const authed = sessions.valid(cookieToken(req));
				const authBypass =
					(cdbModeState.mode === "open" || cdbModeState.mode === "missing") &&
					opts.allowOpenCdb === true;
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
					const m = await probeMetaAuth(
						() =>
							MspClient.spawn({
								provider,
								museHome: opts.museHome,
								env: tools,
							}),
						root,
					);
					if (m !== "unknown") setMeta(m);
					return json({ ok: true, meta: metaAuth });
				}
				if (p === "/api/status") {
					let museVersion: string | null = null;
					if (have("muse")) {
						const r = await run(["muse", "--version"], { timeoutMs: 10_000 });
						museVersion = r.stdout.trim().split("\n")[0] || null;
					}
					return json({
						workspace: noWs ? null : root,
						mode: noWs ? "no-workspace" : "workspace",
						provider,
						muse: museVersion,
						msp: msp ? "connected" : mspWhy ? `unavailable: ${mspWhy}` : "lazy",
						mainSession,
						tools: await toolInfo(),
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
					// Artifact entries carry their sandbox tier so the
					// viewer opens render-job scripts without a re-fetch.
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
					return json({ recents: listRecents(root) });
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
					const input: TurnInput[] = [{ type: "text", text: body.text }];
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
						lastAccess = body.mode;
						return json({ ok: true, mode: body.mode });
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
										? (s["firstUserPrompt"] as string).slice(0, 60)
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
					// The buffer is the checked object itself (fd-read),
					// never a reopened pathname.
					return new Response(new Uint8Array(res.body), {
						headers: {
							"content-type": res.contentType,
							...artifactSecurityHeaders(url.searchParams.get("tier")),
						},
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

	const boundPort = server.port;
	const boundHost = server.hostname;
	if (boundPort === undefined || boundHost === undefined) {
		throw new Error("server started without an address");
	}
	const displayHost =
		host === "0.0.0.0" || host === "::" ? "127.0.0.1" : boundHost;
	return {
		url: `http://${displayHost}:${boundPort}/`,
		urls: isLoopbackHost(host) ? [] : lanUrls(boundPort),
		port: boundPort,
		hostname: boundHost,
		stop: async () => {
			clearInterval(hb);
			server.stop();
			await stopWorker();
		},
	};
}
