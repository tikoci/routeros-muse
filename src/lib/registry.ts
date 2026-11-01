// Workspaces registry (T40): the machine-local list of network
// workspaces, so no-workspace mode can steer toward opening or
// creating one instead of stranding the operator.
//
// State, not config: the registry lives under XDG_DATA_HOME
// (default ~/.local/share) at routeros-muse/registry.toml —
// alongside muse's own homes, not beside user config — because it is
// regenerable runtime state (serving a workspace re-registers it),
// like shell history rather than a dotfile. XDG_DATA_HOME is
// overridable (ServeOpts.dataHome) so tests isolate here hermetically.
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseToml } from "./toml";

export type RegistryEntry = {
	name: string;
	path: string;
	added: string;
	lastOpened: string;
};

/** XDG data home: explicit override, else XDG_DATA_HOME, else ~/.local/share. */
export function dataHomeDir(override?: string): string {
	if (override) return override;
	const env = process.env["XDG_DATA_HOME"];
	if (env) return env;
	return path.join(os.homedir(), ".local", "share");
}

/** The registry file itself. Pure (no fs touch) so tests assert paths. */
export function registryFile(dataHome?: string): string {
	return path.join(dataHomeDir(dataHome), "routeros-muse", "registry.toml");
}

/**
 * Default location for NEW workspaces: ~/Networks. One predictable
 * path on every OS (no XDG user-dirs parsing, no mac/Windows
 * special-cases in the prototype), and machine-managed network trees
 * stay out of the user's documents clutter. Overridable
 * (ServeOpts.defaultWorkspaceDir) so tests create hermetically.
 */
export function defaultWorkspacesDir(override?: string): string {
	if (override) return override;
	return path.join(os.homedir(), "Networks");
}

export type RegistryRead = {
	entries: RegistryEntry[];
	/** True when the file existed but did not parse (or held bad rows). */
	corrupt: boolean;
};

/** Read the registry; a missing file is an empty registry, not an error. */
export function readRegistry(file: string): RegistryRead {
	let text: string;
	try {
		text = nodeFs.readFileSync(file, "utf8");
	} catch {
		return { entries: [], corrupt: false };
	}
	const parsed = parseToml(text);
	if (!parsed.ok) return { entries: [], corrupt: true };
	const raw = parsed.value["workspace"];
	if (raw === undefined) return { entries: [], corrupt: false };
	if (!Array.isArray(raw)) return { entries: [], corrupt: true };
	const entries: RegistryEntry[] = [];
	let corrupt = false;
	for (const row of raw) {
		const r = row as Record<string, unknown>;
		if (
			r &&
			typeof r === "object" &&
			typeof r["name"] === "string" &&
			typeof r["path"] === "string" &&
			typeof r["added"] === "string" &&
			typeof r["lastOpened"] === "string"
		) {
			entries.push({
				name: r["name"],
				path: r["path"],
				added: r["added"],
				lastOpened: r["lastOpened"],
			});
		} else {
			corrupt = true;
		}
	}
	return { entries, corrupt };
}

function tomlString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Write the registry (mkdir -p the parent); the next write heals corruption. */
export function writeRegistry(file: string, entries: RegistryEntry[]): void {
	nodeFs.mkdirSync(path.dirname(file), { recursive: true });
	const body = entries
		.map(
			(e) =>
				`[[workspace]]\nname = ${tomlString(e.name)}\npath = ${tomlString(e.path)}\nadded = ${tomlString(e.added)}\nlastOpened = ${tomlString(e.lastOpened)}\n`,
		)
		.join("\n");
	nodeFs.writeFileSync(file, body);
}

/**
 * Upsert by path: new paths append with added=lastOpened=now;
 * known paths keep added and refresh name + lastOpened. Returns the entry.
 */
export function registerWorkspace(
	file: string,
	name: string,
	dir: string,
	now: string = new Date().toISOString(),
): RegistryEntry {
	const { entries } = readRegistry(file);
	const at = entries.findIndex((e) => e.path === dir);
	if (at >= 0) {
		const prev = entries[at] as RegistryEntry;
		const next = { name, path: dir, added: prev.added, lastOpened: now };
		entries[at] = next;
		writeRegistry(file, entries);
		return next;
	}
	const entry = { name, path: dir, added: now, lastOpened: now };
	entries.push(entry);
	writeRegistry(file, entries);
	return entry;
}

/**
 * Drop entries that are no longer workspaces (missing dir or no
 * workspace.toml). Returns the survivors plus the removed count.
 */
export function pruneRegistry(file: string): {
	entries: RegistryEntry[];
	removed: number;
} {
	const { entries } = readRegistry(file);
	const kept = entries.filter((e) => {
		try {
			return nodeFs.statSync(path.join(e.path, "workspace.toml")).isFile();
		} catch {
			return false;
		}
	});
	const removed = entries.length - kept.length;
	if (removed > 0) writeRegistry(file, kept);
	return { entries: kept, removed };
}

/** Live check for picker display (computed, never stored). */
export function registryEntryAlive(entry: RegistryEntry): boolean {
	try {
		return nodeFs.statSync(path.join(entry.path, "workspace.toml")).isFile();
	} catch {
		return false;
	}
}
