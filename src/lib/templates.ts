// Workspace templates (T93): templates/<name>/ is the single init
// source. Each dir carries a template.toml manifest (name,
// description, version; never copied) plus the files to copy;
// {{name}} in *.toml/*.md becomes the workspace name, and the
// scaffold stamps a [template] provenance table into workspace.toml
// (a record, never enforced).
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { parseToml } from "./toml";
import { packageRoot } from "./tools";

export type TemplateMeta = {
	name: string;
	description: string;
	version: string;
};

/**
 * A scaffold write hit a path this run must not touch (T97):
 * an existing file, or a dir component that is a file or
 * symlink. Carries the conflicting dest-relative paths so the
 * caller can report them like a preflight conflict.
 */
export class ScaffoldConflict extends Error {
	conflicts: string[];
	constructor(conflicts: string[]) {
		super(`conflicting paths: ${conflicts.join(", ")}`);
		this.name = "ScaffoldConflict";
		this.conflicts = conflicts;
	}
}

/** lstat existence: true for any kind, including dangling symlinks. */
export function lstatExists(p: string): boolean {
	try {
		nodeFs.lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

/** True only for a real directory (lstat: never a symlink). */
export function isRealDir(p: string): boolean {
	try {
		const st = nodeFs.lstatSync(p);
		return st.isDirectory() && !st.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Templates root: <package>/templates via the package root, so
 * bunx/npm installs resolve it. An explicit override (tests pass
 * one) wins; null stays null.
 */
export function templatesRoot(pkgRoot?: string | null): string | null {
	const root = pkgRoot === undefined ? packageRoot() : pkgRoot;
	if (!root) return null;
	const dir = path.join(root, "templates");
	try {
		return nodeFs.statSync(dir).isDirectory() ? dir : null;
	} catch {
		return null;
	}
}

/** Manifest of one template dir; null when missing or unreadable. */
export function readTemplateMeta(dir: string): TemplateMeta | null {
	let text: string;
	try {
		text = nodeFs.readFileSync(path.join(dir, "template.toml"), "utf8");
	} catch {
		return null;
	}
	const parsed = parseToml(text);
	if (!parsed.ok) return null;
	const v = parsed.value;
	if (typeof v["name"] !== "string" || typeof v["version"] !== "string") {
		return null;
	}
	return {
		name: v["name"],
		description: typeof v["description"] === "string" ? v["description"] : "",
		version: v["version"],
	};
}

/**
 * Every template under root with a readable manifest, sorted by
 * name. A missing root (or none given) is an empty list.
 */
export function listTemplates(root?: string | null): TemplateMeta[] {
	const base = root === undefined ? templatesRoot() : root;
	if (!base) return [];
	let names: string[];
	try {
		names = nodeFs.readdirSync(base).sort();
	} catch {
		return [];
	}
	const out: TemplateMeta[] = [];
	for (const name of names) {
		const dir = path.join(base, name);
		try {
			if (!nodeFs.statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		const meta = readTemplateMeta(dir);
		if (meta) out.push(meta);
	}
	return out;
}

/** Template dir for a name; null when absent or the name escapes. */
export function templateDir(root: string | null, name: string): string | null {
	if (!root || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
	const dir = path.join(root, name);
	try {
		return nodeFs.statSync(dir).isDirectory() ? dir : null;
	} catch {
		return null;
	}
}

/** Relative file list of a template, template.toml excluded, sorted. */
export function listTemplateFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (rel: string): void => {
		let names: string[];
		try {
			names = nodeFs.readdirSync(path.join(dir, rel)).sort();
		} catch {
			return;
		}
		for (const name of names) {
			const relPath = rel ? `${rel}/${name}` : name;
			if (relPath === "template.toml") continue;
			const full = path.join(dir, relPath);
			let st: nodeFs.Stats;
			try {
				st = nodeFs.statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(relPath);
			else if (st.isFile()) out.push(relPath);
		}
	};
	walk("");
	return out.sort();
}

/**
 * Narrow test seam for scaffold writes (T97 follow-up): lets tests
 * inject partial/short writes and close failures. Production
 * callers leave it unset and get node:fs straight through.
 */
export type ScaffoldFs = {
	writeSync?: (
		fd: number,
		buf: Buffer,
		offset: number,
		length: number,
	) => number;
	closeSync?: (fd: number) => void;
};

/**
 * Exclusive, non-following file create (T97): O_CREAT|O_EXCL
 * fails on any existing path, including a dangling symlink, so
 * a competing writer's file is never truncated. A failed write
 * unlinks the partial file before throwing.
 */
function writeFileExclusive(
	full: string,
	content: string | Buffer,
	fs?: ScaffoldFs,
): void {
	const fd = nodeFs.openSync(full, "wx", 0o666);
	const writeSync =
		fs?.writeSync ??
		((fd: number, buf: Buffer, offset: number, length: number): number =>
			nodeFs.writeSync(fd, buf, offset, length, null));
	const closeSync = fs?.closeSync ?? nodeFs.closeSync;
	try {
		const buf = typeof content === "string" ? Buffer.from(content) : content;
		writeSync(fd, buf, 0, buf.length);
	} catch (err) {
		try {
			closeSync(fd);
		} catch {
			// close failure while handling a write failure: ignore
		}
		try {
			nodeFs.unlinkSync(full);
		} catch {
			// best effort: leave nothing partial behind
		}
		throw err;
	}
	closeSync(fd);
}

/**
 * Ensure dest/prefix exists as real dirs (T97), one level at a
 * time with non-recursive mkdir; each level this run creates is
 * recorded in createdDirs. An existing component that is not a
 * real directory (file or symlink) is a ScaffoldConflict.
 */
function ensureDirPrefix(
	dest: string,
	prefix: string,
	createdDirs?: string[],
): void {
	const parts = prefix.split("/");
	let acc = "";
	for (const part of parts) {
		acc = acc ? `${acc}/${part}` : part;
		const full = path.join(dest, acc);
		try {
			const st = nodeFs.lstatSync(full);
			if (!st.isDirectory() || st.isSymbolicLink()) {
				throw new ScaffoldConflict([acc]);
			}
		} catch (err) {
			if (err instanceof ScaffoldConflict) throw err;
			if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
			try {
				nodeFs.mkdirSync(full);
			} catch (mkErr) {
				if ((mkErr as NodeJS.ErrnoException)?.code === "EEXIST") {
					throw new ScaffoldConflict([acc]);
				}
				throw mkErr;
			}
			createdDirs?.push(acc);
		}
	}
}

/** Pure [template] provenance suffix for workspace.toml text. */
function provenanceSuffix(meta: TemplateMeta): string {
	const q = (s: string): string =>
		`"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	return `\n[template]\nname = ${q(meta.name)}\nversion = ${q(meta.version)}\n`;
}

/** Append [template] provenance to workspace.toml text. */
function stampText(text: string, meta: TemplateMeta): string {
	const sep = text.endsWith("\n") ? "" : "\n";
	return `${text}${sep}${provenanceSuffix(meta)}`;
}

export type CopyOpts = {
	/**
	 * Stamp [template] provenance into workspace.toml as part of
	 * its single exclusive create (T97) — never write-then-rewrite.
	 */
	provenance?: TemplateMeta;
	/**
	 * Caller-owned lists (T97): each file and dir is recorded the
	 * moment it lands, so a throw at any point still rolls back
	 * exactly what this run made.
	 */
	createdFiles?: string[];
	createdDirs?: string[];
	/** Writer seam (tests only); production leaves it unset. */
	fs?: ScaffoldFs;
};

/**
 * Copy every template file into dest (dirs created), substituting
 * {{name}} in *.toml and *.md files. Every write is an exclusive,
 * non-following create; a mid-copy conflict throws ScaffoldConflict.
 * Returns the written rel paths.
 */
export function copyTemplateFiles(
	template: string,
	dest: string,
	name: string,
	opts?: CopyOpts,
): string[] {
	const written: string[] = [];
	for (const rel of listTemplateFiles(template)) {
		const slash = rel.lastIndexOf("/");
		if (slash >= 0) {
			ensureDirPrefix(dest, rel.slice(0, slash), opts?.createdDirs);
		}
		const full = path.join(dest, rel);
		let content: string | Buffer;
		if (rel.endsWith(".toml") || rel.endsWith(".md")) {
			let text = nodeFs
				.readFileSync(path.join(template, rel), "utf8")
				.split("{{name}}")
				.join(name);
			if (rel === "workspace.toml" && opts?.provenance) {
				text = stampText(text, opts.provenance);
			}
			content = text;
		} else {
			content = nodeFs.readFileSync(path.join(template, rel));
		}
		try {
			writeFileExclusive(full, content, opts?.fs);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
				throw new ScaffoldConflict([rel]);
			}
			throw err;
		}
		written.push(rel);
		opts?.createdFiles?.push(rel);
	}
	return written;
}

/** Stamp [template] provenance into a fresh workspace.toml. */
export function stampTemplateProvenance(
	workspaceToml: string,
	meta: TemplateMeta,
): void {
	const cur = nodeFs.readFileSync(workspaceToml, "utf8");
	nodeFs.writeFileSync(workspaceToml, stampText(cur, meta));
}
