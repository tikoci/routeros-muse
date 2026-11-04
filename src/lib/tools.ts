// Tool resolution (T51, D26): package.json owns the trilogy versions.
// The package's own node_modules/.bin fronts PATH for every trilogy
// spawn — bootstrap, server, and agent children alike — so all sides
// resolve the identical builds. Never mutate process.env to do it:
// Bun.spawn inherits the startup snapshot, so each spawn takes an
// explicit env built here.
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { have, run } from "./run";

export const TRILOGY = ["quickchr", "centrs", "rosetta"] as const;
export type TrilogyTool = (typeof TRILOGY)[number];

export type Installed = Record<TrilogyTool, string | null>;

export type ToolSource = "package" | "ambient";

/** First dotted version in output, keeping suffixes like -next. */
export function parseVersion(out: string): string | null {
	const m = out.match(/(\d+\.\d+\.\d+[-+a-zA-Z0-9.]*)/);
	return m?.[1] ?? null;
}

async function detectOne(
	tool: TrilogyTool,
	env?: Record<string, string>,
): Promise<string | null> {
	if (!have(tool, env)) return null;
	// quickchr `version` phones home for RouterOS releases; still the
	// curated path, with a generous timeout.
	const attempts =
		tool === "quickchr"
			? [["quickchr", "version"]]
			: [
					[tool, "--version"],
					[tool, "--help"],
				];
	for (const cmd of attempts) {
		const r = await run(cmd, { timeoutMs: 25_000, env });
		const v = parseVersion(`${r.stdout}\n${r.stderr}`);
		if (v) return v;
	}
	return null;
}

/** Detect the trilogy versions resolving under env (ambient when omitted). */
export async function detectInstalled(
	env?: Record<string, string>,
): Promise<Installed> {
	const [quickchr, centrs, rosetta] = await Promise.all([
		detectOne("quickchr", env),
		detectOne("centrs", env),
		detectOne("rosetta", env),
	]);
	return { quickchr, centrs, rosetta };
}

/**
 * Walk up from fromDir to the routeros-muse package root (the dir whose
 * package.json names it). Null when the install shape is unknown —
 * callers fall back to ambient PATH honestly instead of guessing.
 */
export function packageRoot(
	fromDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string | null {
	let dir = fromDir;
	for (let i = 0; i < 6; i++) {
		try {
			const pkg = JSON.parse(
				nodeFs.readFileSync(path.join(dir, "package.json"), "utf8"),
			) as Record<string, unknown>;
			if (pkg["name"] === "@tikoci/routeros-muse") return dir;
		} catch {
			// Not a package dir (or unreadable): keep climbing.
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/**
 * node_modules dirs that hold our dependencies, nearest first: the
 * package's own (a checkout), then the enclosing one when this package
 * is itself installed (bunx, bun add, -g), where Bun hoists our deps.
 */
export function bundleRoots(pkgRoot: string): string[] {
	const roots = [path.join(pkgRoot, "node_modules")];
	const parts = pkgRoot.split(path.sep);
	const nm = parts.lastIndexOf("node_modules");
	if (nm > 0) roots.push(parts.slice(0, nm + 1).join(path.sep));
	return roots;
}

/**
 * The package tool bundle: the first bundle root's .bin that exists.
 * Null when none does — the honest ambient fallback.
 */
export function toolBinDir(
	pkgRoot: string | null = packageRoot(),
): string | null {
	if (!pkgRoot) return null;
	for (const root of bundleRoots(pkgRoot)) {
		const bin = path.join(root, ".bin");
		try {
			if (nodeFs.statSync(bin).isDirectory()) return bin;
		} catch {
			// Not there: try the next root.
		}
	}
	return null;
}

export function toolSource(binDir: string | null): ToolSource {
	return binDir ? "package" : "ambient";
}

/**
 * Explicit spawn env with the tool bundle fronted on PATH. base
 * defaults to the current process env; the result is always a fresh
 * record (callers never mutate process.env through it).
 */
export function toolEnv(
	binDir: string | null,
	base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(base)) {
		if (v !== undefined) env[k] = v;
	}
	if (binDir) {
		const cur = env["PATH"] ?? "";
		env["PATH"] = cur ? `${binDir}${path.delimiter}${cur}` : binDir;
	}
	return env;
}

/** package.json specs for the trilogy (what D26 says runs). */
export function pinnedTools(
	pkgRoot: string | null = packageRoot(),
): Record<TrilogyTool, string | null> {
	const none = { quickchr: null, centrs: null, rosetta: null };
	if (!pkgRoot) return none;
	try {
		const pkg = JSON.parse(
			nodeFs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;
		const deps = {
			...((pkg["dependencies"] as Record<string, unknown> | undefined) ?? {}),
			...((pkg["devDependencies"] as Record<string, unknown> | undefined) ??
				{}),
		};
		const spec = (tool: TrilogyTool): string | null => {
			const v = deps[`@tikoci/${tool}`];
			return typeof v === "string" && v ? v : null;
		};
		return {
			quickchr: spec("quickchr"),
			centrs: spec("centrs"),
			rosetta: spec("rosetta"),
		};
	} catch {
		return none;
	}
}

/** Bootstrap step-2 header lines: what package.json says, and what fronts PATH. */
export function toolSourceLines(
	specs: Record<TrilogyTool, string | null>,
	binDir: string | null,
): string[] {
	const pinned = TRILOGY.map((t) => `${t}@${specs[t] ?? "(not pinned)"}`).join(
		", ",
	);
	if (!binDir) {
		return [
			`  package.json: ${pinned}`,
			"  WARNING: package tool bundle missing (no node_modules/.bin) — resolving the trilogy from ambient PATH.",
			"  Run `bun install` in the routeros-muse checkout so every side resolves the pinned builds.",
		];
	}
	return [`  package.json: ${pinned}`, `  tools: package bundle (${binDir})`];
}
