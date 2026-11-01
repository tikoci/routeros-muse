// Step 2 (+4b): trilogy pins. Installed versions are detected up
// front through the package-fronted env (tools.ts); the comparison
// against workspace.toml [pins] happens after the workspace opens
// (that is where the pins live). D26: package.json drives
// resolution, [pins] is the per-setup verified-against record —
// unpinned entries and mismatches block with remedies, never with a
// global install.

import { run } from "../lib/run";
import {
	detectInstalled,
	type Installed,
	type ToolSource,
	TRILOGY,
	type TrilogyTool,
	toolEnv,
} from "../lib/tools";

export { parseVersion } from "../lib/tools";
// Re-exported so existing importers keep working; the trilogy
// foundation lives in lib/tools.ts (serve/ imports it from there).
export { detectInstalled, type Installed, TRILOGY, type TrilogyTool };

export function printInstalled(i: Installed): void {
	for (const tool of TRILOGY) {
		console.log(`  ${tool}: ${i[tool] ?? "MISSING"}`);
	}
}

export type PinCompare = {
	unpinned: TrilogyTool[];
	mismatched: { tool: TrilogyTool; pin: string; installed: string | null }[];
};

export function isUnpinned(value: unknown): boolean {
	return (
		typeof value !== "string" || value === "" || /^(unpinned|todo)/i.test(value)
	);
}

/**
 * Channel pin: "next" (spelled with or without the @) tracks the
 * @next dist-tag instead of a fixed version. Suffix-matching cannot
 * work — quickchr publishes plain versions to both tags — so channel
 * pins resolve through the registry at bootstrap time.
 */
export function isChannelPin(value: unknown): boolean {
	return typeof value === "string" && /^@?next$/i.test(value.trim());
}

export type ChannelResolver = (tool: TrilogyTool) => Promise<string | null>;

/** Resolve @next for one tool via the registry; null when unreachable. */
export async function resolveChannelPin(
	tool: TrilogyTool,
): Promise<string | null> {
	// T94: npm enables Node's compile cache by default, which lands in
	// $TMPDIR/node-compile-cache. One registry lookup must not litter
	// TMPDIR (production @next resolves hit this too), so disable it.
	const env = toolEnv(null);
	env["NODE_DISABLE_COMPILE_CACHE"] = "1";
	const r = await run(
		["npm", "view", `@tikoci/${tool}`, "dist-tags", "--json"],
		{
			timeoutMs: 30_000,
			env,
		},
	);
	const out = `${r.stdout}\n${r.stderr}`;
	try {
		const tags = JSON.parse(r.stdout) as Record<string, unknown>;
		if (typeof tags["next"] === "string" && tags["next"])
			return tags["next"] as string;
	} catch {
		// fall through to the text-shape regex
	}
	const m = out.match(/["']?next["']?\s*:\s*["']([^"']+)["']/);
	return m?.[1] ?? null;
}

export type ResolvedPins = {
	pins: Record<string, unknown>;
	failed: TrilogyTool[];
};

/**
 * Substitute every channel pin with its resolved version; exact pins
 * pass through. failed names tools whose tag did not resolve (the
 * caller stops: an unverifiable channel pin blocks, never defaults).
 */
export async function resolvePins(
	pins: Record<string, unknown>,
	resolve: ChannelResolver = resolveChannelPin,
): Promise<ResolvedPins> {
	const out: Record<string, unknown> = { ...pins };
	const failed: TrilogyTool[] = [];
	for (const tool of TRILOGY) {
		if (!isChannelPin(pins[tool])) continue;
		const v = await resolve(tool);
		if (v) out[tool] = v;
		else failed.push(tool);
	}
	return { pins: out, failed };
}

export function comparePins(
	pins: Record<string, unknown>,
	installed: Installed,
): PinCompare {
	const unpinned: TrilogyTool[] = [];
	const mismatched: PinCompare["mismatched"] = [];
	for (const tool of TRILOGY) {
		const pin = pins[tool];
		if (isUnpinned(pin)) {
			unpinned.push(tool);
			continue;
		}
		if (installed[tool] !== pin) {
			mismatched.push({
				tool,
				pin: pin as string,
				installed: installed[tool],
			});
		}
	}
	return { unpinned, mismatched };
}

/** Stop body for unpinned entries (the resume line stays with the caller). */
export function unpinnedMessage(
	unpinned: TrilogyTool[],
	installed: Installed,
): string[] {
	return [
		`Unpinned [pins] entries block the bootstrap (${unpinned.map((t) => `[pins].${t}`).join(", ")}).`,
		...unpinned.map(
			(t) =>
				`  TODO [pins].${t}: set the verified version (running here: ${installed[t] ?? "missing"}).`,
		),
		"Pin before trusting a fresh machine's output against old observations, then resume:",
	];
}

/**
 * Stop body for bundle-vs-pins drift. The fix is never a global
 * install: refresh the bundle package.json resolves, or re-verify
 * the setup against the running versions and bump [pins].
 */
export function mismatchMessage(
	mismatched: PinCompare["mismatched"],
	source: ToolSource,
): string[] {
	const where = source === "package" ? "package bundle" : "ambient PATH";
	return [
		"Tool bundle differs from this setup's verified-against [pins]:",
		...mismatched.map(
			(m) =>
				`  ${m.tool}: running ${m.installed ?? "missing"} (${where}) vs verified ${m.pin}`,
		),
		"Refresh the bundle (reinstall routeros-muse so package.json re-resolves @next, or `bun install` in a source checkout),",
		"or re-verify this setup against the running versions and bump [pins]. Then resume:",
	];
}
