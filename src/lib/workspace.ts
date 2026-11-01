// Workspace module (T40): tree, recents, file reads/writes (TOML
// validate-before-save), TOML sections, alerts, and render-adjacent
// artifact serving — UI-agnostic file ops over a workspace root. Serve
// routes stay thin wrappers mapping results to HTTP.
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { loadDoctorSpec, runDoctor } from "../steps/doctor";
import { readDevices } from "./fleet";
import { have, run } from "./run";
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
 * Scaffold-name rule: a single basename, no separators or escapes, so
 * the creation target always lands directly under the default dir.
 */
export function validWorkspaceName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function scaffoldToml(name: string): string {
	return `# ${name} — minimal workspace scaffold (T40). The full template
# (START-HERE, conventions, skills, checks) ships at templates/network;
# until the scaffold reconciles with it, this is the runnable minimum.
[home]
type = "single-copy"
canonical = true

[pins]
quickchr = "next"
centrs = "next"
rosetta = "next"
`;
}

function scaffoldAgents(name: string): string {
	return `# AGENTS.md — ${name} (minimal scaffold)

Minimal workspace scaffold (T40): the full template (START-HERE.md,
conventions, skills, checks) ships at templates/network. Until the
scaffold reconciles with it: read \`workspace.toml\` + \`router.toml\`,
check capability before promising execution, leave evidence.
`;
}

const SCAFFOLD_ROUTER = `# router.toml — devices (minimal scaffold). Uncomment and fill
# one [device] per box. cdb names the centrs device record (the source
# of truth for reachability + access); host is break-glass only.
#
# [device]
# id = "office-gw"
# site = "office"
# role = "gateway"
# cdb = "office-gw"
`;

export type ScaffoldResult =
	| { ok: true; dir: string }
	| { ok: false; why: string };

/**
 * Create the MINIMAL workspace inline under parent/name: canonical
 * workspace.toml with channel pins, an AGENTS.md pointer, a commented
 * router.toml stub, and device.cdb via `centrs devices init` — an
 * open registry with WinBox-encryption steering until C14
 * (tikoci/centrs#558) ships a centrs-side encryption path. The name
 * is validated before joining, so the target always lands directly
 * under parent; any failure rolls the target back so no
 * half-scaffold survives.
 */
export async function scaffoldWorkspace(
	parent: string,
	name: string,
	env: Record<string, string>,
): Promise<ScaffoldResult> {
	if (!validWorkspaceName(name)) {
		return {
			ok: false,
			why: "name must be one path segment: letters, digits, dot, dash, underscore",
		};
	}
	const target = path.join(parent, name);
	if (nodeFs.existsSync(target)) {
		return { ok: false, why: `already exists: ${target}` };
	}
	const rollback = (): void => {
		nodeFs.rmSync(target, { recursive: true, force: true });
	};
	try {
		nodeFs.mkdirSync(target, { recursive: true });
		nodeFs.writeFileSync(
			path.join(target, "workspace.toml"),
			scaffoldToml(name),
		);
		nodeFs.writeFileSync(path.join(target, "AGENTS.md"), scaffoldAgents(name));
		nodeFs.writeFileSync(path.join(target, "router.toml"), SCAFFOLD_ROUTER);
	} catch (err) {
		rollback();
		return {
			ok: false,
			why: `scaffold writes failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (!have("centrs", env)) {
		rollback();
		return { ok: false, why: "centrs not on PATH" };
	}
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
	if (!init.ok) {
		rollback();
		const line = `${init.stdout}\n${init.stderr}`.trim().split("\n")[0] ?? "";
		return {
			ok: false,
			why: `centrs devices init failed${line ? `: ${line.slice(0, 200)}` : ""}`,
		};
	}
	return { ok: true, dir: target };
}
