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
// unrelated sections survive byte-identical (the T84 lesson). The new
// content lands via an exclusively created sibling temp + rename, so
// a failed write never destroys the file; a symlink anywhere in the
// <dataHome>/routeros-muse chain refuses the operation outright.
import * as nodeCrypto from "node:crypto";
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

/** Thrown when the settings chain holds a symlink (never followed). */
export class SettingsSymlinkError extends Error {
	readonly link: string;
	constructor(link: string) {
		super(`refused: not following symlink at ${link}`);
		this.name = "SettingsSymlinkError";
		this.link = link;
	}
}

/**
 * lstat the chain from <dataHome>/routeros-muse down to settings.toml.
 * Returns the offending path when any component is a symlink, else
 * null. Absent components are fine (not symlinks; creation follows).
 */
function chainSymlink(file: string): string | null {
	for (const p of [path.dirname(file), file]) {
		try {
			if (nodeFs.lstatSync(p).isSymbolicLink()) return p;
		} catch {
			// Absent: nothing to follow.
		}
	}
	return null;
}

/**
 * Read the stored default access mode. Missing file, unparseable
 * file, missing key, a value outside the two selector modes, or a
 * symlink in the chain all read as null (the caller applies the
 * default) — a symlinked file falls back exactly like a corrupt one.
 */
export function readDefaultAccess(dataHome?: string): DefaultAccess | null {
	const file = settingsFile(dataHome);
	if (chainSymlink(file) !== null) return null;
	let text: string;
	try {
		text = nodeFs.readFileSync(file, "utf8");
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

const SECTION_RE = /^\s*\[\s*(?:agent|"agent"|'agent')\s*\]\s*(?:#.*)?$/;
const KEY_RE =
	/^(\s*)(?:default_access|"default_access"|'default_access')(\s*)=.*$/;

/**
 * Narrow test seam for the settings write (T50 follow-up), mirroring
 * ScaffoldFs (T97): lets tests inject failing/short writers.
 * Production callers leave it unset and get node:fs straight through.
 */
export type SettingsFs = {
	openSync?: (p: string, flags: string, mode: number) => number;
	writeSync?: (
		fd: number,
		buf: Buffer,
		offset: number,
		length: number,
	) => number;
	fsyncSync?: (fd: number) => void;
	closeSync?: (fd: number) => void;
};

/**
 * Write content to file via an exclusively created sibling temp
 * (settings.toml.<pid>.<rand>.tmp, O_EXCL, mode 0600) + rename: the
 * write loops until every byte lands (a zero-byte write is an
 * error), the fd closes in a finally, and on ANY error the temp is
 * unlinked and the original stays untouched.
 */
function writeFileAtomic(file: string, content: string, fs?: SettingsFs): void {
	const openSync = fs?.openSync ?? nodeFs.openSync;
	const writeSync =
		fs?.writeSync ??
		((fd: number, buf: Buffer, offset: number, length: number): number =>
			nodeFs.writeSync(fd, buf, offset, length, null));
	const fsyncSync = fs?.fsyncSync ?? nodeFs.fsyncSync;
	const closeSync = fs?.closeSync ?? nodeFs.closeSync;
	const rand = nodeCrypto.randomBytes(8).toString("hex");
	const tmp = `${file}.${process.pid}.${rand}.tmp`;
	const fd = openSync(tmp, "wx", 0o600);
	try {
		try {
			const buf = Buffer.from(content, "utf8");
			let off = 0;
			while (off < buf.length) {
				const n = writeSync(fd, buf, off, buf.length - off);
				if (n <= 0) {
					throw new Error(
						`short write on ${file}: wrote ${n} of ${buf.length - off} bytes`,
					);
				}
				off += n;
			}
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		nodeFs.renameSync(tmp, file);
	} catch (err) {
		try {
			nodeFs.unlinkSync(tmp);
		} catch {
			// Best effort: the temp may already be gone.
		}
		throw err;
	}
}

/**
 * Store the default access mode, creating the file (and dir) when
 * needed. Every other line — comments, other sections, other keys —
 * is preserved byte-identical. Bare, double-quoted, and
 * single-quoted key spellings all match, and save as exactly one
 * bare key (Bun.TOML.parse rejects duplicates, so a second spelling
 * would otherwise corrupt the read). A symlink in the chain throws
 * SettingsSymlinkError without touching anything.
 */
export function writeDefaultAccess(
	dataHome: string | undefined,
	mode: DefaultAccess,
	fs?: SettingsFs,
): void {
	const file = settingsFile(dataHome);
	const link = chainSymlink(file);
	if (link !== null) throw new SettingsSymlinkError(link);
	nodeFs.mkdirSync(path.dirname(file), { recursive: true });
	let text: string;
	try {
		text = nodeFs.readFileSync(file, "utf8");
	} catch (err) {
		// Only a missing file starts empty; an unreadable one (EACCES,
		// EISDIR, ...) must never be replaced wholesale.
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		text = "";
	}
	const hasTrailingNl = text.endsWith("\n");
	const lines = text.length === 0 ? [] : text.split("\n");
	// Drop the phantom last element a trailing newline produces, so a
	// join("\n") round-trips the untouched lines byte-identical.
	if (hasTrailingNl && lines.length > 0) lines.pop();
	let sectionAt = -1;
	const keyAts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (/^\s*\[/.test(line)) {
			if (sectionAt !== -1) break;
			if (SECTION_RE.test(line)) sectionAt = i;
			continue;
		}
		if (sectionAt !== -1 && KEY_RE.test(line)) keyAts.push(i);
	}
	const replacement = `default_access = "${mode}"`;
	const firstKey = keyAts[0];
	if (firstKey !== undefined) {
		lines[firstKey] = replacement;
		// Drop any further bare/quoted duplicates: the file holds one key.
		for (let k = keyAts.length - 1; k >= 1; k--) {
			lines.splice(keyAts[k] as number, 1);
		}
	} else if (sectionAt !== -1) {
		lines.splice(sectionAt + 1, 0, replacement);
	} else {
		if (lines.length > 0) lines.push("");
		lines.push("[agent]", replacement);
	}
	writeFileAtomic(file, `${lines.join("\n")}\n`, fs);
}
