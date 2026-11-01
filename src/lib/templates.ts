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
 * Copy every template file into dest (dirs created), substituting
 * {{name}} in *.toml and *.md files. Returns the written rel paths.
 */
export function copyTemplateFiles(
	template: string,
	dest: string,
	name: string,
): string[] {
	const written: string[] = [];
	for (const rel of listTemplateFiles(template)) {
		const full = path.join(dest, rel);
		nodeFs.mkdirSync(path.dirname(full), { recursive: true });
		if (rel.endsWith(".toml") || rel.endsWith(".md")) {
			const text = nodeFs
				.readFileSync(path.join(template, rel), "utf8")
				.split("{{name}}")
				.join(name);
			nodeFs.writeFileSync(full, text);
		} else {
			nodeFs.copyFileSync(path.join(template, rel), full);
		}
		written.push(rel);
	}
	return written;
}

/** Stamp [template] provenance into a fresh workspace.toml. */
export function stampTemplateProvenance(
	workspaceToml: string,
	meta: TemplateMeta,
): void {
	const cur = nodeFs.readFileSync(workspaceToml, "utf8");
	const q = (s: string): string =>
		`"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	const sep = cur.endsWith("\n") ? "" : "\n";
	nodeFs.writeFileSync(
		workspaceToml,
		`${cur}${sep}\n[template]\nname = ${q(meta.name)}\nversion = ${q(meta.version)}\n`,
	);
}
