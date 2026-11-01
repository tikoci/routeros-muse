// Doctor spec (D15/D20): one packaged machine-readable file, plus
// optional workspace additions merged on top, never a fork. Tiers
// are contextual: the base tier plus per-skill escalation via
// required_for (required-for-this-skill when that skill runs).

import * as path from "node:path";
import { runShell } from "../lib/run";
import { parseToml } from "../lib/toml";

export const TIERS = ["required", "recommended", "helpful"] as const;
export type Tier = (typeof TIERS)[number];

export type DoctorEntry = {
	id: string;
	os: string;
	tier: Tier;
	detect: string;
	hint: string;
	why: string;
	skills: string[];
	required_for: string[];
};

export function packageDoctorPath(): string {
	return path.join(import.meta.dir, "..", "..", "doctor.toml");
}

export function workspaceDoctorPath(wsDir: string): string {
	return path.join(wsDir, "doctor.local.toml");
}

function asStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
}

function parseEntries(text: string, what: string): DoctorEntry[] {
	const parsed = parseToml(text);
	if (!parsed.ok) throw new Error(`${what} does not parse: ${parsed.error}`);
	const raw = parsed.value["tool"];
	if (!Array.isArray(raw)) throw new Error(`${what} has no [[tool]] entries`);
	return raw.map((t, i) => {
		const e = t as Record<string, unknown>;
		const id = e["id"];
		const os = e["os"];
		const tier = e["tier"];
		const detect = e["detect"];
		const hint = e["hint"];
		const why = e["why"];
		for (const [k, v] of [
			["id", id],
			["os", os],
			["tier", tier],
			["detect", detect],
			["hint", hint],
			["why", why],
		] as const) {
			if (typeof v !== "string" || v === "") {
				throw new Error(
					`${what} entry ${i} (${String(id ?? "?")}): ${k} must be a non-empty string`,
				);
			}
		}
		if (!(TIERS as readonly string[]).includes(tier as string)) {
			throw new Error(
				`${what} entry ${i} (${id}): tier must be required|recommended|helpful`,
			);
		}
		return {
			id: id as string,
			os: os as string,
			tier: tier as Tier,
			detect: detect as string,
			hint: hint as string,
			why: why as string,
			skills: asStringArray(e["skills"]),
			required_for: asStringArray(e["required_for"]),
		};
	});
}

/**
 * Merge base + workspace additions: same id+os overrides the base
 * entry field-wise, new ids append. Additions, never a fork.
 */
export function mergeEntries(
	base: DoctorEntry[],
	overlay: DoctorEntry[],
): DoctorEntry[] {
	const merged = base.map((e) => ({ ...e }));
	for (const o of overlay) {
		const at = merged.findIndex((e) => e.id === o.id && e.os === o.os);
		if (at >= 0) merged[at] = { ...o };
		else merged.push({ ...o });
	}
	return merged;
}

export async function loadDoctorSpec(wsDir: string): Promise<DoctorEntry[]> {
	const baseText = await Bun.file(packageDoctorPath()).text();
	const base = parseEntries(baseText, "packaged doctor.toml");
	const overlayPath = workspaceDoctorPath(wsDir);
	if (!(await Bun.file(overlayPath).exists())) return base;
	const overlayText = await Bun.file(overlayPath).text();
	const overlay = parseEntries(overlayText, "doctor.local.toml");
	console.log(
		`  workspace doctor additions: ${overlay.length} ${overlay.length === 1 ? "entry" : "entries"} merged`,
	);
	return mergeEntries(base, overlay);
}

export type DoctorResult = {
	entry: DoctorEntry;
	present: boolean;
};

export async function runDoctor(
	entries: DoctorEntry[],
	os: string,
): Promise<DoctorResult[]> {
	const mine = entries.filter((e) => e.os === os);
	const results: DoctorResult[] = [];
	for (const entry of mine) {
		const r = await runShell(entry.detect, { timeoutMs: 10_000 });
		results.push({ entry, present: r.ok });
	}
	return results;
}

/** Prints the report. Returns the missing required entries (blocking). */
export function printDoctor(results: DoctorResult[]): DoctorEntry[] {
	const missingRequired: DoctorEntry[] = [];
	for (const tier of TIERS) {
		const rows = results.filter((r) => r.entry.tier === tier);
		if (rows.length === 0) continue;
		console.log(`  ${tier}:`);
		for (const { entry, present } of rows) {
			const mark = present ? "ok  " : "MISS";
			let line = `    [${mark}] ${entry.id} — ${entry.why}`;
			if (!present && entry.required_for.length > 0) {
				line += ` (required for: ${entry.required_for.join(", ")})`;
			} else if (!present && entry.skills.length > 0) {
				line += ` (matters to: ${entry.skills.join(", ")})`;
			}
			console.log(line);
			if (!present) {
				console.log(`           hint: ${entry.hint}`);
				if (tier === "required") missingRequired.push(entry);
			}
		}
	}
	return missingRequired;
}
