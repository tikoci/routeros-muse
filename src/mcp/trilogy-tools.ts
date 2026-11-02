// T105: the trilogy's MCP servers (centrs and rosetta) in the session
// config, next to routeros_muse.
//
// Both servers ship in the package bundle (D26, same precedent as the
// ui bridge): launched via process.execPath (bun) with ABSOLUTE entry
// paths resolved from the package root, never ambient PATH. When a
// bundle entry is missing on disk that server is OMITTED (honest
// degradation — the worker still starts) and the caller logs the miss.
//
// centrs entry: src/cli.ts subcommand `mcp` (src/mcp/server.ts
// runMcpStdio). Tools: centrs_explain + centrs_validate +
// centrs_retrieve are read-only (readOnlyHint, offline or read-only);
// centrs_execute is destructiveHint (serves reads AND writes, gated
// per-call by the CDB mcp=rw + confirm), centrs_devices and
// centrs_discover are mixed (list/show/groups read; add/edit/set and
// save=true write with confirm) — never seedable per-op (P7).
// Env: CENTRS_CDB_FILE binds the session's CDB in workspace mode;
// without a binding (no-workspace, no override) the env is empty and
// centrs resolves its operator default. CENTRS_CDB_PASSWORD NEVER
// rides this config (it would travel the MSP wire / session state).
//
// rosetta entry: bin/rosetta.js (bun shebang) -> src/mcp.ts, stdio by
// default. Thirteen of the fourteen routeros_* tools are local SQLite
// doc reads and are seeded; routeros_current_versions is NOT — its
// handler fetches MikroTik's upgrade server per call, so it stays
// available but gated per-call. The seed line is public-internet
// vs CDB-allowlisted devices, not network-vs-local: the seeded
// centrs tools do per-call I/O to registered devices
// (openWorldHint), which the CDB allowlist + the device account
// bound. No device contact from rosetta; the only local
// mutation is the startup DB download/cache in ensureDbReady
// (bookkeeping, stated not seeded). No env needed: the DB resolves
// next to the entry.
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

/** Session config key for the centrs MCP server. */
export const CENTRS_MCP_SERVER = "centrs";

/** Session config key for the rosetta MCP server. */
export const ROSETTA_MCP_SERVER = "rosetta";

/**
 * centrs MCP tools that are read-only (verified against
 * node_modules/@tikoci/centrs/src/mcp/server.ts annotations):
 * explain (offline, openWorldHint false), validate (dry-run :parse
 * + /console/inspect, never mutates), retrieve (read-only API).
 * execute/devices/discover are destructiveHint/mixed and excluded.
 */
export const CENTRS_READONLY_TOOLS = [
	"centrs_explain",
	"centrs_validate",
	"centrs_retrieve",
] as const;

/**
 * The full centrs MCP tool set (for reference; only the read-only
 * subset above is seeded). execute serves reads AND writes behind
 * one name; devices (op add/edit/set/remove) and discover
 * (save=true) mutate the CDB — none can be scoped per-op by a
 * tool_action rule (permissions P7).
 */
export const CENTRS_TOOL_NAMES = [
	...CENTRS_READONLY_TOOLS,
	"centrs_execute",
	"centrs_devices",
	"centrs_discover",
] as const;

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

/**
 * Every namespaced read-only tool seeded as a tagged tool_action
 * allow rule under the preallow toggle: the three centrs RO tools
 * plus the thirteen local-read rosetta tools. Mixed/write tools and
 * the network-fetching rosetta tool are absent by design (see above).
 */
export const TRILOGY_SEED_TOOLS: string[] = [
	...CENTRS_READONLY_TOOLS.map((t) => trilogyToolName(CENTRS_MCP_SERVER, t)),
	...ROSETTA_SEED_TOOLS.map((t) => trilogyToolName(ROSETTA_MCP_SERVER, t)),
];

/** Absolute centrs CLI entry under a package root, or null when missing. */
export function centrsEntry(pkgRoot: string | null): string | null {
	if (!pkgRoot) return null;
	const entry = path.join(
		pkgRoot,
		"node_modules",
		"@tikoci",
		"centrs",
		"src",
		"cli.ts",
	);
	try {
		return nodeFs.statSync(entry).isFile() ? entry : null;
	} catch {
		return null;
	}
}

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
	 * The session's CDB binding (server.ts cdbFile): set in
	 * workspace mode (always bound, even when the file is
	 * missing), null in no-workspace mode without an override
	 * (operator-default resolution). Carried as CENTRS_CDB_FILE
	 * on the centrs entry only.
	 */
	cdbFile: string | null;
	/**
	 * Package root override (tests point at a stub bundle).
	 * Undefined resolves via packageRoot() (null when unknown —
	 * both trilogy servers then omit, honestly).
	 */
	pkgRoot?: string | null;
};

/**
 * The session/start config.mcpServers value (T105): the ui bridge
 * plus the centrs and rosetta bundle servers. A server whose bundle
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
	const centrs = centrsEntry(pkgRoot);
	if (centrs) {
		servers[CENTRS_MCP_SERVER] = {
			transport: "stdio",
			command: opts.bun,
			args: [centrs, "mcp"],
			env: opts.cdbFile ? { CENTRS_CDB_FILE: opts.cdbFile } : {},
		};
	} else {
		missed.push(CENTRS_MCP_SERVER);
	}
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
export function seedToolNames(resolved: {
	centrs: boolean;
	rosetta: boolean;
}): string[] {
	return [
		...UI_TOOL_NAMES.map((t) => mcpToolName(t)),
		...(resolved.centrs
			? CENTRS_READONLY_TOOLS.map((t) => trilogyToolName(CENTRS_MCP_SERVER, t))
			: []),
		...(resolved.rosetta
			? ROSETTA_SEED_TOOLS.map((t) => trilogyToolName(ROSETTA_MCP_SERVER, t))
			: []),
	];
}

/**
 * Every namespaced tool seeded as a tagged tool_action allow rule
 * under the preallow toggle, in seed order: the four ui_* tools
 * (T55 plus T110 ui_add_device) then the read-only centrs +
 * rosetta tools (T105). This is the fully-resolved set; server.ts
 * narrows it via seedToolNames when a bundle entry is missing.
 */
export const SEED_TOOL_NAMES: string[] = seedToolNames({
	centrs: true,
	rosetta: true,
});

/** The ui server key, re-exported for report/test consumers. */
export { UI_MCP_SERVER };
