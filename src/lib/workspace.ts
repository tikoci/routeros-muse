// Workspace module (T40): tree, recents, file reads/writes (TOML
// validate-before-save), TOML sections, alerts, and render-adjacent
// artifact serving — UI-agnostic file ops over a workspace root. Serve
// routes stay thin wrappers mapping results to HTTP.
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { loadDoctorSpec, runDoctor } from "../steps/doctor";
import { readDevices } from "./fleet";
import { have, run } from "./run";
import {
	type CreatedPath,
	copyTemplateFiles,
	isRealDir,
	listTemplateFiles,
	lstatExists,
	readTemplateMeta,
	ScaffoldConflict,
	type ScaffoldFs,
	templateDir,
	templatesRoot,
} from "./templates";
import { parseToml } from "./toml";

export type TreeEntry = {
	path: string;
	name: string;
	kind: "toml" | "md" | "dir" | "file";
	meta: string;
	depth: number;
};

const MAX_TREE_ENTRIES = 500;
const MAX_FILE_BYTES = 512 * 1024;

export function kindOf(name: string, isDir: boolean): TreeEntry["kind"] {
	if (isDir) return "dir";
	if (name.endsWith(".toml")) return "toml";
	if (name.endsWith(".md") || name.endsWith(".markdown")) return "md";
	return "file";
}

/** Resolve rel inside root; null on traversal/absolute escape. */
export function safeJoin(root: string, rel: string): string | null {
	if (path.isAbsolute(rel)) return null;
	const full = path.resolve(root, rel);
	const base = path.resolve(root);
	if (full !== base && !full.startsWith(base + path.sep)) return null;
	return full;
}

export function ageOf(mtimeMs: number): string {
	const s = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
	if (s < 90) return "just now";
	const m = Math.floor(s / 60);
	if (m < 90) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 36) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

export function walkTree(
	root: string,
	depth: number,
	out: TreeEntry[],
	rel = "",
): void {
	if (out.length >= MAX_TREE_ENTRIES || depth > 4) return;
	let names: string[];
	try {
		names = nodeFs.readdirSync(path.join(root, rel)).sort();
	} catch {
		return;
	}
	for (const name of names) {
		if (out.length >= MAX_TREE_ENTRIES) return;
		if (name.startsWith(".git") || name === "node_modules") continue;
		const relPath = rel ? `${rel}/${name}` : name;
		const full = path.join(root, relPath);
		let st: nodeFs.Stats;
		try {
			st = nodeFs.statSync(full);
		} catch {
			continue;
		}
		const isDir = st.isDirectory();
		out.push({
			path: relPath,
			name,
			kind: kindOf(name, isDir),
			meta: isDir ? "" : ageOf(st.mtimeMs),
			depth,
		});
		if (isDir) walkTree(root, depth + 1, out, relPath);
	}
}

export type RecentRow = {
	path: string;
	title: string;
	file: string;
	kind: "toml" | "md" | "dir";
	meta: string;
};

