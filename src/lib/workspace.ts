// Workspace module (T40): tree, recents, file reads/writes (TOML
// validate-before-save), TOML sections, alerts, and render-adjacent
// artifact serving — UI-agnostic file ops over a workspace root. Serve
// routes stay thin wrappers mapping results to HTTP.
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { loadDoctorSpec, runDoctor } from "../steps/doctor";
import { readDevices } from "./fleet";
import {
	canonicalJobPayload,
	readRenderKey,
	sha256Hex,
	verifyJobSignature,
} from "./renderSig";
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
/** Editor/doc viewer cap (GET /api/file shape; T106 ui_open preflights it). */
export const MAX_FILE_BYTES = 512 * 1024;

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
	kind: "toml" | "md" | "dir" | "artifact";
	meta: string;
	/** Sandbox tier hint for artifact rows (the viewer re-verifies via meta). */
	tier?: ArtifactTier;
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

/** Cap on render primaries per recents list: a few at most. */
const RECENT_RENDER_MAX = 3;

/** Curated recents: topology-adjacent rows ordered by mtime. */
export function listRecents(root: string, cx?: TierContext): RecentRow[] {
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
	// Render-job primaries: each job dir contributes its primary
	// artifact (topology.html / report.html), newest few first.
	const primaries: { rel: string; mtime: number }[] = [];
	try {
		const jobDirs = nodeFs.readdirSync(path.join(root, "reports", "render"));
		for (const jd of jobDirs) {
			if (jd.startsWith(".")) continue;
			for (const primary of ["topology.html", "report.html"]) {
				const rel = `reports/render/${jd}/${primary}`;
				try {
					const mtime = nodeFs.statSync(path.join(root, rel)).mtimeMs;
					primaries.push({ rel, mtime });
					break;
				} catch {
					// Not this name; try the next.
				}
			}
		}
	} catch {
		// No render dir at all.
	}
	primaries.sort((a, b) => b.mtime - a.mtime);
	for (const p of primaries.slice(0, RECENT_RENDER_MAX)) cands.push(p.rel);
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
				: isArtifactPath(rel)
					? "artifact"
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
			...(kind === "artifact" ? { tier: artifactTier(root, rel, cx) } : {}),
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
	let st: nodeFs.Stats;
	try {
		st = nodeFs.statSync(full);
	} catch {
		return { status: 404, body: { ok: false, why: "no such file" } };
	}
	// T106: the TOML viewer reads through this path with no other
	// cap; apply the same 512 KiB viewer limit ui_open preflights.
	if (st.size > MAX_FILE_BYTES)
		return { status: 400, body: { ok: false, why: "file too large" } };
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
	| { ok: true; full: string; contentType: string; body: Buffer };

/** Renderable artifact extensions (T83, D17/D19). */
const ARTIFACT_EXTS: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/** Artifacts get their own cap: rendered files dwarf editor text. */
export const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;

export type ArtifactTier = "static" | "scripts";

/**
 * Tier CSPs: both force an opaque origin (sandbox, never
 * allow-same-origin, never connect-src), so agent-authored content
 * framed from /api/artifact cannot touch the session cookie or API.
 * Fetches and subresources are blocked; forms and base tags too
 * (form-action/base-uri 'none'). Navigation is NOT blockable by
 * policy (Chromium has no navigate-to): the UI watches the frame's
 * load events and blanks a navigating artifact instead.
 */
export const ARTIFACT_CSP: Record<ArtifactTier, string> = {
	static:
		"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'",
	scripts:
		"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'",
};

/** True when rel names a servable artifact type (extension allowlist). */
export function isArtifactPath(rel: string): boolean {
	const base = rel.split("/").pop() ?? "";
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return false;
	return (ARTIFACT_EXTS[base.slice(dot).toLowerCase()] ?? null) !== null;
}

/**
 * Security headers for one artifact response. Unknown tiers fail
 * closed to static.
 */
export function artifactSecurityHeaders(
	tier: string | null,
): Record<string, string> {
	const csp = tier === "scripts" ? ARTIFACT_CSP.scripts : ARTIFACT_CSP.static;
	return {
		"content-security-policy": csp,
		"x-content-type-options": "nosniff",
		"cache-control": "no-store",
	};
}

/**
 * Verified per-directory result: the granted tier plus the exact
 * file names the job wrote (membership is checked per call, so a
 * dropped-in file rides no grant while the directory verifies once).
 */
export type TierMemo = { tier: ArtifactTier; names: string[] };

/** Per-request context for tier lookups: key home plus a memo. */
export type TierContext = {
	/** XDG data-home override for the provenance key (tests isolate here). */
	dataHome?: string;
	/**
	 * Memo of verified per-directory results for one tree/recents
	 * request: job-dir rel → memo. The caller owns it (one Map per
	 * request); absent means no memo.
	 */
	cache?: Map<string, TierMemo>;
};

/**
 * List-time sandbox hint for one artifact (tree/recents display
 * only — execution never trusts it): scripts when the file sits
 * directly in a render dir whose job.json claims scripts AND
 * job.json.sig verifies against the current file contents, and the
 * file itself is one the job signed (a dropped-in file rides no
 * grant). Static and unlabeled everywhere else. The serve route
 * re-verifies the exact served bytes instead of reading this.
 */
export function artifactTier(
	root: string,
	rel: string,
	cx?: TierContext,
): ArtifactTier {
	const parts = rel.split("/");
	if (
		parts.length !== 4 ||
		parts[0] !== "reports" ||
		parts[1] !== "render" ||
		parts[2] === "" ||
		parts[2] === "." ||
		parts[2] === ".." ||
		parts[3] === "job.json" ||
		parts[3] === "job.json.sig"
	) {
		return "static";
	}
	const jobDirRel = `${parts[0]}/${parts[1]}/${parts[2]}`;
	const fileName = parts[3] as string;
	let memo = cx?.cache?.get(jobDirRel);
	if (memo === undefined) {
		memo = verifyRenderDir(root, jobDirRel, cx?.dataHome);
		cx?.cache?.set(jobDirRel, memo);
	}
	if (memo.tier !== "scripts") return "static";
	return memo.names.includes(fileName) ? "scripts" : "static";
}

/**
 * Render-job provenance for the EXACT bytes being served: the file
 * must sit directly in a render dir whose job verifies with those
 * bytes pinned into the HMAC, and be a member the job signed. Fresh
 * per call — a label from one call never grants a later serve.
 */
export function artifactProvenanceForBuffer(
	root: string,
	rel: string,
	body: Buffer,
	dataHome?: string,
): "render-job" | null {
	const parts = rel.split("/");
	if (
		parts.length !== 4 ||
		parts[0] !== "reports" ||
		parts[1] !== "render" ||
		parts[2] === "" ||
		parts[2] === "." ||
		parts[2] === ".." ||
		parts[3] === "job.json" ||
		parts[3] === "job.json.sig"
	) {
		return null;
	}
	const jobDirRel = `${parts[0]}/${parts[1]}/${parts[2]}`;
	const fileName = parts[3] as string;
	const memo = verifyRenderDir(root, jobDirRel, dataHome, {
		name: fileName,
		bytes: body,
	});
	if (memo.tier !== "scripts") return null;
	return memo.names.includes(fileName) ? "render-job" : null;
}

/**
 * Serve-time tier for one artifact response: the render-job grant
 * when the served bytes verify pinned into their job's HMAC, else
 * the owner's explicit opt-in, else static. No client tier name is
 * read here — the query carries opt-in only.
 */
export function serveArtifactTier(
	root: string,
	rel: string,
	body: Buffer,
	opts: { dataHome?: string; optin: boolean },
): ArtifactTier {
	if (
		artifactProvenanceForBuffer(root, rel, body, opts.dataHome) === "render-job"
	) {
		return "scripts";
	}
	return opts.optin ? "scripts" : "static";
}

/** Read exactly size bytes from fd at offset 0; short on truncate races. */
function readFdExactly(fd: number, size: number): Buffer | null {
	const buf = Buffer.allocUnsafe(size);
	let off = 0;
	while (off < size) {
		let n: number;
		try {
			n = nodeFs.readSync(fd, buf, off, size - off, off);
		} catch {
			return null;
		}
		if (n === 0) break;
		off += n;
	}
	return off === size ? buf : buf.subarray(0, off);
}

/**
 * Bounded fd read: open O_RDONLY|O_NOFOLLOW|O_NONBLOCK, fstat (must
 * be a regular file at or under the cap), then read exactly the
 * stated size from the fd — never a reopened pathname, never past
 * the cap however the file grows under us. Null on anything else.
 */
function readFdBounded(full: string, maxBytes: number): Buffer | null {
	const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = nodeFs.constants;
	let fd: number;
	try {
		fd = nodeFs.openSync(full, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch {
		return null;
	}
	try {
		let st: nodeFs.Stats;
		try {
			st = nodeFs.fstatSync(fd);
		} catch {
			return null;
		}
		if (!st.isFile() || st.size > maxBytes) return null;
		return readFdExactly(fd, st.size);
	} finally {
		try {
			nodeFs.closeSync(fd);
		} catch {
			// The fd is all we ever read; a close failure is not a read failure.
		}
	}
}

/**
 * Safe file read for metadata and job members: lstat first (must be
 * a regular file — never a FIFO, symlink, dir, or device), then the
 * bounded fd read. The lstat keeps FIFOs from ever reaching open,
 * so a FIFO member returns null instead of hanging.
 */
function readRegularFile(full: string, maxBytes: number): Buffer | null {
	let lst: nodeFs.Stats;
	try {
		lst = nodeFs.lstatSync(full);
	} catch {
		return null;
	}
	if (!lst.isFile()) return null;
	return readFdBounded(full, maxBytes);
}

/** Cap for render metadata reads (job.json, job.json.sig). */
export const JOB_META_MAX_BYTES = 64 * 1024;

/** Max member names a job.json may list (shape gate, before any read). */
export const JOB_FILES_MAX = 16;

/** Total member bytes hashed per verification; going over → static. */
export const VERIFY_TOTAL_MAX_BYTES = 16 * 1024 * 1024;

/** Closed memo: static, no names granted. */
const STATIC_MEMO: TierMemo = { tier: "static", names: [] };

/** A job.json that passed the shared shape gate. */
export type JobManifest = { tier: unknown; files: string[] };

/**
 * One job.json validator for every render-job reader (tree, recents,
 * meta, serve): the parsed file must be an object whose files list
 * holds at most JOB_FILES_MAX unique single-segment artifact names.
 * Anything else — null, arrays, scalars, dupes, subpaths, foreign
 * extensions — returns null and the artifact opens static.
 */
export function parseJobManifest(raw: unknown): JobManifest | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return null;
	}
	const files = (raw as Record<string, unknown>)["files"];
	if (!Array.isArray(files) || files.length > JOB_FILES_MAX) return null;
	const seen = new Set<string>();
	for (const name of files) {
		if (typeof name !== "string") return null;
		if (
			name === "" ||
			name === "." ||
			name === ".." ||
			name.includes("/") ||
			name.includes("\\")
		) {
			return null;
		}
		if (!isArtifactPath(name)) return null;
		if (seen.has(name)) return null;
		seen.add(name);
	}
	return { tier: (raw as Record<string, unknown>)["tier"], files: [...seen] };
}

/**
 * Verify one render dir: job.json must pass the shared shape gate,
 * claim the scripts tier, and its HMAC (over the tier plus a sha256
 * of every member's CURRENT bytes) must verify against job.json.sig.
 * Members read through the safe fd primitive (regular files ≤ 8
 * MiB each, 16 MiB total per verify). Anything missing, oversized,
 * unparseable, foreign, or mismatched fails closed to static.
 *
 * pinned lets the serve path fold the EXACT bytes being served into
 * the HMAC instead of re-reading them: the grant then covers those
 * bytes and only those bytes, with no check/use split.
 */
function verifyRenderDir(
	root: string,
	jobDirRel: string,
	dataHome?: string,
	pinned?: { name: string; bytes: Buffer },
): TierMemo {
	const jobFile = safeJoin(root, `${jobDirRel}/job.json`);
	const sigFile = safeJoin(root, `${jobDirRel}/job.json.sig`);
	if (!jobFile || !sigFile) return STATIC_MEMO;
	const jobRaw = readRegularFile(jobFile, JOB_META_MAX_BYTES);
	const sigRaw = readRegularFile(sigFile, JOB_META_MAX_BYTES);
	if (!jobRaw || !sigRaw) return STATIC_MEMO;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jobRaw.toString("utf8")) as unknown;
	} catch {
		return STATIC_MEMO;
	}
	const manifest = parseJobManifest(parsed);
	if (manifest?.tier !== "scripts") return STATIC_MEMO;
	const key = readRenderKey(dataHome);
	if (!key) return STATIC_MEMO;
	const hashes: Record<string, string> = {};
	let total = 0;
	for (const name of manifest.files) {
		if (pinned && name === pinned.name) {
			total += pinned.bytes.length;
			if (total > VERIFY_TOTAL_MAX_BYTES) return STATIC_MEMO;
			hashes[name] = sha256Hex(pinned.bytes);
			continue;
		}
		const member = safeJoin(root, `${jobDirRel}/${name}`);
		if (!member) return STATIC_MEMO;
		// The per-file cap shrinks to what is left of the total budget,
		// so an over-budget member is refused by fstat before any read.
		const bytes = readRegularFile(
			member,
			Math.min(ARTIFACT_MAX_BYTES, VERIFY_TOTAL_MAX_BYTES - total),
		);
		if (!bytes) return STATIC_MEMO;
		total += bytes.length;
		if (total > VERIFY_TOTAL_MAX_BYTES) return STATIC_MEMO;
		hashes[name] = sha256Hex(bytes);
	}
	const canonical = canonicalJobPayload(jobDirRel, "scripts", hashes);
	return verifyJobSignature(key, canonical, sigRaw.toString("utf8"))
		? { tier: "scripts", names: manifest.files }
		: STATIC_MEMO;
}

