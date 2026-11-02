// Machine settings (T50, D38): the default agent access mode.
//
// Lives next to the workspaces registry at
// <dataHome>/routeros-muse/settings.toml — same XDG data home, same
// override (ServeOpts.dataHome) so tests isolate hermetically:
//
//   [agent]
//   default_access = "promptUnmatched" | "allowAll"
//
// Only the two selector modes are storable; anything else on disk is
// ignored (read falls back to null, the caller applies the default).
// Writes use line surgery, never parse-and-re-emit, so comments and
// unrelated sections survive byte-identical (the T84 lesson).
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { dataHomeDir } from "./registry";
import { parseToml } from "./toml";

export type DefaultAccess = "promptUnmatched" | "allowAll";

export function isDefaultAccess(v: unknown): v is DefaultAccess {
	return v === "promptUnmatched" || v === "allowAll";
}

/** The settings file itself. Pure (no fs touch) so tests assert paths. */
export function settingsFile(dataHome?: string): string {
	return path.join(dataHomeDir(dataHome), "routeros-muse", "settings.toml");
}

/**
 * Read the stored default access mode. Missing file, unparseable
 * file, missing key, or a value outside the two selector modes all
 * read as null (the caller applies the default).
 */
export function readDefaultAccess(dataHome?: string): DefaultAccess | null {
	let text: string;
	try {
		text = nodeFs.readFileSync(settingsFile(dataHome), "utf8");
	} catch {
		return null;
	}
	const parsed = parseToml(text);
	if (!parsed.ok) return null;
	const agent = parsed.value["agent"];
	if (typeof agent !== "object" || agent === null || Array.isArray(agent)) {
		return null;
	}
	const v = (agent as Record<string, unknown>)["default_access"];
	return isDefaultAccess(v) ? v : null;
}

const SECTION_RE = /^\s*\[agent\]\s*(?:#.*)?$/;
const KEY_RE = /^(\s*)default_access(\s*)=.*$/;

/**
 * Store the default access mode, creating the file (and dir) when
 * needed. Every other line — comments, other sections, other keys —
 * is preserved byte-identical.
 */
export function writeDefaultAccess(
	dataHome: string | undefined,
	mode: DefaultAccess,
): void {
	const file = settingsFile(dataHome);
	nodeFs.mkdirSync(path.dirname(file), { recursive: true });
	let text: string;
	try {
		text = nodeFs.readFileSync(file, "utf8");
	} catch {
		text = "";
	}
	const hasTrailingNl = text.endsWith("\n");
	const lines = text.length === 0 ? [] : text.split("\n");
	// Drop the phantom last element a trailing newline produces, so a
	// join("\n") round-trips the untouched lines byte-identical.
	if (hasTrailingNl && lines.length > 0) lines.pop();
	let sectionAt = -1;
	let keyAt = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (/^\s*\[/.test(line)) {
			if (sectionAt !== -1 && keyAt === -1) break;
			if (SECTION_RE.test(line)) sectionAt = i;
			else if (sectionAt !== -1) break;
			continue;
		}
		if (sectionAt !== -1 && keyAt === -1 && KEY_RE.test(line)) keyAt = i;
	}
	const replacement = `default_access = "${mode}"`;
	if (keyAt !== -1) {
		lines[keyAt] = replacement;
	} else if (sectionAt !== -1) {
		lines.splice(sectionAt + 1, 0, replacement);
	} else {
		if (lines.length > 0) lines.push("");
		lines.push("[agent]", replacement);
	}
	nodeFs.writeFileSync(file, `${lines.join("\n")}\n`);
}