function firstH1(text: string): string | null {
	for (const line of text.split("\n").slice(0, 20)) {
		const m = line.match(/^#\s+(.+?)\s*$/);
		if (m) return (m[1] ?? "").slice(0, 80);
	}
	return null;
}

function deviceTitle(root: string): string | null {
	const first = readDevices(root)[0];
	if (!first) return null;
	return first.label && !first.label.startsWith("REPLACE")
		? first.label
		: first.id;
}

/** Curated recents: topology-adjacent rows ordered by mtime. */
export function listRecents(root: string): RecentRow[] {
	const cands: string[] = ["workspace.toml", "router.toml"];
	for (const dir of ["operations", "inbox", "observations", "reports"]) {
		const full = path.join(root, dir);
		let names: string[] = [];
		try {
			names = nodeFs.readdirSync(full);
		} catch {
			continue;
		}
		for (const n of names) {
			if (n.startsWith(".")) continue;
			cands.push(`${dir}/${n}`);
		}
	}
	const rows: (RecentRow & { mtime: number })[] = [];
	for (const rel of cands) {
		const full = path.join(root, rel);
		let st: nodeFs.Stats;
		try {
			st = nodeFs.statSync(full);
		} catch {
			continue;
		}
		const isDir = st.isDirectory();
		if (isDir && rel !== "inbox") continue;
		const base = path.basename(rel);
		let title = base;
		const kind: RecentRow["kind"] = isDir
			? "dir"
			: base.endsWith(".toml")
				? "toml"
				: "md";
		if (!isDir && kind === "md") {
			try {
				title =
					firstH1(nodeFs.readFileSync(full, "utf8").slice(0, 4096)) ??
					base.replace(/\.md$/, "");
			} catch {
				title = base;
			}
		} else if (rel === "router.toml") {
			title = deviceTitle(root) ?? "router.toml";
		} else if (rel === "workspace.toml") {
			title = "Network setup";
		}
		rows.push({
			path: rel,
			title,
			file: isDir ? `${base}/` : base,
			kind,
			meta: rel.startsWith("operations/")
				? "handoff"
				: isDir
					? "unshaped"
					: ageOf(st.mtimeMs),
			mtime: st.mtimeMs,
		});
	}
	rows.sort((a, b) => b.mtime - a.mtime);
	return rows.map(({ mtime: _mtime, ...r }) => r);
}

export type FileResult = { status: number; body: unknown };

/** Read one workspace file (GET /api/file shape). */
export function readWorkspaceFile(root: string, rel: string): FileResult {
	const full = safeJoin(root, rel);
	if (!full)
		return {
			status: 400,
			body: { ok: false, why: "path escapes the workspace" },
		};
	let st: nodeFs.Stats;
	try {
		st = nodeFs.statSync(full);
	} catch {
		return { status: 404, body: { ok: false, why: "no such file" } };
	}
	if (st.isDirectory())
		return { status: 400, body: { ok: false, why: "is a directory" } };
	if (st.size > MAX_FILE_BYTES)
		return { status: 400, body: { ok: false, why: "file too large" } };
	const text = nodeFs.readFileSync(full, "utf8");
	return {
		status: 200,
		body: {
			ok: true,
			path: rel,
			kind: kindOf(path.basename(rel), false),
			text,
		},
	};
}

/** Top-level value kind for the TOML-editor drift guard. */
function tomlKind(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value instanceof Date) return "datetime";
	if (value !== null && typeof value === "object") return "table";
	if (typeof value === "string") return "string";
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	if (value === null) return "null";
	return typeof value;
}

export type WriteOpts = { fromTomlEditor?: boolean };

/**
 * Write one workspace file, TOML validated before save (POST /api/file).
 * Editor-marked TOML saves (T84) also fail closed on semantic drift: the
 * original must be readable and parseable, the old and new top-level key
 * sets and per-key kinds must match exactly, and within top-level tables
 * the row keys and per-row kinds must match too — anything else is
 * rejected with 409. Unmarked writes keep the syntax-only check.
 */
