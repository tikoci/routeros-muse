// T105/T112: the rosetta MCP server in the session config, next
// to routeros_muse.
//
// T105 shipped both centrs and rosetta here. T112 dropped the
// centrs server: agents use the richer centrs CLI this phase, and
// centrs-as-MCP returns after GitHub once the T111 password channel
// exists (muse passes no process env to MCP children, so
// CENTRS_CDB_PASSWORD never reached it).
//
// The rosetta server ships in the package bundle (D26, same
// precedent as the ui bridge): launched via process.execPath (bun)
// with an ABSOLUTE entry path resolved from the package root, never
// ambient PATH. When the bundle entry is missing on disk the server
// is OMITTED (honest degradation — the worker still starts) and the
// caller logs the miss.
//
// rosetta entry: bin/rosetta.js (bun shebang) -> src/mcp.ts, stdio by
// default. Thirteen of the fourteen routeros_* tools are local SQLite
// doc reads and are seeded; routeros_current_versions is NOT — its
// handler fetches MikroTik's upgrade server per call, so it stays
// available but gated per-call. No device contact from rosetta; the
// only local mutation is the startup DB download/cache in
// ensureDbReady (bookkeeping, stated not seeded). No env needed: the
// DB resolves next to the entry.
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { packageRoot } from "../lib/tools";
import type { McpServerConfig } from "../msp/client";
import {
	mcpToolName,
	UI_MCP_SERVER,
	UI_TOOL_NAMES,
	type UiMcpConfig,
	uiMcpServers,
} from "./ui-tools";

/** muse's namespaced tool spelling for a non-ui server. */
export function trilogyToolName(server: string, short: string): string {
	return `mcp__${server}__${short}`;
}

/** Session config key for the rosetta MCP server. */
export const ROSETTA_MCP_SERVER = "rosetta";

/**
 * rosetta MCP tools (verified against
 * node_modules/@tikoci/rosetta/src/mcp.ts registerTool calls):
 * thirteen are local SQLite documentation reads — search, page
 * fetch, property lookup, command tree/diff/version checks, device
 * lookups, stats, changelogs, test results, Dude docs. The exception
 * is routeros_current_versions, whose handler fetches MikroTik's
 * upgrade server on every call: network, not a local read, so it is
 * listed here (the server offers it) but excluded from the seed
 * below. No tool takes a write-shaped input; the only disk writer
 * is startup DB ensureDbReady (fresh-install download, schema
 * re-download), which runs before tools exist — local bookkeeping,
 * not a device write.
 */
export const ROSETTA_TOOL_NAMES = [
	"routeros_search",
	"routeros_get_page",
	"routeros_lookup_property",
	"routeros_explain_command",
	"routeros_command_tree",
	"routeros_command_diff",
	"routeros_command_version_check",
	"routeros_current_versions",
	"routeros_device_lookup",
	"routeros_stats",
	"routeros_search_changelogs",
	"routeros_search_tests",
	"routeros_dude_search",
	"routeros_dude_get_page",
] as const;

/** Rosetta tools excluded from the seed: per-call network fetch. */
export const ROSETTA_UNSEEDED_TOOLS = ["routeros_current_versions"] as const;

/** The seeded rosetta set: every local-read tool, namespaced below. */
export const ROSETTA_SEED_TOOLS: string[] = ROSETTA_TOOL_NAMES.filter(
	(t) => !(ROSETTA_UNSEEDED_TOOLS as readonly string[]).includes(t),
);

// T112: centrs via CLI this phase; centrs MCP returns after GitHub (T111 password channel)

/** Absolute rosetta entry under a package root, or null when missing. */
export function rosettaEntry(pkgRoot: string | null): string | null {
	if (!pkgRoot) return null;
	const entry = path.join(
		pkgRoot,
		"node_modules",
		"@tikoci",
		"rosetta",
		"bin",
		"rosetta.js",
	);
	try {
		return nodeFs.statSync(entry).isFile() ? entry : null;
	} catch {
		return null;
	}
}

export type SessionMcpConfig = UiMcpConfig & {
	/**
	 * Package root override (tests point at a stub bundle).
	 * Undefined resolves via packageRoot() (null when unknown —
	 * the rosetta server then omits, honestly).
	 */
	pkgRoot?: string | null;
};

/**
 * The session/start config.mcpServers value (T105, T112): the ui
 * bridge plus the rosetta bundle server. A server whose bundle
 * entry is missing on disk is omitted (the worker still starts);
 * misses surface via `missed` so the caller logs them once at boot.
 * Never falls back to ambient PATH for the entries (D26).
 */
export function sessionMcpServers(opts: SessionMcpConfig): {
	servers: Record<string, McpServerConfig>;
	missed: string[];
} {
	const pkgRoot = opts.pkgRoot !== undefined ? opts.pkgRoot : packageRoot();
	const servers: Record<string, McpServerConfig> = {
		...uiMcpServers(opts),
	};
	const missed: string[] = [];
	const rosetta = rosettaEntry(pkgRoot);
	if (rosetta) {
		servers[ROSETTA_MCP_SERVER] = {
			transport: "stdio",
			command: opts.bun,
			args: [rosetta],
			env: {},
		};
	} else {
		missed.push(ROSETTA_MCP_SERVER);
	}
	return { servers, missed };
}

/**
 * The seed set for a given bundle resolution: tools of a server
 * whose bundle entry is missing are NOT seeded (and not reported),
 * so the policy file never carries rules for tools no session has.
 */
export function seedToolNames(resolved: { rosetta: boolean }): string[] {
	return [
		...UI_TOOL_NAMES.map((t) => mcpToolName(t)),
		...(resolved.rosetta
			? ROSETTA_SEED_TOOLS.map((t) => trilogyToolName(ROSETTA_MCP_SERVER, t))
			: []),
	];
}

/**
 * Every namespaced tool seeded as a tagged tool_action allow rule
 * under the preallow toggle, in seed order: the four ui_* tools
 * (T55 plus T110 ui_add_device) then the read-only rosetta tools
 * (T105; T112 dropped the centrs tools — agents use the centrs CLI
 * this phase). This is the fully-resolved set; server.ts narrows it
 * via seedToolNames when the bundle entry is missing.
 */
export const SEED_TOOL_NAMES: string[] = seedToolNames({ rosetta: true });

/** The ui server key, re-exported for report/test consumers. */
export { UI_MCP_SERVER };