/**
 * Guard + resolve a workspace artifact (GET /api/artifact shape; the
 * route serves the returned buffer). Any allowlisted path in the
 * workspace serves; containment is lexical (safeJoin) plus an lstat
 * walk from the root down — no symlink anywhere in the path, final
 * component included, and the final component must already be a
 * regular file (a FIFO, dir, socket, or device 400s before any
 * open, so a FIFO artifact never hangs the server). The file is
 * then opened O_NOFOLLOW|O_NONBLOCK, fstat-checked (regular file,
 * 8 MiB cap) and read exactly through the fd, so one opened object
 * is checked and served: no check/use split across reopened
 * pathnames, never past the cap however the file grows under us.
 *
 * Residual race (accepted, same class as the T97 preflight-vs-write
 * window): a directory component swapped between the lstat walk and
 * the open could redirect the open. This defends against workspace
 * content (symlinks, forged metadata), not a same-user shell racing
 * the server.
 */
export function resolveArtifact(root: string, rel: string): ArtifactResult {
	if (!isArtifactPath(rel)) {
		return {
			ok: false,
			status: 400,
			why: "not a renderable artifact (want html/htm/svg/png/jpg/jpeg/gif/webp)",
		};
	}
	const full = safeJoin(root, rel);
	if (!full)
		return { ok: false, status: 400, why: "path escapes the workspace" };
	// lstat every component below the root. The root itself is not
	// judged: it may live under a system link (macOS /tmp) that is
	// the caller's, not the workspace's.
	const base = path.resolve(root);
	const relParts = path.relative(base, full).split(path.sep);
	let cursor = base;
	for (let i = 0; i < relParts.length; i++) {
		cursor = path.join(cursor, relParts[i] as string);
		let lst: nodeFs.Stats;
		try {
			lst = nodeFs.lstatSync(cursor);
		} catch {
			return { ok: false, status: 404, why: "no such artifact" };
		}
		if (lst.isSymbolicLink())
			return { ok: false, status: 400, why: "artifacts may not be symlinks" };
		if (i === relParts.length - 1 && !lst.isFile())
			return { ok: false, status: 400, why: "not a servable artifact" };
	}
	const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = nodeFs.constants;
	let fd: number;
	try {
		fd = nodeFs.openSync(full, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ELOOP")
			return { ok: false, status: 400, why: "artifacts may not be symlinks" };
		return { ok: false, status: 404, why: "no such artifact" };
	}
	try {
		let st: nodeFs.Stats;
		try {
			st = nodeFs.fstatSync(fd);
		} catch {
			return { ok: false, status: 400, why: "not a servable artifact" };
		}
		if (!st.isFile() || st.size > ARTIFACT_MAX_BYTES) {
			return { ok: false, status: 400, why: "not a servable artifact" };
		}
		const body = readFdExactly(fd, st.size);
		if (!body)
			return { ok: false, status: 400, why: "not a servable artifact" };
		const ext = `.${(full.split(".").pop() ?? "").toLowerCase()}`;
		return { ok: true, full, contentType: ARTIFACT_EXTS[ext] ?? "", body };
	} finally {
		try {
			nodeFs.closeSync(fd);
		} catch {
			// The fd is all we ever read; a close failure is not a serve failure.
		}
	}
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
	try {
		const st = nodeFs.lstatSync(full);
		return { full, label, dev: st.dev, ino: st.ino };
	} catch {
		// Created but unidentifiable: ino 0 keeps it and reports it.
		return { full, label, dev: 0, ino: 0 };
	}
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
 * ino of 0 (no stable inode, or the identity read failed) means
 * ownership can't be proven: the path stays and is reported.
 */
export function removeOwned(
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
	if (entry.ino === 0) return `${entry.label} (ownership unverifiable)`;
	if (st.dev !== entry.dev || st.ino !== entry.ino) {
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
 * directory throws. Each level this run creates joins the caller's
 * ledger the moment mkdir lands, so a later mkdir failure still
 * rolls the earlier levels back.
 */
function ensureParentChain(dest: string, created: CreatedPath[]): void {
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
		ensureParentChain(dest, createdParents);
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
			ensureParentChain(dest, createdParents);
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
	// Lexically normalized: dest resolution already collapsed any
	// `..`, so the echoed spelling must too or it names a path that
	// never got created (base/missing/../ws).
	return { ok: true, dir: path.normalize(dir) };
}