export function writeWorkspaceFile(
	root: string,
	rel: string,
	text: string,
	opts?: WriteOpts,
): FileResult {
	const full = safeJoin(root, rel);
	if (!full)
		return {
			status: 400,
			body: { ok: false, why: "path escapes the workspace" },
		};
	if (rel.endsWith(".toml")) {
		const parsed = parseToml(text);
		if (!parsed.ok)
			return {
				status: 400,
				body: { ok: false, why: `invalid TOML: ${parsed.error}` },
			};
		if (opts?.fromTomlEditor === true) {
			let oldText: string;
			try {
				oldText = nodeFs.readFileSync(full, "utf8");
			} catch {
				return {
					status: 409,
					body: {
						ok: false,
						why: "TOML editor save has no readable original; edit the file by hand",
					},
				};
			}
			const old = parseToml(oldText);
			if (!old.ok) {
				return {
					status: 409,
					body: {
						ok: false,
						why: "TOML editor save has no parseable original; edit the file by hand",
					},
				};
			}
			const oldKeys = Object.keys(old.value).sort();
			const newKeys = Object.keys(parsed.value).sort();
			const sameKeys =
				oldKeys.length === newKeys.length &&
				oldKeys.every((k, i) => k === newKeys[i]);
			if (!sameKeys) {
				const all = new Set([...oldKeys, ...newKeys]);
				let drifted = "";
				for (const k of all) {
					if (!oldKeys.includes(k) || !newKeys.includes(k)) {
						drifted = k;
						break;
					}
				}
				return {
					status: 409,
					body: {
						ok: false,
						why: `TOML editor save would change top-level key "${drifted}"; edit the file by hand`,
					},
				};
			}
			for (const k of oldKeys) {
				const before = tomlKind(old.value[k]);
				const after = tomlKind(parsed.value[k]);
				if (before !== after) {
					return {
						status: 409,
						body: {
							ok: false,
							why: `TOML editor save would change "${k}" from ${before} to ${after}; edit the file by hand`,
						},
					};
				}
				if (before === "table") {
					const oldRows = old.value[k] as Record<string, unknown>;
					const newRows = parsed.value[k] as Record<string, unknown>;
					const oldRowKeys = Object.keys(oldRows).sort();
					const newRowKeys = Object.keys(newRows).sort();
					const sameRowKeys =
						oldRowKeys.length === newRowKeys.length &&
						oldRowKeys.every((rk, i) => rk === newRowKeys[i]);
					if (!sameRowKeys) {
						return {
							status: 409,
							body: {
								ok: false,
								why: `TOML editor save would change rows under "${k}"; edit the file by hand`,
							},
						};
					}
					for (const rk of oldRowKeys) {
						const rowBefore = tomlKind(oldRows[rk]);
						const rowAfter = tomlKind(newRows[rk]);
						if (rowBefore !== rowAfter) {
							return {
								status: 409,
								body: {
									ok: false,
									why: `TOML editor save would change "${k}.${rk}" from ${rowBefore} to ${rowAfter}; edit the file by hand`,
								},
							};
						}
					}
				}
			}
		}
	}
	nodeFs.mkdirSync(path.dirname(full), { recursive: true });
	nodeFs.writeFileSync(full, text);
	return { status: 200, body: { ok: true, path: rel } };
}

export type TomlRow = {
	key: string;
	value: string;
	readonly: boolean;
	why: string;
};

export type TomlSection = {
	name: string;
	rows: TomlRow[];
};

const TOP_WHY =
	"top-level arrays and values cannot be edited in this slice; edit the file by hand";
const NESTED_WHY = "nested tables and arrays cannot be edited in this slice";
const TYPE_FLIP_WHY =
	"value looks like a boolean or number; saving would change its type";

function typeFlips(value: string): boolean {
	const t = value.trim();
	return /^(true|false)$/.test(t) || /^-?\d+(\.\d+)?$/.test(t);
}

/**
 * Parsed TOML sections for the settings editor (GET /api/toml shape).
 * Rows the slice cannot re-emit are flagged readonly with a why; the
 * top-level synthetic section is merged into one. writable is true only
 * when every row is editable.
 */
export function readTomlSections(root: string, rel: string): FileResult {
	const full = safeJoin(root, rel);
	if (!full || !rel.endsWith(".toml")) {
		return {
			status: 400,
			body: { ok: false, why: "need a workspace .toml path" },
		};
	}
	let text: string;
	try {
		text = nodeFs.readFileSync(full, "utf8");
	} catch {
		return { status: 404, body: { ok: false, why: "no such file" } };
	}
	const parsed = parseToml(text);
	if (!parsed.ok)
		return {
			status: 400,
			body: { ok: false, why: `invalid TOML: ${parsed.error}` },
		};
	const topRows: TomlRow[] = [];
	const sections: TomlSection[] = [];
	for (const [name, sec] of Object.entries(parsed.value)) {
		if (
			sec &&
			typeof sec === "object" &&
			!Array.isArray(sec) &&
			!(sec instanceof Date)
		) {
			sections.push({
				name,
				rows: Object.entries(sec as Record<string, unknown>).map(
					([key, value]): TomlRow => {
						if (value !== null && typeof value === "object") {
							return {
								key,
								value: JSON.stringify(value) ?? "",
								readonly: true,
								why: NESTED_WHY,
							};
						}
						if (typeof value === "string") {
							if (typeFlips(value)) {
								return { key, value, readonly: true, why: TYPE_FLIP_WHY };
							}
							return { key, value, readonly: false, why: "" };
						}
						return {
							key,
							value: JSON.stringify(value) ?? "",
							readonly: false,
							why: "",
						};
					},
				),
			});
		} else {
			topRows.push({
				key: name,
				value: typeof sec === "string" ? sec : (JSON.stringify(sec) ?? ""),
				readonly: true,
				why: TOP_WHY,
			});
		}
	}
	const merged: TomlSection[] =
		topRows.length > 0
			? [{ name: "(top)", rows: topRows }, ...sections]
			: sections;
	const writable = merged.every((s) => s.rows.every((r) => !r.readonly));
	return {
		status: 200,
		body: { ok: true, path: rel, sections: merged, writable },
	};
}

export type Alert = { title: string; body: string; src: string };

/** Doctor + drift alerts over the workspace (GET /api/alerts shape). */
export async function listAlerts(root: string): Promise<{ alerts: Alert[] }> {
	const alerts: Alert[] = [];
	try {
		const entries = await loadDoctorSpec(root);
		const results = await runDoctor(
			entries,
			process.platform === "darwin" ? "mac" : "linux",
		);
		for (const r of results) {
			if (
				!r.present &&
				(r.entry.tier === "required" || r.entry.tier === "recommended")
			) {
				alerts.push({
					title: `${r.entry.id} is missing`,
					body: r.entry.hint,
					src: `muse doctor · ${r.entry.tier}`,
				});
			}
		}
	} catch {
		// doctor spec problems are not alerts; ignore
	}
	const driftFile = path.join(root, "operations", "drift.md");
	if (nodeFs.existsSync(driftFile)) {
		const text = nodeFs.readFileSync(driftFile, "utf8");
		const open = [...text.matchAll(/^##\s+(.+)$/gm)]
			.map((m) => (m[1] ?? "").trim())
			.filter((h) => !/sample/i.test(h));
		for (const h of open.slice(0, 10)) {
			alerts.push({ title: h, body: "Open drift.md", src: "drift" });
		}
	}
	return { alerts };
}

export type ArtifactResult =
	| { ok: false; status: number; why: string }
	| { ok: true; full: string; contentType: string };

/**
 * Guard + resolve a render artifact (GET /api/artifact shape; the
 * route streams the file itself).
 */
export function resolveArtifact(root: string, rel: string): ArtifactResult {
	if (!rel.startsWith("reports/render/")) {
		return {
			ok: false,
			status: 400,
			why: "artifacts live under reports/render/",
		};
	}
	const full = safeJoin(root, rel);
	if (!full)
		return { ok: false, status: 400, why: "path escapes the workspace" };
	try {
		const st = nodeFs.statSync(full);
		if (st.isDirectory() || st.size > MAX_FILE_BYTES) {
			return { ok: false, status: 400, why: "not a servable artifact" };
		}
	} catch {
		return { ok: false, status: 404, why: "no such artifact" };
	}
	const contentType = full.endsWith(".html")
		? "text/html; charset=utf-8"
		: full.endsWith(".svg")
			? "image/svg+xml"
			: "text/plain; charset=utf-8";
	return { ok: true, full, contentType };
}

/**
 * Scaffold threat model (T97 follow-up): init assumes no
 * concurrent adversary with write access to the destination tree.
 * It defends against pre-existing files and links, accidental
 * races (exclusive create plus ownership-checked rollback), and
 * partial failure. It does NOT defend against a parent directory
 * being swapped for a symlink mid-copy — Node has no openat, so
 * path-based checks cannot pin the tree. That is accepted.
 */

/**
 * Scaffold-name rule: a single basename, no separators or escapes, so
 * the creation target always lands directly under the default dir.
 */
export function validWorkspaceName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/** WinBox-encryption steering for fresh scaffolds, until C14 ships. */
export const CDB_ENCRYPT_STEERING =
	"device.cdb starts open: encrypt it in WinBox before trusting it (one-command centrs encryption is tracked upstream at tikoci/centrs#558).";

export type ScaffoldOpts = {
	/** Templates-root override (tests isolate here). */
	templatesRoot?: string | null;
	/**
	 * Test seam (T97): runs after the conflict scan, before any
	 * write, so a test can land a competing file deterministically.
	 */
	afterPreflight?: () => void;
	/** Writer seam, forwarded to the template copy (tests only). */
	fs?: ScaffoldFs;
};

export type ScaffoldResult =
	| { ok: true; dir: string }
	| { ok: false; why: string; conflicts?: string[]; leftover?: string[] };

/** Ledger entry for a path this run just created (lstat identity). */
function statCreated(full: string, label: string): CreatedPath {
	const st = nodeFs.lstatSync(full);
	return { full, label, dev: st.dev, ino: st.ino };
}

/** errno code, or a short message, for leftover notes. */
function shortErr(err: unknown): string {
	const code = (err as NodeJS.ErrnoException)?.code;
	if (typeof code === "string" && code) return code;
	const msg = err instanceof Error ? err.message : String(err);
	return msg.slice(0, 60);
}

/**
 * Remove one ledgered path only if it is still ours (T97
 * follow-up): lstat it first and compare (dev, ino). A missing
 * path is already gone (null); a mismatch is a foreign
 * replacement and stays, with a leftover note. Removal errors
 * also come back as notes, so rollback continues past them. An
 * ino of 0 (platforms without stable inodes) skips the identity
 * check and removes by path.
 */
function removeOwned(
	entry: CreatedPath,
	remove: (p: string) => void,
): string | null {
	let st: nodeFs.Stats;
	try {
		st = nodeFs.lstatSync(entry.full);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		return `${entry.label} (${shortErr(err)})`;
	}
	if (entry.ino !== 0 && (st.dev !== entry.dev || st.ino !== entry.ino)) {
		return `${entry.label} (ownership changed)`;
	}
	try {
		remove(entry.full);
	} catch (err) {
		return `${entry.label} (${shortErr(err)})`;
	}
	return null;
}

/**
 * Failure result with rollback residue (T97 follow-up): leftover
 * notes join `why` as `; left behind: ...` and ride along as
 * `leftover`. Clean rollbacks keep the bare why and no leftover
 * field, so existing callers see no change.
 */
function scaffoldFail(
	why: string,
	leftovers: string[],
	conflicts?: string[],
): ScaffoldResult {
	const suffix =
		leftovers.length > 0 ? `; left behind: ${leftovers.join(", ")}` : "";
	return {
		ok: false,
		why: `${why}${suffix}`,
		...(conflicts ? { conflicts } : {}),
		...(leftovers.length > 0 ? { leftover: leftovers } : {}),
	};
}

function resolveTemplate(
	template: string,
	opts?: ScaffoldOpts,
): { dir: string; name: string; version: string } | { error: string } {
	const root =
		opts?.templatesRoot === undefined ? templatesRoot() : opts.templatesRoot;
	const dir = templateDir(root, template);
	if (!dir) return { error: `unknown template: ${template}` };
	const meta = readTemplateMeta(dir);
	if (!meta) return { error: `template ${template} has no readable manifest` };
	return { dir, name: meta.name, version: meta.version };
}

/**
 * `centrs devices init` into target; null on success, else the why.
 * A spawn throw (e.g. an un-runnable centrs on PATH) is a plain
 * failure too: it never rejects past the scaffold.
 */
async function runDevicesInit(
	target: string,
	env: Record<string, string>,
): Promise<string | null> {
	try {
		if (!have("centrs", env)) return "centrs not on PATH";
		const init = await run(
			[
				"centrs",
				"devices",
				"init",
				"--cdb-file",
				path.join(target, "device.cdb"),
			],
			{ timeoutMs: 30_000, env },
		);
		if (init.ok) return null;
		const line = `${init.stdout}\n${init.stderr}`.trim().split("\n")[0] ?? "";
		return `centrs devices init failed${line ? `: ${line.slice(0, 200)}` : ""}`;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return `centrs devices init failed: ${msg.slice(0, 200)}`;
	}
}

/**
 * Resolve the scaffold destination ONCE (T97 follow-up): realpath
 * the nearest existing ancestor, then append the not-yet-existing
 * tail. Symlinks above or at the named destination are the user's
 * business and resolve to their target; every later operation
 * runs under the returned real path. Symlinks inside the tree
 * stay refused by the lstat checks downstream. The result `dir`
 * still echoes the caller's spelling.
 */
function resolveDestOnce(dir: string): string {
	let cur = path.resolve(dir);
	const tail: string[] = [];
	for (;;) {
		try {
			nodeFs.lstatSync(cur);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
			tail.unshift(path.basename(cur));
			const up = path.dirname(cur);
			if (up === cur) {
				throw new Error(`cannot resolve destination under ${cur}`);
			}
			cur = up;
		}
	}
	// cur exists by lstat; peel while it refuses to resolve (a
	// dangling link at or inside cur), so the dangling piece lands
	// in the tail and the lstat checks refuse it as a non-dir.
	for (;;) {
		try {
			const real = nodeFs.realpathSync(cur);
			return tail.length > 0 ? path.join(real, ...tail) : real;
		} catch {
			tail.unshift(path.basename(cur));
			const up = path.dirname(cur);
			if (up === cur) {
				throw new Error(`cannot resolve destination under ${cur}`);
			}
			cur = up;
		}
	}
}

/**
 * Ensure dirname(dest) exists as real dirs (T97), creating missing
 * levels one at a time; an existing component that is not a real
 * directory throws. Returns ledger entries for the levels this run
 * created, so rollback removes them too.
 */
function ensureParentChain(dest: string): CreatedPath[] {
	const created: CreatedPath[] = [];
	const missing: string[] = [];
	let cur = path.dirname(path.resolve(dest));
	for (;;) {
		let st: nodeFs.Stats | null = null;
		try {
			st = nodeFs.lstatSync(cur);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
			missing.push(cur);
			const up = path.dirname(cur);
			if (up === cur) {
				throw new Error(`cannot create parent chain under ${cur}`);
			}
			cur = up;
			continue;
		}
		if (!st.isDirectory() || st.isSymbolicLink()) {
			throw new Error(`not a directory: ${cur}`);
		}
		break;
	}
	for (const p of missing.reverse()) {
		try {
			nodeFs.mkdirSync(p);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
			if (!isRealDir(p)) throw new Error(`not a directory: ${p}`);
			continue;
		}
		created.push(statCreated(p, p));
	}
	return created;
}

/**
 * Create a workspace from a template under parent/name (default
 * template: minimal): copy the template (template.toml excluded,
 * {{name}} substituted, [template] provenance stamped in the
 * single workspace.toml create), then device.cdb via
 * `centrs devices init` — an open registry with WinBox-encryption
 * steering until C14 (tikoci/centrs#558) ships a centrs-side
 * encryption path. The name is validated before joining, so the
 * target always lands directly under parent; every write is an
 * exclusive, non-following create, and any failure rolls back
 * exactly what this run made so no half-scaffold survives. The
 * destination resolves once (symlinks above or at it are the
 * user's business); all operations run under the real path while
 * messages and the result dir keep the caller's spelling.
 */
export async function scaffoldWorkspace(
	parent: string,
	name: string,
	env: Record<string, string>,
	template = "minimal",
	opts?: ScaffoldOpts,
): Promise<ScaffoldResult> {
	if (!validWorkspaceName(name)) {
		return {
			ok: false,
			why: "name must be one path segment: letters, digits, dot, dash, underscore",
		};
	}
	const tpl = resolveTemplate(template, opts);
	if ("error" in tpl) return { ok: false, why: tpl.error };
	const target = path.join(parent, name);
	let dest: string;
	try {
		dest = resolveDestOnce(target);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return scaffoldFail(`cannot resolve destination ${target}: ${msg}`, []);
	}
	if (lstatExists(dest)) {
		return { ok: false, why: `already exists: ${target}` };
	}
	opts?.afterPreflight?.();
	const createdFiles: CreatedPath[] = [];
	const createdDirs: CreatedPath[] = [];
	const createdParents: CreatedPath[] = [];
	let targetEntry: CreatedPath | null = null;
	const rollback = (): string[] => {
		const left: string[] = [];
		const keep = (note: string | null): void => {
			if (note) left.push(note);
		};
		for (const f of createdFiles) {
			keep(removeOwned(f, (p) => nodeFs.rmSync(p, { force: true })));
		}
		// Deepest first: a parent is a strict prefix of its child,
		// so it is always shorter and sorts later.
		for (const d of [...createdDirs].sort(
			(a, b) => b.label.length - a.label.length,
		)) {
			keep(removeOwned(d, (p) => nodeFs.rmdirSync(p)));
		}
		if (targetEntry) {
			keep(removeOwned(targetEntry, (p) => nodeFs.rmdirSync(p)));
		}
		for (const p of [...createdParents].sort(
			(a, b) => b.full.length - a.full.length,
		)) {
			keep(removeOwned(p, (q) => nodeFs.rmdirSync(q)));
		}
		return left;
	};
	try {
		createdParents.push(...ensureParentChain(dest));
		try {
			nodeFs.mkdirSync(dest);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
				return { ok: false, why: `already exists: ${target}` };
			}
			throw err;
		}
		targetEntry = statCreated(dest, target);
		copyTemplateFiles(tpl.dir, dest, name, {
			provenance: { name: tpl.name, description: "", version: tpl.version },
			createdFiles,
			createdDirs,
			fs: opts?.fs,
		});
	} catch (err) {
		if (err instanceof ScaffoldConflict) {
			return scaffoldFail(
				`refusing to overwrite in ${target}: ${err.conflicts.join(", ")}`,
				rollback(),
				err.conflicts,
			);
		}
		return scaffoldFail(
			`scaffold writes failed: ${err instanceof Error ? err.message : String(err)}`,
			rollback(),
		);
	}
	const cdbFull = path.join(dest, "device.cdb");
	const cdbExisted = lstatExists(cdbFull);
	const failed = await runDevicesInit(dest, env);
	// A cdb that was absent before centrs ran and present after is
	// assumed to be centrs' own — except a foreign file could land
	// in that same window, and the two are indistinguishable
	// (accepted: with no pre-centrs identity there is nothing to
	// compare against). Record what is there now, success or
	// failure, so rollback removes only an unchanged file.
	let cdbEntry: CreatedPath | null = null;
	if (!cdbExisted) {
		try {
			cdbEntry = statCreated(cdbFull, "device.cdb");
		} catch {
			// never appeared: nothing to remove
		}
	}
	if (failed) {
		const leftovers: string[] = [];
		if (cdbEntry) {
			const note = removeOwned(cdbEntry, (p) =>
				nodeFs.rmSync(p, { force: true }),
			);
			if (note) leftovers.push(note);
		}
		leftovers.push(...rollback());
		return scaffoldFail(failed, leftovers);
	}
	return { ok: true, dir: target };
}

/**
 * Scaffold a template INTO dir (the CLI init path): dir may exist,
 * but none of the template's files (nor device.cdb) may already be
 * there — conflicts are listed and nothing is written. The scan
 * uses lstat, so dangling symlinks count as conflicts, and every
 * dir component the template needs must be absent or a real
 * directory. Every write is an exclusive, non-following create;
 * rollback removes only what this call made, never the
 * pre-existing dir. The destination resolves once (a symlink at
 * or above it is the user's business); all operations run under
 * the real path while messages and the result dir keep the
 * caller's spelling.
 */
export async function scaffoldIntoDir(
	dir: string,
	env: Record<string, string>,
	template = "minimal",
	opts?: ScaffoldOpts,
): Promise<ScaffoldResult> {
	const tpl = resolveTemplate(template, opts);
	if ("error" in tpl) return { ok: false, why: tpl.error };
	let dest: string;
	try {
		dest = resolveDestOnce(dir);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return scaffoldFail(`cannot resolve destination ${dir}: ${msg}`, []);
	}
	if (lstatExists(dest) && !isRealDir(dest)) {
		return { ok: false, why: `not a directory: ${dir}` };
	}
	const conflicts: string[] = [];
	const seen = new Set<string>();
	const add = (rel: string): void => {
		if (!seen.has(rel)) {
			seen.add(rel);
			conflicts.push(rel);
		}
	};
	for (const rel of listTemplateFiles(tpl.dir)) {
		if (lstatExists(path.join(dest, rel))) add(rel);
		const parts = rel.split("/");
		let acc = "";
		for (let i = 0; i < parts.length - 1; i++) {
			acc = acc ? `${acc}/${parts[i]}` : (parts[i] as string);
			const full = path.join(dest, acc);
			if (lstatExists(full) && !isRealDir(full)) add(acc);
		}
	}
	if (lstatExists(path.join(dest, "device.cdb"))) {
		add("device.cdb");
	}
	if (conflicts.length > 0) {
		return {
			ok: false,
			why: `refusing to overwrite in ${dir}: ${conflicts.join(", ")}`,
			conflicts,
		};
	}
	opts?.afterPreflight?.();
	const createdFiles: CreatedPath[] = [];
	const createdDirs: CreatedPath[] = [];
	const createdParents: CreatedPath[] = [];
	let destEntry: CreatedPath | null = null;
	const rollback = (): string[] => {
		const left: string[] = [];
		const keep = (note: string | null): void => {
			if (note) left.push(note);
		};
		for (const f of createdFiles) {
			keep(removeOwned(f, (p) => nodeFs.rmSync(p, { force: true })));
		}
		// Deepest first: a parent is a strict prefix of its child,
		// so it is always shorter and sorts later.
		for (const d of [...createdDirs].sort(
			(a, b) => b.label.length - a.label.length,
		)) {
			keep(removeOwned(d, (p) => nodeFs.rmdirSync(p)));
		}
		if (destEntry) {
			keep(removeOwned(destEntry, (p) => nodeFs.rmdirSync(p)));
		}
		for (const p of [...createdParents].sort(
			(a, b) => b.full.length - a.full.length,
		)) {
			keep(removeOwned(p, (q) => nodeFs.rmdirSync(q)));
		}
		return left;
	};
	try {
		if (lstatExists(dest)) {
			if (!isRealDir(dest)) {
				return { ok: false, why: `not a directory: ${dir}` };
			}
		} else {
			createdParents.push(...ensureParentChain(dest));
			try {
				nodeFs.mkdirSync(dest);
				destEntry = statCreated(dest, dir);
			} catch (err) {
				if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
				if (!isRealDir(dest)) throw new Error(`not a directory: ${dir}`);
				// A competitor created the dir; not ours, so unrecorded.
			}
		}
		copyTemplateFiles(tpl.dir, dest, path.basename(path.resolve(dir)), {
			provenance: { name: tpl.name, description: "", version: tpl.version },
			createdFiles,
			createdDirs,
			fs: opts?.fs,
		});
	} catch (err) {
		if (err instanceof ScaffoldConflict) {
			return scaffoldFail(
				`refusing to overwrite in ${dir}: ${err.conflicts.join(", ")}`,
				rollback(),
				err.conflicts,
			);
		}
		return scaffoldFail(
			`scaffold writes failed: ${err instanceof Error ? err.message : String(err)}`,
			rollback(),
		);
	}
	// device.cdb never existed at preflight; only remove what centrs
	// itself may have left behind, never a competitor's file. As in
	// scaffoldWorkspace, a foreign cdb landed in the centrs window is
	// indistinguishable from centrs' own (accepted).
	const cdbFull = path.join(dest, "device.cdb");
	const cdbExisted = lstatExists(cdbFull);
	const failed = await runDevicesInit(dest, env);
	let cdbEntry: CreatedPath | null = null;
	if (!cdbExisted) {
		try {
			cdbEntry = statCreated(cdbFull, "device.cdb");
		} catch {
			// never appeared: nothing to remove
		}
	}
	if (failed) {
		const leftovers: string[] = [];
		if (cdbEntry) {
			const note = removeOwned(cdbEntry, (p) =>
				nodeFs.rmSync(p, { force: true }),
			);
			if (note) leftovers.push(note);
		}
		leftovers.push(...rollback());
		return scaffoldFail(failed, leftovers);
	}
	return { ok: true, dir };
}
